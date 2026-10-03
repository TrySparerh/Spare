import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// No chain and no API in this file: the boot checks fail fast and quietly.
vi.mock('wagmi/actions', () => ({ getPublicClient: () => undefined }));
vi.mock('@/lib/wagmi', () => ({ wagmiConfig: {} }));

import { BiosScreen } from './BiosScreen';
import { PHONE_SPLINE_VIEWER } from '@/lib/mobileScenes';

const viewerScripts = () => [...document.querySelectorAll('script')].filter((s) => s.src.includes('spline-viewer')).map((s) => s.src);

/** matchMedia with a phone breakpoint that can move after load. */
function liveEnv(phone: boolean) {
  const listeners = new Set<() => void>();
  let isPhone = phone;
  window.matchMedia = ((query: string) => ({
    get matches() {
      return query.includes('max-width: 767px') ? isPhone : false;
    },
    media: query,
    onchange: null,
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  return (next: boolean) => {
    isPhone = next;
    act(() => listeners.forEach((fn) => fn()));
  };
}

function fakeRuntime(viewer: Element) {
  const app = { stop: vi.fn(), play: vi.fn(), dispose: vi.fn() };
  Object.assign(viewer, { _spline: app, _loaded: true });
  return app;
}

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('offline'))));
});

afterEach(() => {
  cleanup();
  document.querySelectorAll('script').forEach((s) => s.remove());
  vi.unstubAllGlobals();
  delete (window as unknown as { matchMedia?: unknown }).matchMedia;
});

describe('BiosScreen Spline scene', () => {
  it('stops and disposes the boot scene when the boot screen closes', () => {
    liveEnv(false);
    const { container, unmount } = render(<BiosScreen onContinue={() => undefined} />);
    const viewer = container.querySelector('[data-bios-spline] spline-viewer') as HTMLElement;
    expect(viewer).not.toBeNull();
    const app = fakeRuntime(viewer);
    unmount();
    expect(app.stop).toHaveBeenCalledTimes(1);
    expect(app.dispose).toHaveBeenCalledTimes(1);
    expect(viewer.parentNode).toBeNull();
  });

  it('disposes the 16:9 scene when the window narrows to phone width', () => {
    const setPhone = liveEnv(false);
    const { container } = render(<BiosScreen onContinue={() => undefined} />);
    const app = fakeRuntime(container.querySelector('[data-bios-spline] spline-viewer') as HTMLElement);
    setPhone(true);
    expect(app.dispose).toHaveBeenCalledTimes(1);
  });

  it('loaded at phone width, then widened: the phone viewer serves the 16:9 scene, no second viewer script', () => {
    const setPhone = liveEnv(true);
    const { container } = render(<BiosScreen onContinue={() => undefined} />);
    expect(viewerScripts()).toEqual([PHONE_SPLINE_VIEWER]);
    setPhone(false);
    expect(container.querySelector('[data-bios-spline] spline-viewer')).not.toBeNull();
    expect(viewerScripts()).toEqual([PHONE_SPLINE_VIEWER]);
  });
});
