/**
 * * — Spare 404.
 * Rendered in the public shell so a wrong link still lands somewhere that
 * looks like Spare. Asks crawlers not to index it while mounted (the page's
 * robots meta reads "noindex" until you leave; the SPA answers 200 here).
 * Text: shell `notFound.*`.
 */
import { useLocation } from 'react-router-dom';
import { Ctas, GlassCard, LinkButton, P, PublicShell } from '@/components/public/PublicShell';
import { useNoIndex } from '@/components/public/live/pageMeta';
import { HoloText } from '@/components/retro/holo';
import { Trans, useTranslation } from '@/i18n';

export default function NotFound() {
  const { t } = useTranslation('shell');
  const { pathname } = useLocation();

  useNoIndex();

  return (
    <PublicShell
      pageTitle={t('notFound.pageTitle')}
      kicker={t('notFound.kicker')}
      title="404"
      subtitle={t('notFound.subtitle')}
      heroSize="xl"
      heroSeed={404}
    >
      <GlassCard title={t('notFound.cardTitle')} icon="/icons/spare-logo.png" bar="lilac">
        <P>{t('notFound.body')}</P>
        <HoloText tone="muted" size="sm" style={{ overflowWrap: 'anywhere' }}>
          <Trans t={t} i18nKey="notFound.requested" values={{ path: pathname }} components={{ path: <span translate="no" /> }} />
        </HoloText>
        <Ctas>
          <LinkButton to="/" variant="primary">
            {t('notFound.back')}
          </LinkButton>
          <LinkButton to="/docs">{t('notFound.readDocs')}</LinkButton>
        </Ctas>
      </GlassCard>
    </PublicShell>
  );
}
