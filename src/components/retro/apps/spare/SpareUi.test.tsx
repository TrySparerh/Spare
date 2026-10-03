import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { setLanguage } from '@/i18n';
import { SPARE } from '@/lib/spare-chain/addresses';
import { DeployingNotice, SpendingWalletNotice, TxStatus } from './SpareUi';

const ME = '0x1111111111111111111111111111111111111111';
const ACCOUNT = '0x2222222222222222222222222222222222222222';

afterEach(async () => {
  await act(() => setLanguage('en'));
  localStorage.clear();
});

describe('Spare kit in every language', () => {
  it('keeps the spending-wallet sentence and its three address links across languages', async () => {
    const { container } = render(<SpendingWalletNotice me={ME} account={ACCOUNT} what="stock mix" />);
    const p = container.querySelector('p') as HTMLElement;
    expect(p.textContent).toBe(
      'This wallet (0x1111…1111) is a linked spending wallet that feeds account 0x2222…2222. Its payments round up into that account, so the stock mix shown here belong to that account and are read-only — connect 0x2222…2222 to change them.',
    );
    expect(p.querySelectorAll('a')).toHaveLength(3);
    expect(p.querySelector('strong')?.textContent).toBe('spending wallet');

    await act(() => setLanguage('zh-CN'));
    expect(p.textContent).toContain('是绑定到账户 0x2222…2222 的消费钱包');
    expect(p.querySelector('strong')?.textContent).toBe('消费钱包');
    expect(p.querySelectorAll('a')).toHaveLength(3);
    expect(container.textContent).toContain('只读');

    await act(() => setLanguage('zh-TW'));
    expect(p.querySelector('strong')?.textContent).toBe('消費錢包');
    expect(container.textContent).toContain('唯讀');
  });

  it('links SweepExecutor inside the translated deploying notice', async () => {
    const { container } = render(<DeployingNotice checking={false} error={null} />);
    const link = () => container.querySelector('a') as HTMLAnchorElement;
    expect(container.textContent).toContain('It switches on by itself once SweepExecutor has code at ');
    expect(link().title).toBe(SPARE.SweepExecutor);
    await act(() => setLanguage('zh-CN'));
    expect(container.textContent).toContain('Spare 合约正在部署到 Robinhood Chain。');
    expect(link().title).toBe(SPARE.SweepExecutor);
  });

  it('formats the multi-step write line with the right punctuation', async () => {
    const state = { phase: 'wallet' as const, label: 'Save rule', step: 1, steps: 2 };
    const { container } = render(<TxStatus state={state} />);
    expect(container.textContent).toContain('Save rule (step 1 of 2): Confirm in your wallet…');
    await act(() => setLanguage('zh-CN'));
    expect(container.textContent).toContain('Save rule（第 1 步，共 2 步）：请在钱包中确认…');
  });
});
