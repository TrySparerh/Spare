import { afterEach, describe, expect, it, vi } from 'vitest';
import { disposeSplineViewer, injectSplineViewer } from './splineViewer';

const DESKTOP = 'https://cdn.spline.design/@splinetool/viewer@2.0.63/build/spline-viewer.js';
const PHONE = 'https://cdn.spline.design/@splinetool/viewer@2.0.65/build/spline-viewer.js';
const scripts = () => [...document.querySelectorAll('script')].map((s) => s.src);

afterEach(() => {
  document.querySelectorAll('script').forEach((s) => s.remove());
  document.body.innerHTML = '';
});

describe('injectSplineViewer', () => {
  it('adds the module script once', () => {
    expect(injectSplineViewer(DESKTOP)).toBe(true);
    expect(injectSplineViewer(DESKTOP)).toBe(false);
    expect(scripts()).toEqual([DESKTOP]);
    expect((document.querySelector('script') as HTMLScriptElement).type).toBe('module');
  });

  it('never adds a second viewer version, even while the first is still downloading', () => {
    expect(injectSplineViewer(PHONE)).toBe(true);
    expect(injectSplineViewer(DESKTOP)).toBe(false);
    expect(scripts()).toEqual([PHONE]);
  });

  it('recognises a viewer script added by older code (no marker attribute)', () => {
    const s = document.createElement('script');
    s.src = PHONE;
    document.head.appendChild(s);
    expect(injectSplineViewer(DESKTOP)).toBe(false);
    expect(scripts()).toEqual([PHONE]);
  });

  // Last: a custom element cannot be undefined again in this document.
  it('adds nothing once <spline-viewer> is defined', () => {
    customElements.define('spline-viewer', class extends HTMLElement {});
    expect(injectSplineViewer(DESKTOP)).toBe(false);
    expect(scripts()).toEqual([]);
  });
});

describe('disposeSplineViewer', () => {
  function viewerWith(loaded: boolean) {
    const viewer = document.createElement('div');
    const app = { stop: vi.fn(), dispose: vi.fn() };
    Object.assign(viewer, { _spline: app, _loaded: loaded });
    return { viewer, app };
  }

  it('leaves a viewer that is still on the page alone', () => {
    const { viewer, app } = viewerWith(true);
    document.body.appendChild(viewer);
    disposeSplineViewer(viewer);
    expect(app.stop).not.toHaveBeenCalled();
    expect(app.dispose).not.toHaveBeenCalled();
    expect(viewer.isConnected).toBe(true);
  });

  it('stops and disposes a detached viewer and drops it from its old parent', () => {
    const host = document.createElement('div');
    const { viewer, app } = viewerWith(true);
    host.appendChild(viewer);
    disposeSplineViewer(viewer);
    expect(app.stop).toHaveBeenCalledTimes(1);
    expect(app.dispose).toHaveBeenCalledTimes(1);
    expect(host.childNodes).toHaveLength(0);
  });

  it('tolerates a runtime that throws or lacks the methods, and a viewer that never started', () => {
    const throwing = document.createElement('div');
    Object.assign(throwing, {
      _spline: {
        stop: () => {
          throw new Error('x');
        },
        dispose: () => {
          throw new Error('y');
        },
      },
      _loaded: true,
    });
    expect(() => disposeSplineViewer(throwing)).not.toThrow();
    const bare = document.createElement('div');
    Object.assign(bare, { _spline: {}, _loaded: true });
    expect(() => disposeSplineViewer(bare)).not.toThrow();
    expect(() => disposeSplineViewer(document.createElement('div'))).not.toThrow();
    expect(() => disposeSplineViewer(null)).not.toThrow();
  });
});
