// FlowRadar — shadow stealth accumulation engine (Wave F, feat/pre-public-accumulation).
//
// PURPOSE. A pure, deterministic classifier over per-token, per-window cohort
// aggregates that names WHERE a token sits on the pre-public accumulation
// lifecycle: WATCHING → STEALTH_ACCUMULATION → EARLY_INDEPENDENT_CONFIRMATION
// → PUBLIC_KOL_ARRIVAL → CROWD_EXPANSION → DISTRIBUTION_RISK → INVALIDATED.
//
// HARD BOUNDARIES (why this module is deliberately self-contained):
//  1. SHADOW-ONLY. It never reads or writes FlowScore, signal thresholds, or
//     candidate-wallet promotion. It has its OWN config (DEFAULT_STEALTH_CONFIG)
//     so nothing here can perturb the scoring path. `shadowOnly: true` is
//     stamped on every result.
//  2. Only the `signal_eligible` cohort drives POSITIVE score. observation_only
//     wallets carry zero signal weight (unknown, not smart) and public_kol /
//     public_promoter (→ publicKol) / copytrader (→ crowd) are LATE-stage
//     cohorts. Public/crowd activity can only LOWER the stealth score (penalty)
//     or advance the lifecycle state — it can NEVER raise the score. This is the
//     load-bearing invariant, enforced structurally (no positive term reads a
//     non-eligible cohort) and covered by property tests.
//  3. No profitability/return claims — the surface is purely structural
//     (buyers, clusters, net USD flow, sell pressure).
//  4. Missing data is unknown, never fabricated: an absent window contributes
//     zero COUNTS (honest — we simply did not aggregate it), never positive
//     activity, and the engine only ever advances state on cohorts present.
//
// bot_or_service and excluded wallets are expected to be dropped by the caller
// before aggregation (operational noise); they have no cohort here.

// ---------------------------------------------------------------------------
// Windows & cohorts
// ---------------------------------------------------------------------------

export type StealthWindow = '5m' | '15m' | '30m' | '1h' | '4h' | '24h';

export const STEALTH_WINDOWS: readonly StealthWindow[] = ['5m', '15m', '30m', '1h', '4h', '24h'];

/** Short→long ordering used for persistence/acceleration reasoning. */
const WINDOW_ORDER: StealthWindow[] = ['5m', '15m', '30m', '1h', '4h', '24h'];

export type StealthCohort = 'eligible' | 'observation' | 'publicKol' | 'crowd';

/** One cohort's activity inside one window. All fields are structural counts/USD. */
export interface CohortFlow {
  distinctBuyers: number;
  distinctSellers: number;
  buyUsd: number;
  sellUsd: number;
  /** Wallets whose FIRST-EVER buy of this token falls in this window (fresh accumulation, not re-buys). */
  freshBuyers: number;
  /** Distinct entity/cluster ids among this cohort's buyers (independence proxy). */
  distinctClusters: number;
}

export interface StealthWindowInput {
  window: StealthWindow;
  eligible: CohortFlow;
  observation: CohortFlow;
  publicKol: CohortFlow;
  crowd: CohortFlow;
}

export interface StealthInput {
  tokenId: string;
  chain: 'SOLANA' | 'BSC';
  /** Any subset of STEALTH_WINDOWS the caller aggregated. Absent windows = zero counts. */
  windows: StealthWindowInput[];
  now: Date;
}

export type StealthState =
  | 'WATCHING'
  | 'STEALTH_ACCUMULATION'
  | 'EARLY_INDEPENDENT_CONFIRMATION'
  | 'PUBLIC_KOL_ARRIVAL'
  | 'CROWD_EXPANSION'
  | 'DISTRIBUTION_RISK'
  | 'INVALIDATED';

// ---------------------------------------------------------------------------
// Config (shadow-only; fully operator-overridable)
// ---------------------------------------------------------------------------

export interface StealthWeights {
  /** Positive drivers (eligible cohort only). Normalised against their own sum. */
  eligibleBreadth: number;
  freshAccumulation: number;
  independence: number;
  persistence: number;
  netInflow: number;
  /** Penalties (subtracted). Scale the public/crowd share of buyers. */
  publicPenalty: number;
  crowdPenalty: number;
}

export interface StealthThresholds {
  /** Distinct eligible buyers (24h) to qualify as STEALTH_ACCUMULATION. */
  minEligibleBuyersStealth: number;
  /** Independent eligible clusters (24h) to escalate to EARLY_INDEPENDENT_CONFIRMATION. */
  minIndependentClustersConfirm: number;
  /** Public-KOL distinct buyers (24h) that mark PUBLIC_KOL_ARRIVAL. */
  publicKolArrivalMinBuyers: number;
  /** Crowd (copytrader) distinct buyers (24h) that mark CROWD_EXPANSION. */
  crowdExpansionMinBuyers: number;
  /** Eligible sell/buy USD ratio (24h) at/above which the early cohort is distributing. */
  distributionSellToBuyRatio: number;
  /** Eligible net USD (24h) at/below which, WITH net selling, the thesis is INVALIDATED. */
  invalidatedNetUsdCeil: number;
  /** USD reference giving a full net-inflow score contribution. */
  netInflowRefUsd: number;
  /** Consecutive short windows used to normalise the persistence term. */
  persistenceWindowsRef: number;
}

export interface StealthConfig {
  weights: StealthWeights;
  thresholds: StealthThresholds;
}

export const DEFAULT_STEALTH_CONFIG: StealthConfig = {
  weights: {
    eligibleBreadth: 0.3,
    freshAccumulation: 0.2,
    independence: 0.25,
    persistence: 0.1,
    netInflow: 0.15,
    publicPenalty: 0.5,
    crowdPenalty: 0.5
  },
  thresholds: {
    minEligibleBuyersStealth: 3,
    minIndependentClustersConfirm: 3,
    publicKolArrivalMinBuyers: 2,
    crowdExpansionMinBuyers: 8,
    distributionSellToBuyRatio: 0.5,
    invalidatedNetUsdCeil: 0,
    netInflowRefUsd: 25000,
    persistenceWindowsRef: 5
  }
};

// Deep-freeze the exported default so it cannot become mutable global state:
// mutating it would silently change results for callers who pass no config,
// violating purity/determinism. Callers override by passing their own config.
Object.freeze(DEFAULT_STEALTH_CONFIG.weights);
Object.freeze(DEFAULT_STEALTH_CONFIG.thresholds);
Object.freeze(DEFAULT_STEALTH_CONFIG);

// ---------------------------------------------------------------------------
// Metrics (~24 structural fields; deterministic)
// ---------------------------------------------------------------------------

export interface StealthMetrics {
  eligibleBuyers24h: number;
  eligibleBuyers1h: number;
  eligibleBuyers15m: number;
  eligibleFreshBuyers24h: number;
  eligibleFreshBuyers1h: number;
  eligibleFreshShare24h: number;
  eligibleBuyUsd24h: number;
  eligibleSellUsd24h: number;
  eligibleNetUsd24h: number;
  eligibleNetUsd1h: number;
  eligibleSellToBuyRatio24h: number;
  independentEligibleClusters24h: number;
  independentEligibleClusters1h: number;
  publicKolBuyers24h: number;
  publicKolBuyers1h: number;
  publicKolNetUsd24h: number;
  /** Descriptive: public-KOL buyers as a share of ALL buyers (context only; NOT used for scoring). */
  publicKolShare24h: number;
  /** Penalty input: public-KOL buyers vs the eligible cohort ONLY — k/(k+eligible). Cannot be diluted by observation/crowd. */
  publicKolPressure: number;
  crowdBuyers24h: number;
  crowdNetUsd24h: number;
  /** Descriptive: crowd buyers as a share of ALL buyers (context only; NOT used for scoring). */
  crowdShare24h: number;
  /** Penalty input: crowd buyers vs the eligible cohort ONLY — c/(c+eligible). Cannot be diluted by observation/public. */
  crowdPressure: number;
  observationBuyers24h: number;
  totalDistinctBuyers24h: number;
  eligibleBuyerShare24h: number;
  accumulationAcceleration: number;
  persistenceWindows: number;
}

export interface StealthResult {
  tokenId: string;
  chain: 'SOLANA' | 'BSC';
  state: StealthState;
  /** 0..100 SHADOW-ONLY score. NOT a FlowScore and never fed into one. */
  stealthScore: number;
  metrics: StealthMetrics;
  reasons: string[];
  shadowOnly: true;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ZERO_FLOW: CohortFlow = {
  distinctBuyers: 0,
  distinctSellers: 0,
  buyUsd: 0,
  sellUsd: 0,
  freshBuyers: 0,
  distinctClusters: 0
};

// Monotonic non-decreasing clamp to [0,1] across ALL reals. Crucially maps
// +Infinity -> 1 (NOT 0): a penalty sum can overflow to Infinity under extreme
// weights, and mapping it to 0 would WIPE the penalty and could raise the score
// when a public/crowd buyer is added (the overflow point). Only NaN -> 0.
function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  if (x <= 0) return 0;
  return x >= 1 ? 1 : x; // Infinity >= 1 is true -> returns 1
}

function safeShare(part: number, total: number): number {
  return total > 0 ? clamp01(part / total) : 0;
}

// Penalty pressure = part/(part+other), computed WITHOUT ever forming the sum
// part+other (which can overflow to Infinity for astronomically large finite
// counts, collapsing pressure to 0 and breaking monotonicity). Scaling both by
// their max yields the algebraically identical value with no intermediate
// overflow, so pressure stays exactly part/(part+other) — monotonic in `part`.
// A physical ceiling on distinct-wallet counts per token per window. Distinct
// buyers are small integers; no token approaches this. Clamping to it is
// defensive input normalisation that ALSO buys exact monotonicity below (see
// pressureShare) — and beyond it, "more buyers" maps to the SAME value, which
// trivially cannot raise the score.
const MAX_COHORT_COUNT = 1e7;

function clampCount(x: number): number {
  if (!(x > 0)) return 0; // x <= 0 or NaN
  return x > MAX_COHORT_COUNT ? MAX_COHORT_COUNT : x;
}

// Penalty pressure = part/(part+other) with BOTH counts clamped to
// [0, MAX_COHORT_COUNT]. On that bounded domain the sum cannot overflow AND the
// IEEE-754 division is EXACTLY monotone non-decreasing in `part` (consecutive
// integer gaps are ≫ a ULP), so the reported score is monotone in public/crowd
// counts with no rounding tricks. Above the ceiling the value saturates
// (equal → non-increasing).
function pressureShare(part: number, other: number): number {
  const a = clampCount(part);
  if (a <= 0) return 0;
  const b = clampCount(other);
  if (b <= 0) return 1; // only the penalised cohort is present
  return a / (a + b);
}

// ---------------------------------------------------------------------------
// Metric computation
// ---------------------------------------------------------------------------

function computeMetrics(input: StealthInput): StealthMetrics {
  const byWindow = new Map<StealthWindow, StealthWindowInput>();
  for (const w of input.windows) byWindow.set(w.window, w);
  const cohort = (win: StealthWindow, c: StealthCohort): CohortFlow => byWindow.get(win)?.[c] ?? ZERO_FLOW;

  const e24 = cohort('24h', 'eligible');
  const e1h = cohort('1h', 'eligible');
  const e15 = cohort('15m', 'eligible');
  const k24 = cohort('24h', 'publicKol');
  const k1h = cohort('1h', 'publicKol');
  const c24 = cohort('24h', 'crowd');
  const o24 = cohort('24h', 'observation');

  const eligibleNetUsd24h = e24.buyUsd - e24.sellUsd;
  const totalDistinctBuyers24h =
    e24.distinctBuyers + o24.distinctBuyers + k24.distinctBuyers + c24.distinctBuyers;

  // Acceleration: eligible buyers-per-minute in the last hour vs the last 24h.
  // >1 means recent accumulation is faster than the daily baseline.
  // No 24h baseline => acceleration is UNKNOWN, reported as 0 (never a
  // fabricated "1 = same as baseline" when there is no baseline to compare to).
  const rate1h = e1h.distinctBuyers / 60;
  const rate24h = e24.distinctBuyers / 1440;
  const accumulationAcceleration = rate24h > 0 ? rate1h / rate24h : 0;

  // Persistence: because the windows are NESTED cumulative trailing spans
  // (5m ⊂ 15m ⊂ … ⊂ 24h), one burst shows up net-positive in ALL of them and
  // must NOT count as repeated evidence. Real persistence = accumulation kept
  // happening in the OUTER ring between adjacent windows, i.e. the longer
  // window's eligible net USD strictly exceeds the shorter's. A single burst
  // makes every window's net equal → all deltas 0 → persistence 0.
  let persistenceWindows = 0;
  for (let i = 0; i < WINDOW_ORDER.length - 1; i++) {
    const shortW = WINDOW_ORDER[i]!;
    const longW = WINDOW_ORDER[i + 1]!;
    if (!byWindow.has(shortW) || !byWindow.has(longW)) continue;
    const sNet = cohort(shortW, 'eligible').buyUsd - cohort(shortW, 'eligible').sellUsd;
    const lNet = cohort(longW, 'eligible').buyUsd - cohort(longW, 'eligible').sellUsd;
    if (lNet - sNet > 0) persistenceWindows += 1;
  }

  return {
    eligibleBuyers24h: e24.distinctBuyers,
    eligibleBuyers1h: e1h.distinctBuyers,
    eligibleBuyers15m: e15.distinctBuyers,
    eligibleFreshBuyers24h: e24.freshBuyers,
    eligibleFreshBuyers1h: e1h.freshBuyers,
    eligibleFreshShare24h: safeShare(e24.freshBuyers, e24.distinctBuyers),
    eligibleBuyUsd24h: e24.buyUsd,
    eligibleSellUsd24h: e24.sellUsd,
    eligibleNetUsd24h,
    eligibleNetUsd1h: e1h.buyUsd - e1h.sellUsd,
    eligibleSellToBuyRatio24h: e24.buyUsd > 0 ? e24.sellUsd / e24.buyUsd : e24.sellUsd > 0 ? Infinity : 0,
    independentEligibleClusters24h: e24.distinctClusters,
    independentEligibleClusters1h: e1h.distinctClusters,
    publicKolBuyers24h: k24.distinctBuyers,
    publicKolBuyers1h: k1h.distinctBuyers,
    publicKolNetUsd24h: k24.buyUsd - k24.sellUsd,
    publicKolShare24h: safeShare(k24.distinctBuyers, totalDistinctBuyers24h),
    publicKolPressure: pressureShare(k24.distinctBuyers, e24.distinctBuyers),
    crowdBuyers24h: c24.distinctBuyers,
    crowdNetUsd24h: c24.buyUsd - c24.sellUsd,
    crowdShare24h: safeShare(c24.distinctBuyers, totalDistinctBuyers24h),
    crowdPressure: pressureShare(c24.distinctBuyers, e24.distinctBuyers),
    observationBuyers24h: o24.distinctBuyers,
    totalDistinctBuyers24h,
    eligibleBuyerShare24h: safeShare(e24.distinctBuyers, totalDistinctBuyers24h),
    accumulationAcceleration,
    persistenceWindows
  };
}

// ---------------------------------------------------------------------------
// Scoring — POSITIVE terms read the eligible cohort ONLY; public/crowd only
// ever subtract. Structurally guarantees "non-eligible activity never raises
// the score."
// ---------------------------------------------------------------------------

function computeScore(m: StealthMetrics, cfg: StealthConfig): number {
  const { weights: w, thresholds: t } = cfg;

  // If there is no eligible accumulation at all, the score is exactly 0 — a
  // token driven purely by public/crowd/observation flow can never score.
  if (m.eligibleBuyers24h <= 0 || m.eligibleNetUsd24h <= 0) return 0;

  const positive =
    w.eligibleBreadth * clamp01(m.eligibleBuyers24h / t.minEligibleBuyersStealth) +
    w.freshAccumulation * clamp01(m.eligibleFreshShare24h) +
    w.independence * clamp01(m.independentEligibleClusters24h / t.minIndependentClustersConfirm) +
    w.persistence * clamp01(m.persistenceWindows / t.persistenceWindowsRef) +
    w.netInflow * clamp01(m.eligibleNetUsd24h / t.netInflowRefUsd);

  const positiveWeightSum =
    w.eligibleBreadth + w.freshAccumulation + w.independence + w.persistence + w.netInflow;
  const positiveNorm = positiveWeightSum > 0 ? positive / positiveWeightSum : 0;

  // Penalties scale public/crowd PRESSURE (each cohort vs the eligible cohort
  // only). Each pressure term is non-decreasing in its own cohort and wholly
  // independent of observation and the other penalised cohort — so adding
  // public, crowd, OR observation buyers can only lower the score, never raise
  // it (observation dilutes nothing because it is not in either denominator).
  //
  // Penalty weights are FLOORED at 0: a caller-supplied NEGATIVE penalty weight
  // would flip a penalty into a bonus and let public/crowd activity RAISE the
  // score — so a hostile/mistaken config can never breach the load-bearing
  // invariant. (Positive-driver weights are left as-is; they only read the
  // eligible cohort and so cannot break it whatever their sign.)
  const publicPenalty = w.publicPenalty > 0 ? w.publicPenalty : 0;
  const crowdPenalty = w.crowdPenalty > 0 ? w.crowdPenalty : 0;
  const penalty = publicPenalty * m.publicKolPressure + crowdPenalty * m.crowdPressure;

  const score = 100 * positiveNorm - 100 * clamp01(penalty);
  if (!Number.isFinite(score) || score <= 0) return 0;
  return score >= 100 ? 100 : Math.round(score * 100) / 100;
}

// ---------------------------------------------------------------------------
// State machine — deterministic; latest lifecycle stage wins.
// Precedence (high→low): INVALIDATED, DISTRIBUTION_RISK, CROWD_EXPANSION,
// PUBLIC_KOL_ARRIVAL, EARLY_INDEPENDENT_CONFIRMATION, STEALTH_ACCUMULATION,
// WATCHING.
// ---------------------------------------------------------------------------

function classify(m: StealthMetrics, cfg: StealthConfig, reasons: string[]): StealthState {
  const t = cfg.thresholds;
  const hadEligibleActivity = m.eligibleBuyUsd24h > 0 || m.eligibleSellUsd24h > 0;

  // INVALIDATED: the early cohort has flipped to net distribution.
  if (hadEligibleActivity && m.eligibleSellUsd24h > m.eligibleBuyUsd24h && m.eligibleNetUsd24h <= t.invalidatedNetUsdCeil) {
    reasons.push(`eligible cohort net-selling (buy $${m.eligibleBuyUsd24h} < sell $${m.eligibleSellUsd24h})`);
    return 'INVALIDATED';
  }

  // DISTRIBUTION_RISK: heavy early-cohort selling even if still net-positive.
  if (hadEligibleActivity && m.eligibleSellToBuyRatio24h >= t.distributionSellToBuyRatio) {
    reasons.push(`eligible sell/buy ratio ${m.eligibleSellToBuyRatio24h.toFixed(2)} ≥ ${t.distributionSellToBuyRatio}`);
    return 'DISTRIBUTION_RISK';
  }

  // CROWD_EXPANSION: copytrader breadth surge (latest non-risk stage).
  if (m.crowdBuyers24h >= t.crowdExpansionMinBuyers) {
    reasons.push(`crowd buyers ${m.crowdBuyers24h} ≥ ${t.crowdExpansionMinBuyers}`);
    return 'CROWD_EXPANSION';
  }

  // PUBLIC_KOL_ARRIVAL: public entry detected — the stealth window has closed.
  if (m.publicKolBuyers24h >= t.publicKolArrivalMinBuyers) {
    reasons.push(`public-KOL buyers ${m.publicKolBuyers24h} ≥ ${t.publicKolArrivalMinBuyers}`);
    return 'PUBLIC_KOL_ARRIVAL';
  }

  const isStealth = m.eligibleBuyers24h >= t.minEligibleBuyersStealth && m.eligibleNetUsd24h > 0;

  // EARLY_INDEPENDENT_CONFIRMATION: stealth AND enough independent clusters.
  if (isStealth && m.independentEligibleClusters24h >= t.minIndependentClustersConfirm) {
    reasons.push(
      `eligible ${m.eligibleBuyers24h} buyers across ${m.independentEligibleClusters24h} independent clusters, net +$${m.eligibleNetUsd24h}`
    );
    return 'EARLY_INDEPENDENT_CONFIRMATION';
  }

  // STEALTH_ACCUMULATION: eligible breadth + net inflow, no public/crowd yet.
  if (isStealth) {
    reasons.push(`eligible ${m.eligibleBuyers24h} buyers accumulating, net +$${m.eligibleNetUsd24h}, no public/crowd`);
    return 'STEALTH_ACCUMULATION';
  }

  reasons.push('no qualifying eligible accumulation');
  return 'WATCHING';
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function computeStealth(input: StealthInput, config: StealthConfig = DEFAULT_STEALTH_CONFIG): StealthResult {
  const metrics = computeMetrics(input);
  const reasons: string[] = [];
  const state = classify(metrics, config, reasons);
  const stealthScore = computeScore(metrics, config);
  return {
    tokenId: input.tokenId,
    chain: input.chain,
    state,
    stealthScore,
    metrics,
    reasons,
    shadowOnly: true
  };
}
