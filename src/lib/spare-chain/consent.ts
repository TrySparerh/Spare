/**
 * Pull consent, judged the way the keeper judges it.
 *
 * A pull needs BOTH approvals from the spending wallet:
 *   USDG.allowance(wallet, Permit2)                       ERC-20 leg
 *   Permit2.allowance(wallet, USDG, SweepExecutor)        Permit2 leg (amount, expiration)
 *
 * The keeper only pulls while the Permit2 leg is live with KEEPER_EXPIRY_MARGIN
 * seconds to spare (engine/src/keeper/keeper.ts MAX_UINT48_SAFETY), and a pull
 * larger than either allowance reverts inside Permit2. So "authorized" here
 * means both legs are live AND together they cover at least the account's
 * weekly cap — anything less is surfaced, never shown as a plain green light.
 *
 * Pure: no React, no RPC — the apps feed it what they read.
 *
 * Labels and details come out in the live language (apps-a `consent.*` /
 * `collection.*`), built each time a view is made: call these during render.
 * Compare `state`, never the label.
 */
import { currentLang, getT } from '@/i18n';
import { formatUsd, ruleIsActive, type ChainRule } from '@/lib/spare';
import { shortAddr } from './addresses';

const tf = getT('apps-a');

/** An allowance this large is "unlimited" for display purposes. */
export const UNLIMITED_ALLOWANCE = 1n << 128n;

/** Seconds of Permit2 expiry headroom the keeper requires before it will pull. */
export const KEEPER_EXPIRY_MARGIN = 60;

export interface ConsentRead {
  /** USDG.allowance(wallet, Permit2). */
  erc20: bigint;
  /** Permit2.allowance(wallet, USDG, SweepExecutor).amount */
  p2Amount: bigint;
  /** Permit2.allowance(wallet, USDG, SweepExecutor).expiration (unix seconds). */
  p2Expiration: number;
}

export type ConsentTone = 'up' | 'warn' | 'down' | 'muted';

/** What the two allowances add up to. Compare this, not the translated label. */
export type ConsentState = 'reading' | 'authorized' | 'low' | 'expired' | 'none' | 'partial';

export interface ConsentView {
  state: ConsentState;
  label: string;
  tone: ConsentTone;
  /** Both legs live — the keeper would try to pull from this wallet now. */
  pullable: boolean;
  /** Pullable AND the allowances cover the weekly cap (or are unlimited). */
  ok: boolean;
  /** The Permit2 → SweepExecutor allowance is set and unexpired: Revoke has something to end. */
  p2Live: boolean;
  detail: string;
}

function reading(): ConsentView {
  return {
    state: 'reading',
    label: tf('consent.label.reading'),
    tone: 'muted',
    pullable: false,
    ok: false,
    p2Live: false,
    detail: tf('consent.detail.reading'),
  };
}

function fmtAllowance(v: bigint): string {
  return v >= UNLIMITED_ALLOWANCE ? tf('consent.unlimited') : formatUsd(v);
}

/** The Permit2 expiry date: the browser's own format in English (unchanged), the chosen language otherwise. */
function dateText(sec: number): string {
  const lang = currentLang();
  return new Date(sec * 1000).toLocaleDateString(lang === 'en' ? undefined : lang);
}

/**
 * What one wallet's allowances mean for round-up pulls.
 * `weeklyCap` is the cap of the account the wallet feeds (undefined while unread).
 */
export function consentView(c: ConsentRead | undefined, opts: { now: number; weeklyCap?: bigint }): ConsentView {
  if (!c) return reading();
  const { now, weeklyCap } = opts;
  const erc20Ok = c.erc20 > 0n;
  const p2Live = c.p2Amount > 0n && c.p2Expiration > now;
  const p2Pullable = c.p2Amount > 0n && c.p2Expiration > now + KEEPER_EXPIRY_MARGIN;
  const until = c.p2Expiration > 0 ? dateText(c.p2Expiration) : '';

  if (erc20Ok && p2Pullable) {
    const room = c.erc20 < c.p2Amount ? c.erc20 : c.p2Amount;
    const unlimited = room >= UNLIMITED_ALLOWANCE;
    const coversCap = weeklyCap != null && weeklyCap > 0n && room >= weeklyCap;
    if (unlimited || coversCap) {
      const detail = c.erc20 < UNLIMITED_ALLOWANCE
        ? tf('consent.detail.authorizedLimited', { until, amount: formatUsd(c.erc20) })
        : tf('consent.detail.authorized', { until });
      return { state: 'authorized', label: tf('consent.label.authorized'), tone: 'up', pullable: true, ok: true, p2Live, detail };
    }
    const legs = { room: formatUsd(room), erc20: fmtAllowance(c.erc20), p2: fmtAllowance(c.p2Amount) };
    return {
      state: 'low',
      label: tf('consent.label.low'),
      tone: 'warn',
      pullable: true,
      ok: false,
      p2Live,
      detail: weeklyCap != null && weeklyCap > 0n
        ? tf('consent.detail.lowVsCap', { ...legs, cap: formatUsd(weeklyCap) })
        : tf('consent.detail.low', legs),
    };
  }
  if (c.p2Amount > 0n && !p2Pullable) {
    return {
      state: 'expired',
      label: tf('consent.label.expired'),
      tone: 'warn',
      pullable: false,
      ok: false,
      p2Live,
      detail: p2Live ? tf('consent.detail.expiring', { until }) : tf('consent.detail.expired', { until }),
    };
  }
  if (!erc20Ok && c.p2Amount === 0n) {
    return { state: 'none', label: tf('consent.label.none'), tone: 'down', pullable: false, ok: false, p2Live, detail: tf('consent.detail.none') };
  }
  return {
    state: 'partial',
    label: tf('consent.label.partial'),
    tone: 'warn',
    pullable: false,
    ok: false,
    p2Live,
    detail: erc20Ok ? tf('consent.detail.partialNoP2') : tf('consent.detail.partialNoErc20'),
  };
}

/* ------------------------- account-level collection ------------------------ */

export interface WalletConsent {
  wallet: string;
  consent: ConsentView;
}

export interface CollectionState {
  label: string;
  tone: ConsentTone;
  detail: string;
  /** True only when at least one linked wallet can actually be pulled from. */
  collecting: boolean;
}

/**
 * Is this account actually collecting round-ups? A rule that is ON says only
 * that the account WANTS round-ups; the keeper pulls nothing without a linked
 * wallet whose two approvals are live.
 */
export function collectionState(rule: ChainRule | undefined, wallets: readonly WalletConsent[] | undefined): CollectionState {
  if (!ruleIsActive(rule)) {
    return { label: tf('collection.label.off'), tone: 'muted', collecting: false, detail: tf('collection.detail.off') };
  }
  if (!wallets) return { label: tf('collection.label.on'), tone: 'muted', collecting: false, detail: tf('collection.detail.checking') };
  const n = wallets.length;
  if (n === 0) {
    return {
      label: tf('collection.label.noWallet'),
      tone: 'warn',
      collecting: false,
      detail: tf('collection.detail.noWallet'),
    };
  }
  if (wallets.some((w) => w.consent.state === 'reading')) {
    return { label: tf('collection.label.on'), tone: 'muted', collecting: false, detail: tf('collection.detail.checkingN', { n }) };
  }
  const pullable = wallets.filter((w) => w.consent.pullable);
  const names = (ws: readonly WalletConsent[]) => ws.map((w) => shortAddr(w.wallet)).join(tf('collection.listSep'));
  if (pullable.length === 0) {
    return {
      label: tf('collection.label.notAuthorized'),
      tone: 'warn',
      collecting: false,
      detail: tf('collection.detail.notAuthorized', { n }),
    };
  }
  if (pullable.length < n) {
    const missing = wallets.filter((w) => !w.consent.pullable);
    return {
      label: tf('collection.label.some', { n: pullable.length, total: n }),
      tone: 'warn',
      collecting: true,
      detail: tf('collection.detail.some', { pullable: names(pullable), missing: names(missing) }),
    };
  }
  const low = wallets.filter((w) => !w.consent.ok);
  if (low.length > 0) {
    return {
      label: tf('collection.label.low'),
      tone: 'warn',
      collecting: true,
      detail: tf('collection.detail.low', { n, low: names(low) }),
    };
  }
  return { label: tf('collection.label.on'), tone: 'up', collecting: true, detail: tf('collection.detail.on', { n }) };
}
