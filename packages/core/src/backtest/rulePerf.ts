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
