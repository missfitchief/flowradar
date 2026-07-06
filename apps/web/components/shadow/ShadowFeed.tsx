'use client';

// FlowRadar — Shadow Mode feed (Task 42 binding decision 4).
//
// Client-side presentational feed over already-shaped rows (page query +
// shadowStatus() call both live in app/shadow/page.tsx — this component
// never touches Prisma or @flowradar/core directly). Filtering is pure
// client-side useState (same "no URL params" convention as AlertsFeed) with
// ONE toggle: "include synthetic demo data" — OFF by default, so a fresh
// visit shows only real-evidence signals (binding decision 4: "default
// real-evidence-only — synthetic hidden behind the toggle").

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { fmtAge, fmtPct } from '@/lib/format';
import type { ShadowHorizonStatus } from '@flowradar/core';

export type ShadowSeverity = 'INFO' | 'WATCH' | 'HIGH' | 'CRITICAL';
export type ShadowRule = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G';

export interface ShadowFeedRow {
  signalId: string;
  tokenId: string;
  tokenSymbol: string;
  rule: ShadowRule;
  severity: ShadowSeverity;
  triggeredAt: Date;
  horizons: Record<'M15' | 'H1' | 'H6' | 'H24' | 'D3' | 'D7', ShadowHorizonStatus>;
  overall: ShadowHorizonStatus;
  syntheticEvidence: boolean;
  /** roiPct at the latest horizon that has actually elapsed; null if none has. */
  latestRoiPct: number | null;
  latestElapsedHorizonLabel: string | null;
}

type HorizonKey = 'M15' | 'H1' | 'H6' | 'H24' | 'D3' | 'D7';

const HORIZON_ORDER: { key: HorizonKey; label: string }[] = [
  { key: 'M15', label: '15m' },
  { key: 'H1', label: '1h' },
  { key: 'H6', label: '6h' },
  { key: 'H24', label: '24h' },
  { key: 'D3', label: '3d' },
  { key: 'D7', label: '7d' }
];

const RULE_NAME: Record<ShadowRule, string> = {
  A: 'Coordinated Accumulation',
  B: 'Slow Accumulation',
  C: 'Organic Distribution',
  D: 'Whale Entry',
  E: 'Funded Fresh Wallets',
  F: 'Profit Rotation',
  G: 'Smart Money Exit'
};

const SEVERITY_BADGE_CLASS: Record<ShadowSeverity, string> = {
  INFO: 'border-transparent bg-zinc-500/15 text-zinc-300',
  WATCH: 'border-amber-500/40 bg-transparent text-amber-400',
  HIGH: 'border-transparent bg-orange-500/15 text-orange-300',
  CRITICAL: 'border-transparent bg-red-500/15 text-red-400'
};

const STATUS_BADGE_CLASS: Record<ShadowHorizonStatus, string> = {
  good: 'border-transparent bg-emerald-500/20 text-emerald-300',
  bad: 'border-transparent bg-red-500/20 text-red-400',
  pending: 'border-transparent bg-zinc-500/20 text-zinc-400 animate-pulse',
  unknown: 'border-transparent bg-zinc-500/10 text-zinc-500'
};

const STATUS_LABEL: Record<ShadowHorizonStatus, string> = {
  good: 'good',
  bad: 'bad',
  pending: 'pending',
  unknown: 'unknown'
};

function HorizonChip({ label, status }: { label: string; status: ShadowHorizonStatus }) {
  return (
    <span
      title={`${label}: ${STATUS_LABEL[status]}`}
      className={cn('inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium tabular-nums', STATUS_BADGE_CLASS[status])}
    >
      {label}
    </span>
  );
}

export interface ShadowSummaryCounts {
  good: number;
  bad: number;
  pending: number;
  unknown: number;
}

export interface ShadowFeedProps {
  rows: ShadowFeedRow[];
}

function computeCounts(rows: ShadowFeedRow[]): ShadowSummaryCounts {
  const counts: ShadowSummaryCounts = { good: 0, bad: 0, pending: 0, unknown: 0 };
  for (const row of rows) counts[row.overall] += 1;
  return counts;
}

export function ShadowFeed({ rows }: ShadowFeedProps) {
  const [includeSynthetic, setIncludeSynthetic] = useState(false);

  const realRows = useMemo(() => rows.filter((r) => !r.syntheticEvidence), [rows]);
  const syntheticRows = useMemo(() => rows.filter((r) => r.syntheticEvidence), [rows]);
  const visibleRows = includeSynthetic ? rows : realRows;

  const realCounts = computeCounts(realRows);
  const syntheticCounts = computeCounts(syntheticRows);

  return (
    <div className="flex flex-col gap-4">
      {/* Summary header — real-evidence-only headline, synthetic shown separately (binding decision 4). */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <SummaryCard label="Good (real)" value={realCounts.good} className="text-emerald-400" />
        <SummaryCard label="Bad (real)" value={realCounts.bad} className="text-red-400" />
        <SummaryCard label="Pending (real)" value={realCounts.pending} className="text-zinc-300" />
        <SummaryCard label="Unknown (real)" value={realCounts.unknown} className="text-zinc-500" />
      </div>
      {syntheticRows.length > 0 && (
        <p className="text-xs text-muted-foreground">
          + {syntheticRows.length} synthetic-evidence signal{syntheticRows.length === 1 ? '' : 's'} (good={syntheticCounts.good},
          bad={syntheticCounts.bad}, pending={syntheticCounts.pending}, unknown={syntheticCounts.unknown}) — hidden by default, see toggle below.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border p-3">
        <span className="text-xs font-medium text-muted-foreground">Filter</span>
        <Button type="button" size="sm" variant={!includeSynthetic ? 'secondary' : 'outline'} onClick={() => setIncludeSynthetic(false)}>
          Real evidence only
        </Button>
        <Button type="button" size="sm" variant={includeSynthetic ? 'secondary' : 'outline'} onClick={() => setIncludeSynthetic(true)}>
          Include synthetic demo data
        </Button>
        <span className="ml-auto text-xs text-muted-foreground">
          {visibleRows.length} of {rows.length}
        </span>
      </div>

      {visibleRows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          {rows.length === 0
            ? 'No signals have fired yet — shadow evaluation begins automatically once the backtest worker picks up new signals.'
            : 'No real-evidence signals yet — toggle "include synthetic demo data" to see mock-world results.'}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {visibleRows.map((row) => (
            <ShadowCard key={row.signalId} row={row} />
          ))}
        </div>
      )}
    </div>
  );
}

function SummaryCard({ label, value, className }: { label: string; value: number; className?: string }) {
  return (
    <Card size="sm">
      <CardContent>
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className={cn('text-2xl font-semibold tabular-nums', className)}>{value}</div>
      </CardContent>
    </Card>
  );
}

function ShadowCard({ row }: { row: ShadowFeedRow }) {
  return (
    <Card>
      <CardContent>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge className={SEVERITY_BADGE_CLASS[row.severity]}>{row.severity}</Badge>
            <Badge variant="outline">
              {row.rule} · {RULE_NAME[row.rule]}
            </Badge>
            <Link href={`/tokens/${row.tokenId}`} className="font-medium hover:underline">
              ${row.tokenSymbol}
            </Link>
            {row.syntheticEvidence && (
              <Badge className="border-transparent bg-violet-500/15 text-violet-300">synthetic demo data</Badge>
            )}
          </div>

          <div className="flex items-center gap-2">
            <Badge className={STATUS_BADGE_CLASS[row.overall]}>overall: {STATUS_LABEL[row.overall]}</Badge>
            <span className="text-xs text-muted-foreground" title={row.triggeredAt.toISOString()}>
              {fmtAge(row.triggeredAt)} ago
            </span>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-border pt-3">
          {HORIZON_ORDER.map(({ key, label }) => (
            <HorizonChip key={key} label={label} status={row.horizons[key]} />
          ))}
          {row.latestRoiPct !== null && (
            <span
              className={cn('ml-2 text-xs font-medium tabular-nums', row.latestRoiPct >= 0 ? 'text-emerald-400' : 'text-red-400')}
              title={`ROI at latest elapsed horizon (${row.latestElapsedHorizonLabel ?? '?'})`}
            >
              {fmtPct(row.latestRoiPct)} @ {row.latestElapsedHorizonLabel}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
