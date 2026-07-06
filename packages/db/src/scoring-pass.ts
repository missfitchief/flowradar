// FlowRadar — shared flow-scoring pass (Task 6 brief: "move the reusable
// job-body into packages/db ... have BOTH worker job and seed call it — do
// not copy-paste the logic twice").
//
// Task 15 rewrite: the interim `buildBasicAggregate` (Task 5's
// apps/worker/src/pipeline/basicAggregate.ts, moved here verbatim in Task 6)
// is DELETED. Both the 30-minute and 1440-minute (24h) TokenWindowAggregate
// are now built by @flowradar/core's `aggregateWindow`, fed by the shared
// `fetchAggregateInputs` query (packages/db/src/fetchAggregateInputs.ts) —
// the same fetch apps/worker/src/jobs/signalDetection.ts and
// packages/db/src/signals.ts's shared signal-detection body call, so the
// scoring pass and the signal pass never diverge on what a token's window
// "is".
//
// The persisted TokenFlowSnapshot row still reflects the 1440-minute
// aggregate (unchanged column set/semantics from Task 6), but
// componentBreakdown now ALSO carries a `metrics` key holding the 1440
// aggregate's `accumulation` sub-object (smartWalletCount30m/1h/6h,
// percentWalletsSold) per Task 15's wallet-driven scope-correction binding
// decision 2 — no schema change, componentBreakdown is already Json.
//
// Anchoring: aggregateWindow's own `to = min(now, latest trade ts)` rule
// (see packages/core/src/window/aggregate.ts's header) replaces this file's
// former from-scratch anchor-to-own-latest-trade logic — same behavior,
// now owned by the pure aggregate function itself instead of being
// duplicated here.

import { aggregateWindow, computeFlowScore } from '@flowradar/core';
import type { Chain, RiskReport, Settings } from '@flowradar/core';
import type { PrismaClient } from '@prisma/client';
import { fetchAggregateInputs } from './fetchAggregateInputs';

const WINDOW_MINUTES_30 = 30;
const WINDOW_MINUTES_1440 = 1440;

/** Minimal risk-lookup shape a caller must provide — deliberately narrower than the full JobContext/ProviderResolver types (which live in apps/worker), so packages/db doesn't need to depend on apps/worker. */
export interface RiskProviderLike {
  getTokenRisk(chain: Chain, address: string): Promise<RiskReport>;
}

export type RiskProviderResolver = (chain: Chain) => RiskProviderLike;

export interface ScoringPassLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface ScoringPassResult {
  tokensConsidered: number;
  scored: number;
  skippedNoWindow: number;
  errors: number;
}

/**
 * Runs one full flow-scoring pass: for every token with >=1 BUY/SELL trade
 * ever, fetches shared aggregate inputs, builds BOTH the 30-minute and
 * 1440-minute (24h) TokenWindowAggregate via @flowradar/core's
 * aggregateWindow, fetches a RiskReport from the resolved risk provider
 * (scored against the 1440-minute aggregate, matching prior behavior),
 * computes flowScore, and persists one TokenFlowSnapshot row (windowMinutes
 * 1440, signalStatus 'watching' — signal detection, Task 15's other half,
 * is the pass that revises signalStatus off the fired-rules mapping).
 * Shared by apps/worker/src/jobs/flowScoring.ts (scheduled worker tick) and
 * packages/db/src/seed.ts (one-shot seed pass) — identical logic, single
 * source of truth, per Task 6 brief's explicit "do not copy-paste"
 * instruction.
 */
export async function runFlowScoringPass(
  prisma: PrismaClient,
  settings: Settings,
  resolveRiskProvider: RiskProviderResolver,
  log?: ScoringPassLogger
): Promise<ScoringPassResult> {
  const now = new Date();

  // Every token that has at least one trade, ever (a token with zero
  // trades has nothing to aggregate and is skipped — aggregateWindow would
  // return an all-empty/all-null aggregate for it anyway, but this avoids
  // the query entirely for the common case of many never-traded noise
  // tokens).
  const tokensWithTrades = await prisma.token.findMany({
    where: { trades: { some: {} } },
    select: { id: true, chain: true, address: true, symbol: true }
  });

  let scored = 0;
  let skippedNoWindow = 0;
  let errors = 0;

  for (const token of tokensWithTrades) {
    try {
      const inputs = await fetchAggregateInputs(prisma, token.id, settings);
      if (inputs.trades.length === 0) {
        skippedNoWindow += 1;
        continue;
      }

      const agg24h = {
        ...aggregateWindow({
          trades: inputs.trades,
          wallets: inputs.wallets,
          clusters: inputs.clusters,
          market: inputs.market,
          windowMinutes: WINDOW_MINUTES_1440,
          inflowSpikeMult: settings.rules.A.inflowSpikeMult,
          now
        }),
        tokenId: token.id
      };

      const riskProvider = resolveRiskProvider(token.chain as Chain);
      const risk = await riskProvider.getTokenRisk(token.chain as Chain, token.address);

      const result = computeFlowScore(agg24h, risk, settings);

      const componentBreakdown = {
        ...result.components,
        ...(agg24h.accumulation ? { metrics: agg24h.accumulation } : {})
      };

      await prisma.tokenFlowSnapshot.create({
        data: {
          tokenId: token.id,
          ts: now,
          windowMinutes: agg24h.windowMinutes,
          flowScore: result.score,
          smartWalletCount: agg24h.smartWalletCount,
          humanLikeCount: agg24h.humanLikeCount,
          possibleBotCount: agg24h.possibleBotCount,
          uniqueEntityCount: agg24h.uniqueEntityCount,
          clusterAdjustedWalletCount: agg24h.uniqueEntityCount,
          entityConcentrationRisk: 0,
          trackedBuyVolumeUsd: agg24h.trackedBuyVolumeUsd,
          trackedSellVolumeUsd: agg24h.trackedSellVolumeUsd,
          netFlowUsd: agg24h.netFlowUsd,
          buySellRatio: agg24h.buySellRatio,
          avgEntryMcap: agg24h.avgEntryMcap ?? 0,
          currentMcap: agg24h.currentMcap ?? 0,
          mcapExpansionFromAvgEntry: agg24h.mcapExpansionFromAvgEntry ?? 0,
          holdersGrowth: 0,
          liquidityChange: agg24h.liquidityChangePct ?? 0,
          signalStatus: 'watching',
          componentBreakdown
        }
      });
      scored += 1;
    } catch (err) {
      errors += 1;
      log?.error(`flowScoring: failed to score ${token.symbol}`, {
        tokenId: token.id,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  const summary: ScoringPassResult = {
    tokensConsidered: tokensWithTrades.length,
    scored,
    skippedNoWindow,
    errors
  };
  log?.info('flowScoring cycle complete', { ...summary });
  return summary;
}

// Re-export WINDOW_MINUTES_30 for callers that need the 30-minute window's
// literal value without hardcoding it again (apps/worker/src/jobs/signalDetection.ts
// builds its OWN pair of aggregates via fetchAggregateInputs + aggregateWindow
// directly rather than reusing this function, since it needs BOTH windows
// simultaneously for evaluateAllRules — see that file).
export { WINDOW_MINUTES_30, WINDOW_MINUTES_1440 };
