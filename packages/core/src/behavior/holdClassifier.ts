// FlowRadar — buy/hold vs fast-dump/stuck classifier (pure; GMGN behavior
// plan Task 6 / directive Task 4).
//
// Classifies a reconstructed BehaviorProfile's LOCAL token positions into
// neutral behavior labels. Grounding rules:
//   - Metrics come ONLY from locally-observed positions (provider claims never
//     classify — they are context, surfaced separately).
//   - Holding is NOT automatically good: durable_holder is a neutral
//     description, not praise; a holder of worthless residue is labeled as
//     such when value data exists, and 'unknown' when it doesn't.
//   - Missing inputs (price series for 2x/5x retention, per-token liquidity,
//     token outcomes) make those metrics NULL with an explicit caveat — never
//     zero, never guessed.
//   - Small samples gate the output: promising_low_sample / insufficient_history
//     instead of confident labels.
//   - NO classification grants signal eligibility — output carries no status,
//     no votes, no promotion linkage.

import type { BehaviorProfile, TokenPositionSummary } from './reconstruct';

export const HOLD_CLASSIFIER_VERSION = 1;

export type HoldBehaviorLabel =
  | 'durable_holder'
  | 'selective_swing_trader'
  | 'fast_flipper'
  | 'probable_distribution_pattern'
  | 'illiquid_stuck_holder'
  | 'received_not_bought'
  | 'worthless_residue'
  | 'promising_low_sample'
  | 'insufficient_history'
  | 'rejected_dirty_data';

export interface HoldMetrics {
  sampleSize: number; // bought positions (buy evidence exists)
  pctFirstSellWithin1m: number | null;
  pctFirstSellWithin5m: number | null;
  pctFirstSellWithin30m: number | null;
  pctFirstSellWithin2h: number | null;
  medianTimeToFirstSellSec: number | null;
  medianTimeToFullExitSec: number | null;
  pctHeldAfter1h: number | null;
  pctHeldAfter6h: number | null;
  pctHeldAfter24h: number | null;
  pctHeldAfter72h: number | null;
  partialExitCount: number;
  fullExitCount: number;
  medianRetainedPct: number | null; // 1 - min(exitRatio,1), median over bought positions
  /** Retention after 2x/5x requires a price series we do not hold locally — null with caveat. */
  retainedAfter2x: number | null;
  retainedAfter5x: number | null;
  /** Per-token exit liquidity requires market depth history — null with caveat. */
  exitLiquidityKnown: boolean;
  receivedNotBoughtCount: number;
  stillHoldingAgedCount: number; // stillHolding with first buy older than STUCK_AGE
  tokenDiversity: number;
  /** Rug exposure requires token-outcome data (runner-mining Task 9) — null when absent. */
  rugExposurePct: number | null;
}

export interface HoldClassification {
  label: HoldBehaviorLabel;
  confidence: number; // 0..100
  componentMetrics: Partial<HoldMetrics>;
  exampleTokens: string[];
  caveats: string[];
}

export interface HoldClassifierResult {
  classifierVersion: number;
  dataQuality: BehaviorProfile['dataQuality'];
  metrics: HoldMetrics;
  labels: HoldClassification[]; // multi-label, strongest first
  /** Explicit: nothing here grants eligibility, votes, or promotion. */
  grantsEligibility: false;
}

export interface HoldClassifierExtras {
  /** Token outcome map from runner mining (address -> 'runner'|'rug'|'dead'|'flat'), when available. */
  tokenOutcomes?: Record<string, 'runner' | 'rug' | 'dead' | 'flat'>;
  now?: Date;
}

const MIN_SAMPLE = 3;
const STUCK_AGE_SEC = 7 * 86400;
const FULL_EXIT_RATIO = 0.95;

function pct(part: number, whole: number): number | null {
  return whole > 0 ? part / whole : null;
}
function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** pctHeldAfter H: among bought positions OBSERVABLE at horizon H (first buy
 *  at least H old, or exited within H), the share NOT fully exited within H.
 *  Positions younger than H with no full exit are excluded (unknowable), so
 *  a young wallet is never scored as a holder by default. */
function pctHeldAfter(positions: TokenPositionSummary[], horizonSec: number, nowMs: number): number | null {
  let observable = 0;
  let held = 0;
  for (const p of positions) {
    if (p.buyUsd <= 0 || p.firstBuyTs === null) continue;
    const firstBuyMs = Date.parse(p.firstBuyTs);
    const fullyExited = (p.exitRatio ?? 0) >= FULL_EXIT_RATIO;
    const exitedWithinH = fullyExited && p.holdDurationSec !== null && p.holdDurationSec <= horizonSec;
    const oldEnough = nowMs - firstBuyMs >= horizonSec * 1000;
    if (!oldEnough && !exitedWithinH) continue; // outcome at H not yet knowable
    observable += 1;
    if (!exitedWithinH) held += 1;
  }
  return observable > 0 ? held / observable : null;
}

export function computeHoldMetrics(profile: BehaviorProfile, extras: HoldClassifierExtras = {}): HoldMetrics {
  const now = extras.now ?? new Date(profile.computedAt);
  const nowMs = now.getTime();
  const positions = profile.local.tokenPositions;
  const bought = positions.filter((p) => p.buyUsd > 0);
  const withFirstSell = bought.filter((p) => p.timeToFirstSellSec !== null);
  const fullExitDurations = bought
    .filter((p) => (p.exitRatio ?? 0) >= FULL_EXIT_RATIO && p.holdDurationSec !== null)
    .map((p) => p.holdDurationSec as number);
  const within = (sec: number) => withFirstSell.filter((p) => (p.timeToFirstSellSec as number) <= sec).length;

  const outcomes = extras.tokenOutcomes;
  let rugExposurePct: number | null = null;
  if (outcomes) {
    const known = bought.filter((p) => outcomes[p.tokenAddress] !== undefined);
    if (known.length > 0) rugExposurePct = known.filter((p) => outcomes[p.tokenAddress] === 'rug').length / known.length;
  }

  return {
    sampleSize: bought.length,
    pctFirstSellWithin1m: pct(within(60), withFirstSell.length),
    pctFirstSellWithin5m: pct(within(300), withFirstSell.length),
    pctFirstSellWithin30m: pct(within(1800), withFirstSell.length),
    pctFirstSellWithin2h: pct(within(7200), withFirstSell.length),
    medianTimeToFirstSellSec: median(withFirstSell.map((p) => p.timeToFirstSellSec as number)),
    medianTimeToFullExitSec: median(fullExitDurations),
    pctHeldAfter1h: pctHeldAfter(positions, 3600, nowMs),
    pctHeldAfter6h: pctHeldAfter(positions, 6 * 3600, nowMs),
    pctHeldAfter24h: pctHeldAfter(positions, 24 * 3600, nowMs),
    pctHeldAfter72h: pctHeldAfter(positions, 72 * 3600, nowMs),
    partialExitCount: profile.local.partialExits.value ?? 0,
    fullExitCount: profile.local.fullExits.value ?? 0,
    medianRetainedPct: median(bought.filter((p) => p.exitRatio !== null).map((p) => Math.max(0, 1 - Math.min(p.exitRatio as number, 1)))),
    retainedAfter2x: null, // requires a price series — never fabricated
    retainedAfter5x: null,
    exitLiquidityKnown: false, // requires market-depth history — never fabricated
    receivedNotBoughtCount: positions.filter((p) => p.receivedNotBought).length,
    stillHoldingAgedCount: positions.filter(
      (p) => p.stillHolding && p.firstBuyTs !== null && nowMs - Date.parse(p.firstBuyTs) > STUCK_AGE_SEC * 1000
    ).length,
    tokenDiversity: positions.length,
    rugExposurePct
  };
}

const BASE_CAVEATS = [
  'exit ratios are USD proxies over locally observed trades (bounded polling) — the local view may be partial',
  'retention after 2x/5x and exit liquidity are unavailable without price/depth series — treated as unknown, not zero'
];

export function classifyHoldBehavior(profile: BehaviorProfile, extras: HoldClassifierExtras = {}): HoldClassifierResult {
  const metrics = computeHoldMetrics(profile, extras);
  const positions = profile.local.tokenPositions;
  const labels: HoldClassification[] = [];
  const example = (filter: (p: TokenPositionSummary) => boolean): string[] =>
    positions.filter(filter).slice(0, 5).map((p) => p.tokenAddress);

  // Dirty data first: irreconcilable provider/local conflict poisons classification.
  if (profile.conflicts.length >= 2) {
    labels.push({
      label: 'rejected_dirty_data',
      confidence: 70,
      componentMetrics: { sampleSize: metrics.sampleSize },
      exampleTokens: [],
      caveats: [...BASE_CAVEATS, `unresolved provider/local conflicts: ${profile.conflicts.map((c) => c.field).join(', ')}`]
    });
  }

  if (profile.dataQuality === 'insufficient' || (metrics.sampleSize === 0 && metrics.receivedNotBoughtCount === 0)) {
    labels.push({
      label: 'insufficient_history',
      confidence: 90,
      componentMetrics: { sampleSize: metrics.sampleSize, tokenDiversity: metrics.tokenDiversity },
      exampleTokens: [],
      caveats: BASE_CAVEATS
    });
    return { classifierVersion: HOLD_CLASSIFIER_VERSION, dataQuality: profile.dataQuality, metrics, labels, grantsEligibility: false };
  }

  // received_not_bought: the majority of activity is positions never bought.
  if (metrics.receivedNotBoughtCount > 0 && metrics.receivedNotBoughtCount >= Math.max(1, positions.length / 2)) {
    labels.push({
      label: 'received_not_bought',
      confidence: 80,
      componentMetrics: { receivedNotBoughtCount: metrics.receivedNotBoughtCount, sampleSize: metrics.sampleSize },
      exampleTokens: example((p) => p.receivedNotBought),
      caveats: [...BASE_CAVEATS, 'sells without a local buy — tokens arrived by transfer/airdrop; sell behavior says nothing about buying skill']
    });
  }

  if (metrics.sampleSize > 0 && metrics.sampleSize < MIN_SAMPLE) {
    const fastPct = metrics.pctFirstSellWithin30m ?? 0;
    labels.push({
      label: fastPct >= 0.5 ? 'fast_flipper' : 'promising_low_sample',
      confidence: 40, // low-sample labels are always low confidence
      componentMetrics: { sampleSize: metrics.sampleSize, pctFirstSellWithin30m: metrics.pctFirstSellWithin30m },
      exampleTokens: example((p) => p.buyUsd > 0),
      caveats: [...BASE_CAVEATS, `only ${metrics.sampleSize} bought position(s) — below the ${MIN_SAMPLE}-token confidence floor`]
    });
    return { classifierVersion: HOLD_CLASSIFIER_VERSION, dataQuality: profile.dataQuality, metrics, labels, grantsEligibility: false };
  }

  // fast_flipper: most first sells land within 30 minutes.
  if ((metrics.pctFirstSellWithin30m ?? 0) >= 0.6 && (metrics.medianTimeToFirstSellSec ?? Infinity) <= 1800) {
    labels.push({
      label: 'fast_flipper',
      confidence: Math.min(90, 50 + metrics.sampleSize * 5),
      componentMetrics: {
        pctFirstSellWithin1m: metrics.pctFirstSellWithin1m,
        pctFirstSellWithin5m: metrics.pctFirstSellWithin5m,
        pctFirstSellWithin30m: metrics.pctFirstSellWithin30m,
        medianTimeToFirstSellSec: metrics.medianTimeToFirstSellSec,
        sampleSize: metrics.sampleSize
      },
      exampleTokens: example((p) => (p.timeToFirstSellSec ?? Infinity) <= 1800),
      caveats: BASE_CAVEATS
    });
  }

  // durable_holder: half of observable positions still held after 24h and median hold >= 24h.
  if ((metrics.pctHeldAfter24h ?? 0) >= 0.5 && (profile.local.medianHoldSec.value ?? 0) >= 86400) {
    labels.push({
      label: 'durable_holder',
      confidence: Math.min(85, 45 + metrics.sampleSize * 5),
      componentMetrics: {
        pctHeldAfter24h: metrics.pctHeldAfter24h,
        pctHeldAfter72h: metrics.pctHeldAfter72h,
        medianRetainedPct: metrics.medianRetainedPct,
        sampleSize: metrics.sampleSize
      },
      exampleTokens: example((p) => p.stillHolding),
      caveats: [...BASE_CAVEATS, 'holding is not automatically good — residual value and liquidity are unknown at this layer']
    });
  }

  // selective_swing_trader: measured exits (2h..7d median first sell), mostly partial, diversified.
  const medFirstSell = metrics.medianTimeToFirstSellSec;
  if (
    medFirstSell !== null &&
    medFirstSell > 7200 &&
    medFirstSell < 7 * 86400 &&
    metrics.partialExitCount >= metrics.fullExitCount &&
    metrics.tokenDiversity >= 5
  ) {
    labels.push({
      label: 'selective_swing_trader',
      confidence: Math.min(80, 40 + metrics.sampleSize * 4),
      componentMetrics: {
        medianTimeToFirstSellSec: medFirstSell,
        partialExitCount: metrics.partialExitCount,
        fullExitCount: metrics.fullExitCount,
        tokenDiversity: metrics.tokenDiversity
      },
      exampleTokens: example((p) => (p.exitRatio ?? 0) > 0 && (p.exitRatio ?? 0) < FULL_EXIT_RATIO),
      caveats: BASE_CAVEATS
    });
  }

  // illiquid_stuck_holder: most bought positions still held past 7d with no sells at all.
  const agedNoSell = positions.filter(
    (p) => p.buyUsd > 0 && p.sellCount === 0 && p.firstBuyTs !== null &&
      (extras.now ?? new Date(profile.computedAt)).getTime() - Date.parse(p.firstBuyTs) > STUCK_AGE_SEC * 1000
  );
  if (metrics.sampleSize >= MIN_SAMPLE && agedNoSell.length / metrics.sampleSize >= 0.6) {
    labels.push({
      label: 'illiquid_stuck_holder',
      confidence: 60,
      componentMetrics: { stillHoldingAgedCount: metrics.stillHoldingAgedCount, sampleSize: metrics.sampleSize },
      exampleTokens: example((p) => p.sellCount === 0 && p.buyUsd > 0),
      caveats: [...BASE_CAVEATS, 'zero exits on aged positions — cannot distinguish conviction from inability to exit without liquidity data']
    });
  }

  // worthless_residue requires residual VALUE data — only when outcomes say the tokens died.
  if (extras.tokenOutcomes) {
    const deadHeld = positions.filter(
      (p) => p.stillHolding && (extras.tokenOutcomes![p.tokenAddress] === 'dead' || extras.tokenOutcomes![p.tokenAddress] === 'rug')
    );
    if (metrics.sampleSize >= MIN_SAMPLE && deadHeld.length / metrics.sampleSize >= 0.5) {
      labels.push({
        label: 'worthless_residue',
        confidence: 65,
        componentMetrics: { sampleSize: metrics.sampleSize, rugExposurePct: metrics.rugExposurePct },
        exampleTokens: deadHeld.slice(0, 5).map((p) => p.tokenAddress),
        caveats: [...BASE_CAVEATS, 'token outcomes from runner-mining series — residue valued at outcome label, not live price']
      });
    }
  }

  if (labels.length === 0) {
    labels.push({
      label: 'promising_low_sample',
      confidence: 30,
      componentMetrics: { sampleSize: metrics.sampleSize, medianTimeToFirstSellSec: metrics.medianTimeToFirstSellSec },
      exampleTokens: example((p) => p.buyUsd > 0),
      caveats: [...BASE_CAVEATS, 'no strong pattern matched — behavior is mixed or the window is too short; retained for observation only']
    });
  }

  labels.sort((a, b) => b.confidence - a.confidence);
  return { classifierVersion: HOLD_CLASSIFIER_VERSION, dataQuality: profile.dataQuality, metrics, labels, grantsEligibility: false };
}
