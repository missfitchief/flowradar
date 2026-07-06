'use client';

// FlowRadar — Wallet Graph Finder "Connected Wallets" table (Task 21 binding
// decision 5 / Spec §8.5 table 2).
//
// Presentational leaf, same pattern as WalletBuyersTable — takes plain
// JSON-serializable rows, no Prisma coupling. Sorted by netFlowUsd desc by
// default; the root address is marked with a badge rather than excluded
// outright (a search's own root is still a meaningful row — e.g. its total
// sent/received against everything discovered — so hiding it would lose
// information; binding decision 5 allows either, this picks "mark it").
// Display capped at 500 rows.

import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { fmtAge, fmtUsd, shortAddr } from '@/lib/format';
import { confidenceBand } from '@/components/graph/GraphCanvas';
import type { GraphNodeType } from '@/components/graph/GraphCanvas';

export interface ConnectedWalletRow {
  address: string;
  depth: number;
  nodeType: GraphNodeType;
  totalSentUsd: number;
  totalReceivedUsd: number;
  netFlowUsd: number;
  interactionCount: number;
  firstSeen: string;
  lastSeen: string;
  tags: string[];
  confidence: number;
}

export interface ConnectedWalletsTableProps {
  rows: ConnectedWalletRow[];
  rootAddress: string;
  explorerAddressUrlTemplate?: string | null;
}

const DISPLAY_CAP = 500;

const NODE_TYPE_BADGE_CLASS: Record<GraphNodeType, string> = {
  WALLET: 'border-transparent bg-slate-500/15 text-slate-300',
  CEX: 'border-transparent bg-amber-500/15 text-amber-300',
  BRIDGE: 'border-transparent bg-violet-500/15 text-violet-300',
  ROUTER: 'border-transparent bg-sky-500/15 text-sky-300',
  POOL: 'border-transparent bg-teal-500/15 text-teal-300',
  TOKEN_CONTRACT: 'border-transparent bg-zinc-500/15 text-zinc-300',
  CONTRACT: 'border-transparent bg-zinc-500/15 text-zinc-300',
  UNKNOWN: 'border-transparent bg-zinc-800/50 text-zinc-500',
};

function fillUrlTemplate(template: string, address: string): string {
  return template.replaceAll('{address}', address);
}

export function ConnectedWalletsTable({ rows, rootAddress, explorerAddressUrlTemplate }: ConnectedWalletsTableProps) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No connected wallets found for this search.</p>;
  }

  const sorted = [...rows].sort((a, b) => b.netFlowUsd - a.netFlowUsd).slice(0, DISPLAY_CAP);

  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-hidden rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Wallet</TableHead>
              <TableHead className="text-right">Depth</TableHead>
              <TableHead>Type</TableHead>
              <TableHead className="text-right">Sent</TableHead>
              <TableHead className="text-right">Received</TableHead>
              <TableHead className="text-right">Net flow</TableHead>
              <TableHead className="text-right">Interactions</TableHead>
              <TableHead>First seen</TableHead>
              <TableHead>Last seen</TableHead>
              <TableHead>Tags</TableHead>
              <TableHead className="text-right">Confidence</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((row) => {
              const isRoot = row.address === rootAddress;
              const explorerUrl = explorerAddressUrlTemplate
                ? fillUrlTemplate(explorerAddressUrlTemplate, row.address)
                : null;
              return (
                <TableRow key={row.address}>
                  <TableCell>
                    <div className="flex items-center gap-1.5">
                      {explorerUrl ? (
                        <a
                          href={explorerUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-mono text-xs text-muted-foreground hover:underline"
                        >
                          {shortAddr(row.address)}
                        </a>
                      ) : (
                        <code className="text-xs text-muted-foreground">{shortAddr(row.address)}</code>
                      )}
                      {isRoot && <Badge className="border-transparent bg-primary/15 text-primary">root</Badge>}
                    </div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{row.depth}</TableCell>
                  <TableCell>
                    <Badge className={NODE_TYPE_BADGE_CLASS[row.nodeType] ?? NODE_TYPE_BADGE_CLASS.UNKNOWN}>
                      {row.nodeType}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{fmtUsd(row.totalSentUsd)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtUsd(row.totalReceivedUsd)}</TableCell>
                  <TableCell
                    className={cn(
                      'text-right tabular-nums',
                      row.netFlowUsd > 0 ? 'text-emerald-400' : row.netFlowUsd < 0 ? 'text-red-400' : '',
                    )}
                  >
                    {fmtUsd(row.netFlowUsd)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{row.interactionCount}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{fmtAge(new Date(row.firstSeen))} ago</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{fmtAge(new Date(row.lastSeen))} ago</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {row.tags.length === 0 ? (
                        <span className="text-xs text-muted-foreground">—</span>
                      ) : (
                        row.tags.map((tag) => (
                          <span key={tag} className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                            {tag}
                          </span>
                        ))
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {row.confidence.toFixed(0)}{' '}
                    <span className="text-muted-foreground">({confidenceBand(row.confidence)})</span>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      {rows.length > DISPLAY_CAP && (
        <p className="text-xs text-muted-foreground">Showing {DISPLAY_CAP} of {rows.length} wallets.</p>
      )}
    </div>
  );
}
