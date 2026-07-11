// FlowRadar — Capital Lineage (Wave A2-A5): DB price resolution.
//
// Resolves the price SOURCES a transfer needs (native SOL prior snapshot +
// current estimate; SPL prior snapshot; verified stablecoin) and hands them to
// the pure computeValuation. Snapshot lookups are strictly at-or-before the
// transfer (no lookahead). A per-edge price-lookup failure NEVER fails the
// pass — it degrades to `unavailable` (hard rule A1.5). The optional
// PriceContext lets a bounded revaluation pass fetch the current SOL price
// ONCE and reuse it across edges instead of per-edge network calls.

import type { PrismaClient } from '@prisma/client';
import { classifyAsset, computeValuation, WSOL_MINT, type PricePoint, type ValuationResult } from '@flowradar/core';

export interface PriceContext {
  /** Current SOL/USD price (fetched once per pass), used only as a labeled estimate. */
  solCurrentPriceUsd: number | null;
  /** When that price was observed. */
  solCurrentPriceTs: Date | null;
  maxSnapshotAgeSec: number;
}

export interface TransferForValuation {
  asset: string;
  assetMint: string | null;
  amountToken: number;
  transferTs: Date;
  /** True when the leg is a router/pool/program/bridge/service movement. */
  isServiceLeg?: boolean;
  /** A positive USD value the provider attached at ingest (0/absent = unpriced). */
  providerValueUsd?: number | null;
}

/**
 * Nearest LOCAL market snapshot at or before `ts` for a token identified by
 * mint address. Returns null when the token isn't tracked or has no prior
 * snapshot. Never returns a future snapshot.
 */
async function nearestPriorSnapshot(prisma: PrismaClient, mint: string, ts: Date): Promise<PricePoint | null> {
  const token = await prisma.token.findFirst({ where: { chain: 'SOLANA', address: mint }, select: { id: true } });
  if (!token) return null;
  const snap = await prisma.tokenMarketSnapshot.findFirst({
    where: { tokenId: token.id, ts: { lte: ts } },
    orderBy: { ts: 'desc' },
    select: { priceUsd: true, ts: true }
  });
  return snap ? { priceUsd: Number(snap.priceUsd), ts: snap.ts } : null;
}

/**
 * Values one transfer honestly. Returns a ValuationResult even on failure
 * (unavailable), never throws for a missing price.
 */
export async function resolveTransferValuation(
  prisma: PrismaClient,
  transfer: TransferForValuation,
  ctx: PriceContext
): Promise<ValuationResult> {
  const assetKind = classifyAsset({ symbol: transfer.asset, assetMint: transfer.assetMint, isServiceLeg: transfer.isServiceLeg });

  // A positive provider valuation is AUTHORITATIVE and needs no snapshot
  // lookup — short-circuit so a lookup failure can never discard it (Codex
  // Wave-A round 2). Service is still not_applicable regardless.
  if (assetKind !== 'service' && transfer.providerValueUsd != null && transfer.providerValueUsd > 0) {
    return computeValuation({ assetKind, amountToken: transfer.amountToken, transferTs: transfer.transferTs, maxSnapshotAgeSec: ctx.maxSnapshotAgeSec, providerValueUsd: transfer.providerValueUsd });
  }

  try {
    if (assetKind === 'service' || assetKind === 'stablecoin' || assetKind === 'unknown') {
      // service / stablecoin decided purely by computeValuation; unknown has no
      // price source => unavailable.
      return computeValuation({ assetKind, amountToken: transfer.amountToken, transferTs: transfer.transferTs, maxSnapshotAgeSec: ctx.maxSnapshotAgeSec, providerValueUsd: transfer.providerValueUsd });
    }

    if (assetKind === 'native_sol') {
      const priorSnapshot = await nearestPriorSnapshot(prisma, WSOL_MINT, transfer.transferTs);
      const currentPrice: PricePoint | null =
        ctx.solCurrentPriceUsd !== null && ctx.solCurrentPriceTs !== null
          ? { priceUsd: ctx.solCurrentPriceUsd, ts: ctx.solCurrentPriceTs }
          : null;
      return computeValuation({
        assetKind,
        amountToken: transfer.amountToken,
        transferTs: transfer.transferTs,
        maxSnapshotAgeSec: ctx.maxSnapshotAgeSec,
        providerValueUsd: transfer.providerValueUsd,
        priorSnapshot,
        currentPrice
      });
    }

    // SPL: nearest prior snapshot of the mint's token; no bulk current price.
    const priorSnapshot = transfer.assetMint ? await nearestPriorSnapshot(prisma, transfer.assetMint, transfer.transferTs) : null;
    return computeValuation({
      assetKind,
      amountToken: transfer.amountToken,
      transferTs: transfer.transferTs,
      maxSnapshotAgeSec: ctx.maxSnapshotAgeSec,
      providerValueUsd: transfer.providerValueUsd,
      priorSnapshot
    });
  } catch {
    // A price-lookup failure degrades to unavailable — never fails the pass.
    // Still honor a provider valuation if one was supplied.
    return computeValuation({ assetKind, amountToken: transfer.amountToken, transferTs: transfer.transferTs, maxSnapshotAgeSec: ctx.maxSnapshotAgeSec, providerValueUsd: transfer.providerValueUsd, priorSnapshot: null, currentPrice: null });
  }
}
