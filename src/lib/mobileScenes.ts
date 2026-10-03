/**
 * PHONE BACKGROUNDS (screens < 768px wide only).
 *
 * Desktop and tablet keep their 16:9 Spline scenes and never read this file's
 * values. Phones get a portrait background per screen, picked by
 * chooseBackground() below, in this order:
 *
 *   1. a phone-native (portrait) Spline scene, once its URL is set here
 *   2. else a short muted portrait video loop (login, desktop)
 *   3. else the portrait poster image
 *
 * Reduced motion or Data Saver always gets the poster. Until a phone scene URL
 * is set, phones never load the Spline viewer script or any .splinecode.
 *
 * ┌─ WHERE TO PUT THE 3 PHONE SPLINE SCENE URLS ─────────────────────────────┐
 * │ Each is a Spline "Export → Code → scene.splinecode" URL, e.g.             │
 * │   https://prod.spline.design/AbCdEf123456/scene.splinecode                │
 * │                                                                            │
 * │ Option A (no code change): in the hosting dashboard, open the site's      │
 * │ service → Variables, add these three, then redeploy the site —            │
 * │ VITE_* values are baked in at build time, so a redeploy is required:      │
 * │   VITE_SPLINE_BIOS_SCENE_MOBILE    = …/scene.splinecode   (boot screen)   │
 * │   VITE_SPLINE_LOGIN_SCENE_MOBILE   = …/scene.splinecode   (sign-in)       │
 * │   VITE_SPLINE_DESKTOP_SCENE_MOBILE = …/scene.splinecode   (desktop)       │
 * │                                                                            │
 * │ Option B: paste them between the quotes in PASTE_PHONE_SCENES below.      │
 * │ An env var, when set, wins over the pasted value.                         │
 * │                                                                            │
 * │ Author them portrait, 9:16 (e.g. 1080x1920): they are drawn as a 9:16     │
 * │ cover, centred, so keep the subject in the middle ~80% of the width.      │
 * └────────────────────────────────────────────────────────────────────────────┘
 */
const PASTE_PHONE_SCENES = {
  bios: 'https://prod.spline.design/HUUVfE9vpMNFTbIR/scene.splinecode', // boot / BIOS screen (EN, 720x1280 star loop)
  login: 'https://prod.spline.design/tzIsAoc7AeZ8SOrI/scene.splinecode', // sign-in screen (EN, 720x1280 stone heads)
  desktop: 'https://prod.spline.design/wrO3H-HuVpvZJxuC/scene.splinecode', // desktop wallpaper + public pages (EN, 540x960 planet)
};

/**
 * The phone scenes were exported with Spline viewer 2.0.65; desktop keeps its
 * own pinned viewer. Only one viewer can define <spline-viewer> per page, so
 * whichever loads first serves both layouts when the width later crosses
 * 768px (lib/splineViewer injectSplineViewer).
 */
export const PHONE_SPLINE_VIEWER = 'https://cdn.spline.design/@splinetool/viewer@2.0.65/build/spline-viewer.js';

function envUrl(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** Phone-native Spline scene per screen ('' = none yet → video / poster). */
export const MOBILE_SCENES = {
  bios: envUrl(import.meta.env.VITE_SPLINE_BIOS_SCENE_MOBILE) || PASTE_PHONE_SCENES.bios.trim() || '',
  login: envUrl(import.meta.env.VITE_SPLINE_LOGIN_SCENE_MOBILE) || PASTE_PHONE_SCENES.login.trim() || '',
  desktop: envUrl(import.meta.env.VITE_SPLINE_DESKTOP_SCENE_MOBILE) || PASTE_PHONE_SCENES.desktop.trim() || '',
} as const;

// ── Mandarin scenes ─────────────────────────────────────────────────────
/**
 * Mandarin versions of each Spline scene (Chinese hero text, e.g. 积零成股).
 * Paste a URL to switch that screen when the language toggle is 中文; leave ''
 * to keep the English scene. zh-TW uses its own slot if set, else zh-CN's.
 *   desktop = desktop/tablet (16:9)   phone = phones (9:16)
 */
const PASTE_MANDARIN_SCENES: Record<'zh-CN' | 'zh-TW', Record<'desktop' | 'phone', Record<SceneScreen, string>>> = {
  'zh-CN': {
    desktop: { bios: '', login: '', desktop: '' },
    phone: { bios: '', login: '', desktop: '' },
  },
  'zh-TW': {
    desktop: { bios: '', login: '', desktop: '' },
    phone: { bios: '', login: '', desktop: '' },
  },
};

export type SceneScreen = 'bios' | 'login' | 'desktop';

/**
 * The scene a screen should load for a language. English (or an empty
 * Mandarin slot) returns the English scene unchanged.
 */
export function sceneForLang(
  screen: SceneScreen,
  device: 'desktop' | 'phone',
  lang: string,
  english: string,
  table = PASTE_MANDARIN_SCENES,
): string {
  if (lang !== 'zh-CN' && lang !== 'zh-TW') return english;
  const own = table[lang][device][screen].trim();
  const simplified = table['zh-CN'][device][screen].trim();
  return own || simplified || english;
}

export interface PhoneFallback {
  /** Muted H.264 portrait loop (540x960). */
  video?: string;
  /** Portrait still (540x960): the reduced-motion / Data Saver background and the video's first paint. */
  poster: string;
}

/** Phone fallbacks per screen (public/brand/mobile). */
export const MOBILE_FALLBACKS: Record<'bios' | 'login' | 'desktop', PhoneFallback> = {
  bios: { poster: '/brand/mobile/bios-mobile.jpg' },
  login: { video: '/brand/mobile/login-mobile.mp4', poster: '/brand/mobile/login-mobile.jpg' },
  desktop: { video: '/brand/mobile/desktop-mobile.mp4', poster: '/brand/mobile/desktop-mobile.jpg' },
};

/* ───────────────────────── background choice ───────────────────────── */

export type BgChoice = 'spline-desktop' | 'spline-mobile' | 'video' | 'poster';

export interface BgInputs {
  /** Viewport < 768px. */
  isMobile: boolean;
  mobileUrl?: string;
  mobileVideo?: string;
  /** prefers-reduced-motion: reduce. */
  reducedMotion: boolean;
  /** navigator.connection.saveData. */
  saveData: boolean;
}

/**
 * Which background a full-bleed screen renders.
 *
 *   desktop / tablet (>= 768px)          → the existing 16:9 Spline scene, always
 *   phone + reduced motion or Data Saver  → poster
 *   phone + phone scene URL               → portrait Spline scene
 *   phone + video                         → muted video loop
 *   phone, nothing else                   → poster
 */
export function chooseBackground({ isMobile, mobileUrl, mobileVideo, reducedMotion, saveData }: BgInputs): BgChoice {
  if (!isMobile) return 'spline-desktop';
  if (reducedMotion || saveData) return 'poster';
  if (mobileUrl && mobileUrl.trim()) return 'spline-mobile';
  if (mobileVideo && mobileVideo.trim()) return 'video';
  return 'poster';
}

/** Data Saver / Lite mode (Chrome on Android; undefined elsewhere → false). */
export function saveDataOn(nav: Navigator | undefined = typeof navigator === 'undefined' ? undefined : navigator): boolean {
  const conn = (nav as (Navigator & { connection?: { saveData?: boolean } }) | undefined)?.connection;
  return conn?.saveData === true;
}

export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(REDUCED_MOTION_QUERY).matches;
}
