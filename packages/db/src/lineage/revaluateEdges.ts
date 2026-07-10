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
import { enrollReceiverFromTransfer, type TransferObservation } from './enrollReceiver';
import { withGlobalJobLock } from '../locks/globalJobLock';

export interface RevaluateResult {
  edgesExamined: number;
  edgesValued: number;
  stillUnavailable: number;
  reEnrollmentsRun: number;
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
  /** When true, re-run receiver enrollment for valued edges (default true). */
  reEnroll?: boolean;
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
    const now = opts.now ?? new Date();
    const reEnroll = opts.reEnroll ?? true;
    const ctx: PriceContext = {
      solCurrentPriceUsd: opts.solCurrentPriceUsd ?? null,
      solCurrentPriceTs: opts.solCurrentPriceTs ?? null,
      maxSnapshotAgeSec: settings.lineage.priceMaxSnapshotAgeSec
    };

    const result: RevaluateResult = {
      edgesExamined: 0,
      edgesValued: 0,
      stillUnavailable: 0,
      reEnrollmentsRun: 0,
      errors: 0,
      byStatus: {},
      lastId: null
    };

    let cursorId: string | undefined;
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
        orderBy: { id: 'asc' },
        take: Math.min(50, maxEdges - result.edgesExamined),
        select: { id: true, asset: true, assetMint: true, amountToken: true, ts: true, sourceAddress: true, destinationAddress: true, txHash: true, valuationSource: true }
      });
      if (batch.length === 0) break;

      for (const edge of batch) {
        result.edgesExamined += 1;
        cursorId = edge.id;
        try {
          const valuation = await resolveTransferValuation(
            prisma,
            { asset: edge.asset, assetMint: edge.assetMint, amountToken: Number(edge.amountToken), transferTs: edge.ts },
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

          // Re-run receiver enrollment idempotently for valued edges whose
          // sender is lineage-tracked. Only when we actually have a value —
          // an unavailable edge must not enroll (unknown != above threshold).
          if (reEnroll && valuation.valuedUsd !== null) {
            const ran = await reEnrollForEdge(prisma, edge, valuation.valuedUsd, settings, now);
            result.reEnrollmentsRun += ran;
          }
        } catch {
          result.errors += 1;
        }
      }
    }

    result.lastId = cursorId ?? null;
    return result;
  });
}

/**
 * Re-runs enrollment for one valued edge across every lineage root the SENDER
 * belongs to (as a root, or via a subscription). Idempotent; returns the
 * number of (root) enrollment calls made.
 */
async function reEnrollForEdge(
  prisma: PrismaClient,
  edge: { asset: string; assetMint: string | null; amountToken: unknown; ts: Date; sourceAddress: string; destinationAddress: string; txHash: string },
  valuedUsd: number,
  settings: Settings,
  now: Date
): Promise<number> {
  const senderWallet = await prisma.wallet.findUnique({
    where: { address_chain: { address: edge.sourceAddress, chain: 'SOLANA' } },
    select: { id: true, lineageRoot: { select: { id: true } } }
  });
  if (!senderWallet) return 0;

  const rootIds = new Set<string>();
  if (senderWallet.lineageRoot) rootIds.add(senderWallet.lineageRoot.id);
  const subs = await prisma.monitoringSubscription.findMany({
    where: { walletId: senderWallet.id, lineageRootId: { not: null } },
    select: { lineageRootId: true }
  });
  for (const s of subs) if (s.lineageRootId) rootIds.add(s.lineageRootId);
  if (rootIds.size === 0) return 0;

  const transfer: TransferObservation = {
    txHash: edge.txHash,
    slot: 0n,
    ts: edge.ts,
    fromAddress: edge.sourceAddress,
    toAddress: edge.destinationAddress,
    asset: edge.asset,
    amountToken: Number(edge.amountToken),
    amountUsd: valuedUsd,
    isNativeSol: edge.assetMint === null && edge.asset === 'SOL',
    provider: 'revaluation'
  };

  let ran = 0;
  for (const rootId of rootIds) {
    // Depth = the sender's own expansion-node depth in this root (0 for a
    // root); a receiver enrolled here lands at depth+1.
    const node = await prisma.lineageExpansionNode.findUnique({
      where: { lineageRootId_walletAddress: { lineageRootId: rootId, walletAddress: edge.sourceAddress } },
      select: { depth: true }
    });
    const depth = node?.depth ?? 0;
    await enrollReceiverFromTransfer(prisma, transfer, rootId, depth, settings, now);
    ran += 1;
  }
  return ran;
}
