import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { fmtUsd, shortAddr } from '@/lib/format';

// WalletClassification.label — 11 values (@flowradar/db's WalletLabel enum),
// spelled out as a literal union rather than importing the Prisma enum so
// this component stays a plain presentational leaf with no Prisma coupling
// (same pattern as HotTokensTable's HotTokenChain/HotTokenSignalStatus).
export type BuyerWalletLabel =
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

/** Net position derived from this token's buyUsd/sellUsd for a wallet (binding decision #6). */
export type NetPosition = 'holding' | 'partial_exit' | 'exited';

/**
 * One distinct buyer wallet row. Plain, JSON-serializable data only (numbers,
 * strings) — no Prisma.Decimal, no Date needed here.
 */
export interface BuyerWalletRow {
  walletId: string;
  address: string;
  labels: BuyerWalletLabel[];
  /** Latest WalletStats.walletScore for this wallet, or null if the wallet has no WalletStats row. */
  walletScore: number | null;
  buyUsd: number;
  sellUsd: number;
}

export interface WalletBuyersTableProps {
  rows: BuyerWalletRow[];
}

const LABEL_BADGE_CLASS: Record<BuyerWalletLabel, string> = {
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

const NET_POSITION_LABEL: Record<NetPosition, string> = {
  holding: 'Holding',
  partial_exit: 'Partial exit',
  exited: 'Exited',
};

const NET_POSITION_BADGE_CLASS: Record<NetPosition, string> = {
  holding: 'border-transparent bg-emerald-500/15 text-emerald-400',
  partial_exit: 'border-transparent bg-amber-500/15 text-amber-400',
  exited: 'border-transparent bg-red-500/15 text-red-400',
};

/**
 * Net position from this token's buy/sell totals (binding decision #6):
 * holding = sells < 20% of buys, partial_exit = 20-79%, exited = >= 80%.
 * A wallet with zero buys (shouldn't occur — every row here comes from a
 * distinct BUY-side wallet — but guarded defensively) is treated as holding.
 */
export function netPositionFor(buyUsd: number, sellUsd: number): NetPosition {
  if (buyUsd <= 0) return 'holding';
  const exitRatio = sellUsd / buyUsd;
  if (exitRatio >= 0.8) return 'exited';
  if (exitRatio >= 0.2) return 'partial_exit';
  return 'holding';
}

function fmtWalletScore(score: number | null): string {
  return score === null ? '—' : score.toFixed(0);
}

/**
 * Distinct buyer wallets for this token, sorted by buyUsd desc (binding
 * decision #6). Presentational only — the query (distinct wallets, their
 * classifications, latest WalletStats, per-token buy/sell totals) lives in
 * app/tokens/[id]/page.tsx.
 */
export function WalletBuyersTable({ rows }: WalletBuyersTableProps) {
  const sorted = [...rows].sort((a, b) => b.buyUsd - a.buyUsd);

  if (sorted.length === 0) {
    return <p className="text-sm text-muted-foreground">No buyer wallets recorded for this token yet.</p>;
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Wallet</TableHead>
            <TableHead>Labels</TableHead>
            <TableHead className="text-right">Score</TableHead>
            <TableHead className="text-right">Buy USD</TableHead>
            <TableHead className="text-right">Sell USD</TableHead>
            <TableHead>Position</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.map((row) => {
            const position = netPositionFor(row.buyUsd, row.sellUsd);
            return (
              <TableRow key={row.walletId}>
                <TableCell>
                  <code className="text-xs text-muted-foreground">{shortAddr(row.address)}</code>
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    {row.labels.length === 0 ? (
                      <span className="text-xs text-muted-foreground">—</span>
                    ) : (
                      row.labels.map((label) => (
                        <Badge key={label} className={LABEL_BADGE_CLASS[label]}>
                          {label}
                        </Badge>
                      ))
                    )}
                  </div>
                </TableCell>
                <TableCell className="text-right tabular-nums">{fmtWalletScore(row.walletScore)}</TableCell>
                <TableCell className="text-right tabular-nums text-emerald-400">{fmtUsd(row.buyUsd)}</TableCell>
                <TableCell
                  className={cn('text-right tabular-nums', row.sellUsd > 0 ? 'text-red-400' : 'text-muted-foreground')}
                >
                  {fmtUsd(row.sellUsd)}
                </TableCell>
                <TableCell>
                  <Badge className={NET_POSITION_BADGE_CLASS[position]}>{NET_POSITION_LABEL[position]}</Badge>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
