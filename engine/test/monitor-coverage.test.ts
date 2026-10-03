/**
 * The monitor's watch table against the Solidity itself: every function an
 * owner, pauser or attestor can call must emit an event the monitor watches,
 * and every watched event must match the source declaration exactly (name,
 * canonical types, indexed flags), or a privileged action could go unseen.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { toEventSignature, type AbiEvent } from "viem";
import { CONTRACT_ABIS, CONTRACT_NAMES, eventsOf, TIMELOCK_ABI, TIMELOCK_WATCH, WATCH, type BookKey } from "../src/monitor/watch.ts";

const SRC = resolve(import.meta.dir, "../../contracts/src");

function solFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return f === "interfaces" || f === "libraries" ? [] : solFiles(p);
    return f.endsWith(".sol") ? [p] : [];
  });
}

/** Strip comments so a commented-out guard or emit never counts. */
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

interface Fn {
  name: string;
  modifiers: string;
  body: string;
}

function functions(src: string): Fn[] {
  const out: Fn[] = [];
  const re = /function\s+(\w+)\s*\(/g;
  for (let m; (m = re.exec(src)); ) {
    let i = src.indexOf(")", m.index);
    // Skip nested parens in the parameter list.
    let depth = 0;
    for (i = src.indexOf("(", m.index); i < src.length; i++) {
      if (src[i] === "(") depth++;
      if (src[i] === ")" && --depth === 0) break;
    }
    const open = src.indexOf("{", i);
    const semi = src.indexOf(";", i);
    if (open < 0 || (semi >= 0 && semi < open)) continue; // declaration without a body
    let d = 0;
    let end = open;
    for (; end < src.length; end++) {
      if (src[end] === "{") d++;
      if (src[end] === "}" && --d === 0) break;
    }
    out.push({ name: m[1]!, modifiers: src.slice(i + 1, open), body: src.slice(open, end + 1) });
  }
  return out;
}

type Guard = "owner" | "pauser" | "attestor" | null;
function guardOf(f: Fn): Guard {
  if (/\bonlyOwner\b/.test(f.modifiers)) return "owner";
  if (/msg\.sender\s*!=\s*pauser/.test(f.body)) return "pauser";
  if (/msg\.sender\s*!=\s*owner\(\)/.test(f.body)) return "owner";
  if (/msg\.sender\s*!=\s*attestor/.test(f.body)) return "attestor";
  return null;
}

const emits = (f: Fn) => [...f.body.matchAll(/\bemit\s+(\w+)\s*\(/g)].map((m) => m[1]!);

interface Parsed {
  name: string;
  inheritsAuth: boolean;
  privileged: { fn: string; guard: Guard; events: string[] }[];
  events: Map<string, string>;
}

function parse(path: string): Parsed {
  const src = stripComments(readFileSync(path, "utf8"));
  const head = /(?:abstract\s+)?contract\s+(\w+)(?:\s+is\s+([^{]+))?\{/.exec(src);
  if (!head) throw new Error(`no contract in ${path}`);
  const events = new Map<string, string>();
  for (const m of src.matchAll(/\bevent\s+(\w+)\s*\(([^)]*)\)\s*;/g)) events.set(m[1]!, m[2]!);
  const privileged = functions(src)
    .map((f) => ({ fn: f.name, guard: guardOf(f), events: emits(f) }))
    .filter((f) => f.guard !== null);
  return { name: head[1]!, inheritsAuth: /\bSpareAuth\b/.test(head[2] ?? ""), privileged, events };
}

const parsed = solFiles(SRC).map(parse);
const auth = parsed.find((p) => p.name === "SpareAuth")!;
const keyOf = (name: string) => (Object.keys(CONTRACT_NAMES) as BookKey[]).find((k) => CONTRACT_NAMES[k] === name);

/** Canonical type list of a Solidity event parameter list; `indexed` flags alongside. */
const STRUCTS: Record<string, string> = { "Leg[]": "(address,uint16)[]", "OracleGuard.Status": "uint8" };
function canonical(params: string): { sig: string; indexed: boolean[] } {
  const parts = params.split(",").map((p) => p.trim()).filter(Boolean);
  const types = parts.map((p) => {
    const t = p.split(/\s+/)[0]!;
    return STRUCTS[t] ?? t;
  });
  return { sig: types.join(","), indexed: parts.map((p) => /\bindexed\b/.test(p)) };
}

describe("monitor coverage of privileged functions (from contracts/src)", () => {
  test("the parser sees the privileged surface it should", () => {
    expect(auth.privileged.map((f) => f.fn).sort()).toEqual(["pause", "setKeeper", "setPauser", "unpause"]);
    const cashPark = parsed.find((p) => p.name === "CashPark")!;
    expect(cashPark.privileged.map((f) => f.fn).sort()).toEqual(["setAdapter", "setExecutor"]);
    const total = parsed.reduce((n, p) => n + p.privileged.length, 0);
    expect(total).toBeGreaterThanOrEqual(17);
  });

  test("every concrete contract in contracts/src is watched", () => {
    for (const p of parsed) {
      if (p.name === "SpareAuth") continue;
      expect(keyOf(p.name)).toBeDefined();
    }
  });

  test("every owner / pauser function's event is a PRIVILEGED alert; attestor ones are at least logged", () => {
    // Ownable2Step (OpenZeppelin): transferOwnership / acceptOwnership / renounceOwnership.
    const ownable = ["OwnershipTransferStarted", "OwnershipTransferred"];
    for (const p of parsed) {
      if (p.name === "SpareAuth") continue;
      const w = WATCH[keyOf(p.name)!];
      const fns = [...p.privileged, ...(p.inheritsAuth ? auth.privileged : [])];
      for (const f of fns) {
        expect(f.events.length).toBeGreaterThan(0); // a silent privileged setter could not be monitored at all
        for (const ev of f.events) {
          const watched = f.guard === "attestor" ? Boolean(w.privileged[ev]) || w.activity.includes(ev) : Boolean(w.privileged[ev]);
          if (!watched) throw new Error(`${p.name}.${f.fn} (${f.guard}) emits ${ev}, which the monitor does not watch`);
        }
      }
      if (p.inheritsAuth) for (const ev of ownable) expect(w.privileged[ev]).toBeDefined();
      else expect(Object.keys(w.privileged)).toEqual([]);
    }
  });

  test("every watched event matches its Solidity declaration: types and indexed flags", () => {
    let checked = 0;
    for (const p of parsed) {
      if (p.name === "SpareAuth") continue;
      const key = keyOf(p.name)!;
      for (const ev of eventsOf(CONTRACT_ABIS[key], WATCH[key], p.name)) {
        const decl = p.events.get(ev.name) ?? auth.events.get(ev.name);
        if (!decl) continue; // OpenZeppelin's Ownable2Step events (lib/ is not in git)
        const src = canonical(decl);
        expect(toEventSignature(ev)).toBe(`${ev.name}(${src.sig})`);
        expect(ev.inputs.map((i) => Boolean(i.indexed))).toEqual(src.indexed);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(25);
  });

  test("OpenZeppelin events have their 5.0.2 signatures", () => {
    const ev = (name: string) => (CONTRACT_ABIS.cashPark as readonly AbiEvent[]).find((x) => x.type === "event" && x.name === name)!;
    expect(toEventSignature(ev("OwnershipTransferStarted"))).toBe("OwnershipTransferStarted(address,address)");
    expect(toEventSignature(ev("OwnershipTransferred"))).toBe("OwnershipTransferred(address,address)");
    const tl = eventsOf(TIMELOCK_ABI as never, TIMELOCK_WATCH, "Timelock").map((e) => toEventSignature(e));
    expect(tl).toEqual([
      "CallScheduled(bytes32,uint256,address,uint256,bytes,bytes32,uint256)",
      "CallExecuted(bytes32,uint256,address,uint256,bytes)",
      "Cancelled(bytes32)",
      "MinDelayChange(uint256,uint256)",
      "RoleGranted(bytes32,address,address)",
      "RoleRevoked(bytes32,address,address)",
      "RoleAdminChanged(bytes32,bytes32,bytes32)",
    ]);
  });
});
