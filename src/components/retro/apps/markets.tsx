/**
 * Shared pieces for the Markets apps (Stock Desk, After Hours, Portfolio
 * X-Ray): the market badge, the copyable token key, pool labels and the
 * standing notes about what a stock token is.
 */
import { useState, type CSSProperties } from 'react';
import { zeroAddress } from 'viem';
import { EXPLORER_URL } from '@/lib/spare-chain/addresses';
import type { PoolKey } from '@/lib/spare-chain/fund-swap';
import type { MarketState } from '@/lib/stockBoard';
import { BEVEL_WELL, FONT_TEXT, HOLO, INK, HoloBadge, type HoloTone } from '@/components/retro/holo';
import { getT, tKey, useTranslation } from '@/i18n';

const tf = getT('apps-b');

/** v4's dynamic-fee flag: the hook sets the LP fee per swap. */
const DYNAMIC_FEE = 0x800000;

/** The standing note under every stock board (an apps-b key: translate at render). */
export const STOCK_TOKEN_NOTE = tKey('markets.stockTokenNote');

/** "Uniswap v4 · 0.01% · no hook", or "—" before the registry answers. */
export function poolLabel(pk: PoolKey | null | undefined): string {
  if (!pk) return '—';
  const pct = Number(pk.fee) / 10_000;
  const fee =
    Number(pk.fee) === DYNAMIC_FEE
      ? tf('markets.dynamicFee')
      : `${pct.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: pct < 0.01 ? 4 : 2 })}%`;
  const hooked = pk.hooks && pk.hooks.toLowerCase() !== zeroAddress;
  return `Uniswap v4 · ${fee} · ${hooked ? tf('markets.hooked') : tf('markets.noHook')}`;
}

export function shortToken(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export function tokenUrl(a: string): string {
  return `${EXPLORER_URL}/token/${a}`;
}

/** Labels and titles are apps-b keys, translated where the badge renders. */
const MARKET: Record<MarketState | 'loading' | 'offline', { label: string; tone: HoloTone; title: string }> = {
  open: { label: tKey('markets.market.live'), tone: 'good', title: tKey('markets.market.liveTitle') },
  mixed: { label: tKey('markets.market.partly'), tone: 'warn', title: tKey('markets.market.partlyTitle') },
  closed: { label: tKey('markets.market.closed'), tone: 'warn', title: tKey('markets.market.closedTitle') },
  unknown: { label: tKey('markets.market.checking'), tone: 'warn', title: tKey('markets.market.checkingTitle') },
  loading: { label: tKey('markets.market.checking'), tone: 'warn', title: tKey('markets.market.checkingTitle') },
  offline: { label: tKey('shared.unavailable'), tone: 'bad', title: tKey('markets.market.offlineTitle') },
};

export function MarketBadge({
  market,
  loading,
  error,
  size = 'md',
}: {
  market: MarketState;
  loading: boolean;
  error: Error | null;
  size?: 'sm' | 'md';
}) {
  const { t } = useTranslation('apps-b');
  const key: keyof typeof MARKET = market !== 'unknown' ? market : error ? 'offline' : loading ? 'loading' : 'unknown';
  const m = MARKET[key];
  return <HoloBadge label={t(m.label)} tone={m.tone} title={t(m.title)} pulse={key === 'loading'} size={size} dot />;
}

const KEY: CSSProperties = {
  height: 24,
  padding: '0 8px',
  border: 0,
  background: HOLO.paper,
  boxShadow: BEVEL_WELL,
  color: HOLO.link,
  fontFamily: FONT_TEXT,
  fontWeight: 700,
  fontSize: 11,
  whiteSpace: 'nowrap',
  cursor: 'pointer',
};

export const LINK: CSSProperties = {
  fontFamily: FONT_TEXT,
  fontWeight: 700,
  fontSize: 11.5,
  color: INK.link,
  textDecorationLine: 'underline',
  textDecorationStyle: 'dotted',
  textUnderlineOffset: 3,
  whiteSpace: 'nowrap',
};

/** The token address as a little sunken paper key: click to copy, plus a Blockscout link. */
export function TokenKey({ token, symbol }: { token: string; symbol: string }) {
  const { t } = useTranslation('apps-b');
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard blocked — the explorer link still shows the full address */
    }
  };
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <button
        type="button"
        onClick={copy}
        title={t('markets.copyTitle', { token })}
        aria-label={t('markets.copyAria', { symbol, short: shortToken(token) })}
        style={KEY}
      >
        {copied ? t('markets.copied') : shortToken(token)}
      </button>
      <a href={tokenUrl(token)} target="_blank" rel="noopener noreferrer" style={LINK}>
        Blockscout ↗
      </a>
    </span>
  );
}
