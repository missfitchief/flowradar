'use client';

// FlowRadar — Alerts feed (Task 17 binding decision 1).
//
// Client-side presentational feed over already-shaped rows (the DB query,
// Signal+Token join, and Decimal->number/Date->Date conversion all live in
// app/alerts/page.tsx — this component never touches Prisma). Filtering is
// pure client-side useState, no URL params (binding decision 1: "client, URL-
// param-free, simple useState") — a page refresh always resets filters to
// "show everything", which is fine for an ops-facing feed like this one.
//
// AlertRow.severity is read off the JOINED Signal row, not Alert itself
// (Alert has no severity column — see packages/db/src/alerts.ts's own
// "Alert itself doesn't carry severity" comment) — null when an Alert has no
// linked Signal at all (e.g. a TEST-kind row from /api/alerts/test).

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { fmtAge, fmtPct, fmtUsd } from '@/lib/format';

/**
 * Renders `fmtAge(date)`, but only computed CLIENT-SIDE, after mount.
 *
 * fmtAge() reads Date.now() internally, so a naive `{fmtAge(date)}` call
 * inside a server-rendered client component computes a DIFFERENT string on
 * the server (render time) vs. the client (hydration time, ~1-2s later) —
 * for a just-fired alert this lands in fmtAge's second-granularity band
 * ("17m 38s" vs "17m 39s"), which is close enough to flip the string and
 * trip a React hydration mismatch (confirmed via the dev overlay while
 * verifying this page against the freshly-seeded DB, where every alert is
 * only minutes old). Rendering a fixed placeholder for the initial
 * (server-matching) pass and swapping to the live value in a useEffect
 * — same "nothing time-sensitive until after mount" shape as
 * components/AutoRefresh.tsx uses for its own interval — sidesteps this
 * without needing suppressHydrationWarning (which would hide a REAL future
 * mismatch here, not just this one).
 */
function RelativeAge({ date }: { date: Date }) {
  const [label, setLabel] = useState<string | null>(null);

  useEffect(() => {
    setLabel(fmtAge(date));
    const id = setInterval(() => setLabel(fmtAge(date)), 1000);
    return () => clearInterval(id);
  }, [date]);

  return <>{label ?? '…'}</>;
}

export type AlertSeverity = 'INFO' | 'WATCH' | 'HIGH' | 'CRITICAL';
export type AlertRule = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G';
export type AlertDeliveryStatus = 'sent' | 'skipped_no_token' | 'skipped_cooldown' | 'failed';

/**
 * One row of the Alerts feed. Plain, JSON-serializable data only (numbers,
 * strings, Date) — no Prisma.Decimal — matching every other presentational
 * component's contract in this app (HotTokensTable, WalletBuyersTable, ...).
 */
export interface AlertFeedRow {
  id: string;
  sentAt: Date;
  deliveryStatus: AlertDeliveryStatus;
  /** Null for a TEST-kind alert (no linked Signal, no linked Token). */
  tokenId: string | null;
  tokenSymbol: string | null;
  rule: AlertRule | null;
  /** From the joined Signal row — null when this Alert has no linked Signal (e.g. TEST). */
  severity: AlertSeverity | null;
  reasons: string[];
  walletCount: number | null;
  uniqueEntityCount: number | null;
  netFlowUsd: number | null;
  mcapAtTrigger: number | null;
  /** Latest TokenMarketSnapshot.marketCapUsd for this token, if any snapshot exists. */
  currentMcapUsd: number | null;
  /** Rendered Telegram HTML payload text (payload.text) — shown in the expandable <details>. */
  payloadText: string;
}

const SEVERITIES: AlertSeverity[] = ['INFO', 'WATCH', 'HIGH', 'CRITICAL'];
const RULES: AlertRule[] = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];

const RULE_NAME: Record<AlertRule, string> = {
  A: 'Coordinated Accumulation',
  B: 'Slow Accumulation',
  C: 'Organic Distribution',
  D: 'Whale Entry',
  E: 'Funded Fresh Wallets',
  F: 'Profit Rotation',
  G: 'Smart Money Exit',
};

/** WATCH is amber-outline (binding decision 1), everything else is a filled badge. */
const SEVERITY_BADGE_CLASS: Record<AlertSeverity, string> = {
  INFO: 'border-transparent bg-zinc-500/15 text-zinc-300',
  WATCH: 'border-amber-500/40 bg-transparent text-amber-400',
  HIGH: 'border-transparent bg-orange-500/15 text-orange-300',
  CRITICAL: 'border-transparent bg-red-500/15 text-red-400',
};

const DELIVERY_BADGE_CLASS: Record<AlertDeliveryStatus, string> = {
  sent: 'border-transparent bg-emerald-500/15 text-emerald-300',
  skipped_no_token: 'border-transparent bg-zinc-500/15 text-zinc-400',
  skipped_cooldown: 'border-transparent bg-zinc-500/15 text-zinc-400',
  failed: 'border-transparent bg-red-500/15 text-red-400',
};

const DELIVERY_LABEL: Record<AlertDeliveryStatus, string> = {
  sent: 'sent',
  skipped_no_token: 'not configured',
  skipped_cooldown: 'cooldown',
  failed: 'failed',
};

/** Renders "N (M entities)" when the two counts diverge, plain number when equal or entity count is unavailable (mirrors HotTokensTable's fmtWalletVsEntity). */
function fmtWalletVsEntity(raw: number, entities: number | null): string {
  if (entities === null || raw === entities) return `${raw}`;
  return `${raw} (${entities} entities)`;
}

function fmtMcapPerf(mcapAtTrigger: number | null, currentMcapUsd: number | null): { label: string; className: string } | null {
  if (mcapAtTrigger === null || mcapAtTrigger <= 0 || currentMcapUsd === null) return null;
  const pctChange = ((currentMcapUsd - mcapAtTrigger) / mcapAtTrigger) * 100;
  return {
    label: fmtPct(pctChange),
    className: pctChange >= 0 ? 'text-emerald-400' : 'text-red-400',
  };
}

interface SeverityToggleProps {
  active: Set<AlertSeverity>;
  onToggle: (severity: AlertSeverity) => void;
}

function SeverityToggle({ active, onToggle }: SeverityToggleProps) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {SEVERITIES.map((severity) => {
        const isActive = active.has(severity);
        return (
          <Button
            key={severity}
            type="button"
            size="sm"
            variant={isActive ? 'secondary' : 'outline'}
            onClick={() => onToggle(severity)}
            aria-pressed={isActive}
          >
            {severity}
          </Button>
        );
      })}
    </div>
  );
}

export interface AlertsFeedProps {
  rows: AlertFeedRow[];
}

export function AlertsFeed({ rows }: AlertsFeedProps) {
  const [activeSeverities, setActiveSeverities] = useState<Set<AlertSeverity>>(new Set(SEVERITIES));
  const [ruleFilter, setRuleFilter] = useState<AlertRule | 'ALL'>('ALL');
  const [signalsOnly, setSignalsOnly] = useState(false);

  function toggleSeverity(severity: AlertSeverity): void {
    setActiveSeverities((prev) => {
      const next = new Set(prev);
      if (next.has(severity)) next.delete(severity);
      else next.add(severity);
      return next;
    });
  }

  const filtered = useMemo(() => {
    return rows.filter((row) => {
      if (signalsOnly && row.rule === null) return false;
      if (ruleFilter !== 'ALL' && row.rule !== ruleFilter) return false;
      // Rows with no severity (TEST alerts) always pass the severity filter —
      // it has nothing to do with severity, so hiding it under an unrelated
      // toggle would be surprising. Rows WITH a severity are filtered normally.
      if (row.severity !== null && !activeSeverities.has(row.severity)) return false;
      return true;
    });
  }, [rows, activeSeverities, ruleFilter, signalsOnly]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-4 rounded-lg border border-border p-3">
        <div>
          <div className="mb-1.5 text-xs font-medium text-muted-foreground">Severity</div>
          <SeverityToggle active={activeSeverities} onToggle={toggleSeverity} />
        </div>

        <div>
          <div className="mb-1.5 text-xs font-medium text-muted-foreground">Rule</div>
          <Select value={ruleFilter} onValueChange={(v) => setRuleFilter(v as AlertRule | 'ALL')}>
            <SelectTrigger size="sm" className="w-40">
              <SelectValue placeholder="All rules" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All rules</SelectItem>
              {RULES.map((rule) => (
                <SelectItem key={rule} value={rule}>
                  {rule} — {RULE_NAME[rule]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div>
          <div className="mb-1.5 text-xs font-medium text-muted-foreground">Scope</div>
          <div className="flex gap-1.5">
            <Button type="button" size="sm" variant={!signalsOnly ? 'secondary' : 'outline'} onClick={() => setSignalsOnly(false)}>
              All alerts
            </Button>
            <Button type="button" size="sm" variant={signalsOnly ? 'secondary' : 'outline'} onClick={() => setSignalsOnly(true)}>
              Signals only
            </Button>
          </div>
        </div>

        <div className="ml-auto text-xs text-muted-foreground">
          {filtered.length} of {rows.length}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          {rows.length === 0 ? 'No alerts have fired yet.' : 'No alerts match the current filters.'}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {filtered.map((row) => (
            <AlertCard key={row.id} row={row} />
          ))}
        </div>
      )}
    </div>
  );
}

function AlertCard({ row }: { row: AlertFeedRow }) {
  const perf = fmtMcapPerf(row.mcapAtTrigger, row.currentMcapUsd);
  const reasons = row.reasons.slice(0, 4);

  return (
    <Card>
      <CardContent>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            {row.severity && <Badge className={SEVERITY_BADGE_CLASS[row.severity]}>{row.severity}</Badge>}
            {row.rule && (
              <Badge variant="outline">
                {row.rule} · {RULE_NAME[row.rule]}
              </Badge>
            )}
            {row.tokenId && row.tokenSymbol ? (
              <Link href={`/tokens/${row.tokenId}`} className="font-medium hover:underline">
                ${row.tokenSymbol}
              </Link>
            ) : (
              <span className="font-medium text-muted-foreground">TEST alert</span>
            )}
          </div>

          <div className="flex items-center gap-2">
            <Badge className={DELIVERY_BADGE_CLASS[row.deliveryStatus]}>{DELIVERY_LABEL[row.deliveryStatus]}</Badge>
            <span className="text-xs text-muted-foreground" title={row.sentAt.toISOString()}>
              <RelativeAge date={row.sentAt} /> ago
            </span>
          </div>
        </div>

        {reasons.length > 0 && (
          <ul className="mt-3 space-y-1 text-sm text-muted-foreground">
            {reasons.map((reason, idx) => (
              <li key={idx} className="flex gap-2">
                <span aria-hidden="true">•</span>
                <span>{reason}</span>
              </li>
            ))}
          </ul>
        )}

        {(row.walletCount !== null || row.netFlowUsd !== null || row.mcapAtTrigger !== null) && (
          <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2 border-t border-border pt-3 text-sm">
            {row.walletCount !== null && (
              <div>
                <div className="text-xs text-muted-foreground">Wallets</div>
                <div className="font-medium tabular-nums">{fmtWalletVsEntity(row.walletCount, row.uniqueEntityCount)}</div>
              </div>
            )}
            {row.netFlowUsd !== null && (
              <div>
                <div className="text-xs text-muted-foreground">Net flow</div>
                <div className={cn('font-medium tabular-nums', row.netFlowUsd >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                  {row.netFlowUsd >= 0 ? '+' : ''}
                  {fmtUsd(row.netFlowUsd)}
                </div>
              </div>
            )}
            {row.mcapAtTrigger !== null && (
              <div>
                <div className="text-xs text-muted-foreground">Mcap at trigger → now</div>
                <div className="font-medium tabular-nums">
                  {fmtUsd(row.mcapAtTrigger)}
                  {row.currentMcapUsd !== null && <> → {fmtUsd(row.currentMcapUsd)}</>}
                  {perf && <span className={cn('ml-1.5', perf.className)}>({perf.label})</span>}
                </div>
              </div>
            )}
          </div>
        )}

        <details className="mt-3 text-xs">
          <summary className="cursor-pointer select-none text-muted-foreground hover:text-foreground">
            View rendered payload
          </summary>
          <pre className="mt-2 max-h-80 overflow-auto rounded-md bg-muted/30 p-3 whitespace-pre-wrap text-muted-foreground">
            {row.payloadText}
          </pre>
        </details>
      </CardContent>
    </Card>
  );
}
