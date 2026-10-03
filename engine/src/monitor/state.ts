/**
 * What survives a restart: the scan cursor, the linked-wallet set, the event
 * keys already alerted and the conditions already open. With STATE_FILE on a
 * persistent volume a restart resumes at cursor + 1 and alerts on nothing twice;
 * a downtime gap is scanned and alerted, never skipped.
 *
 * Written atomically (temp file + rename): a crash mid-write leaves the
 * previous state, never a torn file.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ConditionRecord } from "./alerts.ts";

export interface LinkRecord {
  /** null once unlinked. */
  account: string | null;
  block: string;
  logIndex: number;
}

export interface MonitorState {
  version: 1;
  chainId: number;
  /** Last block fully scanned for watched events. */
  cursor: string;
  /** First block of the live scan; discovery rebuilds links below it. */
  scanStart: string;
  /** Events below this block were history on a start without state: logged, not pushed. */
  pushFrom: string;
  /** Linked / Unlinked rebuilt up to here (from the deploy block). */
  discoveredTo: string;
  links: Record<string, LinkRecord>;
  seen: [string, number][];
  conditions: [string, ConditionRecord][];
  keeperNonce: number | null;
  lastKeeperActivityAt: number | null;
  watchingSince: number;
  sweepDueSince: number | null;
}

export function loadState(path: string, chainId: number): { state: MonitorState | null; problem: string | null } {
  if (!existsSync(path)) return { state: null, problem: null };
  try {
    const s = JSON.parse(readFileSync(path, "utf8")) as MonitorState;
    if (s.version !== 1) return { state: null, problem: `state file version ${String(s.version)} is not 1; starting fresh` };
    if (s.chainId !== chainId) return { state: null, problem: `state file is for chain ${s.chainId}, monitor serves ${chainId}; starting fresh` };
    if (![s.cursor, s.scanStart, s.pushFrom, s.discoveredTo].every((v) => typeof v === "string" && /^\d+$/.test(v))) {
      return { state: null, problem: "state file has a malformed cursor; starting fresh" };
    }
    return { state: s, problem: null };
  } catch (err) {
    return { state: null, problem: `state file unreadable (${(err as Error).message.split("\n")[0]}); starting fresh` };
  }
}

export function saveState(path: string, s: MonitorState): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(s));
  renameSync(tmp, path);
}
