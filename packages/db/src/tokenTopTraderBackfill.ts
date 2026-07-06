// FlowRadar — runTokenTopTraderBackfill: the Wave 4.5 top-trader backfill
// pass (Task 35, Spec §5b). For every token whose market cap has recently
// expanded a lot, pulls that token's top traders from a
// TokenTopTradersProvider (Birdeye live, MockTokenTopTradersProvider in
// MOCK_MODE — see apps/worker/src/jobs/tokenTopTraderBackfill.ts's resolver)
// and inserts them as CandidateWallet rows (source='birdeye_top_traders'),
// which then flow through the SAME validation pipeline as every other
// candidate source (packages/db/src/candidateValidation.ts) — a top trader
// is never trusted/promoted directly by this pass.
//
// "Recently expanded a lot" = latest TokenMarketSnapshot.marketCapUsd >=
// settings.connectors.topTraderBackfill.mcapExpansionMin * the snapshot
// closest to (now - lookbackHours) at-or-before that time (same "latest
// snapshot at-or-before a timestamp" convention as ingest.ts's
// latestMarketCapUsd). A token with no snapshot old enough to compare
// against (too new) is skipped, not treated as an infinite expansion.
//
// Per-token try/catch: one token's provider call throwing is caught, logged,
// and never aborts the pass for any other qualifying token (same contract as
// externalWalletSource.ts's per-source try/catch).

import type { PrismaClient } from '@prisma/client';
import type { Chain, Settings } from '@flowradar/core';
import type { TokenTopTradersProvider } from '@flowradar/providers';

export interface TokenTopTraderBackfillLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/**
 * Resolves a TokenTopTradersProvider for `chain`. Returns null/undefined, OR
 * throws, to mean "no provider available" — both are handled gracefully
 * (this pass is a no-op for every token on that chain, not a crash).
 */
export type TokenTopTradersResolver = (chain: Chain) => TokenTopTradersProvider | null | undefined;

export interface TokenTopTraderBackfillResult {
  tokensConsidered: number;
  tokensQualified: number;
  candidatesUpserted: number;
  errors: number;
}

const SOURCE_NAME = 'birdeye_top_traders';
const HOUR_MS = 60 * 60 * 1000;

export async function runTokenTopTraderBackfill(
  prisma: PrismaClient,
  settings: Settings,
  resolveProvider: TokenTopTradersResolver,
  log?: TokenTopTraderBackfillLogger,
  now: Date = new Date()
): Promise<TokenTopTraderBackfillResult> {
  const { mcapExpansionMin, lookbackHours, topN } = settings.connectors.topTraderBackfill;
  const lookbackAt = new Date(now.getTime() - lookbackHours * HOUR_MS);

  const tokens = await prisma.token.findMany({ select: { id: true, chain: true, address: true } });

  let tokensQualified = 0;
  let candidatesUpserted = 0;
  let errors = 0;

  for (const token of tokens) {
    try {
      const latestSnapshot = await prisma.tokenMarketSnapshot.findFirst({
        where: { tokenId: token.id },
        orderBy: { ts: 'desc' },
        select: { marketCapUsd: true }
      });
      if (!latestSnapshot) continue; // no market data at all yet

      const lookbackSnapshot = await prisma.tokenMarketSnapshot.findFirst({
        where: { tokenId: token.id, ts: { lte: lookbackAt } },
        orderBy: { ts: 'desc' },
        select: { marketCapUsd: true }
      });
      if (!lookbackSnapshot) continue; // token too new to have a lookback baseline — skip, not an infinite expansion

      const latestMcap = Number(latestSnapshot.marketCapUsd);
      const lookbackMcap = Number(lookbackSnapshot.marketCapUsd);
      if (lookbackMcap <= 0) continue;

      const expansion = latestMcap / lookbackMcap;
      if (expansion < mcapExpansionMin) continue;

      tokensQualified += 1;

      const provider = resolveProvider(token.chain as Chain);
      if (!provider) {
        log?.info('tokenTopTraderBackfill: no provider available for chain, skipping token', {
          chain: token.chain,
          tokenAddress: token.address
        });
        continue;
      }

      const topTraders = await provider.getTopTraders(token.chain as Chain, token.address, { limit: topN });
      for (const trader of topTraders) {
        await upsertCandidateFromTopTrader(prisma, trader);
        candidatesUpserted += 1;
      }

      log?.info('tokenTopTraderBackfill: token qualified and backfilled', {
        tokenAddress: token.address,
        chain: token.chain,
        expansion,
        topTradersFound: topTraders.length
      });
    } catch (err) {
      errors += 1;
      log?.error('tokenTopTraderBackfill: failed to process token', {
        tokenId: token.id,
        tokenAddress: token.address,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  const summary: TokenTopTraderBackfillResult = {
    tokensConsidered: tokens.length,
    tokensQualified,
    candidatesUpserted,
    errors
  };
  log?.info('tokenTopTraderBackfill cycle complete', { ...summary });
  return summary;
}

async function upsertCandidateFromTopTrader(
  prisma: PrismaClient,
  trader: { walletAddress: string; chain: Chain; pnlUsd?: number; winRate?: number; tradeCount?: number }
): Promise<void> {
  const now = new Date();

  await prisma.candidateWallet.upsert({
    where: {
      walletAddress_chain_source: {
        walletAddress: trader.walletAddress,
        chain: trader.chain,
        source: SOURCE_NAME
      }
    },
    create: {
      walletAddress: trader.walletAddress,
      chain: trader.chain,
      source: SOURCE_NAME,
      claimedPnlUsd: trader.pnlUsd ?? null,
      claimedWinRate: trader.winRate ?? null,
      claimedTradeCount: trader.tradeCount ?? null,
      firstSeenAt: now,
      lastSeenAt: now,
      validationStatus: 'pending'
    },
    // Re-sync (same anti-clobber contract as externalWalletSource.ts's
    // upsertCandidateWallet): validationStatus is never touched on an
    // existing row.
    update: {
      claimedPnlUsd: trader.pnlUsd ?? null,
      claimedWinRate: trader.winRate ?? null,
      claimedTradeCount: trader.tradeCount ?? null,
      lastSeenAt: now
    }
  });
}

// Re-exported purely so callers that only import this module can reference
// the source name string without re-typing it — matches
// externalWalletSource.ts's convention of not hiding meaningful constants.
export const TOKEN_TOP_TRADER_BACKFILL_SOURCE_NAME = SOURCE_NAME;
