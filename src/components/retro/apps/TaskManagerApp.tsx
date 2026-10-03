/**
 * Task Manager — the Ctrl+Alt+Del easter egg.
 *
 * Lists the Spare windows you have open (End Task closes the selected one)
 * and the services the desktop depends on, each with a real, live check:
 *   Robinhood Chain RPC   latest block number
 *   Chainlink feeds       the stock oracles, via StockRouter
 *   Spare API             GET /health
 *   Spare keeper (remote) its last round-up, as reported by /health
 * A check that can't be answered reads "unavailable".
 */
import { useEffect, useState } from 'react';
import { useBlockNumber } from 'wagmi';
import { API_BASE } from '@/lib/config';
import { SPARE_CHAIN_ID } from '@/lib/spare-chain/addresses';
import { fmtAgo, toUnixSeconds, useStockBoard } from '@/lib/stockBoard';
import { useTranslation } from '@/i18n';
import { useWindowManager } from '../WindowManager';
import {
  FONT_TEXT,
  HOLO,
  INK,
  HoloBadge,
  HoloButton,
  HoloCard,
  HoloTable,
  HoloWindowBody,
  type HoloColumn,
  type HoloTone,
} from '@/components/retro/holo';

type ProcRow = {
  [key: string]: unknown;
  id: string;
  name: string;
  status: string;
  tone: HoloTone;
  detail: string;
  closeable: boolean;
};

interface Health {
  ok: boolean;
  /** Unix seconds of the keeper's last round-up, or null when it has reported none. */
  keeperLastAccruedAt: number | null;
}

/**
 * A GET /health body → what the Task Manager shows; null when it is not the
 * Spare API. keeper.lastAccruedAt arrives as ISO-8601 text (unix seconds or
 * milliseconds are accepted too), the same reading the boot screen uses.
 */
function healthFromBody(body: unknown): Health | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as { ok?: unknown; service?: unknown; keeper?: { lastAccruedAt?: unknown } | null };
  if (b.ok === false || b.service !== 'spare-api') return null;
  return { ok: true, keeperLastAccruedAt: toUnixSeconds(b.keeper?.lastAccruedAt) };
}

/** GET {API}/health with a timeout. null = unreachable (the API may not be deployed yet). */
function useApiHealth(): { health: Health | null; checking: boolean } {
  const [health, setHealth] = useState<Health | null>(null);
  const [checking, setChecking] = useState(true);
  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 8_000);
      try {
        const r = await fetch(`${API_BASE}/health`, { signal: ctl.signal });
        const body = r.ok ? await r.json().catch(() => null) : null;
        if (cancelled) return;
        setHealth(healthFromBody(body));
      } catch {
        if (!cancelled) setHealth(null);
      } finally {
        clearTimeout(t);
        if (!cancelled) setChecking(false);
      }
    };
    void check();
    const id = setInterval(check, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);
  return { health, checking };
}

export function TaskManagerApp() {
  const { t } = useTranslation('apps-b');
  const wm = useWindowManager();
  const [selected, setSelected] = useState<string | null>(null);
  const block = useBlockNumber({ chainId: SPARE_CHAIN_ID, query: { refetchInterval: 15_000 } });
  const board = useStockBoard();
  const { health, checking } = useApiHealth();

  const openApps: ProcRow[] = wm.apps
    .map((app) => ({ app, state: wm.windows[app.id] }))
    .filter((w) => w.state?.isOpen && w.app.id !== 'taskmanager')
    .map(({ app, state }) => ({
      id: app.id,
      name: `${app.title} · spare`,
      status: state.isMinimized ? t('taskManager.status.minimized') : t('taskManager.status.running'),
      tone: state.isMinimized ? 'muted' : 'good',
      detail: t('taskManager.detail.window'),
      closeable: true,
    }));

  const feeds: Pick<ProcRow, 'status' | 'tone' | 'detail'> =
    board.market === 'open'
      ? { status: t('taskManager.status.live'), tone: 'good', detail: t('taskManager.detail.feedsOk', { count: board.rows.filter((r) => r.status === 0).length }) }
      : board.market === 'closed'
      ? { status: t('taskManager.status.marketClosed'), tone: 'warn', detail: t('taskManager.detail.lastCloses') }
      : board.market === 'mixed'
      ? { status: t('taskManager.status.partly'), tone: 'warn', detail: t('taskManager.detail.someWaiting') }
      : board.error
      ? { status: t('taskManager.status.unavailable'), tone: 'bad', detail: t('taskManager.detail.noAnswer') }
      : { status: t('taskManager.status.checking'), tone: 'warn', detail: '…' };

  const services: ProcRow[] = [
    {
      id: 'svc.rpc',
      name: 'Robinhood Chain RPC',
      ...(block.data != null
        ? { status: t('taskManager.status.running'), tone: 'good' as HoloTone, detail: t('taskManager.detail.block', { n: block.data.toLocaleString('en-US') }) }
        : block.error
        ? { status: t('taskManager.status.unavailable'), tone: 'bad' as HoloTone, detail: t('taskManager.detail.rpcDown') }
        : { status: t('taskManager.status.checking'), tone: 'warn' as HoloTone, detail: '…' }),
      closeable: false,
    },
    { id: 'svc.feeds', name: t('taskManager.svc.feeds'), ...feeds, closeable: false },
    {
      id: 'svc.api',
      name: 'Spare API',
      ...(health
        ? { status: t('taskManager.status.online'), tone: 'good' as HoloTone, detail: '/health OK' } // i18n-ignore: endpoint + status code
        : checking
        ? { status: t('taskManager.status.checking'), tone: 'warn' as HoloTone, detail: '…' }
        : { status: t('taskManager.status.unavailable'), tone: 'muted' as HoloTone, detail: t('taskManager.detail.apiDown') }),
      closeable: false,
    },
    {
      id: 'svc.keeper',
      name: t('taskManager.svc.keeper'),
      ...(health?.keeperLastAccruedAt
        ? { status: t('taskManager.status.reporting'), tone: 'good' as HoloTone, detail: t('taskManager.detail.lastRoundUp', { ago: fmtAgo(health.keeperLastAccruedAt) }) }
        : { status: '—', tone: 'muted' as HoloTone, detail: health ? t('taskManager.detail.noRoundUps') : t('taskManager.detail.viaApi') }),
      closeable: false,
    },
  ];

  const procs = [...openApps, ...services];
  const sel = procs.find((p) => p.id === selected);

  const endTask = () => {
    if (!sel?.closeable) return;
    wm.closeApp(sel.id);
    setSelected(null);
  };

  const columns: HoloColumn<ProcRow>[] = [
    { key: 'name', label: t('taskManager.cols.process'), width: 'minmax(140px, 1.6fr)', render: (p) => <span style={{ fontWeight: 700, color: HOLO.ink }}>{p.name}</span> },
    { key: 'status', label: t('taskManager.cols.status'), width: 'minmax(96px, 0.9fr)', render: (p) => <HoloBadge label={p.status} tone={p.tone} /> },
    { key: 'detail', label: t('taskManager.cols.detail'), width: 'minmax(120px, 1.2fr)', render: (p) => <span style={{ color: HOLO.inkMuted }}>{p.detail}</span> },
  ];

  return (
    <HoloWindowBody padding={12} gap={10}>
      <HoloCard
        title={t('taskManager.title')}
        accent={t('taskManager.accent', { open: openApps.length, services: services.length })}
        accentTone="info"
        compact
      >
        <span style={{ fontFamily: FONT_TEXT, fontSize: 11.5, color: INK.muted }}>{t('taskManager.intro')}</span>
      </HoloCard>

      <HoloTable<ProcRow>
        columns={columns}
        rows={procs}
        rowKey={(p) => p.id}
        selectedKey={selected ?? undefined}
        onSelectRow={(p) => setSelected(p.id)}
        dense
        minWidth={420}
        ariaLabel={t('taskManager.aria')}
      />

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontFamily: FONT_TEXT, fontSize: 10.5, color: INK.muted, flex: 1, minWidth: 160 }}>
          {t('taskManager.footer', { count: procs.length })}
        </span>
        <HoloButton size="sm" onClick={endTask} disabled={!sel?.closeable}>
          {t('taskManager.endTask')}
        </HoloButton>
      </div>
    </HoloWindowBody>
  );
}

export default TaskManagerApp;
