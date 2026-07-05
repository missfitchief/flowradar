// FlowRadar — shared helpers for marketDataHot.ts / marketDataNormal.ts.
//
// Both jobs need the same "latest TokenFlowSnapshot.flowScore per token,
// partitioned by the hot-tier threshold" query and the same
// "getTokenMarket -> snapshotMarket" refresh loop; factored out here so
// neither file duplicates it (and so the >=50 threshold lives in exactly one
// place, matching brief decision 3's ">= 50" wording literally).

import { snapshotMarket } from '@flowradar/db';
import type { Chain } from '@flowradar/core';
import type { JobContext } from '../context.js';

interface TokenRef {
  id: string;
  address: string;
  chain: Chain;
  symbol: string;
}

/**
 * Splits every known Token into `hot` (latest TokenFlowSnapshot.flowScore >=
 * threshold) and `normal` (everything else, including tokens with no
 * TokenFlowSnapshot yet at all — a brand-new token is "normal" tier until
 * flowScoring produces its first snapshot).
 */
export async function partitionTokensByLatestFlowScore(
  ctx: JobContext,
  threshold: number
): Promise<{ hot: TokenRef[]; normal: TokenRef[] }> {
  const { prisma } = ctx;

  const tokens = await prisma.token.findMany({
    select: { id: true, address: true, chain: true, symbol: true }
  });

  // One row per token: the latest TokenFlowSnapshot (distinct tokenId,
  // ordered by ts desc — Prisma's distinct-with-orderBy pattern for
  // "latest per group").
  const latestSnapshots = await prisma.tokenFlowSnapshot.findMany({
    where: { tokenId: { in: tokens.map((t) => t.id) } },
    orderBy: { ts: 'desc' },
    distinct: ['tokenId'],
    select: { tokenId: true, flowScore: true }
  });
  const flowScoreByTokenId = new Map(latestSnapshots.map((s) => [s.tokenId, s.flowScore]));

  const hot: TokenRef[] = [];
  const normal: TokenRef[] = [];
  for (const token of tokens) {
    const flowScore = flowScoreByTokenId.get(token.id);
    if (flowScore !== undefined && flowScore >= threshold) {
      hot.push(token);
    } else {
      normal.push(token);
    }
  }

  return { hot, normal };
}

/** For each token: getTokenMarket via the resolved provider, then snapshotMarket. Errors per-token are logged, never rethrown. */
export async function refreshMarketForTokens(ctx: JobContext, tokens: TokenRef[], jobName: string): Promise<void> {
  const { prisma, providers, log } = ctx;
  const now = new Date();

  let refreshed = 0;
  let errors = 0;

  for (const token of tokens) {
    try {
      const marketProvider = providers(token.chain, 'marketData');
      const market = await marketProvider.getTokenMarket(token.chain, token.address);
      if (!market) continue;
      await snapshotMarket(prisma, token.id, market, now);
      refreshed += 1;
    } catch (err) {
      errors += 1;
      log.error(`${jobName}: failed to refresh market for ${token.symbol}`, {
        tokenId: token.id,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  log.info(`${jobName} cycle complete`, { tokensConsidered: tokens.length, tokensRefreshed: refreshed, errors });
}
