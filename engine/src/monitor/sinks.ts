/**
 * Where alerts go. Every alert is ALWAYS written as one structured JSON log
 * line (the hosting platform keeps stdout). Telegram and a Discord / Slack webhook are
 * added when configured. A burst (e.g. 30 assets registered in one script)
 * is packed into a few messages, each sink is held to SINK_MAX_PER_MINUTE,
 * and a sink that is down never blocks the poll loop or the other sinks.
 */
import { formatAlert, packMessages, redact, SEVERITY_RANK, type Alert, type Severity } from "./alerts.ts";

export interface Sink {
  name: string;
  maxChars: number;
  /** Least severe alert this sink receives (default: everything). */
  minSeverity?: Severity;
  send(text: string): Promise<void>;
}

type Fetch = (input: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

const TIMEOUT_MS = 10_000;

interface SinkOpts {
  minSeverity?: Severity;
  fetch?: Fetch;
}

export function telegramSink(token: string, chatId: string, opts: SinkOpts = {}): Sink {
  const fetchImpl = opts.fetch ?? (fetch as unknown as Fetch);
  return {
    name: "telegram",
    maxChars: 4_000,
    minSeverity: opts.minSeverity,
    async send(text) {
      const res = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // Plain text: no parse_mode, so addresses and underscores never need escaping.
        body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`telegram HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    },
  };
}

/** Discord reads `content`, Slack reads `text`; each ignores the other. */
export function webhookSink(url: string, opts: SinkOpts = {}): Sink {
  const fetchImpl = opts.fetch ?? (fetch as unknown as Fetch);
  return {
    name: "webhook",
    maxChars: 1_900,
    minSeverity: opts.minSeverity,
    async send(text) {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: text, text }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`webhook HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    },
  };
}

interface Queued {
  text: string;
  attempts: number;
}

const MAX_QUEUE = 100;
const MAX_ATTEMPTS = 3;

export class Dispatcher {
  private readonly queues = new Map<string, Queued[]>();
  private readonly sent = new Map<string, number[]>();
  private readonly dropped = new Map<string, number>();
  /** Messages given up on, per sink, since start. */
  readonly lost = new Map<string, number>();

  constructor(
    private readonly opts: {
      sinks: readonly Sink[];
      maxPerMinute: number;
      /** Values that must never leave the process (RPC URL, bot token, webhook URL). */
      secrets: readonly string[];
      /** Explorer base: the one URL prefix allowed through redaction. */
      explorer: string | null;
      header: string;
      now?: () => number;
      write?: (line: string) => void;
    },
  ) {
    for (const s of opts.sinks) {
      this.queues.set(s.name, []);
      this.sent.set(s.name, []);
      this.dropped.set(s.name, 0);
      this.lost.set(s.name, 0);
    }
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  private clean(text: string): string {
    return redact(text, this.opts.secrets, this.opts.explorer);
  }

  /** One structured JSON log line (stdout); every string in it is redacted. */
  log(level: "info" | "warn" | "error", msg: string, fields: Record<string, unknown> = {}): void {
    const line = JSON.stringify({ ts: new Date(this.now()).toISOString(), level, msg: this.clean(msg), ...fields }, (_k, v) =>
      typeof v === "bigint" ? v.toString() : typeof v === "string" ? this.clean(v) : v,
    );
    (this.opts.write ?? console.log)(line);
  }

  /** Log every alert; queue the pushable ones, most severe first, and flush. */
  async dispatch(alerts: readonly Alert[]): Promise<void> {
    for (const a of alerts) {
      const level = a.state === "resolved" || a.severity === "info" ? "info" : a.severity === "critical" ? "error" : "warn";
      this.log(level, a.title, {
        alert: { key: a.key, name: a.name, severity: a.severity, state: a.state ?? null, lines: a.lines, pushed: a.push && this.opts.sinks.length > 0 },
      });
    }
    const push = alerts.filter((a) => a.push).sort((x, y) => SEVERITY_RANK[x.severity] - SEVERITY_RANK[y.severity]);
    if (push.length && this.opts.sinks.length) {
      for (const s of this.opts.sinks) {
        const min = SEVERITY_RANK[s.minSeverity ?? "info"];
        const texts = push.filter((a) => SEVERITY_RANK[a.severity] <= min).map((a) => this.clean(formatAlert(a)));
        const q = this.queues.get(s.name)!;
        for (const text of packMessages(texts, s.maxChars, this.opts.header)) {
          if (q.length >= MAX_QUEUE) {
            q.shift();
            this.dropped.set(s.name, this.dropped.get(s.name)! + 1);
            this.lost.set(s.name, this.lost.get(s.name)! + 1);
          }
          q.push({ text, attempts: 0 });
        }
      }
    }
    await this.flush();
  }

  /** Send what each sink's rate allows; failures stay queued (bounded retries). */
  async flush(): Promise<void> {
    await Promise.all(
      this.opts.sinks.map(async (s) => {
        const q = this.queues.get(s.name)!;
        const times = this.sent.get(s.name)!;
        while (q.length) {
          const now = this.now();
          while (times.length && now - times[0]! >= 60_000) times.shift();
          if (times.length >= this.opts.maxPerMinute) return;
          const head = q[0]!;
          const lost = this.dropped.get(s.name)!;
          const text = lost ? `${head.text}\n\n(${lost} earlier message(s) dropped: queue full; see the monitor logs)` : head.text;
          try {
            await s.send(text.length > s.maxChars ? `${text.slice(0, s.maxChars - 3)}...` : text);
            times.push(now);
            q.shift();
            this.dropped.set(s.name, 0);
          } catch (err) {
            head.attempts++;
            this.log("error", `sink ${s.name} send failed (attempt ${head.attempts}/${MAX_ATTEMPTS})`, {
              error: this.clean((err as Error)?.message ?? String(err)).split("\n")[0],
            });
            if (head.attempts >= MAX_ATTEMPTS) {
              q.shift();
              this.dropped.set(s.name, lost + 1);
              this.lost.set(s.name, this.lost.get(s.name)! + 1);
            }
            return; // a failing sink waits for the next flush
          }
        }
      }),
    );
  }

  pending(): Record<string, number> {
    return Object.fromEntries([...this.queues].map(([k, q]) => [k, q.length]));
  }
}
