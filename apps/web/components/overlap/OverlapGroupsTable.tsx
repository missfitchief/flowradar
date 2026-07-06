// FlowRadar — Overlap Finder "recurring co-trader groups" table (Task 38,
// Wave 4.6, task-38-brief.md binding decision 5). Wallets sharing the exact
// same overlapping-token set within one search — a "possible entity cluster"
// (probabilistic wording, same framing precedent as ClustersTable's actual
// EntityCluster rows, but this is a much weaker signal — shared token-set
// membership only, no funding-graph corroboration — so the label is
// deliberately softer/qualified here).

import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { shortAddr } from '@/lib/format';

export interface OverlapGroupRow {
  overlapGroupId: string;
  walletCount: number;
  walletAddresses: string[];
  sharedTokenCount: number;
}

export interface OverlapGroupsTableProps {
  rows: OverlapGroupRow[];
}

const MAX_VISIBLE_MEMBERS = 10;

export function OverlapGroupsTable({ rows }: OverlapGroupsTableProps) {
  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No recurring co-trader groups found — no wallets shared the exact same overlapping-token set in this search.
      </p>
    );
  }

  const sorted = [...rows].sort((a, b) => b.walletCount - a.walletCount);

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Group</TableHead>
            <TableHead className="text-right">Wallets</TableHead>
            <TableHead className="text-right">Shared tokens</TableHead>
            <TableHead>Members</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.map((row) => {
            const visible = row.walletAddresses.slice(0, MAX_VISIBLE_MEMBERS);
            const hidden = row.walletAddresses.length - visible.length;
            return (
              <TableRow key={row.overlapGroupId}>
                <TableCell>
                  <div className="flex items-center gap-1.5">
                    <code className="text-xs text-muted-foreground">{row.overlapGroupId}</code>
                    <Badge className="border-transparent bg-violet-500/15 text-violet-300" title="Shared token-set membership only — not corroborated by funding-graph evidence.">
                      possible entity cluster
                    </Badge>
                  </div>
                </TableCell>
                <TableCell className="text-right tabular-nums">{row.walletCount}</TableCell>
                <TableCell className="text-right tabular-nums">{row.sharedTokenCount}</TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    {visible.map((addr) => (
                      <code key={addr} className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        {shortAddr(addr)}
                      </code>
                    ))}
                    {hidden > 0 && <Badge className="border-transparent bg-zinc-800/50 text-zinc-500">+{hidden}</Badge>}
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
