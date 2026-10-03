/**
 * /roadmap — where Spare is going.
 *
 * Order, not dates: every stage is labelled S1…S4, never a calendar date.
 * S1 is the only stage marked LIVE because it is the only one on mainnet; the
 * S1 "LIVE" badge is also checked against the chain (SweepExecutor bytecode).
 *
 * The stage data follows the spec's `roadmapPhases` shape. It is kept here
 * rather than read from src/content/roadmap.ts so this page can never render
 * a stale roadmap from another source. Its text fields are i18n keys: the
 * stage copy is the same copy the desktop Roadmap app shows (apps-b
 * `roadmap.*`); the page's own words are shell `roadmapPage.*`.
 */
import {
  Bullets,
  Ctas,
  DocSection,
  GlassCard,
  Grid,
  H3,
  LinkButton,
  P,
  PublicShell,
  StatTile,
  useSectionSpy,
  type PublicSidebarSection,
} from '@/components/public/PublicShell';
import { GlyphCheck, HOLO, HoloBadge, HoloText } from '@/components/retro/holo';
import { useSpareDeployment } from '@/lib/spare-chain/hooks';
import { tKey, useTranslation } from '@/i18n';

type RoadmapStatus = 'completed' | 'in-progress' | 'upcoming';

interface RoadmapPhase {
  id: string;
  /** Stage label shown instead of a date: S1…S4. */
  q: 'S1' | 'S2' | 'S3' | 'S4';
  /** i18n key. */
  title: string;
  status: RoadmapStatus;
  /** i18n key. */
  summary: string;
  /** `text` is an i18n key. */
  items: { text: string; done: boolean }[];
}

const done = (text: string) => ({ text, done: true });
const todo = (text: string) => ({ text, done: false });

const PHASES: RoadmapPhase[] = [
  {
    id: 's1',
    q: 'S1',
    title: tKey('apps-b:roadmap.phases.s1.title'),
    status: 'completed',
    summary: tKey('apps-b:roadmap.phases.s1.summary'),
    items: [
      done(tKey('apps-b:roadmap.phases.s1.link')),
      done(tKey('apps-b:roadmap.phases.s1.rules')),
      done(tKey('apps-b:roadmap.phases.s1.mix')),
      done(tKey('apps-b:roadmap.phases.s1.cashPark')),
      done(tKey('apps-b:roadmap.phases.s1.keeper')),
      done(tKey('apps-b:roadmap.phases.s1.pools')),
      done(tKey('apps-b:roadmap.phases.s1.stocks')),
      done(tKey('apps-b:roadmap.phases.s1.fund')),
      done(tKey('apps-b:roadmap.phases.s1.fee')),
    ],
  },
  {
    id: 's1-hardening',
    q: 'S1',
    title: tKey('apps-b:roadmap.phases.hardening.title'),
    status: 'in-progress',
    summary: tKey('apps-b:roadmap.phases.hardening.summary'),
    items: [
      todo(tKey('apps-b:roadmap.phases.hardening.multisig')),
      todo(tKey('apps-b:roadmap.phases.hardening.audit')),
      todo(tKey('apps-b:roadmap.phases.hardening.standby')),
      todo(tKey('apps-b:roadmap.phases.hardening.treasuryPark')),
      todo(tKey('apps-b:roadmap.phases.hardening.gate')),
    ],
  },
  {
    id: 's2',
    q: 'S2',
    title: tKey('apps-b:roadmap.phases.s2.title'),
    status: 'upcoming',
    summary: tKey('apps-b:roadmap.phases.s2.summary'),
    items: [
      todo(tKey('apps-b:roadmap.phases.s2.balance')),
      todo(tKey('apps-b:roadmap.phases.s2.stealth')),
      todo(tKey('apps-b:roadmap.phases.s2.confidential')),
      todo(tKey('apps-b:roadmap.phases.s2.viewingKey')),
      todo(tKey('apps-b:roadmap.phases.s2.proofs')),
    ],
  },
  {
    id: 's3',
    q: 'S3',
    title: tKey('apps-b:roadmap.phases.s3.title'),
    status: 'upcoming',
    summary: tKey('apps-b:roadmap.phases.s3.summary'),
    items: [
      todo(tKey('apps-b:roadmap.phases.s3.boosts')),
      todo(tKey('apps-b:roadmap.phases.s3.streaks')),
      todo(tKey('apps-b:roadmap.phases.s3.match')),
      todo(tKey('apps-b:roadmap.phases.s3.kids')),
      todo(tKey('apps-b:roadmap.phases.s3.recap')),
      todo(tKey('apps-b:roadmap.phases.s3.token')),
    ],
  },
  {
    id: 's4',
    q: 'S4',
    title: tKey('apps-b:roadmap.phases.s4.title'),
    status: 'upcoming',
    summary: tKey('apps-b:roadmap.phases.s4.summary'),
    items: [
      todo(tKey('apps-b:roadmap.phases.s4.hook')),
      todo(tKey('apps-b:roadmap.phases.s4.chains')),
    ],
  },
];

const STATUS_LABEL: Record<RoadmapStatus, string> = {
  completed: tKey('apps-b:roadmap.status.live'),
  'in-progress': tKey('apps-b:roadmap.status.inProgress'),
  upcoming: tKey('apps-b:roadmap.status.planned'),
};
const STATUS_TONE = { completed: 'good', 'in-progress': 'warn', upcoming: 'info' } as const;
const PHASE_ART: Record<string, string> = {
  s1: '/icons/spare/auto-invest.png',
  's1-hardening': '/icons/spare/link-wallet.png',
  s2: '/icons/spare/viewing-key.png',
  s3: '/icons/spare/stock-mix.png',
  s4: '/icons/spare/fund-wallet.png',
};

const SECTION_IDS = [...PHASES.map((p) => p.id), 'principles', 'changelog'];

/** `text` and `date` are i18n keys; an entry with a date shows it as its badge, the others an S1 badge. Oldest first. */
const CHANGELOG: { id: string; date?: string; text: string }[] = [
  { id: 'deployed', date: tKey('roadmapPage.changelog.date'), text: tKey('roadmapPage.changelog.deployed') },
  { id: 'review', date: tKey('roadmapPage.changelog.date'), text: tKey('roadmapPage.changelog.review') },
  { id: 'pools', date: tKey('roadmapPage.changelog.date'), text: tKey('roadmapPage.changelog.pools') },
  { id: 'universe', date: tKey('roadmapPage.changelog.dateUniverse'), text: tKey('roadmapPage.changelog.universe') },
  { id: 'fund', text: tKey('roadmapPage.changelog.fund') },
];

const WONT = [
  tKey('apps-b:roadmap.wont.subscription'),
  tKey('apps-b:roadmap.wont.projections'),
  tKey('apps-b:roadmap.wont.card'),
  tKey('apps-b:roadmap.wont.pausableExit'),
  tKey('apps-b:roadmap.wont.earlyAddress'),
];

/* ───────────────────────────── pieces ───────────────────────────── */

function Checklist({ items, status }: { items: RoadmapPhase['items']; status: RoadmapStatus }) {
  const { t } = useTranslation('shell');
  return (
    <ul className="rm-check">
      {items.map((it) => (
        <li key={it.text} className={it.done ? 'is-done' : status === 'in-progress' ? 'is-active' : ''}>
          <span className="rm-check__box" aria-hidden>
            {it.done && <GlyphCheck color={HOLO.onScreen} />}
          </span>
          <span>
            {t(it.text)}
            <span className="rm-sr">{it.done ? t('roadmapPage.srDone') : t('roadmapPage.srNotDone')}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function StageRail({ onPick, s1Live }: { onPick: (id: string) => void; s1Live: boolean | null }) {
  const { t } = useTranslation('shell');
  return (
    <nav className="rm-rail" aria-label={t('roadmapPage.railAria')}>
      {PHASES.map((p, i) => (
        <button key={p.id} type="button" className={`rm-rail__node rm-rail__node--${p.status}`} onClick={() => onPick(p.id)}>
          <span className="rm-rail__key" aria-hidden>
            {i + 1}
          </span>
          <span className="rm-rail__q">{p.q}</span>
          <span className="rm-rail__title">{t(p.title)}</span>
          <HoloBadge
            label={p.id === 's1' && s1Live === false ? t('roadmapPage.check') : t(STATUS_LABEL[p.status])}
            tone={STATUS_TONE[p.status]}
            pulse={p.status === 'in-progress'}
          />
        </button>
      ))}
    </nav>
  );
}

/* ───────────────────────────────── page ───────────────────────────────── */

export default function Roadmap() {
  const { t } = useTranslation('shell');
  const [active, select] = useSectionSpy(SECTION_IDS);
  const dep = useSpareDeployment();
  const s1Live: boolean | null = dep.checking ? null : dep.error ? null : dep.deployed;

  const counts = PHASES.reduce(
    (acc, p) => ({ ...acc, [p.status]: acc[p.status] + 1 }),
    { completed: 0, 'in-progress': 0, upcoming: 0 } as Record<RoadmapStatus, number>,
  );

  const sidebar: PublicSidebarSection[] = [
    { label: t('roadmapPage.nav.stages'), items: PHASES.map((p) => ({ id: p.id, label: `${p.q} · ${t(p.title)}` })) },
    {
      label: t('roadmapPage.nav.meta'),
      items: [
        { id: 'principles', label: t('roadmapPage.nav.principles') },
        { id: 'changelog', label: t('roadmapPage.nav.changelog') },
      ],
    },
  ];

  return (
    <PublicShell
      pageTitle={t('roadmapPage.pageTitle')}
      metaDescription={t('roadmapPage.metaDescription')}
      kicker={t('roadmapPage.kicker')}
      title={t('apps-b:roadmap.hero.title')}
      subtitle={t('roadmapPage.subtitle')}
      art="/icons/spare/auto-invest.png"
      heroSeed={17}
      heroAside={<HoloBadge label="S1 → S4" variant="solid" size="md" />}
      sidebar={sidebar}
      activeId={active}
      onSelect={select}
    >
      <style>{ROADMAP_CSS}</style>

      <Grid min={150}>
        <StatTile label={t('roadmapPage.stats.live')} value={String(counts.completed)} tone="good" sub={t('roadmapPage.stats.liveSub')} />
        <StatTile label={t('roadmapPage.stats.inProgress')} value={String(counts['in-progress'])} tone="warn" sub={t('roadmapPage.stats.inProgressSub')} />
        <StatTile label={t('roadmapPage.stats.planned')} value={String(counts.upcoming)} sub="S2 · S3 · S4" />
      </Grid>

      <StageRail onPick={select} s1Live={s1Live} />

      {PHASES.map((p) => (
        <DocSection key={p.id} id={p.id} label={t(p.title)} kicker={`${p.q} · ${t(STATUS_LABEL[p.status])}`}>
          <GlassCard
            title={`${p.q} · ${t(p.title)}`}
            icon={PHASE_ART[p.id]}
            accent={<HoloBadge label={t(STATUS_LABEL[p.status])} tone={STATUS_TONE[p.status]} variant="solid" pulse={p.status === 'in-progress'} />}
            bar={p.status === 'completed' ? 'holo' : p.status === 'in-progress' ? 'pink' : 'lilac'}
          >
            <P>{t(p.summary)}</P>
            <Checklist items={p.items} status={p.status} />
            {p.id === 's1' && (
              <HoloText tone={s1Live === false ? 'warn' : 'muted'} size="xs">
                {s1Live === true
                  ? t('roadmapPage.s1Check.ok')
                  : s1Live === false
                  ? t('roadmapPage.s1Check.missing')
                  : t('roadmapPage.s1Check.checking')}
              </HoloText>
            )}
          </GlassCard>
        </DocSection>
      ))}

      <DocSection id="principles" label={t('roadmapPage.nav.principles')} kicker={t('roadmapPage.nav.meta')}>
        <GlassCard title={t('roadmapPage.nav.principles')} icon="/icons/spare-logo.png">
          <P>{t('apps-b:roadmap.principles')}</P>
        </GlassCard>
        <GlassCard title={t('apps-b:roadmap.wontTitle')} bar="pink">
          <H3>{t('apps-b:roadmap.wontTitle')}</H3>
          <Bullets items={WONT.map((k) => t(k))} />
        </GlassCard>
      </DocSection>

      <DocSection id="changelog" label={t('roadmapPage.nav.changelog')}>
        <ol className="rm-log">
          {CHANGELOG.map((c) => (
            <li key={c.id}>
              {c.date ? <HoloBadge label={t(c.date)} tone="ink" variant="solid" /> : <HoloBadge label="S1" tone="muted" />}
              <span className="rm-log__text">{t(c.text)}</span>
            </li>
          ))}
        </ol>
        <Ctas>
          <LinkButton to="/" variant="primary">
            {t('roadmapPage.cta.open')}
          </LinkButton>
          <LinkButton to="/whitepaper">{t('roadmapPage.cta.whitepaper')}</LinkButton>
          <LinkButton to="/docs">{t('publicRoutes.docs.tagline')}</LinkButton>
        </Ctas>
      </DocSection>
    </PublicShell>
  );
}

const ROADMAP_CSS = `
.rm-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.rm-check { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(min(260px, 100%), 1fr)); gap: 6px 16px; }
.rm-check li {
  display: flex; align-items: flex-start; gap: 9px; padding: 5px 0;
  border-bottom: 1px dashed rgba(154,139,224,.6);
  font-family: var(--holo-font-text); font-size: 12.5px; line-height: 1.5; color: #2A1B6E;
}
.rm-check__box {
  flex-shrink: 0; width: 18px; height: 18px; margin-top: 1px;
  display: inline-flex; align-items: center; justify-content: center;
  background: #FFFDFB; box-shadow: var(--holo-well);
}
.rm-check li.is-done .rm-check__box {
  background: linear-gradient(180deg, #4B36B8 0%, #2A1B6E 100%);
  box-shadow: inset 1px 1px 0 #7B63E0, 0 0 0 1px #2A1B6E;
}
.rm-check li.is-active .rm-check__box { background: repeating-linear-gradient(135deg, #FFE0A3 0 3px, #FFFDFB 3px 6px); }

.rm-rail { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 16px; }
.rm-rail__node {
  position: relative; display: flex; flex-direction: column; align-items: flex-start; gap: 5px;
  padding: 10px; border: 2px solid #2A1B6E; text-align: left; cursor: pointer; min-width: 0;
  background: linear-gradient(160deg, #FFFFFF 0%, #FFF5EE 38%, #FBEEFF 70%, #EDF1FF 100%);
  box-shadow: inset 0 0 0 1px #FFFFFF, 3px 3px 0 0 rgba(42,27,110,.2);
  font: inherit; color: #2A1B6E;
}
.rm-rail__node:hover { transform: translate(-1px, -1px); box-shadow: inset 0 0 0 1px #FFFFFF, 5px 5px 0 0 rgba(42,27,110,.24); }
.rm-rail__node:focus-visible { outline: 2px dotted #2A1B6E; outline-offset: 3px; }
.rm-rail__node:not(:last-child)::after {
  content: ''; position: absolute; top: 22px; right: -16px; width: 14px; height: 2px;
  background-image: linear-gradient(90deg, #2A1B6E 50%, transparent 50%); background-size: 4px 2px;
}
.rm-rail__node--completed { background: var(--holo-dither) 0 0 / 4px 4px, linear-gradient(135deg, #FFF6DF 0%, #FFD0EA 30%, #DCCBFF 56%, #BDE6FF 80%, #FFF1E6 100%); }
.rm-rail__key {
  width: 26px; height: 26px; display: inline-flex; align-items: center; justify-content: center;
  background: linear-gradient(180deg, #4B36B8 0%, #2A1B6E 100%); color: #FFF6EE;
  font-family: var(--holo-font-display); font-size: 11px; box-shadow: inset 1px 1px 0 #7B63E0;
}
.rm-rail__node--upcoming .rm-rail__key { background: #FFFDFB; color: #2A1B6E; box-shadow: var(--holo-well); }
.rm-rail__q { font-family: var(--holo-font-pixel); font-weight: 700; font-size: 10px; letter-spacing: .14em; color: #4B36B8; }
.rm-rail__title { font-family: var(--holo-font-chrome); font-size: 19px; line-height: 1.05; }
.rm-log { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.rm-log li {
  display: flex; align-items: flex-start; gap: 10px; flex-wrap: wrap; padding: 9px 10px;
  border: 2px solid #2A1B6E; background: linear-gradient(160deg, #FFFFFF 0%, #FFF5EE 38%, #FBEEFF 70%, #EDF1FF 100%);
  box-shadow: inset 0 0 0 1px #FFFFFF, 3px 3px 0 0 rgba(42,27,110,.18);
}
.rm-log__text { flex: 1 1 260px; min-width: 0; font-family: var(--holo-font-text); font-size: 12.5px; line-height: 1.55; color: #2A1B6E; }
@media (max-width: 1100px) {
  .rm-rail { grid-template-columns: repeat(auto-fit, minmax(min(170px, 100%), 1fr)); }
  .rm-rail__node::after { display: none; }
}
@media (max-width: 767px) {
  .rm-rail { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
  .rm-rail__node:last-child { grid-column: 1 / -1; }
  .rm-rail__title { font-size: 18px; }
}
`;
