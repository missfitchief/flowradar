// FlowRadar — Wallet Graph Finder "Transaction Paths" table (Task 21 binding
// decision 6 / Spec §8.5 table 3).
//
// One row per TransactionPath (packages/core/src/graph/types.ts), already
// flattened to plain numbers by the API boundary. Sorted by
// totalPathValueUsd desc.

import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { fmtPct, fmtUsd, shortAddr } from '@/lib/format';
import { confidenceBand } from '@/components/graph/GraphCanvas';

export interface PathRow {
  addresses: string[];
  totalPathValueUsd: number;
  valueRetentionPct: number;
  timeGapMs: number;
  confidence: number;
}

export interface PathsTableProps {
  paths: PathRow[];
}

const CONFIDENCE_BADGE_CLASS: Record<string, string> = {
  strong: 'border-transparent bg-emerald-500/15 text-emerald-300',
  probable: 'border-transparent bg-sky-500/15 text-sky-300',
  possible: 'border-transparent bg-amber-500/15 text-amber-300',
  weak: 'border-transparent bg-zinc-500/15 text-zinc-400',
};

/** Humanizes a millisecond duration to its two largest non-zero units: "2d 4h" / "3h 12m" / "5m 10s" / "<1s". */
function fmtTimeGap(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 1) return '<1s';

  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function PathsTable({ paths }: PathsTableProps) {
  if (paths.length === 0) {
    return <p className="text-sm text-muted-foreground">No multi-hop value paths found.</p>;
  }

  const sorted = [...paths].sort((a, b) => b.totalPathValueUsd - a.totalPathValueUsd);

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Path</TableHead>
            <TableHead className="text-right">Hops</TableHead>
            <TableHead className="text-right">Total value</TableHead>
            <TableHead className="text-right">Value retention</TableHead>
            <TableHead className="text-right">Time gap</TableHead>
            <TableHead>Confidence</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.map((path, idx) => {
            const band = confidenceBand(path.confidence);
            return (
              <TableRow key={idx}>
                <TableCell>
                  <code className="text-xs text-muted-foreground">
                    {path.addresses.map((a) => shortAddr(a)).join(' → ')}
                  </code>
                </TableCell>
                <TableCell className="text-right tabular-nums">{Math.max(0, path.addresses.length - 1)}</TableCell>
                <TableCell className="text-right tabular-nums">{fmtUsd(path.totalPathValueUsd)}</TableCell>
                <TableCell className="text-right tabular-nums">{fmtPct(path.valueRetentionPct)}</TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">
                  {fmtTimeGap(path.timeGapMs)}
                </TableCell>
                <TableCell>
                  <Badge className={CONFIDENCE_BADGE_CLASS[band]}>
                    {path.confidence.toFixed(0)} ({band})
                  </Badge>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
