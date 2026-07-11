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

import {
  aggregateWindow,
  computeFlowScore,
  shouldPersistFlowSnapshot,
  emptySnapshotPersistenceMetrics,
  quantizeToColumnScale,
  stableStringify,
  DEFAULT_SNAPSHOT_PERSISTENCE
} from '@flowradar/core';
import type { Chain, RiskReport, Settings, SnapshotPersistenceMetrics, FlowSnapshotComparable } from '@flowradar/core';
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
  /** Task 0 (storage bound): persistence accounting — attempted = inserted +
   *  suppressedUnchanged, so nothing is ever silently dropped. `scored` keeps
   *  its meaning of "tokens successfully scored" whether or not a row landed. */
  snapshotPersistence: SnapshotPersistenceMetrics;
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
  const persistence = emptySnapshotPersistenceMetrics();

  for (const token of tokensWithTrades) {
    try {
      // F8: bound the market-snapshot load to only the points aggregateWindow
      // reads for this 24h window (score-exact) instead of the token's full,
      // ever-growing snapshot history.
      const inputs = await fetchAggregateInputs(prisma, token.id, settings, {
        now,
        windows: [WINDOW_MINUTES_1440]
      });
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

      // Task 0 (storage bound): compare against the token's LATEST persisted
      // row and suppress ONLY byte-identical repeats within the routine
      // cadence (98.8% of writes at measurement time). Exact-match — any real
      // change, including a signalDetection in-place status revision on the
      // latest row, persists exactly as before.
      // USD/mcap fields persist as Decimal(20,4): quantize BOTH sides to the
      // column scale so a float's 4dp round-trip compares equal (raw floats
      // would defeat suppression every cycle — Codex review). The
      // componentBreakdown JSON participates via a stable fingerprint because
      // the Signal Feed reads it off the latest row.
      const nextRow: FlowSnapshotComparable = {
        ts: now,
        windowMinutes: agg24h.windowMinutes,
        flowScore: result.score,
        smartWalletCount: agg24h.smartWalletCount,
        humanLikeCount: agg24h.humanLikeCount,
        possibleBotCount: agg24h.possibleBotCount,
        uniqueEntityCount: agg24h.uniqueEntityCount,
        trackedBuyVolumeUsd: quantizeToColumnScale(agg24h.trackedBuyVolumeUsd),
        trackedSellVolumeUsd: quantizeToColumnScale(agg24h.trackedSellVolumeUsd),
        netFlowUsd: quantizeToColumnScale(agg24h.netFlowUsd),
        buySellRatio: agg24h.buySellRatio,
        avgEntryMcap: quantizeToColumnScale(agg24h.avgEntryMcap ?? 0),
        currentMcap: quantizeToColumnScale(agg24h.currentMcap ?? 0),
        mcapExpansionFromAvgEntry: agg24h.mcapExpansionFromAvgEntry ?? 0,
        liquidityChange: agg24h.liquidityChangePct ?? 0,
        signalStatus: 'watching',
        componentsFingerprint: stableStringify(componentBreakdown)
      };
      const latest = await prisma.tokenFlowSnapshot.findFirst({
        where: { tokenId: token.id, windowMinutes: agg24h.windowMinutes },
        orderBy: [{ ts: 'desc' }, { id: 'desc' }], // id tiebreak: deterministic under ms ties
        select: {
          ts: true,
          windowMinutes: true,
          flowScore: true,
          smartWalletCount: true,
          humanLikeCount: true,
          possibleBotCount: true,
          uniqueEntityCount: true,
          trackedBuyVolumeUsd: true,
          trackedSellVolumeUsd: true,
          netFlowUsd: true,
          buySellRatio: true,
          avgEntryMcap: true,
          currentMcap: true,
          mcapExpansionFromAvgEntry: true,
          liquidityChange: true,
          signalStatus: true,
          componentBreakdown: true
        }
      });
      const prevRow: FlowSnapshotComparable | null = latest
        ? {
            ts: latest.ts,
            windowMinutes: latest.windowMinutes,
            flowScore: latest.flowScore,
            smartWalletCount: latest.smartWalletCount,
            humanLikeCount: latest.humanLikeCount,
            possibleBotCount: latest.possibleBotCount,
            uniqueEntityCount: latest.uniqueEntityCount,
            trackedBuyVolumeUsd: quantizeToColumnScale(Number(latest.trackedBuyVolumeUsd)),
            trackedSellVolumeUsd: quantizeToColumnScale(Number(latest.trackedSellVolumeUsd)),
            netFlowUsd: quantizeToColumnScale(Number(latest.netFlowUsd)),
            buySellRatio: latest.buySellRatio,
            avgEntryMcap: quantizeToColumnScale(Number(latest.avgEntryMcap)),
            currentMcap: quantizeToColumnScale(Number(latest.currentMcap)),
            mcapExpansionFromAvgEntry: latest.mcapExpansionFromAvgEntry,
            liquidityChange: latest.liquidityChange,
            signalStatus: latest.signalStatus,
            componentsFingerprint: stableStringify(latest.componentBreakdown)
          }
        : null;

      // signalStatus lifecycle is OWNED by signal detection (which now records
      // real transitions as new rows — see signals.ts). Scoring CARRIES the
      // latest status forward instead of resetting to 'watching': otherwise a
      // hot token would oscillate watching->hot every cycle, fabricating
      // transitions and doubling rows (Codex re-review REJECT). New tokens
      // start 'watching' exactly as before.
      const carriedStatus = prevRow?.signalStatus ?? 'watching';
      nextRow.signalStatus = carriedStatus;

      persistence.attempted += 1;
      const decision = shouldPersistFlowSnapshot(prevRow, nextRow, DEFAULT_SNAPSHOT_PERSISTENCE);
      if (decision.persist) {
        try {
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
              signalStatus: carriedStatus as 'watching' | 'hot' | 'profit_rotation' | 'exit_warning' | 'dead',
              componentBreakdown
            }
          });
        } catch (err) {
          persistence.insertFailed += 1; // honest accounting even on DB failure
          throw err;
        }
        persistence.inserted += 1;
        if (decision.reason === 'first') persistence.firstSnapshots += 1;
        else if (decision.reason === 'changed') persistence.changedPersisted += 1;
        else persistence.routineHeartbeats += 1;
      } else {
        persistence.suppressedUnchanged += 1;
      }
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
    errors,
    snapshotPersistence: persistence
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
