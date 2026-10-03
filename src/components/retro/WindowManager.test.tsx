import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { WindowManagerProvider, useWindowManager, type AppDescriptor } from './WindowManager';

const Null = () => null as unknown as JSX.Element;

function app(id: string, extra: Partial<AppDescriptor> = {}): AppDescriptor {
  return { id, title: id, iconLetter: id[0], component: Null, ...extra };
}

function setViewport(width: number, height: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
}

function mount(apps: AppDescriptor[], initiallyOpen: string[] = []) {
  let api: ReturnType<typeof useWindowManager> | null = null;
  function Probe() {
    api = useWindowManager();
    return null;
  }
  render(
    <WindowManagerProvider apps={apps} initiallyOpen={initiallyOpen}>
      <Probe />
    </WindowManagerProvider>,
  );
  return () => api as unknown as ReturnType<typeof useWindowManager>;
}

/** On screen: clear of the 34px ticker and the 44px taskbar, inside the right edge. */
function expectOnScreen(w: { position: { left: number; top: number }; size: { width: number; height: number } }, vw: number, vh: number) {
  expect(w.position.left).toBeGreaterThanOrEqual(0);
  expect(w.position.top).toBeGreaterThanOrEqual(34);
  expect(w.position.left + w.size.width).toBeLessThanOrEqual(vw);
  expect(w.position.top + w.size.height).toBeLessThanOrEqual(vh - 44);
}

afterEach(() => setViewport(1024, 768));

describe('WindowManager placement', () => {
  it('fits a window that opens on boot into a smaller viewport', () => {
    setViewport(1280, 720);
    const wm = mount([app('rules', { defaultSize: { width: 760, height: 660 }, defaultPosition: { left: 180, top: 90 } })], ['rules']);
    expectOnScreen(wm().windows.rules, 1280, 720);
  });

  it('keeps late registry entries out of the bottom-right clamp', () => {
    setViewport(1280, 800);
    const apps = Array.from({ length: 21 }, (_, i) => app(`a${i}`, { defaultSize: { width: 520, height: 360 } }));
    const wm = mount(apps);
    const first = wm().windows.a0.position;
    const late = wm().windows.a20.position; // 20 % 6 = 2 steps down the cascade
    expect(late.left - first.left).toBe(56);
    expect(late.top - first.top).toBe(56);
  });

  it('re-fits open windows when the viewport shrinks', () => {
    setViewport(1600, 1000);
    const wm = mount([app('big', { defaultSize: { width: 800, height: 600 }, defaultPosition: { left: 700, top: 300 } })]);
    act(() => wm().openApp('big'));
    expectOnScreen(wm().windows.big, 1600, 1000);
    act(() => {
      setViewport(1024, 700);
      window.dispatchEvent(new Event('resize'));
    });
    expectOnScreen(wm().windows.big, 1024, 700);
  });
});

describe('WindowManager z-order', () => {
  it('never climbs above the ceiling, however often windows are focused', () => {
    const wm = mount([app('a'), app('b'), app('c')]);
    act(() => {
      wm().openApp('a');
      wm().openApp('b');
      wm().openApp('c');
    });
    const order = ['a', 'b', 'c'];
    for (let i = 0; i < 300; i++) {
      act(() => wm().focusApp(order[i % 3]));
    }
    const zs = Object.values(wm().windows).map((w) => w.zIndex);
    expect(Math.max(...zs)).toBeLessThanOrEqual(90);
    expect(Math.min(...zs)).toBeGreaterThan(20);
    // the last focus wins, and the stack order is preserved through renumbering
    expect(wm().focusedId).toBe(order[299 % 3]);
    expect(wm().windows.b.zIndex).toBeLessThan(wm().windows.c.zIndex);
  });
});
