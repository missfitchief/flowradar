import Link from 'next/link';
import { buildSignalExplanation, confidenceBand } from '@flowradar/core';
import type { ExplainInput } from '@flowradar/core';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { fmtAge, fmtPct, fmtUsd } from '@/lib/format';

// FlowRadar — SignalCard (Task 43 binding decision 4).
//
// Large, responsive card: 1-col mobile / 2-col >=lg (grid is applied by the
// section wrapper, SignalSection — this component only renders one card).
// Content order (binding): header -> FlowScore -> explanation (headline +
// whyFired + conclusion) -> "what would invalidate this" (collapsible) ->
// whatChanged -> evidence chips (SECOND-to-last) -> footer links (raw data,
// THIRD/last). Bigger type than the dense tables (text-base/lg, not text-xs).

export type SignalCardChain = 'SOLANA' | 'BSC';
export type SignalCardStatus = 'watching' | 'hot' | 'profit_rotation' | 'exit_warning' | 'dead';
export type SignalCardSeverity = 'INFO' | 'WATCH' | 'HIGH' | 'CRITICAL';

/**
 * Plain, JSON-serializable data for one Signal Feed card — assembled
 * server-side from the latest TokenFlowSnapshot + Signal (+ EntityCluster /
 * ProfitRotationSignal for the rotation variant) joins. No Prisma.Decimal, no
 * non-serializable value crosses into this component.
 */
export interface SignalCardData {
  tokenId: string;
  symbol: string;
  name: string;
  chain: SignalCardChain;
  status: SignalCardStatus;
  rule: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G';
  severity: SignalCardSeverity;
  flowScore: number;
  mcapUsd: number | null;
  liquidityUsd: number | null;
  rawWalletCount: number;
  uniqueEntityCount: number;
  largestClusterSize: number;
  netFlowUsd: number;
  avgEntryMcapUsd: number | null;
  currentMcapUsd: number | null;
  soldPct: number;
  hasRotation: boolean;
  riskFlagCount: number;
  lastUpdatedAt: Date;
  explorerUrl: string | null;
  dexScreenerUrl: string;
  previous?: {
    smartWalletCount: number;
    netFlowUsd: number;
    mcapMultiplier: number;
  };
}

const CHAIN_BADGE_CLASS: Record<SignalCardChain, string> = {
  SOLANA: 'border-transparent bg-violet-500/15 text-violet-300',
  BSC: 'border-transparent bg-amber-500/15 text-amber-300',
};

const STATUS_BADGE_CLASS: Record<SignalCardStatus, string> = {
  watching: 'border-transparent bg-zinc-500/15 text-zinc-300',
  hot: 'border-transparent bg-orange-500/15 text-orange-300',
  profit_rotation: 'border-transparent bg-violet-500/15 text-violet-300',
  exit_warning: 'border-transparent bg-red-500/15 text-red-400',
  dead: 'border-transparent bg-zinc-800/50 text-zinc-500',
};

const SEVERITY_BADGE_CLASS: Record<SignalCardSeverity, string> = {
  INFO: 'border-transparent bg-zinc-500/15 text-zinc-300',
  WATCH: 'border-transparent bg-amber-500/15 text-amber-300',
  HIGH: 'border-transparent bg-orange-500/15 text-orange-300',
  CRITICAL: 'border-transparent bg-red-500/15 text-red-400',
};

/** FlowScore color ramp (mirrors HotTokensTable's own binding decision #3): >=70 emerald, 40-69 amber, <40 zinc. */
function flowScoreClass(score: number): string {
  if (score >= 70) return 'text-emerald-400';
  if (score >= 40) return 'text-amber-400';
  return 'text-zinc-400';
}

function fmtUsdOrDash(n: number | null): string {
  return n === null ? 'unknown' : fmtUsd(n);
}

/** Risk level from Token.riskFlags count: none/low(1)/high(2+). */
function riskLevel(count: number): 'none' | 'low' | 'high' {
  if (count === 0) return 'none';
  if (count === 1) return 'low';
  return 'high';
}

const RISK_BADGE_CLASS: Record<'none' | 'low' | 'high', string> = {
  none: 'border-transparent bg-zinc-500/15 text-zinc-300',
  low: 'border-transparent bg-amber-500/15 text-amber-300',
  high: 'border-transparent bg-red-500/15 text-red-400',
};

function mcapMultiplier(avgEntry: number | null, current: number | null): number | null {
  if (avgEntry === null || current === null || avgEntry === 0) return null;
  return current / avgEntry;
}

export interface SignalCardProps {
  data: SignalCardData;
  settings: ExplainInput['settings'];
}

/**
 * Renders one Signal Feed card. Order: header row, FlowScore, explanation
 * block (headline + whyFired + conclusion), "what would invalidate this"
 * (<details>), whatChanged, evidence chips, footer links.
 */
export function SignalCard({ data, settings }: SignalCardProps) {
  const explainInput: ExplainInput = {
    rule: data.rule,
    severity: data.severity,
    symbol: data.symbol,
    metrics: {
      rawWalletCount: data.rawWalletCount,
      uniqueEntityCount: data.uniqueEntityCount,
      largestClusterSize: data.largestClusterSize,
      netFlowUsd: data.netFlowUsd,
      soldPct: data.soldPct,
      mcapMultiplier: mcapMultiplier(data.avgEntryMcapUsd, data.currentMcapUsd) ?? 1,
      liquidityUsd: data.liquidityUsd ?? 0,
    },
    previous: data.previous,
    settings,
  };
  const explanation = buildSignalExplanation(explainInput);

  const multiplier = mcapMultiplier(data.avgEntryMcapUsd, data.currentMcapUsd);
  const risk = riskLevel(data.riskFlagCount);

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-5 text-card-foreground ring-1 ring-foreground/10">
      {/* Header row */}
      <div className="flex flex-wrap items-center gap-2">
        <Link href={`/tokens/${data.tokenId}`} className="text-xl font-semibold tracking-tight hover:underline">
          ${data.symbol}
        </Link>
        <Badge className={CHAIN_BADGE_CLASS[data.chain]}>{data.chain}</Badge>
        <Badge className={STATUS_BADGE_CLASS[data.status]}>{data.status}</Badge>
        <Badge className={SEVERITY_BADGE_CLASS[data.severity]}>{data.severity}</Badge>
        <span className="ml-auto text-sm text-muted-foreground">{fmtAge(data.lastUpdatedAt)} ago</span>
      </div>

      {/* FlowScore, prominent */}
      <div className="flex items-baseline gap-2">
        <span className={cn('text-4xl font-bold tabular-nums', flowScoreClass(data.flowScore))}>
          {data.flowScore.toFixed(0)}
        </span>
        <span className="text-sm text-muted-foreground">FlowScore</span>
      </div>

      {/* Explanation — plain-English read, FIRST */}
      <div className="flex flex-col gap-2">
        <p className="text-lg font-medium leading-snug">{explanation.headline}</p>
        {explanation.whyFired.map((sentence, i) => (
          <p key={i} className="text-base leading-relaxed text-foreground/90">
            {sentence}
          </p>
        ))}
        <p className="text-base italic text-muted-foreground">{explanation.conclusion}</p>
      </div>

      {/* What would invalidate this — collapsible */}
      <details className="rounded-lg border border-border/60 p-3 text-base">
        <summary className="cursor-pointer font-medium text-foreground/90">What would invalidate this</summary>
        <ul className="mt-2 flex flex-col gap-1 pl-4 text-base text-muted-foreground">
          {explanation.wouldInvalidate.map((line, i) => (
            <li key={i} className="list-disc">
              {line}
            </li>
          ))}
        </ul>
      </details>

      {/* What changed since previous check */}
      {explanation.whatChanged && (
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground/80">Since last check: </span>
          {explanation.whatChanged}
        </p>
      )}

      {/* Evidence chips — SECOND */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-2 border-t border-border/60 pt-4 text-sm sm:grid-cols-3">
        <EvidenceChip label="Mcap" value={fmtUsdOrDash(data.mcapUsd)} />
        <EvidenceChip label="Liquidity" value={fmtUsdOrDash(data.liquidityUsd)} />
        <EvidenceChip label="Smart wallets" value={String(data.rawWalletCount)} />
        <EvidenceChip
          label="Unique entities"
          value={
            data.uniqueEntityCount === data.rawWalletCount
              ? String(data.uniqueEntityCount)
              : `${data.uniqueEntityCount} (of ${data.rawWalletCount} raw)`
          }
        />
        <EvidenceChip label="Largest cluster" value={`${data.largestClusterSize} wallets`} />
        <EvidenceChip
          label="Net flow"
          value={`${data.netFlowUsd >= 0 ? '+' : ''}${fmtUsd(data.netFlowUsd)}`}
          valueClassName={data.netFlowUsd >= 0 ? 'text-emerald-400' : 'text-red-400'}
        />
        <EvidenceChip
          label="Entry → current mcap"
          value={
            data.avgEntryMcapUsd !== null && data.currentMcapUsd !== null
              ? `${fmtUsd(data.avgEntryMcapUsd)} → ${fmtUsd(data.currentMcapUsd)}${multiplier !== null ? ` (×${multiplier.toFixed(1)})` : ''}`
              : 'unknown'
          }
        />
        <EvidenceChip label="Sell pressure" value={fmtPct(data.soldPct).replace('+', '')} />
        <EvidenceChip label="Profit rotation" value={data.hasRotation ? 'yes' : 'no'} />
        <div className="flex flex-col gap-0.5">
          <span className="text-xs text-muted-foreground">Risk level</span>
          <Badge className={cn('w-fit', RISK_BADGE_CLASS[risk])}>{risk}</Badge>
        </div>
      </div>

      {/* Footer links — raw data, THIRD/last */}
      <div className="flex flex-wrap gap-4 border-t border-border/60 pt-3 text-sm">
        <Link href={`/tokens/${data.tokenId}`} className="text-muted-foreground underline-offset-4 hover:underline">
          Token detail
        </Link>
        <a
          href={data.dexScreenerUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-muted-foreground underline-offset-4 hover:underline"
        >
          DexScreener
        </a>
        {data.explorerUrl && (
          <a
            href={data.explorerUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-muted-foreground underline-offset-4 hover:underline"
          >
            Explorer
          </a>
        )}
      </div>
    </div>
  );
}

function EvidenceChip({
  label,
  value,
  valueClassName,
}: {
  label: string;
  value: string;
  valueClassName?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={cn('font-medium tabular-nums', valueClassName)}>{value}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rotation card variant (Profit rotation section) — binding decision 5.
// ---------------------------------------------------------------------------

export interface RotationCardData {
  id: string;
  sourceSymbol: string;
  sourceTokenId: string;
  destSymbol: string;
  destTokenId: string;
  chainPath: string[];
  bridgeProtocol: string | null;
  realizedProfitUsd: number;
  transferredValueUsd: number;
  timeGapMin: number;
  valueMatchPct: number;
  confidence: number;
  destTokenMcapAtBuyUsd: number | null;
  currentDestPerfPct: number;
  detectedAt: Date;
}

/**
 * Rotation-specific card: uses the rotation explanation (buildSignalExplanation
 * with rule 'F' + a `rotation` block) plus a path line (SOLANA -> Wormhole ->
 * BSC), value match %, time gap, and confidence band.
 */
export function RotationCard({ data, settings }: { data: RotationCardData; settings: ExplainInput['settings'] }) {
  const bridged = data.chainPath.length > 1;
  const explainInput: ExplainInput = {
    rule: 'F',
    severity: 'HIGH',
    symbol: data.destSymbol,
    metrics: {
      rawWalletCount: 0,
      uniqueEntityCount: 0,
      largestClusterSize: 0,
      netFlowUsd: data.transferredValueUsd,
      soldPct: 0,
      mcapMultiplier: 1,
      liquidityUsd: 0,
    },
    rotation: {
      sourceSymbol: data.sourceSymbol,
      destSymbol: data.destSymbol,
      bridged,
      bridgeProtocol: data.bridgeProtocol ?? undefined,
      timeGapMin: data.timeGapMin,
      valueMatchPct: data.valueMatchPct,
      confidence: data.confidence,
    },
    settings,
  };
  const explanation = buildSignalExplanation(explainInput);
  const band = confidenceBand(data.confidence);

  const pathLine = bridged
    ? `${data.chainPath[0]} → ${data.bridgeProtocol ?? 'bridge'} → ${data.chainPath[data.chainPath.length - 1]}`
    : data.chainPath.join(' → ');

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-violet-500/30 bg-card p-5 text-card-foreground ring-1 ring-foreground/10">
      <div className="flex flex-wrap items-center gap-2">
        <Link href={`/tokens/${data.sourceTokenId}`} className="text-xl font-semibold tracking-tight hover:underline">
          ${data.sourceSymbol}
        </Link>
        <span className="text-xl text-muted-foreground">→</span>
        <Link href={`/tokens/${data.destTokenId}`} className="text-xl font-semibold tracking-tight hover:underline">
          ${data.destSymbol}
        </Link>
        <Badge className="border-transparent bg-violet-500/15 text-violet-300">profit rotation</Badge>
        <span className="ml-auto text-sm text-muted-foreground">{fmtAge(data.detectedAt)} ago</span>
      </div>

      <p className="font-mono text-sm text-muted-foreground">{pathLine}</p>

      <div className="flex flex-col gap-2">
        <p className="text-lg font-medium leading-snug">{explanation.headline}</p>
        {explanation.whyFired.map((sentence, i) => (
          <p key={i} className="text-base leading-relaxed text-foreground/90">
            {sentence}
          </p>
        ))}
        <p className="text-base italic text-muted-foreground">{explanation.conclusion}</p>
      </div>

      <details className="rounded-lg border border-border/60 p-3 text-base">
        <summary className="cursor-pointer font-medium text-foreground/90">What would invalidate this</summary>
        <ul className="mt-2 flex flex-col gap-1 pl-4 text-base text-muted-foreground">
          {explanation.wouldInvalidate.map((line, i) => (
            <li key={i} className="list-disc">
              {line}
            </li>
          ))}
        </ul>
      </details>

      <div className="grid grid-cols-2 gap-x-4 gap-y-2 border-t border-border/60 pt-4 text-sm sm:grid-cols-3">
        <EvidenceChip label="Realized profit" value={fmtUsd(data.realizedProfitUsd)} valueClassName="text-emerald-400" />
        <EvidenceChip label="Transferred value" value={fmtUsd(data.transferredValueUsd)} />
        <EvidenceChip label="Value match" value={`${data.valueMatchPct.toFixed(0)}%`} />
        <EvidenceChip label="Time gap" value={`${data.timeGapMin.toFixed(0)} min`} />
        <EvidenceChip label="Confidence" value={`${data.confidence.toFixed(0)} (${band})`} />
        <EvidenceChip
          label="Dest mcap at buy"
          value={data.destTokenMcapAtBuyUsd !== null ? fmtUsd(data.destTokenMcapAtBuyUsd) : 'unknown'}
        />
        <EvidenceChip
          label="Dest perf. since"
          value={fmtPct(data.currentDestPerfPct)}
          valueClassName={data.currentDestPerfPct >= 0 ? 'text-emerald-400' : 'text-red-400'}
        />
      </div>

      <div className="flex flex-wrap gap-4 border-t border-border/60 pt-3 text-sm">
        <Link href={`/tokens/${data.destTokenId}`} className="text-muted-foreground underline-offset-4 hover:underline">
          Token detail
        </Link>
        <Link href="/flow" className="text-muted-foreground underline-offset-4 hover:underline">
          Money Flow
        </Link>
      </div>
    </div>
  );
}
