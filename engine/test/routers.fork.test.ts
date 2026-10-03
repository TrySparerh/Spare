/**
 * Every router against REAL chain state: a live-head anvil fork of Robinhood
 * Chain mainnet (re-identified as 31337) with SPARE deployed by
 * scripts/deploy-local.ts — real Uniswap v4 pools, real Chainlink feeds, real
 * Permit2, real stock tokens — plus a test database filled by the core's own
 * worker primitives (runCursor + events.ts + observe.ts), i.e. exactly what the
 * workers will write.
 *
 * Market hours matter: US-equity feeds are 24/5. Assertions that depend on a
 * fresh feed branch on the router's own verdict and say which branch ran.
 *
 * Opt-in: runs only with SPARE_FORK=1, anvil in ~/.foundry/bin and the
 * contracts built (`forge build` in contracts/ writes the artifacts
 * deploy-local.ts deploys). A plain `bun test` skips it, so a clone-and-test
 * run never depends on the network or on build order.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  createWalletClient,
  erc20Abi,
  getAddress,
  http,
  maxUint256,
  type Abi,
  type Address,
  type PublicClient,
  type WalletClient,
} from "viem";
import { anvilBin, rpc, startAnvil, type Anvil } from "./helpers/anvil.ts";
import { closeTestDb, testDb, type TestDb } from "./helpers/db.ts";
import { caller, makeCtx } from "./helpers/context.ts";
import { deployLocal, type LocalDeployment } from "../scripts/deploy-local.ts";
import { makePublicClient, spareLocal } from "../src/chain/client.ts";
import { parseAddressBook, type SpareAddresses, OPTIONAL_CONTRACTS, REQUIRED_CONTRACTS } from "../src/chain/addresses.ts";
import {
  cashParkAbi,
  electionRegistryAbi,
  permit2Abi,
  ruleRegistryAbi,
  stockRouterAbi,
  sweepExecutorAbi,
} from "../src/chain/abis.ts";
import { PERMIT2, TOKENS, USDG, VENUE } from "../src/chain/constants.ts";
import { blockTimes } from "../src/chain/blocks.ts";
import { decodeSpareLogs, indexedContracts, writeEventRows } from "../src/chain/events.ts";
import { observePayments, ruleAtBlock, writePayments } from "../src/chain/observe.ts";
import { CHAIN_INDEXER_CURSOR, cursorSource, paymentsCursorName, runCursor } from "../src/workers/cursors.ts";
import { makeClassifier } from "../src/lib/payments.ts";
import { mirrorOracleGuard, oracleStatusName } from "../src/lib/oracle.ts";
import { poolId } from "../src/routers/universe.ts";
import type { Context } from "../src/trpc.ts";

/** The first artifact deploy-local.ts loads: present once `forge build` has run in contracts/. */
const ARTIFACT = resolve(import.meta.dir, "../../contracts/out/MockArbSys.sol/MockArbSys.json");
const SKIP = process.env.SPARE_FORK !== "1" || !anvilBin() || !existsSync(ARTIFACT);
/** Per-test ceiling for the fork's RPC round trips (bun's 5 s default flaked on a live-head fork). */
const TEST_MS = 30_000;
const FINALITY = 3000n;

const randomAddress = (): Address =>
  getAddress(`0x${Buffer.from(crypto.getRandomValues(new Uint8Array(20))).toString("hex")}`);

describe.skipIf(SKIP)("routers on a live RHC fork with SPARE deployed", () => {
  let anvil: Anvil;
  let dep: LocalDeployment;
  let A: SpareAddresses;
  let client: PublicClient;
  let wallet: WalletClient;
  let t: TestDb;
  let ctx: Context;
  let api: ReturnType<typeof caller>;
  const alice = randomAddress();
  const bob = randomAddress();
  const carol = randomAddress(); // a merchant, not linked to anyone
  let aliceAccrueTo = 0n;
  let paymentTx = "" as `0x${string}`;

  async function send(from: Address, address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []) {
    const hash = await wallet.writeContract({ address, abi, functionName, args, account: from, chain: spareLocal } as never);
    const r = await client.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`${functionName} from ${from} reverted`);
    return r;
  }
  const mine = (n: bigint) => rpc(anvil.url, "anvil_mine", [`0x${n.toString(16)}`]);
  const now = async () => (await client.getBlock()).timestamp;

  /** One chain-indexer tick using only core primitives. */
  async function indexChain() {
    return runCursor(
      {
        db: t.handle.db,
        client,
        id: { chainId: 31337, name: CHAIN_INDEXER_CURSOR, source: cursorSource(indexedContracts(A)), startBlock: A.deployBlock! },
        confirmations: FINALITY,
        maxBlocks: 1_000_000n,
      },
      async (range, tx) => {
        const logs = await client.getLogs({ address: indexedContracts(A), fromBlock: range.from, toBlock: range.to });
        const times = await blockTimes(client, logs.map((l) => l.blockNumber!));
        await writeEventRows(tx, 31337, decodeSpareLogs(logs, A, USDG, times));
      },
    );
  }

  /** One roundup-observer tick for a wallet, from `start`. */
  async function observe(account: Address, w: Address, start: bigint) {
    const spare = [...REQUIRED_CONTRACTS, ...OPTIONAL_CONTRACTS].map((k) => A[k]).filter(Boolean) as string[];
    const classifier = makeClassifier({ account, linkedWallets: [w], spareContracts: spare, venue: Object.values(VENUE) });
    return runCursor(
      {
        db: t.handle.db,
        client,
        id: { chainId: 31337, name: paymentsCursorName(w), source: cursorSource([USDG]), startBlock: start },
        confirmations: FINALITY,
        maxBlocks: 2_000_000n,
      },
      async (range, tx) => {
        const rows = await observePayments({
          client, chainId: 31337, token: USDG, wallet: w, account,
          fromBlock: range.from, toBlock: range.to, maxRange: 50_000n, classifier,
          ruleAt: (b) => ruleAtBlock(tx, 31337, account, b),
        });
        await writePayments(tx, rows);
      },
    );
  }

  beforeAll(async () => {
    anvil = await startAnvil();
    dep = await deployLocal(anvil.url, () => {});
    const book = parseAddressBook(dep, 31337, "deploy-local");
    if (!book.deployed) throw new Error(book.reason);
    A = book.addresses;
    client = makePublicClient(31337, anvil.url);
    wallet = createWalletClient({ chain: spareLocal, transport: http(anvil.url) });
    t = await testDb(31337);
    ctx = makeCtx({
      chainId: 31337,
      client,
      book: () => book,
      handle: t.handle,
      keeperAddress: getAddress(dep.keeper),
      finalityBuffer: FINALITY,
      // The operator's view: `health` serves its detail to the HEALTH_TOKEN bearer only.
      healthToken: "f".repeat(32),
      authorization: `Bearer ${"f".repeat(32)}`,
    });
    api = caller(ctx);

    for (const u of [alice, bob, carol]) {
      await rpc(anvil.url, "anvil_impersonateAccount", [u]);
      await rpc(anvil.url, "anvil_setBalance", [u, "0xDE0B6B3A7640000"]);
    }
    for (const u of [alice, bob]) await rpc(anvil.url, "anvil_dealERC20", [u, USDG, `0x${(100_000_000n).toString(16)}`]);

    const exp = (await now()) + 30n * 86_400n;
    const onboard = async (u: Address, multiplier: number) => {
      await send(u, USDG, erc20Abi as Abi, "approve", [PERMIT2, maxUint256]);
      await send(u, PERMIT2, permit2Abi as Abi, "approve", [USDG, A.sweepExecutor, 50_000_000n, Number(exp)]);
      await send(u, A.ruleRegistry, ruleRegistryAbi as Abi, "linkSelf");
      await send(u, A.ruleRegistry, ruleRegistryAbi as Abi, "setRule", [1, multiplier, 50_000_000n, true]);
    };
    await onboard(alice, 1);
    await onboard(bob, 3);
    await send(bob, A.electionRegistry, electionRegistryAbi as Abi, "setMix", [[{ asset: TOKENS.SPY, bps: 5000 }, { asset: TOKENS.NVDA, bps: 5000 }]]);

    await mine(FINALITY + 100n);
    aliceAccrueTo = (await client.getBlockNumber()) - FINALITY - 1n;
    await send(getAddress(dep.keeper), A.sweepExecutor, sweepExecutorAbi as Abi, "accrue", [alice, alice, 10_000_000n, aliceAccrueTo]);
    await send(getAddress(dep.keeper), A.sweepExecutor, sweepExecutorAbi as Abi, "accrue", [bob, bob, 6_000_000n, aliceAccrueTo]);

    // A real payment: alice pays a merchant $3.75.
    paymentTx = (await send(alice, USDG, erc20Abi as Abi, "transfer", [carol, 3_750_000n])).transactionHash;
    await mine(FINALITY + 100n);
  }, 240_000);

  afterAll(async () => {
    await closeTestDb();
    if (anvil) await anvil.stop();
  });

  test("health: chain, verified deployment, keeper registration, database", async () => {
    const h = (await api.health()) as Record<string, any>;
    expect(h.ok).toBe(true);
    expect(h.chain).toMatchObject({ id: 31337, rpc: "up", observedId: 31337, idHealthy: true });
    expect(h.contracts.deployed).toBe(true);
    expect(h.deployment).toMatchObject({ verified: true, executorPaused: false, parkPaused: false, keeperRegistered: { sweepExecutor: true, cashPark: true } });
    expect(h.database).toMatchObject({ migrated: true, boundChainId: 31337, bindingHealthy: true });
  }, TEST_MS);

  test("a client on the wrong chain is refused (chain_mismatch), not read", async () => {
    const wrong = caller({ ...ctx, chainId: 4663 });
    const r = (await wrong.rule.get({ account: alice })) as { available: boolean; code: string };
    // The 31337 book does not describe chain 4663 -> it is simply not deployed there.
    expect(r.available).toBe(false);
    const mis = caller({ ...ctx, chainId: 4663, book: () => ({ ...ctx.book(), source: "x" }) as never });
    const r2 = (await mis.oracle.status()) as { available: boolean; code: string };
    expect(r2).toMatchObject({ available: false, code: "chain_mismatch" });
  }, TEST_MS);

  test("link.list: the linked wallet, its cursor and its Permit2 allowance", async () => {
    const r = (await api.link.list({ account: alice })) as any;
    expect(r.available).toBe(true);
    expect(r.linkedTo).toBeNull();
    expect(r.wallets).toHaveLength(1);
    const w = r.wallets[0];
    expect(w.wallet).toBe(alice);
    expect(BigInt(w.linkedAtBlock)).toBeGreaterThan(0n);
    expect(w.lastAccruedBlock).toBe(aliceAccrueTo.toString());
    expect(w.permit2.status).toBe("active");
    expect(w.permit2.amount.display).toBe("40"); // 50 granted - 10 pulled
    expect(w.usdgBalance.display).toBe("86.25"); // 100 - 10 accrued - 3.75 paid
    const none = (await api.link.list({ account: carol })) as any;
    expect(none).toMatchObject({ available: true, wallets: [], linkedTo: null });
  }, TEST_MS);

  test("rule.get: on-chain rule and the live weekly-cap window", async () => {
    const r = (await api.rule.get({ account: alice })) as any;
    expect(r).toMatchObject({ available: true, set: true, accruing: true });
    expect(r.rule).toMatchObject({ roundTo: 1, multiplier: 1, enabled: true, weeklyCap: { display: "50" } });
    expect(r.weeklyCap.pulled.display).toBe("10");
    expect(r.weeklyCap.remaining.display).toBe("40");
    const unset = (await api.rule.get({ account: carol })) as any;
    expect(unset).toMatchObject({ available: true, set: false, rule: null, accruing: false });
  }, TEST_MS);

  test("rule.preview (RPC path): acceptance (1) through real Transfer logs", async () => {
    const r = (await api.rule.preview({ account: alice, days: 1 })) as any;
    expect(r.available).toBe(true);
    expect(r.kind).toBe("rule-preview");
    expect(r.sources).toEqual([{ wallet: alice, source: "rpc", payments: 2 }]);
    // The executor's Permit2 pull is not a payment; the $3.75 to the merchant is.
    expect(r.totals).toMatchObject({ payments: 2, eligible: 1, excluded: 1, excludedByReason: { "to-spare-contract": 1 } });
    expect(r.totals.roundUps.display).toBe("0.25");
    const pay = r.payments.find((p: any) => p.txHash === paymentTx);
    expect(pay).toMatchObject({ to: carol, amount: { display: "3.75" }, delta: { display: "0.25" }, excludedReason: null });
    expect(pay.time).not.toBeNull();

    const x3 = (await api.rule.preview({ account: alice, days: 1, rule: { roundTo: 1, multiplier: 3 } })) as any;
    expect(x3.rule.source).toBe("input");
    expect(x3.totals.roundUps.display).toBe("0.75");
    const cap = (await api.rule.preview({ account: alice, days: 1, rule: { roundTo: 1, multiplier: 3, weeklyCap: "500000" } })) as any;
    expect(cap.totals.afterWeeklyCap.display).toBe("0.5");
    expect(cap.totals.droppedByWeeklyCap.display).toBe("0.25");
  }, 120_000);

  test("mix.get: default 60/40 for alice, own 50/50 for bob", async () => {
    const a = (await api.mix.get({ account: alice })) as any;
    expect(a.source).toBe("default");
    expect(a.legs.map((l: any) => [l.symbol, l.bps, l.active])).toEqual([["SPY", 6000, true], ["NVDA", 4000, true]]);
    expect(a.maxLegs).toBe(6);
    const b = (await api.mix.get({ account: bob })) as any;
    expect(b.source).toBe("own");
    expect(b.legs.map((l: any) => l.bps)).toEqual([5000, 5000]);
  }, TEST_MS);

  test("accrual.state before indexing: chain figures, observer reports 'not_indexed'", async () => {
    const r = (await api.accrual.state({ account: alice })) as any;
    expect(r.available).toBe(true);
    expect(r.pending.display).toBe("10");
    expect(r.value.display).toBe("10");
    expect(r.units.raw).toBe("0");
    expect(r.threshold.display).toBe("5");
    expect(r.progressBps).toBe(10_000);
    expect(r.remainingToThreshold.display).toBe("0");
    expect(r.weekly.weekPulled.display).toBe("10");
    expect(r.weekly.remainingWeeklyCap.display).toBe("40");
    expect(r.parkFresh).toBe(true);
    expect(r.finality.finalityBuffer).toBe("3000");
    expect(r.wallets[0].accrualCursor).toBe(aliceAccrueTo.toString());
    expect(r.observed).toMatchObject({ available: false, code: "not_indexed" });
    const l = (await api.accrual.ledger({ account: alice, limit: 10 })) as any;
    expect(l).toMatchObject({ available: false, code: "not_indexed" });
  }, TEST_MS);

  test("worker primitives: chain-indexer + observer ticks fill the DB; routers read it back", async () => {
    const ci = await indexChain();
    expect(ci?.range).not.toBeNull();
    const links = await t.handle.sql`select account, wallet from links order by linked_block`;
    expect(links.map((x) => x.wallet)).toEqual([alice.toLowerCase(), bob.toLowerCase()]);
    const batches = await t.handle.sql`select wallet, amount, status, source from accrual_batches order by wallet`;
    expect(batches).toHaveLength(2);
    expect(batches.every((b) => b.status === "confirmed" && b.source === "chain")).toBe(true);

    const linkedAt = BigInt((await api.link.list({ account: alice }) as any).wallets[0].linkedAtBlock);
    const obs = await observe(alice, alice, linkedAt);
    expect(obs?.range?.from).toBe(linkedAt);

    const st = (await api.accrual.state({ account: alice })) as any;
    expect(st.observed.available).toBe(true);
    // The $3.75 payment came after the last accrual: $0.25 observed, not yet accrued.
    expect(st.observed.totalUnaccrued.display).toBe("0.25");
    expect(st.batches.rows).toHaveLength(1);
    expect(st.batches.rows[0]).toMatchObject({ amount: { display: "10" }, status: "confirmed" });

    const page1 = (await api.accrual.ledger({ account: alice, limit: 1 })) as any;
    expect(page1.available).toBe(true);
    expect(page1.totals).toMatchObject({ payments: 2, eligible: 1, excludedByReason: { "to-spare-contract": 1 } });
    expect(page1.totals.roundUps.display).toBe("0.25");
    expect(page1.rows).toHaveLength(1);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = (await api.accrual.ledger({ account: alice, limit: 1, cursor: page1.nextCursor })) as any;
    expect(page2.rows).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();
    const all = [...page1.rows, ...page2.rows];
    expect(all.find((p: any) => p.txHash === paymentTx)).toMatchObject({ delta: { display: "0.25" }, roundTo: 1, multiplier: 1, excludedReason: null });
    expect(all.find((p: any) => p.excludedReason === "to-spare-contract")?.counterparty.toLowerCase()).toBe(A.sweepExecutor.toLowerCase());
    expect(page1.coverage.find((c: any) => c.wallet === alice.toLowerCase())?.indexed).toBe(true);
  }, 120_000);

  test("rule.preview (DB path) matches the RPC path when the observer covers the window", async () => {
    const rpcView = (await api.rule.preview({ account: alice, days: 1 })) as any;
    // Re-scan alice from before the preview window so the DB covers it (a fresh
    // address has no earlier history — the scan proves it rather than assuming).
    await t.handle.sql`delete from cursors where name = ${paymentsCursorName(alice)}`;
    await t.handle.sql`delete from payments where wallet = ${alice.toLowerCase()}`;
    await observe(alice, alice, BigInt(rpcView.window.fromBlock) - 1_000n);
    const dbView = (await api.rule.preview({ account: alice, days: 1 })) as any;
    expect(dbView.sources[0].source).toBe("db");
    expect(dbView.totals).toEqual(rpcView.totals);
  }, 180_000);

  test("universe.list: registry assets, allowlisted pools, oracle + ERC-8056 state", async () => {
    const r = (await api.universe.list()) as any;
    expect(r.available).toBe(true);
    expect(r.assets.map((x: any) => x.symbol)).toEqual(["SPY", "NVDA", "SGOV"]);
    for (const x of r.assets) {
      expect(x.active).toBe(true);
      expect(x.pool.poolId).toBe(poolId(x.pool));
      expect(x.feed.answer).not.toBeNull();
      expect(x.token8056.uiMultiplier).not.toBeNull();
      expect(["OK", "STALE", "PAUSED"]).toContain(x.oracle.status);
      if (x.oracle.status === "OK") expect(Number(x.oracle.price.display)).toBeGreaterThan(0);
    }
    // NVDA is pinned to the hookless fee-100 pool (as on mainnet).
    expect(r.assets.find((x: any) => x.symbol === "NVDA").pool.hooked).toBe(false);
    expect(r.assets.find((x: any) => x.symbol === "SPY").pool.hooked).toBe(false);
    expect(r.sequencerFeed).toBeNull();
  }, TEST_MS);

  test("oracle.status: router verdicts, and the TS mirror of OracleGuard agrees with the chain", async () => {
    const r = (await api.oracle.status()) as any;
    expect(r.available).toBe(true);
    expect(r.registry).toEqual({ available: true });
    const spy = r.feeds.find((f: any) => f.label === "SPY / USD");
    expect(spy.verdict.source).toBe("router");
    const qqq = r.feeds.find((f: any) => f.label === "QQQ / USD");
    expect(qqq.verdict.source).toBe("engine-mirror");
    expect(r.feeds.find((f: any) => f.label === "USDG / USD").verdict.source).toBe("none");
    // Mirror vs on-chain for every registry asset.
    for (const f of r.feeds.filter((x: any) => x.verdict.source === "router")) {
      const [status] = (await client.readContract({ address: A.stockRouter, abi: stockRouterAbi, functionName: "oracleStatus", args: [f.token] })) as readonly [number, bigint];
      const mirrored = mirrorOracleGuard({
        answer: BigInt(f.answer.raw),
        updatedAt: BigInt(Date.parse(f.updatedAt) / 1000),
        heartbeat: BigInt(f.heartbeatSeconds),
        now: BigInt(r.asOf.timestamp),
        paused: false,
        oraclePaused: false,
      });
      expect(oracleStatusName(mirrored)).toBe(oracleStatusName(status));
    }
  }, TEST_MS);

  test("sweep.next predicts, sweep executes, sweep.history reports what happened", async () => {
    const before = (await api.sweep.next({ account: alice })) as any;
    expect(before.available).toBe(true);
    expect(before.eligibleNow).toBe(true);
    expect(before.blockedBy).toBeNull();
    expect(before.legs.map((l: any) => [l.symbol, l.projectedUsdg.display])).toEqual([["SPY", "6"], ["NVDA", "4"]]);

    const h0 = (await api.sweep.history({ account: alice, limit: 5 })) as any;
    expect(h0).toMatchObject({ available: true, sweeps: [] }); // indexed, and genuinely none yet

    // Keeper-only: the keeper sweeps with a per-asset limit (tokens per 1 USDG).
    // Here the limit is the oracle price less 1.5%; the live keeper uses a
    // same-block V4Quoter quote less 50 bps.
    const limits = [];
    for (const leg of before.legs) {
      const [, price] = (await client.readContract({ address: A.stockRouter, abi: stockRouterAbi, functionName: "oracleStatus", args: [leg.asset] })) as readonly [number, bigint];
      const perUsdg = (1_000_000n * 10n ** 12n * 10n ** 18n) / price;
      limits.push({ asset: leg.asset, minOutPerUsdg: (perUsdg * 9_850n) / 10_000n });
    }
    const receipt = await send(getAddress(dep.keeper), A.sweepExecutor, sweepExecutorAbi as Abi, "sweep", [[alice, bob], limits]);
    expect(receipt.status).toBe("success");
    await mine(FINALITY + 10n);
    await indexChain();

    const h = (await api.sweep.history({ account: alice, limit: 5 })) as any;
    expect(h.available).toBe(true);
    expect(h.sweeps).toHaveLength(1);
    const s = h.sweeps[0];
    expect(s.txHash).toBe(receipt.transactionHash);
    expect(s.usdgIn.display).toBe("10");

    for (const leg of before.legs) {
      const got = await client.readContract({ address: leg.asset, abi: erc20Abi, functionName: "balanceOf", args: [alice] });
      if (leg.outcome === "swap") {
        // Delivered on-chain, and the history says exactly that amount.
        expect(got).toBeGreaterThan(0n);
        const d = s.outcomes.find((o: any) => o.kind === "delivered" && o.token.toLowerCase() === leg.asset.toLowerCase());
        expect(BigInt(d.amount.raw)).toBe(got);
        const fill = s.fills.find((f: any) => f.asset.toLowerCase() === leg.asset.toLowerCase());
        expect(fill.oraclePrice).not.toBeNull();
        // Acceptance (2): the netted fill sits within the 1.5% band of Chainlink.
        const refTokens = (BigInt(fill.usdgIn.raw) * 10n ** 30n) / BigInt(fill.oraclePrice.raw);
        const out = BigInt(fill.tokensOut.raw);
        expect(out * 10_000n >= refTokens * 9_850n).toBe(true);
      } else if (leg.outcome === "defer") {
        expect(got).toBe(0n);
        expect(s.outcomes.some((o: any) => o.kind === "deferred" && o.asset?.toLowerCase() === leg.asset.toLowerCase())).toBe(true);
      }
      console.log(`[fork] ${leg.symbol}: oracle ${leg.oracleStatus} -> ${leg.outcome}; alice holds ${got}`);
    }
    // Fee: 0.25% of converted legs only.
    const feeTotal = s.fills.reduce((sum: bigint, f: any) => sum + BigInt(f.fee.raw), 0n);
    const vault = await client.readContract({ address: USDG, abi: erc20Abi, functionName: "balanceOf", args: [A.feeVault] });
    expect(vault).toBe(feeTotal);

    const after = (await api.sweep.next({ account: alice })) as any;
    if (before.legs.every((l: any) => l.outcome === "swap")) {
      expect(after.epoch.sweptThisEpoch).toBe(true);
      expect(after.blockedBy).toBe("already_swept_this_epoch");
      expect(after.value.display).toBe("0");
    }
  }, 180_000);

  test("park.state: USDG adapter, then acceptance (3) through the SGOV adapter", async () => {
    const u = (await api.park.state({ account: alice })) as any;
    expect(u).toMatchObject({ available: true, kind: "usdg", isFresh: true, underlyingSymbol: "USDG" });
    expect(u.nav.perUnit.display).toBe("1");

    // Switch to SGOV (no units are parked) and park bob's fresh accrual.
    await send(getAddress(dep.owner), A.cashPark, cashParkAbi as Abi, "setAdapter", [A.sgovParkAdapter]);
    await mine(FINALITY + 10n);
    const to = (await client.getBlockNumber()) - FINALITY - 1n;
    await send(getAddress(dep.keeper), A.sweepExecutor, sweepExecutorAbi as Abi, "accrue", [bob, bob, 20_000_000n, to]);
    const sg = (await api.park.state({ account: bob })) as any;
    expect(sg).toMatchObject({ available: true, kind: "sgov", underlying: TOKENS.SGOV, underlyingSymbol: "SGOV" });
    expect(sg.oracle.feed).toBe("0xa0DF4ee0fFf975306345875E3548Fcc519577A11");
    if (sg.isFresh) {
      await send(getAddress(dep.keeper), A.cashPark, cashParkAbi as Abi, "park", [[bob]]);
      const parked = (await api.park.state({ account: bob })) as any;
      expect(BigInt(parked.account.units.raw)).toBeGreaterThan(0n);
      expect(parked.account.pending.raw).toBe("0");
      // Valued at the SGOV feed: within 1.5% of what was parked (bob's balance before parking).
      const v = Number(parked.account.value.display);
      const parkedUsd = Number(sg.account.pending.display);
      expect(Math.abs(v - parkedUsd) / parkedUsd).toBeLessThan(0.015);
      expect(Number(parked.nav.perUnit.display)).toBeGreaterThan(50);
      console.log(`[fork] SGOV park: ${parked.account.units.display} SGOV valued ${v} USDG (NAV ${parked.nav.perUnit.display})`);
    } else {
      // Law 4: stale NAV holds accrual un-parked.
      await send(getAddress(dep.keeper), A.cashPark, cashParkAbi as Abi, "park", [[bob]]);
      const held = (await api.park.state({ account: bob })) as any;
      expect(held.account.units.raw).toBe("0");
      console.log("[fork] SGOV feed not fresh — park() held accrual un-parked (law 4)");
    }
  }, 120_000);
});
