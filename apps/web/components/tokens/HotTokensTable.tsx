import Link from 'next/link';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { fmtAge, fmtUsd } from '@/lib/format';

// Chain values are a fixed 2-member enum (@flowradar/db's ChainId) — spelled
// out here as a literal union instead of importing the Prisma enum type so
// this component stays a plain presentational leaf with no Prisma coupling.
export type HotTokenChain = 'SOLANA' | 'BSC';

// FlowSignalStatus's 5 values (@flowradar/db), same reasoning as above.
export type HotTokenSignalStatus = 'watching' | 'hot' | 'profit_rotation' | 'exit_warning' | 'dead';

/**
 * One row of the Overview hot-tokens table. Plain, JSON-serializable data
 * only (numbers, strings, Date) — no Prisma.Decimal — so this component has
 * no dependency on the DB layer and stays trivially reusable/testable.
 */
export interface HotTokenRow {
  id: string;
  symbol: string;
  name: string;
  chain: HotTokenChain;
  firstSeenAt: Date;
  flowScore: number;
  smartWalletCount: number;
  uniqueEntityCount: number;
  netFlowUsd: number;
  humanLikeCount: number;
  possibleBotCount: number;
  signalStatus: HotTokenSignalStatus;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  vol5m: number | null;
  vol1h: number | null;
  vol24h: number | null;
  /** Last Alert.sentAt for this token, if any have fired yet. Alerts arrive Wave 2 — always null for now. */
  lastAlertAt: Date | null;
}

const CHAIN_BADGE_CLASS: Record<HotTokenChain, string> = {
  SOLANA: 'border-transparent bg-violet-500/15 text-violet-300',
  BSC: 'border-transparent bg-amber-500/15 text-amber-300',
};

const SIGNAL_BADGE_CLASS: Record<HotTokenSignalStatus, string> = {
  watching: 'border-transparent bg-zinc-500/15 text-zinc-300',
  hot: 'border-transparent bg-orange-500/15 text-orange-300',
  profit_rotation: 'border-transparent bg-violet-500/15 text-violet-300',
  exit_warning: 'border-transparent bg-red-500/15 text-red-400',
  dead: 'border-transparent bg-zinc-800/50 text-zinc-500',
};

/** FlowScore color ramp (binding decision #3): >=70 emerald, 40-69 amber, <40 zinc. */
function flowScoreClass(score: number): string {
  if (score >= 70) return 'text-emerald-400';
  if (score >= 40) return 'text-amber-400';
  return 'text-zinc-400';
}

function fmtUsdOrDash(n: number | null): string {
  return n === null ? '—' : fmtUsd(n);
}

/** Renders "raw (entities)" when the two counts differ, plain number when equal. */
function fmtWalletVsEntity(raw: number, entities: number): string {
  return raw === entities ? `${raw}` : `${raw} (${entities})`;
}

function fmtHumanLikePct(humanLikeCount: number, smartWalletCount: number): string {
  const denom = Math.max(smartWalletCount, 1);
  return `${((humanLikeCount / denom) * 100).toFixed(0)}%`;
}

export interface HotTokensTableProps {
  rows: HotTokenRow[];
}

/** Presentational — Overview page's data query lives in app/page.tsx; this component only renders already-shaped rows. */
export function HotTokensTable({ rows }: HotTokensTableProps) {
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>FlowScore</TableHead>
            <TableHead>Chain</TableHead>
            <TableHead>Symbol</TableHead>
            <TableHead className="text-right">Market Cap</TableHead>
            <TableHead className="text-right">Liquidity</TableHead>
            <TableHead className="text-right">Vol 5m</TableHead>
            <TableHead className="text-right">Vol 1h</TableHead>
            <TableHead className="text-right">Vol 24h</TableHead>
            <TableHead className="text-right">Smart Wallets</TableHead>
            <TableHead className="text-right">Unique Entities</TableHead>
            <TableHead className="text-right">Net Smart Flow</TableHead>
            <TableHead className="text-right">Human-like %</TableHead>
            <TableHead>Age</TableHead>
            <TableHead>Signal Status</TableHead>
            <TableHead>Last Alert</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell className={cn('font-semibold tabular-nums', flowScoreClass(row.flowScore))}>
                {row.flowScore.toFixed(1)}
              </TableCell>
              <TableCell>
                <Badge className={CHAIN_BADGE_CLASS[row.chain]}>{row.chain}</Badge>
              </TableCell>
              <TableCell className="font-medium">
                <Link href={`/tokens/${row.id}`} className="hover:underline">
                  {row.symbol}
                </Link>
              </TableCell>
              <TableCell className="text-right tabular-nums">{fmtUsdOrDash(row.marketCapUsd)}</TableCell>
              <TableCell className="text-right tabular-nums">{fmtUsdOrDash(row.liquidityUsd)}</TableCell>
              <TableCell className="text-right tabular-nums">{fmtUsdOrDash(row.vol5m)}</TableCell>
              <TableCell className="text-right tabular-nums">{fmtUsdOrDash(row.vol1h)}</TableCell>
              <TableCell className="text-right tabular-nums">{fmtUsdOrDash(row.vol24h)}</TableCell>
              <TableCell className="text-right tabular-nums">{row.smartWalletCount}</TableCell>
              <TableCell className="text-right tabular-nums">
                {fmtWalletVsEntity(row.smartWalletCount, row.uniqueEntityCount)}
              </TableCell>
              <TableCell
                className={cn(
                  'text-right tabular-nums',
                  row.netFlowUsd >= 0 ? 'text-emerald-400' : 'text-red-400',
                )}
              >
                {row.netFlowUsd >= 0 ? '+' : ''}
                {fmtUsd(row.netFlowUsd)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {fmtHumanLikePct(row.humanLikeCount, row.smartWalletCount)}
              </TableCell>
              <TableCell className="text-muted-foreground">{fmtAge(row.firstSeenAt)}</TableCell>
              <TableCell>
                <Badge className={SIGNAL_BADGE_CLASS[row.signalStatus]}>{row.signalStatus}</Badge>
              </TableCell>
              <TableCell className="text-muted-foreground">
                {row.lastAlertAt ? fmtAge(row.lastAlertAt) : '—'}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
