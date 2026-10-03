import { z } from "zod";
import { getAddress, type Address } from "viem";

/** A non-zero EVM address, normalised to its EIP-55 checksum. */
export const AddressInput = z
  .string()
  .trim()
  .regex(/^0x[0-9a-fA-F]{40}$/, "expected a 0x-prefixed 20-byte address")
  .refine((v) => !/^0x0{40}$/i.test(v), "the zero address is not an account")
  .transform((v) => getAddress(v) as Address);

export const AccountInput = z.object({ account: AddressInput });

/** Keyset cursor "<blockNumber>:<logIndex>" for newest-first paging. */
export const PageCursor = z
  .string()
  .regex(/^\d{1,20}:\d{1,9}$/, "cursor must be <block>:<logIndex>")
  .transform((v) => {
    const [b, l] = v.split(":");
    return { block: BigInt(b!), logIndex: Number(l) };
  });

export function encodeCursor(block: bigint, logIndex: number): string {
  return `${block}:${logIndex}`;
}

export const lc = (a: string) => a.toLowerCase();
