// FlowRadar — signals.ts: shared signal-detection pass body.
//
// Normative source: Task 15 binding decisions 3-4.
//
// Once per pass (not per-token — mirrors clustering.ts's own "global pass,
// not token-scoped" shape): runs runProfitRotation (Task 23 binding decision
// 3), which both PERSISTS ProfitRotationSignal rows and returns the matched
// MatchedRotationCandidate[] this same pass then threads into EVERY token's
// evaluateAllRules call as RuleExtras.rotationCandidates — ruleF.ts itself
// filters by candidate.destTokenId === agg.tokenId, so handing every token
// the SAME full candidate list is correct (each token's own Rule F
// evaluation only matches the subset actually destined for it).
//
// Per-token: fetches shared aggregate inputs (fetchAggregateInputs — the
// SAME fetch the scoring pass uses, so scoring and signals never compute
// two different notions of "this token's window"), builds the 30-min and
// 1440-min TokenWindowAggregate via @flowradar/core's aggregateWindow,
// builds FundingEvent[] via buildFundingEvents, runs evaluateAllRules with
// this pass's shared rotationCandidates, and for every FIRED rule result:
//   - dedupe: skip creating a new Signal row if an ACTIVE Signal already
//     exists for (tokenId, rule) with triggeredAt within the last 24h (a
//     rule that keeps firing tick after tick shouldn't spam a fresh row
//     every cycle — this is the "no duplicate open signal same token+rule"
//     requirement from the Task 15 brief).
//   - otherwise create one Signal row, sourcing walletCount/uniqueEntityCount/
//     netFlowUsd/mcapAtTrigger from WHICHEVER aggregate that specific rule
//     was evaluated against (agg30 for A/C/D/E, agg24h for B/F/G — matching
//     rules/index.ts's own agg30/agg24h routing), since RuleResult.metrics
//     is per-rule (not every rule's metrics carries a uniform
//     rawWalletCount/uniqueEntityCount pair — only Rule A's does — so
//     Signal-row-level counts are derived straight from the aggregate
//     itself, mirroring Rule A's own naming convention).
//
// After all 7 rules are evaluated, this token's most recent
// TokenFlowSnapshot row (if any — the scoring pass, which MUST run first,
// creates it) has its `signalStatus` column updated per the Spec mapping:
//   any G fired            -> exit_warning
//   else any F fired        -> profit_rotation
//   else any A-E fired      -> hot
//   else flowScore < 10 AND agg30 has zero window trades -> dead
//   else                     -> watching
//
// This module is called from BOTH apps/worker/src/jobs/signalDetection.ts
// (scheduled worker tick) and packages/db/src/seed.ts (one-shot seed pass),
// mirroring the scoring pass's own worker/seed sharing pattern (Task 6).

import { aggregateWindow, evaluateAllRules, firedRules } from '@flowradar/core';
import type { Settings, TokenWindowAggregate } from '@flowradar/core';
import type { PrismaClient } from '@prisma/client';
import { fetchAggregateInputs } from './fetchAggregateInputs';
import { buildFundingEvents } from './fundingEvents';
import { runProfitRotation } from './rotation';

const WINDOW_MINUTES_30 = 30;
const WINDOW_MINUTES_1440 = 1440;
const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEAD_FLOW_SCORE_FLOOR = 10;

export interface SignalDetectionLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface SignalDetectionResult {
  tokensConsidered: number;
  processed: number;
  signalsCreated: number;
  signalsDeduped: number;
  errors: number;
}

/**
 * Runs one full signal-detection pass across every token with >=1 trade
 * ever. Returns a summary plus (for seed.ts's self-check table) the raw
 * per-token fired-rule breakdown.
 */
export async function runSignalDetectionPass(
  prisma: PrismaClient,
  settings: Settings,
  log?: SignalDetectionLogger
): Promise<{ summary: SignalDetectionResult; perToken: Map<string, { symbol: string; fired: { rule: string; severity: string }[] }> }> {
  const now = new Date();

  const tokensWithTrades = await prisma.token.findMany({
    where: { trades: { some: {} } },
    select: { id: true, symbol: true }
  });

  // Once per pass (see file header): matches + persists ProfitRotationSignal
  // rows, and returns the SAME MatchedRotationCandidate[] every token's Rule
  // F evaluation below reads from.
  const { candidates: rotationCandidates } = await runProfitRotation(prisma, settings, now, log);

  let processed = 0;
  let signalsCreated = 0;
  let signalsDeduped = 0;
  let errors = 0;
  const perToken = new Map<string, { symbol: string; fired: { rule: string; severity: string }[] }>();

  for (const token of tokensWithTrades) {
    try {
      // F8: bound the market-snapshot load to only the points aggregateWindow
      // reads for these two windows (30m + 24h) — score-exact, and avoids
      // re-loading the token's full, ever-growing snapshot history each cycle.
      const inputs = await fetchAggregateInputs(prisma, token.id, settings, {
        now,
        windows: [WINDOW_MINUTES_30, WINDOW_MINUTES_1440]
      });
      if (inputs.trades.length === 0) {
        continue;
      }

      const agg30: TokenWindowAggregate = {
        ...aggregateWindow({
          trades: inputs.trades,
          wallets: inputs.wallets,
          clusters: inputs.clusters,
          market: inputs.market,
          windowMinutes: WINDOW_MINUTES_30,
          inflowSpikeMult: settings.rules.A.inflowSpikeMult,
          now
        }),
        tokenId: token.id
      };
      const agg24h: TokenWindowAggregate = {
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

      // Lookback bound: use agg24h.from (NOT agg30.from) — Rule E's funding
      // transfer can precede its resulting buy by up to E.maxDelayMin (120
      // minutes per DEFAULT_SETTINGS), and agg30 is only a 30-minute window
      // anchored to this token's OWN latest trade, which can sit well AFTER
      // the funding transfer that seeded a fresh wallet's very first buy
      // (e.g. the transfer lands 25+ minutes before agg30.from when the
      // funded wallet's buy isn't the token's most recent trade). agg24h.from
      // reaches back a full 24h from the same token-relative anchor, safely
      // covering any funding-to-buy chain within Rule E's delay band while
      // staying anchored to the token's own trading timeline rather than
      // real wall-clock time (which can drift arbitrarily far from a
      // historical/seeded token's actual activity).
      const fundingEvents = await buildFundingEvents(prisma, token.id, agg24h.from, now, settings);

      const results = evaluateAllRules(agg30, agg24h, settings, { fundingEvents, rotationCandidates });
      const fired = firedRules(results);

      perToken.set(token.id, {
        symbol: token.symbol,
        fired: fired.map((r) => ({ rule: r.rule, severity: r.severity }))
      });

      // Rules A, C, D, E are evaluated against agg30; B, F, G against agg24h
      // (mirrors rules/index.ts's own routing exactly).
      const agg24hRules = new Set(['B', 'F', 'G']);

      for (const result of fired) {
        const agg = agg24hRules.has(result.rule) ? agg24h : agg30;

        const dedupeWindowStart = new Date(now.getTime() - DEDUPE_WINDOW_MS);
        const existingActive = await prisma.signal.findFirst({
          where: {
            tokenId: token.id,
            rule: result.rule,
            status: 'active',
            triggeredAt: { gte: dedupeWindowStart }
          },
          select: { id: true }
        });

        if (existingActive) {
          signalsDeduped += 1;
          continue;
        }

        await prisma.signal.create({
          data: {
            tokenId: token.id,
            rule: result.rule,
            severity: result.severity,
            triggeredAt: now,
            reasons: result.reasons,
            walletCount: agg.smartWalletCount,
            uniqueEntityCount: agg.uniqueEntityCount,
            netFlowUsd: agg.netFlowUsd,
            mcapAtTrigger: agg.currentMcap ?? 0,
            status: 'active',
            metrics: {
              rawWalletCount: agg.smartWalletCount,
              uniqueEntityCount: agg.uniqueEntityCount,
              largestClusterSize: agg.largestClusterSize,
              // Clustering hasn't landed yet (Task 22) — degrades gracefully
              // to 'unknown' per the Task 15 binding decision, rather than a
              // fabricated numeric placeholder.
              entityConcentrationRisk: 'unknown'
            }
          }
        });
        signalsCreated += 1;
      }

      await updateSnapshotSignalStatus(prisma, token.id, fired, agg30);

      processed += 1;
    } catch (err) {
      errors += 1;
      log?.error(`signalDetection: failed to process token`, {
        tokenId: token.id,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  const summary: SignalDetectionResult = {
    tokensConsidered: tokensWithTrades.length,
    processed,
    signalsCreated,
    signalsDeduped,
    errors
  };
  log?.info('signalDetection cycle complete', { ...summary });
  return { summary, perToken };
}

/**
 * Updates the token's most recent TokenFlowSnapshot row's signalStatus per
 * the Spec mapping (see file header). No-op if the token has no snapshot
 * row yet (the scoring pass, which must run first, creates one for every
 * token with a scoreable window — a token this signal pass is processing
 * always has trades, so in practice a snapshot always exists by the time
 * this runs after a scoring pass; defensive no-op guards a signal-only run
 * with no prior scoring pass, e.g. a future targeted single-token
 * invocation).
 */
async function updateSnapshotSignalStatus(
  prisma: PrismaClient,
  tokenId: string,
  fired: { rule: string }[],
  agg30: TokenWindowAggregate
): Promise<void> {
  const latestSnapshot = await prisma.tokenFlowSnapshot.findFirst({
    where: { tokenId },
    orderBy: { ts: 'desc' },
    select: { id: true, flowScore: true }
  });
  if (!latestSnapshot) return;

  const firedRuleSet = new Set(fired.map((r) => r.rule));

  let signalStatus: 'watching' | 'hot' | 'profit_rotation' | 'exit_warning' | 'dead';
  if (firedRuleSet.has('G')) {
    signalStatus = 'exit_warning';
  } else if (firedRuleSet.has('F')) {
    signalStatus = 'profit_rotation';
  } else if (['A', 'B', 'C', 'D', 'E'].some((r) => firedRuleSet.has(r))) {
    signalStatus = 'hot';
  } else if (
    latestSnapshot.flowScore < DEAD_FLOW_SCORE_FLOOR &&
    agg30.trackedBuyVolumeUsd === 0 &&
    agg30.trackedSellVolumeUsd === 0
  ) {
    signalStatus = 'dead';
  } else {
    signalStatus = 'watching';
  }

  await prisma.tokenFlowSnapshot.update({
    where: { id: latestSnapshot.id },
    data: { signalStatus }
  });
}
