/**
 * Test helper only: bind a server to an ephemeral 127.0.0.1 port that
 * `fetch` will connect to. Node's fetch refuses the Fetch standard's "bad
 * ports" (6000, 6665-6669, 10080, …) before connecting, and an OS whose
 * dynamic port range starts low (Windows can start it at 1024) hands those
 * out, so a test that drew one failed with "bad port". Such a port is
 * released and another drawn.
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** https://fetch.spec.whatwg.org/#port-blocking — what Node 24's fetch refuses. */
export const FETCH_BAD_PORTS: ReadonlySet<number> = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115,
  117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587,
  601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
  6679, 6697, 10080,
]);

const MAX_TRIES = 20;

function listenOnce(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

/**
 * Listen on a fetch-safe port and return the base URL. `nextPort` names the
 * port to try (0: any free port); tests of this helper pass a bad one first.
 */
export async function listenLocal(server: Server, nextPort: (attempt: number) => number = () => 0): Promise<string> {
  for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
    const port = await listenOnce(server, nextPort(attempt));
    if (!FETCH_BAD_PORTS.has(port)) return `http://127.0.0.1:${port}`;
    await new Promise<void>((r) => server.close(() => r()));
  }
  throw new Error(`no fetch-safe port in ${MAX_TRIES} tries`);
}
