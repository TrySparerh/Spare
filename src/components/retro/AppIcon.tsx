/**
 * AppIcon — picks the right glyph for an app. Uses iconImage if provided,
 * otherwise falls back to LetterIcon. Wraps both at the requested size so
 * Desktop / Taskbar / StartMenu / title bars get a consistent footprint.
 *
 * `iconMono` apps ship a white-only glyph (the X mark). On a light surface
 * (Start menu, taskbar, My Spare) it is inked deep indigo through a CSS mask;
 * over the world (desktop grid, title bars) it stays white with the same
 * indigo pixel outline the desktop labels use.
 */
import type { AppDescriptor } from './WindowManager';
import { LetterIcon } from './LetterIcon';
import { HOLO } from './holo/tokens';
import { HoloGlyphTile } from './holo/HoloGlyphs';
import { useIsMobileNow } from '@/hooks/use-mobile';
import { phoneIconSrc } from '@/lib/phoneIcons';

interface AppIconProps {
  app: Pick<AppDescriptor, 'iconLetter' | 'iconTone' | 'iconImage' | 'iconMono' | 'iconGlyph'>;
  /** Pixel size of the icon footprint. */
  size?: number;
  /** LetterIcon size token, when no image is provided. */
  letterSize?: 'sm' | 'md' | 'lg' | 'xl';
  /** What the icon sits on — only changes how `iconMono` glyphs are inked. Default 'light'. */
  surface?: 'light' | 'world';
}

const MONO_OUTLINE =
  'drop-shadow(1px 0 0 #2A1B6E) drop-shadow(-1px 0 0 #2A1B6E) drop-shadow(0 1px 0 #2A1B6E) drop-shadow(0 -1px 0 #2A1B6E)';

export function AppIcon({ app, size = 32, letterSize = 'md', surface = 'light' }: AppIconProps) {
  // Phones only: 128 px copies of the 1254 px icons (desktop / tablet keep the originals).
  const isPhone = useIsMobileNow();
  const iconImage = phoneIconSrc(app.iconImage, isPhone);
  if (iconImage && app.iconMono && surface === 'light') {
    const mask = `url("${iconImage}") center / contain no-repeat`;
    return (
      <span
        aria-hidden
        style={{
          width: size,
          height: size,
          display: 'block',
          flexShrink: 0,
          background: HOLO.ink,
          WebkitMask: mask,
          mask,
        }}
      />
    );
  }
  if (iconImage) {
    return (
      <img
        src={iconImage}
        alt=""
        style={{
          width: size,
          height: size,
          imageRendering: 'pixelated',
          objectFit: 'contain',
          display: 'block',
          flexShrink: 0,
          filter: app.iconMono ? MONO_OUTLINE : undefined,
        }}
        draggable={false}
      />
    );
  }
  if (app.iconGlyph) return <HoloGlyphTile kind={app.iconGlyph} size={size} />;
  return <LetterIcon letter={app.iconLetter} tone={app.iconTone} size={letterSize} />;
}

export default AppIcon;
