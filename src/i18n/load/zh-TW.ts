/**
 * Traditional Chinese bundle: every zh-TW namespace in ONE lazy chunk. Only
 * src/i18n/index.ts imports this, and only with import(), so English visitors
 * never download it. Add namespaces as files in locales/zh-TW/, not here.
 */
const files = import.meta.glob<Record<string, unknown>>('../locales/zh-TW/*.json', { eager: true, import: 'default' });
export default files;
