'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { fmtPct, fmtUsd, shortAddr } from '@/lib/format';

// Wallet.chain (@flowradar/db's ChainId) spelled out as a literal union so
// this component stays a plain presentational leaf with no Prisma coupling —
// same pattern as HotTokensTable's HotTokenChain / WalletBuyersTable's
// BuyerWalletLabel.
export type LeaderboardChain = 'SOLANA' | 'BSC';

// WalletStats.source (@flowradar/db's StatsSource), same reasoning.
export type LeaderboardSource = 'csv' | 'computed' | 'provider';

// WalletClassification.label (@flowradar/db's WalletLabel), same reasoning.
export type LeaderboardLabel =
  | 'human_like'
  | 'smart_money'
  | 'whale'
  | 'possible_bot'
  | 'sniper'
  | 'mev'
  | 'deployer_related'
  | 'copy_trader'
  | 'cex_related'
  | 'bridge_related'
  | 'unknown';

/** One best/worst-performing recent token for a wallet, derived from WalletTokenTrade (sellUsd - buyUsd per token). Null when the wallet has no trade history to derive one from. */
export interface WalletTokenPnl {
  tokenId: string;
  symbol: string;
  deltaUsd: number;
}

/**
 * One wallet leaderboard row. Plain, JSON-serializable data only (numbers,
 * strings, booleans) — no Prisma.Decimal, no Date — per the established
 * server-component-queries/client-component-renders-serialized-rows
 * invariant (binding decision #9, task 9's report).
 */
export interface WalletLeaderboardRow {
  walletId: string;
  address: string;
  chain: LeaderboardChain;
  pnlUsd: number;
  winRate: number; // 0-1 fraction, matches WalletStats.winRate
  tradeCount: number;
  avgTradeSizeUsd: number;
  walletScore: number;
  source: LeaderboardSource;
  labels: LeaderboardLabel[];
  bestToken: WalletTokenPnl | null;
  worstToken: WalletTokenPnl | null;
  /** Meets every settings.profitableWallet threshold (binding decision #2) — drives the emerald left-border highlight. */
  meetsProfitableThreshold: boolean;
}

export interface LeaderboardTableProps {
  rows: WalletLeaderboardRow[];
}

type SortColumn = 'pnl' | 'winRate' | 'tradeCount' | 'score';
type SortDirection = 'asc' | 'desc';

const CHAIN_BADGE_CLASS: Record<LeaderboardChain, string> = {
  SOLANA: 'border-transparent bg-violet-500/15 text-violet-300',
  BSC: 'border-transparent bg-amber-500/15 text-amber-300',
};

const SOURCE_BADGE_CLASS: Record<LeaderboardSource, string> = {
  csv: 'border-transparent bg-violet-500/15 text-violet-300',
  computed: 'border-transparent bg-zinc-500/15 text-zinc-300',
  provider: 'border-transparent bg-sky-500/15 text-sky-300',
};

const LABEL_BADGE_CLASS: Record<LeaderboardLabel, string> = {
  human_like: 'border-transparent bg-emerald-500/15 text-emerald-300',
  smart_money: 'border-transparent bg-violet-500/15 text-violet-300',
  whale: 'border-transparent bg-blue-500/15 text-blue-300',
  possible_bot: 'border-transparent bg-amber-500/15 text-amber-300',
  sniper: 'border-transparent bg-orange-500/15 text-orange-300',
  mev: 'border-transparent bg-orange-500/15 text-orange-300',
  deployer_related: 'border-transparent bg-red-500/15 text-red-400',
  copy_trader: 'border-transparent bg-cyan-500/15 text-cyan-300',
  cex_related: 'border-transparent bg-zinc-500/15 text-zinc-300',
  bridge_related: 'border-transparent bg-zinc-500/15 text-zinc-300',
  unknown: 'border-transparent bg-zinc-800/50 text-zinc-500',
};

const MAX_VISIBLE_LABELS = 3;

/** Wallet score color ramp — identical to FlowScore's (binding decision #3 / HotTokensTable's flowScoreClass): >=70 emerald, 40-69 amber, <40 zinc. */
function walletScoreClass(score: number): string {
  if (score >= 70) return 'text-emerald-400';
  if (score >= 40) return 'text-amber-400';
  return 'text-zinc-400';
}

function pnlClass(n: number): string {
  if (n > 0) return 'text-emerald-400';
  if (n < 0) return 'text-red-400';
  return 'text-muted-foreground';
}

function fmtSignedUsd(n: number): string {
  return n >= 0 ? `+${fmtUsd(n)}` : `-${fmtUsd(Math.abs(n))}`;
}

function fmtWinRate(rate: number): string {
  return fmtPct(rate * 100);
}

const SORT_ACCESSORS: Record<SortColumn, (row: WalletLeaderboardRow) => number> = {
  pnl: (row) => row.pnlUsd,
  winRate: (row) => row.winRate,
  tradeCount: (row) => row.tradeCount,
  score: (row) => row.walletScore,
};

interface SortHeaderProps {
  label: string;
  column: SortColumn;
  activeColumn: SortColumn;
  direction: SortDirection;
  onSort: (column: SortColumn) => void;
}

function SortHeader({ label, column, activeColumn, direction, onSort }: SortHeaderProps) {
  const isActive = activeColumn === column;
  const Icon = isActive ? (direction === 'desc' ? ArrowDown : ArrowUp) : ChevronsUpDown;
  return (
    <TableHead className="text-right">
      <button
        type="button"
        onClick={() => onSort(column)}
        aria-sort={isActive ? (direction === 'desc' ? 'descending' : 'ascending') : 'none'}
        className={cn(
          'inline-flex items-center gap-1 font-medium hover:text-foreground',
          isActive ? 'text-foreground' : 'text-muted-foreground',
        )}
      >
        {label}
        <Icon className={cn('size-3.5', isActive ? 'opacity-100' : 'opacity-40')} />
      </button>
    </TableHead>
  );
}

function TokenPnlCell({ token }: { token: WalletTokenPnl | null }) {
  if (!token) return <span className="text-xs text-muted-foreground">—</span>;
  return (
    <Link href={`/tokens/${token.tokenId}`} className="inline-flex items-center gap-1.5 hover:underline">
      <span className="font-medium">{token.symbol}</span>
      <span className={cn('tabular-nums text-xs', pnlClass(token.deltaUsd))}>{fmtSignedUsd(token.deltaUsd)}</span>
    </Link>
  );
}

/**
 * Wallet Leaderboard table (Task 10). Client component so column headers can
 * be clicked to re-sort — sorting happens entirely over the already-fetched,
 * already-serialized `rows` array (binding decision #1: "no URL state, no
 * pagination"). The query (latest WalletStats per wallet, classifications,
 * best/worst-token deltas from WalletTokenTrade, profitable-threshold check
 * against Settings) lives in app/wallets/page.tsx; this component only sorts
 * and renders.
 */
export function LeaderboardTable({ rows }: LeaderboardTableProps) {
  const [sortColumn, setSortColumn] = useState<SortColumn>('pnl');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');

  function handleSort(column: SortColumn): void {
    if (column === sortColumn) {
      setSortDirection((d) => (d === 'desc' ? 'asc' : 'desc'));
    } else {
      setSortColumn(column);
      setSortDirection('desc');
    }
  }

  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No wallets tracked yet.</p>;
  }

  const accessor = SORT_ACCESSORS[sortColumn];
  const sorted = [...rows].sort((a, b) => {
    const diff = accessor(a) - accessor(b);
    return sortDirection === 'desc' ? -diff : diff;
  });

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Wallet</TableHead>
            <TableHead>Chain</TableHead>
            <SortHeader label="30d PnL" column="pnl" activeColumn={sortColumn} direction={sortDirection} onSort={handleSort} />
            <SortHeader
              label="Win rate"
              column="winRate"
              activeColumn={sortColumn}
              direction={sortDirection}
              onSort={handleSort}
            />
            <SortHeader
              label="Trades"
              column="tradeCount"
              activeColumn={sortColumn}
              direction={sortDirection}
              onSort={handleSort}
            />
            <TableHead className="text-right">Avg size</TableHead>
            <SortHeader label="Score" column="score" activeColumn={sortColumn} direction={sortDirection} onSort={handleSort} />
            <TableHead>Source</TableHead>
            <TableHead>Labels</TableHead>
            <TableHead>Best token</TableHead>
            <TableHead>Worst token</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.map((row) => {
            const visibleLabels = row.labels.slice(0, MAX_VISIBLE_LABELS);
            const hiddenLabelCount = row.labels.length - visibleLabels.length;
            return (
              <TableRow key={row.walletId}>
                {/* Profitable-threshold highlight (binding decision #2) lives on the
                    first cell, not the <tr>: shadcn's Table sets border-collapse:
                    collapse, under which a <tr>-level border-left resolves against
                    neighboring rows' shared edge and unreliably drops to 0px on
                    boundary rows (verified live: the table's last row lost its
                    border-left-width despite the class being present in the DOM).
                    A <td>-level border-left isn't subject to that row-boundary
                    collapse ambiguity and renders consistently on every row. */}
                <TableCell
                  className={cn(row.meetsProfitableThreshold && 'border-l-2 border-l-emerald-500/60')}
                >
                  <code className="text-xs text-muted-foreground">{shortAddr(row.address)}</code>
                </TableCell>
                <TableCell>
                  <Badge className={CHAIN_BADGE_CLASS[row.chain]}>{row.chain}</Badge>
                </TableCell>
                <TableCell className={cn('text-right tabular-nums', pnlClass(row.pnlUsd))}>
                  {fmtSignedUsd(row.pnlUsd)}
                </TableCell>
                <TableCell className="text-right tabular-nums">{fmtWinRate(row.winRate)}</TableCell>
                <TableCell className="text-right tabular-nums">{row.tradeCount}</TableCell>
                <TableCell className="text-right tabular-nums">{fmtUsd(row.avgTradeSizeUsd)}</TableCell>
                <TableCell className={cn('text-right font-bold tabular-nums', walletScoreClass(row.walletScore))}>
                  {row.walletScore.toFixed(0)}
                </TableCell>
                <TableCell>
                  <Badge className={SOURCE_BADGE_CLASS[row.source]}>{row.source}</Badge>
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    {visibleLabels.length === 0 ? (
                      <span className="text-xs text-muted-foreground">—</span>
                    ) : (
                      <>
                        {visibleLabels.map((label) => (
                          <Badge key={label} className={LABEL_BADGE_CLASS[label]}>
                            {label}
                          </Badge>
                        ))}
                        {hiddenLabelCount > 0 && (
                          <Badge className="border-transparent bg-zinc-800/50 text-zinc-500">+{hiddenLabelCount}</Badge>
                        )}
                      </>
                    )}
                  </div>
                </TableCell>
                <TableCell>
                  <TokenPnlCell token={row.bestToken} />
                </TableCell>
                <TableCell>
                  <TokenPnlCell token={row.worstToken} />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
