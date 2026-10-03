/**
 * Sweep batching for the keeper — which accounts share a `sweep` call, and
 * the limit each call carries. Pure: quotes and oracle reads are injected, so
 * every decision here is unit-tested against a model pool.
 *
 * Why calls are split (audit A-M1). SweepExecutor.sweep nets every account's
 * leg of an asset into ONE all-or-nothing swap, marks each account swept for
 * the epoch BEFORE any leg runs, and defers every contributor of an asset if
 * that one swap reverts. The limit is quoted on the netted swap, so one large
 * account's price impact used to set everyone's limit: co-batched legs either
 * filled at the whale's average rate or, past the router's oracle band, were
 * all deferred to the next epoch. Separate calls are netted separately, so:
 *
 *   - an account whose leg alone moves an asset's price more than the impact
 *     cap is swept in a call of its own (after everyone else's);
 *   - the other accounts are packed so no call's netted swap of an asset
 *     exceeds the largest size measured to stay within the cap.
 *
 * Impact is measured against a $1 reference quote on the same pool (the fee
 * cancels) and assumed monotone in size, as it is on a v4 curve: any size at
 * or below one measured inside the cap is inside it too. A size never
 * measured inside the cap is treated as over it (isolated), never as fine.
 */
import type { Address } from "viem";
import {
  impactBps,
  limitFromQuote,
  netTotals,
  quoteVsOracle,
  splitMix,
  swapInFor,
  withoutAssets,
  type Leg,
  type LegState,
} from "./plan.ts";

export interface Due {
  account: Address;
  value: bigint;
  legs: readonly Leg[];
}

/** One swap to quote: asset tokens out for `swapIn` USDG on the asset's pinned pool. */
export interface QuoteReq {
  asset: Address;
  swapIn: bigint;
}
/** Quotes in request order; null when that swap could not be quoted. */
export type Quoter = (reqs: readonly QuoteReq[]) => Promise<(bigint | null)[]>;

/** Oracle price (1e18, OracleGuard OK) and the swap fee in pips of an asset's pinned pool. */
export interface Market {
  price1e18: bigint;
  feePips: number;
  /** Why the pool itself may not be used, whatever the quote (a hooked pool off its pin: hooks.ts). */
  held?: string;
}

/** The reference swap impact is measured against: $1. */
export const REF_SWAP_IN = 1_000_000n;
/** Sizes probed per over-cap asset: its largest distinct legs, and the netted swap halved this many times. */
export const IMPACT_PROBES = 8;

const lc = (a: string) => a.toLowerCase();

export interface Isolated<T> {
  entry: T;
  asset: Address;
  /** Its own leg's measured impact, bps; null when that size was not probed (larger than any size known to fit). */
  impactBps: number | null;
}

export interface Partition<T> {
  /** Sweep calls in send order: co-batched accounts first, then each isolated account alone. */
  calls: T[][];
  isolated: Isolated<T>[];
  /** Assets whose impact could not be measured; accounts holding one sit this tick out. */
  unmeasured: Address[];
  /** The accounts that sit out (they hold an unmeasured asset); their epoch is untouched. */
  sittingOut: T[];
  /** Per over-cap asset (lower-cased): the largest swapIn measured inside the impact cap. */
  caps: Map<string, bigint>;
}

/**
 * Split due accounts into sweep calls so that no account's price impact sets
 * another account's limit. Two quote rounds: the $1 reference and the netted
 * swap per asset; then, only for assets whose netted swap is over the cap,
 * the largest legs and a halving ladder of the netted size.
 */
export async function partitionSweep<T extends Due>(
  entries: readonly T[],
  opts: {
    needsQuote: (asset: Address) => boolean;
    feeBps: bigint;
    maxImpactBps: number;
    quote: Quoter;
    refSwapIn?: bigint;
    probes?: number;
  },
): Promise<Partition<T>> {
  const ref = opts.refSwapIn ?? REF_SWAP_IN;
  const probes = opts.probes ?? IMPACT_PROBES;
  const fee = (gross: bigint) => swapInFor(gross, opts.feeBps);

  // Gross USDG per asset each account will swap, and the netted total — as _collect / _addLeg build them.
  const legsOf = new Map<T, Map<string, bigint>>();
  const assetOf = new Map<string, Address>();
  const totals = new Map<string, bigint>();
  for (const e of entries) {
    const m = new Map<string, bigint>();
    for (const s of splitMix(e.value, e.legs)) {
      if (s.usdg === 0n || !opts.needsQuote(s.asset)) continue;
      const k = lc(s.asset);
      assetOf.set(k, s.asset);
      m.set(k, (m.get(k) ?? 0n) + s.usdg);
      totals.set(k, (totals.get(k) ?? 0n) + s.usdg);
    }
    legsOf.set(e, m);
  }

  // Round 1: reference + netted swap per asset.
  const keys = [...totals.keys()];
  const r1 = keys.length
    ? await opts.quote(keys.flatMap((k) => [{ asset: assetOf.get(k)!, swapIn: ref }, { asset: assetOf.get(k)!, swapIn: fee(totals.get(k)!) }]))
    : [];
  const refs = new Map<string, { swapIn: bigint; out: bigint }>();
  const unmeasured = new Set<string>();
  const hot: string[] = [];
  keys.forEach((k, i) => {
    const refOut = r1[2 * i];
    const totOut = r1[2 * i + 1];
    if (!refOut || !totOut) {
      unmeasured.add(k);
      return;
    }
    refs.set(k, { swapIn: ref, out: refOut });
    if (impactBps(refs.get(k)!, fee(totals.get(k)!), totOut) > opts.maxImpactBps) hot.push(k);
  });

  // Round 2, over-cap assets only: what sizes stay inside the cap?
  const caps = new Map<string, bigint>();
  const measured = new Map<string, number>();
  if (hot.length) {
    const reqs: { k: string; swapIn: bigint }[] = [];
    for (const k of hot) {
      caps.set(k, ref); // the reference itself is inside the cap by definition
      const sizes = new Set<bigint>();
      const legs = [...new Set(entries.map((e) => legsOf.get(e)!.get(k)).filter((g): g is bigint => g !== undefined).map(fee))];
      legs.sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
      for (const s of legs.slice(0, probes)) if (s > ref) sizes.add(s);
      let s = fee(totals.get(k)!);
      for (let i = 0; i < probes; i++) {
        s /= 2n;
        if (s <= ref) break;
        sizes.add(s);
      }
      for (const swapIn of sizes) reqs.push({ k, swapIn });
    }
    const r2 = reqs.length ? await opts.quote(reqs.map((r) => ({ asset: assetOf.get(r.k)!, swapIn: r.swapIn }))) : [];
    reqs.forEach((r, i) => {
      const out = r2[i];
      if (!out) return; // unquotable at this size: never counted as inside the cap
      const imp = impactBps(refs.get(r.k)!, r.swapIn, out);
      measured.set(`${r.k}:${r.swapIn}`, imp);
      if (imp <= opts.maxImpactBps && r.swapIn > caps.get(r.k)!) caps.set(r.k, r.swapIn);
    });
  }

  // Isolate every account with a leg over its asset's cap; keep the rest.
  const isolated: Isolated<T>[] = [];
  const keep: T[] = [];
  const sittingOut: T[] = [];
  for (const e of entries) {
    const m = legsOf.get(e)!;
    if ([...m.keys()].some((k) => unmeasured.has(k))) {
      sittingOut.push(e);
      continue;
    }
    let worst: { k: string; imp: number | null } | null = null;
    for (const k of hot) {
      const g = m.get(k);
      if (g === undefined || fee(g) <= caps.get(k)!) continue;
      const imp = measured.get(`${k}:${fee(g)}`) ?? null;
      if (!worst || (imp ?? Number.POSITIVE_INFINITY) > (worst.imp ?? Number.POSITIVE_INFINITY)) worst = { k, imp };
    }
    if (worst) isolated.push({ entry: e, asset: assetOf.get(worst.k)!, impactBps: worst.imp });
    else keep.push(e);
  }

  // First-fit: a call takes an account while every over-cap asset's netted swap stays within its cap.
  const packed: { entries: T[]; sum: Map<string, bigint> }[] = [];
  for (const e of keep) {
    const m = legsOf.get(e)!;
    const fits = (sum: Map<string, bigint>) =>
      hot.every((k) => {
        const g = m.get(k);
        return g === undefined || fee((sum.get(k) ?? 0n) + g) <= caps.get(k)!;
      });
    let call = packed.find((c) => fits(c.sum));
    if (!call) packed.push((call = { entries: [], sum: new Map() }));
    call.entries.push(e);
    for (const k of hot) {
      const g = m.get(k);
      if (g !== undefined) call.sum.set(k, (call.sum.get(k) ?? 0n) + g);
    }
  }

  return {
    calls: [...packed.map((c) => c.entries), ...isolated.map((i) => [i.entry])],
    isolated,
    unmeasured: [...unmeasured].map((k) => assetOf.get(k)!),
    sittingOut,
    caps,
  };
}

/**
 * The pool half of the oracle check (B-L3): why a pool's $1 reference quote
 * is too far under the oracle to trust, or null when it is close enough. It
 * does not depend on any account's size, so it holds an asset for the whole
 * tick, whatever call the asset is in.
 */
export function poolHeld(ref: bigint, m: Market, allowanceBps: number): string | null {
  if (m.held) return m.held;
  const spot = quoteVsOracle({ swapIn: REF_SWAP_IN, quotedOut: ref, price1e18: m.price1e18, feePips: m.feePips, allowanceBps });
  return spot.ok ? null : `pool ${spot.shortfallBps.toFixed(1)} bps under the oracle at $1 (max ${spot.maxBps.toFixed(1)}: pool fee + ${allowanceBps})`;
}

/**
 * Assets whose pool already fails the $1 oracle check, with why: one $1
 * quote and one oracle / pool-fee read per asset. An asset that cannot be
 * quoted or priced here is not held (planCall decides it per call); only a
 * measured failure is. The keeper screens these out before it fills a
 * tick's per-call budget, so accounts that are certain to be held this tick
 * do not take the slots of accounts that can be swept.
 */
export async function heldPools(
  assets: readonly Address[],
  opts: { quote: Quoter; market: (assets: readonly Address[]) => Promise<Map<string, Market>>; allowanceBps: number },
): Promise<Map<string, { asset: Address; why: string }>> {
  const held = new Map<string, { asset: Address; why: string }>();
  if (!assets.length) return held;
  const [refs, market] = await Promise.all([opts.quote(assets.map((asset) => ({ asset, swapIn: REF_SWAP_IN }))), opts.market(assets)]);
  assets.forEach((asset, i) => {
    const ref = refs[i];
    const m = market.get(lc(asset));
    if (!ref || !m) return;
    const why = poolHeld(ref, m, opts.allowanceBps);
    if (why) held.set(lc(asset), { asset, why });
  });
  return held;
}

export interface CallPlan<T> {
  chosen: T[];
  limits: { asset: Address; minOutPerUsdg: bigint }[];
  /** Per asset with a limit (lower-cased): the $1 reference quote and oracle price the plan was checked at. */
  refs: Map<string, { ref: bigint; price1e18: bigint }>;
  /** Assets taken out of this call and why; accounts holding one wait for a later tick. */
  dropped: Map<string, { asset: Address; why: string }>;
  settleOnly: number;
}

/**
 * Net, quote and check ONE sweep call. Every asset left in it must carry a
 * limit: a missing limit makes the executor defer the leg AFTER marking the
 * account swept for the epoch. So an asset that cannot be quoted or has no OK
 * oracle price takes its accounts out of this call, and so does one that fails
 * the oracle check (B-L3), in two parts:
 *  - the pool itself: a $1 reference swap may be at most the pool fee +
 *    `allowanceBps` under the oracle (a pool pushed off the oracle is held,
 *    whatever the call's size);
 *  - the call's size: the netted quote may add at most `sizeAllowanceBps` on
 *    top (a packed call), never more than `maxShortfallBps` in all; an
 *    `isolated` call (one account, its own impact) is held to
 *    `maxShortfallBps` only, so a large account is swept alone, not never.
 * The rest is re-netted and re-quoted (netting changes swapIn and the limit).
 */
export async function planCall<T extends Due>(
  entries: readonly T[],
  opts: {
    state: (asset: Address) => LegState | undefined;
    feeBps: bigint;
    toleranceBps: bigint;
    allowanceBps: number;
    sizeAllowanceBps: number;
    maxShortfallBps: number;
    isolated: boolean;
    quote: Quoter;
    market: (assets: readonly Address[]) => Promise<Map<string, Market>>;
  },
): Promise<CallPlan<T>> {
  const needsQuote = (a: Address) => opts.state(a) === "ok";
  const quoted = new Map<string, bigint | null>();
  const dropped = new Map<string, { asset: Address; why: string }>();
  let chosen = [...entries];
  let limits: { asset: Address; minOutPerUsdg: bigint }[] = [];
  let refs = new Map<string, { ref: bigint; price1e18: bigint }>();
  const first = netTotals(chosen, needsQuote);
  const market = first.size ? await opts.market([...first.keys()]) : new Map<string, Market>();
  for (;;) {
    const totals = netTotals(chosen, needsQuote);
    const need = [...totals].map(([asset, total]) => ({ asset, swapIn: swapInFor(total, opts.feeBps) }));
    const key = (n: QuoteReq) => `${lc(n.asset)}:${n.swapIn}`;
    const refOf = (asset: Address): QuoteReq => ({ asset, swapIn: REF_SWAP_IN });
    const fresh = [...need, ...need.map((n) => refOf(n.asset))].filter(
      (n, i, all) => !quoted.has(key(n)) && all.findIndex((o) => key(o) === key(n)) === i,
    );
    const got = fresh.length ? await opts.quote(fresh) : [];
    fresh.forEach((n, i) => quoted.set(key(n), got[i] ?? null));
    limits = [];
    refs = new Map();
    let failed = false;
    for (const n of need) {
      const out = quoted.get(key(n)) ?? null;
      const ref = quoted.get(key(refOf(n.asset))) ?? null;
      const m = market.get(lc(n.asset));
      let why: string | null = null;
      if (!out) why = "no quote";
      else if (!ref) why = "no $1 reference quote";
      else if (!m) why = "no OK oracle price";
      else {
        why = poolHeld(ref, m, opts.allowanceBps);
        if (!why) {
          // Whole pips, so quoteVsOracle's floor stays an exact integer.
          const capPips = opts.isolated
            ? opts.maxShortfallBps * 100
            : Math.min(m.feePips + (opts.allowanceBps + opts.sizeAllowanceBps) * 100, opts.maxShortfallBps * 100);
          const full = quoteVsOracle({ swapIn: n.swapIn, quotedOut: out, price1e18: m.price1e18, feePips: capPips, allowanceBps: 0 });
          if (!full.ok) why = `quote ${full.shortfallBps.toFixed(1)} bps under the oracle (max ${full.maxBps.toFixed(1)}${opts.isolated ? ", alone" : ""})`;
        }
      }
      const lim = out && !why ? limitFromQuote(n.swapIn, out, opts.toleranceBps) : 0n;
      if (lim > 0n) {
        limits.push({ asset: n.asset, minOutPerUsdg: lim });
        refs.set(lc(n.asset), { ref: ref!, price1e18: m!.price1e18 });
      } else {
        dropped.set(lc(n.asset), { asset: n.asset, why: why ?? "limit rounds to 0" });
        failed = true;
      }
    }
    if (!failed) break;
    chosen = withoutAssets(chosen, new Set(dropped.keys()));
    if (chosen.length === 0) {
      limits = [];
      refs = new Map();
      break;
    }
  }
  const settleOnly = chosen.filter((c) => c.legs.every((l) => opts.state(l.asset) === "settle")).length;
  return { chosen, limits, refs, dropped, settleOnly };
}

/** An asset an isolated call bought (A-M1): its pool's $1 reference quote and the oracle price before the call. */
export interface Recovery {
  asset: Address;
  /** Asset tokens out for REF_SWAP_IN, quoted at the block the call was planned at. */
  ref: bigint;
  price1e18: bigint;
  /** When the call was mined (ms). */
  since: number;
}

/**
 * Whether an asset an isolated call bought is still held (A-M1 residual).
 * The whale is swept last, so its price impact stays in the pool; the $1
 * pool check alone (poolHeld: fee + allowance under the oracle) would let
 * accounts still due fill into what is left of it. So the asset waits until
 * its $1 quote is back within `bps` of its pre-sweep value. That value is
 * rebased by the oracle's move since (tokens per $1 scale as 1 / price), so a
 * real market move the feed has posted is not mistaken for leftover impact.
 * Unreadable now (no quote, no OK price) stays held; after `maxMs` the hold
 * lapses whatever the quote says.
 */
export function recoveryHeld(
  r: Recovery,
  now: { ref: bigint | null; price1e18: bigint | null; at: number },
  opts: { bps: number; maxMs: number },
): { held: true; why: string } | { held: false; why: "recovered" | "expired" } {
  if (now.at - r.since >= opts.maxMs) return { held: false, why: "expired" };
  if (now.ref === null) return { held: true, why: "no $1 reference quote" };
  if (now.price1e18 === null || now.price1e18 <= 0n) return { held: true, why: "no OK oracle price" };
  const expected = (r.ref * r.price1e18) / now.price1e18;
  if (now.ref * 10_000n >= expected * BigInt(10_000 - opts.bps)) return { held: false, why: "recovered" };
  const gap = Number(((expected - now.ref) * 100_000n) / expected) / 10;
  return { held: true, why: `$1 quote ${gap.toFixed(1)} bps under its value before an isolated sweep (max ${opts.bps})` };
}
