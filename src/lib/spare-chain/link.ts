/**
 * Two-step wallet linking (RuleRegistry.linkWallet).
 *
 *   1. Connected as the SPENDING wallet: sign EIP-712
 *      Link(address account, address wallet, uint256 nonce, uint256 deadline)
 *      naming the investing account. nonce = RuleRegistry.nonces(wallet).
 *   2. Switch to the ACCOUNT wallet: submit linkWallet(wallet, deadline, sig).
 *      The contract hashes with msg.sender as `account`, so only the named
 *      account can ever use the signature.
 *
 * Between the two steps the signed handoff waits in this browser's
 * localStorage (both wallets must be used from the same browser). It is not a
 * secret — it is useless to anyone but the named account — but a wallet can
 * still kill it on-chain with RuleRegistry.invalidateNonce().
 */
import { getAddress, maxUint160, type Address, type Hex } from 'viem';
import { SPARE, SPARE_CHAIN_ID, sameAddress } from './addresses';

/** How long a link signature stays valid. Long enough to switch wallets. */
export const LINK_DEADLINE_SECONDS = 60 * 60;

/** Permit2 allowance granted to SweepExecutor: unlimited amount, one year. */
export const PERMIT2_AMOUNT = maxUint160;
export const PERMIT2_TTL_SECONDS = 365 * 24 * 60 * 60;

export const LINK_TYPES = {
  Link: [
    { name: 'account', type: 'address' },
    { name: 'wallet', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const;

export const LINK_DOMAIN = {
  name: 'SPARE RuleRegistry',
  version: '1',
  chainId: SPARE_CHAIN_ID,
  verifyingContract: SPARE.RuleRegistry,
} as const;

export function linkTypedData(account: Address, wallet: Address, nonce: bigint, deadline: bigint) {
  return {
    domain: LINK_DOMAIN,
    types: LINK_TYPES,
    primaryType: 'Link' as const,
    message: { account, wallet, nonce, deadline },
  };
}

export interface PendingLink {
  account: Address;
  wallet: Address;
  nonce: bigint;
  deadline: bigint;
  signature: Hex;
  createdAt: number;
}

const KEY = 'spare.pendingLinks.v1';

interface StoredLink {
  account: string;
  wallet: string;
  nonce: string;
  deadline: string;
  signature: string;
  createdAt: number;
}

export function loadPendingLinks(): PendingLink[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const list = JSON.parse(raw) as StoredLink[];
    if (!Array.isArray(list)) return [];
    return list.flatMap((s) => {
      try {
        return [{
          account: getAddress(s.account),
          wallet: getAddress(s.wallet),
          nonce: BigInt(s.nonce),
          deadline: BigInt(s.deadline),
          signature: s.signature as Hex,
          createdAt: Number(s.createdAt) || 0,
        }];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

export function savePendingLinks(list: PendingLink[]): void {
  try {
    const stored: StoredLink[] = list.map((p) => ({
      account: p.account,
      wallet: p.wallet,
      nonce: p.nonce.toString(),
      deadline: p.deadline.toString(),
      signature: p.signature,
      createdAt: p.createdAt,
    }));
    localStorage.setItem(KEY, JSON.stringify(stored));
  } catch {
    /* storage unavailable — the handoff lives only in memory this session */
  }
}

/** Replace any older handoff for the same (account, wallet) pair; drop expired ones. */
export function upsertPendingLink(list: PendingLink[], next: PendingLink, nowSec: number): PendingLink[] {
  return [
    ...list.filter(
      (p) => p.deadline > BigInt(nowSec) && !(sameAddress(p.account, next.account) && sameAddress(p.wallet, next.wallet)),
    ),
    next,
  ];
}

export function removePendingLink(list: PendingLink[], account: string, wallet: string): PendingLink[] {
  return list.filter((p) => !(sameAddress(p.account, account) && sameAddress(p.wallet, wallet)));
}
