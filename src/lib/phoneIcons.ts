/**
 * PHONE ICONS (screens < 768px wide only).
 *
 * A few icons ship as 1254x1254 PNGs (0.17–0.89 MB each) but are drawn at
 * 18–64 px. Phones get 128x128 copies from public/icons/mobile/ (6–13 KB each)
 * instead. Desktop and tablet keep requesting the originals: callers pass
 * `isPhone` from useIsMobileNow(), which is `false` there from the first render.
 */
const PHONE_ICONS: Readonly<Record<string, string>> = {
  '/icons/telegram.png': '/icons/mobile/telegram.png',
  '/icons/x.png': '/icons/mobile/x.png',
  '/icons/recycle-bin.png': '/icons/mobile/recycle-bin.png',
  '/icons/phantom-icon.png': '/icons/mobile/phantom-icon.png',
  '/icons/coinbase-icon.png': '/icons/mobile/coinbase-icon.png',
  '/icons/metamask-icon.png': '/icons/mobile/metamask-icon.png',
};

/** The phone-sized copy of `src` on phones; `src` unchanged everywhere else. */
export function phoneIconSrc(src: string, isPhone: boolean): string;
export function phoneIconSrc(src: string | null | undefined, isPhone: boolean): string | null | undefined;
export function phoneIconSrc(src: string | null | undefined, isPhone: boolean): string | null | undefined {
  if (!isPhone || !src) return src;
  return PHONE_ICONS[src] ?? src;
}
