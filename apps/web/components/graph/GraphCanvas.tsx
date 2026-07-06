'use client';

// FlowRadar — Wallet Graph Finder cytoscape canvas (Task 21 binding decisions
// 1 + 4 + 9).
//
// cytoscape is imported dynamically INSIDE useEffect (never at module top
// level) because the package touches `window` at import time and this
// component may be rendered during SSR — a top-level `import cytoscape from
// 'cytoscape'` would crash the Next.js server render. No react-cytoscape
// wrapper — cytoscape is driven directly against a ref'd container div.
//
// Layout: built-in 'concentric' (no layout-extension dependency), keyed on
// depth via `concentric: (node) => maxDepth - node.depth` so the root (depth
// 0) lands in the center ring and each successive depth ring sits further
// out. Deterministic: nodes are added in a fixed order (sorted by depth then
// address) before running the layout, so concentric's tie-breaking is stable
// across runs of the same search.
//
// For verification: the cytoscape instance is stashed on
// `window.__flowradarCy` (see binding decision 9 — hidden preview tabs can
// prevent cytoscape from sizing/painting pixels, so tests read node/edge
// counts off the live instance instead of screenshotting).

import { useEffect, useRef, useState } from 'react';
import type { Core, ElementDefinition, NodeSingular, EdgeSingular } from 'cytoscape';
import { fmtUsd, shortAddr } from '@/lib/format';

export type GraphNodeType =
  | 'WALLET'
  | 'BRIDGE'
  | 'CEX'
  | 'ROUTER'
  | 'POOL'
  | 'TOKEN_CONTRACT'
  | 'CONTRACT'
  | 'UNKNOWN';

/** Plain, JSON-serializable node shape — no Prisma.Decimal, no Date (binding decision 9). */
export interface GraphCanvasNode {
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

export interface GraphCanvasEdge {
  sourceAddress: string;
  destAddress: string;
  relationship: string;
  totalUsd: number;
  txCount: number;
}

export interface GraphCanvasProps {
  nodes: GraphCanvasNode[];
  edges: GraphCanvasEdge[];
  rootAddress: string;
  explorerAddressUrlTemplate?: string | null;
}

const NODE_TYPE_COLOR: Record<GraphNodeType, string> = {
  WALLET: '#94a3b8', // slate
  CEX: '#f59e0b', // amber
  BRIDGE: '#8b5cf6', // violet
  ROUTER: '#0ea5e9', // sky
  POOL: '#14b8a6', // teal
  TOKEN_CONTRACT: '#71717a', // zinc
  CONTRACT: '#71717a', // zinc
  UNKNOWN: '#6b7280', // gray
};

// Canonical confidence bands live in @flowradar/core (0–30 weak, 31–60
// possible, 61–80 probable, 81–100 strong). Import + re-export the single
// source of truth so /graph's ConnectedWallets/Paths tables band a value
// identically to /flow's Clusters/Bridges/Rotations tables — a locally-forked
// copy here previously diverged at every boundary (whole-branch review
// finding). Imported (not a bare re-export) because this module also calls it
// directly in the node-detail panel below.
import { confidenceBand } from '@flowradar/core';
export { confidenceBand };

/** sqrt-scaled node diameter from total flow (sent + received), clamped 16-60px. */
function nodeSizeFor(totalFlowUsd: number, maxFlowUsd: number): number {
  if (maxFlowUsd <= 0) return 16;
  const ratio = Math.sqrt(Math.max(0, totalFlowUsd) / maxFlowUsd);
  return Math.max(16, Math.min(60, 16 + ratio * 44));
}

/** log10(USD)-scaled edge width, clamped 1-8px. */
function edgeWidthFor(totalUsd: number): number {
  if (totalUsd <= 0) return 1;
  const w = Math.log10(totalUsd);
  return Math.max(1, Math.min(8, w));
}

function fillUrlTemplate(template: string, address: string): string {
  return template.replaceAll('{address}', address);
}

interface SelectedNodeDetail {
  address: string;
  nodeType: GraphNodeType;
  depth: number;
  totalSentUsd: number;
  totalReceivedUsd: number;
  netFlowUsd: number;
  interactionCount: number;
  confidence: number;
  tags: string[];
}

const LEGEND_ORDER: GraphNodeType[] = ['WALLET', 'CEX', 'BRIDGE', 'ROUTER', 'POOL', 'TOKEN_CONTRACT', 'UNKNOWN'];
const LEGEND_LABEL: Record<GraphNodeType, string> = {
  WALLET: 'Wallet',
  CEX: 'CEX',
  BRIDGE: 'Bridge',
  ROUTER: 'Router',
  POOL: 'Pool',
  TOKEN_CONTRACT: 'Token/contract',
  CONTRACT: 'Token/contract',
  UNKNOWN: 'Unknown',
};

export function GraphCanvas({ nodes, edges, rootAddress, explorerAddressUrlTemplate }: GraphCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const [selected, setSelected] = useState<SelectedNodeDetail | null>(null);

  useEffect(() => {
    if (!containerRef.current || nodes.length === 0) return;

    let disposed = false;

    void import('cytoscape').then(({ default: cytoscape }) => {
      if (disposed || !containerRef.current) return;

      const maxDepth = nodes.reduce((max, n) => Math.max(max, n.depth), 0);
      const maxFlowUsd = nodes.reduce((max, n) => Math.max(max, n.totalSentUsd + n.totalReceivedUsd), 0);

      // Deterministic ordering: sort by depth then address before building
      // elements, so concentric's placement is stable run-to-run.
      const sortedNodes = [...nodes].sort((a, b) => a.depth - b.depth || a.address.localeCompare(b.address));

      const elements: ElementDefinition[] = [];
      for (const n of sortedNodes) {
        const size = nodeSizeFor(n.totalSentUsd + n.totalReceivedUsd, maxFlowUsd);
        elements.push({
          data: {
            id: n.address,
            label: shortAddr(n.address),
            depth: n.depth,
            nodeType: n.nodeType,
            size,
            color: NODE_TYPE_COLOR[n.nodeType] ?? NODE_TYPE_COLOR.UNKNOWN,
            isRoot: n.address === rootAddress,
            totalSentUsd: n.totalSentUsd,
            totalReceivedUsd: n.totalReceivedUsd,
            netFlowUsd: n.netFlowUsd,
            interactionCount: n.interactionCount,
            confidence: n.confidence,
            tags: n.tags,
          },
        });
      }

      const nodeAddressSet = new Set(sortedNodes.map((n) => n.address));
      const sortedEdges = [...edges].sort(
        (a, b) => a.sourceAddress.localeCompare(b.sourceAddress) || a.destAddress.localeCompare(b.destAddress),
      );
      for (const e of sortedEdges) {
        // Guard against an edge referencing a node outside this result set
        // (shouldn't happen given how the API persists them, but a
        // dangling reference would otherwise throw at cytoscape init).
        if (!nodeAddressSet.has(e.sourceAddress) || !nodeAddressSet.has(e.destAddress)) continue;
        elements.push({
          data: {
            id: `${e.sourceAddress}->${e.destAddress}->${e.relationship}`,
            source: e.sourceAddress,
            target: e.destAddress,
            width: edgeWidthFor(e.totalUsd),
            totalUsd: e.totalUsd,
            relationship: e.relationship,
            txCount: e.txCount,
          },
        });
      }

      const cy = cytoscape({
        container: containerRef.current,
        elements,
        style: [
          {
            selector: 'node',
            style: {
              'background-color': 'data(color)',
              width: 'data(size)',
              height: 'data(size)',
              label: 'data(label)',
              'font-size': 9,
              // cytoscape's style engine doesn't parse CSS var()/fallback
              // syntax (it warned "invalid" on `var(--foreground, ...)`) —
              // a plain hex matching this app's dark-theme foreground color
              // is used instead.
              color: '#e4e4e7',
              'text-valign': 'bottom',
              'text-margin-y': 4,
              'text-outline-width': 0,
            },
          },
          {
            selector: 'node[?isRoot]',
            style: {
              'border-width': 3,
              'border-color': '#ffffff',
              'border-opacity': 0.9,
            },
          },
          {
            selector: 'edge',
            style: {
              width: 'data(width)',
              'line-color': '#52525b',
              'line-opacity': 0.55,
              'target-arrow-color': '#52525b',
              'target-arrow-shape': 'triangle',
              'arrow-scale': 0.8,
              'curve-style': 'bezier',
            },
          },
          {
            selector: 'node:selected',
            style: {
              'border-width': 3,
              'border-color': '#38bdf8',
            },
          },
        ],
        // No constructor-time `layout` — the custom concentric layout below is
        // run explicitly right after construction (with the depth-keyed
        // `concentric` accessor + spacing), so a constructor-time layout pass
        // would only be immediately discarded. cytoscape leaves nodes
        // unpositioned until the first .layout().run(), which is fine here.
        wheelSensitivity: 0.2,
      });

      cy.layout({
        name: 'concentric',
        concentric: (n: NodeSingular) => maxDepth - (n.data('depth') as number),
        levelWidth: () => 1,
        minNodeSpacing: 30,
        animate: false,
      }).run();

      cy.fit(undefined, 24);

      cy.on('tap', 'node', (evt) => {
        const n = evt.target as NodeSingular;
        setSelected({
          address: n.id(),
          nodeType: n.data('nodeType') as GraphNodeType,
          depth: n.data('depth') as number,
          totalSentUsd: n.data('totalSentUsd') as number,
          totalReceivedUsd: n.data('totalReceivedUsd') as number,
          netFlowUsd: n.data('netFlowUsd') as number,
          interactionCount: n.data('interactionCount') as number,
          confidence: n.data('confidence') as number,
          tags: (n.data('tags') as string[]) ?? [],
        });
      });

      cy.on('mouseover', 'edge', (evt) => {
        const e = evt.target as EdgeSingular;
        e.style('line-opacity', 1);
      });
      cy.on('mouseout', 'edge', (evt) => {
        const e = evt.target as EdgeSingular;
        e.style('line-opacity', 0.55);
      });

      cyRef.current = cy;
      // Verification hook (binding decision 9): a hidden preview tab may
      // prevent cytoscape from sizing/painting real pixels, so tests read
      // node/edge counts off this global instead of a screenshot.
      (window as unknown as { __flowradarCy?: Core }).__flowradarCy = cy;
    });

    return () => {
      disposed = true;
      if (cyRef.current) {
        cyRef.current.destroy();
        cyRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges, rootAddress]);

  if (nodes.length === 0) {
    return (
      <div className="flex h-[560px] items-center justify-center rounded-lg border border-border text-sm text-muted-foreground">
        Run a search to see the wallet graph.
      </div>
    );
  }

  const explorerUrl =
    selected && explorerAddressUrlTemplate ? fillUrlTemplate(explorerAddressUrlTemplate, selected.address) : null;

  return (
    <div className="flex flex-col gap-3 lg:flex-row">
      <div ref={containerRef} className="h-[560px] flex-1 rounded-lg border border-border bg-card/40" />

      <div className="flex w-full flex-col gap-4 lg:w-72">
        {/* Legend */}
        <div className="rounded-lg border border-border p-3">
          <div className="mb-2 text-xs font-medium text-muted-foreground">Legend</div>
          <div className="flex flex-col gap-1.5">
            {LEGEND_ORDER.map((type) => (
              <div key={type} className="flex items-center gap-2 text-xs">
                <span
                  className="inline-block size-2.5 rounded-full"
                  style={{ backgroundColor: NODE_TYPE_COLOR[type] }}
                />
                {LEGEND_LABEL[type]}
              </div>
            ))}
          </div>
        </div>

        {/* Node detail panel */}
        <div className="rounded-lg border border-border p-3">
          <div className="mb-2 text-xs font-medium text-muted-foreground">Node detail</div>
          {!selected ? (
            <p className="text-xs text-muted-foreground">Click a node to see its detail.</p>
          ) : (
            <div className="flex flex-col gap-1.5 text-xs">
              <div className="font-mono text-[11px] break-all">{selected.address}</div>
              <div className="flex items-center gap-1.5">
                <span
                  className="inline-block size-2 rounded-full"
                  style={{ backgroundColor: NODE_TYPE_COLOR[selected.nodeType] }}
                />
                {selected.nodeType}
                <span className="text-muted-foreground">· depth {selected.depth}</span>
              </div>
              <div className="mt-1 grid grid-cols-2 gap-x-2 gap-y-1">
                <span className="text-muted-foreground">Sent</span>
                <span className="text-right tabular-nums">{fmtUsd(selected.totalSentUsd)}</span>
                <span className="text-muted-foreground">Received</span>
                <span className="text-right tabular-nums">{fmtUsd(selected.totalReceivedUsd)}</span>
                <span className="text-muted-foreground">Net flow</span>
                <span
                  className={
                    'text-right tabular-nums ' +
                    (selected.netFlowUsd > 0 ? 'text-emerald-400' : selected.netFlowUsd < 0 ? 'text-red-400' : '')
                  }
                >
                  {fmtUsd(selected.netFlowUsd)}
                </span>
                <span className="text-muted-foreground">Interactions</span>
                <span className="text-right tabular-nums">{selected.interactionCount}</span>
                <span className="text-muted-foreground">Confidence</span>
                <span className="text-right tabular-nums">
                  {selected.confidence.toFixed(0)} ({confidenceBand(selected.confidence)})
                </span>
              </div>
              {selected.tags.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {selected.tags.map((tag) => (
                    <span key={tag} className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      {tag}
                    </span>
                  ))}
                </div>
              )}
              {explorerUrl && (
                <a
                  href={explorerUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-1 text-muted-foreground underline-offset-4 hover:underline"
                >
                  View on explorer
                </a>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
