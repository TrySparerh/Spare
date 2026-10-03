// A per-client token bucket, with the client address taken from the TRUSTED end
// of X-Forwarded-For.
import { isIPv4, isIPv6 } from "node:net";
import type { Context, MiddlewareHandler } from "hono";
import { env } from "../env.ts";

/**
 * Dependency-free per-client token-bucket rate limiter.
 *
 * Each client gets a bucket of `burst` tokens that refills linearly over
 * `windowMs`. A request costs `cost(c)` tokens (default one); when the bucket
 * is short the request is rejected with 429 + Retry-After. State is in-memory
 * (per process) and self-pruning, so it is safe for a single API instance;
 * front a fleet with a shared limiter (e.g. at the load balancer) for
 * multi-instance deployments.
 *
 * Only mounted on HTTP routes (/trpc, /health) — the WebSocket upgrade is
 * handled in Bun.serve before Hono runs, so realtime clients are unaffected.
 */

interface Bucket {
  tokens: number;
  last: number;
}

export interface RateLimitOptions {
  /** Max burst — bucket capacity. */
  burst?: number;
  /** Time in ms to fully refill an empty bucket. */
  windowMs?: number;
  /** Proxies in front of us that append to X-Forwarded-For (default TRUSTED_PROXY_HOPS). */
  trustedProxyHops?: number;
  /** Tokens a request costs (default 1). */
  cost?: (c: Context) => number;
}

/**
 * The client address as our outermost trusted proxy saw it.
 *
 * Every proxy APPENDS the address it received the request from, so only the
 * right-most `trustedHops` entries of X-Forwarded-For were written by
 * infrastructure we run behind; everything left of them is whatever the
 * client sent, and keying on it let a client mint a fresh bucket per request.
 * With one hop (the proxy in front of the service) the client is the LAST entry. A header with
 * fewer entries than hops did not come through the proxies, so the socket
 * address is used — as it is with trustedHops = 0. X-Real-IP is
 * client-settable and is never read.
 */
export function clientAddress(forwardedFor: string | undefined, socketAddress: string | undefined, trustedHops: number): string {
  if (trustedHops > 0 && forwardedFor) {
    const hops = forwardedFor.split(",").map((s) => s.trim());
    const entry = hops.length >= trustedHops ? hops[hops.length - trustedHops] : undefined;
    if (entry) return entry;
  }
  return socketAddress || "unknown";
}

/** First 64 bits of an IPv6 address as hex groups, e.g. "2001:db8:0:1". */
function ipv6Prefix64(ip: string): string {
  const [head = "", tail] = ip.split("::");
  const groups = (part: string) => (part ? part.split(":") : []);
  // An embedded dotted IPv4 (the last 32 bits) fills two groups.
  const width = (gs: string[]) => gs.reduce((n, g) => n + (g.includes(".") ? 2 : 1), 0);
  const h = groups(head);
  const t = tail === undefined ? [] : groups(tail);
  const all = tail === undefined ? h : [...h, ...new Array<string>(8 - width(h) - width(t)).fill("0"), ...t];
  return all
    .slice(0, 4)
    .map((g) => parseInt(g, 16).toString(16))
    .join(":");
}

/**
 * The bucket a client address shares. IPv4 is one address; an IPv4-mapped
 * IPv6 address is its IPv4; any other IPv6 address is its /64, the smallest
 * block a single subscriber is routinely given — keying on the full address
 * would let one host rotate through 2^64 buckets.
 */
export function rateLimitKey(address: string): string {
  const ip = address.replace(/^\[(.*)\]$/, "$1").split("%")[0]!;
  if (isIPv4(ip)) return ip;
  if (!isIPv6(ip)) return address;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped && isIPv4(mapped[1]!)) return mapped[1]!;
  return `${ipv6Prefix64(ip.toLowerCase())}::/64`;
}

/** The TCP peer, from Bun's server (Hono's env is the server, or { server }). */
function socketAddress(c: Context): string | undefined {
  type BunServer = { requestIP?: (r: Request) => { address?: string } | null };
  const e = c.env as (BunServer & { server?: BunServer }) | undefined;
  const server = e?.server ?? e;
  return server?.requestIP?.(c.req.raw)?.address;
}

/**
 * The rate-limit key of the request in `c`: the client address our outermost
 * trusted proxy saw, grouped as rateLimitKey does. rule.preview's per-client
 * in-flight limit (routers/rule.ts) keys on the same value as the limiter.
 */
export function requestClientKey(c: Context, trustedHops: number = env.TRUSTED_PROXY_HOPS): string {
  return rateLimitKey(clientAddress(c.req.header("x-forwarded-for"), socketAddress(c), trustedHops));
}

export function rateLimit(options: RateLimitOptions = {}): MiddlewareHandler {
  const burst = options.burst ?? env.RATE_LIMIT_BURST;
  const windowMs = options.windowMs ?? env.RATE_LIMIT_WINDOW_MS;
  const trustedHops = options.trustedProxyHops ?? env.TRUSTED_PROXY_HOPS;
  const cost = options.cost ?? (() => 1);
  const refillPerMs = burst / windowMs;

  const buckets = new Map<string, Bucket>();
  let lastSweep = Date.now();

  // Drop idle buckets occasionally so the map can't grow without bound.
  function sweep(now: number) {
    if (now - lastSweep < windowMs) return;
    lastSweep = now;
    for (const [ip, b] of buckets) {
      if (now - b.last > windowMs * 2) buckets.delete(ip);
    }
  }

  return async (c, next) => {
    const now = Date.now();
    sweep(now);

    const key = requestClientKey(c, trustedHops);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { tokens: burst, last: now };
      buckets.set(key, bucket);
    } else {
      const elapsed = now - bucket.last;
      bucket.tokens = Math.min(burst, bucket.tokens + elapsed * refillPerMs);
      bucket.last = now;
    }

    const price = Math.max(1, cost(c));
    if (bucket.tokens < price) {
      const retryMs = Math.ceil((Math.min(price, burst) - bucket.tokens) / refillPerMs);
      const retrySec = Math.max(1, Math.ceil(retryMs / 1000));
      c.header("Retry-After", String(retrySec));
      return c.json(
        { error: "rate limit exceeded", retryAfterSeconds: retrySec },
        429,
      );
    }

    bucket.tokens -= price;
    return next();
  };
}
