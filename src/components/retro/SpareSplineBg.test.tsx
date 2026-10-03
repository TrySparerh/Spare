import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SpareSplineBg } from './SpareSplineBg';
import { PHONE_SPLINE_VIEWER } from '@/lib/mobileScenes';

const DESKTOP_SCENE = 'https://prod.spline.design/desktop/scene.splinecode';
const PHONE_SCENE = 'https://prod.spline.design/phone/scene.splinecode';
const VIDEO = '/brand/mobile/login-mobile.mp4';
const POSTER = '/brand/mobile/login-mobile.jpg';

function setEnv({ phone, reducedMotion = false }: { phone: boolean; reducedMotion?: boolean }) {
  window.matchMedia = ((query: string) => ({
    matches: query.includes('max-width: 767px') ? phone : query.includes('prefers-reduced-motion: reduce') ? reducedMotion : false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

const viewerScripts = () => [...document.querySelectorAll('script')].filter((s) => s.src.includes('spline-viewer'));

/** Like setEnv, but the phone breakpoint can change after load (a resized window, a rotated tablet). */
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

/** What the 2.x viewer hangs on the element once it starts loading a scene. */
function fakeRuntime(viewer: Element, loaded: boolean) {
  const app = { stop: vi.fn(), play: vi.fn(), dispose: vi.fn() };
  Object.assign(viewer, { _spline: app, _loaded: loaded });
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
  HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
  HTMLMediaElement.prototype.pause = vi.fn();
});

afterEach(() => {
  cleanup();
  viewerScripts().forEach((s) => s.remove());
  vi.unstubAllGlobals();
  delete (navigator as unknown as { connection?: unknown }).connection;
  delete (window as unknown as { matchMedia?: unknown }).matchMedia;
});

describe('SpareSplineBg teardown', () => {
  it('desktop: leaving the screen stops and disposes the scene runtime and drops the viewer', () => {
    setEnv({ phone: false });
    const { container, unmount } = render(<SpareSplineBg url={DESKTOP_SCENE} marker="data-login-spline" />);
    const viewer = container.querySelector('spline-viewer') as HTMLElement;
    const app = fakeRuntime(viewer, true);
    unmount();
    expect(app.stop).toHaveBeenCalledTimes(1);
    expect(app.dispose).toHaveBeenCalledTimes(1);
    expect(viewer.isConnected).toBe(false);
    expect(viewer.parentNode).toBeNull();
  });

  it('phone: the portrait scene is torn down the same way', () => {
    setEnv({ phone: true });
    const { container, unmount } = render(
      <SpareSplineBg url={DESKTOP_SCENE} marker="data-login-spline" mobileUrl={PHONE_SCENE} mobilePoster={POSTER} />,
    );
    const app = fakeRuntime(container.querySelector('spline-viewer') as HTMLElement, true);
    unmount();
    expect(app.dispose).toHaveBeenCalledTimes(1);
  });

  it('a scene still streaming in is disposed when it lands, after the viewer has handled it', async () => {
    setEnv({ phone: false });
    const { container, unmount } = render(<SpareSplineBg url={DESKTOP_SCENE} marker="data-login-spline" />);
    const viewer = container.querySelector('spline-viewer') as HTMLElement;
    const app = fakeRuntime(viewer, false);
    unmount();
    // Disposing mid-parse does not stop the runtime (it starts its loop anyway), so it waits.
    expect(app.dispose).not.toHaveBeenCalled();
    viewer.dispatchEvent(new CustomEvent('load-complete'));
    expect(app.dispose).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(app.stop).toHaveBeenCalledTimes(1);
    expect(app.dispose).toHaveBeenCalledTimes(1);
  });

  it('a re-render keeps the live scene running', () => {
    setEnv({ phone: false });
    const { container, rerender } = render(<SpareSplineBg url={DESKTOP_SCENE} marker="data-login-spline" zIndex={0} />);
    const app = fakeRuntime(container.querySelector('spline-viewer') as HTMLElement, true);
    rerender(<SpareSplineBg url={DESKTOP_SCENE} marker="data-login-spline" zIndex={1} />);
    expect(app.stop).not.toHaveBeenCalled();
    expect(app.dispose).not.toHaveBeenCalled();
  });

  it('crossing the phone breakpoint swaps scenes and disposes the one that left', () => {
    const setPhone = liveEnv(true);
    const { container } = render(
      <SpareSplineBg url={DESKTOP_SCENE} marker="data-login-spline" mobileUrl={PHONE_SCENE} mobilePoster={POSTER} />,
    );
    const phoneApp = fakeRuntime(container.querySelector('spline-viewer') as HTMLElement, true);
    setPhone(false);
    expect(container.querySelector('spline-viewer')?.getAttribute('url')).toBe(DESKTOP_SCENE);
    expect(phoneApp.dispose).toHaveBeenCalledTimes(1);
  });
});

describe('SpareSplineBg viewer script', () => {
  it('a page loaded at phone width and then widened injects no second viewer', () => {
    const setPhone = liveEnv(true);
    const { container } = render(
      <SpareSplineBg url={DESKTOP_SCENE} marker="data-login-spline" mobileUrl={PHONE_SCENE} mobilePoster={POSTER} />,
    );
    expect(viewerScripts().map((s) => s.src)).toEqual([PHONE_SPLINE_VIEWER]);
    setPhone(false);
    expect(container.querySelector('spline-viewer')?.getAttribute('url')).toBe(DESKTOP_SCENE);
    // The phone viewer (still downloading, or already defined) serves the desktop scene too.
    expect(viewerScripts().map((s) => s.src)).toEqual([PHONE_SPLINE_VIEWER]);
  });

  it('loaded on desktop and then narrowed: still one viewer', () => {
    const setPhone = liveEnv(false);
    render(<SpareSplineBg url={DESKTOP_SCENE} marker="data-login-spline" mobileUrl={PHONE_SCENE} mobilePoster={POSTER} />);
    expect(viewerScripts()).toHaveLength(1);
    setPhone(true);
    expect(viewerScripts()).toHaveLength(1);
  });
});

describe('SpareSplineBg', () => {
  it('desktop: the 16:9 scene and the viewer script, exactly as before', () => {
    setEnv({ phone: false });
    const { container } = render(
      <SpareSplineBg url={DESKTOP_SCENE} marker="data-login-spline" mobileUrl={PHONE_SCENE} mobileVideo={VIDEO} mobilePoster={POSTER} />,
    );
    const host = container.querySelector('[data-login-spline]') as HTMLElement;
    expect(host).not.toBeNull();
    expect(host.hasAttribute('data-spare-bg')).toBe(false);
    expect(host.children).toHaveLength(1);
    expect(host.querySelector('spline-viewer')?.getAttribute('url')).toBe(DESKTOP_SCENE);
    expect(container.querySelector('video, img')).toBeNull();
    expect(viewerScripts()).toHaveLength(1);
  });

  it('phone without a phone scene: video over its poster, and no Spline at all', () => {
    setEnv({ phone: true });
    const { container } = render(
      <SpareSplineBg url={DESKTOP_SCENE} marker="data-login-spline" mobileVideo={VIDEO} mobilePoster={POSTER} />,
    );
    const host = container.querySelector('[data-login-spline]') as HTMLElement;
    expect(host.getAttribute('data-spare-bg')).toBe('video');
    const video = host.querySelector('video') as HTMLVideoElement;
    expect(video.getAttribute('src')).toBe(VIDEO);
    expect(video.getAttribute('poster')).toBe(POSTER);
    expect(video.muted).toBe(true);
    expect(video.hasAttribute('muted')).toBe(true);
    expect(video.hasAttribute('playsinline')).toBe(true);
    expect(video.loop).toBe(true);
    expect(host.querySelector('img')?.getAttribute('src')).toBe(POSTER);
    expect(container.querySelector('spline-viewer')).toBeNull();
    expect(viewerScripts()).toHaveLength(0);
  });

  it('phone with only a poster: the still, no Spline', () => {
    setEnv({ phone: true });
    const { container } = render(<SpareSplineBg url={DESKTOP_SCENE} marker="data-bios-spline" mobilePoster={POSTER} />);
    const host = container.querySelector('[data-bios-spline]') as HTMLElement;
    expect(host.getAttribute('data-spare-bg')).toBe('poster');
    expect(host.querySelector('img')?.getAttribute('src')).toBe(POSTER);
    expect(container.querySelector('spline-viewer, video')).toBeNull();
    expect(viewerScripts()).toHaveLength(0);
  });

  it('phone with a phone scene: that scene (portrait), the poster under it', () => {
    setEnv({ phone: true });
    const { container } = render(
      <SpareSplineBg url={DESKTOP_SCENE} marker="data-login-spline" mobileUrl={PHONE_SCENE} mobileVideo={VIDEO} mobilePoster={POSTER} />,
    );
    const host = container.querySelector('[data-login-spline]') as HTMLElement;
    expect(host.getAttribute('data-spare-bg')).toBe('spline');
    const viewer = host.querySelector('spline-viewer') as HTMLElement;
    expect(viewer.getAttribute('url')).toBe(PHONE_SCENE);
    expect(host.querySelector('img')?.getAttribute('src')).toBe(POSTER);
    expect(container.querySelector('video')).toBeNull();
    expect(viewerScripts()).toHaveLength(1);
  });

  it('phone + reduced motion: poster only, even with a phone scene and a video', () => {
    setEnv({ phone: true, reducedMotion: true });
    const { container } = render(
      <SpareSplineBg url={DESKTOP_SCENE} marker="data-login-spline" mobileUrl={PHONE_SCENE} mobileVideo={VIDEO} mobilePoster={POSTER} />,
    );
    const host = container.querySelector('[data-login-spline]') as HTMLElement;
    expect(host.getAttribute('data-spare-bg')).toBe('poster');
    expect(container.querySelector('spline-viewer, video')).toBeNull();
    expect(viewerScripts()).toHaveLength(0);
  });

  it('phone + Data Saver: poster only', () => {
    setEnv({ phone: true });
    Object.defineProperty(navigator, 'connection', { configurable: true, value: { saveData: true } });
    const { container } = render(
      <SpareSplineBg url={DESKTOP_SCENE} marker="data-login-spline" mobileUrl={PHONE_SCENE} mobileVideo={VIDEO} mobilePoster={POSTER} />,
    );
    expect(container.querySelector('[data-login-spline]')?.getAttribute('data-spare-bg')).toBe('poster');
    expect(container.querySelector('spline-viewer, video')).toBeNull();
    expect(viewerScripts()).toHaveLength(0);
  });
});
