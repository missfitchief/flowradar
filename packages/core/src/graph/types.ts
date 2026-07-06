// FlowRadar — wallet-graph BFS engine types (Task 19).
//
// Binding decisions (Task 19 brief): these shapes are the graph engine's own
// contract, distinct from (and more detailed than) the abbreviated
// GraphNode/GraphEdge/RawGraphEdge sketches in ../types.ts's plan-mirroring
// section. packages/core/src/types.ts is left untouched — the graph engine
// exports its real shapes from here, and apps/worker (Task 20) imports from
// this module for anything graph-shaped.
//
// This file (like all of packages/core) is PURE: no I/O, no settings import.
// Everything the BFS engine needs arrives via GraphSearchParams.

import type { Chain, GraphSearchParams, NodeType, WalletGraphRelationship } from '../types';

/**
 * One edge as returned by an EdgeFetcher, before dedupe/aggregation. `source`
 * is Task 19's naming for the edge's origin address, `dest` for its
 * destination (kept distinct from ../types.ts's GraphEdge.from/to, which
 * belongs to a different, unused sketch). `source`/`dest` always reflect the
 * TRUE fund-flow direction (who actually sent to whom) — this does NOT
 * change under bidirectional discovery (Module 6): only which edges get
 * RETURNED for a given queried address changes, never how an edge's own
 * direction is recorded.
 */
export interface RawGraphEdge {
  source: string;
  dest: string;
  relationship: WalletGraphRelationship;
  asset: string;
  amountUsd: number;
  txCount: number;
  firstTs: Date;
  lastTs: Date;
  sampleTxHashes: string[];
  /** Node-type hint for `dest` (or the non-`address` side) supplied by the fetcher, used when no registry hit exists. */
  counterpartyType?: NodeType;
}

/** Persisted/aggregated edge shape returned by runBfs — identical to RawGraphEdge post-dedupe. */
export type GraphEdge = RawGraphEdge;

export interface GraphNode {
  address: string;
  depth: number;
  nodeType: NodeType;
  totalSentUsd: number;
  totalReceivedUsd: number;
  netFlowUsd: number;
  interactionCount: number;
  firstSeen: Date | null;
  lastSeen: Date | null;
  tags: string[];
  confidence: number;
}

/**
 * Registry lookup — resolves an address to a known entity (CEX/bridge/
 * router/pool/deployer/mixer/token-contract) so the BFS engine can type
 * nodes and decide expansion without hard-coding any address list itself.
 */
export type RegistryLookup = (address: string) => {
  category: 'CEX' | 'BRIDGE' | 'ROUTER' | 'POOL' | 'DEPLOYER' | 'MIXER' | 'TOKEN_CONTRACT';
  label: string;
  doNotExpand: boolean;
} | null;

/**
 * Async edge fetcher — the only I/O seam. `params` is passed through so a
 * live/mock fetcher can respect perNodeTxCap, chain, time range, etc.
 * (perNodeTxCap itself is the fetcher's concern; the BFS engine only
 * documents it — see bfs.ts header.)
 *
 * Bidirectional discovery contract (Module 6 fix): for a queried `address`,
 * the fetcher returns EVERY edge touching `address` — both edges where
 * `address` is the true source (money OUT) and edges where `address` is the
 * true dest (money IN). The fetcher guarantees every returned RawGraphEdge
 * has `address` as EITHER `source` OR `dest` (never neither); `source`/`dest`
 * on the returned edge always reflect the true fund-flow direction and are
 * NEVER flipped/normalized to put `address` on a particular side. It is the
 * BFS engine's job (see bfs.ts's expandNode) to compute the counterparty as
 * whichever side of the edge is NOT `address`, and to admit/enqueue that
 * counterparty — not the fetcher's job to pre-orient edges around the
 * queried address.
 */
export interface EdgeFetcher {
  (address: string, chain: Chain, params: GraphSearchParams): Promise<RawGraphEdge[]>;
}

export interface TransactionPath {
  addresses: string[];
  hops: { source: string; dest: string; amountUsd: number; ts: Date }[];
  totalPathValueUsd: number;
  valueRetentionPct: number;
  timeGapMs: number;
  confidence: number;
}
