// FlowRadar — runGraphSearch: shared body for the wallet-graph search job
// (Task 20 binding decision 2).
//
// Loads a WalletGraphSearch row, sets status running+startedAt, builds
// GraphSearchParams from the row's params Json (deep-merged over
// settings.graph defaults for any missing field — mirrors parseSettings'
// own "merge over defaults" convention, just scoped to the graph-search
// param shape instead of the whole Settings object), runs runBfs +
// extractPaths from @flowradar/core, persists WalletGraphNode/WalletGraphEdge
// rows (batched createMany), and writes back status done|truncated,
// nodeCount/edgeCount, finishedAt, resultSummary. On any throw, status is
// set to failed with the error message — this search row must NEVER be left
// in `running` state, so the whole body after the initial "set running" write
// is wrapped in try/catch that always reaches a terminal status.
//
// Called from two places (both awaiting the same shared function, per the
// brief): apps/worker/src/jobs/walletGraph.ts (on-demand job, future async
// use) and apps/web/app/api/graph/route.ts (synchronous inline call — the web
// app cannot depend on the worker process being up, same pattern as
// /api/import's importWalletsCsv call).

import type { PrismaClient } from '@prisma/client';
import { extractPaths, runBfs } from '@flowradar/core';
import type { Chain, GraphMode, GraphSearchParams, Settings, TransactionPath } from '@flowradar/core';
import { DEFAULT_SETTINGS } from '@flowradar/core';
import { createDbEdgeFetcher, createRegistryLookup } from './edgeFetcher';

/** Loose shape accepted from WalletGraphSearch.params (Json) — every field optional, filled from settings.graph defaults. */
export interface PartialGraphSearchParams {
  rootAddress?: string;
  chain?: Chain;
  mode?: GraphMode;
  maxDepth?: number;
  minTransferUsd?: number;
  timeRange?: { from?: string | Date; to?: string | Date };
  includeNative?: boolean;
  includeToken?: boolean;
  includeSwaps?: boolean;
  includeBridges?: boolean;
  includeCex?: boolean;
  excludeRoutersPoolsContracts?: boolean;
  maxNodes?: number;
  maxEdges?: number;
}

/**
 * Builds a full GraphSearchParams from the search row's rootAddress/chain/mode
 * columns (authoritative) plus its params Json (everything else), falling
 * back to settings.graph defaults for any field the stored params omit.
 */
function buildParams(
  row: { rootAddress: string; chain: Chain; mode: GraphMode; params: unknown },
  settings: Settings
): GraphSearchParams {
  const stored = (row.params ?? {}) as PartialGraphSearchParams;
  const graphDefaults = settings.graph;

  const timeRange = stored.timeRange
    ? {
        from: stored.timeRange.from ? new Date(stored.timeRange.from) : undefined,
        to: stored.timeRange.to ? new Date(stored.timeRange.to) : undefined
      }
    : undefined;

  return {
    rootAddress: row.rootAddress,
    chain: row.chain,
    mode: row.mode,
    maxDepth: stored.maxDepth ?? graphDefaults.maxDepth,
    minTransferUsd: stored.minTransferUsd ?? graphDefaults.minTransferUsd,
    timeRange,
    includeNative: stored.includeNative ?? true,
    includeToken: stored.includeToken ?? true,
    includeSwaps: stored.includeSwaps ?? true,
    includeBridges: stored.includeBridges ?? true,
    includeCex: stored.includeCex ?? true,
    excludeRoutersPoolsContracts: stored.excludeRoutersPoolsContracts ?? false,
    maxNodes: stored.maxNodes ?? graphDefaults.maxNodes,
    maxEdges: stored.maxEdges ?? graphDefaults.maxEdges
  };
}

export interface RunGraphSearchResult {
  status: 'done' | 'truncated' | 'failed';
  nodeCount: number;
  edgeCount: number;
}

/**
 * Runs one WalletGraphSearch end-to-end: running -> BFS -> persist -> done|
 * truncated, or failed on any thrown error. Never leaves the row in
 * `running` state.
 */
export async function runGraphSearch(prisma: PrismaClient, searchId: string): Promise<RunGraphSearchResult> {
  const search = await prisma.walletGraphSearch.findUniqueOrThrow({ where: { id: searchId } });

  await prisma.walletGraphSearch.update({
    where: { id: searchId },
    data: { status: 'running', startedAt: new Date(), error: null }
  });

  try {
    const settingsRow = await prisma.settings.findFirst();
    const settings: Settings = settingsRow ? (settingsRow.values as unknown as Settings) : DEFAULT_SETTINGS;

    const params = buildParams(search, settings);

    const perNodeTxCap = settings.graph.perNodeTxCap;
    const fetcher = createDbEdgeFetcher(prisma, { perNodeTxCap });
    const registry = await createRegistryLookup(prisma);

    const { nodes, edges, truncated } = await runBfs(params, fetcher, registry);
    const paths: TransactionPath[] = extractPaths(nodes, edges, params.rootAddress);

    // Persist: wipe any prior nodes/edges for this search (re-runs are
    // possible if this function is ever called twice for the same row), then
    // batch-insert the fresh result.
    await prisma.walletGraphNode.deleteMany({ where: { searchId } });
    await prisma.walletGraphEdge.deleteMany({ where: { searchId } });

    if (nodes.length > 0) {
      await prisma.walletGraphNode.createMany({
        data: nodes.map((n) => ({
          searchId,
          address: n.address,
          depth: n.depth,
          nodeType: n.nodeType,
          totalSentUsd: n.totalSentUsd,
          totalReceivedUsd: n.totalReceivedUsd,
          netFlowUsd: n.netFlowUsd,
          interactionCount: n.interactionCount,
          firstSeen: n.firstSeen ?? search.startedAt ?? new Date(),
          lastSeen: n.lastSeen ?? search.startedAt ?? new Date(),
          tags: n.tags,
          confidence: n.confidence
        }))
      });
    }

    if (edges.length > 0) {
      await prisma.walletGraphEdge.createMany({
        data: edges.map((e) => ({
          searchId,
          sourceAddress: e.source,
          destAddress: e.dest,
          relationship: e.relationship,
          totalUsd: e.amountUsd,
          txCount: e.txCount,
          firstTs: e.firstTs,
          lastTs: e.lastTs,
          sampleTxHashes: e.sampleTxHashes
        }))
      });
    }

    const resultSummary = {
      paths,
      counts: { nodeCount: nodes.length, edgeCount: edges.length, pathCount: paths.length }
    };

    const status = truncated ? 'truncated' : 'done';

    await prisma.walletGraphSearch.update({
      where: { id: searchId },
      data: {
        status,
        nodeCount: nodes.length,
        edgeCount: edges.length,
        finishedAt: new Date(),
        resultSummary: resultSummary as unknown as object
      }
    });

    return { status, nodeCount: nodes.length, edgeCount: edges.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.walletGraphSearch.update({
      where: { id: searchId },
      data: { status: 'failed', error: message, finishedAt: new Date() }
    });
    return { status: 'failed', nodeCount: 0, edgeCount: 0 };
  }
}
