import '@testing-library/jest-dom/vitest';
import { initI18n } from '@/i18n';

// Components call useTranslation(); start i18n in English so tests see the
// English strings (the source of truth) rather than raw keys.
await initI18n('en');
