/**
 * /mcp — Spare MCP: how to connect any MCP client, and the seven read-only
 * tools it serves.
 *
 * The status line reads the Spare API live (`GET /health`, `GET /api/mcp/tools`).
 * The API may not be deployed yet: then the page says "offline" and still
 * shows the full connect guide and the tool list from the spec. Only the
 * known `spare_*` tools are ever rendered, whatever a server returns.
 *
 * Text: pages-b namespace (`mcp.*`; tool blurbs `mcpTools.*`).
 */
import type { CSSProperties, ReactNode } from 'react';
import {
  FONT_TEXT,
  HOLO,
  INK,
  HoloBadge,
  HoloCard,
  HoloHero,
  HoloNotice,
  HoloStar,
} from '@/components/retro/holo';
import { LivePageFrame } from '@/components/public/live/LivePageFrame';
import { Bullets, CodeBlock, CopyButton, CtaRow, Grid, LinkButton, Mono, Prose } from '@/components/public/live/LiveAtoms';
import { usePageMeta } from '@/components/public/live/pageMeta';
import { SPARE_MCP_ENDPOINT, SPARE_MCP_TOOLS, useSpareApi, type SpareApiStatus, type SpareToolDoc, type SpareToolName } from '@/components/public/live/spareApi';
import { Trans, tKey, useTranslation } from '@/i18n';

/** A client that connects to remote MCP servers over Streamable HTTP. */
const HTTP_CONFIG = `{
  "mcpServers": {
    "spare": {
      "type": "http",
      "url": "${SPARE_MCP_ENDPOINT}"
    }
  }
}`;

/** A client that only starts local (stdio) servers: the mcp-remote bridge. */
const STDIO_CONFIG = `{
  "mcpServers": {
    "spare": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "${SPARE_MCP_ENDPOINT}"]
    }
  }
}`;

const TRY_ASKING = [tKey('mcp.tryAsking.q1'), tKey('mcp.tryAsking.q2'), tKey('mcp.tryAsking.q3'), tKey('mcp.tryAsking.q4')];

const SAFE = [tKey('mcp.safe.readOnly'), tKey('mcp.safe.publicData'), tKey('mcp.safe.noLogin')];

/** Tool blurbs live in spareApi.ts; their translations are keyed by tool name. */
const TOOL_BLURB: Record<SpareToolName, string> = {
  spare_universe: tKey('mcpTools.universe'),
  spare_account: tKey('mcpTools.account'),
  spare_roundup_preview: tKey('mcpTools.roundupPreview'),
  spare_quote: tKey('mcpTools.quote'),
  spare_activity: tKey('mcpTools.activity'),
  spare_contracts: tKey('mcpTools.contracts'),
  spare_fees: tKey('mcpTools.fees'),
};

/** Inline code inside a translated sentence (<mono>…</mono>). */
const MonoTag = ({ children }: { children?: ReactNode }) => <Mono>{children}</Mono>;

function StatusLine({ status, checking }: { status: SpareApiStatus | null; checking: boolean }) {
  const { t } = useTranslation('pages-b');
  const online = !!status?.online;
  const state = checking && !status ? t('mcp.status.checking') : online ? t('mcp.status.online') : t('mcp.status.offline');
  // Live count only — never a hard-coded number while the API is offline or unsure.
  const tools = t('mcp.status.tools', { n: online && status?.toolCount != null ? status.toolCount : checking && !status ? '…' : '—' });
  return (
    <div
      role="status"
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: '6px 10px',
        padding: '8px 12px',
        background: HOLO.paper,
        boxShadow: 'var(--holo-well)',
        fontFamily: FONT_TEXT,
        fontSize: 12.5,
        color: INK.body,
        minWidth: 0,
      }}
    >
      <HoloBadge label={state.toUpperCase()} tone={online ? 'good' : checking && !status ? 'muted' : 'warn'} variant="fill" pulse={checking && !status} />
      <span style={{ fontWeight: 700 }}>Spare MCP</span>
      <span aria-hidden style={{ color: INK.muted }}>·</span>
      <span>{state}</span>
      <span aria-hidden style={{ color: INK.muted }}>·</span>
      <span>{tools}</span>
      <span aria-hidden style={{ color: INK.muted }}>·</span>
      <span style={{ overflowWrap: 'anywhere', minWidth: 0 }} translate="no">
        {SPARE_MCP_ENDPOINT}
      </span>
    </div>
  );
}

function ConnectCard({ title, note, code, lang }: { title: string; note?: string; code: string; lang: string }) {
  return (
    <HoloCard title={title} compact flat>
      {note && (
        <Prose muted style={{ fontSize: 11.5 }}>
          {note}
        </Prose>
      )}
      <CodeBlock code={code} lang={lang} />
    </HoloCard>
  );
}

function ToolStatus({ name, status }: { name: SpareToolDoc['name']; status: SpareApiStatus | null }) {
  const { t } = useTranslation('pages-b');
  if (!status?.online) return <HoloBadge label={t('mcp.tool.offline')} tone="muted" />;
  if (status.liveTools?.has(name)) return <HoloBadge label={t('mcp.tool.live')} tone="good" />;
  if (status.liveTools) return <HoloBadge label={t('mcp.tool.notListed')} tone="warn" />;
  return <HoloBadge label="—" tone="muted" />;
}

export default function Mcp() {
  const { t } = useTranslation('pages-b');
  usePageMeta(t('mcp.meta.title'), t('mcp.meta.description'));
  const { status, checking } = useSpareApi();
  const online = !!status?.online;
  // The blurb lives in spareApi.ts: show the translation only while our English copy still matches it.
  const blurb = (tool: SpareToolDoc) => (t(TOOL_BLURB[tool.name], { lng: 'en' }) === tool.blurb ? t(TOOL_BLURB[tool.name]) : tool.blurb);

  const quote: CSSProperties = { margin: 0, fontFamily: FONT_TEXT, fontSize: 12.5, lineHeight: 1.55, color: INK.body, flex: 1, minWidth: 0 };

  return (
    <LivePageFrame exeTitle="Spare — MCP.exe" banner={t('mcp.banner')} live={online}>
      <HoloHero
        kicker="Spare MCP · Robinhood Chain"
        title={t('mcp.hero.title')}
        description={t('mcp.hero.description')}
        art={<HoloStar size={84} />}
        aside={<HoloBadge label={t('mcp.readOnly')} variant="solid" size="md" />}
        seed={31}
      />

      <StatusLine status={status} checking={checking} />

      {!checking && !online && (
        <HoloNotice tone="warn" title={t('mcp.offline.title')}>
          {t('mcp.offline.body')}
        </HoloNotice>
      )}

      <HoloCard title={t('mcp.oneLiner.title')} accent="STREAMABLE HTTP" accentTone="info">
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <span
            translate="no"
            style={{
              flex: '1 1 260px',
              minWidth: 0,
              padding: '8px 10px',
              background: HOLO.screen,
              boxShadow: 'var(--holo-well)',
              color: HOLO.onScreen,
              fontFamily: FONT_TEXT,
              fontWeight: 700,
              fontSize: 13,
              overflowWrap: 'anywhere',
            }}
          >
            {SPARE_MCP_ENDPOINT}
          </span>
          <CopyButton text={SPARE_MCP_ENDPOINT} label={t('mcp.oneLiner.copy')} />
        </div>
        <Prose muted style={{ fontSize: 11.5 }}>
          {t('mcp.oneLiner.note')}
        </Prose>
      </HoloCard>

      <HoloCard title={t('mcp.connect.title')}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
          <Prose muted style={{ fontSize: 11.5 }}>
            <Trans t={t} i18nKey="mcp.connect.intro" components={{ mono: <MonoTag /> }} />
          </Prose>
          <ConnectCard title={t('mcp.connect.httpTitle')} note={t('mcp.connect.httpNote')} code={HTTP_CONFIG} lang="json" />
          <ConnectCard title={t('mcp.connect.stdioTitle')} note={t('mcp.connect.stdioNote')} code={STDIO_CONFIG} lang="json" />
          <HoloCard title={t('mcp.connect.anyTitle')} compact flat>
            <Prose>{t('mcp.connect.anyBody')}</Prose>
            <Prose muted style={{ fontSize: 11.5 }}>
              <Trans t={t} i18nKey="mcp.connect.anyRpc" components={{ mono: <MonoTag /> }} />
            </Prose>
          </HoloCard>
        </div>
      </HoloCard>

      <HoloCard
        title={t('mcp.tools.title')}
        accent={online && status?.toolCount != null ? t('mcp.tools.accentLive', { n: status.toolCount }) : t('mcp.readOnly')}
        accentTone={online ? 'good' : 'info'}
      >
        <Prose muted style={{ fontSize: 11.5 }}>
          {online ? t('mcp.tools.introOnline') : t('mcp.tools.introOffline')}
        </Prose>
        <Grid min={280} gap={10}>
          {SPARE_MCP_TOOLS.map((tool) => (
            <div
              key={tool.name}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
                padding: '8px 10px',
                background: 'rgba(255,255,255,.72)',
                boxShadow: `inset 0 0 0 1px ${HOLO.bevelLo}, 2px 2px 0 0 rgba(42,27,110,.14)`,
                minWidth: 0,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, minWidth: 0 }}>
                <span translate="no" style={{ fontFamily: FONT_TEXT, fontWeight: 700, fontSize: 13, color: INK.body, overflowWrap: 'anywhere' }}>
                  {tool.name}
                </span>
                <ToolStatus name={tool.name} status={status} />
              </div>
              <p style={{ margin: 0, fontFamily: FONT_TEXT, fontSize: 12, lineHeight: 1.55, color: INK.body }}>{blurb(tool)}</p>
              <p translate="no" style={{ margin: 0, fontFamily: FONT_TEXT, fontSize: 11, lineHeight: 1.5, color: INK.muted, overflowWrap: 'anywhere' }}>
                {t('mcp.tools.args', { args: tool.args })}
              </p>
            </div>
          ))}
        </Grid>
        <Prose muted style={{ fontSize: 11.5 }}>
          {t('mcp.tools.footer')}
        </Prose>
      </HoloCard>

      <Grid min={300} gap={16}>
        <HoloCard title={t('mcp.tryAsking.title')} bar="lilac">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {TRY_ASKING.map((key) => {
              const q = t(key);
              return (
                <div
                  key={key}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '6px 8px',
                    background: 'rgba(255,255,255,.7)',
                    boxShadow: `inset 0 0 0 1px ${HOLO.bevelLo}`,
                    minWidth: 0,
                  }}
                >
                  <p style={quote}>{t('mcp.tryAsking.quoted', { q })}</p>
                  <CopyButton text={q} label={t('shell:common.copy')} />
                </div>
              );
            })}
          </div>
        </HoloCard>
        <HoloCard title={t('mcp.safe.title')} bar="pink">
          <Bullets items={SAFE.map((key) => t(key))} />
        </HoloCard>
      </Grid>

      <CtaRow>
        <LinkButton to="/devtools" variant="primary">
          {t('common.devtools')}
        </LinkButton>
        <LinkButton to="/docs">{t('shell:appNames.docs')}</LinkButton>
      </CtaRow>
    </LivePageFrame>
  );
}
