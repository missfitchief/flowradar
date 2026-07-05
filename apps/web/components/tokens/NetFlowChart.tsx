'use client';

import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { TooltipContentProps } from 'recharts';
import type { ValueType, NameType } from 'recharts/types/component/DefaultTooltipContent';
import { fmtUsd } from '@/lib/format';

/** One TokenFlowSnapshot's netFlowUsd at its ts, for this token. */
export interface NetFlowPoint {
  ts: string;
  netFlowUsd: number;
}

export interface NetFlowChartProps {
  points: NetFlowPoint[];
}

const AXIS_TICK_STYLE = { fill: 'var(--muted-foreground)', fontSize: 11 };

function fmtTickTime(ts: string): string {
  return new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric' });
}

function ChartTooltip({ active, payload, label }: TooltipContentProps<ValueType, NameType>) {
  if (!active || !payload || payload.length === 0) return null;
  const value = Number(payload[0]!.value);

  return (
    <div className="rounded-md border border-border bg-popover px-3 py-2 text-xs shadow-md">
      <div className="text-muted-foreground">{fmtTickTime(String(label))}</div>
      <div className={`mt-1 font-medium ${value >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
        {value >= 0 ? '+' : ''}
        {fmtUsd(value)}
      </div>
    </div>
  );
}

/** Bar chart of TokenFlowSnapshot.netFlowUsd history for this token — green bars for net-positive, red for net-negative. */
export function NetFlowChart({ points }: NetFlowChartProps) {
  if (points.length === 0) {
    return (
      <div className="flex h-56 items-center justify-center text-sm text-muted-foreground">
        No flow snapshot history yet.
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={240}>
      <BarChart data={points} margin={{ top: 8, right: 12, bottom: 8, left: 4 }}>
        <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
        <XAxis
          dataKey="ts"
          tickFormatter={fmtTickTime}
          tick={AXIS_TICK_STYLE}
          stroke="var(--border)"
          minTickGap={40}
        />
        <YAxis tickFormatter={(v: number) => fmtUsd(v)} tick={AXIS_TICK_STYLE} stroke="var(--border)" width={70} />
        <Tooltip content={ChartTooltip} cursor={{ fill: 'var(--muted)', opacity: 0.3 }} />
        <Bar dataKey="netFlowUsd" isAnimationActive={false}>
          {points.map((p, i) => (
            <Cell key={i} fill={p.netFlowUsd >= 0 ? '#34d399' : '#f87171'} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
