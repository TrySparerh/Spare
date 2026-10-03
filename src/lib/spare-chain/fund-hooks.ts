/**
 * useFundTx — the write pipeline for Fund Wallet's raw router transactions.
 *
 * Same contract as hooks.ts useSpareTx (switch to 4663 -> simulate -> sign -> wait for
 * the receipt, steps run in order, any failure stops the queue, TxState drives the
 * shared <TxStatus>), but each step is a prebuilt {to, data, value} — the Universal
 * Router's execute() calldata comes from fund-swap.ts builders — and reverts are decoded
 * against the router / v4 / Permit2 errors (fund-errors.ts).
 *
 * Steps are built LAZILY, right before they are simulated, so a swap queued behind
 * approvals gets a fresh deadline and a Permit2 expiry measured from when it is sent.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAccount, usePublicClient, useSendTransaction, useSwitchChain } from 'wagmi';
import type { Hash } from 'viem';
import { SPARE_CHAIN_ID } from './addresses';
import { invalidateSpareReads, type TxState } from './hooks';
import { humanizeFundError, type FundErrorContext } from './fund-errors';
import type { SwapTx } from './fund-swap';
import { getT } from '@/i18n';

const chainId = SPARE_CHAIN_ID;
// Status-line errors, in the live language (apps-a `fundTx.*`).
const tf = getT('apps-a');

export interface FundStep {
  /** Shown in the status line, e.g. "Swap 0.01 ETH → USDG". */
  label: string;
  /** Called right before the step is simulated. */
  build: () => SwapTx | Promise<SwapTx>;
  /** Units for decoded slippage errors. */
  errorContext?: FundErrorContext;
}

const IDLE: TxState = { phase: 'idle', label: '', step: 0, steps: 0 };

export function useFundTx() {
  const { address, chainId: walletChainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { sendTransactionAsync } = useSendTransaction();
  const client = usePublicClient({ chainId });
  const queryClient = useQueryClient();

  const [state, setState] = useState<TxState>(IDLE);
  // Each run gets an id; reset() or a newer run makes older runs stop touching state.
  const runId = useRef(0);
  useEffect(() => () => {
    runId.current += 1;
  }, []);

  const run = useCallback(
    async (steps: FundStep[], done?: (hash: Hash) => void) => {
      if (steps.length === 0) return;
      const id = ++runId.current;
      const live = () => runId.current === id;
      let onChain = walletChainId === chainId;

      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        const base = { label: step.label, step: i + 1, steps: steps.length };
        if (!address || !client) {
          setState({ ...base, phase: 'error', error: tf('fundTx.connectFirst') });
          return;
        }
        let hash: Hash | undefined;
        try {
          if (!onChain) {
            setState({ ...base, phase: 'switching' });
            await switchChainAsync({ chainId });
            onChain = true;
            if (!live()) return;
          }
          setState({ ...base, phase: 'checking' });
          const tx = await step.build();
          // Simulate against our own RPC first: a revert comes back decoded (slippage,
          // missing allowance, deadline) instead of as a wallet's opaque gas failure.
          await client.call({ account: address, to: tx.to, data: tx.data, value: tx.value });
          if (!live()) return;
          setState({ ...base, phase: 'wallet' });
          hash = await sendTransactionAsync({ account: address, chainId, to: tx.to, data: tx.data, value: tx.value } as Parameters<typeof sendTransactionAsync>[0]);
          if (!live()) return;
          setState({ ...base, phase: 'pending', hash });
          const receipt = await client.waitForTransactionReceipt({ hash });
          void invalidateSpareReads(queryClient);
          if (!live()) return;
          if (receipt.status !== 'success') {
            setState({ ...base, phase: 'error', hash, error: tf('fundTx.revertedOnChain') });
            return;
          }
          if (i === steps.length - 1) {
            setState({ ...base, phase: 'confirmed', hash });
            done?.(hash);
          }
        } catch (e) {
          if (live()) setState({ ...base, phase: 'error', hash, error: humanizeFundError(e, step.errorContext) });
          return;
        }
      }
    },
    [address, walletChainId, switchChainAsync, sendTransactionAsync, client, queryClient],
  );

  const reset = useCallback(() => {
    runId.current += 1;
    setState(IDLE);
  }, []);

  const busy = state.phase === 'switching' || state.phase === 'checking' || state.phase === 'wallet' || state.phase === 'pending';

  return { state, run, reset, busy };
}
