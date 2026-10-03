/**
 * The chain libs build some user-facing text themselves (consent and oracle
 * badges, feed rows, guard sentences, "3m ago"). They must follow the chosen
 * language, not stay English.
 */
import { act } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { setLanguage } from '@/i18n';
import { collectionState, consentView } from './consent';
import { oracleView } from './hooks';
import { ago, feedRowTag, feedRowText, keeperStatus } from './protocol-feed';
import { checkSwapPrice } from './fund-swap';
import { FIXTURE_TOKENS as ASSET_TOKENS, primeFixtureNames } from '@/test/assetFixtures';
import { validateMix } from '@/lib/spare';
import { fmtAgo } from '@/lib/stockBoard';
import { publicTabLabel, PUBLIC_TABS } from '@/components/public/publicTabs';

beforeAll(primeFixtureNames);

afterEach(async () => {
  await act(() => setLanguage('en'));
  localStorage.clear();
});

const NOW = 1_800_000_000;
const rule = { roundTo: 1, multiplier: 1, weeklyCap: 25_000_000n, enabled: true } as never;

function samples() {
  return {
    consent: consentView({ erc20: 0n, p2Amount: 0n, p2Expiration: 0 }, { now: NOW }),
    collection: collectionState(rule, []),
    oracle: oracleView(1),
    row: feedRowText({ kind: 'Accrued', args: { amount: 1_250_000n } }),
    tag: feedRowTag('AssetSwept').label,
    keeper: keeperStatus({ lastCollectOrSweepAt: null, nowSec: 5, linkedWallets: 3 }).label,
    ago: ago(0, 7_200),
    boardAgo: fmtAgo(NOW - 300, NOW * 1000),
    mix: validateMix([], { maxLegs: 6, isEligible: () => true }),
    guard: checkSwapPrice({
      zeroForOne: true,
      fill: { amountIn: 10n ** 18n, grossOut: 0n },
      probe: null,
      ref: null,
      now: NOW,
    }).block,
    tab: publicTabLabel(PUBLIC_TABS.find((x) => x.to === '/dispatch')!),
  };
}

describe('lib-built text follows the language', () => {
  it('is the original English in English', () => {
    const s = samples();
    expect(s.consent.label).toBe('NOT AUTHORIZED');
    expect(s.consent.state).toBe('none');
    expect(s.collection.label).toBe('ON · NO WALLET');
    expect(s.oracle).toMatchObject({ label: 'STALE', detail: 'feed older than heartbeat + 1h (market closed) — sweep waits' });
    expect(s.row).toBe('Round-up collected · $1.25');
    expect(s.tag).toBe('BOUGHT');
    expect(s.keeper).toBe('Standing by — watching 3 linked wallets');
    expect(s.ago).toBe('2h ago');
    expect(s.boardAgo).toBe('5m ago');
    expect(s.mix).toBe('Add at least one asset.');
    expect(s.guard).toBe('The pool quoted nothing for this amount — swap blocked.');
    expect(s.tab).toBe('Dispatch');
  });

  it('switches to Simplified and Traditional Chinese', async () => {
    await act(() => setLanguage('zh-CN'));
    const cn = samples();
    expect(cn.consent.label).toBe('未授权');
    expect(cn.consent.state).toBe('none');
    expect(cn.collection.label).toBe('已开启 · 无钱包');
    expect(cn.oracle.label).toBe('已过时');
    expect(cn.row).toBe('已收取凑整 · $1.25');
    expect(cn.ago).toBe('2 小时前');
    expect(cn.boardAgo).toBe('5 分钟前');
    expect(cn.mix).toBe('请至少添加一个资产。');
    expect(cn.guard).toMatch(/已阻止兑换/);
    expect(cn.tab).toBe('实时买入');

    await act(() => setLanguage('zh-TW'));
    const tw = samples();
    expect(tw.consent.label).toBe('未授權');
    expect(tw.oracle.label).toBe('已過時');
    expect(tw.keeper).toMatch(/待命中/);
    expect(tw.boardAgo).toBe('5 分鐘前');
    expect(tw.guard).toMatch(/已阻止兌換/);
    expect(tw.tab).toBe('即時買進');
    // Tickers and amounts are never translated.
    expect(feedRowText({ kind: 'Deferred', args: { asset: ASSET_TOKENS.NVDA, usdg: 2_000_000n, status: 1 } })).toBe(
      'NVDA 成分已順延 · $2.00 · 休市',
    );
  });
});
