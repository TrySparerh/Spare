/**
 * Roadmap — the Spare roadmap (src/content/roadmap.ts, the same stages as
 * /roadmap) as poster cards with status chips. Order, not dates: each stage
 * is labelled S1…S4 and marked LIVE only once it is on mainnet.
 */
import { ROADMAP_PRINCIPLES, WONT_SHIP, roadmapPhases, type RoadmapStatus } from '@/content/roadmap';
import { tKey, useTranslation } from '@/i18n';
import {
  FONT_TEXT,
  HOLO,
  INK,
  HoloButton,
  HoloCard,
  HoloHero,
  HoloWindowBody,
  type HoloTone,
} from '@/components/retro/holo';
import { ROW } from './spare/styles';

/** Status chips; `label` is an apps-b key. */
const STATUS: Record<RoadmapStatus, { label: string; tone: HoloTone; dot: string }> = {
  completed: { label: tKey('roadmap.status.live'), tone: 'good', dot: HOLO.goodFill },
  'in-progress': { label: tKey('roadmap.status.inProgress'), tone: 'warn', dot: HOLO.warnFill },
  upcoming: { label: tKey('roadmap.status.planned'), tone: 'info', dot: HOLO.infoFill },
};

export function RoadmapApp() {
  const { t } = useTranslation('apps-b');
  const live = roadmapPhases.filter((m) => m.status === 'completed').length;
  return (
    <HoloWindowBody>
      <HoloHero
        kicker={t('shell:appNames.roadmap')}
        title={t('roadmap.hero.title')}
        subtitle={t('roadmap.hero.subtitle')}
        description={t('roadmap.hero.description')}
        compact
        seed={7}
      >
        <div style={{ ...ROW, marginTop: 2 }}>
          <HoloButton size="sm" onClick={() => window.open('/roadmap', '_blank', 'noopener,noreferrer')}>
            {t('roadmap.openFull')}
          </HoloButton>
          <span style={{ fontFamily: FONT_TEXT, fontSize: 11, color: INK.muted }}>
            {t('roadmap.count', { live, toCome: roadmapPhases.length - live })}
          </span>
        </div>
      </HoloHero>

      {roadmapPhases.map((m) => {
        const st = STATUS[m.status];
        return (
          <HoloCard key={m.id} title={`${m.q} · ${t(m.title)}`} accent={t(st.label)} accentTone={st.tone}>
            <p style={{ margin: 0, fontFamily: FONT_TEXT, fontSize: 12, lineHeight: 1.55, color: INK.body }}>{t(m.summary)}</p>
            <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 5 }}>
              {m.items.map((it) => (
                <li key={it.text} style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontFamily: FONT_TEXT, fontSize: 11.5, lineHeight: 1.45, color: INK.body }}>
                  <span
                    aria-hidden
                    style={{
                      width: 8,
                      height: 8,
                      flexShrink: 0,
                      background: it.done ? HOLO.goodFill : st.dot,
                      boxShadow: `0 0 0 1px ${HOLO.ink}`,
                      transform: 'translateY(-1px)',
                    }}
                  />
                  <span>
                    {t(it.text)}
                    {it.done && <span style={{ color: INK.good, fontWeight: 700 }}> ✓</span>}
                  </span>
                </li>
              ))}
            </ul>
          </HoloCard>
        );
      })}

      <HoloCard title={t('roadmap.wontTitle')} bar="lilac" compact>
        <ul style={{ margin: 0, paddingLeft: 18, fontFamily: FONT_TEXT, fontSize: 11.5, lineHeight: 1.6, color: INK.body }}>
          {WONT_SHIP.map((w) => (
            <li key={w}>{t(w)}</li>
          ))}
        </ul>
        <span style={{ fontFamily: FONT_TEXT, fontSize: 10.5, lineHeight: 1.5, color: INK.muted }}>{t(ROADMAP_PRINCIPLES)}</span>
      </HoloCard>
    </HoloWindowBody>
  );
}

export default RoadmapApp;
