/**
 * The Spline viewer (<spline-viewer>, a custom element from Spline's CDN
 * bundle) as Spare drives it: one viewer script per page, and a runtime that
 * is shut down when its element leaves the page. Used by SpareSplineBg and
 * the boot screen.
 */

/**
 * The runtime Application the viewer creates when it starts loading
 * (`_spline` in viewer 2.x); undefined until then. Read from the 2.0.63 and
 * 2.0.65 bundles: stop() clears the render loop and pauses its events;
 * dispose() also frees the renderer and removes its window / document
 * listeners.
 */
export interface SplineRuntime {
  play?: () => void;
  stop?: () => void;
  dispose?: () => void;
  _resize?: () => void;
  _renderer?: { getPixelRatio?: () => number; setPixelRatio?: (ratio: number) => void };
}

/** <spline-viewer> as the 2.x viewer upgrades it. `_loaded` turns true when the scene has streamed in. */
export type SplineViewerElement = HTMLElement & { _spline?: SplineRuntime; _loaded?: boolean };

/** Marks the viewer script this app injected (any version). */
const VIEWER_SCRIPT_ATTR = 'data-spline-viewer';

/**
 * Inject a Spline viewer script unless the page already has one — defined,
 * or still downloading. Only one viewer can define <spline-viewer> per page; a
 * second define throws "the name "spline-viewer" has already been used".
 * Returns true when it added the script.
 */
export function injectSplineViewer(src: string): boolean {
  if (typeof customElements !== 'undefined' && customElements.get('spline-viewer')) return false;
  if (document.querySelector(`script[${VIEWER_SCRIPT_ATTR}], script[src="${src}"], script[src*="/@splinetool/viewer@"]`)) return false;
  const el = document.createElement('script');
  el.type = 'module';
  el.src = src;
  el.setAttribute(VIEWER_SCRIPT_ATTR, '');
  document.head.appendChild(el);
  return true;
}

function shutDown(app: SplineRuntime | undefined) {
  if (!app) return;
  try {
    app.stop?.();
  } catch {
    /* already stopped */
  }
  try {
    app.dispose?.();
  } catch {
    /* already disposed */
  }
}

/**
 * Stop and dispose a viewer's runtime once React has taken the element off
 * the page, then drop the element. Call it from an effect cleanup with the
 * viewer the effect captured: a viewer still on the page (an effect re-run,
 * Fast Refresh) is left alone.
 *
 * A scene still streaming in is torn down when it lands: the runtime only
 * checks for disposal before it parses, then builds its renderer and starts
 * its render loop regardless. `load-complete` fires after that loop is queued
 * and before it starts; the microtask lets the viewer finish its own handler,
 * which still reads the scene.
 */
export function disposeSplineViewer(viewer: SplineViewerElement | null | undefined): void {
  if (!viewer || viewer.isConnected) return;
  const app = viewer._spline;
  if (app && !viewer._loaded) {
    viewer.addEventListener('load-complete', () => queueMicrotask(() => shutDown(viewer._spline)), { once: true });
  } else {
    shutDown(app);
  }
  viewer.remove();
}
