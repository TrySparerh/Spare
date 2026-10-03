/**
 * What counts as a payment (SPARE-BUILD.md §3.2).
 *
 * A payment is an outgoing USDG Transfer from a linked wallet, EXCLUDING
 * transfers:
 *   to-linked-wallet   to a wallet linked to the same account (incl. itself)
 *   to-account         to the investing account itself
 *   to-spare-contract  to any SPARE contract (e.g. the executor's own accrual pull)
 *   to-venue           to a pool / router of the swap venue — a swap is not a payment
 *   to-zero-address    a burn / redemption has no merchant (engine decision, see below)
 *
 * `to-zero-address`: a burn is a redemption, not spending. When in doubt the
 * engine under-accrues: it pulls money from users' wallets, so a false
 * negative costs a round-up and a false positive takes money the user never
 * meant to give.
 *
 * Known gap: Uniswap v3 pools are individual contracts, not in the static venue
 * list. The pure classifier accepts any extra venue addresses the caller knows
 * (e.g. an observer that resolved `factory()` of a counterparty). SPARE's own
 * venue allowlist is v4-only (AssetRegistry pool keys), and every v4 swap
 * settles into the PoolManager, which IS in the list.
 */
import { roundUpDelta } from "./roundup.ts";

export const EXCLUSION_REASONS = [
  "to-linked-wallet",
  "to-account",
  "to-spare-contract",
  "to-venue",
  "to-zero-address",
] as const;
export type ExclusionReason = (typeof EXCLUSION_REASONS)[number];

/**
 * Ledger-only reasons a real payment accrued nothing because of the account's
 * STATE at that block (not the payment's nature): no rule set yet, or the rule
 * disabled / capped at zero.
 */
export const STATE_REASONS = ["no-rule", "rule-disabled"] as const;
export type LedgerReason = ExclusionReason | (typeof STATE_REASONS)[number];

export interface ClassifyContext {
  account: string;
  /** Every wallet currently linked to the account. */
  linkedWallets: Iterable<string>;
  spareContracts: Iterable<string>;
  venue: Iterable<string>;
}

/** Lower-cased lookup sets, built once per account. */
export interface Classifier {
  classify(to: string): ExclusionReason | null;
}

const ZERO = "0x0000000000000000000000000000000000000000";

export function makeClassifier(ctx: ClassifyContext): Classifier {
  const lc = (xs: Iterable<string>) => new Set([...xs].map((x) => x.toLowerCase()));
  const account = ctx.account.toLowerCase();
  const wallets = lc(ctx.linkedWallets);
  const spare = lc(ctx.spareContracts);
  const venue = lc(ctx.venue);
  return {
    classify(to: string): ExclusionReason | null {
      const t = to.toLowerCase();
      if (t === ZERO) return "to-zero-address";
      if (t === account) return "to-account";
      if (wallets.has(t)) return "to-linked-wallet";
      if (spare.has(t)) return "to-spare-contract";
      if (venue.has(t)) return "to-venue";
      return null;
    },
  };
}

export interface ObservedTransfer {
  from: string;
  to: string;
  amount: bigint;
}

export interface PricedPayment {
  excludedReason: ExclusionReason | null;
  /** 0 when excluded; otherwise the rule's round-up. */
  delta: bigint;
}

/** Classify, then price with the rule. Excluded transfers accrue nothing. */
export function pricePayment(t: ObservedTransfer, classifier: Classifier, roundTo: number, multiplier: number): PricedPayment {
  const excludedReason = classifier.classify(t.to);
  return { excludedReason, delta: excludedReason ? 0n : roundUpDelta(t.amount, roundTo, multiplier) };
}
