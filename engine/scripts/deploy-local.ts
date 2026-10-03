#!/usr/bin/env bun
/**
 * deploy-local — deploy SPARE S1 onto a LOCAL ANVIL FORK of Robinhood Chain and
 * write its address book, so the engine (and the workers built on it) can run
 * end-to-end against real Uniswap v4 pools, real Chainlink feeds, real Permit2
 * and real stock tokens without touching mainnet.
 *
 *   anvil --fork-url https://rpc.mainnet.chain.robinhood.com --chain-id 31337
 *   bun run deploy:local                    # -> .local/addresses/31337.json
 *   CHAIN_ID=31337 ADDRESSES_FILE=.local/addresses/31337.json bun run dev
 *
 * SAFETY: refuses to run unless the RPC is a loopback URL, reports chain 31337
 * and identifies as anvil. It uses anvil's unlocked dev accounts (no private
 * key is read or written). It can never broadcast to a live network.
 *
 * Mirrors contracts/test/fork/SpareFork.t.sol setUp(): the same constructor
 * wiring, the same allowlisted pool keys (hook included), heartbeats and bands,
 * the USDG park adapter as the launch default, and the 60/40 SPY/NVDA default mix.
 * The fork has no ArbSys precompile (Nitro serves 0xfe at 0x64), so MockArbSys
 * is etched there, exactly as the fork test does, keeping L2Clock on its
 * production branch.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  http,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { PERMIT2, TOKENS, USDG, VENUE } from "../src/chain/constants.ts";
import { spareLocal } from "../src/chain/client.ts";

const OUT_DIR = resolve(import.meta.dir, "../../contracts/out");

interface Artifact {
  abi: Abi;
  bytecode: { object: Hex };
  deployedBytecode: { object: Hex };
}

export function artifact(file: string, contract = file.replace(/\.sol$/, "")): Artifact {
  const p = join(OUT_DIR, file, `${contract}.json`);
  if (!existsSync(p)) throw new Error(`missing ${p} — run forge build in contracts/`);
  return JSON.parse(readFileSync(p, "utf8")) as Artifact;
}

/** Allowlisted pool keys — identical to SpareFork.t.sol (exact PoolKey, hook included). */
export const POOL_KEYS = {
  SPY: { currency0: TOKENS.SPY, currency1: USDG, fee: 3000, tickSpacing: 60, hooks: "0x0000000000000000000000000000000000000000" },
  // Hookless fee-100 pool, as on mainnet (the hooked fee-0 pool fills ~3% worse through StockRouter).
  NVDA: { currency0: USDG, currency1: TOKENS.NVDA, fee: 100, tickSpacing: 1, hooks: "0x0000000000000000000000000000000000000000" },
  SGOV: { currency0: USDG, currency1: TOKENS.SGOV, fee: 0, tickSpacing: 200, hooks: "0xc52fc52698479E42F0dA9a8a75296EC3871454c0" },
} as const;

export const FEEDS_BY_TOKEN = {
  SPY: "0x319724394D3A0e3669269846abE664Cd621f9f6A",
  NVDA: "0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15",
  SGOV: "0xa0DF4ee0fFf975306345875E3548Fcc519577A11",
} as const;

export interface LocalDeployment {
  chainId: 31337;
  deployBlock: number;
  owner: Address;
  keeper: Address;
  assetRegistry: Address;
  ruleRegistry: Address;
  electionRegistry: Address;
  screeningGate: Address;
  stockRouter: Address;
  cashPark: Address;
  feeVault: Address;
  sweepExecutor: Address;
  usdgParkAdapter: Address;
  sgovParkAdapter: Address;
}

export async function assertLocalAnvil(rpcUrl: string): Promise<PublicClient> {
  const u = new URL(rpcUrl);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) {
    throw new Error(`deploy-local refuses non-loopback RPC ${u.host}`);
  }
  const client = createPublicClient({ chain: spareLocal, transport: http(rpcUrl, { timeout: 60_000 }) }) as PublicClient;
  const id = await client.getChainId();
  if (id !== 31337) throw new Error(`deploy-local refuses chain ${id}; start anvil with --chain-id 31337`);
  const version = await client.request({ method: "web3_clientVersion" as never });
  if (!/anvil/i.test(String(version))) throw new Error(`deploy-local refuses non-anvil node (${version})`);
  return client;
}

async function send(client: PublicClient, wallet: WalletClient, account: Address, req: { address: Address; abi: Abi; functionName: string; args?: readonly unknown[] }) {
  const hash = await wallet.writeContract({ ...req, account, chain: spareLocal } as never);
  const r = await client.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${req.functionName} reverted`);
  return r;
}

async function deploy(client: PublicClient, wallet: WalletClient, account: Address, file: string, args: readonly unknown[]) {
  const a = artifact(file);
  const hash = await wallet.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args, account, chain: spareLocal } as never);
  const r = await client.waitForTransactionReceipt({ hash });
  if (r.status !== "success" || !r.contractAddress) throw new Error(`deploy ${file} failed`);
  return { address: r.contractAddress, block: Number(r.blockNumber) };
}

export async function deployLocal(rpcUrl = "http://127.0.0.1:8545", log: (m: string) => void = console.log): Promise<LocalDeployment> {
  const client = await assertLocalAnvil(rpcUrl);
  const wallet = createWalletClient({ chain: spareLocal, transport: http(rpcUrl, { timeout: 60_000 }) });
  const accounts = (await client.request({ method: "eth_accounts" as never })) as Address[];
  if (accounts.length < 2) throw new Error("anvil must expose unlocked dev accounts");
  const [owner, keeper] = accounts as [Address, Address];

  // ArbSys stand-in at 0x64 so L2Clock reads the (forked) L2 block number.
  await client.request({
    method: "anvil_setCode" as never,
    params: ["0x0000000000000000000000000000000000000064", artifact("MockArbSys.sol").deployedBytecode.object] as never,
  });

  const d = async (file: string, args: readonly unknown[]) => deploy(client, wallet, owner, file, args);
  const registry = await d("AssetRegistry.sol", [owner, USDG]);
  const rules = await d("RuleRegistry.sol", []);
  const elections = await d("ElectionRegistry.sol", [owner, registry.address]);
  const screening = await d("ScreeningGate.sol", [owner, owner, false]);
  const router = await d("StockRouter.sol", [owner, VENUE.v4PoolManager, registry.address]);
  const park = await d("CashPark.sol", [owner, USDG]);
  const vault = await d("FeeVault.sol", [owner]);
  const exec = await d("SweepExecutor.sol", [owner, PERMIT2, rules.address, elections.address, screening.address, router.address, park.address, vault.address]);
  const usdgAdapter = await d("UsdgParkAdapter.sol", [USDG, park.address]);
  const sgovAdapter = await d("SgovParkAdapter.sol", [USDG, TOKENS.SGOV, park.address, router.address, 100]);
  log(`[deploy-local] contracts deployed (owner ${owner})`);

  const reg = { address: registry.address, abi: artifact("AssetRegistry.sol").abi };
  for (const sym of ["SPY", "NVDA", "SGOV"] as const) {
    await send(client, wallet, owner, { ...reg, functionName: "setAsset", args: [TOKENS[sym], FEEDS_BY_TOKEN[sym], 86_400, 150, POOL_KEYS[sym]] });
    await send(client, wallet, owner, { ...reg, functionName: "setActive", args: [TOKENS[sym], true] });
  }
  const routerC = { address: router.address, abi: artifact("StockRouter.sol").abi };
  await send(client, wallet, owner, { ...routerC, functionName: "setCaller", args: [exec.address, true] });
  await send(client, wallet, owner, { ...routerC, functionName: "setCaller", args: [sgovAdapter.address, true] });
  const parkC = { address: park.address, abi: artifact("CashPark.sol").abi };
  await send(client, wallet, owner, { ...parkC, functionName: "setExecutor", args: [exec.address] });
  await send(client, wallet, owner, { ...parkC, functionName: "setAdapter", args: [usdgAdapter.address] });
  await send(client, wallet, owner, { ...parkC, functionName: "setKeeper", args: [keeper, true] });
  await send(client, wallet, owner, { address: exec.address, abi: artifact("SweepExecutor.sol").abi, functionName: "setKeeper", args: [keeper, true] });
  await send(client, wallet, owner, {
    address: elections.address,
    abi: artifact("ElectionRegistry.sol").abi,
    functionName: "setDefaultMix",
    args: [[{ asset: TOKENS.SPY, bps: 6000 }, { asset: TOKENS.NVDA, bps: 4000 }]],
  });
  log("[deploy-local] registry, router, park, executor and default mix configured");

  return {
    chainId: 31337,
    deployBlock: registry.block,
    owner,
    keeper,
    assetRegistry: registry.address,
    ruleRegistry: rules.address,
    electionRegistry: elections.address,
    screeningGate: screening.address,
    stockRouter: router.address,
    cashPark: park.address,
    feeVault: vault.address,
    sweepExecutor: exec.address,
    usdgParkAdapter: usdgAdapter.address,
    sgovParkAdapter: sgovAdapter.address,
  };
}

if (import.meta.main) {
  const rpc = process.argv.find((a) => a.startsWith("--rpc="))?.slice(6) ?? process.env.RPC_URL ?? "http://127.0.0.1:8545";
  const out = resolve(process.argv.find((a) => a.startsWith("--out="))?.slice(6) ?? resolve(import.meta.dir, "../.local/addresses/31337.json"));
  try {
    const dep = await deployLocal(rpc);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(dep, null, 2)}\n`);
    console.log(`[deploy-local] wrote ${out}`);
    console.log(`[deploy-local] run: CHAIN_ID=31337 ADDRESSES_FILE=${out} bun run dev`);
  } catch (err) {
    console.error(`[deploy-local] ${(err as Error).message}`);
    process.exit(1);
  }
}
