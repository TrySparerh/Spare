import { useLang } from '@/i18n';
import { MOBILE_SCENES, sceneForLang, type SceneScreen } from '@/lib/mobileScenes';

/**
 * Desktop + phone Spline scene URLs for a screen in the current language.
 * Changes when the language toggle changes, so callers can key the background
 * on the result to reload the right scene instantly.
 */
export function useSceneUrls(screen: SceneScreen, englishDesktop: string): { url: string; mobileUrl: string } {
  const lang = useLang();
  return {
    url: sceneForLang(screen, 'desktop', lang, englishDesktop),
    mobileUrl: sceneForLang(screen, 'phone', lang, MOBILE_SCENES[screen]),
  };
}
