/**
 * The read budget prices spare_roundup_preview from the same argument the
 * handler acts on: a call is charged the replay price exactly when it replays
 * a wallet's payments from the chain.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const replays = vi.hoisted(() => ({ n: 0 }));
vi.mock('./replay.js', () => ({
  MAX_REPLAY_DAYS: 30,
  replayRoundUps: async () => {
    replays.n++;
    return { mode: 'wallet' };
  },
}));

import { SPARE_ENGINE_TOOLS, clearSpareCaches } from './tools.js';
import { ROUNDUP_REPLAY_COST, toolCost } from './budget.js';

const roundup = SPARE_ENGINE_TOOLS.find((t) => t.name === 'spare_roundup_preview')!;
const ADDR = '0x7e57000000000000000000000000000000000001';

beforeEach(() => {
  clearSpareCaches();
  replays.n = 0;
});

describe('spare_roundup_preview: budget price matches what the handler does', () => {
  const cases: Array<Record<string, unknown>> = [
    { amountUsd: '3.75' },
    { wallet: ADDR },
    { address: ADDR },
    { account: ADDR },
    { wallet: '', address: ADDR },
    { wallet: null, account: ADDR },
    { wallet: '', address: '', account: '', amountUsd: '3.75' },
    { amounts: '3.75,12.40', wallet: '' },
  ];

  for (const args of cases) {
    it(JSON.stringify(args), async () => {
      await roundup.handler({ ...args });
      const replayed = replays.n === 1;
      expect(toolCost('spare_roundup_preview', args)).toBe(replayed ? ROUNDUP_REPLAY_COST : 1);
    });
  }

  it('wallet= beside an address is a replay, so it is charged as one', async () => {
    await roundup.handler({ wallet: '', address: ADDR });
    expect(replays.n).toBe(1);
    expect(toolCost('spare_roundup_preview', { wallet: '', address: ADDR })).toBe(ROUNDUP_REPLAY_COST);
  });
});
