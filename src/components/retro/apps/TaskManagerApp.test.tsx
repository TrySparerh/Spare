import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The chain reads and the window manager are stubbed: this file is about the
// Spare API rows, which read GET /health.
vi.mock('wagmi', () => ({ useBlockNumber: () => ({ data: 78_054_952n, error: null }) }));
vi.mock('@/lib/stockBoard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/stockBoard')>()),
  useStockBoard: () => ({ market: 'open', rows: [], error: null }),
}));
vi.mock('../WindowManager', () => ({ useWindowManager: () => ({ apps: [], windows: {}, closeApp: () => undefined }) }));

import { TaskManagerApp } from './TaskManagerApp';

function serveHealth(body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })),
  );
}

const keeperRow = () => screen.getByText('Spare keeper (remote)').closest('[role="row"]') as HTMLElement;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-02T07:20:25.000Z'));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Task Manager · Spare keeper (remote)', () => {
  it('reads the ISO-8601 lastAccruedAt the API actually sends', async () => {
    serveHealth({ ok: true, service: 'spare-api', keeper: { lastAccruedAt: '2026-10-01T20:20:25.000Z', lastSweptAt: null } });
    render(<TaskManagerApp />);
    await waitFor(() => expect(within(keeperRow()).getByText('last round-up 11h ago')).toBeInTheDocument());
    expect(within(keeperRow()).getByText('Reporting')).toBeInTheDocument();
    expect(screen.queryByText('no round-ups reported yet')).toBeNull();
  });

  it('still reads a numeric timestamp (unix seconds or milliseconds)', async () => {
    serveHealth({ ok: true, service: 'spare-api', keeper: { lastAccruedAt: Date.parse('2026-10-02T05:20:25.000Z') } });
    render(<TaskManagerApp />);
    await waitFor(() => expect(within(keeperRow()).getByText('last round-up 2h ago')).toBeInTheDocument());
  });

  it('says so when the keeper has reported no round-up', async () => {
    serveHealth({ ok: true, service: 'spare-api', keeper: { lastAccruedAt: null, lastSweptAt: null } });
    render(<TaskManagerApp />);
    await waitFor(() => expect(within(keeperRow()).getByText('no round-ups reported yet')).toBeInTheDocument());
  });

  it('does not trust a host that is not the Spare API', async () => {
    serveHealth({ ok: true, service: 'something-else', keeper: { lastAccruedAt: '2026-10-01T20:20:25.000Z' } });
    render(<TaskManagerApp />);
    await waitFor(() => expect(within(keeperRow()).getByText('status via Spare API')).toBeInTheDocument());
    expect(screen.queryByText(/last round-up/)).toBeNull();
  });
});
