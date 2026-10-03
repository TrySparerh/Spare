import { describe, expect, test } from "bun:test";
import { Conditions, errorSummary, formatAlert, packMessages, redact, SeenSet, type Alert } from "../src/monitor/alerts.ts";
import { loadMonitorConfig, parseMonitorBook, withRoleOverrides } from "../src/monitor/config.ts";
import { Dispatcher, telegramSink, webhookSink, type Sink } from "../src/monitor/sinks.ts";

const RPC = "https://robinhood-mainnet.g.alchemy.com/v2/SECRETKEY1234567890";
const BOT = "123456789:AAH-supersecret-bot-token";
const HOOK = "https://discord.com/api/webhooks/1/hook-secret-part";
const EXPLORER = "https://robinhoodchain.blockscout.com";

const alert = (over: Partial<Alert> = {}): Alert => ({
  key: "ev:0xabc:1",
  name: "ExecutorSet",
  severity: "critical",
  title: "CashPark: executor set to 0xdead",
  lines: [`${EXPLORER}/tx/0xabc`],
  push: true,
  ...over,
});

function recordingSink(name: string, opts: { maxChars?: number; fail?: () => boolean } = {}): Sink & { got: string[] } {
  const got: string[] = [];
  return {
    name,
    maxChars: opts.maxChars ?? 4_000,
    got,
    async send(text) {
      if (opts.fail?.()) throw new Error(`boom via ${RPC}`);
      got.push(text);
    },
  };
}

function dispatcher(sinks: Sink[], clock: { t: number }, lines: string[] = [], maxPerMinute = 20) {
  return new Dispatcher({ sinks, maxPerMinute, secrets: [RPC, BOT, HOOK], explorer: EXPLORER, header: "Spare monitor (chain 4663)", now: () => clock.t, write: (l) => lines.push(l) });
}

describe("monitor alerts: conditions", () => {
  test("fires once, stays quiet, repeats after the interval, resolves once", () => {
    const c = new Conditions(60_000);
    const d = () => ({ severity: "critical" as const, title: "keeper ETH low" });
    const first = c.observe("balance.keeper", true, 0, d);
    expect(first?.state).toBe("firing");
    expect(first?.key).toBe("cond:balance.keeper");
    expect(c.observe("balance.keeper", true, 30_000, d)).toBeNull();
    expect(c.observe("balance.keeper", true, 59_999, d)).toBeNull();
    expect(c.observe("balance.keeper", true, 60_000, d)?.state).toBe("repeat");
    expect(c.observe("balance.keeper", true, 90_000, d)).toBeNull();
    const resolved = c.observe("balance.keeper", false, 100_000, d);
    expect(resolved?.state).toBe("resolved");
    expect(resolved?.severity).toBe("critical"); // routed like the alert it resolves
    expect(c.observe("balance.keeper", false, 200_000, d)).toBeNull();
    // A new dip is a new incident.
    expect(c.observe("balance.keeper", true, 300_000, d)?.state).toBe("firing");
  });

  test("a good observation of a condition never seen is silent", () => {
    const c = new Conditions(60_000);
    expect(c.observe("rpc.down", false, 0, () => ({ severity: "critical", title: "x" }))).toBeNull();
  });
});

describe("monitor alerts: dedupe set", () => {
  test("a key is accepted once; pruning drops the oldest by age and by count", () => {
    const s = new SeenSet(3, 1_000);
    expect(s.add("a", 0)).toBe(true);
    expect(s.add("a", 10)).toBe(false);
    s.add("b", 500);
    s.add("c", 900);
    s.add("d", 950);
    s.prune(1_200); // "a" is too old (and the set is over 3)
    expect([...s.keys.keys()]).toEqual(["b", "c", "d"]);
    s.prune(1_600); // "b" is now older than 1s
    expect([...s.keys.keys()]).toEqual(["c", "d"]);
  });
});

describe("monitor alerts: redaction", () => {
  test("RPC keys, bot tokens and webhook URLs never survive; explorer links do", () => {
    const text = `HTTP request failed. URL: ${RPC} token ${BOT} hook ${HOOK} see ${EXPLORER}/tx/0x12 and https://evil.example/x`;
    const out = redact(text, [RPC, BOT, HOOK], EXPLORER);
    expect(out).not.toContain("SECRETKEY");
    expect(out).not.toContain("supersecret");
    expect(out).not.toContain("hook-secret");
    expect(out).not.toContain("evil.example");
    expect(out).toContain(`${EXPLORER}/tx/0x12`);
  });

  test("errorSummary keeps the first line only (viem puts the URL and body below it)", () => {
    const err = Object.assign(new Error(`HTTP request failed.\n\nURL: ${RPC}\nRequest body: {}`), { shortMessage: "HTTP request failed." });
    expect(errorSummary(err)).toBe("HTTP request failed.");
    expect(errorSummary(new Error(`line one\nURL: ${RPC}`))).toBe("line one");
    const capped = Object.assign(new Error("RPC Request failed."), { shortMessage: "RPC Request failed.", details: `query spans 2 blocks via ${RPC}` });
    expect(redact(errorSummary(capped), [RPC])).toBe("RPC Request failed. (query spans 2 blocks via <redacted>)");
  });
});

describe("monitor alerts: packing", () => {
  test("a burst packs into few messages under the limit, oversized ones are cut", () => {
    const texts = Array.from({ length: 30 }, (_, i) => `[WARNING] AssetRegistry: TKN${i} ACTIVATED\n  token 0x${"1".repeat(40)}`);
    const msgs = packMessages(texts, 1_900, "Spare monitor");
    expect(msgs.length).toBeGreaterThan(1);
    expect(msgs.length).toBeLessThan(5);
    for (const m of msgs) {
      expect(m.length).toBeLessThanOrEqual(1_900);
      expect(m.startsWith("Spare monitor")).toBe(true);
    }
    expect(msgs.join("").match(/ACTIVATED/g)?.length).toBe(30);
    const [big] = packMessages(["x".repeat(5_000)], 1_000, "H");
    expect(big!.length).toBeLessThanOrEqual(1_000);
  });

  test("format tags severity, repeats and resolutions", () => {
    expect(formatAlert(alert())).toStartWith("[CRITICAL] CashPark");
    expect(formatAlert(alert({ state: "repeat" }))).toStartWith("[CRITICAL] (still)");
    expect(formatAlert(alert({ state: "resolved", severity: "info" }))).toStartWith("[RESOLVED]");
  });
});

describe("monitor alerts: dispatcher", () => {
  test("every alert is logged as JSON; only pushable ones reach the sinks, most severe first", async () => {
    const clock = { t: 0 };
    const lines: string[] = [];
    const s = recordingSink("telegram");
    const d = dispatcher([s], clock, lines);
    await d.dispatch([
      alert({ key: "w", severity: "warning", title: "AssetRegistry: SPY ACTIVATED" }),
      alert({ key: "h", severity: "critical", title: "old history", push: false }),
      alert({ key: "c", severity: "critical", title: "CashPark: executor set" }),
    ]);
    expect(lines.length).toBe(3);
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
    expect(JSON.parse(lines[1]!).alert.pushed).toBe(false);
    expect(s.got.length).toBe(1);
    expect(s.got[0]!.indexOf("executor set")).toBeLessThan(s.got[0]!.indexOf("SPY ACTIVATED"));
    expect(s.got[0]).not.toContain("old history");
  });

  test("routing: a critical-only sink gets criticals (and their resolutions), an everything sink gets all", async () => {
    const clock = { t: 0 };
    const phone = { ...recordingSink("telegram"), minSeverity: "critical" as const };
    const phoneGot: string[] = [];
    phone.send = async (t) => void phoneGot.push(t);
    const all = recordingSink("webhook");
    const d = dispatcher([phone, all], clock);
    await d.dispatch([
      alert({ key: "c", severity: "critical", title: "OWNERSHIP STARTED" }),
      alert({ key: "w", severity: "warning", title: "asset activated" }),
      alert({ key: "i", severity: "info", title: "clearance revoked" }),
    ]);
    await d.dispatch([alert({ key: "cond:rpc.down", severity: "critical", state: "resolved", title: "RPC healthy again" })]);
    const phoneText = phoneGot.join(" | ");
    expect(phoneText).toContain("OWNERSHIP STARTED");
    expect(phoneText).toContain("[RESOLVED] RPC healthy again");
    expect(phoneText).not.toContain("asset activated");
    expect(phoneText).not.toContain("clearance revoked");
    expect(all.got.join(" | ")).toContain("clearance revoked");
  });

  test("rate limit: a sink gets at most N messages a minute; the rest wait, none are lost", async () => {
    const clock = { t: 0 };
    const s = recordingSink("webhook", { maxChars: 120 });
    const d = dispatcher([s], clock, [], 2);
    await d.dispatch(Array.from({ length: 5 }, (_, i) => alert({ key: `k${i}`, title: `alert number ${i} ${"x".repeat(40)}` })));
    expect(s.got.length).toBe(2);
    expect(d.pending().webhook).toBe(3);
    await d.flush();
    expect(s.got.length).toBe(2);
    clock.t = 60_000;
    await d.flush();
    expect(s.got.length).toBe(4);
    clock.t = 120_000;
    await d.flush();
    expect(s.got.length).toBe(5);
    expect(d.pending().webhook).toBe(0);
  });

  test("a failing sink retries a bounded number of times, never blocks the others, and leaks no secret", async () => {
    const clock = { t: 0 };
    const lines: string[] = [];
    const bad = recordingSink("telegram", { fail: () => true });
    const good = recordingSink("webhook");
    const d = dispatcher([bad, good], clock, lines);
    await d.dispatch([alert({ title: `RPC failing: ${RPC}` })]);
    expect(good.got.length).toBe(1);
    expect(good.got[0]).not.toContain("SECRETKEY");
    await d.flush();
    await d.flush();
    expect(d.pending().telegram).toBe(0); // dropped after 3 attempts
    expect(d.lost.get("telegram")).toBe(1);
    expect(d.lost.get("webhook")).toBe(0);
    const errors = lines.filter((l) => l.includes("send failed"));
    expect(errors.length).toBe(3);
    for (const l of lines) expect(l).not.toContain("SECRETKEY");
    // The next message that does go out says something was dropped.
    bad.send = async (t) => void bad.got.push(t);
    await d.dispatch([alert({ key: "next", title: "next one" })]);
    expect(bad.got[0]).toContain("1 earlier message(s) dropped");
  });
});

describe("monitor sinks: payloads", () => {
  test("telegram posts plain text to sendMessage with the chat id", async () => {
    const calls: { url: string; body: string }[] = [];
    const sink = telegramSink(BOT, "-100123", {
      fetch: async (url, init) => {
        calls.push({ url, body: init.body });
        return { ok: true, status: 200, text: async () => "{}" };
      },
    });
    await sink.send("hello");
    expect(calls[0]!.url).toBe(`https://api.telegram.org/bot${BOT}/sendMessage`);
    expect(JSON.parse(calls[0]!.body)).toEqual({ chat_id: "-100123", text: "hello", disable_web_page_preview: true });
  });

  test("webhook body works for Discord (content) and Slack (text); HTTP errors throw", async () => {
    let body = "";
    const ok = webhookSink(HOOK, {
      fetch: async (_u, init) => {
        body = init.body;
        return { ok: true, status: 204, text: async () => "" };
      },
    });
    await ok.send("hi");
    expect(JSON.parse(body)).toEqual({ content: "hi", text: "hi" });
    const down = webhookSink(HOOK, { fetch: async () => ({ ok: false, status: 429, text: async () => "rate limited" }) });
    await expect(down.send("hi")).rejects.toThrow("webhook HTTP 429");
  });
});

describe("monitor config", () => {
  test("defaults, ETH floors in wei, and no private key is read", () => {
    const c = loadMonitorConfig({ KEEPER_PK: `0x${"1".repeat(64)}` });
    expect(c.KEEPER_MIN_ETH).toBe(2_000_000_000_000_000n);
    expect(c.OWNER_MIN_ETH).toBe(1_000_000_000_000_000n);
    expect(c.EXPLORER_URL).toBe(EXPLORER);
    expect(c.LOGS_RANGE).toBe(50_000n);
    expect(JSON.stringify(c, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).not.toContain("1111111111");
    expect(loadMonitorConfig({ KEEPER_MIN_ETH: "0" }).KEEPER_MIN_ETH).toBe(0n);
    expect(() => loadMonitorConfig({ KEEPER_MIN_ETH: "lots" })).toThrow();
    expect(() => loadMonitorConfig({ TELEGRAM_BOT_TOKEN: BOT })).toThrow("set together");
  });

  test("the book's roles, live adapter and screening flag are read; env overrides roles", () => {
    const json = {
      chainId: 4663,
      startBlock: 10,
      contracts: Object.fromEntries(
        ["AssetRegistry", "RuleRegistry", "ElectionRegistry", "ScreeningGate", "StockRouter", "CashPark", "FeeVault", "SweepExecutor", "UsdgParkAdapter"].map((n, i) => [
          n,
          `0x${(i + 1).toString(16).padStart(40, "0")}`,
        ]),
      ),
      roles: { owner: `0x${"a".repeat(40)}`, keeper: `0x${"b".repeat(40)}` },
      parkAdapter: { live: "UsdgParkAdapter", standby: "SgovParkAdapter" },
      screeningEnforced: false,
    };
    const b = parseMonitorBook(json, 4663);
    expect(b.roles.owner?.toLowerCase()).toBe(`0x${"a".repeat(40)}`);
    expect(b.roles.pauser).toBeNull();
    expect(b.liveAdapter).toBe("usdgParkAdapter");
    expect(b.screeningEnforced).toBe(false);
    expect(() => parseMonitorBook(json, 1)).toThrow("chain");
    const moved = withRoleOverrides(b, loadMonitorConfig({ OWNER_ADDRESS: `0x${"c".repeat(40)}` }));
    expect(moved.roles.owner?.toLowerCase()).toBe(`0x${"c".repeat(40)}`);
    expect(moved.roles.keeper).toBe(b.roles.keeper);
  });
});
