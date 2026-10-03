/**
 * SpareWorldBackground — the desktop's full-bleed background: the owner's
 * Spline scene of the pastel pixel world, rendered through SpareSplineBg (the
 * same full-bleed Spline host the BIOS and login use), with pointer events off
 * so desktop icons and windows stay clickable.
 *
 * FullBleedWorld is the same scene fixed to the viewport, for the public pages
 * (LivePageFrame).
 *
 * Swap the scene without a code change via VITE_SPLINE_DESKTOP_SCENE. Phones
 * (< 768px) get the portrait phone scene (MOBILE_SCENES.desktop), else the
 * desktop video loop over its poster — see lib/mobileScenes.
 */
import { MOBILE_FALLBACKS } from '@/lib/mobileScenes';
import { useSceneUrls } from '@/lib/useSceneUrls';
import { SpareSplineBg } from './SpareSplineBg';

const DESKTOP_SCENE =
  (import.meta.env.VITE_SPLINE_DESKTOP_SCENE as string | undefined) ||
  'https://prod.spline.design/KQ1LEi0YyRV-sMZg/scene.splinecode';

/** Shown while the scene streams in (and if WebGL is unavailable): the scene's own palette. */
const LOADING_BG =
  'radial-gradient(ellipse at 55% 45%, #b9a7ff 0%, rgba(185,167,255,0) 45%),' +
  'linear-gradient(160deg, #ffd9c2 0%, #ffb8e0 38%, #c9b6ff 68%, #8fa4ff 100%)';

interface Props {
  opacity?: number;
  position?: 'fixed' | 'absolute';
}

function Scene({ opacity, position }: Required<Props>) {
  const scenes = useSceneUrls('desktop', DESKTOP_SCENE);
  return (
    <div
      aria-hidden
      data-desktop-bg=""
      style={{
        position,
        inset: 0,
        pointerEvents: 'none',
        opacity,
        background: LOADING_BG,
      }}
    >
      <SpareSplineBg
        key={`${scenes.url}|${scenes.mobileUrl}`}
        url={scenes.url}
        marker="data-desktop-spline"
        mobileUrl={scenes.mobileUrl}
        mobileVideo={MOBILE_FALLBACKS.desktop.video}
        mobilePoster={MOBILE_FALLBACKS.desktop.poster}
      />
    </div>
  );
}

/** The desktop wallpaper (absolute inside the desktop root). */
export function SpareWorldBackground({ opacity = 1, position = 'absolute' }: Props) {
  return <Scene opacity={opacity} position={position} />;
}

/** The same world, fixed behind a scrolling page. */
export function FullBleedWorld({ opacity = 1, position = 'fixed' }: Props) {
  return <Scene opacity={opacity} position={position} />;
}

export default SpareWorldBackground;
