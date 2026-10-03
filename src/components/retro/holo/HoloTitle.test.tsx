import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { HoloTitle } from './HoloTitle';

/** Text + number of isolated decimal points in the outline copy and the fill copy. */
function copies(ui: JSX.Element) {
  const { container } = render(ui);
  const base = container.querySelector('.holo-title__base') as HTMLElement;
  const fill = container.querySelector('.holo-title__fill') as HTMLElement;
  return {
    baseText: base.textContent,
    fillText: fill.textContent,
    baseDots: base.querySelectorAll('.holo-title__dot').length,
    fillDots: fill.querySelectorAll('.holo-title__dot').length,
  };
}

describe('HoloTitle money numerals', () => {
  it('isolates the decimal point in both copies without changing the text', () => {
    const c = copies(<HoloTitle>$5.00</HoloTitle>);
    expect(c.baseText).toBe('$5.00');
    expect(c.fillText).toBe('$5.00');
    expect(c.baseDots).toBe(1);
    expect(c.fillDots).toBe(1);
  });

  it('handles thousands separators, numbers, arrays and fragments', () => {
    expect(copies(<HoloTitle>$1,234.56</HoloTitle>).baseDots).toBe(1);
    expect(copies(<HoloTitle>{0.25}</HoloTitle>).baseDots).toBe(1);
    const arr = copies(<HoloTitle>{['$', '20.00', ' · ', '1.5x']}</HoloTitle>);
    expect(arr.baseText).toBe('$20.00 · 1.5x');
    expect(arr.baseDots).toBe(2);
    expect(copies(<HoloTitle><>$0.25</></HoloTitle>).baseDots).toBe(1);
  });

  it('leaves dots that are not decimal points alone', () => {
    expect(copies(<HoloTitle>Spare.</HoloTitle>).baseDots).toBe(0);
    expect(copies(<HoloTitle>.5 and 5.</HoloTitle>).baseDots).toBe(0);
    expect(copies(<HoloTitle>5/5</HoloTitle>).baseDots).toBe(0);
  });
});

describe('HoloTitle Chinese runs', () => {
  it('wraps each CJK run in both copies and keeps the text', () => {
    const { container } = render(<HoloTitle>欢迎来到 Spare $5.00，现在开始</HoloTitle>);
    const base = container.querySelector('.holo-title__base') as HTMLElement;
    const fill = container.querySelector('.holo-title__fill') as HTMLElement;
    expect(base.textContent).toBe('欢迎来到 Spare $5.00，现在开始');
    expect(fill.textContent).toBe(base.textContent);
    expect([...base.querySelectorAll('.holo-title__cjk')].map((n) => n.textContent)).toEqual(['欢迎来到', '，现在开始']);
    expect(fill.querySelectorAll('.holo-title__cjk')).toHaveLength(2);
    expect(base.querySelectorAll('.holo-title__dot')).toHaveLength(1);
  });

  it('adds nothing to English titles', () => {
    const { container } = render(<HoloTitle>Welcome to Spare</HoloTitle>);
    expect(container.querySelector('.holo-title__cjk')).toBeNull();
    expect((container.querySelector('.holo-title__base') as HTMLElement).innerHTML).toBe('Welcome to Spare');
  });
});
