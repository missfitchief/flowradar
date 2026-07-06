import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { fmtAge, fmtUsd, shortAddr } from '@/lib/format';

/**
 * One BUY/SELL trade row for the timeline. Plain, JSON-serializable data only
 * (numbers, strings, Date) per binding decision #1 — no Prisma.Decimal.
 */
export interface TimelineTrade {
  id: string;
  ts: Date;
  action: 'BUY' | 'SELL';
  walletAddress: string;
  amountUsd: number;
  priceUsd: number;
  marketCapAtTrade: number;
}

export interface TradesTimelineProps {
  trades: TimelineTrade[];
}

const ACTION_BADGE_CLASS: Record<'BUY' | 'SELL', string> = {
  BUY: 'border-transparent bg-emerald-500/15 text-emerald-400',
  SELL: 'border-transparent bg-red-500/15 text-red-400',
};

const TIMELINE_CAP = 50;

/**
 * Chronological list of BUY/SELL trades, latest first, capped at 50 rows
 * (binding decision #5). Wallet address renders as plain shortened code text
 * — no link target exists yet (wallet detail pages arrive in a later task).
 */
export function TradesTimeline({ trades }: TradesTimelineProps) {
  const rows = [...trades].sort((a, b) => b.ts.getTime() - a.ts.getTime()).slice(0, TIMELINE_CAP);

  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No trades recorded for this token yet.</p>;
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Time</TableHead>
            <TableHead>Action</TableHead>
            <TableHead>Wallet</TableHead>
            <TableHead className="text-right">Amount</TableHead>
            <TableHead className="text-right">Price</TableHead>
            <TableHead className="text-right">Mcap at trade</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell className="text-muted-foreground">{fmtAge(row.ts)} ago</TableCell>
              <TableCell>
                <Badge className={ACTION_BADGE_CLASS[row.action]}>{row.action}</Badge>
              </TableCell>
              <TableCell>
                <code className="text-xs text-muted-foreground">{shortAddr(row.walletAddress)}</code>
              </TableCell>
              <TableCell
                className={cn(
                  'text-right tabular-nums',
                  row.action === 'BUY' ? 'text-emerald-400' : 'text-red-400',
                )}
              >
                {fmtUsd(row.amountUsd)}
              </TableCell>
              <TableCell className="text-right tabular-nums">{fmtUsd(row.priceUsd)}</TableCell>
              <TableCell className="text-right tabular-nums">{fmtUsd(row.marketCapAtTrade)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
