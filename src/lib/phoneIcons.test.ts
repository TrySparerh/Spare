import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { phoneIconSrc } from './phoneIcons';

const HEAVY = [
  '/icons/telegram.png',
  '/icons/x.png',
  '/icons/recycle-bin.png',
  '/icons/phantom-icon.png',
  '/icons/coinbase-icon.png',
  '/icons/metamask-icon.png',
];

describe('phoneIconSrc', () => {
  it('leaves every src untouched off phones (desktop / tablet requests stay identical)', () => {
    for (const src of HEAVY) expect(phoneIconSrc(src, false)).toBe(src);
    expect(phoneIconSrc('/icons/spare/docs.png', false)).toBe('/icons/spare/docs.png');
  });

  it('swaps the 1254px icons for their 128px phone copies on phones', () => {
    for (const src of HEAVY) {
      const phone = phoneIconSrc(src, true);
      expect(phone).toBe(src.replace('/icons/', '/icons/mobile/'));
      expect(existsSync(resolve(__dirname, '../../public', `.${phone}`))).toBe(true);
    }
  });

  it('passes through icons with no phone copy, data URIs and empty values', () => {
    expect(phoneIconSrc('/icons/spare/docs.png', true)).toBe('/icons/spare/docs.png');
    expect(phoneIconSrc('data:image/svg+xml;base64,AAAA', true)).toBe('data:image/svg+xml;base64,AAAA');
    expect(phoneIconSrc(null, true)).toBeNull();
    expect(phoneIconSrc(undefined, true)).toBeUndefined();
  });
});
