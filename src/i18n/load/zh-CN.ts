/**
 * Simplified Chinese bundle: every zh-CN namespace in ONE lazy chunk. Only
 * src/i18n/index.ts imports this, and only with import(), so English visitors
 * never download it. Add namespaces as files in locales/zh-CN/, not here.
 */
const files = import.meta.glob<Record<string, unknown>>('../locales/zh-CN/*.json', { eager: true, import: 'default' });
export default files;
