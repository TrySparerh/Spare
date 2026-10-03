/**
 * SpareSplineBg — a Spline scene used as a full-bleed background.
 *
 * Extracted from BiosScreen because the login screen needs the same thing with
 * a different scene, and the awkward part is worth writing once:
 *
 * `spline-viewer` sizes its internal canvas from whatever the host measured
 * when the custom element upgraded, and then does not reliably re-measure.
 * CSS on the host, resize events and attribute changes were all ignored — the
 * host reported the right geometry while the canvas stayed 300x150 in a corner
 * with black around it. The fix reaches into the shadow root and pins the
 * canvas directly, and sets its drawing BUFFER too: CSS size alone stretches a
 * 300x150 buffer about tenfold, which reads as mush rather than a background.
 *
 * A ResizeObserver reapplies on layout change; a short poll covers the window
 * between element upgrade and the scene finishing its stream-in.
 *
 * PHONES (< 768px) never get the 16:9 desktop scene (1–21 MB, badly cropped in
 * portrait). chooseBackground() (lib/mobileScenes) picks, per screen:
 *   · `mobileUrl`    a portrait Spline scene — DPR capped at 1.5, paused while
 *                    the tab is hidden, the poster underneath while it streams
 *   · `mobileVideo`  a muted portrait loop over its poster
 *   · `mobilePoster` a still (always, under reduced motion or Data Saver)
 * Without `mobileUrl`, a phone never injects the viewer script and never asks
 * for a .splinecode. The choice is made synchronously on the first render, so
 * a phone never paints (or fetches) the desktop branch for a frame.
 * Desktop and tablet render exactly what they did before these props existed.
 *
 * ONE VIEWER PER PAGE. Whichever viewer script lands first (phone 2.0.65 or
 * desktop 2.0.63) defines <spline-viewer> and serves both layouts; a page that
 * loads at phone width and is then widened (a tablet rotating, a window being
 * resized) must not inject the other one, or its define() throws.
 *
 * TEARDOWN. Removing a <spline-viewer> from the page does not stop its
 * runtime: the boot and login scenes kept their render loop and window
 * listeners after those screens closed, and drew into a zero-size canvas
 * (thousands of WebGPU validation errors per minute on the desktop). Every
 * viewer this file (or the boot screen) mounts is stopped and disposed when
 * it leaves the page — see disposeSplineViewer.
 */
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type DetailedHTMLProps,
  type HTMLAttributes,
  type ComponentType,
} from 'react';
import { useIsMobileNow } from '@/hooks/use-mobile';
import { PHONE_SPLINE_VIEWER, REDUCED_MOTION_QUERY, chooseBackground, prefersReducedMotion, saveDataOn } from '@/lib/mobileScenes';
import { disposeSplineViewer, injectSplineViewer, type SplineViewerElement } from '@/lib/splineViewer';

type SplineViewerProps = DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & {
  url?: string;
  'events-target'?: string;
};

const SplineViewer = 'spline-viewer' as unknown as ComponentType<SplineViewerProps>;

/** Pinned to the viewer version the scenes were exported with. */
const VIEWER_SRC =
  (import.meta.env.VITE_SPLINE_VIEWER as string | undefined) ||
  'https://cdn.spline.design/@splinetool/viewer@2.0.63/build/spline-viewer.js';

interface Props {
  /** Scene URL (…/scene.splinecode). */
  url: string;
  /** Marks the wrapper so page CSS can target it. */
  marker?: string;
  /** Behind everything by default. */
  zIndex?: number;
  /** Phones only: a portrait (phone-native) Spline scene. Empty = use the video / poster. */
  mobileUrl?: string;
  /** Phones only: a muted portrait video loop, used when there is no `mobileUrl`. */
  mobileVideo?: string;
  /** Phones only: portrait still — first paint under the video / phone scene, and the reduced-motion background. */
  mobilePoster?: string;
}

/* ───────────────────────── live environment reads ───────────────────────── */

function subscribeReducedMotion(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => undefined;
  const mql = window.matchMedia(REDUCED_MOTION_QUERY);
  mql.addEventListener('change', onChange);
  return () => mql.removeEventListener('change', onChange);
}

function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReducedMotion, prefersReducedMotion, () => false);
}

export function SpareSplineBg({ url, marker = 'data-spare-spline', zIndex = 0, mobileUrl, mobileVideo, mobilePoster }: Props) {
  const isMobile = useIsMobileNow();
  const reducedMotion = useReducedMotion();
  const [saveData] = useState(saveDataOn);
  const choice = chooseBackground({ isMobile, mobileUrl, mobileVideo, reducedMotion, saveData });

  switch (choice) {
    case 'spline-desktop':
      return <SplineLayer url={url} marker={marker} zIndex={zIndex} />;
    case 'spline-mobile':
      return <SplineLayer url={mobileUrl as string} marker={marker} zIndex={zIndex} phone poster={mobilePoster} />;
    case 'video':
      return <VideoLayer src={mobileVideo as string} poster={mobilePoster} marker={marker} zIndex={zIndex} />;
    default:
      return <PosterLayer poster={mobilePoster} marker={marker} zIndex={zIndex} />;
  }
}

/* ───────────────────────────── Spline layer ───────────────────────────── */

interface SplineLayerProps {
  url: string;
  marker: string;
  zIndex: number;
  /** Phone-native scene: portrait cover, DPR <= 1.5, paused while the tab is hidden. */
  phone?: boolean;
  poster?: string;
}

/** Desktop: the 16:9 scene as a cover — the exact geometry the screens shipped with. */
const DESKTOP_VIEWER_STYLE: CSSProperties = {
  // Cover: size off whichever axis is short so a 16:9 scene never
  // letterboxes, centred with margins rather than a transform — a
  // transformed host throws off the viewer's own measurement.
  position: 'absolute',
  left: '50%',
  top: '50%',
  width: 'max(100vw, 177.78vh)',
  height: 'max(56.25vw, 100vh)',
  marginLeft: 'calc(max(100vw, 177.78vh) / -2)',
  marginTop: 'calc(max(56.25vw, 100vh) / -2)',
  maxWidth: 'none',
  display: 'block',
  background: 'transparent',
};

/** Phones: the same cover, for a portrait 9:16 scene. */
const PHONE_VIEWER_STYLE: CSSProperties = {
  position: 'absolute',
  left: '50%',
  top: '50%',
  width: 'max(100vw, 56.25vh)',
  height: 'max(177.78vw, 100vh)',
  marginLeft: 'calc(max(100vw, 56.25vh) / -2)',
  marginTop: 'calc(max(177.78vw, 100vh) / -2)',
  maxWidth: 'none',
  display: 'block',
  background: 'transparent',
};

function viewerIn(host: HTMLElement): SplineViewerElement | null {
  return host.querySelector('spline-viewer') as SplineViewerElement | null;
}

/** Pin the shadow canvas to the host and size its drawing buffer at <= maxDpr. */
function fitCanvas(host: HTMLElement, maxDpr: number) {
  const viewer = viewerIn(host);
  const canvas = (viewer as unknown as { shadowRoot?: ShadowRoot } | null)?.shadowRoot?.querySelector(
    'canvas',
  ) as HTMLCanvasElement | null;
  if (!canvas) return;

  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.display = 'block';
  canvas.style.objectFit = 'cover';

  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
  const w = Math.round(rect.width * dpr);
  const h = Math.round(rect.height * dpr);
  if (w > 0 && h > 0 && (canvas.width !== w || canvas.height !== h)) {
    canvas.width = w;
    canvas.height = h;
  }
}

/** Cap the runtime's own pixel ratio (it renders at devicePixelRatio — 3x on most phones). */
function capRuntimeDpr(host: HTMLElement, maxDpr: number) {
  const app = viewerIn(host)?._spline;
  const renderer = app?._renderer;
  if (!app || typeof renderer?.getPixelRatio !== 'function' || typeof renderer.setPixelRatio !== 'function') return;
  const cap = Math.min(window.devicePixelRatio || 1, maxDpr);
  if (renderer.getPixelRatio() <= cap) return;
  try {
    renderer.setPixelRatio(cap);
    if (typeof app._resize === 'function') app._resize();
  } catch {
    /* private API moved — fitCanvas still caps the buffer */
  }
}

/** Drawing-buffer DPR cap: 2x so a 4K panel does not ask for a 7680px surface every frame; phones 1.5x. */
const DESKTOP_MAX_DPR = 2;
const PHONE_MAX_DPR = 1.5;

function SplineLayer({ url, marker, zIndex, phone = false, poster }: SplineLayerProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  // Load the viewer script once per document — never a second one (see the header).
  useEffect(() => {
    injectSplineViewer(phone ? PHONE_SPLINE_VIEWER : VIEWER_SRC);
  }, [phone]);

  // Shut this viewer's runtime down when it leaves the page (see disposeSplineViewer).
  useEffect(() => {
    const viewer = hostRef.current && viewerIn(hostRef.current);
    if (!viewer) return;
    return () => disposeSplineViewer(viewer);
  }, [url, phone]);

  // Force the shadow canvas to fill — see the file header for why this is needed.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let stopped = false;
    const maxDpr = phone ? PHONE_MAX_DPR : DESKTOP_MAX_DPR;
    const fit = () => fitCanvas(host, maxDpr);

    fit();
    const poll = window.setInterval(() => {
      if (!stopped) fit();
    }, 400);
    const settle = window.setTimeout(() => {
      stopped = true;
      window.clearInterval(poll);
    }, 12000);

    const ro = new ResizeObserver(fit);
    ro.observe(host);

    return () => {
      stopped = true;
      window.clearInterval(poll);
      window.clearTimeout(settle);
      ro.disconnect();
    };
  }, [url, phone]);

  // Phones only: once the scene is in, cap the runtime at 1.5x and re-pin the
  // canvas (a slow phone network can land the scene after the 12 s poll);
  // stop the render loop while the tab is hidden and resume on return.
  useEffect(() => {
    if (!phone) return;
    const host = hostRef.current;
    const viewer = host && viewerIn(host);
    if (!host || !viewer) return;

    const onLoaded = () => {
      capRuntimeDpr(host, PHONE_MAX_DPR);
      fitCanvas(host, PHONE_MAX_DPR);
    };

    const onVisibility = () => {
      const hidden = document.visibilityState === 'hidden';
      const app = viewer._spline;
      let paused = false;
      if (app && typeof app.stop === 'function' && typeof app.play === 'function') {
        try {
          if (hidden) app.stop();
          else app.play();
          paused = true;
        } catch {
          /* fall back to hiding */
        }
      }
      // No runtime API (or not loaded yet): hide the viewer instead.
      viewer.style.visibility = hidden && !paused ? 'hidden' : '';
    };

    viewer.addEventListener('load-complete', onLoaded);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      viewer.removeEventListener('load-complete', onLoaded);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [url, phone]);

  if (!phone) {
    return (
      <div
        ref={hostRef}
        {...{ [marker]: '' }}
        aria-hidden
        style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none', zIndex }}
      >
        <SplineViewer url={url} style={DESKTOP_VIEWER_STYLE} />
      </div>
    );
  }

  return (
    <div ref={hostRef} {...{ [marker]: '' }} data-spare-bg="spline" aria-hidden style={layerStyle(zIndex)}>
      {/* The still paints at once; the scene draws over it when it has streamed in. */}
      {poster && <img className="spare-bg__poster" src={poster} alt="" decoding="async" draggable={false} style={COVER_MEDIA} />}
      <SplineViewer url={url} style={PHONE_VIEWER_STYLE} />
    </div>
  );
}

/* ─────────────────────────── phone video / poster ─────────────────────────── */

/** Same box as the Spline host: full-bleed, behind, click-through. */
function layerStyle(zIndex: number): CSSProperties {
  return { position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none', zIndex };
}

const COVER_MEDIA: CSSProperties = {
  position: 'absolute',
  inset: 0,
  width: '100%',
  height: '100%',
  objectFit: 'cover',
  objectPosition: 'center',
  display: 'block',
  pointerEvents: 'none',
  background: 'transparent',
};

interface MediaLayerProps {
  marker: string;
  zIndex: number;
  poster?: string;
}

function VideoLayer({ src, poster, marker, zIndex }: MediaLayerProps & { src: string }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  // Hidden until the first frame plays: iOS can paint a black box before
  // that, and Low Power Mode blocks autoplay outright — the poster (and the
  // screen's gradient under it) covers both.
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    // React sets `muted` as a property only; iOS autoplay checks the attribute.
    v.muted = true;
    v.defaultMuted = true;
    v.setAttribute('muted', '');
    const play = () => {
      try {
        const p = v.play();
        if (p && typeof p.catch === 'function') p.catch(() => undefined);
      } catch {
        /* autoplay refused — the poster stays */
      }
    };
    play();
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') v.pause();
      else play();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [src]);

  return (
    <div {...{ [marker]: '' }} data-spare-bg="video" aria-hidden style={layerStyle(zIndex)}>
      {poster && <img className="spare-bg__poster" src={poster} alt="" decoding="async" draggable={false} style={COVER_MEDIA} />}
      <video
        ref={videoRef}
        className="spare-bg__video"
        src={src}
        poster={poster}
        autoPlay
        muted
        loop
        playsInline
        preload="auto"
        disablePictureInPicture
        tabIndex={-1}
        onPlaying={() => setPlaying(true)}
        style={{ ...COVER_MEDIA, opacity: playing ? 1 : 0, transition: 'opacity .45s ease' }}
      />
    </div>
  );
}

function PosterLayer({ poster, marker, zIndex }: MediaLayerProps) {
  return (
    <div {...{ [marker]: '' }} data-spare-bg="poster" aria-hidden style={layerStyle(zIndex)}>
      {poster && <img className="spare-bg__poster" src={poster} alt="" decoding="async" draggable={false} style={COVER_MEDIA} />}
    </div>
  );
}

export default SpareSplineBg;
