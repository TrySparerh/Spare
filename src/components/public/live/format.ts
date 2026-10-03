/** Formatting for the live developer pages (pure; unit-tested). */
import { formatUnits } from 'viem';

/**
 * A USDG → stock fill vs the Chainlink answer, in percent.
 * `usdgIn` is USDG base units (6 dp), `tokensOut` stock base units (18 dp),
 * `oracle1e18` USD per token at 1e18. Positive = paying above Chainlink.
 */
export function edgePct(usdgIn: bigint, tokensOut: bigint, oracle1e18: bigint): number | null {
  if (usdgIn <= 0n || tokensOut <= 0n || oracle1e18 <= 0n) return null;
  const fill1e18 = (usdgIn * 10n ** 12n * 10n ** 18n) / tokensOut;
  return Number(((fill1e18 - oracle1e18) * 1_000_000n) / oracle1e18) / 10_000;
}

/** "+0.29%", "-0.05%", "—". */
export function fmtEdge(p: number | null | undefined): string {
  if (p == null || !Number.isFinite(p)) return '—';
  return `${p > 0 ? '+' : ''}${p.toFixed(2)}%`;
}

/** Uniswap v4 pool fee (hundredths of a bip) → "0.30%", "0.01%", "1.00%", "0.00%"; the dynamic-fee flag → "dynamic". */
export function fmtPoolFee(fee: number): string {
  if (fee === 0x800000) return 'dynamic';
  return `${(fee / 10_000).toFixed(fee % 100 === 0 ? 2 : 4)}%`;
}

/** A Chainlink answer (8 dp) as dollars. */
export function fmtFeedPrice(answer: bigint | null | undefined, decimals = 8): string {
  if (answer == null) return '—';
  const n = Number(formatUnits(answer, decimals));
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: n < 10 ? 4 : 2 })}`;
}
