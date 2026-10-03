/**
 * Local anvil fork of RHC mainnet for tests, re-identified as chain 31337.
 *
 * The public RHC RPC only serves state for roughly the last 5k–20k blocks
 * (~10–30 min at 0.1s blocks; measured 2026-09-30), so the fork is taken at the
 * LIVE head and the suite must finish promptly. Storage caching is off so runs
 * do not accumulate per-block cache directories in ~/.foundry.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const RHC_RPC = process.env.RHC_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com";

export function anvilBin(): string | null {
  const exe = join(homedir(), ".foundry", "bin", process.platform === "win32" ? "anvil.exe" : "anvil");
  return existsSync(exe) ? exe : null;
}

export interface Anvil {
  url: string;
  port: number;
  stop(): Promise<void>;
}

export async function startAnvil(opts: { fork?: boolean; chainId?: number } = {}): Promise<Anvil> {
  const bin = anvilBin();
  if (!bin) throw new Error("anvil not found in ~/.foundry/bin");
  const args = ["--port", "0", "--chain-id", String(opts.chainId ?? 31337)];
  if (opts.fork !== false) args.push("--fork-url", RHC_RPC, "--no-storage-caching", "--fork-retry-backoff", "500", "--retries", "8");
  const proc: ChildProcess = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`anvil did not start:\n${out.slice(-2000)}`)), 90_000);
    const onData = (b: Buffer) => {
      out += b.toString();
      const m = /Listening on [^:\s]+:(\d+)/.exec(out);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    };
    proc.stdout!.on("data", onData);
    proc.stderr!.on("data", onData);
    proc.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`anvil exited (${code}):\n${out.slice(-2000)}`));
    });
  });
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    stop: async () => {
      proc.kill();
      await new Promise((r) => setTimeout(r, 200));
    },
  };
}

/** JSON-RPC helper for anvil_* cheatcodes. */
export async function rpc<T = unknown>(url: string, method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result as T;
}
