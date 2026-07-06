// FlowRadar — transaction-path extraction over an already-built wallet graph
// (Task 19). PURE: consumes the GraphNode[]/GraphEdge[] produced by runBfs
// (or any equivalent shape) plus the root address; no I/O, no settings.
//
// DFS from the root along DIRECTED, transfer-ish value edges only (the same
// relationship-ish notion as CAPITAL_FLOW mode: direct_transfer,
// native_transfer, token_transfer, stablecoin_transfer, bridge_deposit,
// bridge_withdrawal — swap/router/cex/lp/contract edges never appear inside
// an extracted path). No node is revisited within a single path. Depth is
// capped at 4 hops. A path is dropped entirely if value ever moves backwards
// in time (lastTs of a later hop before an earlier hop's ts) — value must
// move forward in time to count as a real transaction path.

import type { WalletGraphRelationship } from '../types';
import type { GraphEdge, GraphNode, TransactionPath } from './types';

const PATH_RELATIONSHIPS: ReadonlySet<WalletGraphRelationship> = new Set([
  'direct_transfer',
  'native_transfer',
  'token_transfer',
  'stablecoin_transfer',
  'bridge_deposit',
  'bridge_withdrawal'
]);

const MAX_HOPS = 4;
const DEFAULT_MAX_PATHS = 20;
const DEFAULT_MIN_HOPS = 2;

export function extractPaths(
  nodes: GraphNode[],
  edges: GraphEdge[],
  rootAddress: string,
  opts?: { maxPaths?: number; minHops?: number }
): TransactionPath[] {
  const maxPaths = opts?.maxPaths ?? DEFAULT_MAX_PATHS;
  const minHops = opts?.minHops ?? DEFAULT_MIN_HOPS;

  const confidenceByAddress = new Map(nodes.map((n) => [n.address, n.confidence]));

  const outgoing = new Map<string, GraphEdge[]>();
  for (const e of edges) {
    if (!PATH_RELATIONSHIPS.has(e.relationship)) continue;
    const list = outgoing.get(e.source) ?? [];
    list.push(e);
    outgoing.set(e.source, list);
  }
  // deterministic exploration order: largest amountUsd first, then txCount
  for (const list of outgoing.values()) {
    list.sort((a, b) => b.amountUsd - a.amountUsd || b.txCount - a.txCount);
  }

  const results: TransactionPath[] = [];

  function dfs(
    current: string,
    visited: Set<string>,
    addresses: string[],
    hops: { source: string; dest: string; amountUsd: number; ts: Date }[]
  ): void {
    if (hops.length >= 1) {
      emitPath(addresses, hops);
    }
    if (hops.length >= MAX_HOPS) return;

    const children = outgoing.get(current) ?? [];
    for (const edge of children) {
      if (visited.has(edge.dest)) continue;

      // value must move forward in time: reject if this hop's timestamp is
      // before the previous hop's timestamp.
      if (hops.length > 0) {
        const prevTs = hops[hops.length - 1].ts;
        if (edge.lastTs.getTime() < prevTs.getTime()) continue;
      }

      visited.add(edge.dest);
      addresses.push(edge.dest);
      hops.push({ source: edge.source, dest: edge.dest, amountUsd: edge.amountUsd, ts: edge.lastTs });

      dfs(edge.dest, visited, addresses, hops);

      hops.pop();
      addresses.pop();
      visited.delete(edge.dest);
    }
  }

  function emitPath(
    addresses: string[],
    hops: { source: string; dest: string; amountUsd: number; ts: Date }[]
  ): void {
    if (hops.length < minHops) return;

    const timeGapMs = hops[hops.length - 1].ts.getTime() - hops[0].ts.getTime();
    if (timeGapMs < 0) return; // value moved backwards in time overall: drop

    const totalPathValueUsd = Math.min(...hops.map((h) => h.amountUsd));
    const firstAmount = hops[0].amountUsd;
    const lastAmount = hops[hops.length - 1].amountUsd;
    const valueRetentionPct = clamp((lastAmount / firstAmount) * 100, 0, 999);

    const pathConfidence = Math.min(
      confidenceByAddress.get(addresses[0]) ?? 100,
      ...addresses.slice(1).map((a) => confidenceByAddress.get(a) ?? 100)
    );

    results.push({
      addresses: [...addresses],
      hops: hops.map((h) => ({ ...h })),
      totalPathValueUsd,
      valueRetentionPct,
      timeGapMs,
      confidence: pathConfidence
    });
  }

  function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
  }

  dfs(rootAddress, new Set([rootAddress]), [rootAddress], []);

  results.sort((a, b) => b.totalPathValueUsd - a.totalPathValueUsd);
  return results.slice(0, maxPaths);
}
