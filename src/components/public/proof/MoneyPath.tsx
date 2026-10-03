/**
 * The money path as a pixel diagram: five steps left to right (top to bottom
 * when the column is narrow), plus the two branches that bound it: exit
 * at any time, and a failed price check that defers instead of selling.
 * Pure CSS (proofStyles.ts, pf-path*); the step names in code chips are
 * contract and function names and stay untranslated.
 */
import { Trans, tKey, useTranslation } from '@/i18n';
import { TAGS } from './ProofAtoms';

const STEPS = [
  { title: tKey('path.s1.title'), body: tKey('path.s1.body'), code: 'RuleRegistry' },
  { title: tKey('path.s2.title'), body: tKey('path.s2.body'), code: 'SweepExecutor.accrue' },
  { title: tKey('path.s3.title'), body: tKey('path.s3.body'), code: 'CashPark' },
  { title: tKey('path.s4.title'), body: tKey('path.s4.body'), code: 'SweepExecutor.sweep → StockRouter' },
  { title: tKey('path.s5.title'), body: tKey('path.s5.body'), code: 'Delivered' },
] as const;

export function MoneyPath() {
  const { t } = useTranslation('proof');
  return (
    <div className="pf-pathwrap">
      <figure className="pf-path" aria-label={t('path.aria')}>
        <ol className="pf-path__steps">
          {STEPS.map((s, i) => (
            <li key={s.code} className="pf-path__step">
              <div className="pf-path__head">
                <span className="pf-path__n" aria-hidden>
                  {i + 1}
                </span>
                <span className="pf-path__title">{t(s.title)}</span>
              </div>
              <code className="pf-path__code" translate="no">
                {s.code}
              </code>
              <p className="pf-path__body">{t(s.body)}</p>
            </li>
          ))}
        </ol>
        <div className="pf-path__branches">
          <div className="pf-path__branch pf-path__branch--exit">
            <span className="pf-path__from">{t('path.fromStep', { n: 3 })}</span>
            <span className="pf-path__title">{t('path.exitTitle')}</span>
            <p className="pf-path__body">
              <Trans t={t} i18nKey="path.exitBody" components={TAGS} />
            </p>
          </div>
          <div className="pf-path__branch pf-path__branch--defer">
            <span className="pf-path__from">{t('path.fromStep', { n: 4 })}</span>
            <span className="pf-path__title">{t('path.deferTitle')}</span>
            <p className="pf-path__body">{t('path.deferBody')}</p>
          </div>
        </div>
      </figure>
    </div>
  );
}
