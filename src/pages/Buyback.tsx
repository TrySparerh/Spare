/**
 * /buyback — where Spare's fees go.
 *
 * Live, straight from Robinhood Chain (no backend in the path):
 *   - FeeVault's USDG + WETH balances and the live fee rates
 *   - all-time conversion fees and USDG converted (Σ SweepExecutor.AssetSwept)
 *   - every FeeVault.Withdrawn
 * Then the fee flow, the S3 $SPARE buyback plan (not live, no address) and
 * the withdrawals table. A value that can't be read shows "—".
 *
 * Text: pages-b namespace (`buyback.*`).
 */
import { useQuery } from '@tanstack/react-query';
import type { CSSProperties, ReactNode } from 'react';
import { usePublicClient } from 'wagmi';
import type { PublicClient } from 'viem';
import {
  FONT_CHROME,
  FONT_PIXEL,
  FONT_TEXT,
  GRADIENT,
  HOLO,
  HoloBadge,
  HoloCard,
  HoloDivider,
  HoloHero,
  HoloList,
  HoloListRow,
  HoloNotice,
  HoloStat,
  HoloTable,
  INK,
  TEXTURE,
  type HoloColumn,
} from '@/components/retro/holo';
import { AddrLink, DeployingNotice, Hint, TxLink } from '@/components/retro/apps/spare/SpareUi';
import { CtaRow, HoloLinkButton, HoloPageWindow, X_URL, usePageMeta } from '@/components/public/HoloPageWindow';
import { useSpareDeployment } from '@/lib/spare-chain/hooks';
import { SPARE, SPARE_CHAIN_ID, START_BLOCK, sameAddress, symbolOf } from '@/lib/spare-chain/addresses';
import { blockTimes } from '@/lib/spare-chain/activity';
import { WETH } from '@/lib/spare-chain/fund-swap';
import { FUND_FEE_BPS, useFeeVault, useProtocolLedger, type FeeWithdrawal } from '@/lib/spare-chain/protocol-stats';
import { formatBps, formatToken, formatUsd } from '@/lib/spare';
import { Trans, tKey, useTranslation } from '@/i18n';
import { useAssetNames } from '@/lib/spare-chain/universe';

const DASH = '—';

function pct(bps: number | null): string {
  return bps === null ? DASH : `${formatBps(bps)}%`;
}

function wethText(wei: bigint | null): string {
  return wei === null ? DASH : formatToken(wei, 18, 6);
}

function utc(ts: number | undefined): string {
  if (ts == null) return DASH;
  return `${new Date(ts * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/* ----------------------------------- flow ----------------------------------- */

function FlowNode({
  icon,
  title,
  value,
  note,
  badge,
  tone = 'light',
  dashed = false,
  area,
}: {
  icon?: string;
  title: string;
  value?: ReactNode;
  note: ReactNode;
  badge?: ReactNode;
  tone?: 'light' | 'screen';
  dashed?: boolean;
  area: string;
}) {
  const screen = tone === 'screen';
  return (
    <div
      className="bb-node"
      style={{
        gridArea: area,
        background: screen ? `${TEXTURE.ditherLight} 0 0 / 4px 4px, ${GRADIENT.screen}` : `${TEXTURE.dither} 0 0 / 4px 4px, ${GRADIENT.card}`,
        border: `2px ${dashed ? 'dashed' : 'solid'} ${HOLO.ink}`,
        boxShadow: dashed ? 'none' : `inset 0 0 0 1px #FFFFFF, ${'4px 4px 0 0 rgba(42,27,110,.2)'}`,
        color: screen ? HOLO.onScreen : HOLO.ink,
        opacity: dashed ? 0.92 : 1,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {icon && <img src={icon} alt="" width={28} height={28} draggable={false} style={{ imageRendering: 'pixelated', flexShrink: 0 }} />}
        <span style={{ fontFamily: FONT_CHROME, fontWeight: 400, fontSize: 20, lineHeight: 1.05, flex: '1 1 auto', minWidth: 0 }}>{title}</span>
        {badge}
      </div>
      {value != null && (
        <div style={{ fontFamily: FONT_TEXT, fontWeight: 700, fontSize: 15, lineHeight: 1.3, color: screen ? HOLO.onScreen : HOLO.ink, overflowWrap: 'anywhere' }}>
          {value}
        </div>
      )}
      <div style={{ fontFamily: FONT_TEXT, fontSize: 11.5, lineHeight: 1.5, color: screen ? HOLO.onScreenMuted : HOLO.inkMuted }}>{note}</div>
    </div>
  );
}

function FlowArrow({ label, dashed = false, area, desktopOnly = false }: { label: string; dashed?: boolean; area: string; desktopOnly?: boolean }) {
  return (
    <div className={`bb-arrow${desktopOnly ? ' bb-arrow--desktop' : ''}`} style={{ gridArea: area }} aria-hidden>
      <span className="bb-arrow__label" style={{ opacity: dashed ? 0.85 : 1 }}>
        {label}
      </span>
      <span className="bb-arrow__shaft">
        <span className="bb-arrow__line" style={{ borderStyle: dashed ? 'dashed' : 'solid' }} />
        <svg className="bb-arrow__head" width="10" height="12" viewBox="0 0 5 6" shapeRendering="crispEdges">
          <path d="M0 0h1v6h-1zM1 1h1v4h-1zM2 2h1v2h-1zM3 2h1v2h-1z" fill={HOLO.ink} />
        </svg>
      </span>
    </div>
  );
}

const FLOW_CSS = `
  .bb-flow {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 76px minmax(0, 1.15fr) 76px minmax(0, 1fr);
    grid-template-areas:
      "src1 a1 vault a3 out1"
      "src2 a2 vault a4 out2";
    gap: 12px 6px;
    align-items: center;
  }
  .bb-node { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; min-width: 0; }
  .bb-arrow { display: flex; flex-direction: column; align-items: stretch; gap: 3px; min-width: 0; }
  .bb-arrow__label {
    align-self: center;
    font-family: ${FONT_PIXEL};
    font-size: 10px;
    letter-spacing: .08em;
    text-transform: uppercase;
    color: ${HOLO.ink};
    background: ${HOLO.paper};
    box-shadow: inset 0 0 0 1px ${HOLO.ink};
    padding: 2px 5px;
    white-space: nowrap;
  }
  .bb-arrow__shaft { display: flex; align-items: center; }
  .bb-arrow__line { flex: 1; border-top: 3px solid ${HOLO.ink}; border-left: 0; border-right: 0; border-bottom: 0; height: 0; }
  .bb-arrow__head { flex-shrink: 0; display: block; }
  @media (max-width: 767px) {
    .bb-flow {
      grid-template-columns: minmax(0, 1fr);
      grid-template-areas: "src1" "src2" "a1" "vault" "a3" "out1" "a4" "out2";
      gap: 8px;
    }
    .bb-arrow--desktop { display: none; }
    .bb-arrow { flex-direction: row; align-items: center; justify-content: center; gap: 8px; }
    .bb-arrow__shaft { flex-direction: column; height: 30px; }
    .bb-arrow__line { flex: 1; border-top: 0; border-left-width: 3px; border-left-color: ${HOLO.ink}; height: auto; width: 0; }
    .bb-arrow__head { transform: rotate(90deg); }
  }
`;

/** The four fee-flow steps, in order (the last one is S3). */
const FLOW_STEPS = [
  tKey('buyback.flow.steps.convert'),
  tKey('buyback.flow.steps.swap'),
  tKey('buyback.flow.steps.hold'),
  tKey('buyback.flow.steps.s3'),
] as const;

/* ------------------------------ withdrawals ------------------------------- */

type WithdrawalRow = FeeWithdrawal & { id: string; time?: number } & Record<string, unknown>;

function tokenLabel(token: string): string {
  if (sameAddress(token, WETH)) return 'WETH';
  return symbolOf(token);
}

function amountLabel(w: FeeWithdrawal): string {
  const sym = tokenLabel(w.token);
  if (sym === 'USDG') return `${formatUsd(w.amount)} USDG`;
  return `${formatToken(w.amount, 18, 6)} ${sym}`;
}

/* ---------------------------------- page ---------------------------------- */

const SECTION_GRID: CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14, alignItems: 'start' };

export default function Buyback() {
  const { t } = useTranslation('pages-b');
  usePageMeta(t('buyback.meta.title'), t('buyback.meta.description'));
  // Withdrawn tokens are named from the registry read (symbolOf).
  useAssetNames();

  const deployment = useSpareDeployment();
  const deployed = deployment.deployed;
  const vault = useFeeVault(deployed);
  const { ledger, loading: ledgerLoading, error: ledgerError } = useProtocolLedger(deployed);
  const client = usePublicClient({ chainId: SPARE_CHAIN_ID });

  const withdrawals = ledger?.withdrawals ?? [];
  const timesQ = useQuery({
    queryKey: ['spare', 'fee-withdrawal-times', withdrawals.map((w) => w.blockNumber.toString()).join(',')],
    queryFn: () => blockTimes(client as PublicClient, withdrawals.map((w) => w.blockNumber)),
    enabled: !!client && withdrawals.length > 0,
    staleTime: Infinity,
  });
  const rows: WithdrawalRow[] = withdrawals.map((w) => ({
    ...w,
    id: `${w.txHash}:${w.logIndex}`,
    time: timesQ.data?.get(w.blockNumber),
  }));

  const withdrawalColumns: HoloColumn<WithdrawalRow>[] = [
    { key: 'time', label: t('buyback.withdrawals.cols.time'), width: 150, render: (r) => utc(r.time) },
    { key: 'token', label: t('buyback.withdrawals.cols.token'), width: 80, render: (r) => tokenLabel(r.token) },
    { key: 'amount', label: t('buyback.withdrawals.cols.amount'), align: 'right', render: (r) => amountLabel(r) },
    { key: 'to', label: t('buyback.withdrawals.cols.to'), width: 130, render: (r) => <AddrLink address={r.to} /> },
    { key: 'tx', label: t('buyback.withdrawals.cols.tx'), width: 130, render: (r) => <TxLink hash={r.txHash} /> },
  ];

  const reading = deployment.checking || (deployed && vault.loading);
  const vaultOk = deployed && vault.usdg !== null;
  const vaultBadge = reading ? (
    <HoloBadge label={t('common.readingBadge')} tone="info" variant="solid" />
  ) : vaultOk ? (
    <HoloBadge label={t('shell:common.liveData')} tone="good" variant="solid" pulse />
  ) : (
    <HoloBadge label={t('buyback.unavailableBadge')} tone="warn" variant="solid" />
  );

  const usdgInVault = vault.usdg === null ? DASH : formatUsd(vault.usdg);
  const feesAllTime = ledger ? formatUsd(ledger.feesUsdg) : DASH;
  const convertedAllTime = ledger ? formatUsd(ledger.convertedUsdg) : DASH;
  const ledgerSub = ledgerLoading ? t('buyback.readingChain') : ledgerError && !ledger ? t('buyback.unavailableNow') : undefined;
  const none = t('buyback.rates.none');

  return (
    <HoloPageWindow exeTitle={t('buyback.exeTitle')} icon="/icons/spare/spare-balance.png" banner={t('buyback.banner')} current="/buyback">
      <HoloHero
        art="/icons/spare/spare-balance.png"
        kicker={t('buyback.hero.kicker')}
        title={t('buyback.hero.title')}
        size="md"
        description={t('buyback.hero.description')}
        aside={vaultBadge}
        seed={31}
      />

      {!deployed && !deployment.checking && <DeployingNotice checking={false} error={deployment.error} />}

      {/* ── live counter ─────────────────────────────────────────────── */}
      <HoloCard title={t('buyback.vault.title')} icon="/icons/spare/spare-balance.png" accent={vaultBadge}>
        <div style={SECTION_GRID}>
          <HoloStat
            label={t('buyback.vault.usdg')}
            value={usdgInVault}
            size="xl"
            sub={reading ? t('buyback.readingChain') : vault.usdg === null ? t('buyback.unavailableNow') : t('buyback.vault.usdgSub')}
          />
          <HoloStat
            label={t('buyback.vault.weth')}
            value={wethText(vault.weth)}
            size="xl"
            sub={reading ? t('buyback.readingChain') : vault.weth === null ? t('buyback.unavailableNow') : t('buyback.vault.wethSub')}
          />
        </div>
        <HoloDivider />
        <div style={SECTION_GRID}>
          <HoloStat label={t('buyback.totals.fees')} value={feesAllTime} size="md" sub={ledgerSub ?? t('buyback.totals.feesSub')} />
          <HoloStat label={t('buyback.totals.converted')} value={convertedAllTime} size="md" sub={ledgerSub ?? t('buyback.totals.convertedSub')} />
          <HoloStat
            label={t('buyback.totals.buys')}
            value={ledger ? ledger.buys.toLocaleString('en-US') : DASH}
            size="md"
            sub={ledgerSub ?? t('buyback.totals.buysSub')}
          />
        </div>
        {ledger && ledger.convertedUsdg === 0n && (
          <HoloNotice tone="info" compact title={t('buyback.notices.zeroTitle')}>
            {t('buyback.notices.zeroBody')}
          </HoloNotice>
        )}
        {ledgerError && !ledger && (
          <HoloNotice tone="warn" compact title={t('buyback.notices.unavailableTitle')}>
            {t('buyback.notices.unavailableBody')}
          </HoloNotice>
        )}
        <Hint>
          {ledger ? (
            <Trans
              t={t}
              i18nKey="buyback.hint.vaultRead"
              values={{ start: START_BLOCK.toLocaleString('en-US'), block: ledger.scannedTo.toLocaleString('en-US') }}
              components={{ addr: <AddrLink address={SPARE.FeeVault} full /> }}
            />
          ) : (
            <Trans
              t={t}
              i18nKey="buyback.hint.vault"
              values={{ start: START_BLOCK.toLocaleString('en-US') }}
              components={{ addr: <AddrLink address={SPARE.FeeVault} full /> }}
            />
          )}
        </Hint>
      </HoloCard>

      {/* ── fee rates ────────────────────────────────────────────────── */}
      <HoloCard title={t('buyback.rates.title')} accent={vault.feeBps !== null ? t('shell:common.liveData') : undefined} accentTone="good" bar="lilac">
        <HoloList>
          <HoloListRow label={t('buyback.rates.conversion')} value={pct(vault.feeBps)} hint={t('buyback.rates.conversionHint')} />
          <HoloListRow label={t('buyback.rates.ceiling')} value={pct(vault.maxFeeBps)} hint={t('buyback.rates.ceilingHint')} />
          <HoloListRow label={t('buyback.rates.fundSwap')} value={`${formatBps(FUND_FEE_BPS)}%`} hint={t('buyback.rates.fundSwapHint')} />
          <HoloListRow label={t('buyback.rates.deferred')} value={none} />
          <HoloListRow label={t('buyback.rates.other')} value={none} />
        </HoloList>
      </HoloCard>

      {/* ── the flow ─────────────────────────────────────────────────── */}
      <HoloCard title={t('buyback.flow.title')} icon="/icons/spare/auto-invest.png">
        <div className="bb-flow" role="img" aria-label={t('buyback.flow.aria')}>
          <FlowNode area="src1" icon="/icons/spare/stock-mix.png" title={t('buyback.flow.converts')} note={t('buyback.flow.convertsNote')} />
          <FlowNode area="src2" icon="/icons/spare/fund-wallet.png" title={t('buyback.rates.fundSwap')} note={t('buyback.flow.swapNote')} />
          <FlowArrow area="a1" label="0.25%" />
          <FlowArrow area="a2" label="0.25%" desktopOnly />
          <FlowNode
            area="vault"
            tone="screen"
            icon="/icons/spare/spare-balance.png"
            title="FeeVault"
            value={
              <>
                {usdgInVault} USDG
                <br />
                {wethText(vault.weth)} WETH
              </>
            }
            note={t('buyback.flow.vaultNote')}
          />
          <FlowArrow area="a3" label={t('buyback.flow.owner')} />
          <FlowArrow area="a4" label="S3" dashed />
          <FlowNode area="out1" title={t('buyback.flow.withdrawals')} note={t('buyback.flow.withdrawalsNote')} />
          <FlowNode
            area="out2"
            dashed
            title={t('buyback.flow.buybacks')}
            note={t('buyback.flow.buybacksNote')}
            badge={<HoloBadge label="S3" tone="warn" variant="solid" />}
          />
        </div>
        <style>{FLOW_CSS}</style>
        <ol style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {FLOW_STEPS.map((key, i) => (
            <li key={key} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
              <HoloBadge label={String(i + 1)} variant="solid" tone={i === 3 ? 'warn' : 'info'} />
              <span style={{ fontFamily: FONT_TEXT, fontSize: 12.5, lineHeight: 1.55, color: INK.body, minWidth: 0 }}>
                <Trans t={t} i18nKey={key} components={{ code: <code style={CODE} /> }} />
              </span>
            </li>
          ))}
        </ol>
      </HoloCard>

      {/* ── $SPARE ───────────────────────────────────────────────────── */}
      <HoloCard title="$SPARE" accent={t('buyback.spare.soon')} accentTone="warn" bar="pink">
        <HoloList>
          <HoloListRow label={t('buyback.spare.address')} value={t('shell:common.soon')} hint={t('buyback.spare.addressHint')} />
        </HoloList>
        <p style={COPY}>{t('buyback.spare.body')}</p>
        <CtaRow>
          <HoloLinkButton href={X_URL} size="sm">
            {t('buyback.spare.follow')}
          </HoloLinkButton>
        </CtaRow>
      </HoloCard>

      {/* ── withdrawals ──────────────────────────────────────────────── */}
      <HoloCard title={t('buyback.withdrawals.title')} accent={ledger ? String(withdrawals.length) : undefined} accentTone="ink" bar="lilac">
        <HoloTable
          ariaLabel={t('buyback.withdrawals.aria')}
          columns={withdrawalColumns}
          rows={rows}
          rowKey={(r) => r.id}
          loading={deployed && ledgerLoading}
          minWidth={640}
          dense
          emptyMessage={ledgerError && !ledger ? t('buyback.withdrawals.unavailable') : deployed ? t('buyback.withdrawals.none') : DASH}
        />
        <Hint>{t('buyback.withdrawals.hint')}</Hint>
      </HoloCard>

      <CtaRow>
        <HoloLinkButton to="/flywheel" variant="primary" size="lg">
          {t('buyback.cta.flywheel')}
        </HoloLinkButton>
        <HoloLinkButton to="/roadmap" size="lg">
          {t('shell:appNames.roadmap')}
        </HoloLinkButton>
      </CtaRow>
    </HoloPageWindow>
  );
}

const COPY: CSSProperties = { margin: 0, fontFamily: FONT_TEXT, fontSize: 12.5, lineHeight: 1.6, color: INK.body };
const CODE: CSSProperties = {
  fontFamily: FONT_TEXT,
  fontSize: 11.5,
  background: HOLO.faceDeep,
  boxShadow: `inset 0 0 0 1px ${HOLO.bevelLo}`,
  padding: '0 4px',
};
