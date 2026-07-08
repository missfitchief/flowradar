import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { fmtAge, fmtPct, fmtUsd } from '@/lib/format';
import type { TokenConfluence, ConfluenceSnapshotRow } from '@flowradar/db';

export interface ConfluencePanelProps {
  confluence: TokenConfluence;
}

// --- state labelling ------------------------------------------------------
// A card's status maps to an honest verdict badge. Constraint 15: absence of
// data (unavailable / missing_key / plan_required / stub / no-row) is NEVER
// rendered as a reassuring all-clear — only "ok" (data present) shows real
// values, everything else is a plainly-flagged not-available state.
const STATUS_LABEL: Record<string, string> = {
  ok: 'data present',
  unavailable: 'unavailable',
  missing_key: 'key not configured',
  plan_required: 'plan required',
  rate_limited: 'rate limited',
  error: 'error',
  stub: 'not integrated',
};

const STATUS_BADGE_CLASS: Record<string, string> = {
  ok: 'border-transparent bg-emerald-500/15 text-emerald-300',
  unavailable: 'border-transparent bg-zinc-700/40 text-zinc-400',
  missing_key: 'border-transparent bg-amber-500/15 text-amber-400',
  plan_required: 'border-transparent bg-amber-500/15 text-amber-400',
  rate_limited: 'border-transparent bg-amber-500/15 text-amber-400',
  error: 'border-transparent bg-red-500/15 text-red-400',
  stub: 'border-transparent bg-zinc-700/40 text-zinc-400',
};

function statusLabel(status: string | null): string {
  if (!status) return 'unknown — no data';
  return STATUS_LABEL[status] ?? 'unknown';
}
function statusBadgeClass(status: string | null): string {
  if (!status) return 'border-transparent bg-zinc-700/40 text-zinc-400';
  return STATUS_BADGE_CLASS[status] ?? 'border-transparent bg-zinc-700/40 text-zinc-400';
}

const SHADOW_BADGE = 'border-transparent bg-zinc-800/50 text-zinc-400';
const PROVIDER_CLAIMED_BADGE = 'border-transparent bg-sky-500/15 text-sky-300';

/** Small numeric/text row inside a card body. */
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="font-medium tabular-nums">{value}</div>
    </div>
  );
}

/** A card header with the "not part of FlowScore" shadow badge always shown. */
function CardHead({
  title,
  snapshot,
  providerClaimed,
}: {
  title: string;
  snapshot: ConfluenceSnapshotRow | null;
  providerClaimed: boolean;
}) {
  return (
    <CardHeader>
      <div className="flex flex-wrap items-center gap-2">
        <CardTitle>{title}</CardTitle>
        <Badge className={statusBadgeClass(snapshot?.status ?? null)}>
          {statusLabel(snapshot?.status ?? null)}
        </Badge>
        <Badge className={SHADOW_BADGE}>shadow-only · not part of FlowScore</Badge>
        {providerClaimed && <Badge className={PROVIDER_CLAIMED_BADGE}>provider-claimed</Badge>}
      </div>
    </CardHeader>
  );
}

/** Honest "we have no data" body used by every card whose snapshot is null or non-ok. */
function UnavailableBody({ snapshot, providerClaimed }: { snapshot: ConfluenceSnapshotRow | null; providerClaimed: boolean }) {
  // NEVER a reassuring verdict — this is explicitly the absence-of-data path.
  const reason =
    snapshot === null
      ? 'No data collected for this token yet.'
      : `Status: ${statusLabel(snapshot.status)} — data not available. Absence of data is not a clearance.`;
  return (
    <p className="text-sm text-muted-foreground">
      {reason}
      {providerClaimed && ' This is an external, provider-claimed source, not a FlowRadar-computed metric.'}
    </p>
  );
}

function n(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function s(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

// --- Liquidity Risk (internal, FlowRadar-computed) ------------------------
function LiquidityRiskCard({ snapshot }: { snapshot: ConfluenceSnapshotRow | null }) {
  if (!snapshot || snapshot.status !== 'ok') {
    return (
      <Card>
        <CardHead title="Liquidity Risk" snapshot={snapshot} providerClaimed={false} />
        <CardContent><UnavailableBody snapshot={snapshot} providerClaimed={false} /></CardContent>
      </Card>
    );
  }
  const d = snapshot.dataJson;
  const ratio = n(d.liquidityToMcapRatio);
  const slippage = n(d.estimatedOneWaySlippagePct);
  const dumpToHalve = n(d.dumpToHalveUsd);
  const maxPos = n(d.positionSizeMaxFor2PctSlippageUsd);
  const absBand = s(d.absoluteLiquidityBand) ?? 'unknown';
  const fragBand = s(d.ratioFragilityBand) ?? 'unknown';
  const confidence = s(d.confidence) ?? 'low';
  const caveats = Array.isArray(d.caveats) ? (d.caveats as unknown[]).filter((c): c is string => typeof c === 'string') : [];
  return (
    <Card>
      <CardHead title="Liquidity Risk" snapshot={snapshot} providerClaimed={false} />
      <CardContent>
        <div className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
          <Stat label="Liquidity / MCap" value={ratio === null ? 'unknown' : fmtPct(ratio * 100)} />
          <Stat label="Fragility" value={fragBand} />
          <Stat label="Depth band" value={absBand} />
          <Stat label="Est. 1-way slippage" value={slippage === null ? 'unknown' : fmtPct(slippage)} />
          <Stat label="Dump-to-halve" value={dumpToHalve === null ? 'unknown' : fmtUsd(dumpToHalve)} />
          <Stat label="Max size @ ~2% slip" value={maxPos === null ? 'unknown' : fmtUsd(maxPos)} />
          <Stat label="Confidence" value={confidence} />
        </div>
        {caveats.length > 0 && (
          <ul className="mt-3 flex flex-col gap-1 text-xs text-amber-400/90">
            {caveats.map((c, i) => (
              <li key={i}>⚠ {c}</li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-xs text-muted-foreground">
          Internal FlowRadar estimate from displayed liquidity + market cap (CPMM identities). Fragility describes structure, not a buy/sell call.
        </p>
      </CardContent>
    </Card>
  );
}

// --- Holder Risk (HolderScan, provider-claimed / optional) ----------------
function HolderRiskCard({ snapshot }: { snapshot: ConfluenceSnapshotRow | null }) {
  if (!snapshot || snapshot.status !== 'ok') {
    return (
      <Card>
        <CardHead title="Holder Risk" snapshot={snapshot} providerClaimed />
        <CardContent><UnavailableBody snapshot={snapshot} providerClaimed /></CardContent>
      </Card>
    );
  }
  const d = snapshot.dataJson;
  const holderCount = n(d.holderCount);
  // Providers vary on the key name (mock writes topHolderConcentrationPct);
  // fall back across both so present data is never displayed as "unknown".
  const conc = n(d.topHolderConcentrationPct) ?? n(d.topHolderConcentration);
  return (
    <Card>
      <CardHead title="Holder Risk" snapshot={snapshot} providerClaimed />
      <CardContent>
        <div className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
          <Stat label="Holders" value={holderCount === null ? 'unknown' : holderCount.toLocaleString()} />
          <Stat label="Top-holder share" value={conc === null ? 'unknown' : fmtPct(conc)} />
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Provider-claimed (HolderScan) — shown alongside, and independent of, FlowRadar&apos;s own concentration risk. Not part of FlowScore.
        </p>
      </CardContent>
    </Card>
  );
}

// --- CLOBr (liquidity map, stub) ------------------------------------------
function ClobrCard({ snapshot }: { snapshot: ConfluenceSnapshotRow | null }) {
  return (
    <Card>
      <CardHead title="CLOBr liquidity map" snapshot={snapshot} providerClaimed />
      <CardContent><UnavailableBody snapshot={snapshot} providerClaimed /></CardContent>
    </Card>
  );
}

// --- GMGN (external intel, query-only / stub) -----------------------------
function GmgnCard({ snapshot }: { snapshot: ConfluenceSnapshotRow | null }) {
  if (!snapshot || snapshot.status !== 'ok') {
    return (
      <Card>
        <CardHead title="GMGN external intel" snapshot={snapshot} providerClaimed />
        <CardContent><UnavailableBody snapshot={snapshot} providerClaimed /></CardContent>
      </Card>
    );
  }
  const d = snapshot.dataJson;
  const labels = Array.isArray(d.labels) ? (d.labels as unknown[]).filter((x): x is string => typeof x === 'string') : [];
  return (
    <Card>
      <CardHead title="GMGN external intel" snapshot={snapshot} providerClaimed />
      <CardContent>
        {labels.length === 0 ? (
          <p className="text-sm text-muted-foreground">No provider-claimed labels returned.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {labels.map((l, i) => (
              <Badge key={i} className={PROVIDER_CLAIMED_BADGE}>{l}</Badge>
            ))}
          </div>
        )}
        <p className="mt-2 text-xs text-muted-foreground">
          Query-only, provider-claimed labels — never asserted as fact, never a scoring input. Not part of FlowScore.
        </p>
      </CardContent>
    </Card>
  );
}

// --- AG Paper (paper-trade observation, manual/stub) ----------------------
function AgPaperCard({ snapshot }: { snapshot: ConfluenceSnapshotRow | null }) {
  if (!snapshot || snapshot.status !== 'ok') {
    return (
      <Card>
        <CardHead title="AG Paper observations" snapshot={snapshot} providerClaimed={false} />
        <CardContent><UnavailableBody snapshot={snapshot} providerClaimed={false} /></CardContent>
      </Card>
    );
  }
  const d = snapshot.dataJson;
  const pnl = n(d.paperPnlPct);
  return (
    <Card>
      <CardHead title="AG Paper observations" snapshot={snapshot} providerClaimed={false} />
      <CardContent>
        <div className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
          <Stat label="Paper PnL" value={pnl === null ? 'unknown' : fmtPct(pnl)} />
          <Stat label="Observed" value={`${fmtAge(snapshot.observedAt)} ago`} />
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Manual paper-journal observation — never a real execution, never a recommendation. Not part of FlowScore.
        </p>
      </CardContent>
    </Card>
  );
}

// --- Overlap summary (conflict-aware) -------------------------------------
// Reads the shadow signals we already have and states agreement AND
// disagreement between them. This is the ONE place that must surface conflict
// ("smart-money accumulating but liquidity very fragile"), not just
// confirmation. It derives nothing new for FlowScore — purely descriptive.
function OverlapSummary({ confluence }: { confluence: TokenConfluence }) {
  const observations: string[] = [];
  const conflicts: string[] = [];

  const liq = confluence.liquidityRisk;
  if (liq && liq.status === 'ok') {
    const frag = s(liq.dataJson.ratioFragilityBand);
    if (frag === 'very_fragile' || frag === 'fragile') {
      conflicts.push(`Liquidity is ${frag.replace('_', ' ')} — a large exit would move price sharply.`);
    } else if (frag) {
      observations.push(`Liquidity structure: ${frag}.`);
    }
  }

  const gmgn = confluence.gmgn;
  if (gmgn && gmgn.status === 'ok') {
    const labels = Array.isArray(gmgn.dataJson.labels) ? (gmgn.dataJson.labels as unknown[]) : [];
    if (labels.length > 0) {
      observations.push(`GMGN (provider-claimed) labels present: ${labels.join(', ')}.`);
    }
  }

  const holder = confluence.holderRisk;
  if (holder && holder.status === 'ok') {
    const delta = holder.dataJson.holderDelta as Record<string, unknown> | undefined;
    const d24 = delta ? n(delta['24h']) : null;
    if (d24 !== null && d24 < 0) {
      conflicts.push('Holder count is declining (provider-claimed) — distribution, not accumulation.');
    }
  }

  // Cross-source disagreement: a bullish external label WHILE liquidity is fragile.
  const hasBullishLabel =
    gmgn?.status === 'ok' && Array.isArray(gmgn.dataJson.labels) &&
    (gmgn.dataJson.labels as unknown[]).some((l) => typeof l === 'string' && /smart|bull|trend/i.test(l));
  const fragile = liq?.status === 'ok' && (s(liq.dataJson.ratioFragilityBand) === 'very_fragile' || s(liq.dataJson.ratioFragilityBand) === 'fragile');
  if (hasBullishLabel && fragile) {
    conflicts.push('Sources disagree: external intel reads positive while liquidity structure is fragile.');
  }

  const nothing = observations.length === 0 && conflicts.length === 0;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle>Social + Wallet + External overlap</CardTitle>
          <Badge className={SHADOW_BADGE}>shadow-only · not part of FlowScore</Badge>
          {conflicts.length > 0 && (
            <Badge className="border-transparent bg-red-500/15 text-red-400">⚠ sources disagree</Badge>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {nothing ? (
          <p className="text-sm text-muted-foreground">
            Not enough confluence evidence to compare sources yet. No agreement or disagreement can be asserted — this is not a clearance.
          </p>
        ) : (
          <div className="flex flex-col gap-3 text-sm">
            {conflicts.length > 0 && (
              <div>
                <div className="mb-1 text-xs font-medium text-red-400">Disagreements / tensions</div>
                <ul className="flex flex-col gap-1">
                  {conflicts.map((c, i) => (
                    <li key={i}>⚠ {c}</li>
                  ))}
                </ul>
              </div>
            )}
            {observations.length > 0 && (
              <div>
                <div className="mb-1 text-xs font-medium text-muted-foreground">Observations</div>
                <ul className="flex flex-col gap-1">
                  {observations.map((o, i) => (
                    <li key={i}>{o}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
        <p className="mt-3 text-xs text-muted-foreground">
          Descriptive confluence only — surfaces disagreement between shadow sources, never a buy/sell call. Not part of FlowScore.
        </p>
      </CardContent>
    </Card>
  );
}

/**
 * Token-detail Confluence panel (Task E) — SHADOW-ONLY. Read-only server
 * component that renders the latest confluence evidence for one token:
 * internal Liquidity Risk (FlowRadar-computed) plus provider-claimed Holder
 * Risk / CLOBr / GMGN / AG Paper cards, and a conflict-aware overlap summary.
 *
 * Hard rules honored here: it changes no FlowScore/signal/wallet state; it
 * labels every card shadow-only / provider-claimed / not-part-of-FlowScore;
 * absence-of-data (null snapshot, or status stub/unavailable/missing_key/
 * plan_required) renders honestly as unavailable/unknown and NEVER as a
 * reassuring all-clear; it renders no resolved secret (only source NAMES
 * from the source-status rows); and it surfaces source disagreement, not
 * only confirmation.
 */
export function ConfluencePanel({ confluence }: ConfluencePanelProps) {
  const { liquidityRisk, holderRisk, clobr, gmgn, agPaper, sourceStatuses } = confluence;

  const nothingAtAll =
    !liquidityRisk && !holderRisk && !clobr && !gmgn && !agPaper && sourceStatuses.length === 0;

  if (nothingAtAll) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Confluence</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            No confluence evidence for this token yet. This is an absence of data, not a clearance.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <LiquidityRiskCard snapshot={liquidityRisk} />
      <HolderRiskCard snapshot={holderRisk} />
      <ClobrCard snapshot={clobr} />
      <GmgnCard snapshot={gmgn} />
      <AgPaperCard snapshot={agPaper} />
      <OverlapSummary confluence={confluence} />

      {sourceStatuses.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Confluence source health</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-2 text-sm">
              {sourceStatuses.map((row) => (
                <li key={row.sourceName} className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{row.sourceName}</span>
                  <span className="text-xs text-muted-foreground">{row.provider}</span>
                  <Badge className={statusBadgeClass(row.mode)}>{row.mode}</Badge>
                  <span className="text-xs text-muted-foreground">{row.note}</span>
                  {row.apiKeyEnvName && (
                    <span className="text-xs text-muted-foreground">env: {row.apiKeyEnvName}</span>
                  )}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <p className="text-xs text-muted-foreground">
        Shadow-only confluence evidence — not part of FlowScore, the signal rules, or wallet scoring. Provider-claimed metrics are external claims, not verified facts; unavailable sources are shown as unknown, never as a reassuring all-clear.
      </p>
    </div>
  );
}
