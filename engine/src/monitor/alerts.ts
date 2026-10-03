/**
 * Alert model: one Alert per privileged event (keyed by tx hash + log index,
 * so overlapping scans never repeat it) and a small state machine for
 * conditions (balance low, RPC down, keeper idle, ...): an alert when a
 * condition turns bad, a reminder every REPEAT_MINUTES while it stays bad,
 * and one "resolved" when it clears.
 */
export type Severity = "critical" | "warning" | "info";

export const SEVERITY_RANK: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

export interface Alert {
  /** Dedupe key: `ev:<tx>:<logIndex>` for events, `cond:<name>` for conditions. */
  key: string;
  /** Event name or condition name, e.g. "ExecutorSet", "balance.keeper". */
  name: string;
  severity: Severity;
  /** One line, no secrets. */
  title: string;
  lines: string[];
  /** Conditions only. */
  state?: "firing" | "repeat" | "resolved";
  /** false: history from a start without saved state, logged but not pushed. */
  push: boolean;
}

/**
 * Strip anything that could carry a credential: every URL except the block
 * explorer's (RPC URLs embed API keys; bot and webhook URLs ARE the key), and
 * every configured secret verbatim.
 */
export function redact(text: string, secrets: readonly string[], keepUrlPrefix: string | null = null): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 6) out = out.split(s).join("<redacted>");
  return out.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)\]]+/gi, (m) => (keepUrlPrefix && m.startsWith(`${keepUrlPrefix}/`) ? m : "<url>"));
}

/**
 * First line of an error plus viem's one-line `details` (the provider's
 * reason), never the request body. Callers still pass it through redact():
 * a provider can echo the URL in its details.
 */
export function errorSummary(err: unknown): string {
  const e = err as { shortMessage?: unknown; message?: unknown; details?: unknown } | null;
  const raw = typeof e?.shortMessage === "string" ? e.shortMessage : typeof e?.message === "string" ? e.message : String(err);
  const head = raw.split("\n")[0] ?? "error";
  const details = typeof e?.details === "string" ? (e.details.split("\n")[0] ?? "").slice(0, 120) : "";
  return (details && !head.includes(details) ? `${head} (${details})` : head).slice(0, 240);
}

export function formatAlert(a: Alert): string {
  const tag = a.state === "resolved" ? "RESOLVED" : a.severity.toUpperCase();
  const again = a.state === "repeat" ? " (still)" : "";
  return [`[${tag}]${again} ${a.title}`, ...a.lines.map((l) => `  ${l}`)].join("\n");
}

/** Pack formatted alerts into as few messages as fit under `maxChars` (an oversized one is cut). */
export function packMessages(texts: readonly string[], maxChars: number, header: string): string[] {
  const out: string[] = [];
  let cur = header;
  for (const t0 of texts) {
    const room = maxChars - header.length - 2;
    const t = t0.length > room ? `${t0.slice(0, room - 3)}...` : t0;
    if (cur.length + 2 + t.length > maxChars && cur !== header) {
      out.push(cur);
      cur = header;
    }
    cur = `${cur}\n\n${t}`;
  }
  if (cur !== header) out.push(cur);
  return out;
}

export interface ConditionRecord {
  since: number;
  lastSent: number;
}

type Describe = (state: "firing" | "repeat" | "resolved", since: number) => { severity: Severity; title: string; lines?: string[] };

/** Fire once, remind every `repeatMs`, resolve once. */
export class Conditions {
  readonly active = new Map<string, ConditionRecord>();

  constructor(private readonly repeatMs: number) {}

  observe(name: string, bad: boolean, now: number, describe: Describe): Alert | null {
    const key = `cond:${name}`;
    const cur = this.active.get(key);
    if (bad) {
      if (!cur) {
        this.active.set(key, { since: now, lastSent: now });
        return this.make(key, name, "firing", now, describe);
      }
      if (now - cur.lastSent < this.repeatMs) return null;
      cur.lastSent = now;
      return this.make(key, name, "repeat", cur.since, describe);
    }
    if (!cur) return null;
    this.active.delete(key);
    return this.make(key, name, "resolved", cur.since, describe);
  }

  isActive(name: string): boolean {
    return this.active.has(`cond:${name}`);
  }

  private make(key: string, name: string, state: "firing" | "repeat" | "resolved", since: number, describe: Describe): Alert {
    const d = describe(state, since);
    return {
      key,
      name,
      // A resolution keeps the condition's severity, so it reaches every sink the alert did.
      severity: d.severity,
      title: d.title,
      lines: d.lines ?? [],
      state,
      push: true,
    };
  }
}

/** Event keys already alerted, bounded by count and age. */
export class SeenSet {
  readonly keys = new Map<string, number>();

  constructor(
    private readonly maxKeys = 20_000,
    private readonly maxAgeMs = 14 * 86_400_000,
  ) {}

  /** True the first time `key` is offered. */
  add(key: string, now: number): boolean {
    if (this.keys.has(key)) return false;
    this.keys.set(key, now);
    return true;
  }

  prune(now: number): void {
    for (const [k, at] of this.keys) {
      if (now - at <= this.maxAgeMs && this.keys.size <= this.maxKeys) break;
      this.keys.delete(k);
    }
  }
}

export function minutes(ms: number): string {
  const m = Math.round(ms / 60_000);
  return m < 120 ? `${m}m` : `${(m / 60).toFixed(1)}h`;
}
