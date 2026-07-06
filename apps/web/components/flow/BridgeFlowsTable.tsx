// FlowRadar — Money Flow "Bridge Flows" table (Task 24 binding decision 4 /
// Spec §8.4 table C).
//
// Presentational leaf. A bridge hop is ingested as TWO same-chain
// MoneyFlowEdge rows (a bridge_deposit on the source chain, a
// bridge_withdrawal on the destination chain — see packages/db/src/ingest.ts
// header) joined only by asset+amount+time+protocol proximity, never a
// single cross-chain row (packages/db/src/bridgeFlow.ts documents the same
// shape for its own DB-mutating confidence pass). This table receives
// already-paired rows (pairing done server-side in page.tsx, read-only,
// mirroring bridgeFlow.ts's tolerance without writing back to the DB) plus
// any leftover unmatched singles, sorted amount desc.

import { confidenceBand } from '@flowradar/core';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { fmtAge, fmtUsd, shortAddr } from '@/lib/format';

export interface BridgeFlowRow {
  id: string;
  sourceChain: string;
  destChain: string;
  sourceAddress: string;
  destAddress: string;
  asset: string;
  amountUsd: number;
  bridgeProtocol: string;
  ts: string; // ISO
  confidence: number;
  matched: boolean;
}

export interface BridgeFlowsTableProps {
  rows: BridgeFlowRow[];
}

const DISPLAY_CAP = 100;

export function BridgeFlowsTable({ rows }: BridgeFlowsTableProps) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No bridge flows detected yet.</p>;
  }

  const sorted = [...rows].sort((a, b) => b.amountUsd - a.amountUsd).slice(0, DISPLAY_CAP);

  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-hidden rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Source chain</TableHead>
              <TableHead>Dest chain</TableHead>
              <TableHead>Source wallet</TableHead>
              <TableHead>Dest wallet</TableHead>
              <TableHead>Asset</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead>Bridge</TableHead>
              <TableHead>Time</TableHead>
              <TableHead className="text-right">Confidence</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((row) => (
              <TableRow key={row.id}>
                <TableCell>
                  <Badge className="border-transparent bg-violet-500/15 text-violet-300">{row.sourceChain}</Badge>
                </TableCell>
                <TableCell>
                  <Badge className="border-transparent bg-amber-500/15 text-amber-300">{row.destChain}</Badge>
                </TableCell>
                <TableCell>
                  <code className="text-xs text-muted-foreground">{shortAddr(row.sourceAddress)}</code>
                </TableCell>
                <TableCell>
                  <code className="text-xs text-muted-foreground">{shortAddr(row.destAddress)}</code>
                </TableCell>
                <TableCell className="text-xs">{row.asset}</TableCell>
                <TableCell className="text-right tabular-nums">{fmtUsd(row.amountUsd)}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{row.bridgeProtocol}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{fmtAge(new Date(row.ts))} ago</TableCell>
                <TableCell className="text-right tabular-nums">
                  <div className="flex items-center justify-end gap-1.5">
                    <span>
                      {row.confidence.toFixed(0)}{' '}
                      <span className="text-muted-foreground">({confidenceBand(row.confidence)})</span>
                    </span>
                    {!row.matched && (
                      <Badge className="border-transparent bg-zinc-500/15 text-zinc-300">unmatched leg</Badge>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {rows.length > DISPLAY_CAP && (
        <p className="text-xs text-muted-foreground">
          Showing {DISPLAY_CAP} of {rows.length} bridge flows.
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        Rows marked <span className="text-foreground">unmatched leg</span> are a single bridge_deposit or
        bridge_withdrawal that could not be paired to its counterpart within the matching window — shown singly
        rather than dropped.
      </p>
    </div>
  );
}
