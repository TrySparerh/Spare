/**
 * Per-IP read budget shared by every public way into the Spare tools:
 *   GET  /api/spare/*                  (REST mirror)
 *   POST /mcp, POST /api/mcp           (MCP JSON-RPC, charged per batch element)
 * One bucket per client IP across all of them, so no path gets around another.
 *
 * Tools fan out to the shared, rate-limited Robinhood Chain RPC (or a paid
 * provider behind SPARE_RPC_URL / RHC_RPC_URL), so the scan-heavy ones cost
 * more tokens: spare_activity reads at most 24 eth_getLogs chunks a call
 * (then pages with nextBefore) and a wallet replay in spare_roundup_preview
 * at most 40, plus ~30 eth_calls.
 *
 * A client is its IP: IPv4 as is, an IPv4-mapped IPv6 address as its IPv4,
 * any other IPv6 address by its /64 (engine/src/middleware/rateLimit.ts
 * rateLimitKey).
 */
import { isIPv4, isIPv6 } from 'node:net';
import type { Request, Response } from 'express';
import { normalizeToolName } from '../mcp/normalize.js';
import { pick, REPLAY_WALLET_KEYS } from './args.js';

export const BUDGET_CAPACITY = 60;
export const BUDGET_WINDOW_MS = 60_000;

/** Tokens one call of a tool costs (default 1). Keyed by canonical name. */
export const TOOL_COST: Readonly<Record<string, number>> = {
  spare_activity: 6,
  spare_fees: 4,
  spare_account: 2,
  spare_quote: 2,
  spare_universe: 2,
  spare_contracts: 2,
};
/** spare_roundup_preview with a wallet (chain replay) instead of listed amounts. */
export const ROUNDUP_REPLAY_COST = 10;

/** Cost of one tool call, given the raw (possibly aliased) name and its args. */
export function toolCost(rawName: unknown, args: Record<string, unknown> | undefined): number {
  const name = normalizeToolName(rawName);
  if (name === 'spare_roundup_preview') {
    // Same pick() as the handler: `wallet=&address=0x…` replays, so it pays the replay price.
    return pick(args ?? {}, ...REPLAY_WALLET_KEYS) !== undefined ? ROUNDUP_REPLAY_COST : 1;
  }
  return TOOL_COST[name] ?? 1;
}

/** Cost of one JSON-RPC message: tools/call is charged by tool, anything else 1. */
export function rpcMessageCost(msg: unknown): number {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return 1;
  const m = msg as { method?: unknown; params?: unknown };
  if (m.method !== 'tools/call') return 1;
  const p = (m.params && typeof m.params === 'object' ? m.params : {}) as { name?: unknown; arguments?: unknown };
  const args = p.arguments && typeof p.arguments === 'object' && !Array.isArray(p.arguments) ? (p.arguments as Record<string, unknown>) : {};
  return toolCost(p.name, args);
}

export interface TokenBucket {
  /** Take `cost` tokens for `key`. Returns 0 when allowed, else seconds to wait. */
  take(key: string, cost: number, now?: number): number;
  reset(): void;
}

export function createTokenBucket(capacity = BUDGET_CAPACITY, windowMs = BUDGET_WINDOW_MS): TokenBucket {
  const buckets = new Map<string, { tokens: number; last: number }>();
  const refillPerMs = capacity / windowMs;
  const sweep = setInterval(() => {
    const cutoff = Date.now() - 5 * windowMs;
    for (const [k, b] of buckets) if (b.last < cutoff) buckets.delete(k);
  }, windowMs);
  sweep.unref?.();
  return {
    take(key, cost, now = Date.now()) {
      const c = Math.max(1, Math.ceil(cost));
      const b = buckets.get(key) ?? { tokens: capacity, last: now };
      b.tokens = Math.min(capacity, b.tokens + (now - b.last) * refillPerMs);
      b.last = now;
      buckets.set(key, b);
      if (c > capacity) return Math.ceil(windowMs / 1000); // can never fit
      if (b.tokens < c) return Math.max(1, Math.ceil((c - b.tokens) / refillPerMs / 1000));
      b.tokens -= c;
      return 0;
    },
    reset() {
      buckets.clear();
    },
  };
}

/** The one budget every Spare read path draws from. */
export const spareReadBudget = createTokenBucket();

/** First 64 bits of an IPv6 address as hex groups, e.g. "2001:db8:0:1". */
function ipv6Prefix64(ip: string): string {
  const [head = '', tail] = ip.split('::');
  const groups = (part: string) => (part ? part.split(':') : []);
  // An embedded dotted IPv4 (the last 32 bits) fills two groups.
  const width = (gs: string[]) => gs.reduce((n, g) => n + (g.includes('.') ? 2 : 1), 0);
  const h = groups(head);
  const t = tail === undefined ? [] : groups(tail);
  const all = tail === undefined ? h : [...h, ...new Array<string>(8 - width(h) - width(t)).fill('0'), ...t];
  return all
    .slice(0, 4)
    .map((g) => parseInt(g, 16).toString(16))
    .join(':');
}

/**
 * The bucket a client address shares. IPv4 is one address; an IPv4-mapped
 * IPv6 address is its IPv4; any other IPv6 address is its /64, the smallest
 * block a single subscriber is routinely given. Keying on the full address
 * would let one host rotate through 2^64 buckets.
 */
export function rateLimitKey(address: string): string {
  const ip = address.replace(/^\[(.*)\]$/, '$1').split('%')[0]!;
  if (isIPv4(ip)) return ip;
  if (!isIPv6(ip)) return address;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped && isIPv4(mapped[1]!)) return mapped[1]!;
  return `${ipv6Prefix64(ip.toLowerCase())}::/64`;
}

export function clientKey(req: Request): string {
  return rateLimitKey(req.ip || req.socket?.remoteAddress || 'unknown');
}

/**
 * Charge `cost` to the caller. On success returns true; otherwise it has
 * already answered 429 (JSON, or a JSON-RPC error when `rpc`) and returns false.
 */
export function charge(req: Request, res: Response, cost: number, rpc: { id: unknown } | null = null): boolean {
  const units = Math.max(1, Math.ceil(cost));
  const wait = spareReadBudget.take(clientKey(req), units);
  if (wait === 0) return true;
  res.set('Retry-After', String(wait));
  const message =
    units > BUDGET_CAPACITY
      ? `This request costs ${units} read units, more than the ${BUDGET_CAPACITY}-unit per-minute budget. Send fewer calls per batch.`
      : `Rate limited: ${BUDGET_CAPACITY} read units per minute per client (this request costs ${units}). Retry in ${wait}s.`;
  if (rpc) {
    res.status(429).json({ jsonrpc: '2.0', id: rpc.id ?? null, error: { code: -32005, message, data: { retryAfterSeconds: wait } } });
  } else {
    res.status(429).json({ error: 'rate_limited', message, retryAfterSeconds: wait });
  }
  return false;
}
