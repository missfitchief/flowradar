'use client';

import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { TooltipContentProps } from 'recharts';
import type { ValueType, NameType } from 'recharts/types/component/DefaultTooltipContent';
import { fmtUsd } from '@/lib/format';

/**
 * One point of the token's 72h hourly TokenMarketSnapshot series. `ts` is an
 * ISO string (not `Date`) and `priceUsd`/`marketCapUsd` are plain numbers
 * (not `Prisma.Decimal`) — this is a client component, so everything crossing
 * the server->client boundary must already be JSON-serializable per binding
 * decision #9 (Decimal->Number / Date->ISO string at the query boundary in
 * page.tsx, never here).
 */
export interface PricePoint {
  ts: string;
  priceUsd: number;
  marketCapUsd: number;
}

/** One buy or sell marker overlaid on the price line at (trade.ts, priceUsd at trade). */
export interface TradeMarker {
  ts: string;
  priceUsd: number;
  action: 'BUY' | 'SELL';
}

export interface PriceChartProps {
  series: PricePoint[];
  trades: TradeMarker[];
}

// Internal shape once ts strings are converted to epoch-ms numbers — the X
// axis must be numeric (not categorical) so a trade's Scatter point can be
// positioned at its *exact* timestamp instead of snapping to the nearest
// hourly snapshot tick.
interface NumericPricePoint {
  tsMs: number;
  priceUsd: number;
  marketCapUsd: number;
}
interface NumericTradePoint {
  tsMs: number;
  priceUsd: number;
}

const AXIS_TICK_STYLE = { fill: 'var(--muted-foreground)', fontSize: 11 };

function fmtTickTime(tsMs: number): string {
  return new Date(tsMs).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric' });
}

function fmtTooltipTime(tsMs: number): string {
  return new Date(tsMs).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** Custom tooltip: time / price / mcap for the hovered snapshot point. */
function ChartTooltip({ active, payload, label }: TooltipContentProps<ValueType, NameType>) {
  if (!active || !payload || payload.length === 0) return null;

  const point = payload.find(
    (p): p is typeof p & { payload: NumericPricePoint } =>
      p.payload != null && typeof (p.payload as NumericPricePoint).marketCapUsd === 'number',
  );
  if (!point) return null;

  const data = point.payload;

  return (
    <div className="rounded-md border border-border bg-popover px-3 py-2 text-xs shadow-md">
      <div className="text-muted-foreground">{fmtTooltipTime(Number(label))}</div>
      <div className="mt-1 font-medium text-foreground">Price {fmtUsd(data.priceUsd)}</div>
      <div className="text-muted-foreground">Mcap {fmtUsd(data.marketCapUsd)}</div>
    </div>
  );
}

/**
 * Price line (left axis) + market-cap area (right axis) from the token's 72h
 * hourly TokenMarketSnapshot series, with buy/sell trade markers overlaid via
 * Scatter (emerald = BUY, red = SELL), positioned at (trade.ts, priceUsd at
 * trade time) per binding decision #3. The shared X axis is numeric (epoch
 * ms), not categorical, so a trade landing between two hourly snapshot ticks
 * still plots at its real timestamp rather than snapping to the nearest one.
 * Colors are hand-picked (dark-friendly) rather than Recharts' default palette.
 */
export function PriceChart({ series, trades }: PriceChartProps) {
  if (series.length === 0) {
    return (
      <div className="flex h-72 items-center justify-center text-sm text-muted-foreground">
        No market snapshot history yet.
      </div>
    );
  }

  const numericSeries: NumericPricePoint[] = series.map((p) => ({
    tsMs: new Date(p.ts).getTime(),
    priceUsd: p.priceUsd,
    marketCapUsd: p.marketCapUsd,
  }));

  const toNumericTrade = (t: TradeMarker): NumericTradePoint => ({
    tsMs: new Date(t.ts).getTime(),
    priceUsd: t.priceUsd,
  });
  const buyPoints = trades.filter((t) => t.action === 'BUY').map(toNumericTrade);
  const sellPoints = trades.filter((t) => t.action === 'SELL').map(toNumericTrade);

  const domain: [number, number] = [numericSeries[0]!.tsMs, numericSeries[numericSeries.length - 1]!.tsMs];

  return (
    <ResponsiveContainer width="100%" height={320}>
      <ComposedChart data={numericSeries} margin={{ top: 8, right: 12, bottom: 8, left: 4 }}>
        <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
        <XAxis
          dataKey="tsMs"
          type="number"
          domain={domain}
          scale="time"
          tickFormatter={fmtTickTime}
          tick={AXIS_TICK_STYLE}
          stroke="var(--border)"
          minTickGap={40}
        />
        <YAxis
          yAxisId="price"
          tickFormatter={(v: number) => fmtUsd(v)}
          tick={AXIS_TICK_STYLE}
          stroke="var(--border)"
          width={70}
        />
        <YAxis
          yAxisId="mcap"
          orientation="right"
          tickFormatter={(v: number) => fmtUsd(v)}
          tick={AXIS_TICK_STYLE}
          stroke="var(--border)"
          width={70}
        />
        <Tooltip content={ChartTooltip} />
        <Legend wrapperStyle={{ fontSize: 12, color: 'var(--muted-foreground)' }} />

        <Area
          yAxisId="mcap"
          type="monotone"
          dataKey="marketCapUsd"
          name="Market cap"
          stroke="var(--chart-2)"
          fill="var(--chart-2)"
          fillOpacity={0.15}
          strokeWidth={1.5}
          isAnimationActive={false}
        />

        <Line
          yAxisId="price"
          type="monotone"
          dataKey="priceUsd"
          name="Price"
          stroke="var(--chart-1)"
          strokeWidth={2}
          dot={false}
          isAnimationActive={false}
        />

        <Scatter
          yAxisId="price"
          xAxisId={0}
          data={buyPoints}
          dataKey="priceUsd"
          name="Buys"
          fill="#34d399"
          shape="circle"
          isAnimationActive={false}
        />
        <Scatter
          yAxisId="price"
          xAxisId={0}
          data={sellPoints}
          dataKey="priceUsd"
          name="Sells"
          fill="#f87171"
          shape="circle"
          isAnimationActive={false}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
