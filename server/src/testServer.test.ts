import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { FETCH_BAD_PORTS, listenLocal } from './testServer.js';

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => (s.listening ? s.close(() => r()) : r()))));
});

function server(): http.Server {
  const s = http.createServer((_req, res) => res.end('ok'));
  servers.push(s);
  return s;
}

/** A bad port above 1024 that is free to bind here (an OS can hand these out as ephemeral ports). */
async function freeBadPort(): Promise<number> {
  for (const port of [...FETCH_BAD_PORTS].filter((p) => p > 1024).reverse()) {
    const probe = http.createServer();
    const ok = await new Promise<boolean>((r) => {
      probe.once('error', () => r(false));
      probe.listen(port, '127.0.0.1', () => r(true));
    });
    if (ok) {
      await new Promise<void>((r) => probe.close(() => r()));
      return port;
    }
  }
  throw new Error('every bad port above 1024 is taken');
}

describe('listenLocal', () => {
  it('lists exactly ports that fetch refuses as "bad port"', async () => {
    const causes = await Promise.all(
      [...FETCH_BAD_PORTS].map((p) =>
        fetch(`http://127.0.0.1:${p}/`).then(
          () => 'connected',
          (e: unknown) => String((e as { cause?: { message?: unknown } }).cause?.message ?? e),
        ),
      ),
    );
    expect(new Set(causes)).toEqual(new Set(['bad port']));
  });

  it('a bad port drawn first is released and another drawn, so fetch connects', async () => {
    const bad = await freeBadPort();
    const tried: number[] = [];
    const base = await listenLocal(server(), (attempt) => {
      const port = attempt === 0 ? bad : 0;
      tried.push(port);
      return port;
    });
    expect(tried).toEqual([bad, 0]);
    expect(FETCH_BAD_PORTS.has(Number(new URL(base).port))).toBe(false);
    expect(await (await fetch(base)).text()).toBe('ok');
  });
});
