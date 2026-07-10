// FlowRadar — Capital Lineage (Wave A6): bounded idempotent edge revaluation.
//
// Backfills honest valuation onto edges that were persisted before valuation
// existed (valuationStatus IS NULL) or that were previously unavailable. Pages
// by id cursor — never loads all edges. Updates ONLY valuation fields (never
// touches raw amountToken / amountUsd / txHash / the edge identity). Re-running
// is idempotent. A per-edge failure is recorded and skipped, never fails the
// pass. Holds the global job lock (serialized with seed/import/expansion).
//
// RE-ENROLLMENT (Codex Wave-A round 2): this job does NOT enroll receivers
// directly (that would need root/depth/cap context it lacks). Instead, when an
// edge NEWLY gains a value (unavailable/unpriced -> valued), it REOPENS the
// sender's completed expansion node (done -> pending, cursor reset). The next
// runLineageExpansion pass then re-processes that wallet, re-values inline, and
// enrolls with correct depth/caps — the single correct enrollment path.

import type { PrismaClient } from '@prisma/client';
import type { Settings } from '@flowradar/core';
import { resolveTransferValuation, type PriceContext } from './resolveValuation';
import { withGlobalJobLock } from '../locks/globalJobLock';

export interface RevaluateResult {
  edgesExamined: number;
  edgesValued: number;
  /** Edges that transitioned unavailable/unvalued -> a real value this pass. */
  newlyValued: number;
  stillUnavailable: number;
  /** Completed expansion nodes reopened so the next pass re-enrolls. */
  nodesReopened: number;
  errors: number;
  byStatus: Record<string, number>;
  lastId: string | null;
}

export interface RevaluateOptions {
  maxEdgesPerPass?: number;
  /** Current SOL/USD price fetched ONCE by the caller (or null to skip the estimate). */
  solCurrentPriceUsd?: number | null;
  solCurrentPriceTs?: Date | null;
  now?: Date;
  /**
   * Resume cursor: only edges with id > startAfterId are considered. Pass the
   * previous run's `lastId` back to page FORWARD across runs — without it a
   * bounded run always restarts at the lowest id and a persistently
   * `unavailable` earliest batch would be retried forever, starving later
   * never-valued edges (Codex Wave-A review).
   */
  startAfterId?: string;
  /** Narrow to edges whose sourceAddress starts with this prefix (targeted revaluation of one wallet/root's outflows). */
  sourceAddressStartsWith?: string;
}

export async function revaluateEdges(
  prisma: PrismaClient,
  settings: Settings,
  opts: RevaluateOptions = {}
): Promise<RevaluateResult> {
  return withGlobalJobLock('revaluate-edges', async () => {
    const maxEdges = opts.maxEdgesPerPass ?? 200;
    const ctx: PriceContext = {
      solCurrentPriceUsd: opts.solCurrentPriceUsd ?? null,
      solCurrentPriceTs: opts.solCurrentPriceTs ?? null,
      maxSnapshotAgeSec: settings.lineage.priceMaxSnapshotAgeSec
    };

    const result: RevaluateResult = {
      edgesExamined: 0,
      edgesValued: 0,
      newlyValued: 0,
      stillUnavailable: 0,
      nodesReopened: 0,
      errors: 0,
      byStatus: {},
      lastId: null
    };

    // Senders whose edges NEWLY gained a value — their completed expansion
    // nodes are reopened after the pass so the next expansion re-enrolls.
    const newlyValuedSenders = new Set<string>();
    let cursorId: string | undefined = opts.startAfterId;
    for (;;) {
      if (result.edgesExamined >= maxEdges) break;
      const batch = await prisma.moneyFlowEdge.findMany({
        where: {
          sourceChain: 'SOLANA',
          actionType: { in: ['transfer', 'cex_deposit', 'cex_withdrawal'] },
          OR: [{ valuationStatus: null }, { valuationStatus: 'unavailable' }],
          ...(opts.sourceAddressStartsWith ? { sourceAddress: { startsWith: opts.sourceAddressStartsWith } } : {}),
          ...(cursorId ? { id: { gt: cursorId } } : {})
        },
        // Stable id-cursor ordering so paging never skips an edge. Cross-run
        // starvation is prevented by startAfterId (the caller pages forward
        // with the previous run's lastId rather than restarting at id 0).
        orderBy: { id: 'asc' },
        take: Math.min(50, maxEdges - result.edgesExamined),
        select: { id: true, asset: true, assetMint: true, amountToken: true, amountUsd: true, ts: true, sourceAddress: true, valuedUsd: true }
      });
      if (batch.length === 0) break;

      for (const edge of batch) {
        result.edgesExamined += 1;
        cursorId = edge.id;
        const hadValue = edge.valuedUsd !== null;
        try {
          const valuation = await resolveTransferValuation(
            prisma,
            {
              asset: edge.asset,
              assetMint: edge.assetMint,
              amountToken: Number(edge.amountToken),
              transferTs: edge.ts,
              // Legacy positive amountUsd is a provider ingest valuation.
              providerValueUsd: Number(edge.amountUsd) > 0 ? Number(edge.amountUsd) : null
            },
            ctx
          );
          result.byStatus[valuation.status] = (result.byStatus[valuation.status] ?? 0) + 1;

          // Update ONLY valuation fields — never the raw amount or identity.
          await prisma.moneyFlowEdge.update({
            where: { id: edge.id },
            data: {
              valuedUsd: valuation.valuedUsd,
              priceUsd: valuation.priceUsd,
              priceTimestamp: valuation.priceTimestamp,
              valuationStatus: valuation.status,
              valuationSource: valuation.source,
              valuationConfidence: valuation.confidence,
              valuationAgeSeconds: valuation.ageSeconds,
              valuationReason: valuation.reason
            }
          });

          if (valuation.valuedUsd !== null) {
            result.edgesValued += 1;
            if (!hadValue) {
              result.newlyValued += 1;
              newlyValuedSenders.add(edge.sourceAddress);
            }
          } else {
            result.stillUnavailable += 1;
          }
        } catch {
          result.errors += 1;
        }
      }
    }

    // Reopen completed expansion nodes for senders whose edges NEWLY gained a
    // value, so the next expansion pass re-processes them and enrolls
    // receivers that were previously skipped as unavailable/$0 (Codex Wave-A
    // round 2). Cursor reset so the wallet is re-scanned from the start;
    // idempotent (edges + relationships dedupe).
    if (newlyValuedSenders.size > 0) {
      const reopened = await prisma.lineageExpansionNode.updateMany({
        where: { walletAddress: { in: [...newlyValuedSenders] }, status: 'done' },
        data: { status: 'pending', cursor: null, stopReason: null }
      });
      result.nodesReopened = reopened.count;
    }

    result.lastId = cursorId ?? null;
    return result;
  });
}
