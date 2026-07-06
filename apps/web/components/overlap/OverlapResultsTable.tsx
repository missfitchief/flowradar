'use client';

// FlowRadar — Overlap Finder results table (Task 38, Wave 4.6,
// task-38-brief.md binding decision 4).
//
// One row per TokenOverlapWalletResult: wallet (shortAddr + explorer link),
// tokensOverlapCount ("N of M") with a traded-all badge, totalBuyUsd,
// estimatedPnlUsd (signed color), firstBuyTime age, buy/sell counts, and a
// candidate-status chip (pending/promoted/rejected/none — the CandidateWallet
// join from GET /api/overlap/[id]) so the operator sees pipeline state.
// Sorted estimatedPnlUsd desc (nulls last) then tokensOverlapCount desc.
// Client-side view toggles (traded-all / bought-all-early / has-est-PnL) over
// the already-loaded rows — no new fetch. Display capped at 500.

import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { fmtAge, fmtUsd, shortAddr } from '@/lib/format';
import { cn } from '@/lib/utils';

export type OverlapCandidateStatus = 'pending' | 'validating' | 'promoted' | 'rejected' | null;

export interface OverlapWalletRow {
  walletAddress: string;
  chain: string;
  tokensOverlapCount: number;
  totalBuyUsd: number | null;
  totalSellUsd: number | null;
  estimatedPnlUsd: number | null;
  firstBuyTime: string | null; // ISO
  buyCount: number | null;
  sellCount: number | null;
  entryMarketCapUsd: number | null;
  overlapGroupId: string | null;
  candidateStatus: OverlapCandidateStatus;
}

export interface OverlapResultsTableProps {
  rows: OverlapWalletRow[];
  tokenCount: number;
  explorerAddressUrlTemplate?: string | null;
}

const DISPLAY_CAP = 500;
const EARLY_WINDOW_MS = 24 * 60 * 60 * 1000; // "bought early" = within 24h of the search's earliest observed first-buy

type ViewFilter = 'all' | 'traded-all' | 'bought-all-early' | 'has-est-pnl';

const CANDIDATE_BADGE_CLASS: Record<NonNullable<OverlapCandidateStatus>, string> = {
  pending: 'border-transparent bg-amber-500/15 text-amber-300',
  validating: 'border-transparent bg-sky-500/15 text-sky-300',
  promoted: 'border-transparent bg-emerald-500/15 text-emerald-300',
  rejected: 'border-transparent bg-red-500/15 text-red-400',
};

function fillUrlTemplate(template: string, address: string): string {
  return template.replaceAll('{address}', address);
}

function pnlClass(n: number | null): string {
  if (n === null) return 'text-muted-foreground';
  if (n > 0) return 'text-emerald-400';
  if (n < 0) return 'text-red-400';
  return 'text-muted-foreground';
}

function fmtSignedUsd(n: number | null): string {
  if (n === null) return '—';
  return n >= 0 ? `+${fmtUsd(n)}` : `-${fmtUsd(Math.abs(n))}`;
}

export function OverlapResultsTable({ rows, tokenCount, explorerAddressUrlTemplate }: OverlapResultsTableProps) {
  const [filter, setFilter] = useState<ViewFilter>('all');

  const earliestFirstBuyMs = useMemo(() => {
    const times = rows.map((r) => (r.firstBuyTime ? new Date(r.firstBuyTime).getTime() : null)).filter((t): t is number => t !== null);
    return times.length > 0 ? Math.min(...times) : null;
  }, [rows]);

  const filtered = useMemo(() => {
    switch (filter) {
      case 'traded-all':
        return rows.filter((r) => r.tokensOverlapCount === tokenCount);
      case 'bought-all-early':
        return rows.filter(
          (r) =>
            r.tokensOverlapCount === tokenCount &&
            r.firstBuyTime !== null &&
            earliestFirstBuyMs !== null &&
            new Date(r.firstBuyTime).getTime() - earliestFirstBuyMs <= EARLY_WINDOW_MS,
        );
      case 'has-est-pnl':
        return rows.filter((r) => r.estimatedPnlUsd !== null);
      default:
        return rows;
    }
  }, [rows, filter, tokenCount, earliestFirstBuyMs]);

  const sorted = useMemo(
    () =>
      [...filtered]
        .sort((a, b) => {
          if (a.estimatedPnlUsd === null && b.estimatedPnlUsd === null) return b.tokensOverlapCount - a.tokensOverlapCount;
          if (a.estimatedPnlUsd === null) return 1;
          if (b.estimatedPnlUsd === null) return -1;
          if (b.estimatedPnlUsd !== a.estimatedPnlUsd) return b.estimatedPnlUsd - a.estimatedPnlUsd;
          return b.tokensOverlapCount - a.tokensOverlapCount;
        })
        .slice(0, DISPLAY_CAP),
    [filtered],
  );

  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No overlapping wallets found for these tokens.</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {(
          [
            ['all', 'All'],
            ['traded-all', 'Traded all'],
            ['bought-all-early', 'Bought all early (24h)'],
            ['has-est-pnl', 'Has est. PnL'],
          ] as [ViewFilter, string][]
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setFilter(value)}
            className={cn(
              'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
              filter === value
                ? 'border-primary/40 bg-primary/15 text-primary'
                : 'border-border text-muted-foreground hover:bg-muted/50',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="overflow-hidden rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Wallet</TableHead>
              <TableHead className="text-right">Overlap</TableHead>
              <TableHead className="text-right">Total buy</TableHead>
              <TableHead className="text-right">Est. PnL</TableHead>
              <TableHead>First buy</TableHead>
              <TableHead className="text-right">Buys</TableHead>
              <TableHead className="text-right">Sells</TableHead>
              <TableHead>Candidate status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((row) => {
              const explorerUrl = explorerAddressUrlTemplate ? fillUrlTemplate(explorerAddressUrlTemplate, row.walletAddress) : null;
              const tradedAll = row.tokensOverlapCount === tokenCount;
              return (
                <TableRow key={row.walletAddress}>
                  <TableCell>
                    {explorerUrl ? (
                      <a href={explorerUrl} target="_blank" rel="noopener noreferrer" className="font-mono text-xs text-muted-foreground hover:underline">
                        {shortAddr(row.walletAddress)}
                      </a>
                    ) : (
                      <code className="text-xs text-muted-foreground">{shortAddr(row.walletAddress)}</code>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    <div className="flex items-center justify-end gap-1.5">
                      <span>
                        {row.tokensOverlapCount} of {tokenCount}
                      </span>
                      {tradedAll && <Badge className="border-transparent bg-violet-500/15 text-violet-300">traded all</Badge>}
                    </div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{row.totalBuyUsd !== null ? fmtUsd(row.totalBuyUsd) : '—'}</TableCell>
                  <TableCell className={cn('text-right tabular-nums', pnlClass(row.estimatedPnlUsd))}>
                    {fmtSignedUsd(row.estimatedPnlUsd)}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {row.firstBuyTime ? `${fmtAge(new Date(row.firstBuyTime))} ago` : '—'}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{row.buyCount ?? '—'}</TableCell>
                  <TableCell className="text-right tabular-nums">{row.sellCount ?? '—'}</TableCell>
                  <TableCell>
                    {row.candidateStatus ? (
                      <Badge className={CANDIDATE_BADGE_CLASS[row.candidateStatus]}>{row.candidateStatus}</Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">not a candidate</span>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      {filtered.length > DISPLAY_CAP && (
        <p className="text-xs text-muted-foreground">
          Showing {DISPLAY_CAP} of {filtered.length} wallets.
        </p>
      )}
    </div>
  );
}
