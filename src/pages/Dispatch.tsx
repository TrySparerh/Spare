/**
 * /dispatch — the live sweep log: every round-up collected
 * and every sweep Spare runs, read straight from Spare's contracts on
 * Robinhood Chain. Each row links to its transaction; no row ever shows an
 * account or wallet address.
 *
 * Data (all on-chain, no backend):
 *   feed    SweepExecutor + CashPark events, ≤ 50,000-block eth_getLogs
 *           chunks, the last 7 days first; "Load older" pages back a week at a
 *           time down to the deploy block; new blocks are picked up every 30 s
 *   totals  Σ Accrued / Σ AssetSwept since deployment (narrow scans)
 *   keeper  its ETH balance, newest collection / sweep, linked wallets
 *
 * Text: pages-b namespace (`dispatch.*`). Row sentences, badges and keeper
 * words come from protocol-feed (feedRowText / feedRowTag / keeperStatus),
 * which builds them in the live language (pages-b `feed.*`, `dispatch.tags.*`,
 * `dispatch.keeper.*`).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatEther, type PublicClient } from 'viem';
import {
  FONT_TEXT,
  HOLO,
  INK,
  HoloBadge,
  HoloButton,
  HoloCard,
  HoloHero,
  HoloNotice,
  HoloProgress,
  HoloScreen,
  HoloStat,
} from '@/components/retro/holo';
import { formatUsd } from '@/lib/spare';
import { START_BLOCK } from '@/lib/spare-chain/addresses';
import { WEEK_BLOCKS, blockTimes, olderWindow } from '@/lib/spare-chain/activity';
import {
  ago,
  feedRowTag,
  feedRowText,
  keeperStatus,
  scanFeed,
  sortFeedNewestFirst,
  summarizeFeed,
  type FeedEvent,
} from '@/lib/spare-chain/protocol-feed';
import { DEPLOY_BLOCK, KEEPER } from '@/components/public/live/addressBook';
import { LivePageFrame } from '@/components/public/live/LivePageFrame';
import { AddressLink, Bullets, CtaRow, Grid, LinkButton, Prose, TxLinkOut } from '@/components/public/live/LiveAtoms';
import { usePageMeta } from '@/components/public/live/pageMeta';
import { useKeeperPulse, useProtocolTotals, useRhcClient, type TimedEvent } from '@/components/public/live/useLiveChain';
import { Trans, tKey, useTranslation } from '@/i18n';
import { useAssetNames } from '@/lib/spare-chain/universe';

const PAGE = 50;
const REFRESH_MS = 30_000;

/* ----------------------------------- i18n ---------------------------------- */

/** protocol-feed's ago() ("3m ago"); it already returns the live language (pages-b `common.ago.*`). */
function useAgo() {
  return ago;
}


/* ---------------------------------- feed ----------------------------------- */

interface FeedWindow {
  events: FeedEvent[];
  /** Lowest block scanned (inclusive). */
  from: bigint;
  /** Highest block scanned (inclusive). */
  to: bigint;
}

function mergeEvents(a: FeedEvent[], b: FeedEvent[]): FeedEvent[] {
  const seen = new Map<string, FeedEvent>();
  for (const e of [...a, ...b]) seen.set(e.id, e);
  return sortFeedNewestFirst([...seen.values()]);
}

function useDispatchFeed(client: PublicClient | undefined) {
  const [win, setWin] = useState<FeedWindow | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [olderBusy, setOlderBusy] = useState(false);
  const [olderError, setOlderError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const winRef = useRef<FeedWindow | null>(null);
  winRef.current = win;

  // First load: the last 7 days (never before the deploy block).
  useEffect(() => {
    if (!client) return;
    const ctl = new AbortController();
    setStatus('loading');
    setProgress(null);
    (async () => {
      try {
        const head = await client.getBlockNumber();
        const lo = head - WEEK_BLOCKS + 1n;
        const from = lo < START_BLOCK ? START_BLOCK : lo;
        const events = await scanFeed(client, from, head, {
          signal: ctl.signal,
          onProgress: (done, total) => setProgress({ done, total }),
        });
        if (ctl.signal.aborted) return;
        setWin({ events, from, to: head });
        setStatus('ready');
      } catch {
        if (!ctl.signal.aborted) setStatus('error');
      }
    })();
    return () => ctl.abort();
  }, [client, attempt]);

  // Every 30 s: scan the blocks since the last scan and put new rows on top.
  useEffect(() => {
    if (!client || status !== 'ready') return;
    let busy = false;
    const id = window.setInterval(async () => {
      const cur = winRef.current;
      if (busy || !cur || document.visibilityState === 'hidden') return;
      busy = true;
      try {
        const head = await client.getBlockNumber();
        if (head > cur.to) {
          const fresh = await scanFeed(client, cur.to + 1n, head);
          setWin((w) => (w ? { ...w, events: mergeEvents(fresh, w.events), to: head > w.to ? head : w.to } : w));
        }
      } catch {
        /* next tick retries */
      } finally {
        busy = false;
      }
    }, REFRESH_MS);
    return () => window.clearInterval(id);
  }, [client, status]);

  const canScanOlder = !!win && win.from > START_BLOCK;

  const scanOlder = useCallback(async () => {
    const cur = winRef.current;
    if (!client || !cur || olderBusy) return;
    const w = olderWindow(cur.from);
    if (!w) return;
    setOlderBusy(true);
    setOlderError(false);
    try {
      const older = await scanFeed(client, w.from, w.to);
      setWin((x) => (x ? { ...x, events: mergeEvents(x.events, older), from: w.from < x.from ? w.from : x.from } : x));
    } catch {
      setOlderError(true);
    } finally {
      setOlderBusy(false);
    }
  }, [client, olderBusy]);

  return {
    win,
    status,
    progress,
    canScanOlder,
    scanOlder,
    olderBusy,
    olderError,
    retry: () => setAttempt((n) => n + 1),
  };
}

/** Block timestamps for the rows on screen (cached across renders by activity.ts). */
function useRowTimes(client: PublicClient | undefined, rows: FeedEvent[]) {
  const [times, setTimes] = useState<Map<bigint, number>>(new Map());
  const key = rows.map((r) => r.blockNumber.toString()).join(',');
  useEffect(() => {
    if (!client || rows.length === 0) return;
    let live = true;
    blockTimes(
      client,
      rows.map((r) => r.blockNumber),
    )
      .then((m) => {
        if (live) setTimes((prev) => new Map([...prev, ...m]));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, key]);
  return times;
}

/* ---------------------------------- rows ----------------------------------- */

function FeedRow({ e, at, nowSec }: { e: FeedEvent; at: number | undefined; nowSec: number }) {
  const { t } = useTranslation('pages-b');
  const agoT = useAgo();
  const tag = feedRowTag(e.kind);
  const when =
    at != null ? new Date(at * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : t('dispatch.row.block', { n: e.blockNumber.toString() });
  return (
    <li
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: '6px 10px',
        padding: '8px 2px',
        borderBottom: `1px dashed ${HOLO.screenLine}`,
        minWidth: 0,
      }}
    >
      <span style={{ flexShrink: 0, width: 92 }}>
        <HoloBadge label={tag.label} tone={tag.tone} variant="fill" />
      </span>
      <span style={{ flex: '1 1 240px', minWidth: 0, fontFamily: FONT_TEXT, fontSize: 12.5, lineHeight: 1.5, color: INK.body, overflowWrap: 'anywhere' }}>
        {feedRowText(e)}
      </span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10, flexShrink: 0, fontFamily: FONT_TEXT, fontSize: 11.5, color: INK.muted }}>
        <span title={when}>{at != null ? agoT(at, nowSec) : `#${e.blockNumber.toString()}`}</span>
        <TxLinkOut hash={e.txHash} label={t('common.tx')} />
      </span>
    </li>
  );
}

/* ---------------------------------- page ----------------------------------- */

const newestTimed = (list: (TimedEvent | null | undefined)[]): TimedEvent | null =>
  list.reduce<TimedEvent | null>((best, t) => {
    if (!t) return best;
    if (!best) return t;
    const a = t.event;
    const b = best.event;
    return a.blockNumber > b.blockNumber || (a.blockNumber === b.blockNumber && a.logIndex > b.logIndex) ? t : best;
  }, null);

const OUTCOMES = [tKey('dispatch.outcomes.bought'), tKey('dispatch.outcomes.deferred'), tKey('dispatch.outcomes.safeSettled')] as const;

export default function Dispatch() {
  const { t } = useTranslation('pages-b');
  const agoT = useAgo();
  // Feed rows name stock tokens through symbolOf(): re-render once the registry read names them.
  useAssetNames();
  usePageMeta(t('dispatch.meta.title'), t('dispatch.meta.description'));
  const client = useRhcClient();
  const feed = useDispatchFeed(client);
  const { totals, loading: totalsLoading, error: totalsError } = useProtocolTotals(true);
  const { pulse, loading: pulseLoading } = useKeeperPulse(true);

  const [limit, setLimit] = useState(PAGE);
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = window.setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 15_000);
    return () => window.clearInterval(id);
  }, []);

  const events = feed.win?.events ?? [];
  const rows = useMemo(() => events.slice(0, limit), [events, limit]);
  const times = useRowTimes(client, rows);

  const feedSummary = useMemo(() => summarizeFeed(events), [events]);
  const fromFeed: TimedEvent | null = feedSummary.lastKeeper
    ? { event: feedSummary.lastKeeper, at: times.get(feedSummary.lastKeeper.blockNumber) ?? null }
    : null;
  const lastKeeper = newestTimed([fromFeed, pulse?.lastAccrued, pulse?.lastAccountSwept, pulse?.lastAssetSwept]);
  const lastCollectOrSweep = newestTimed([pulse?.lastAccrued, pulse?.lastAccountSwept]);
  const linkedWallets = pulse?.linkedWallets ?? null;
  const keeper = keeperStatus({
    lastCollectOrSweepAt: lastCollectOrSweep?.at ?? null,
    nowSec,
    linkedWallets,
  });
  const keeperLabel = keeper.label;

  const moreLoaded = events.length > limit;
  const coveredAll = !!feed.win && !feed.canScanOlder;
  const loadOlder = async () => {
    if (moreLoaded) {
      setLimit((n) => n + PAGE);
      return;
    }
    await feed.scanOlder();
    setLimit((n) => n + PAGE);
  };

  const pending = (loading: boolean) => (loading ? '…' : '—');
  const collected = totals ? `${totals.accruedCount} · ${formatUsd(totals.accruedUsdg)}` : pending(totalsLoading && !totalsError);
  const converted = totals ? formatUsd(totals.convertedUsdg) : pending(totalsLoading && !totalsError);
  const fees = totals ? formatUsd(totals.feesUsdg) : pending(totalsLoading && !totalsError);
  const lastAction = lastKeeper
    ? lastKeeper.at != null
      ? agoT(lastKeeper.at, nowSec)
      : `#${lastKeeper.event.blockNumber.toString()}`
    : pulse
    ? t('common.noneYet')
    : pending(pulseLoading);

  const noActivityEver = totals ? totals.accruedCount === 0 && totals.convertedUsdg === 0n : false;

  return (
    <LivePageFrame exeTitle={t('dispatch.exeTitle')} banner={t('dispatch.banner')} bannerRight={t('dispatch.bannerRight')} maxWidth={960}>
      <HoloHero
        kicker={t('dispatch.hero.kicker')}
        title={t('dispatch.hero.title')}
        description={t('dispatch.hero.description')}
        art="/icons/spare/spare-activity.png"
        aside={<HoloBadge label={t('shell:common.liveData')} tone="good" variant="solid" pulse dot />}
        seed={17}
      />

      <Grid min={190} gap={12}>
        <HoloCard compact flat closeBox={false}>
          <HoloStat label={t('dispatch.stats.collected')} value={collected} size="md" sub={t('dispatch.stats.collectedSub')} />
        </HoloCard>
        <HoloCard compact flat closeBox={false}>
          <HoloStat label={t('dispatch.stats.converted')} value={converted} size="md" sub={t('dispatch.stats.convertedSub')} />
        </HoloCard>
        <HoloCard compact flat closeBox={false}>
          <HoloStat label={t('dispatch.stats.fees')} value={fees} size="md" sub={t('dispatch.stats.feesSub')} />
        </HoloCard>
        <HoloCard compact flat closeBox={false}>
          <HoloStat label={t('dispatch.stats.lastAction')} value={lastAction} size="md" sub={t('dispatch.stats.lastActionSub')} />
        </HoloCard>
      </Grid>

      <HoloCard
        title={t('dispatch.keeper.title')}
        accent={keeper.running ? t('dispatch.keeper.running') : t('dispatch.keeper.standingBy')}
        accentTone={keeper.running ? 'good' : 'info'}
      >
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px 10px', fontFamily: FONT_TEXT, fontSize: 12.5, color: INK.body }}>
          <span>{t('dispatch.keeper.title')}</span>
          <AddressLink address={KEEPER} />
          <span aria-hidden style={{ color: INK.muted }}>·</span>
          <span>
            {t('dispatch.keeper.gas', {
              value: pulse?.balanceWei != null ? `${Number(formatEther(pulse.balanceWei)).toFixed(4)} ETH` : pending(pulseLoading),
            })}
          </span>
          <span aria-hidden style={{ color: INK.muted }}>·</span>
          <span style={{ fontWeight: 700, color: keeper.running ? INK.good : INK.body }}>{pulse || !pulseLoading ? keeperLabel : '…'}</span>
        </div>
        <Prose muted style={{ fontSize: 11.5 }}>
          {t('dispatch.keeper.note')}
        </Prose>
      </HoloCard>

      <HoloCard title={t('dispatch.feed.title')} accent={t('dispatch.feed.refresh', { n: REFRESH_MS / 1000 })} accentTone="info">
        {feed.status === 'loading' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <HoloProgress
              value={feed.progress && feed.progress.total ? Math.round((feed.progress.done / feed.progress.total) * 100) : undefined}
              indeterminate={!feed.progress || !feed.progress.total}
              label={t('dispatch.feed.progress')}
              showValue={feed.progress ? `${feed.progress.done}/${feed.progress.total}` : undefined}
              ariaLabel={t('dispatch.feed.progressAria')}
            />
            <Prose muted style={{ fontSize: 11.5 }}>
              {t('dispatch.feed.scanning')}
            </Prose>
          </div>
        )}

        {feed.status === 'error' && (
          <HoloNotice
            tone="error"
            title={t('dispatch.feed.errorTitle')}
            action={
              <HoloButton size="sm" onClick={feed.retry}>
                {t('shell:common.retry')}
              </HoloButton>
            }
          >
            {t('dispatch.feed.errorBody')}
          </HoloNotice>
        )}

        {feed.status === 'ready' && rows.length === 0 && (
          <HoloNotice tone="info">{noActivityEver || coveredAll ? t('dispatch.feed.emptyAll') : t('dispatch.feed.emptyWeek')}</HoloNotice>
        )}

        {rows.length > 0 && (
          <HoloScreen padding="4px 12px">
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }} aria-label={t('dispatch.feed.listAria')}>
              {rows.map((e) => (
                <FeedRow key={e.id} e={e} at={times.get(e.blockNumber)} nowSec={nowSec} />
              ))}
            </ul>
          </HoloScreen>
        )}

        {feed.status === 'ready' && (
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
            {(moreLoaded || feed.canScanOlder) && (
              <HoloButton size="sm" onClick={loadOlder} disabled={feed.olderBusy}>
                {feed.olderBusy ? t('shell:common.loading') : t('dispatch.feed.loadOlder')}
              </HoloButton>
            )}
            <span style={{ fontFamily: FONT_TEXT, fontSize: 11, color: INK.muted }}>
              {coveredAll
                ? t('dispatch.feed.coveredAll', { block: DEPLOY_BLOCK.toLocaleString('en-US') })
                : feed.win
                ? t('dispatch.feed.showing', { from: feed.win.from.toLocaleString('en-US'), to: feed.win.to.toLocaleString('en-US') })
                : ''}
            </span>
            {feed.olderError && <span style={{ fontFamily: FONT_TEXT, fontSize: 11, color: INK.warn }}>{t('dispatch.feed.olderError')}</span>}
          </div>
        )}
      </HoloCard>

      <HoloCard title={t('dispatch.outcomes.title')} bar="lilac">
        <Bullets items={OUTCOMES.map((key) => <Trans key={key} t={t} i18nKey={key} components={{ b: <strong /> }} />)} />
      </HoloCard>

      <CtaRow>
        <LinkButton to="/" variant="primary">
          {t('common.startRoundingUp')}
        </LinkButton>
        <LinkButton to="/docs#sweep">{t('dispatch.cta.howSweeps')}</LinkButton>
      </CtaRow>
    </LivePageFrame>
  );
}
