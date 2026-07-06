// FlowRadar — evaluateReplay / rulePerformance / comboPerformance (Task 41
// binding decision 2).
//
// evaluateReplay joins each ReplayedSignal (Task 41's replay.ts) to a
// SignalOutcome via Task 40's evaluateSignalOutcome, using the POST-firedAt
// slice of a per-token market series supplied by the caller
// (marketSeriesByToken — the DB-facing runner builds this from
// TokenMarketSnapshot rows; see replayRunner.ts). Entry basis is taken from
// the series' own first point at/after firedAt (price preferred, mcap
// fallback — mirrors packages/db/src/backtest.ts's own entry-derivation, but
// self-contained here since packages/core cannot read Signal.mcapAtTrigger
// directly).
//
// Synthetic-provenance propagation (binding decision 2 — BINDING): if ANY
// point in the series slice this evaluation actually consumed carries
// `source === 'seed_synthetic_continuation'`, the resulting
// EvaluatedReplaySignal is flagged `syntheticEvidence: true`. Every summary
// function downstream (rulePerformance, comboPerformance) computes TWO
// parallel OutcomesSummary objects — `real` (syntheticEvidence: false only)
// and `synthetic` (syntheticEvidence: true only) — NEVER a single pooled
// summary. This is a hard requirement per the task brief ("never silently
// pooled").
//
// rulePerformance groups by rule (A-G), always returning all 7 keys (a rule
// with zero observed signals still gets a zero-count summary via
// summarizeOutcomes([])).
//
// comboPerformance computes the 8 combination specs required by the plan's
// binding capture (ui-backtest-wave35.md Phase B):
//   A                 — every fired Rule A signal.
//   A+B               — Rule A signals where Rule B ALSO fired on the SAME
//                        token within 24h of A's firedAt (either direction —
//                        "both fired same token <=24h apart" per the brief).
//   A+C               — same pairing shape, against Rule C.
//   A+entityAdjusted  — Rule A signals whose own metrics.uniqueEntityCount is
//                        >= a settings-derived minimum. There is no existing
//                        Settings field named exactly this; the min is
//                        DERIVED from settings.rules.A.watchMinWallets/2
//                        (rounded up) — half the WATCH wallet floor is used
//                        as a floor for "meaningfully-many distinct actors,
//                        not just one cluster wearing many wallets", which
//                        keeps this combo's threshold moving in lockstep with
//                        a tuned Rule A rather than being a second untunable
//                        magic number.
//   A+lowSellPressure — Rule A signals whose metrics.soldPct is
//                        < settings.rules.A.maxSoldPct / 2 (half the normal
//                        HIGH-tier sold-pct ceiling — a stricter "low sell
//                        pressure" filter on top of an already-fired A).
//   F                 — every fired Rule F signal.
//   F+clusterConf     — Rule F signals whose metrics.rotationConfidence (when
//                        present) is >= settings.entityConfidenceThreshold
//                        (61 by default — the plan's own "rotation confidence
//                        >= 61" framing). Signals with no rotationConfidence
//                        metric present are excluded (cannot evaluate the
//                        filter, so treated as not qualifying rather than
//                        silently passing).
//   A/B/F             — the union of every signal whose rule is A, B, or F
//                        (any of the three fired) — deduped so a token that
//                        fired more than one of A/B/F within the same
//                        evaluation batch only contributes each of its own
//                        underlying signals once (this combo is a signal-set
//                        union, not a per-token collapse).

import { evaluateSignalOutcome } from './evaluate';
import type { MarketPoint, SignalOutcome } from './evaluate';
import { summarizeOutcomes } from './summarize';
import type { OutcomesSummary } from './summarize';
import type { ReplayedSignal } from './replay';
import type { BacktestHorizon } from '../types';
import type { Settings } from '../settings';

const SYNTHETIC_SOURCE = 'seed_synthetic_continuation';

export interface EvaluatedReplaySignal {
  signal: ReplayedSignal;
  outcome: SignalOutcome;
  /** True when any market point actually consumed by this evaluation carried source='seed_synthetic_continuation'. */
  syntheticEvidence: boolean;
}

/** Picks an entry basis (price preferred, mcap fallback) from the series' first point at/after firedAt. Null when no such point exists. */
function deriveEntry(series: (MarketPoint & { source?: string })[], firedAt: Date): { entryPriceUsd: number | null; entryMcapUsd: number | null } {
  const atOrAfter = series.filter((p) => p.ts.getTime() >= firedAt.getTime()).sort((a, b) => a.ts.getTime() - b.ts.getTime());
  const first = atOrAfter[0];
  if (!first) return { entryPriceUsd: null, entryMcapUsd: null };
  return {
    entryPriceUsd: first.priceUsd > 0 ? first.priceUsd : null,
    entryMcapUsd: first.mcapUsd
  };
}

/**
 * Joins each replayed signal to its post-firedAt outcome using the supplied
 * per-token market series map. Signals for a tokenId with no entry in
 * marketSeriesByToken (or an empty series) still produce a result — a
 * neutral_pending outcome via evaluateSignalOutcome's own no-usable-data path
 * — rather than being dropped or throwing.
 */
export function evaluateReplay(
  replayed: ReplayedSignal[],
  marketSeriesByToken: Map<string, (MarketPoint & { source?: string })[]>,
  horizons?: BacktestHorizon[]
): EvaluatedReplaySignal[] {
  return replayed.map((signal) => {
    const series = (signal.tokenId !== undefined ? marketSeriesByToken.get(signal.tokenId) : undefined) ?? [];
    const { entryPriceUsd, entryMcapUsd } = deriveEntry(series, signal.firedAt);

    const consumedSlice = series.filter((p) => p.ts.getTime() >= signal.firedAt.getTime());
    const syntheticEvidence = consumedSlice.some((p) => p.source === SYNTHETIC_SOURCE);

    const outcome = evaluateSignalOutcome({
      triggeredAt: signal.firedAt,
      entryPriceUsd,
      entryMcapUsd,
      series: consumedSlice.map((p) => ({ ts: p.ts, priceUsd: p.priceUsd, mcapUsd: p.mcapUsd, liquidityUsd: p.liquidityUsd })),
      ...(horizons ? { horizons } : {})
    });

    return { signal, outcome, syntheticEvidence };
  });
}

export interface RealSyntheticSplit {
  real: OutcomesSummary;
  synthetic: OutcomesSummary;
}

function splitSummarize(evaluated: EvaluatedReplaySignal[]): RealSyntheticSplit {
  const real = evaluated.filter((e) => !e.syntheticEvidence).map((e) => e.outcome);
  const synthetic = evaluated.filter((e) => e.syntheticEvidence).map((e) => e.outcome);
  return { real: summarizeOutcomes(real), synthetic: summarizeOutcomes(synthetic) };
}

const ALL_RULES = ['A', 'B', 'C', 'D', 'E', 'F', 'G'] as const;
export type RulePerformance = Record<(typeof ALL_RULES)[number], RealSyntheticSplit>;

/** Groups evaluated replay signals by rule (A-G) and summarizes real vs synthetic-evidence outcomes independently per rule. Always returns all 7 keys. */
export function rulePerformance(evaluated: EvaluatedReplaySignal[]): RulePerformance {
  const result = {} as RulePerformance;
  for (const rule of ALL_RULES) {
    const forRule = evaluated.filter((e) => e.signal.rule === rule);
    result[rule] = splitSummarize(forRule);
  }
  return result;
}

export interface ComboPerfResult {
  name: string;
  summary: RealSyntheticSplit;
}

const PAIR_WINDOW_MS = 24 * 60 * 60 * 1000;

/** True when `other` fired for the same token within 24h (either direction) of `base`. */
function hasPairedFire(base: ReplayedSignal, all: ReplayedSignal[], otherRule: ReplayedSignal['rule']): boolean {
  return all.some(
    (s) =>
      s.rule === otherRule &&
      s.tokenId === base.tokenId &&
      Math.abs(s.firedAt.getTime() - base.firedAt.getTime()) <= PAIR_WINDOW_MS
  );
}

function asNumber(v: number | string | boolean | undefined): number | null {
  return typeof v === 'number' ? v : null;
}

/**
 * Computes the 8 required combo performance summaries (see file header for
 * each combo's exact definition). Every combo is evaluated over the SAME
 * `evaluated` batch — a combo with zero qualifying signals still appears
 * with a zero-count summary (via summarizeOutcomes([])), never omitted.
 */
export function comboPerformance(evaluated: EvaluatedReplaySignal[], settings: Settings): ComboPerfResult[] {
  const allSignals = evaluated.map((e) => e.signal);
  const aSignals = evaluated.filter((e) => e.signal.rule === 'A');
  const fSignals = evaluated.filter((e) => e.signal.rule === 'F');

  const minEntityAdjusted = Math.ceil(settings.rules.A.watchMinWallets / 2);
  const maxLowSellPressure = settings.rules.A.maxSoldPct / 2;

  const aPlusB = aSignals.filter((e) => hasPairedFire(e.signal, allSignals, 'B'));
  const aPlusC = aSignals.filter((e) => hasPairedFire(e.signal, allSignals, 'C'));
  const aPlusEntityAdjusted = aSignals.filter((e) => {
    const count = asNumber(e.signal.metrics.uniqueEntityCount);
    return count !== null && count >= minEntityAdjusted;
  });
  const aPlusLowSellPressure = aSignals.filter((e) => {
    const soldPct = asNumber(e.signal.metrics.soldPct);
    return soldPct !== null && soldPct < maxLowSellPressure;
  });
  const fPlusClusterConf = fSignals.filter((e) => {
    const conf = asNumber(e.signal.metrics.rotationConfidence);
    return conf !== null && conf >= settings.entityConfidenceThreshold;
  });
  const anyABF = evaluated.filter((e) => e.signal.rule === 'A' || e.signal.rule === 'B' || e.signal.rule === 'F');

  const combos: ComboPerfResult[] = [
    { name: 'A', summary: splitSummarize(aSignals) },
    { name: 'A+B', summary: splitSummarize(aPlusB) },
    { name: 'A+C', summary: splitSummarize(aPlusC) },
    { name: 'A+entityAdjusted', summary: splitSummarize(aPlusEntityAdjusted) },
    { name: 'A+lowSellPressure', summary: splitSummarize(aPlusLowSellPressure) },
    { name: 'F', summary: splitSummarize(fSignals) },
    { name: 'F+clusterConf', summary: splitSummarize(fPlusClusterConf) },
    { name: 'A/B/F', summary: splitSummarize(anyABF) }
  ];

  return combos;
}

// ---------------------------------------------------------------------------
// bucketPerformance (Task 41 review — IMPORTANT: capture-mandated bucket
// breakdowns, previously absent)
// ---------------------------------------------------------------------------
//
// Four independent bucketing dimensions, each real/synthetic split via the
// SAME splitSummarize pattern comboPerformance/rulePerformance already use —
// a signal is bucketed once per dimension (a signal can appear in exactly one
// bucket of EACH of the four dimensions simultaneously; the dimensions are
// orthogonal views over the same `evaluated` batch, not a single combined
// bucket key).
//
// Field sourcing (from RuleResult.metrics, i.e. ReplayedSignal.metrics — see
// rules/ruleA.ts, the only rule that currently populates mcapUsd/
// liquidityUsd/uniqueEntityCount; other rules' signals fall into the
// 'unknown' bucket for mcap/liquidity for exactly that reason, which is
// correct/expected today, not a bug):
//   mcapAtTrigger      <- metrics.mcapUsd (number)
//   liquidity          <- metrics.liquidityUsd (number)
//   uniqueEntityCount  <- metrics.uniqueEntityCount (number)
//   clusterConcentration <- metrics.entityConcentrationRisk (string, one of
//     'low'|'medium'|'high'|'unknown' per alerts/templates.ts's
//     ClusterConcentration type) — degrades to 'unknown' whenever the metric
//     is absent OR carries any other value, mirroring the same
//     "clustering hasn't landed yet -> unknown" degradation already used at
//     the DB layer (packages/db/src/signals.ts).
//
// Bucket boundaries (capture-mandated, inclusive lower / exclusive upper
// unless noted):
//   mcapAtTrigger:  <100k | [100k,1M) | [1M,5M) | >=5M | unknown (missing/non-number)
//   liquidity:      <20k | [20k,100k) | >=100k | unknown (missing/non-number)
//   uniqueEntityCount: 1-4 | 5-14 | 15+ (inclusive on both ends; a signal
//     with uniqueEntityCount < 1 or not a number is EXCLUDED from this
//     dimension's buckets entirely — there is no 'unknown' bucket in the
//     capture's own spec for this dimension, and fabricating one beyond the
//     literal capture would be an undocumented invention; mirrors
//     comboPerformance's own asNumber-based "cannot evaluate -> excluded"
//     precedent for uniqueEntityCount filters elsewhere in this file).
//   clusterConcentration: low | medium | high | unknown

export type McapBucket = '<100k' | '100k-1M' | '1M-5M' | '>5M' | 'unknown';
export type LiquidityBucket = '<20k' | '20k-100k' | '>100k' | 'unknown';
export type EntityCountBucket = '1-4' | '5-14' | '15+';
export type ClusterConcentrationBucket = 'low' | 'medium' | 'high' | 'unknown';

export interface BucketBreakdowns {
  mcapAtTrigger: Record<McapBucket, RealSyntheticSplit>;
  liquidity: Record<LiquidityBucket, RealSyntheticSplit>;
  uniqueEntityCount: Record<EntityCountBucket, RealSyntheticSplit>;
  clusterConcentration: Record<ClusterConcentrationBucket, RealSyntheticSplit>;
}

function mcapBucketOf(metrics: EvaluatedReplaySignal['signal']['metrics']): McapBucket {
  const v = asNumber(metrics.mcapUsd);
  if (v === null) return 'unknown';
  if (v < 100_000) return '<100k';
  if (v < 1_000_000) return '100k-1M';
  if (v < 5_000_000) return '1M-5M';
  return '>5M';
}

function liquidityBucketOf(metrics: EvaluatedReplaySignal['signal']['metrics']): LiquidityBucket {
  const v = asNumber(metrics.liquidityUsd);
  if (v === null) return 'unknown';
  if (v < 20_000) return '<20k';
  if (v < 100_000) return '20k-100k';
  return '>100k';
}

/** Null when the signal cannot be evaluated for this dimension (missing/non-number/< 1) — excluded from the returned buckets, per this file's header note (no 'unknown' bucket defined for this dimension in the capture spec). */
function entityCountBucketOf(metrics: EvaluatedReplaySignal['signal']['metrics']): EntityCountBucket | null {
  const v = asNumber(metrics.uniqueEntityCount);
  if (v === null || v < 1) return null;
  if (v <= 4) return '1-4';
  if (v <= 14) return '5-14';
  return '15+';
}

const CLUSTER_CONCENTRATION_VALUES = new Set(['low', 'medium', 'high', 'unknown']);

function clusterConcentrationBucketOf(metrics: EvaluatedReplaySignal['signal']['metrics']): ClusterConcentrationBucket {
  const v = metrics.entityConcentrationRisk;
  if (typeof v === 'string' && CLUSTER_CONCENTRATION_VALUES.has(v)) {
    return v as ClusterConcentrationBucket;
  }
  return 'unknown';
}

/**
 * Groups evaluated replay signals into 4 independent bucketing dimensions
 * (mcapAtTrigger, liquidity, uniqueEntityCount, clusterConcentration), each
 * real/synthetic split via splitSummarize. Every bucket key for every
 * dimension is always present (a bucket with zero qualifying signals still
 * gets a zero-count summary via summarizeOutcomes([]), never omitted) except
 * where a signal cannot be evaluated for the uniqueEntityCount dimension at
 * all (see entityCountBucketOf) — such signals simply don't contribute to
 * ANY of that one dimension's 3 buckets, while still contributing normally to
 * the other 3 dimensions.
 */
export function bucketPerformance(evaluated: EvaluatedReplaySignal[]): BucketBreakdowns {
  const byMcap = new Map<McapBucket, EvaluatedReplaySignal[]>();
  const byLiquidity = new Map<LiquidityBucket, EvaluatedReplaySignal[]>();
  const byEntityCount = new Map<EntityCountBucket, EvaluatedReplaySignal[]>();
  const byClusterConcentration = new Map<ClusterConcentrationBucket, EvaluatedReplaySignal[]>();

  for (const e of evaluated) {
    const metrics = e.signal.metrics;

    const mcapKey = mcapBucketOf(metrics);
    byMcap.set(mcapKey, [...(byMcap.get(mcapKey) ?? []), e]);

    const liqKey = liquidityBucketOf(metrics);
    byLiquidity.set(liqKey, [...(byLiquidity.get(liqKey) ?? []), e]);

    const entityKey = entityCountBucketOf(metrics);
    if (entityKey !== null) {
      byEntityCount.set(entityKey, [...(byEntityCount.get(entityKey) ?? []), e]);
    }

    const clusterKey = clusterConcentrationBucketOf(metrics);
    byClusterConcentration.set(clusterKey, [...(byClusterConcentration.get(clusterKey) ?? []), e]);
  }

  const mcapAtTrigger = {} as Record<McapBucket, RealSyntheticSplit>;
  for (const key of ['<100k', '100k-1M', '1M-5M', '>5M', 'unknown'] as const) {
    mcapAtTrigger[key] = splitSummarize(byMcap.get(key) ?? []);
  }

  const liquidity = {} as Record<LiquidityBucket, RealSyntheticSplit>;
  for (const key of ['<20k', '20k-100k', '>100k', 'unknown'] as const) {
    liquidity[key] = splitSummarize(byLiquidity.get(key) ?? []);
  }

  const uniqueEntityCount = {} as Record<EntityCountBucket, RealSyntheticSplit>;
  for (const key of ['1-4', '5-14', '15+'] as const) {
    uniqueEntityCount[key] = splitSummarize(byEntityCount.get(key) ?? []);
  }

  const clusterConcentration = {} as Record<ClusterConcentrationBucket, RealSyntheticSplit>;
  for (const key of ['low', 'medium', 'high', 'unknown'] as const) {
    clusterConcentration[key] = splitSummarize(byClusterConcentration.get(key) ?? []);
  }

  return { mcapAtTrigger, liquidity, uniqueEntityCount, clusterConcentration };
}
