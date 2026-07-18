// FlowRadar — universe coverage + runner classification + control matching
// (pure; Runner Mining Tasks 1-3).
//
// Classification honesty rules (the load-bearing asymmetry):
//   - verified_above_10m needs ONE honest historical observation >= $10M —
//     an observed fact at an observed timestamp (no lookahead: the ATH comes
//     from computeTokenOutcome over ts-ordered observations only).
//   - verified_below_10m needs FULL-LIFE coverage: a series anchored at (or
//     provably near) token launch AND enough points — otherwise the token
//     could have peaked before we watched, and calling it a non-runner would
//     be survivorship-blind. Without anchoring it is insufficient_history.
//   - unknown is NEVER a non-runner; missing mcap is NEVER zero.
//   - The $10M threshold is fixed by the directive and NOT configurable here.

import type { TokenOutcome } from './outcome';

export type UniverseCoverage = 'covered' | 'partially_covered' | 'unavailable' | 'invalid' | 'unsupported' | 'quarantined';

export interface CoverageInput {
  /** Canonical base58 Solana mint validity (caller-validated). */
  validMint: boolean;
  /** Chain of the local token row; only SOLANA is supported this sprint. */
  chain: 'SOLANA' | 'BSC';
  /** Known pollution (e.g. the quarantined BSC fixture class). */
  quarantined: boolean;
  /** Valid historical mcap observations available locally. */
  seriesPointCount: number;
  /** Minimum points for full coverage (default 3, matching outcome engine). */
  minSeriesPoints?: number;
}

export function classifyUniverseCoverage(input: CoverageInput): UniverseCoverage {
  if (input.quarantined) return 'quarantined';
  if (input.chain !== 'SOLANA') return 'unsupported';
  if (!input.validMint) return 'invalid';
  const min = input.minSeriesPoints ?? 3;
  if (input.seriesPointCount === 0) return 'unavailable';
  if (input.seriesPointCount < min) return 'partially_covered';
  return 'covered';
}

export type RunnerClass =
  | 'verified_above_10m'
  | 'verified_below_10m'
  | 'insufficient_history'
  | 'conflicting_evidence'
  | 'invalid';

export const RUNNER_ATH_THRESHOLD_USD = 10_000_000; // fixed by directive — do not tune

export interface RunnerClassification {
  runnerClass: RunnerClass;
  confidence: 'high' | 'medium' | 'low';
  reasons: string[];
}

export interface RunnerClassifyInput {
  outcome: TokenOutcome;
  coverage: UniverseCoverage;
  /** True when the observation series provably starts at/near token launch. */
  anchoredAtLaunch: boolean;
  /** Distinct sources contributing observations (for conflict awareness). */
  sourceCount: number;
  /** Max relative disagreement between sources at overlapping timestamps (0..1+), null when single-source. */
  maxSourceDisagreement: number | null;
}

export function classifyRunner(input: RunnerClassifyInput): RunnerClassification {
  const { outcome, coverage, anchoredAtLaunch } = input;
  const reasons: string[] = [];

  if (coverage === 'invalid' || coverage === 'unsupported' || coverage === 'quarantined') {
    return { runnerClass: 'invalid', confidence: 'high', reasons: [`coverage=${coverage}`] };
  }
  if (coverage === 'unavailable' || outcome.athMcapUsd === null) {
    return { runnerClass: 'insufficient_history', confidence: 'high', reasons: ['no valid historical mcap observation — unknown is not a non-runner'] };
  }

  // Cross-source conflict beyond 3x at overlapping timestamps poisons the verdict.
  if (input.maxSourceDisagreement !== null && input.maxSourceDisagreement > 3) {
    return {
      runnerClass: 'conflicting_evidence',
      confidence: 'low',
      reasons: [`sources disagree ${input.maxSourceDisagreement.toFixed(1)}x at overlapping timestamps — not reconciled`]
    };
  }

  if (outcome.athMcapUsd >= RUNNER_ATH_THRESHOLD_USD) {
    // An observed fact: at athTs the reconstructed mcap was >= $10M.
    reasons.push(`observed historical mcap ${Math.round(outcome.athMcapUsd).toLocaleString()} at ${outcome.athTs?.toISOString() ?? 'unknown-ts'}`);
    const confidence = coverage === 'covered' && input.sourceCount >= 2 ? 'high' : coverage === 'covered' ? 'medium' : 'low';
    return { runnerClass: 'verified_above_10m', confidence, reasons };
  }

  // BELOW $10M requires full-life coverage: unanchored series only prove what
  // happened DURING observation, not that no earlier peak existed.
  if (!anchoredAtLaunch) {
    return {
      runnerClass: 'insufficient_history',
      confidence: 'medium',
      reasons: [`observed ATH ${Math.round(outcome.athMcapUsd).toLocaleString()} < 10M but series is NOT launch-anchored — an earlier unobserved peak cannot be excluded`]
    };
  }
  if (coverage !== 'covered') {
    return {
      runnerClass: 'insufficient_history',
      confidence: 'medium',
      reasons: ['launch-anchored but too few observations for a non-runner verdict']
    };
  }
  reasons.push(`launch-anchored full-coverage series; observed ATH ${Math.round(outcome.athMcapUsd).toLocaleString()} < 10,000,000`);
  return { runnerClass: 'verified_below_10m', confidence: outcome.confidence === 'high' ? 'high' : 'medium', reasons };
}

// ---------------------------------------------------------------------------
// Task 3 — matched controls (pre-outcome features ONLY)
// ---------------------------------------------------------------------------

export interface MatchFeatures {
  mint: string;
  /** Launch-period anchor (epoch ms of first observation/firstSeen). PRE-outcome. */
  launchTsMs: number;
  /** Baseline (first observed) mcap — PRE-outcome by construction. */
  baselineMcapUsd: number | null;
  /** Early activity proxy: observations in the FIRST 24h of the series (pre-outcome by construction). */
  earlyPointCount: number;
  /** Unknown-outcome controls (insufficient_history) are capped at tier2 — survivorship caveat. */
  tier2Only?: boolean;
}

export interface ControlMatch {
  runnerMint: string;
  controlMint: string | null;
  status: 'matched_tier1' | 'matched_tier2' | 'no_valid_control';
  tier: 'tier1' | 'tier2' | null;
  distance: number | null;
  confidence: 'high' | 'medium' | 'low';
  reason: string | null;
  excluded: { mint: string; reason: string }[];
}

const TIER1_LAUNCH_WINDOW_MS = 7 * 86400_000;
const TIER2_LAUNCH_WINDOW_MS = 30 * 86400_000;

function matchDistance(a: MatchFeatures, b: MatchFeatures): number | null {
  if (a.baselineMcapUsd === null || b.baselineMcapUsd === null || a.baselineMcapUsd <= 0 || b.baselineMcapUsd <= 0) return null;
  const mcapRatio = Math.abs(Math.log(b.baselineMcapUsd / a.baselineMcapUsd)); // 0 = identical scale
  const launchGapDays = Math.abs(a.launchTsMs - b.launchTsMs) / 86400_000;
  const activityGap = Math.abs(Math.log((b.earlyPointCount + 1) / (a.earlyPointCount + 1)));
  return mcapRatio * 2 + launchGapDays / 7 + activityGap; // deterministic weighted distance
}

/**
 * Deterministic greedy matching: runners sorted by mint; each takes its
 * nearest UNUSED control (tier1 first: launch within 7d + baseline within
 * ~2.7x; tier2: 30d window, any comparable baseline). Ties break by mint.
 * Controls never reuse; no post-outcome feature participates — callers must
 * pass only pre-outcome features (enforced by the MatchFeatures shape).
 */
export function matchControls(runners: MatchFeatures[], controlPool: MatchFeatures[]): ControlMatch[] {
  const used = new Set<string>();
  const results: ControlMatch[] = [];
  const sortedRunners = [...runners].sort((a, b) => (a.mint < b.mint ? -1 : 1));

  for (const runner of sortedRunners) {
    const excluded: { mint: string; reason: string }[] = [];
    let best: { mint: string; distance: number; tier: 'tier1' | 'tier2' } | null = null;

    const candidates = [...controlPool].sort((a, b) => (a.mint < b.mint ? -1 : 1));
    for (const cand of candidates) {
      if (cand.mint === runner.mint) continue;
      if (used.has(cand.mint)) {
        if (excluded.length < 10) excluded.push({ mint: cand.mint, reason: 'already matched to another runner' });
        continue;
      }
      const launchGap = Math.abs(runner.launchTsMs - cand.launchTsMs);
      const d = matchDistance(runner, cand);
      if (d === null) {
        if (excluded.length < 10) excluded.push({ mint: cand.mint, reason: 'baseline mcap unavailable — cannot match on pre-outcome scale' });
        continue;
      }
      const mcapComparable =
        runner.baselineMcapUsd !== null && cand.baselineMcapUsd !== null &&
        Math.abs(Math.log(cand.baselineMcapUsd / runner.baselineMcapUsd)) <= 1; // within ~e (2.7x)
      let tier: 'tier1' | 'tier2' | null =
        launchGap <= TIER1_LAUNCH_WINDOW_MS && mcapComparable ? 'tier1' : launchGap <= TIER2_LAUNCH_WINDOW_MS ? 'tier2' : null;
      if (tier === 'tier1' && cand.tier2Only) tier = 'tier2'; // unknown-outcome control never tier1
      if (tier === null) {
        if (excluded.length < 10) excluded.push({ mint: cand.mint, reason: 'launch period too far for any tier' });
        continue;
      }
      const better =
        best === null ||
        (tier === 'tier1' && best.tier === 'tier2') ||
        (tier === best.tier && (d < best.distance || (d === best.distance && cand.mint < best.mint)));
      if (better) best = { mint: cand.mint, distance: d, tier };
    }

    if (best) {
      used.add(best.mint);
      results.push({
        runnerMint: runner.mint,
        controlMint: best.mint,
        status: best.tier === 'tier1' ? 'matched_tier1' : 'matched_tier2',
        tier: best.tier,
        distance: best.distance,
        confidence: best.tier === 'tier1' ? 'medium' : 'low', // local features only — never 'high' without venue/holder data
        reason: null,
        excluded
      });
    } else {
      results.push({
        runnerMint: runner.mint,
        controlMint: null,
        status: 'no_valid_control',
        tier: null,
        distance: null,
        confidence: 'high',
        reason: 'no candidate with comparable pre-outcome features in any tier',
        excluded
      });
    }
  }
  return results;
}

/** Research entry bands (Task 4) — under_50k focus, fixed by directive. */
export type EarlyEntryBand = 'under_5k' | '5k_to_10k' | '10k_to_20k' | '20k_to_50k';

export function earlyEntryBand(mcapUsd: number | null): EarlyEntryBand | null {
  if (mcapUsd === null || !Number.isFinite(mcapUsd) || mcapUsd < 0) return null; // unknown is NOT a band
  if (mcapUsd < 5_000) return 'under_5k';
  if (mcapUsd < 10_000) return '5k_to_10k';
  if (mcapUsd < 20_000) return '10k_to_20k';
  if (mcapUsd < 50_000) return '20k_to_50k';
  return null;
}
