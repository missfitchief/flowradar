// FlowRadar — Money Flow "Suspicious Rotations" table (Task 24 binding
// decision 2 / product brief Module 9 (Money Flow page) / plan Task 24, table A).
//
// Presentational leaf (no Prisma coupling), same pattern as
// ConnectedWalletsTable/WalletBuyersTable: plain JSON-serializable rows in,
// sorted realizedProfitUsd desc, capped display, explicit empty state.

import { confidenceBand } from '@flowradar/core';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { fmtPct, fmtUsd, shortAddr } from '@/lib/format';

export interface RotationRow {
  id: string;
  sourceWalletAddress: string;
  sourceWalletExplorerUrl: string | null;
  destWalletAddress: string;
  destWalletExplorerUrl: string | null;
  sourceTokenId: string;
  sourceTokenSymbol: string;
  destTokenId: string;
  destTokenSymbol: string;
  realizedProfitUsd: number;
  transferredValueUsd: number;
  chainPath: string[];
  timeGapMin: number;
  confidence: number;
  currentDestPerfPct: number;
}

export interface RotationsTableProps {
  rows: RotationRow[];
}

const DISPLAY_CAP = 100;

/** Coarsens a raw minute count into "Xm" / "Xh Ym" / "Xd Yh", same two-largest-units shape as fmtAge. */
function fmtGapMinutes(totalMinutes: number): string {
  const minutes = Math.max(0, Math.round(totalMinutes));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

export function RotationsTable({ rows }: RotationsTableProps) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No cross-token capital rotations detected yet.</p>;
  }

  const sorted = [...rows].sort((a, b) => b.realizedProfitUsd - a.realizedProfitUsd).slice(0, DISPLAY_CAP);

  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-hidden rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Source wallet</TableHead>
              <TableHead>Dest wallet</TableHead>
              <TableHead>Rotation</TableHead>
              <TableHead className="text-right">Realized profit</TableHead>
              <TableHead className="text-right">Transferred</TableHead>
              <TableHead>Chain path</TableHead>
              <TableHead className="text-right">Time gap</TableHead>
              <TableHead className="text-right">Confidence</TableHead>
              <TableHead className="text-right">Dest perf. since</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((row) => (
              <TableRow key={row.id}>
                <TableCell>
                  {row.sourceWalletExplorerUrl ? (
                    <a
                      href={row.sourceWalletExplorerUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-mono text-xs text-muted-foreground hover:underline"
                    >
                      {shortAddr(row.sourceWalletAddress)}
                    </a>
                  ) : (
                    <code className="text-xs text-muted-foreground">{shortAddr(row.sourceWalletAddress)}</code>
                  )}
                </TableCell>
                <TableCell>
                  {row.destWalletExplorerUrl ? (
                    <a
                      href={row.destWalletExplorerUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-mono text-xs text-muted-foreground hover:underline"
                    >
                      {shortAddr(row.destWalletAddress)}
                    </a>
                  ) : (
                    <code className="text-xs text-muted-foreground">{shortAddr(row.destWalletAddress)}</code>
                  )}
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-1.5 text-sm">
                    <a href={`/tokens/${row.sourceTokenId}`} className="font-medium hover:underline">
                      ${row.sourceTokenSymbol}
                    </a>
                    <span className="text-muted-foreground">→</span>
                    <a href={`/tokens/${row.destTokenId}`} className="font-medium hover:underline">
                      ${row.destTokenSymbol}
                    </a>
                  </div>
                </TableCell>
                <TableCell className="text-right tabular-nums text-emerald-400">
                  {fmtUsd(row.realizedProfitUsd)}
                </TableCell>
                <TableCell className="text-right tabular-nums">{fmtUsd(row.transferredValueUsd)}</TableCell>
                <TableCell>
                  <span className="text-xs text-muted-foreground">{row.chainPath.join(' → ')}</span>
                </TableCell>
                <TableCell className="text-right tabular-nums text-xs text-muted-foreground">
                  {fmtGapMinutes(row.timeGapMin)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {row.confidence.toFixed(0)}{' '}
                  <span className="text-muted-foreground">({confidenceBand(row.confidence)})</span>
                </TableCell>
                <TableCell
                  className={cn(
                    'text-right tabular-nums',
                    row.currentDestPerfPct > 0
                      ? 'text-emerald-400'
                      : row.currentDestPerfPct < 0
                        ? 'text-red-400'
                        : '',
                  )}
                >
                  {fmtPct(row.currentDestPerfPct)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {rows.length > DISPLAY_CAP && (
        <p className="text-xs text-muted-foreground">
          Showing {DISPLAY_CAP} of {rows.length} rotations.
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        <Badge className="border-transparent bg-zinc-500/15 text-zinc-300">note</Badge>{' '}
        Confidence is probabilistic (band from a weighted-evidence score), not a certainty claim.
      </p>
    </div>
  );
}
