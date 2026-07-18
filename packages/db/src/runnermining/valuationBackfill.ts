// FlowRadar — historical trade-valuation backfill (product-rescue sprint).
//
// The ingest stores 0-for-unpriced on wallet_token_trades.amountUsd, which
// makes every wallet-quality metric NULL. This builder honestly backfills
// USD valuations for those trades using the canonical hierarchy, STRICTLY
// no-lookahead (only price observations at or before the trade):
//
//   1. prior_market_snapshot   — nearest PRIOR TokenMarketSnapshot within
//                                maxSnapshotAgeSec (exact local observation;
//                                confidence 70)
//   2. birdeye_1d_prior_close  — the CLOSE of the last Birdeye 1D candle
//                                whose END is at/before the trade (candle-END
//                                semantics; explicit estimate; confidence 40)
//   3. unavailable             — left NULL (unknown is never zero, never
//                                fabricated)
//
// Only rows whose legacy amountUsd <= 0 AND valuationSource IS NULL are
// touched; amountUsd receives the estimate so existing engines (behavior
// reconstruction, DNA, top-PnL) work unchanged, while valuedUsd /
// valuationSource / valuationConfidence make the estimate explicit and
// reversible (re-zero where valuationSource is set). marketCapAtTrade is
// filled from the same observation when it was 0. Idempotent, bounded,
// stable-ordered, per-token error isolation. SHADOW-ONLY.

import type { PrismaClient } from '@prisma/client';
import { toErrorReceipt, ERROR_RECEIPTS_MAX } from '../dormancy/activity';
import type { WalletErrorReceipt } from '../dormancy/activity';

export const VALUATION_BACKFILL_ENGINE_VERSION = 1;

interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

export interface ValuationBackfillReport {
  tokensConsidered: number;
  tokensProcessed: number;
  tradesExamined: number;
  backfilled: number;
  bySource: Record<string, number>;
  unpriceable: number;
  mcapFilled: number;
  errors: number;
  errorReceipts: WalletErrorReceipt[];
}

export async function backfillTradeValuations(
  prisma: PrismaClient,
  opts: {
    chain?: 'SOLANA' | 'BSC';
    /** Mints to backfill; default = every enriched token. */
    mints?: string[];
    /** Bound on tokens processed this pass. */
    limit?: number;
    /** Trades examined per token (bounded, stable order). */
    maxTradesPerToken?: number;
    /** Prior snapshot must be at most this old to price a trade. */
    maxSnapshotAgeSec?: number;
    /** Prior candle END must be at most this old to price a trade. */
    maxCandleAgeSec?: number;
  } = {}
): Promise<ValuationBackfillReport> {
  const chain = opts.chain ?? 'SOLANA';
  const limit = opts.limit ?? 300;
  const maxTradesPerToken = Math.min(opts.maxTradesPerToken ?? 5000, 20_000);
  const maxSnapshotAgeSec = opts.maxSnapshotAgeSec ?? 3600;
  const maxCandleAgeSec = opts.maxCandleAgeSec ?? 2 * 86_400;

  let mints: string[];
  if (opts.mints) {
    mints = [...new Set(opts.mints)].sort().slice(0, limit);
  } else {
    const rows = await prisma.tokenEnrichment.findMany({
      where: { status: 'enriched' },
      orderBy: { mint: 'asc' },
      take: limit,
      select: { mint: true }
    });
    mints = rows.map((r) => r.mint);
  }

  const report: ValuationBackfillReport = {
    tokensConsidered: mints.length,
    tokensProcessed: 0,
    tradesExamined: 0,
    backfilled: 0,
    bySource: {},
    unpriceable: 0,
    mcapFilled: 0,
    errors: 0,
    errorReceipts: []
  };

  for (const mint of mints) {
    try {
      const token = await prisma.token.findUnique({
        where: { chain_address: { chain, address: mint } },
        select: { id: true }
      });
      if (!token) {
        report.tokensProcessed += 1;
        continue;
      }

      // Enrichment candles + labeled supply (may be absent — snapshot-only then).
      const enrichment = await prisma.tokenEnrichment.findUnique({
        where: { mint },
        select: { candlesJson: true, supplyJson: true }
      });
      const candles = (Array.isArray(enrichment?.candlesJson) ? (enrichment?.candlesJson as unknown as Candle[]) : [])
        .filter((c) => Number.isFinite(c.c) && c.c > 0)
        .sort((a, b) => a.t - b.t);
      const supply = (enrichment?.supplyJson as { supply?: number } | null)?.supply ?? null;

      // Snapshots for this token (bounded; sorted asc for cursor walk).
      // REAL provider observations only — synthetic seed continuations must
      // never price a trade (fabricated prices are not evidence).
      const snapshots = await prisma.tokenMarketSnapshot.findMany({
        where: { tokenId: token.id, source: { not: { contains: 'synthetic' } } },
        orderBy: [{ ts: 'asc' }, { id: 'asc' }],
        take: 50_000,
        select: { ts: true, priceUsd: true, marketCapUsd: true }
      });

      const unpriced = await prisma.walletTokenTrade.findMany({
        where: { tokenId: token.id, chain, amountUsd: { lte: 0 }, valuationSource: null },
        orderBy: [{ ts: 'asc' }, { id: 'asc' }],
        take: maxTradesPerToken,
        select: { id: true, ts: true, amountToken: true, priceUsd: true, marketCapAtTrade: true }
      });
      report.tradesExamined += unpriced.length;

      // Cursor over sorted snapshots/candles (trades are ts-ascending).
      let snapIdx = -1;
      let candleIdx = -1;
      for (const trade of unpriced) {
        const tsMs = trade.ts.getTime();
        while (snapIdx + 1 < snapshots.length && snapshots[snapIdx + 1].ts.getTime() <= tsMs) snapIdx += 1;
        // Candle END = t + 86400 (1D): only candles whose END is <= trade ts
        // are knowable at the trade (no lookahead).
        while (candleIdx + 1 < candles.length && (candles[candleIdx + 1].t + 86_400) * 1000 <= tsMs) candleIdx += 1;

        let price: number | null = null;
        let mcap: number | null = null;
        let source: string | null = null;
        let confidence: number | null = null;

        const snap = snapIdx >= 0 ? snapshots[snapIdx] : null;
        if (snap && tsMs - snap.ts.getTime() <= maxSnapshotAgeSec * 1000 && Number(snap.priceUsd) > 0) {
          price = Number(snap.priceUsd);
          mcap = Number(snap.marketCapUsd) > 0 ? Number(snap.marketCapUsd) : null;
          source = 'prior_market_snapshot';
          confidence = 70;
        } else {
          const candle = candleIdx >= 0 ? candles[candleIdx] : null;
          if (candle && tsMs - (candle.t + 86_400) * 1000 <= maxCandleAgeSec * 1000) {
            price = candle.c;
            mcap = supply !== null && Number.isFinite(supply) && supply > 0 ? candle.c * supply : null;
            source = 'birdeye_1d_prior_close';
            confidence = 40;
          }
        }

        if (price === null || source === null) {
          report.unpriceable += 1; // unavailable — unknown stays NULL, never zero
          continue;
        }

        const amountToken = Number(trade.amountToken);
        const valued = amountToken * price;
        // Overflow/sanity guard: amountUsd is Decimal(20,4) — a value that
        // cannot fit (or a non-finite product) is UNPRICEABLE, never written.
        if (!Number.isFinite(amountToken) || amountToken <= 0 || !Number.isFinite(valued) || valued >= 1e15) {
          report.unpriceable += 1;
          continue;
        }
        const fillMcap = Number(trade.marketCapAtTrade) <= 0 && mcap !== null && mcap < 1e15;
        try {
          await prisma.walletTokenTrade.update({
            where: { id: trade.id },
            data: {
              amountUsd: valued,
              valuedUsd: valued,
              valuationSource: source,
              valuationConfidence: confidence,
              ...(Number(trade.priceUsd) <= 0 ? { priceUsd: price } : {}),
              ...(fillMcap ? { marketCapAtTrade: mcap! } : {})
            }
          });
        } catch (err) {
          // Per-TRADE isolation: one failed write never skips the token's
          // remaining trades.
          report.errors += 1;
          if (report.errorReceipts.length < ERROR_RECEIPTS_MAX) {
            report.errorReceipts.push(toErrorReceipt(`${mint}:${trade.id}`, err));
          }
          continue;
        }
        report.backfilled += 1;
        report.bySource[source] = (report.bySource[source] ?? 0) + 1;
        if (fillMcap) report.mcapFilled += 1;
      }
      report.tokensProcessed += 1;
    } catch (err) {
      report.errors += 1;
      if (report.errorReceipts.length < ERROR_RECEIPTS_MAX) {
        report.errorReceipts.push(toErrorReceipt(mint, err));
      }
    }
  }
  return report;
}
