/**
 * A fake JSON-RPC chain for unit tests, served as a viem custom transport
 * (`transport()`) or over HTTP (`serve()`, JSON-RPC batches included).
 *
 * Contracts are ABI + handler pairs: an eth_call (or a Multicall3 aggregate3
 * subcall, or an eth_estimateGas) is decoded against the ABI registered at its
 * `to`, recorded with its block, and answered by the handler. A handler that
 * throws `Revert` reverts with that data; an address with no contract answers
 * like an EOA (empty return data). eth_getLogs serves `emit()`ed logs by
 * address, topics and range. eth_sendRawTransaction parses and decodes the
 * signed transaction, records it (gas limit included), and (with `autoMine`)
 * mines it at head + 1 with the logs, status and gas used its `onMined` hook
 * returns.
 *
 * Every JSON-RPC request is recorded in `requests`; `use()` intercepts any
 * method (return undefined to fall through, throw `rpcError()` to fail it,
 * or await something to hold it).
 */
import {
  RpcRequestError,
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  encodeFunctionResult,
  keccak256,
  multicall3Abi,
  numberToHex,
  parseTransaction,
  recoverTransactionAddress,
  toHex,
  type Abi,
  type AbiEvent,
  type Address,
  type Hex,
  type Transport,
} from "viem";

const MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11";
const lc = (a: string) => a.toLowerCase();

/** A revert with exact revert data. */
export class Revert extends Error {
  constructor(readonly data: Hex) {
    super(`revert ${data.slice(0, 10)}`);
  }
}
export const revertWith = (abi: Abi, errorName: string, args?: readonly unknown[]) =>
  new Revert(encodeErrorResult({ abi, errorName, args } as never));

/** A JSON-RPC error response. */
export class RpcFailure extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: Hex,
  ) {
    super(message);
  }
}
export const rpcError = (code: number, message: string, data?: Hex) => new RpcFailure(code, message, data);

export interface CallCtx {
  block: bigint;
  from?: Address;
}
export type Handler = (args: readonly any[], ctx: CallCtx) => unknown;

export interface ContractCall {
  to: Address;
  functionName: string;
  args: readonly unknown[];
  block: bigint;
  from?: Address;
  via: "eth_call" | "multicall" | "eth_estimateGas";
}

export interface SentTx {
  raw: Hex;
  hash: Hex;
  from: Address;
  to: Address;
  nonce: number;
  chainId: number;
  functionName: string;
  args: readonly unknown[];
  /** The gas limit it was signed with. */
  gas: bigint;
  /** Block it was mined in; undefined while pending. */
  block?: bigint;
}

export interface RpcLog {
  address: Address;
  topics: Hex[];
  data: Hex;
  blockNumber: bigint;
  logIndex: number;
  transactionHash: Hex;
}

interface Receipt {
  status: "success" | "reverted";
  block: bigint;
  logs: RpcLog[];
  gasUsed: bigint;
}

type Interceptor = (method: string, params: any[]) => unknown;

const hexBlock = (b: bigint) => numberToHex(b);

export class FakeRpc {
  head = 1_000n;
  chainId = 4663;
  /** Seconds; default: 1 s blocks ending at a fixed Wednesday. */
  timestampOf: (block: bigint) => bigint = (b) => 1_790_000_000n + b;
  balance = 10n ** 18n;
  latestNonce = 0;
  pendingNonce = 0;
  /** Mine every sent tx at head + 1 straight away. */
  autoMine = true;
  /** Gas eth_estimateGas answers for a decoded call. */
  gasFor: (call: ContractCall) => bigint = () => 300_000n;
  /** Logs, status and gas used (default 21,000; "all" = its whole gas limit) of a mined tx. */
  onMined: (tx: SentTx) => {
    logs?: Omit<RpcLog, "blockNumber" | "logIndex" | "transactionHash">[];
    status?: "success" | "reverted";
    gasUsed?: bigint | "all";
  } = () => ({});

  readonly requests: { method: string; params: any[] }[] = [];
  /** Over HTTP: requests per POST (a JSON-RPC batch counts its length). */
  readonly httpPosts: number[] = [];
  readonly calls: ContractCall[] = [];
  readonly sent: SentTx[] = [];
  readonly logs: RpcLog[] = [];
  readonly code = new Map<string, Hex>();
  private readonly contracts = new Map<string, { abi: Abi; fns: Record<string, Handler> }>();
  private readonly receipts = new Map<string, Receipt>();
  private readonly interceptors: Interceptor[] = [];

  /** Register (or extend) the contract at `address`. */
  contract(address: string, abi: Abi, fns: Record<string, Handler>): this {
    const k = lc(address);
    const prev = this.contracts.get(k);
    this.contracts.set(k, { abi: prev ? ([...prev.abi, ...abi] as Abi) : abi, fns: { ...prev?.fns, ...fns } });
    if (!this.code.has(k)) this.code.set(k, "0x6080");
    return this;
  }

  use(fn: Interceptor): () => void {
    this.interceptors.push(fn);
    return () => {
      const i = this.interceptors.indexOf(fn);
      if (i >= 0) this.interceptors.splice(i, 1);
    };
  }

  /** Append an event log (encoded from its ABI) at `block`. */
  emit(address: Address, event: AbiEvent, args: Record<string, unknown>, block: bigint, logIndex = 0, txHash?: Hex): RpcLog {
    const log = { ...encodeLog(address, event, args), blockNumber: block, logIndex, transactionHash: txHash ?? keccak256(toHex(`${block}:${logIndex}:${this.logs.length}`)) };
    this.logs.push(log);
    return log;
  }

  /** Contract calls to `functionName` (optionally only via one path). */
  callsTo(functionName: string, via?: ContractCall["via"]): ContractCall[] {
    return this.calls.filter((c) => c.functionName === functionName && (!via || c.via === via));
  }

  count(method: string): number {
    return this.requests.filter((r) => r.method === method).length;
  }

  /** Mine a pending tx now (manual mining). */
  mine(hash: Hex): bigint {
    const tx = this.sent.find((t) => t.hash === hash);
    if (!tx) throw new Error(`unknown tx ${hash}`);
    this.head += 1n;
    tx.block = this.head;
    this.latestNonce = Math.max(this.latestNonce, tx.nonce + 1);
    const out = this.onMined(tx);
    const logs = (out.logs ?? []).map((l, i) => ({ ...l, blockNumber: tx.block!, logIndex: i, transactionHash: hash }));
    const gasUsed = out.gasUsed === "all" ? tx.gas : (out.gasUsed ?? 21_000n);
    this.receipts.set(hash, { status: out.status ?? "success", block: tx.block, logs, gasUsed });
    return tx.block;
  }

  transport(): Transport {
    return custom({ request: ({ method, params }) => this.request(method, (params as any[]) ?? []) }, { retryCount: 0 });
  }

  /** The same chain over HTTP, as the keeper's production transport reaches a node. */
  serve(): { url: string; stop: () => void } {
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const body = (await req.json()) as { id: number; method: string; params?: any[] } | { id: number; method: string; params?: any[] }[];
        this.httpPosts.push(Array.isArray(body) ? body.length : 1);
        const one = async (r: { id: number; method: string; params?: any[] }) => {
          try {
            return { jsonrpc: "2.0", id: r.id, result: await this.handle(r.method, r.params ?? []) };
          } catch (err) {
            const e = toFailure(err);
            return { jsonrpc: "2.0", id: r.id, error: { code: e.code, message: e.message, ...(e.data ? { data: e.data } : {}) } };
          }
        };
        return Response.json(Array.isArray(body) ? await Promise.all(body.map(one)) : await one(body));
      },
    });
    return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
  }

  async request(method: string, params: any[]): Promise<unknown> {
    try {
      return await this.handle(method, params);
    } catch (err) {
      const e = toFailure(err);
      throw new RpcRequestError({ body: { method, params }, url: "fake-rpc", error: { code: e.code, message: e.message, ...(e.data ? { data: e.data } : {}) } } as never);
    }
  }

  private async handle(method: string, params: any[]): Promise<unknown> {
    this.requests.push({ method, params });
    for (const fn of [...this.interceptors]) {
      const r = await fn(method, params);
      if (r !== undefined) return r;
    }
    switch (method) {
      case "eth_chainId":
        return numberToHex(this.chainId);
      case "eth_blockNumber":
        return hexBlock(this.head);
      case "eth_getBalance":
        return numberToHex(this.balance);
      case "eth_getCode":
        return this.code.get(lc(params[0])) ?? "0x";
      case "eth_gasPrice":
      case "eth_maxPriorityFeePerGas":
        return numberToHex(10_000_000n);
      case "eth_getTransactionCount":
        return numberToHex(params[1] === "pending" ? this.pendingNonce : this.latestNonce);
      case "eth_getBlockByNumber":
        return this.block(this.blockOf(params[0]));
      case "eth_call":
        return this.call(params[0], this.blockOf(params[1]), "eth_call");
      case "eth_estimateGas": {
        const { call } = this.decode(params[0], this.blockOf(params[1]), "eth_estimateGas");
        this.run(call);
        return numberToHex(this.gasFor(call));
      }
      case "eth_getLogs":
        return this.getLogs(params[0]);
      case "eth_sendRawTransaction":
        return this.sendRaw(params[0]);
      case "eth_getTransactionReceipt":
        return this.receipt(params[0]);
      case "eth_getTransactionByHash":
        return this.txByHash(params[0]);
      default:
        throw rpcError(-32601, `fake-rpc: method ${method} not served`);
    }
  }

  private blockOf(tag: unknown): bigint {
    if (tag === undefined || tag === "latest" || tag === "pending" || tag === "safe" || tag === "finalized") return this.head;
    if (typeof tag === "string" && tag.startsWith("0x")) return BigInt(tag);
    if (tag && typeof tag === "object" && "blockNumber" in tag) return BigInt((tag as { blockNumber: string }).blockNumber);
    throw rpcError(-32602, `fake-rpc: bad block tag ${String(tag)}`);
  }

  private block(n: bigint) {
    return {
      number: hexBlock(n),
      hash: keccak256(toHex(`block:${n}`)),
      parentHash: keccak256(toHex(`block:${n - 1n}`)),
      timestamp: numberToHex(this.timestampOf(n)),
      baseFeePerGas: numberToHex(10_000_000n),
      gasLimit: numberToHex(1_125_899_906_842_624n),
      gasUsed: "0x0",
      miner: "0x0000000000000000000000000000000000000000",
      nonce: "0x0000000000000000",
      difficulty: "0x1",
      totalDifficulty: "0x1",
      extraData: "0x",
      size: "0x1",
      logsBloom: `0x${"0".repeat(512)}`,
      transactionsRoot: keccak256("0x01"),
      stateRoot: keccak256("0x02"),
      receiptsRoot: keccak256("0x03"),
      sha3Uncles: keccak256("0x04"),
      mixHash: keccak256("0x05"),
      transactions: [],
      uncles: [],
    };
  }

  private decode(
    tx: { to?: string; data?: Hex; input?: Hex; from?: Address },
    block: bigint,
    via: ContractCall["via"],
    record = true,
  ): { call: ContractCall; abi: Abi } {
    const to = lc(tx.to ?? "") as Address;
    const c = this.contracts.get(to);
    const data = (tx.data ?? tx.input ?? "0x") as Hex;
    if (!c) throw rpcError(-32000, `fake-rpc: no contract at ${to}`);
    let d;
    try {
      d = decodeFunctionData({ abi: c.abi, data });
    } catch {
      throw new Revert("0x"); // no such function on this contract
    }
    const call: ContractCall = { to, functionName: d.functionName, args: (d.args ?? []) as readonly unknown[], block, from: tx.from, via };
    if (record) this.calls.push(call);
    return { call, abi: c.abi };
  }

  /** Run a decoded call's handler; Revert propagates. */
  private run(call: ContractCall): unknown {
    const fn = this.contracts.get(call.to)?.fns[call.functionName];
    if (!fn) throw new Revert("0x");
    return fn(call.args, { block: call.block, from: call.from });
  }

  private exec(target: string, data: Hex, block: bigint, from: Address | undefined, via: ContractCall["via"]): Hex {
    if (!this.contracts.has(lc(target))) return "0x"; // an EOA: the call succeeds with no data
    const { call, abi } = this.decode({ to: target, data, from }, block, via);
    const result = this.run(call);
    return encodeFunctionResult({ abi, functionName: call.functionName, result } as never);
  }

  private call(tx: { to: string; data?: Hex; input?: Hex; from?: Address }, block: bigint, via: ContractCall["via"]): Hex {
    const data = (tx.data ?? tx.input ?? "0x") as Hex;
    if (lc(tx.to) !== MULTICALL3) {
      try {
        return this.exec(tx.to, data, block, tx.from, via);
      } catch (err) {
        if (err instanceof Revert) throw rpcError(3, "execution reverted", err.data);
        throw err;
      }
    }
    const { functionName, args } = decodeFunctionData({ abi: multicall3Abi, data });
    if (functionName !== "aggregate3") throw rpcError(-32000, `fake-rpc: multicall ${functionName} not served`);
    const results = (args[0] as readonly { target: Address; allowFailure: boolean; callData: Hex }[]).map((c) => {
      try {
        return { success: true, returnData: this.exec(c.target, c.callData, block, tx.from, "multicall") };
      } catch (err) {
        if (!(err instanceof Revert)) throw err;
        if (!c.allowFailure) throw rpcError(3, "execution reverted", err.data);
        return { success: false, returnData: err.data };
      }
    });
    return encodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", result: results });
  }

  private getLogs(f: { address?: string | string[]; topics?: (Hex | Hex[] | null)[]; fromBlock?: Hex; toBlock?: Hex }) {
    const from = f.fromBlock ? this.blockOf(f.fromBlock) : this.head;
    const to = f.toBlock ? this.blockOf(f.toBlock) : this.head;
    const addrs = f.address === undefined ? null : (Array.isArray(f.address) ? f.address : [f.address]).map(lc);
    const topics = f.topics ?? [];
    return this.logs
      .filter((l) => l.blockNumber >= from && l.blockNumber <= to)
      .filter((l) => !addrs || addrs.includes(lc(l.address)))
      .filter((l) =>
        topics.every((t, i) => t === null || t === undefined || (Array.isArray(t) ? t.map(lc) : [lc(t)]).includes(lc(l.topics[i] ?? ""))),
      )
      .sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1))
      .map((l) => rpcLog(l));
  }

  private async sendRaw(raw: Hex): Promise<Hex> {
    const tx = parseTransaction(raw);
    const from = await recoverTransactionAddress({ serializedTransaction: raw as never });
    if (tx.chainId !== this.chainId) throw rpcError(-32000, `fake-rpc: chain id ${tx.chainId} != ${this.chainId}`);
    if (tx.nonce !== this.pendingNonce) throw rpcError(-32000, `fake-rpc: nonce ${tx.nonce} != pending ${this.pendingNonce}`);
    const { call } = this.decode({ to: tx.to!, data: tx.data!, from }, this.head + 1n, "eth_call", false);
    const hash = keccak256(raw);
    this.sent.push({ raw, hash, from, to: lc(tx.to!) as Address, nonce: tx.nonce!, chainId: tx.chainId!, functionName: call.functionName, args: call.args, gas: tx.gas ?? 0n });
    this.pendingNonce++;
    if (this.autoMine) this.mine(hash);
    return hash;
  }

  private receipt(hash: Hex) {
    const r = this.receipts.get(hash);
    const tx = this.sent.find((t) => t.hash === hash);
    if (!r || !tx) return null;
    return {
      transactionHash: hash,
      transactionIndex: "0x0",
      blockHash: keccak256(toHex(`block:${r.block}`)),
      blockNumber: hexBlock(r.block),
      from: tx.from,
      to: tx.to,
      cumulativeGasUsed: numberToHex(r.gasUsed),
      gasUsed: numberToHex(r.gasUsed),
      effectiveGasPrice: "0x989680",
      contractAddress: null,
      logs: r.logs.map(rpcLog),
      logsBloom: `0x${"0".repeat(512)}`,
      status: r.status === "success" ? "0x1" : "0x0",
      type: "0x2",
    };
  }

  private txByHash(hash: Hex) {
    const tx = this.sent.find((t) => t.hash === hash);
    if (!tx) return null;
    const p = parseTransaction(tx.raw);
    return {
      hash,
      from: tx.from,
      to: tx.to,
      input: p.data,
      nonce: numberToHex(tx.nonce),
      value: "0x0",
      gas: numberToHex(p.gas ?? 0n),
      maxFeePerGas: numberToHex(p.maxFeePerGas ?? 0n),
      maxPriorityFeePerGas: numberToHex(p.maxPriorityFeePerGas ?? 0n),
      chainId: numberToHex(tx.chainId),
      type: "0x2",
      blockHash: tx.block === undefined ? null : keccak256(toHex(`block:${tx.block}`)),
      blockNumber: tx.block === undefined ? null : hexBlock(tx.block),
      transactionIndex: tx.block === undefined ? null : "0x0",
      v: "0x0",
      r: "0x1",
      s: "0x1",
      yParity: "0x0",
      accessList: [],
    };
  }
}

function toFailure(err: unknown): RpcFailure {
  if (err instanceof RpcFailure) return err;
  if (err instanceof Revert) return new RpcFailure(3, "execution reverted", err.data);
  return new RpcFailure(-32000, (err as Error)?.message ?? String(err));
}

function rpcLog(l: RpcLog) {
  return {
    address: l.address,
    topics: l.topics,
    data: l.data,
    blockNumber: hexBlock(l.blockNumber),
    blockHash: keccak256(toHex(`block:${l.blockNumber}`)),
    transactionHash: l.transactionHash,
    transactionIndex: "0x0",
    logIndex: numberToHex(l.logIndex),
    removed: false,
  };
}

/** topics + data of `event` with `args`, as a node returns them. */
export function encodeLog(address: Address, event: AbiEvent, args: Record<string, unknown>): { address: Address; topics: Hex[]; data: Hex } {
  const topics = encodeEventTopics({ abi: [event], eventName: event.name, args } as never) as Hex[];
  const plain = event.inputs.filter((i) => !i.indexed);
  const data = plain.length ? encodeAbiParameters(plain, plain.map((i) => args[i.name!])) : "0x";
  return { address, topics, data };
}
