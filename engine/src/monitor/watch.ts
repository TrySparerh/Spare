/**
 * What the monitor watches, per contract. Every event below is taken from the
 * generated ABIs (chain/abis.ts, lifted from the Foundry artifacts), so a
 * topic can never drift from what the deployed bytecode emits. The
 * TimelockController events are OpenZeppelin 5.0.2's, verbatim.
 *
 * PRIVILEGED: one alert per event. Every onlyOwner / pauser / attestor
 * function in contracts/src emits one of these (test/monitor-coverage.test.ts
 * reads the Solidity and fails if a privileged function is ever left out).
 * OPERATIONAL: events that mean a user's money did not move as planned.
 * ACTIVITY: proof the keeper is working, and the linked-wallet set the
 * liveness checks need. Logged, never pushed.
 */
import { formatUnits, getAddress, parseAbiItem, toEventSelector, zeroAddress, type Abi, type AbiEvent, type Address, type Hex } from "viem";
import {
  assetRegistryAbi,
  cashParkAbi,
  electionRegistryAbi,
  feeVaultAbi,
  ruleRegistryAbi,
  screeningGateAbi,
  sgovParkAdapterAbi,
  stockRouterAbi,
  sweepExecutorAbi,
  usdgParkAdapterAbi,
} from "../chain/abis.ts";
import { USDG } from "../chain/constants.ts";
import { keeperSwapsZeroForOne, type HookPin } from "../keeper/hooks.ts";
import type { Severity } from "./alerts.ts";
import type { MonitorBook } from "./config.ts";

export type BookKey =
  | "assetRegistry"
  | "ruleRegistry"
  | "electionRegistry"
  | "screeningGate"
  | "stockRouter"
  | "cashPark"
  | "feeVault"
  | "sweepExecutor"
  | "usdgParkAdapter"
  | "sgovParkAdapter";

export const CONTRACT_NAMES: Record<BookKey, string> = {
  assetRegistry: "AssetRegistry",
  ruleRegistry: "RuleRegistry",
  electionRegistry: "ElectionRegistry",
  screeningGate: "ScreeningGate",
  stockRouter: "StockRouter",
  cashPark: "CashPark",
  feeVault: "FeeVault",
  sweepExecutor: "SweepExecutor",
  usdgParkAdapter: "UsdgParkAdapter",
  sgovParkAdapter: "SgovParkAdapter",
};

export const CONTRACT_ABIS: Record<BookKey, Abi> = {
  assetRegistry: assetRegistryAbi,
  ruleRegistry: ruleRegistryAbi,
  electionRegistry: electionRegistryAbi,
  screeningGate: screeningGateAbi,
  stockRouter: stockRouterAbi,
  cashPark: cashParkAbi,
  feeVault: feeVaultAbi,
  sweepExecutor: sweepExecutorAbi,
  usdgParkAdapter: usdgParkAdapterAbi,
  sgovParkAdapter: sgovParkAdapterAbi,
};

/** Contracts that inherit SpareAuth (Ownable2Step + keeper + pauser). */
export const AUTH_CONTRACTS = [
  "assetRegistry",
  "electionRegistry",
  "screeningGate",
  "stockRouter",
  "cashPark",
  "feeVault",
  "sweepExecutor",
] as const satisfies readonly BookKey[];

export const TIMELOCK_ABI = [
  parseAbiItem("event CallScheduled(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data, bytes32 predecessor, uint256 delay)"),
  parseAbiItem("event CallExecuted(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data)"),
  parseAbiItem("event Cancelled(bytes32 indexed id)"),
  parseAbiItem("event MinDelayChange(uint256 oldDuration, uint256 newDuration)"),
  parseAbiItem("event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)"),
  parseAbiItem("event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender)"),
  parseAbiItem("event RoleAdminChanged(bytes32 indexed role, bytes32 indexed previousAdminRole, bytes32 indexed newAdminRole)"),
] as const;

export type Args = Record<string, unknown>;

export interface Verdict {
  severity: Severity;
  title: string;
  lines?: string[];
}

export interface DescribeCtx {
  book: MonitorBook;
  /** Display name of the emitting contract. */
  contract: string;
  /** `0xabc… (SweepExecutor)` for known addresses. */
  label: (a: unknown) => string;
  /** Best-effort token symbol, already resolved for this event's token args. */
  symbol: (a: unknown) => string;
  /** Decode a timelock call against the Spare ABIs. */
  call: (target: unknown, data: unknown) => string;
  /** Decode revert bytes (SwapDeferred.reason) to an error name. */
  reason: (data: unknown) => string;
}

type Describe = (a: Args, c: DescribeCtx) => Verdict;

const same = (a: unknown, b: Address | null | undefined) =>
  typeof a === "string" && !!b && a.toLowerCase() === b.toLowerCase();
const usdg = (v: unknown) => `$${formatUnits(BigInt(v as bigint), 6)}`;

/** SpareAuth + Ownable2Step: every owned contract emits these. */
const AUTH_EVENTS: Record<string, Describe> = {
  OwnershipTransferStarted: (a, c) => ({
    severity: "critical",
    title: `${c.contract}: ownership transfer STARTED ${c.label(a.previousOwner)} -> ${c.label(a.newOwner)}`,
    lines: ["takes effect when the new owner calls acceptOwnership(); the current owner can cancel with transferOwnership(currentOwner)"],
  }),
  OwnershipTransferred: (a, c) =>
    same(a.previousOwner, zeroAddress)
      ? { severity: "info", title: `${c.contract}: owner set at deploy to ${c.label(a.newOwner)}` }
      : {
          severity: same(a.newOwner, c.book.roles.owner) ? "warning" : "critical",
          title: `${c.contract}: owner is now ${c.label(a.newOwner)} (was ${c.label(a.previousOwner)})`,
        },
  KeeperSet: (a, c) => ({
    severity: a.enabled === true && !same(a.keeper, c.book.roles.keeper) ? "critical" : "warning",
    title: `${c.contract}: keeper ${c.label(a.keeper)} ${a.enabled === true ? "ENABLED" : "disabled"}`,
  }),
  PauserSet: (a, c) => ({
    severity: same(a.pauser, c.book.roles.pauser) ? "warning" : "critical",
    title: `${c.contract}: pauser set to ${c.label(a.pauser)}`,
  }),
  Paused: (a, c) => ({
    severity: "critical",
    title: `${c.contract}: PAUSED by ${c.label(a.by)}`,
    lines: ["new accruals / parks / sweeps stop; exit() and claim() stay open (they ignore pause)"],
  }),
  Unpaused: (a, c) => ({ severity: "warning", title: `${c.contract}: unpaused by ${c.label(a.by)}` }),
};

export interface ContractWatch {
  privileged: Record<string, Describe>;
  operational: Record<string, Describe>;
  activity: readonly string[];
}

export const WATCH: Record<BookKey, ContractWatch> = {
  assetRegistry: {
    privileged: {
      ...AUTH_EVENTS,
      AssetSet: (a, c) => ({
        severity: "warning",
        title: `AssetRegistry: ${c.symbol(a.token)} registered / re-pinned`,
        lines: [
          `token ${c.label(a.token)}`,
          `feed ${c.label(a.feed)}, heartbeat ${String(a.heartbeat)}s, band ${String(a.bandBps)} bps`,
          `poolId ${String(a.poolId)}`,
        ],
      }),
      AssetActive: (a, c) => ({
        severity: "warning",
        title: `AssetRegistry: ${c.symbol(a.token)} ${a.active === true ? "ACTIVATED" : "DEACTIVATED"}`,
        lines: [
          `token ${c.label(a.token)}`,
          ...(a.active === true ? [] : ["queued legs in this asset now safe-settle to USDG at the next sweep"]),
        ],
      }),
    },
    operational: {},
    activity: [],
  },
  ruleRegistry: {
    // No owner: linking and rules are each account's own action.
    privileged: {},
    operational: {},
    activity: ["Linked", "Unlinked"],
  },
  electionRegistry: {
    privileged: {
      ...AUTH_EVENTS,
      DefaultMixSet: (a, c) => {
        const legs = (a.legs as { asset: Address; bps: number }[] | undefined) ?? [];
        return {
          severity: "warning",
          title: `ElectionRegistry: default mix set (${legs.length} legs)`,
          lines: [legs.map((l) => `${c.symbol(l.asset)} ${Number(l.bps) / 100}%`).join(", ")],
        };
      },
    },
    operational: {},
    activity: [],
  },
  screeningGate: {
    privileged: {
      ...AUTH_EVENTS,
      AttestorSet: (a, c) => ({
        severity: same(a.attestor, c.book.roles.attestor) ? "warning" : "critical",
        title: `ScreeningGate: attestor set to ${c.label(a.attestor)}`,
      }),
      EnforcedSet: (a) => ({
        severity: "warning",
        title: `ScreeningGate: screening enforcement ${a.enforced === true ? "ON" : "OFF"}`,
        lines: [a.enforced === true ? "sweeps now skip accounts without a live clearance" : "every account is eligible to buy"],
      }),
      Revoked: (a, c) => ({ severity: "info", title: `ScreeningGate: clearance revoked for ${c.label(a.account)}` }),
    },
    operational: {},
    // Attestor clear() and users' own submitClearance(): routine screening, logged.
    activity: ["Cleared"],
  },
  stockRouter: {
    privileged: {
      ...AUTH_EVENTS,
      CallerSet: (a, c) => {
        const known = same(a.caller, c.book.sweepExecutor) || same(a.caller, c.book.sgovParkAdapter);
        return {
          severity: a.enabled === true && !known ? "critical" : "warning",
          title: `StockRouter: caller ${c.label(a.caller)} ${a.enabled === true ? "ENABLED" : "disabled"}`,
        };
      },
      SequencerFeedSet: (a, c) => ({ severity: "warning", title: `StockRouter: sequencer feed set to ${c.label(a.feed)}` }),
    },
    operational: {},
    activity: [],
  },
  cashPark: {
    privileged: {
      ...AUTH_EVENTS,
      ExecutorSet: (a, c) => ({
        severity: same(a.executor, c.book.sweepExecutor) ? "warning" : "critical",
        title: `CashPark: executor set to ${c.label(a.executor)}`,
        lines: same(a.executor, c.book.sweepExecutor)
          ? []
          : [`expected SweepExecutor ${c.book.sweepExecutor}: the executor can withdraw every account's parked USDG`],
      }),
      AdapterSet: (a, c) => {
        const known = same(a.adapter, c.book.usdgParkAdapter) || same(a.adapter, c.book.sgovParkAdapter);
        return { severity: known ? "warning" : "critical", title: `CashPark: park adapter set to ${c.label(a.adapter)}` };
      },
    },
    operational: {
      ExitUnitsKept: (a, c) => ({
        severity: "warning",
        title: `CashPark: exit kept ${String(a.units)} parked units for ${c.label(a.account)}`,
        lines: ["the adapter could neither redeem nor pay in kind; the user can call exit() again later"],
      }),
    },
    activity: ["Parked"],
  },
  feeVault: {
    privileged: {
      ...AUTH_EVENTS,
      Withdrawn: (a, c) => ({
        severity: "warning",
        title: `FeeVault: ${String(a.amount)} of ${c.symbol(a.token)} withdrawn to ${c.label(a.to)}`,
      }),
    },
    operational: {},
    activity: [],
  },
  sweepExecutor: {
    privileged: {
      ...AUTH_EVENTS,
      ParamsSet: (a) => ({
        severity: "warning",
        title: "SweepExecutor: params changed",
        lines: [
          `finalityBuffer ${String(a.finalityBuffer)} blocks, threshold ${usdg(a.threshold)}, fee ${String(a.feeBps)} bps, slippage ${String(a.slippageBps)} bps, epoch ${String(a.epochLength)}s`,
        ],
      }),
    },
    operational: {
      SwapDeferred: (a, c) => ({
        severity: "warning",
        title: `SweepExecutor: ${c.symbol(a.asset)} swap deferred (${usdg(a.usdg)} back to the park)`,
        lines: [`reason ${c.reason(a.reason)}`, "the USDG is retried at the next sweep; repeated deferrals mean a thin or moved pool"],
      }),
      DeliveryHeld: (a, c) => ({
        severity: "warning",
        title: `SweepExecutor: delivery of ${c.symbol(a.token)} to ${c.label(a.account)} held as claimable`,
      }),
    },
    activity: ["Accrued", "AccrualSkipped", "AccountSwept", "AssetSwept", "Deferred", "SafeSettled"],
  },
  // No owner, no events: only CashPark calls an adapter.
  usdgParkAdapter: { privileged: {}, operational: {}, activity: [] },
  sgovParkAdapter: { privileged: {}, operational: {}, activity: [] },
};

export const TIMELOCK_WATCH: ContractWatch = {
  privileged: {
    CallScheduled: (a, c) => ({
      severity: "critical",
      title: `Timelock: call SCHEDULED, executable in ${Number(a.delay as bigint) / 3600}h`,
      lines: [c.call(a.target, a.data), `id ${String(a.id)} #${String(a.index)}`, "cancel with Timelock.cancel(id) from a canceller if this is not ours"],
    }),
    CallExecuted: (a, c) => ({ severity: "warning", title: "Timelock: call EXECUTED", lines: [c.call(a.target, a.data), `id ${String(a.id)}`] }),
    Cancelled: (a) => ({ severity: "warning", title: "Timelock: operation cancelled", lines: [`id ${String(a.id)}`] }),
    MinDelayChange: (a) => ({
      severity: "critical",
      title: `Timelock: min delay ${Number(a.oldDuration as bigint) / 3600}h -> ${Number(a.newDuration as bigint) / 3600}h`,
    }),
    RoleGranted: (a, c) => ({ severity: "critical", title: `Timelock: role ${String(a.role).slice(0, 10)} GRANTED to ${c.label(a.account)} by ${c.label(a.sender)}` }),
    RoleRevoked: (a, c) => ({ severity: "critical", title: `Timelock: role ${String(a.role).slice(0, 10)} revoked from ${c.label(a.account)} by ${c.label(a.sender)}` }),
    RoleAdminChanged: (a) => ({
      severity: "critical",
      title: `Timelock: admin of role ${String(a.role).slice(0, 10)} changed to ${String(a.newAdminRole).slice(0, 10)}`,
    }),
  },
  operational: {},
  activity: [],
};

/** The ABI events a watch table names, taken from `abi` (throws if one is missing). */
export function eventsOf(abi: Abi, w: ContractWatch, label: string): AbiEvent[] {
  const names = [...Object.keys(w.privileged), ...Object.keys(w.operational), ...w.activity];
  return names.map((n) => {
    const ev = abi.find((x): x is AbiEvent => x.type === "event" && x.name === n);
    if (!ev) throw new Error(`${label} ABI has no event ${n}`);
    return ev;
  });
}

/** Union for one getLogs filter: one entry per topic0. */
export function uniqueEvents(events: readonly AbiEvent[]): AbiEvent[] {
  const m = new Map<string, AbiEvent>();
  for (const e of events) m.set(toEventSelector(e), e);
  return [...m.values()];
}

/**
 * The fee-setting events of the third-party hooks some assets swap through
 * (keeper/hooks.ts), verbatim from their Sourcify-verified sources:
 * FablesBaseHook (both hooks), FablesRWA's floors and market calendar,
 * FablesRamp's flat fee. Every one is indexed by PoolId, so the monitor asks
 * for the pinned pools' alone.
 */
export const HOOK_EVENTS_ABI = [
  parseAbiItem("event FeePoked(bytes32 indexed poolId, uint24 fee0For1, uint24 fee1For0, uint40 expiry)"),
  parseAbiItem("event PokeCleared(bytes32 indexed poolId)"),
  parseAbiItem("event PoolAsymmetrySet(bytes32 indexed poolId, uint24 premiumPips, bool premiumZeroForOne)"),
  parseAbiItem(
    "event PoolConfigured(bytes32 indexed poolId, (uint24 openFloor, uint24 overnightFloor, uint24 closedFloor, uint8 spikeMult, uint24 closedSpike, uint32 descentWindow, uint24 closeFloor, uint32 closeBefore, uint32 closeAfter) config, uint24 maxFee)",
  ),
  parseAbiItem("event DayOverridesSet(bytes32 indexed poolId, uint256 indexed yearMonth, uint64 packed)"),
  parseAbiItem("event SessionHoursSet(bytes32 indexed poolId, uint32 openSec, uint32 closeSec)"),
  parseAbiItem("event DstModeSet(bytes32 indexed poolId, uint8 mode)"),
  parseAbiItem("event EarlyCloseSet(bytes32 indexed poolId, uint256 y, uint256 m, uint256 d, uint32 closeSec)"),
  parseAbiItem("event PoolConfigured(bytes32 indexed poolId, uint24 floorPips, uint24 flatPips, uint24 maxFee)"),
] as const;

const pct = (pips: unknown) => `${(Number(pips) / 10_000).toFixed(2)}%`;

/**
 * The hooks' events, described against the pin of the pool they name. A
 * change that makes the keeper hold the asset (a poke above the pin's
 * ceiling on the keeper's side, a cap above the pinned one, a flat fee above
 * the ceiling) is critical; any other fee change is a warning, and a cleared
 * poke is information.
 */
export function hookWatch(pins: readonly HookPin[]): ContractWatch {
  const pinOf = (a: Args) => pins.find((p) => typeof a.poolId === "string" && p.poolId.toLowerCase() === a.poolId.toLowerCase());
  const name = (a: Args) => pinOf(a)?.symbol ?? `pool ${String(a.poolId)}`;
  const holds = (a: Args) => {
    const p = pinOf(a);
    return p ? `the keeper holds ${p.symbol} while its fee is above ${pct(p.hookMaxFeePips)} or its cap above ${pct(p.hookFeeCap)} (HOOK_PINS)` : "";
  };
  const configured = (a: Args, c: DescribeCtx): Verdict => {
    const p = pinOf(a);
    const cfg = a.config as Record<string, unknown> | undefined;
    const fees = cfg
      ? `open ${pct(cfg.openFloor)}, overnight ${pct(cfg.overnightFloor)}, closed ${pct(cfg.closedFloor)}, closing ramp ${pct(cfg.closeFloor)}, opening spike x${String(cfg.spikeMult)} / ${pct(cfg.closedSpike)} over ${String(cfg.descentWindow)}s`
      : `floor ${pct(a.floorPips)}, flat ${pct(a.flatPips)}`;
    const raised = !!p && (Number(a.maxFee) > p.hookFeeCap || (a.flatPips !== undefined && Number(a.flatPips) > p.hookMaxFeePips));
    return {
      severity: raised ? "critical" : "warning",
      title: `${c.contract}: ${name(a)} pool fees RE-CONFIGURED (cap ${pct(a.maxFee)})`,
      lines: [fees, holds(a)].filter(Boolean),
    };
  };
  return {
    privileged: {
      FeePoked: (a, c) => {
        const p = pinOf(a);
        const ours = p ? Number(keeperSwapsZeroForOne(p.token, USDG) ? a.fee0For1 : a.fee1For0) : 0;
        return {
          severity: p && ours > p.hookMaxFeePips ? "critical" : "warning",
          title: `${c.contract}: ${name(a)} pool fee POKED to ${pct(a.fee0For1)} (0->1) / ${pct(a.fee1For0)} (1->0) until ${new Date(Number(a.expiry) * 1000).toISOString()}`,
          lines: ["a side of 0.00% is not poked (it keeps the pool's own fee)", holds(a)].filter(Boolean),
        };
      },
      PokeCleared: (a, c) => ({ severity: "info", title: `${c.contract}: ${name(a)} pool fee poke cleared (back to its own fee)` }),
      PoolAsymmetrySet: (a, c) => ({
        severity: "warning",
        title: `${c.contract}: ${name(a)} pool premium set to ${pct(a.premiumPips)} on ${a.premiumZeroForOne === true ? "0->1" : "1->0"} swaps`,
        lines: [holds(a)].filter(Boolean),
      }),
      PoolConfigured: configured,
      DayOverridesSet: (a, c) => ({ severity: "warning", title: `${c.contract}: ${name(a)} market calendar overridden for ${String(a.yearMonth)}` }),
      SessionHoursSet: (a, c) => ({ severity: "warning", title: `${c.contract}: ${name(a)} session hours set to ${String(a.openSec)}s-${String(a.closeSec)}s ET` }),
      DstModeSet: (a, c) => ({ severity: "warning", title: `${c.contract}: ${name(a)} DST mode set to ${String(a.mode)}` }),
      EarlyCloseSet: (a, c) => ({
        severity: "warning",
        title: `${c.contract}: ${name(a)} early close ${String(a.y)}-${String(a.m)}-${String(a.d)} at ${String(a.closeSec)}s ET`,
      }),
    },
    operational: {},
    activity: [],
  };
}

/** One watch entry per hook the pins name, and the PoolIds to ask its logs for. */
export function hookContracts(pins: readonly HookPin[]): { watched: Watched[]; poolIds: Hex[] } {
  const byHook = new Map<string, HookPin[]>();
  for (const p of pins) byHook.set(p.hook.toLowerCase(), [...(byHook.get(p.hook.toLowerCase()) ?? []), p]);
  const watched = [...byHook.values()].map((ps) => ({
    key: "hook" as const,
    name: `Hook ${ps.map((p) => p.symbol).join("/")}`,
    address: getAddress(ps[0]!.hook),
    abi: HOOK_EVENTS_ABI as unknown as Abi,
    watch: hookWatch(ps),
  }));
  return { watched, poolIds: pins.map((p) => p.poolId) };
}

/**
 * The OpenZeppelin AccessManager the pinned hooks answer to (each pin's
 * hookAuthority), events verbatim from its Sourcify-verified source. Its roles
 * decide who can set the MU and GME pool fees (accepted risk A-L3), its target
 * settings which hook functions those roles reach and how long moving a hook
 * to another authority takes, and its operations what is queued to run on
 * them. The hookAuthority pin alone only catches a hook moved elsewhere; these
 * catch the changes made inside the same AccessManager.
 */
export const ACCESS_MANAGER_ABI = [
  parseAbiItem("event RoleGranted(uint64 indexed roleId, address indexed account, uint32 delay, uint48 since, bool newMember)"),
  parseAbiItem("event RoleRevoked(uint64 indexed roleId, address indexed account)"),
  parseAbiItem("event RoleGrantDelayChanged(uint64 indexed roleId, uint32 delay, uint48 since)"),
  parseAbiItem("event RoleAdminChanged(uint64 indexed roleId, uint64 indexed admin)"),
  parseAbiItem("event RoleGuardianChanged(uint64 indexed roleId, uint64 indexed guardian)"),
  parseAbiItem("event TargetFunctionRoleUpdated(address indexed target, bytes4 selector, uint64 indexed roleId)"),
  parseAbiItem("event TargetAdminDelayUpdated(address indexed target, uint32 delay, uint48 since)"),
  parseAbiItem("event TargetClosed(address indexed target, bool closed)"),
  parseAbiItem("event OperationScheduled(bytes32 indexed operationId, uint32 indexed nonce, uint48 schedule, address caller, address target, bytes data)"),
  parseAbiItem("event OperationExecuted(bytes32 indexed operationId, uint32 indexed nonce)"),
  parseAbiItem("event OperationCanceled(bytes32 indexed operationId, uint32 indexed nonce)"),
] as const;

const PUBLIC_ROLE = 2n ** 64n - 1n;
const roleName = (id: unknown) => {
  const r = BigInt(id as bigint);
  return r === 0n ? "ADMIN_ROLE" : r === PUBLIC_ROLE ? "PUBLIC_ROLE" : `role ${r}`;
};
const at = (since: unknown) => new Date(Number(since) * 1000).toISOString();

/**
 * Role changes concern every pinned hook the AccessManager governs: a new
 * member, a new role admin or a delay that lets a grant land sooner is
 * critical. Target settings and scheduled operations are critical only when
 * they name a pinned hook; for any other target they are information.
 */
export function accessManagerWatch(pins: readonly HookPin[]): ContractWatch {
  const hookOf = (t: unknown) => pins.filter((p) => typeof t === "string" && p.hook.toLowerCase() === t.toLowerCase());
  const which = (t: unknown, c: DescribeCtx) => {
    const ps = hookOf(t);
    return ps.length ? `the ${ps.map((p) => p.symbol).join("/")} hook` : c.label(t);
  };
  const governs = `it governs the fee setters of the ${pins.map((p) => p.symbol).join(" and ")} hooks (accepted risk A-L3)`;
  return {
    privileged: {
      RoleGranted: (a, c) =>
        a.newMember === true
          ? {
              severity: "critical",
              title: `${c.contract}: ${roleName(a.roleId)} GRANTED to ${c.label(a.account)} (execution delay ${String(a.delay)}s, from ${at(a.since)})`,
              lines: [`a new member of a role can change the pools' fees: ${governs}`],
            }
          : {
              severity: "warning",
              title: `${c.contract}: ${roleName(a.roleId)} execution delay of ${c.label(a.account)} set to ${String(a.delay)}s from ${at(a.since)}`,
            },
      RoleRevoked: (a, c) => ({ severity: "warning", title: `${c.contract}: ${roleName(a.roleId)} revoked from ${c.label(a.account)}` }),
      RoleGrantDelayChanged: (a, c) => ({
        severity: "critical",
        title: `${c.contract}: ${roleName(a.roleId)} grant delay set to ${String(a.delay)}s from ${at(a.since)}`,
        lines: [`how soon a new member of the role takes effect; ${governs}`],
      }),
      RoleAdminChanged: (a, c) => ({
        severity: "critical",
        title: `${c.contract}: admin of ${roleName(a.roleId)} is now ${roleName(a.admin)}`,
        lines: [governs],
      }),
      RoleGuardianChanged: (a, c) => ({ severity: "warning", title: `${c.contract}: guardian of ${roleName(a.roleId)} is now ${roleName(a.guardian)}` }),
      TargetFunctionRoleUpdated: (a, c) => ({
        severity: hookOf(a.target).length ? "critical" : "info",
        title: `${c.contract}: ${which(a.target, c)} function ${String(a.selector)} now needs ${roleName(a.roleId)}`,
      }),
      TargetAdminDelayUpdated: (a, c) => ({
        severity: hookOf(a.target).length ? "critical" : "info",
        title: `${c.contract}: admin delay of ${which(a.target, c)} set to ${String(a.delay)}s from ${at(a.since)}`,
        lines: hookOf(a.target).length ? ["the wait before the hook can be moved to another authority (pinned hookAuthority)"] : [],
      }),
      TargetClosed: (a, c) => ({
        severity: hookOf(a.target).length ? "warning" : "info",
        title: `${c.contract}: ${which(a.target, c)} ${a.closed === true ? "CLOSED (its restricted functions cannot be called)" : "reopened"}`,
      }),
      OperationScheduled: (a, c) => ({
        severity: hookOf(a.target).length ? "critical" : "info",
        title: `${c.contract}: operation SCHEDULED on ${which(a.target, c)} by ${c.label(a.caller)}, runnable from ${at(a.schedule)}`,
        lines: [`selector ${String(a.data).slice(0, 10)}`, `id ${String(a.operationId)} #${String(a.nonce)}`],
      }),
      OperationExecuted: (a, c) => ({ severity: "info", title: `${c.contract}: operation executed`, lines: [`id ${String(a.operationId)} #${String(a.nonce)}`] }),
      OperationCanceled: (a, c) => ({ severity: "info", title: `${c.contract}: operation canceled`, lines: [`id ${String(a.operationId)} #${String(a.nonce)}`] }),
    },
    operational: {},
    activity: [],
  };
}

/** One watch entry per AccessManager the pins name as their hooks' authority. */
export function hookAuthorityContracts(pins: readonly HookPin[]): Watched[] {
  const byAuthority = new Map<string, HookPin[]>();
  for (const p of pins) byAuthority.set(p.hookAuthority.toLowerCase(), [...(byAuthority.get(p.hookAuthority.toLowerCase()) ?? []), p]);
  return [...byAuthority.values()].map((ps) => ({
    key: "hookAuthority" as const,
    name: `AccessManager (${ps.map((p) => p.symbol).join("/")} hooks)`,
    address: getAddress(ps[0]!.hookAuthority),
    abi: ACCESS_MANAGER_ABI as unknown as Abi,
    watch: accessManagerWatch(ps),
  }));
}

export interface Watched {
  key: BookKey | "timelock" | "hook" | "hookAuthority";
  name: string;
  address: Address;
  abi: Abi;
  watch: ContractWatch;
}

/** Every contract in the book (plus the timelock, if configured) with its table. */
export function watchedContracts(book: MonitorBook, timelock: Address | undefined): Watched[] {
  const out: Watched[] = [];
  for (const key of Object.keys(WATCH) as BookKey[]) {
    const address = book[key];
    if (!address) continue;
    out.push({ key, name: CONTRACT_NAMES[key], address: getAddress(address), abi: CONTRACT_ABIS[key], watch: WATCH[key] });
  }
  if (timelock) out.push({ key: "timelock", name: "Timelock", address: getAddress(timelock), abi: TIMELOCK_ABI as unknown as Abi, watch: TIMELOCK_WATCH });
  return out;
}
