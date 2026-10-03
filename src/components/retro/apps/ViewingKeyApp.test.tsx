import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { setLanguage } from '@/i18n';
import { ViewingKeyApp } from './ViewingKeyApp';

afterEach(async () => {
  cleanup();
  await act(() => setLanguage('en'));
  localStorage.clear();
});

describe('ViewingKeyApp (S2 preview)', () => {
  it('opens with the preview banner, ahead of everything else', () => {
    const { container } = render(<ViewingKeyApp />);
    expect(screen.getByText('Preview · not live')).toBeInTheDocument();
    expect(screen.getByText(/^Nothing is routed privately yet\./)).toBeInTheDocument();
    const text = container.textContent ?? '';
    expect(text.indexOf('Preview · not live')).toBeLessThan(text.indexOf('Read this first'));
  });

  it('the route switch only changes the picture: nothing is saved', () => {
    localStorage.clear();
    render(<ViewingKeyApp />);
    fireEvent.click(screen.getByRole('radio', { name: 'Private (not built)' }));
    expect(screen.getByRole('radio', { name: 'Private (not built)' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText(/^Preview only\./)).toBeInTheDocument();
    expect(localStorage.length).toBe(0);
  });

  it('shows the banner in both Chinese variants', async () => {
    render(<ViewingKeyApp />);
    await act(() => setLanguage('zh-CN'));
    expect(screen.getByText('预览 · 尚未上线')).toBeInTheDocument();
    await act(() => setLanguage('zh-TW'));
    expect(screen.getByText('預覽 · 尚未上線')).toBeInTheDocument();
  });
});
