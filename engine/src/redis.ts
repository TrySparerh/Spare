import { Redis } from "ioredis";
import { env } from "./env.ts";

let client: Redis | undefined;

/**
 * Lazy, self-healing Redis connection shared by health checks and the API.
 * BullMQ queues/workers create their own connections from the same URL.
 * Never throws at construction; retries forever in the background.
 */
export function getRedis(): Redis {
  if (!client) {
    client = new Redis(env.REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      retryStrategy: (times) => Math.min(times * 500, 10_000),
      enableOfflineQueue: false,
    });
    client.on("error", () => {
      /* surfaced by health checks; never crash the process */
    });
  }
  return client;
}

export async function redisHealthy(): Promise<boolean> {
  try {
    const r = getRedis();
    if (r.status === "wait" || r.status === "end") await r.connect().catch(() => {});
    const pong = await Promise.race([
      r.ping(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 2000)),
    ]);
    return pong === "PONG";
  } catch {
    return false;
  }
}

/** Connection options for BullMQ (it manages its own ioredis instances). */
export function bullConnection(url = env.REDIS_URL) {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    username: u.username || undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
    tls: u.protocol === "rediss:" ? {} : undefined,
    // BullMQ requirement for blocking commands:
    maxRetriesPerRequest: null as null,
    retryStrategy: (times: number) => Math.min(times * 1000, 15_000),
  };
}
