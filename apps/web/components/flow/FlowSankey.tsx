'use client';

// FlowRadar — Money Flow Sankey (Task 24 binding decision 5 / Spec §8.4).
//
// Built server-side (page.tsx) from the $ALPHA -> $BETA rotation chain:
//   Token ALPHA -> source wallet -> Bridge (Wormhole) -> dest wallet -> Token BETA
// weighted by USD value at each hop (sell proceeds -> bridge deposit ->
// bridge withdrawal -> dest buy). Recharts' Sankey (v3) needs `data.nodes`
// (each just `{ name }`, though extra fields like `category` pass through to
// the payload for custom coloring) and `data.links` with NUMERIC
// `source`/`target` indices into that node array — not names — so the
// server assembles plain name/value info and this component does the
// name -> index mapping right before rendering.

import { ResponsiveContainer, Sankey, Tooltip } from 'recharts';
import type { TooltipContentProps } from 'recharts';
import type { ValueType, NameType } from 'recharts/types/component/DefaultTooltipContent';
import { fmtUsd } from '@/lib/format';

export type FlowSankeyNodeCategory = 'token' | 'wallet' | 'bridge';

export interface FlowSankeyNode {
  name: string;
  category: FlowSankeyNodeCategory;
}

export interface FlowSankeyLink {
  source: string;
  target: string;
  value: number;
}

export interface FlowSankeyProps {
  nodes: FlowSankeyNode[];
  links: FlowSankeyLink[];
}

const CATEGORY_COLOR: Record<FlowSankeyNodeCategory, string> = {
  token: '#818cf8', // indigo-400
  wallet: '#34d399', // emerald-400
  bridge: '#fbbf24', // amber-400
};

interface NodePayload {
  name: string;
  category?: FlowSankeyNodeCategory;
}

function SankeyTooltip({ active, payload }: TooltipContentProps<ValueType, NameType>) {
  if (!active || !payload || payload.length === 0) return null;
  const entry = payload[0];
  if (!entry) return null;

  const linkPayload = entry.payload as { source?: NodePayload; target?: NodePayload; value?: number } | undefined;
  if (linkPayload?.source && linkPayload?.target) {
    return (
      <div className="rounded-md border border-border bg-popover px-3 py-2 text-xs shadow-md">
        <div className="text-foreground">
          {linkPayload.source.name} → {linkPayload.target.name}
        </div>
        <div className="mt-1 text-muted-foreground">{fmtUsd(Number(linkPayload.value ?? 0))}</div>
      </div>
    );
  }

  const nodePayload = entry.payload as NodePayload | undefined;
  if (nodePayload?.name) {
    return (
      <div className="rounded-md border border-border bg-popover px-3 py-2 text-xs shadow-md">
        <div className="text-foreground">{nodePayload.name}</div>
      </div>
    );
  }

  return null;
}

/**
 * Custom node renderer — colors each node rectangle by category
 * (token/wallet/bridge) rather than Recharts' default palette, and prints the
 * node name as a label (dark-friendly: light text on the dark card background).
 */
function CustomNode(props: {
  x: number;
  y: number;
  width: number;
  height: number;
  index: number;
  payload: NodePayload;
}) {
  const { x, y, width, height, payload } = props;
  const color = CATEGORY_COLOR[payload.category ?? 'wallet'];
  const isOutLabel = x < 120; // left-edge nodes: label to the right; else label to the left

  return (
    <g>
      <rect x={x} y={y} width={width} height={Math.max(height, 1)} fill={color} fillOpacity={0.85} rx={2} />
      <text
        x={isOutLabel ? x + width + 8 : x - 8}
        y={y + height / 2}
        textAnchor={isOutLabel ? 'start' : 'end'}
        dominantBaseline="middle"
        fontSize={12}
        fill="var(--foreground)"
      >
        {payload.name}
      </text>
    </g>
  );
}

/**
 * Real Recharts Sankey diagram (not a simplified layered node-link fallback —
 * the v3 API turned out to accept the plain-name-node / value-link shape
 * cleanly once names are mapped to indices below). Guard: if there are no
 * links (no rotation/bridge data assembled), render the documented empty
 * state instead of an empty Sankey canvas.
 */
export function FlowSankey({ nodes, links }: FlowSankeyProps) {
  if (nodes.length === 0 || links.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
        No cross-token capital rotations detected yet.
      </div>
    );
  }

  const indexByName = new Map(nodes.map((n, i) => [n.name, i]));
  const data = {
    nodes: nodes.map((n) => ({ name: n.name, category: n.category })),
    links: links
      .map((l) => ({
        source: indexByName.get(l.source),
        target: indexByName.get(l.target),
        value: l.value,
      }))
      .filter((l): l is { source: number; target: number; value: number } => l.source !== undefined && l.target !== undefined),
  };

  return (
    <ResponsiveContainer width="100%" height={320}>
      <Sankey
        data={data}
        nodePadding={24}
        nodeWidth={12}
        linkCurvature={0.5}
        node={CustomNode}
        link={{ stroke: 'var(--muted-foreground)', strokeOpacity: 0.25 }}
        margin={{ top: 16, right: 120, bottom: 16, left: 120 }}
      >
        <Tooltip content={SankeyTooltip} />
      </Sankey>
    </ResponsiveContainer>
  );
}
