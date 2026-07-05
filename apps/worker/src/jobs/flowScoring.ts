// FlowRadar — flowScoring job (Task 5 brief decision 3).
//
// For every token with at least one BUY/SELL trade ever, builds an interim
// TokenWindowAggregate (pipeline/basicAggregate.ts — replaced by
// @flowradar/core's real aggregateWindow in Task 15; see that file's header
// for why its 24h window is anchored to the token's own most recent trade
// rather than to `now`), fetches a RiskReport from the resolved risk
// provider, runs computeFlowScore, and persists one TokenFlowSnapshot row
// (windowMinutes 1440, signalStatus 'watching' — the real signal-status
// state machine arrives with signalDetection.ts in Task 15).

import { computeFlowScore } from '@flowradar/core';
import type { JobContext } from '../context.js';
import { buildBasicAggregate } from '../pipeline/basicAggregate.js';

export async function run(ctx: JobContext): Promise<void> {
  const { prisma, providers, settings, log } = ctx;
  const now = new Date();

  // Every token that has at least one trade, ever (a token with zero trades
  // has nothing to aggregate and is skipped — buildBasicAggregate would
  // return null for it anyway, but this avoids the query entirely for the
  // common case of many never-traded noise tokens).
  const tokensWithTrades = await prisma.token.findMany({
    where: { trades: { some: {} } },
    select: { id: true, chain: true, address: true, symbol: true }
  });

  let scored = 0;
  let skippedNoWindow = 0;
  let errors = 0;

  for (const token of tokensWithTrades) {
    try {
      const agg = await buildBasicAggregate(prisma, token.id, token.chain, settings, now);
      if (!agg) {
        skippedNoWindow += 1;
        continue;
      }

      const riskProvider = providers(token.chain, 'risk');
      const risk = await riskProvider.getTokenRisk(token.chain, token.address);

      const result = computeFlowScore(agg, risk, settings);

      await prisma.tokenFlowSnapshot.create({
        data: {
          tokenId: token.id,
          ts: now,
          windowMinutes: agg.windowMinutes,
          flowScore: result.score,
          smartWalletCount: agg.smartWalletCount,
          humanLikeCount: agg.humanLikeCount,
          possibleBotCount: agg.possibleBotCount,
          uniqueEntityCount: agg.uniqueEntityCount,
          clusterAdjustedWalletCount: agg.uniqueEntityCount,
          entityConcentrationRisk: 0,
          trackedBuyVolumeUsd: agg.trackedBuyVolumeUsd,
          trackedSellVolumeUsd: agg.trackedSellVolumeUsd,
          netFlowUsd: agg.netFlowUsd,
          buySellRatio: agg.buySellRatio,
          avgEntryMcap: agg.avgEntryMcap ?? 0,
          currentMcap: agg.currentMcap ?? 0,
          mcapExpansionFromAvgEntry: agg.mcapExpansionFromAvgEntry ?? 0,
          holdersGrowth: 0,
          liquidityChange: agg.liquidityChangePct ?? 0,
          signalStatus: 'watching',
          componentBreakdown: result.components
        }
      });
      scored += 1;
    } catch (err) {
      errors += 1;
      log.error(`flowScoring: failed to score ${token.symbol}`, {
        tokenId: token.id,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  log.info('flowScoring cycle complete', {
    tokensConsidered: tokensWithTrades.length,
    scored,
    skippedNoWindow,
    errors
  });
}
