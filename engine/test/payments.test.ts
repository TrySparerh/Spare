import { describe, expect, test } from "bun:test";
import { makeClassifier, pricePayment } from "../src/lib/payments.ts";
import { VENUE } from "../src/chain/constants.ts";

const account = "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa";
const w1 = "0x1111111111111111111111111111111111111111";
const w2 = "0x2222222222222222222222222222222222222222";
const spare = "0x5555555555555555555555555555555555555555";
const merchant = "0x9999999999999999999999999999999999999999";

const c = makeClassifier({
  account,
  linkedWallets: [w1, w2],
  spareContracts: [spare],
  venue: Object.values(VENUE),
});

describe("what counts as a payment (§3.2)", () => {
  test("a transfer to a merchant is a payment", () => {
    expect(c.classify(merchant)).toBeNull();
  });
  test("to another linked wallet (or itself) is not", () => {
    expect(c.classify(w2)).toBe("to-linked-wallet");
    expect(c.classify(w1)).toBe("to-linked-wallet");
  });
  test("to the account itself is not", () => {
    expect(c.classify(account.toLowerCase())).toBe("to-account");
  });
  test("to a SPARE contract is not", () => {
    expect(c.classify(spare)).toBe("to-spare-contract");
  });
  test("into the v4 PoolManager (every allowlisted swap settles there) is not", () => {
    expect(c.classify("0x8366A39CC670B4001A1121B8F6A443A643E40951")).toBe("to-venue");
    expect(c.classify(VENUE.swapRouter02)).toBe("to-venue");
  });
  test("a burn is not (engine decision: under-accrue when in doubt)", () => {
    expect(c.classify("0x0000000000000000000000000000000000000000")).toBe("to-zero-address");
  });
  test("matching is case-insensitive", () => {
    expect(c.classify(w2.toUpperCase().replace("0X", "0x"))).toBe("to-linked-wallet");
  });
});

describe("pricePayment", () => {
  test("eligible payments are priced with the rule", () => {
    expect(pricePayment({ from: w1, to: merchant, amount: 3_750_000n }, c, 1, 3)).toEqual({ excludedReason: null, delta: 750_000n });
  });
  test("excluded payments accrue nothing", () => {
    expect(pricePayment({ from: w1, to: w2, amount: 3_750_000n }, c, 1, 3)).toEqual({ excludedReason: "to-linked-wallet", delta: 0n });
  });
});
