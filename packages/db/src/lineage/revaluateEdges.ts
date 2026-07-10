// FlowRadar — Capital Lineage (Wave A6): bounded idempotent edge revaluation.
//
// Backfills honest valuation onto edges that were persisted before valuation
// existed (valuationStatus IS NULL) or that were previously unavailable. Pages
// by id cursor — never loads all edges. Updates ONLY valuation fields (never
// touches raw amountToken / amountUsd / txHash / the edge identity). Re-running
// is idempotent: the same inputs produce the same valuation, and re-enrollment
// goes through the idempotent enrollReceiverFromTransfer (which NEVER grants
// signal eligibility). A per-edge failure is recorded and skipped, never fails
// the pass. Holds the global job lock (serialized with seed/import/expansion).

import type { PrismaClient } from '@prisma/client';
import type { Settings } from '@flowradar/core';
import { resolveTransferValuation, type PriceContext } from './resolveValuation';
import { withGlobalJobLock } from '../locks/globalJobLock';

export interface RevaluateResult {
  edgesExamined: number;
  edgesValued: number;
  stillUnavailable: number;
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
      stillUnavailable: 0,
      errors: 0,
      byStatus: {},
      lastId: null
    };

    // This job ONLY re-values edges. Re-enrollment is deliberately NOT done
    // here (Codex Wave-A review): the frontier RESUME (runLineageExpansion,
    // Wave B) re-processes each wallet, re-values inline, and enrolls with the
    // correct depth/cap accounting — doing enrollment here with a defaulted
    // depth would bypass node/child/day bounds.
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
        select: { id: true, asset: true, assetMint: true, amountToken: true, amountUsd: true, ts: true }
      });
      if (batch.length === 0) break;

      for (const edge of batch) {
        result.edgesExamined += 1;
        cursorId = edge.id;
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

          if (valuation.valuedUsd !== null) result.edgesValued += 1;
          else result.stillUnavailable += 1;
        } catch {
          result.errors += 1;
        }
      }
    }

    result.lastId = cursorId ?? null;
    return result;
  });
}
