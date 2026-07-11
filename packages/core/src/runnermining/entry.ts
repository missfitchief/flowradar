// FlowRadar — runner-mining ENTRY-TIME side (Task 2).
//
// THE NO-LOOKAHEAD WALL: this module may import ONLY ./types. It must never
// import the outcome side or reference its labels/types — enforced by a
// static guard test. Everything computed here is provably computable at buy time:
//   1. the series is truncated to STRICTLY-PRIOR points (ts < buyTs) first —
//      a snapshot stamped at exactly buyTs could have been produced after the
//      trade within the same second, so ties are excluded (conservative);
//   2. duplicate-timestamp ties among prior points resolve DETERMINISTICALLY
//      to the HIGHEST mcap (conservative: never overstate how early/low the
//      entry was) with a confidence penalty for the ambiguity;
//   3. stale or missing prior data ⇒ 'unavailable', mcap null, bucket
//      'unknown' — never $0, never current-price-as-historical
//      (current_price_estimate is deliberately not a status here).

import type { RunnerMiningConfig, TokenSeriesPoint } from './types';
import { validateRunnerMiningConfig } from './types';

export type EntryMcapBucket =
  | 'under_5k'
  | '5k_to_10k'
  | '10k_to_20k'
  | '20k_to_50k'
  | '50k_to_100k'
  | '100k_to_250k'
  | '250k_to_1m'
  | 'above_1m'
  | 'unknown';

export function entryMcapBucket(mcapUsd: number | null): EntryMcapBucket {
  // <= 0 is UNKNOWN, not "under_5k": a $0 mcap is the classic
  // unknown-coerced-to-zero artifact and must never classify as a low-mcap
  // entry (Codex: eligibility-bypass risk downstream).
  if (mcapUsd === null || !Number.isFinite(mcapUsd) || mcapUsd <= 0) return 'unknown';
  if (mcapUsd < 5_000) return 'under_5k';
  if (mcapUsd < 10_000) return '5k_to_10k';
  if (mcapUsd < 20_000) return '10k_to_20k';
  if (mcapUsd < 50_000) return '20k_to_50k';
  if (mcapUsd < 100_000) return '50k_to_100k';
  if (mcapUsd < 250_000) return '100k_to_250k';
  if (mcapUsd < 1_000_000) return '250k_to_1m';
  return 'above_1m';
}

/** Historical mining statuses ONLY — current_price_estimate is deliberately absent. */
export type EntryValuationStatus = 'nearest_prior_snapshot' | 'unavailable';

export interface EntryContext {
  entryPriceUsd: number | null;
  entryMarketCapUsd: number | null;
  entryLiquidityUsd: number | null;
  priceTimestamp: Date | null;
  valuationStatus: EntryValuationStatus;
  valuationAgeSeconds: number | null;
  /** 1 near age 0, linearly decaying to 0.25 at maxEntrySnapshotAgeSec; halved on ambiguous ties; 0 when unavailable. */
  valuationConfidence: number;
  bucket: EntryMcapBucket;
  /** True/false only when the mcap is KNOWN; null = unknown (never defaulted). */
  belowFocusCeiling: boolean | null;
}

export function computeEntryContext(
  buyTs: Date,
  series: TokenSeriesPoint[],
  cfg: RunnerMiningConfig
): EntryContext {
  validateRunnerMiningConfig(cfg);
  const buyMs = buyTs.getTime();
  // STRUCTURAL no-lookahead: strictly-prior points only (ties excluded).
  const prior = series.filter((p) => p.ts.getTime() < buyMs);

  const unavailable: EntryContext = {
    entryPriceUsd: null,
    entryMarketCapUsd: null,
    entryLiquidityUsd: null,
    priceTimestamp: null,
    valuationStatus: 'unavailable',
    valuationAgeSeconds: null,
    valuationConfidence: 0,
    bucket: 'unknown',
    belowFocusCeiling: null
  };

  // Nearest strictly-prior point carrying a valid mcap. Ties on the same
  // timestamp resolve to the HIGHEST mcap, deterministically (input order
  // must never change the answer) and conservatively (never claim a lower
  // entry than the ambiguous data supports).
  let best: TokenSeriesPoint | null = null;
  let tieAmbiguity = false;
  for (const p of prior) {
    if (p.marketCapUsd === null || !Number.isFinite(p.marketCapUsd) || p.marketCapUsd <= 0) continue;
    if (best === null || p.ts.getTime() > best.ts.getTime()) {
      best = p;
      tieAmbiguity = false;
    } else if (p.ts.getTime() === best.ts.getTime() && p.marketCapUsd !== best.marketCapUsd) {
      tieAmbiguity = true;
      if (p.marketCapUsd > best.marketCapUsd!) best = p;
    }
  }
  if (best === null) return unavailable;

  // Compare UNROUNDED milliseconds against the window (rounding first would
  // let a just-over-window snapshot squeak in when maxAge is tiny).
  const ageMs = buyMs - best.ts.getTime();
  if (ageMs > cfg.maxEntrySnapshotAgeSec * 1000) return unavailable; // stale ⇒ unknown, never "close enough"
  const ageSec = ageMs / 1000;

  const mcap = best.marketCapUsd!;
  const ageFraction = cfg.maxEntrySnapshotAgeSec > 0 ? ageSec / cfg.maxEntrySnapshotAgeSec : 0;
  let valuationConfidence = 1 - 0.75 * Math.min(1, Math.max(0, ageFraction));
  if (tieAmbiguity) valuationConfidence /= 2; // ambiguous same-ts data

  return {
    entryPriceUsd: best.priceUsd,
    entryMarketCapUsd: mcap,
    entryLiquidityUsd: best.liquidityUsd,
    priceTimestamp: new Date(best.ts.getTime()),
    valuationStatus: 'nearest_prior_snapshot',
    valuationAgeSeconds: ageSec,
    valuationConfidence,
    bucket: entryMcapBucket(mcap),
    belowFocusCeiling: mcap < cfg.lowMcapFocusCeilingUsd
  };
}
