// FlowRadar — Money Flow "Entity Clusters" table (Task 24 binding decision 3
// / Spec §8.4 table B).
//
// Presentational leaf, EntityCluster + EntityClusterWallet joined server-side
// in page.tsx. Sorted walletCount desc (largest cluster first — NOVA's
// 19-wallet single-funder cluster per seed self-check, confidence 65).
// "Tokens traded" / recent buys / recent exits are derived server-side from
// each cluster's member WalletTokenTrade rows (via EntityCluster.trades,
// which is stamped with entityClusterId at scoring-pass time) — documented
// as a proxy metric (best-effort from the trade rows actually linked to the
// cluster, not a live re-scan of every member wallet's full trade history).

import { confidenceBand } from '@flowradar/core';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { fmtUsd, shortAddr } from '@/lib/format';

export interface ClusterRow {
  id: string;
  walletCount: number;
  total30dPnlUsd: number;
  chains: string[];
  tokensTraded: number;
  confidence: number;
  mainFundingSource: string | null;
  recentBuys24h: number;
  recentExits24h: number;
  isLargest: boolean;
}

export interface ClustersTableProps {
  rows: ClusterRow[];
}

export function ClustersTable({ rows }: ClustersTableProps) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No entity clusters detected yet.</p>;
  }

  const sorted = [...rows].sort((a, b) => b.walletCount - a.walletCount);

  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-hidden rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Cluster</TableHead>
              <TableHead className="text-right">Wallets</TableHead>
              <TableHead className="text-right">30d PnL</TableHead>
              <TableHead>Chains</TableHead>
              <TableHead className="text-right">Tokens traded</TableHead>
              <TableHead className="text-right">Confidence</TableHead>
              <TableHead>Main funding source</TableHead>
              <TableHead className="text-right">Recent buys (24h)</TableHead>
              <TableHead className="text-right">Recent exits (24h)</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((row) => (
              <TableRow key={row.id}>
                <TableCell>
                  <div className="flex items-center gap-1.5">
                    <code className="text-xs text-muted-foreground">{shortAddr(row.id)}</code>
                    {row.isLargest && (
                      <Badge className="border-transparent bg-primary/15 text-primary">largest</Badge>
                    )}
                  </div>
                </TableCell>
                <TableCell className="text-right tabular-nums">{row.walletCount}</TableCell>
                <TableCell
                  className={
                    row.total30dPnlUsd > 0
                      ? 'text-right tabular-nums text-emerald-400'
                      : row.total30dPnlUsd < 0
                        ? 'text-right tabular-nums text-red-400'
                        : 'text-right tabular-nums'
                  }
                >
                  {fmtUsd(row.total30dPnlUsd)}
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    {row.chains.map((chain) => (
                      <Badge
                        key={chain}
                        className={
                          chain === 'SOLANA'
                            ? 'border-transparent bg-violet-500/15 text-violet-300'
                            : 'border-transparent bg-amber-500/15 text-amber-300'
                        }
                      >
                        {chain}
                      </Badge>
                    ))}
                  </div>
                </TableCell>
                <TableCell className="text-right tabular-nums">{row.tokensTraded}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {row.confidence.toFixed(0)}{' '}
                  <span className="text-muted-foreground">({confidenceBand(row.confidence)})</span>
                </TableCell>
                <TableCell>
                  {row.mainFundingSource ? (
                    <code className="text-xs text-muted-foreground">{shortAddr(row.mainFundingSource)}</code>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums">{row.recentBuys24h}</TableCell>
                <TableCell className="text-right tabular-nums">{row.recentExits24h}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <p className="text-xs text-muted-foreground">
        &quot;Tokens traded&quot; and recent buy/exit counts are derived from each cluster&apos;s member trades
        recorded against it (proxy metric, not a live re-scan of every member wallet).
      </p>
    </div>
  );
}
