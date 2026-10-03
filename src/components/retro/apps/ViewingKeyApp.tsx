/**
 * ViewingKeyApp — a preview of the S2 private path. None of it is live.
 *
 * The shielded pool, stealth funding, viewing keys and solvency proofs are not
 * built, and every sweep settles publicly to the account's wallet. The window
 * opens with a "preview, not live" banner, explains what the private path
 * would take, and lets the visitor switch the route picture between public and
 * private. That switch is local component state: it is not saved and nothing
 * reads it.
 *
 * The app shows no key material. A string that looks like a viewing key would
 * be saved and trusted by whoever saw it, while protecting nothing.
 *
 * Layout: a glass "pool" in the middle with four labelled callouts around it,
 * each marked as design.
 */
import { useState, type CSSProperties, type ReactNode } from 'react';
import { Trans, tKey, useTranslation } from '@/i18n';
import {
  FONT_CHROME,
  FONT_PIXEL,
  FONT_TEXT,
  GRADIENT,
  HOLO,
  INK,
  INK_ON_LIGHT,
  TEXTURE,
  pixelPath,
  HoloBadge,
  HoloCard,
  HoloHero,
  HoloLabel,
  HoloNotice,
  HoloPanel,
  HoloSegmented,
  HoloSparkles,
  HoloStar,
  HoloStat,
  HoloTitle,
  type HoloTone,
} from '@/components/retro/holo';
import { AppCanvas, MutedWell } from './spare/SpareUi';
import { HINT } from './spare/styles';

/** One prerequisite for the private path. Status is a requirement, not progress. `piece` / `why` are apps-b keys. */
interface ShipItem {
  id: string;
  piece: string;
  why: string;
}

const CHECKLIST: ShipItem[] = [
  { id: 'notes', piece: tKey('viewingKey.items.notes.piece'), why: tKey('viewingKey.items.notes.why') },
  { id: 'stealth', piece: tKey('viewingKey.items.stealth.piece'), why: tKey('viewingKey.items.stealth.why') },
  { id: 'key', piece: tKey('viewingKey.items.key.piece'), why: tKey('viewingKey.items.key.why') },
  { id: 'proof', piece: tKey('viewingKey.items.proof.piece'), why: tKey('viewingKey.items.proof.why') },
  { id: 'custody', piece: tKey('viewingKey.items.custody.piece'), why: tKey('viewingKey.items.custody.why') },
];

/* ───────────────────────────── pixel glyphs ───────────────────────────── */

const ICON_LOCK = [
  '00011111000',
  '00110001100',
  '00100000100',
  '00100000100',
  '11111111111',
  '11111111111',
  '11111011111',
  '11110001111',
  '11111011111',
  '11111011111',
  '11111111111',
  '11111111111',
];
const ICON_EYE = [
  '000011110000',
  '001100001100',
  '011001100110',
  '110011110011',
  '110011110011',
  '011001100110',
  '001100001100',
  '000011110000',
];
const ICON_BOOK = [
  '0111110111110',
  '1000001000001',
  '1011101011101',
  '1000001000001',
  '1011101011101',
  '1000001000001',
  '1011101011101',
  '1000001000001',
  '1111111111111',
];
const ICON_SHIELD = [
  '11111111111',
  '10000000001',
  '10000000101',
  '10000001001',
  '10100010001',
  '10010100001',
  '10001000001',
  '01000000010',
  '00100000100',
  '00010001000',
  '00001010000',
  '00000100000',
];

function PixelIcon({ rows, scale = 2, color = HOLO.ink }: { rows: readonly string[]; scale?: number; color?: string }) {
  const w = rows[0].length;
  const h = rows.length;
  return (
    <svg aria-hidden focusable="false" width={w * scale} height={h * scale} viewBox={`0 0 ${w} ${h}`} shapeRendering="crispEdges" style={{ display: 'block', flexShrink: 0 }}>
      <path d={pixelPath(rows)} fill={color} />
    </svg>
  );
}

/* ─────────────────────── container-query layout (this app only) ─────────────────────── */

/*
 * Wide layout: four callouts around the pool, two per row:
 *
 *     [ Your data yours    ]   [ Unlinkable wallet  ]
 *               |                         |
 *               o------[ ✦ POOL ]---------o        ← short pool band, orbit ring behind it
 *               |                         |
 *     [ Read your own book ]   [ Proof of backing   ]
 *
 * Each callout gets half the diagram (~330px at the default window width) instead of
 * a third, so the longest one reads in ~8 lines rather than 10+. The wires are
 * drawn by the pool band itself (stems reach up/down through the row gaps), so
 * they always land on the callouts' inner edges whatever height the copy wraps to.
 * Narrow (≤600px container): one column, pool first, no wires — unchanged.
 */
const VK_CSS = `
.vk-diagram { position: relative; isolation: isolate; overflow: hidden; container-type: inline-size; display: flex; flex-direction: column; gap: 12px; padding: 14px; min-width: 0; }
.vk-diagram__head { position: relative; display: flex; align-items: flex-end; justify-content: space-between; gap: 8px 12px; flex-wrap: wrap; }
.vk-grid { --vk-gx: 16px; --vk-gy: 22px; position: relative; display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); grid-template-areas: "a b" "core core" "c d"; gap: var(--vk-gy) var(--vk-gx); }
.vk-grid > .vk-cell { position: relative; z-index: 1; min-width: 0; }
.vk-cell--callout { display: flex; flex-direction: column; }
.vk-cell--callout > * { flex: 1 1 auto; }
.vk-core { display: flex; align-items: center; justify-content: center; min-height: 92px; }
.vk-wires { position: absolute; left: 0; right: 0; top: calc(-1 * var(--vk-gy)); bottom: calc(-1 * var(--vk-gy)); z-index: 0; pointer-events: none; }
.vk-wires__ring { position: absolute; left: 2%; top: calc(var(--vk-gy) - 8px); width: 96%; height: calc(100% - 2 * var(--vk-gy) + 16px); overflow: visible; }
.vk-wires__stem { position: absolute; top: 0; bottom: 0; width: 2px; margin-left: -1px; background: rgba(42, 27, 110, .55); }
.vk-wires__rail { position: absolute; top: 50%; height: 2px; margin-top: -1px; left: calc((100% - var(--vk-gx)) / 4); right: calc((100% - var(--vk-gx)) / 4); background: rgba(42, 27, 110, .55); }
.vk-wires__orb { position: absolute; top: 50%; width: 18px; height: 18px; margin: -9px 0 0 -9px; border-radius: 50%; background: radial-gradient(circle at 34% 30%, #FFFFFF 0 16%, #FFE3F4 32%, #D9CCFF 56%, #9FB4FF 80%, #7B63E0 100%); box-shadow: 0 0 0 2px #2A1B6E, inset 0 0 0 1px rgba(255, 255, 255, .8), 2px 2px 0 1px rgba(42, 27, 110, .2); }
.vk-wires__l { left: calc((100% - var(--vk-gx)) / 4); }
.vk-wires__r { left: calc(100% - (100% - var(--vk-gx)) / 4); }
.vk-vault { position: relative; z-index: 1; overflow: hidden; display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 8px 14px; max-width: calc(50% - 48px); padding: 10px 20px 10px 14px; }
.vk-vault__text { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; min-width: 0; }
.vk-vault__note { font-family: var(--holo-font-text); font-size: 11px; color: #5140B8; }
@container (max-width: 600px) {
  .vk-grid { grid-template-columns: minmax(0, 1fr); grid-template-areas: "core" "a" "b" "c" "d"; gap: 10px; }
  .vk-wires { display: none; }
  .vk-core { min-height: 0; }
  .vk-vault { width: 100%; max-width: none; justify-content: flex-start; gap: 8px 12px; padding: 10px 12px; }
}
`;

/* ─────────────────────────────────── the app ─────────────────────────────────── */

export function ViewingKeyApp() {
  const { t } = useTranslation('apps-b');
  /** Which route the picture shows. Not saved: there is no private route to choose. */
  const [privatePath, setPrivatePath] = useState(false);

  const emphasis = (color: string): CSSProperties => ({ color, fontWeight: 700 });

  return (
    <AppCanvas>
      <style>{VK_CSS}</style>

      <HoloNotice tone="warn" title={t('viewingKey.preview.title')} live="none">
        {t('viewingKey.preview.body')}
      </HoloNotice>

      <HoloHero
        art="/icons/spare/viewing-key.png"
        kicker={t('viewingKey.hero.kicker')}
        title={t('shell:appNames.viewing-key')}
        subtitle={t('viewingKey.hero.subtitle')}
        description={t('viewingKey.hero.description')}
        aside={
          <>
            <HoloBadge label={t('shared.notBuilt')} tone="warn" variant="solid" dot />
            <HoloBadge label={t('viewingKey.hero.noKey')} tone="muted" dot={false} />
          </>
        }
        seed={31}
      />

      <HoloNotice tone="warn" title={t('shared.readFirst')} action={<HoloBadge label={t('shared.notBuilt')} tone="warn" variant="fill" />}>
        <span style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span>
            <Trans t={t} i18nKey="viewingKey.read.p1" components={{ warn: <span style={emphasis(INK.warn)} /> }} />
          </span>
          <span>
            <Trans t={t} i18nKey="viewingKey.read.p2" components={{ info: <span style={emphasis(INK.info)} /> }} />
          </span>
          <span>{t('viewingKey.read.p3')}</span>
        </span>
      </HoloNotice>

      <HoloCard title={t('viewingKey.route.title')} accent={t('viewingKey.route.accent')} accentTone="warn">
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: '8px 12px', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
            <HoloLabel>{t('viewingKey.route.label')}</HoloLabel>
            <HoloSegmented
              value={privatePath ? 'private' : 'public'}
              onChange={(v) => setPrivatePath(v === 'private')}
              ariaLabel={t('viewingKey.route.aria')}
              options={[
                { value: 'public', label: t('viewingKey.route.optPublic') },
                { value: 'private', label: t('viewingKey.route.optPrivate') },
              ]}
            />
          </div>
        </div>

        <RouteLanes privatePath={privatePath} />

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 8 }}>
          <Readout label={t('viewingKey.readout.route')} value={t('viewingKey.readout.public')} tone="ink" />
          <Readout label={t('viewingKey.readout.saved')} value={t('viewingKey.readout.no')} tone="muted" />
          <Readout label={t('viewingKey.readout.key')} value={t('viewingKey.readout.none')} tone="muted" />
          <Readout label={t('viewingKey.readout.today')} value={t('viewingKey.readout.no')} tone="warn" />
        </div>
      </HoloCard>

      <PrivatePathDiagram />

      <HoloCard
        title={t('viewingKey.prereq.title')}
        bar="lilac"
        accent={t('viewingKey.prereq.count', { count: CHECKLIST.length })}
        accentTone="ink"
      >
        <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column' }}>
          {CHECKLIST.map((it, i) => (
            <li
              key={it.id}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: '6px 12px',
                flexWrap: 'wrap',
                padding: '9px 2px',
                borderBottom: i < CHECKLIST.length - 1 ? `1px dashed ${HOLO.inkFaint}` : 0,
              }}
            >
              <StepCoin n={i + 1} />
              <div style={{ flex: '1 1 220px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
                <span style={{ fontFamily: FONT_CHROME, fontWeight: 400, fontSize: 19, lineHeight: 1.05, color: INK.body }}>{t(it.piece)}</span>
                <span style={{ ...HINT, fontSize: 11.5 }}>{t(it.why)}</span>
              </div>
              <HoloBadge label={t('viewingKey.prereq.required')} tone="muted" dot={false} style={{ marginTop: 2 }} />
            </li>
          ))}
        </ol>
      </HoloCard>

      <HoloCard title={t('viewingKey.balance.title')} accent={t('shared.notBuilt')} accentTone="warn" bar="pink">
        <MutedWell>
          <span style={{ display: 'block', marginBottom: 6, fontFamily: FONT_PIXEL, fontSize: 11, letterSpacing: 1.5, textTransform: 'uppercase', color: INK.warn }}>
            {t('viewingKey.balance.head')}
          </span>
          {t('viewingKey.balance.body')}
        </MutedWell>
      </HoloCard>
    </AppCanvas>
  );
}

/* ─────────────────────────────── route preview ─────────────────────────────── */

function Readout({ label, value, tone }: { label: string; value: string; tone: HoloTone }) {
  return (
    <HoloPanel variant="sunken" texture="none" padding="7px 10px">
      <HoloStat label={label} value={value} tone={tone} size="sm" style={{ width: '100%' }} />
    </HoloPanel>
  );
}

/** The two routes a sweep could take; the one shown is outlined. Only the public one exists. */
function RouteLanes({ privatePath }: { privatePath: boolean }) {
  const { t } = useTranslation('apps-b');
  return (
    <div role="group" aria-label={t('viewingKey.lanes.aria')} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <Lane
        picked={!privatePath}
        to={t('viewingKey.lanes.wallet')}
        note={t('viewingKey.lanes.walletNote')}
        status={<HoloBadge label={t('viewingKey.lanes.only')} tone="good" />}
      />
      <Lane
        picked={privatePath}
        dashed
        to={t('viewingKey.lanes.pool')}
        note={t('viewingKey.notDeployed')}
        status={<HoloBadge label={t('shared.notBuilt')} tone="warn" />}
      />
      {privatePath && <span style={{ ...HINT, color: INK.warn }}>{t('viewingKey.lanes.warn')}</span>}
    </div>
  );
}

function Lane({ picked, dashed = false, to, note, status }: { picked: boolean; dashed?: boolean; to: string; note: string; status: ReactNode }) {
  const { t } = useTranslation('apps-b');
  const wire = `2px ${dashed ? 'dashed' : 'solid'} ${picked ? HOLO.ink : HOLO.bevelLo}`;
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: '6px 10px',
        padding: '7px 10px',
        background: picked ? 'rgba(255,255,255,.85)' : 'transparent',
        boxShadow: picked ? `0 0 0 2px ${HOLO.ink}, 3px 3px 0 2px rgba(42,27,110,.18)` : `inset 0 0 0 1px ${HOLO.bevelLo}`,
        opacity: picked ? 1 : 0.82,
      }}
    >
      <HoloBadge label={t('viewingKey.lanes.sweep')} variant="solid" />
      <span aria-hidden style={{ flex: '1 1 28px', minWidth: 28, maxWidth: 140, borderTop: wire, position: 'relative', height: 0 }}>
        <span style={{ position: 'absolute', right: -2, top: -6, width: 0, height: 0, borderTop: '5px solid transparent', borderBottom: '5px solid transparent', borderLeft: `7px solid ${picked ? HOLO.ink : HOLO.bevelLo}` }} />
      </span>
      <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <span style={{ fontFamily: FONT_CHROME, fontWeight: 400, fontSize: 18, lineHeight: 1.05, color: INK.body }}>{to}</span>
        <span style={{ fontFamily: FONT_TEXT, fontSize: 11, color: INK.muted }}>{note}</span>
      </span>
      <span style={{ flex: 1 }} />
      {status}
      {picked && <HoloBadge label={t('viewingKey.lanes.pick')} variant="solid" tone="holo" dot />}
    </div>
  );
}

/* ─────────────────────────────── design diagram ─────────────────────────────── */

const DIAGRAM_SURFACE: CSSProperties = {
  background: `${TEXTURE.dither} 0 0 / 4px 4px, ${GRADIENT.sky}`,
  border: `2px solid ${HOLO.ink}`,
  boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.9), 4px 4px 0 0 rgba(42,27,110,.22)',
  ...INK_ON_LIGHT,
};

function PrivatePathDiagram() {
  const { t } = useTranslation('apps-b');
  return (
    <section className="vk-diagram" aria-label={t('viewingKey.diagram.label')} style={DIAGRAM_SURFACE}>
      <HoloSparkles count={10} seed={41} sizes={[6, 15]} />
      <div className="vk-diagram__head">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
          <HoloLabel tone="ink">{t('viewingKey.diagram.label')}</HoloLabel>
          <HoloTitle as="h2" size="sm">{t('viewingKey.diagram.title')}</HoloTitle>
        </div>
        <HoloBadge label={t('viewingKey.diagram.badge')} tone="warn" variant="solid" dot />
      </div>

      <div className="vk-grid">
        <Callout area="a" title={t('viewingKey.callout.a.title')} icon={ICON_EYE} lead={t('viewingKey.callout.a.lead')}>
          {t('viewingKey.callout.a.body')}
        </Callout>
        <Callout area="b" title={t('viewingKey.callout.b.title')} icon={ICON_LOCK} lead={t('viewingKey.callout.b.lead')}>
          {t('viewingKey.callout.b.body')}
        </Callout>

        <Vault />

        <Callout area="c" title={t('viewingKey.callout.c.title')} icon={ICON_BOOK} lead={t('viewingKey.callout.c.lead')}>
          {t('viewingKey.callout.c.body')}
        </Callout>
        <Callout area="d" title={t('viewingKey.callout.d.title')} icon={ICON_SHIELD} lead={t('viewingKey.callout.d.lead')}>
          {t('viewingKey.callout.d.body')}
        </Callout>
      </div>
    </section>
  );
}

function Callout({ area, title, icon, lead, children }: { area: string; title: string; icon: readonly string[]; lead: string; children: ReactNode }) {
  return (
    <div className="vk-cell vk-cell--callout" style={{ gridArea: area }}>
      {/* Row-mates share a height; the body fills it so the corner dither sits at the card's foot. */}
      <HoloCard title={title} compact bodyStyle={{ flex: '1 1 auto' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <span
            aria-hidden
            style={{
              flexShrink: 0,
              width: 38,
              height: 38,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: GRADIENT.chrome,
              boxShadow: `0 0 0 2px ${HOLO.ink}, inset 0 0 0 1px #FFFFFF, 2px 2px 0 2px rgba(42,27,110,.2)`,
              margin: 2,
            }}
          >
            <PixelIcon rows={icon} />
          </span>
          <p style={{ margin: 0, minWidth: 0, fontFamily: FONT_TEXT, fontSize: 11.5, lineHeight: 1.55, color: INK.body }}>
            {/* No space after a lead that ends in Chinese punctuation (。). */}
            <strong style={{ color: INK.info }}>{lead}</strong>
            {/[\u3000-\u303f\uff00-\uffef]$/.test(lead) ? '' : ' '}
            {children}
          </p>
        </div>
      </HoloCard>
    </div>
  );
}

/**
 * The glass pool at the centre of the diagram (not deployed). A short band
 * between the two rows of callouts; in the wide layout it also carries the
 * wiring: an orbit ring behind the glass, a rail out to two chrome orbs, and stems
 * from each orb up/down through the row gaps to the callouts' inner edges.
 */
const GLASS: CSSProperties = {
  background: [
    'linear-gradient(rgba(255,255,255,.35) 1px, transparent 1px) 0 0 / 12px 12px',
    'linear-gradient(90deg, rgba(255,255,255,.35) 1px, transparent 1px) 0 0 / 12px 12px',
    'linear-gradient(145deg, rgba(255,255,255,.78) 0%, rgba(233,221,255,.5) 45%, rgba(189,235,255,.55) 100%)',
  ].join(', '),
  border: `2px solid ${HOLO.ink}`,
  boxShadow: 'inset 0 0 0 1px #FFFFFF, inset 0 0 26px rgba(255,255,255,.9), 4px 4px 0 0 rgba(42,27,110,.22)',
  backdropFilter: 'blur(6px)',
  WebkitBackdropFilter: 'blur(6px)',
};

function Vault() {
  const { t } = useTranslation('apps-b');
  return (
    <div className="vk-cell vk-core" style={{ gridArea: 'core' }}>
      <div className="vk-wires" aria-hidden>
        <svg className="vk-wires__ring" focusable="false" viewBox="0 0 100 100" preserveAspectRatio="none">
          <ellipse cx="50" cy="50" rx="40" ry="44" fill="none" stroke="#FFFFFF" strokeOpacity=".95" strokeWidth="1.5" strokeDasharray="2 5" vectorEffect="non-scaling-stroke" />
        </svg>
        <span className="vk-wires__stem vk-wires__l" />
        <span className="vk-wires__stem vk-wires__r" />
        <span className="vk-wires__rail" />
        <span className="vk-wires__orb vk-wires__l" />
        <span className="vk-wires__orb vk-wires__r" />
      </div>
      <div className="vk-vault" role="img" aria-label={t('viewingKey.vault.aria')} style={GLASS}>
        <HoloStar size={64} animated />
        <span className="vk-vault__text">
          <HoloBadge label={t('viewingKey.vault.badge')} variant="solid" />
          <span className="vk-vault__note" style={{ color: INK.muted }}>{t('viewingKey.notDeployed')}</span>
        </span>
      </div>
    </div>
  );
}

/** Numbered chrome coin for the prerequisite list. */
function StepCoin({ n }: { n: number }) {
  return (
    <span
      aria-hidden
      style={{
        flexShrink: 0,
        width: 28,
        height: 28,
        borderRadius: '50%',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: GRADIENT.chrome,
        boxShadow: `0 0 0 2px ${HOLO.ink}, inset 0 0 0 1px #FFFFFF, 2px 2px 0 1px rgba(42,27,110,.2)`,
        fontFamily: FONT_TEXT,
        fontWeight: 700,
        fontSize: 13,
        lineHeight: 1,
        color: HOLO.ink,
        margin: 2,
      }}
    >
      {n}
    </span>
  );
}

export default ViewingKeyApp;
