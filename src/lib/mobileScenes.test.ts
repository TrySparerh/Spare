import { describe, expect, it } from 'vitest';
import { MOBILE_FALLBACKS, MOBILE_SCENES, chooseBackground, saveDataOn, sceneForLang, type BgChoice, type BgInputs } from './mobileScenes';

const SCENE = 'https://prod.spline.design/phone/scene.splinecode';
const VIDEO = '/brand/mobile/login-mobile.mp4';

function pick(over: Partial<BgInputs>): BgChoice {
  return chooseBackground({ isMobile: true, reducedMotion: false, saveData: false, ...over });
}

describe('chooseBackground', () => {
  it('desktop / tablet always keep the 16:9 Spline scene, whatever else is set', () => {
    for (const mobileUrl of [undefined, '', SCENE]) {
      for (const mobileVideo of [undefined, '', VIDEO]) {
        for (const reducedMotion of [false, true]) {
          for (const saveData of [false, true]) {
            expect(chooseBackground({ isMobile: false, mobileUrl, mobileVideo, reducedMotion, saveData })).toBe('spline-desktop');
          }
        }
      }
    }
  });

  it.each<[string, Partial<BgInputs>, BgChoice]>([
    ['phone scene wins over the video', { mobileUrl: SCENE, mobileVideo: VIDEO }, 'spline-mobile'],
    ['phone scene alone', { mobileUrl: SCENE }, 'spline-mobile'],
    ['no phone scene → video', { mobileVideo: VIDEO }, 'video'],
    ['empty phone scene → video', { mobileUrl: '', mobileVideo: VIDEO }, 'video'],
    ['whitespace phone scene → video', { mobileUrl: '   ', mobileVideo: VIDEO }, 'video'],
    ['nothing → poster', {}, 'poster'],
    ['empty video → poster', { mobileUrl: '', mobileVideo: '' }, 'poster'],
    ['reduced motion beats the phone scene', { mobileUrl: SCENE, mobileVideo: VIDEO, reducedMotion: true }, 'poster'],
    ['reduced motion beats the video', { mobileVideo: VIDEO, reducedMotion: true }, 'poster'],
    ['Data Saver beats the phone scene', { mobileUrl: SCENE, saveData: true }, 'poster'],
    ['Data Saver beats the video', { mobileVideo: VIDEO, saveData: true }, 'poster'],
  ])('phone: %s', (_name, over, want) => {
    expect(pick(over)).toBe(want);
  });

  it('a phone never gets the desktop scene', () => {
    for (const mobileUrl of [undefined, '', SCENE]) {
      for (const mobileVideo of [undefined, '', VIDEO]) {
        for (const reducedMotion of [false, true]) {
          for (const saveData of [false, true]) {
            expect(pick({ mobileUrl, mobileVideo, reducedMotion, saveData })).not.toBe('spline-desktop');
          }
        }
      }
    }
  });
});

describe('saveDataOn', () => {
  it('reads navigator.connection.saveData', () => {
    expect(saveDataOn({ connection: { saveData: true } } as unknown as Navigator)).toBe(true);
    expect(saveDataOn({ connection: { saveData: false } } as unknown as Navigator)).toBe(false);
  });
  it('is false where the Network Information API is missing', () => {
    expect(saveDataOn({} as Navigator)).toBe(false);
    expect(saveDataOn(undefined)).toBe(false);
  });
});

describe('phone assets', () => {
  it('every screen has a portrait poster; login and desktop have a video loop, the BIOS does not', () => {
    for (const screen of ['bios', 'login', 'desktop'] as const) {
      expect(MOBILE_FALLBACKS[screen].poster).toMatch(/^\/brand\/mobile\/.+\.jpg$/);
    }
    expect(MOBILE_FALLBACKS.bios.video).toBeUndefined();
    expect(MOBILE_FALLBACKS.login.video).toMatch(/^\/brand\/mobile\/.+\.mp4$/);
    expect(MOBILE_FALLBACKS.desktop.video).toMatch(/^\/brand\/mobile\/.+\.mp4$/);
  });

  it('phone scene slots are strings (empty until the owner sets them)', () => {
    for (const screen of ['bios', 'login', 'desktop'] as const) {
      expect(typeof MOBILE_SCENES[screen]).toBe('string');
    }
  });
});

describe('sceneForLang (Mandarin scenes)', () => {
  const table = {
    'zh-CN': { desktop: { bios: 'cn-d-bios', login: '', desktop: '' }, phone: { bios: 'cn-p-bios', login: '', desktop: '' } },
    'zh-TW': { desktop: { bios: '', login: '', desktop: '' }, phone: { bios: 'tw-p-bios', login: '', desktop: '' } },
  };
  it('English always gets the English scene', () => {
    expect(sceneForLang('bios', 'desktop', 'en', 'EN', table)).toBe('EN');
  });
  it('zh-CN uses its slot, else falls back to English', () => {
    expect(sceneForLang('bios', 'desktop', 'zh-CN', 'EN', table)).toBe('cn-d-bios');
    expect(sceneForLang('login', 'desktop', 'zh-CN', 'EN', table)).toBe('EN');
  });
  it('zh-TW uses its own slot, then zh-CN, then English', () => {
    expect(sceneForLang('bios', 'phone', 'zh-TW', 'EN', table)).toBe('tw-p-bios');
    expect(sceneForLang('bios', 'desktop', 'zh-TW', 'EN', table)).toBe('cn-d-bios');
    expect(sceneForLang('desktop', 'phone', 'zh-TW', 'EN', table)).toBe('EN');
  });
});
