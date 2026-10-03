/**
 * fund-swap-fork.ts — end-to-end check of the Fund Wallet swaps on a LOCAL fork of RHC mainnet.
 *
 *   scripts/dev-fork.sh --reset        # or any: anvil --fork-url <RHC RPC> --chain-id 31337
 *   bun scripts/fund-swap-fork.ts      # right away: the public RPC only serves ~10 min of state
 *
 * Uses the app's own builders (src/lib/spare-chain/fund-swap.ts) against the REAL Universal
 * Router, V4Quoter, PoolManager, Permit2, USDG and WETH in forked state. The user is a FRESH
 * random key made for this run, given ETH with anvil_setBalance and USDG by a transfer from an
 * impersonated mainnet holder (USDG_WHALE, as scripts/lib/common.sh; the USDG balance slot as a
 * fallback). Never an anvil mnemonic key: those are public, and on RHC mainnet anvil #5 carries an
 * EIP-7702 delegation to a sweeper that forwards any ETH it receives, so a USDG->ETH payout to it
 * vanished and the checks failed falsely. The fee recipient is the MAINNET FeeVault (it exists in
 * the forked state), the builders' default.
 *
 * Asserts, per direction: FeeVault received exactly floor(gross * feeBps / 1e4); the user got
 * >= the quote's minimum (and exactly the quoted net, since nothing else moves the fork); the
 * router kept nothing. Plus negative controls: minOut = net + 1 reverts V4TooLittleReceived,
 * no Permit2 allowance reverts AllowanceExpired, a past deadline reverts
 * TransactionDeadlinePassed — each decoded by the app's humanizeFundError.
 *
 * Refuses to run against anything but chain 31337 on a loopback RPC. Never touches mainnet.
 */
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  erc20Abi,
  formatEther,
  formatUnits,
  getAddress,
  http,
  keccak256,
  parseEther,
  toHex,
  type Address,
  type Hash,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  FEE_VAULT,
  PERMIT2,
  PERMIT2_ROUTER_TTL_SECONDS,
  UNIVERSAL_ROUTER,
  USDG,
  V4_QUOTER,
  WETH,
  buildEthToUsdg,
  buildPermit2ApproveRouterTx,
  buildUsdgApprovePermit2Tx,
  buildUsdgToEth,
  feeOf,
  maxEthSwapIn,
  quoteEthToUsdg,
  quoteUsdgToEth,
  readUsdgPermit2State,
  usdgSwapNeeds,
  type SwapTx,
} from '../src/lib/spare-chain/fund-swap';
import { humanizeFundError } from '../src/lib/spare-chain/fund-errors';

const RPC = process.env.SPARE_RPC_URL ?? 'http://127.0.0.1:8545';
const FEE_BPS = 25;
const SLIPPAGE_BPS = 50;
const ETH_IN = parseEther('0.01');
const USDG_IN = 20_000_000n; // 20 USDG
/** What the fresh user starts with: enough for both swaps, the approvals and gas. */
const START_ETH = parseEther('1');
const START_USDG = 100_000_000n; // 100 USDG
/** A large plain-EOA USDG holder on mainnet (scripts/lib/common.sh DEFAULT_USDG_WHALE). */
const USDG_WHALE = getAddress(process.env.USDG_WHALE ?? '0xf70da97812cb96acdf810712aa562db8dfa3dbef');
/** USDG (Paxos) balance mapping slot (scripts/lib/common.sh USDG_BALANCE_SLOT): the funding fallback. */
const USDG_BALANCE_SLOT = 1n;

const host = new URL(RPC).hostname;
if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host)) {
  console.error(`refusing to run against ${RPC}: this script only talks to a local anvil fork`);
  process.exit(2);
}

const fork = defineChain({
  id: 31337,
  name: 'SPARE dev fork',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});
const pub = createPublicClient({ chain: fork, transport: http(RPC) });
const anvil = createTestClient({ mode: 'anvil', chain: fork, transport: http(RPC) });
// A key made for this run only: no mainnet history, no code, nothing else moves its balances.
const account = privateKeyToAccount(generatePrivateKey());
const wallet = createWalletClient({ account, chain: fork, transport: http(RPC) });
const me = account.address;

let failures = 0;
function check(ok: boolean, what: string) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}`);
  if (!ok) failures += 1;
}

const bal = (token: Address, who: Address) => pub.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [who] });
const ethBal = (who: Address) => pub.getBalance({ address: who });

async function send(label: string, tx: SwapTx): Promise<{ hash: Hash; gasCost: bigint; gasUsed: bigint }> {
  const hash = await wallet.sendTransaction({ to: tx.to, data: tx.data, value: tx.value });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`${label} reverted on-chain (${hash})`);
  console.log(`  tx    ${label}: ${hash} (gas ${r.gasUsed})`);
  return { hash, gasCost: r.gasUsed * r.effectiveGasPrice, gasUsed: r.gasUsed };
}

/** eth_call that MUST revert; returns the app's humanized message. */
async function mustRevert(tx: SwapTx, ctx?: { outSymbol: string; outDecimals: number }): Promise<string | null> {
  try {
    await pub.call({ account: me, to: tx.to, data: tx.data, value: tx.value });
    return null;
  } catch (e) {
    return humanizeFundError(e, ctx);
  }
}

/** Fund the fresh user: ETH by anvil_setBalance, USDG from the impersonated holder (else the balance slot). */
async function fundUser() {
  await anvil.setBalance({ address: me, value: START_ETH });
  let how = `transfer from holder ${USDG_WHALE}`;
  if ((await bal(USDG, USDG_WHALE)) >= START_USDG) {
    await anvil.setBalance({ address: USDG_WHALE, value: parseEther('1') });
    await anvil.impersonateAccount({ address: USDG_WHALE });
    try {
      const whale = createWalletClient({ account: USDG_WHALE, chain: fork, transport: http(RPC) });
      const hash = await whale.writeContract({ address: USDG, abi: erc20Abi, functionName: 'transfer', args: [me, START_USDG] });
      await pub.waitForTransactionReceipt({ hash });
    } finally {
      await anvil.stopImpersonatingAccount({ address: USDG_WHALE });
    }
  }
  if ((await bal(USDG, me)) < START_USDG) {
    how = `balance slot ${USDG_BALANCE_SLOT}`;
    const slot = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [me, USDG_BALANCE_SLOT]));
    await anvil.setStorageAt({ address: USDG, index: slot, value: toHex(START_USDG, { size: 32 }) });
  }
  const [eth, usdg] = await Promise.all([ethBal(me), bal(USDG, me)]);
  console.log(`  funded ${formatEther(eth)} ETH (anvil_setBalance) · ${formatUnits(usdg, 6)} USDG (${how})`);
  if (eth !== START_ETH || usdg !== START_USDG) throw new Error('could not fund the fresh user (USDG storage layout changed?)');
}

async function main() {
  const cid = await pub.getChainId();
  if (cid !== 31337) {
    console.error(`chain id ${cid} is not the dev fork (31337) — refusing`);
    process.exit(2);
  }
  const head = await pub.getBlockNumber();
  console.log(`fork ${RPC} chain ${cid} head #${head}`);
  console.log(`user ${me} (fresh key, this run only)  FeeVault ${FEE_VAULT} (mainnet address, forked state)  router ${UNIVERSAL_ROUTER}`);
  await fundUser();

  for (const [name, a] of [['UniversalRouter', UNIVERSAL_ROUTER], ['V4Quoter', V4_QUOTER], ['FeeVault', FEE_VAULT], ['Permit2', PERMIT2]] as const) {
    const code = await pub.getCode({ address: a });
    check(!!code && code !== '0x', `${name} has code on the fork`);
  }
  const myCode = await pub.getCode({ address: me });
  check(!myCode || myCode === '0x', 'user is a plain EOA (no 7702 delegation)');

  /* ───────────────────────── ETH -> USDG ───────────────────────── */
  console.log(`\n[1] ETH -> USDG: ${formatEther(ETH_IN)} ETH, fee ${FEE_BPS} bps, slippage ${SLIPPAGE_BPS} bps`);
  const q = await quoteEthToUsdg(pub, ETH_IN, { feeBps: FEE_BPS, slippageBps: SLIPPAGE_BPS });
  console.log(`  quote gross ${formatUnits(q.grossOut, 6)} USDG · fee ${formatUnits(q.fee, 6)} · net ${formatUnits(q.netOut, 6)} · min ${formatUnits(q.minAmountOut, 6)}`);

  const tooTight = await mustRevert(buildEthToUsdg({ amountIn: ETH_IN, minAmountOut: q.netOut + 1n, feeBps: FEE_BPS }), { outSymbol: 'USDG', outDecimals: 6 });
  check(!!tooTight && /below your minimum/.test(tooTight), `minOut = net + 1 reverts: "${tooTight}"`);
  const late = await mustRevert(buildEthToUsdg({ amountIn: ETH_IN, minAmountOut: q.minAmountOut, feeBps: FEE_BPS, deadline: 1n }));
  check(!!late && /deadline passed/.test(late), `past deadline reverts: "${late}"`);

  const [vU0, uU0, uE0, rE0, rU0] = await Promise.all([bal(USDG, FEE_VAULT), bal(USDG, me), ethBal(me), ethBal(UNIVERSAL_ROUTER), bal(USDG, UNIVERSAL_ROUTER)]);
  const s1 = await send('swap ETH->USDG', buildEthToUsdg({ amountIn: ETH_IN, minAmountOut: q.minAmountOut, feeBps: FEE_BPS }));
  const [vU1, uU1, uE1, rE1, rU1] = await Promise.all([bal(USDG, FEE_VAULT), bal(USDG, me), ethBal(me), ethBal(UNIVERSAL_ROUTER), bal(USDG, UNIVERSAL_ROUTER)]);
  const fee1 = vU1 - vU0;
  const got1 = uU1 - uU0;
  const gross1 = fee1 + got1;
  console.log(`  result: FeeVault +${formatUnits(fee1, 6)} USDG · user +${formatUnits(got1, 6)} USDG · gross ${formatUnits(gross1, 6)}`);
  check(fee1 === feeOf(gross1, FEE_BPS), `FeeVault got exactly floor(gross * ${FEE_BPS} / 1e4) = ${fee1} USDG units`);
  check(fee1 === q.fee && got1 === q.netOut, `fill matches the quote exactly (fee ${q.fee}, net ${q.netOut})`);
  check(got1 >= q.minAmountOut, `user received ${got1} >= minOut ${q.minAmountOut}`);
  check(uE0 - uE1 === ETH_IN + s1.gasCost, `user spent exactly ${formatEther(ETH_IN)} ETH + gas`);
  check(rE1 === rE0 && rU1 === rU0, 'router kept no ETH / USDG');

  /* ───────────────────────── USDG -> ETH ───────────────────────── */
  console.log(`\n[2] USDG -> ETH (gas top-up): ${formatUnits(USDG_IN, 6)} USDG, fee ${FEE_BPS} bps, slippage ${SLIPPAGE_BPS} bps`);
  const st0 = await readUsdgPermit2State(pub, me);
  const need = usdgSwapNeeds(st0, USDG_IN);
  console.log(`  permit2 state: USDG->Permit2 ${st0.erc20Allowance} · Permit2->router ${st0.permit2Amount} exp ${st0.permit2Expiration} · needs ${JSON.stringify(need)}`);
  if (need.erc20Approve) await send('USDG.approve(Permit2, max)', buildUsdgApprovePermit2Tx());

  const q2 = await quoteUsdgToEth(pub, USDG_IN, { feeBps: FEE_BPS, slippageBps: SLIPPAGE_BPS });
  console.log(`  quote gross ${formatEther(q2.grossOut)} ETH · fee ${formatEther(q2.fee)} · net ${formatEther(q2.netOut)} · min ${formatEther(q2.minAmountOut)}`);

  if (need.permit2Allowance) {
    const noAllowance = await mustRevert(buildUsdgToEth({ amountIn: USDG_IN, minAmountOut: q2.minAmountOut, feeBps: FEE_BPS }));
    check(!!noAllowance && /Permit2 allowance/.test(noAllowance), `no router allowance reverts: "${noAllowance}"`);
    const now = Number((await pub.getBlock()).timestamp);
    await send(`Permit2.approve(USDG, router, exactly ${formatUnits(USDG_IN, 6)}, +${PERMIT2_ROUTER_TTL_SECONDS / 60}min)`, buildPermit2ApproveRouterTx(USDG_IN, now + PERMIT2_ROUTER_TTL_SECONDS));
  }
  const tooTight2 = await mustRevert(buildUsdgToEth({ amountIn: USDG_IN, minAmountOut: q2.netOut + 1n, feeBps: FEE_BPS }), { outSymbol: 'ETH', outDecimals: 18 });
  check(!!tooTight2 && /below your minimum/.test(tooTight2), `minOut = net + 1 reverts: "${tooTight2}"`);

  const [vW0, vE0, uE2, uU2, rE2, rW2, rU2] = await Promise.all([
    bal(WETH, FEE_VAULT), ethBal(FEE_VAULT), ethBal(me), bal(USDG, me), ethBal(UNIVERSAL_ROUTER), bal(WETH, UNIVERSAL_ROUTER), bal(USDG, UNIVERSAL_ROUTER),
  ]);
  const s2 = await send('swap USDG->ETH', buildUsdgToEth({ amountIn: USDG_IN, minAmountOut: q2.minAmountOut, feeBps: FEE_BPS }));
  const [vW1, vE1, uE3, uU3, rE3, rW3, rU3] = await Promise.all([
    bal(WETH, FEE_VAULT), ethBal(FEE_VAULT), ethBal(me), bal(USDG, me), ethBal(UNIVERSAL_ROUTER), bal(WETH, UNIVERSAL_ROUTER), bal(USDG, UNIVERSAL_ROUTER),
  ]);
  const fee2 = vW1 - vW0;
  const got2 = uE3 - uE2 + s2.gasCost;
  const gross2 = fee2 + got2;
  console.log(`  result: FeeVault +${formatEther(fee2)} WETH · user +${formatEther(got2)} ETH (before gas) · gross ${formatEther(gross2)}`);
  check(fee2 === feeOf(gross2, FEE_BPS), `FeeVault got exactly floor(gross * ${FEE_BPS} / 1e4) = ${fee2} wei as WETH`);
  check(vE1 === vE0, 'FeeVault native ETH unchanged (fee arrives as WETH)');
  check(fee2 === q2.fee && got2 === q2.netOut, `fill matches the quote exactly (fee ${q2.fee}, net ${q2.netOut})`);
  check(got2 >= q2.minAmountOut, `user received ${got2} >= minOut ${q2.minAmountOut}`);
  check(uU2 - uU3 === USDG_IN, `user spent exactly ${formatUnits(USDG_IN, 6)} USDG`);
  check(rE3 === rE2 && rW3 === rW2 && rU3 === rU2, 'router kept no ETH / WETH / USDG');
  const st1 = await readUsdgPermit2State(pub, me);
  check(!need.permit2Allowance || st1.permit2Amount === 0n, `exact-amount Permit2 allowance fully consumed (now ${st1.permit2Amount})`);

  /* ───────────────────────── gas reserve ───────────────────────── */
  console.log('\n[3] gas reserve');
  const ethNow = await ethBal(me);
  const max = maxEthSwapIn(ethNow);
  check(ethNow - max === 300_000_000_000_000n, `"Max" (${formatEther(max)} ETH) leaves exactly 0.0003 ETH`);

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('fork test crashed:', humanizeFundError(e));
  console.error(e);
  process.exit(1);
});
