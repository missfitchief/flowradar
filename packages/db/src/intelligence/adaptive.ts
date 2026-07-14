import type { MonitoringPriority } from '@prisma/client';

export const ADAPTIVE_RULE_VERSION = 1;
export const ADAPTIVE_MODEL_VERSION = 1;
export const ENTITY_DECAY_POLICY_VERSION = 1;
export const OUTCOME_EVALUATOR_VERSION = 1;

export const ADAPTIVE_WEIGHTS = Object.freeze({
  entityConfluence: 24,
  independentCapital: 12,
  dormantAwakening: 12,
  fundingExecution: 12,
  historicalAlpha: 16,
  evidenceQuality: 10,
  coreParticipation: 8,
  freshness: 6
});

export const ADAPTIVE_THRESHOLDS = Object.freeze({
  observation: 0,
  watch: 50,
  strongWatch: 70,
  highConviction: 85,
  exceptional: 94,
  buyCandidateSignal: 70,
  buyCandidateQuality: 78,
  minimumIndependentEvidenceTypes: 2,
  minimumFeedbackSample: 30
});

const CORE_ROLES = new Set([
  'root_main', 'operator_root', 'funding_wallet', 'execution_wallet',
  'profit_collector', 'profit_collection_wallet', 'deployer', 'lp_wallet'
]);
const INFRASTRUCTURE_PATTERN = /service|router|exchange|cex|bridge_contract|program|contract|pool|vault/i;

export type MembershipStatus = 'confirmed' | 'strong' | 'probable' | 'possible' | 'stale' | 'rejected';
export type MembershipScope = 'core' | 'peripheral' | 'infrastructure';

export interface MembershipProjectionInput {
  role: string;
  evidenceScore: number;
  confidence: number;
  independentSignalCount: number;
  evidenceTypes: string[];
  contradictions?: string[];
  daysSinceEvidence?: number;
  registryCategory?: string | null;
}

export interface MembershipProjection {
  status: MembershipStatus;
  scope: MembershipScope;
  identityConfidence: number;
  currentRelevance: number;
  evidenceFreshness: number;
  evidenceTypes: string[];
  reasonCodes: string[];
}

/** Fail-closed wallet-to-entity classification. One signal can never produce
 * a confirmed/strong membership, and known infrastructure is always rejected. */
export function projectEntityMembership(input: MembershipProjectionInput): MembershipProjection {
  const evidenceTypes = independentEvidenceTypes(input.evidenceTypes);
  const days = Math.max(0, input.daysSinceEvidence ?? 0);
  const infrastructure = INFRASTRUCTURE_PATTERN.test(`${input.role} ${input.registryCategory ?? ''}`);
  const evidenceFreshness = round(clamp01(Math.pow(0.5, days / 90)));
  const contradictionPenalty = Math.min(0.35, (input.contradictions?.length ?? 0) * 0.07);
  const identityConfidence = round(clamp01(normalize01(input.confidence) * 0.5 + clamp01(input.evidenceScore / 100) * 0.5 - contradictionPenalty));
  const currentRelevance = round(clamp01(evidenceFreshness * 0.55 + identityConfidence * 0.25 + Math.min(1, input.independentSignalCount / 4) * 0.2));
  if (infrastructure) {
    return { status: 'rejected', scope: 'infrastructure', identityConfidence: 0, currentRelevance: 0, evidenceFreshness, evidenceTypes, reasonCodes: ['known_infrastructure_fail_closed'] };
  }
  const independent = evidenceTypes.length;
  let status: MembershipStatus;
  if (days >= 365 && independent < 2) status = 'stale';
  else if (independent >= 3 && identityConfidence >= 0.82) status = 'confirmed';
  else if (independent >= 2 && identityConfidence >= 0.68) status = 'strong';
  else if (independent >= 2 && identityConfidence >= 0.48) status = 'probable';
  else status = 'possible';
  const scope: MembershipScope = CORE_ROLES.has(input.role) && independent >= 2 && status !== 'possible' && status !== 'stale'
    ? 'core'
    : 'peripheral';
  return {
    status,
    scope,
    identityConfidence,
    currentRelevance,
    evidenceFreshness,
    evidenceTypes,
    reasonCodes: [
      `independent_evidence_types_${independent}`,
      `membership_${status}`,
      `scope_${scope}`,
      ...(contradictionPenalty ? ['contradiction_penalty_applied'] : [])
    ]
  };
}

function independentEvidenceTypes(values: string[]) {
  return [...new Set(values.map((value) => {
    const normalized = value.toLowerCase();
    if (/direct|funding/.test(normalized)) return 'direct_funding';
    if (/multi.?hop/.test(normalized)) return 'multi_hop_funding';
    if (/funder/.test(normalized)) return 'shared_funder';
    if (/deployer/.test(normalized)) return 'shared_deployer';
    if (/\blp\b|liquidity/.test(normalized)) return 'shared_lp';
    if (/bridge/.test(normalized)) return 'exact_bridge';
    if (/timing/.test(normalized)) return 'timing_correlation';
    if (/repeat/.test(normalized)) return 'repeated_behavior';
    if (/execution|behavior/.test(normalized)) return 'execution_pattern';
    return normalized.replace(/[^a-z0-9]+/g, '_');
  }).filter(Boolean))].sort();
}

export interface HistoricalOutcomeInput {
  returnPct: number | null;
  peakReturnPct?: number | null;
  drawdownPct?: number | null;
  realized?: boolean;
  rugPull?: boolean;
  entryPercentile?: number | null;
  capitalUsd?: number | null;
}

export interface CalibratedAlpha {
  score: number;
  sampleConfidence: number;
  intervalLow: number;
  intervalHigh: number;
  sampleSize: number;
  medianReturnPct: number | null;
  hitRate: number | null;
  rugRate: number | null;
  consistency: number;
  components: Record<string, number | null>;
}

/** Robust historical-alpha calibration: returns are winsorized, the median is
 * preferred over the mean, and a Bayesian prior dominates small samples. */
export function calibrateHistoricalAlpha(outcomes: HistoricalOutcomeInput[]): CalibratedAlpha {
  const usable = outcomes.filter((row) => row.returnPct !== null && Number.isFinite(row.returnPct));
  const returns = usable.map((row) => clamp(row.returnPct!, -100, 2_000)).sort((a, b) => a - b);
  const n = returns.length;
  if (!n) return { score: 35, sampleConfidence: 0, intervalLow: 10, intervalHigh: 70, sampleSize: 0, medianReturnPct: null, hitRate: null, rugRate: null, consistency: 0, components: { bayesianReturn: null, hitRate: null, entryQuality: null, drawdownQuality: null, capitalQuality: null } };
  const median = percentile(returns, 0.5);
  const wins = usable.filter((row) => row.returnPct! >= 50).length;
  const rugs = usable.filter((row) => row.rugPull || row.returnPct! <= -90).length;
  const priorN = 8;
  const bayesianMedian = (median * n + 15 * priorN) / (n + priorN);
  const hitRate = (wins + 2) / (n + 6);
  const rugRate = (rugs + 1) / (n + 12);
  const entryValues = usable.map((row) => row.entryPercentile).filter(finiteNumber);
  const entryQuality = entryValues.length ? 1 - average(entryValues.map((value) => clamp01(value))) : 0.45;
  const drawdowns = usable.map((row) => row.drawdownPct).filter(finiteNumber).map((value) => Math.abs(value));
  const drawdownQuality = drawdowns.length ? clamp01(1 - percentile(drawdowns.sort((a, b) => a - b), 0.5) / 100) : 0.45;
  const capital = usable.map((row) => row.capitalUsd).filter(finiteNumber);
  const capitalQuality = capital.length ? clamp01(Math.log10(1 + percentile(capital.sort((a, b) => a - b), 0.5)) / 6) : 0.35;
  const dispersion = Math.abs(percentile(returns, 0.75) - percentile(returns, 0.25));
  const consistency = clamp01(1 - dispersion / Math.max(100, Math.abs(median) + 100));
  const returnComponent = clamp01((Math.log1p(Math.max(-99, bayesianMedian) + 100) - Math.log(100)) / Math.log(11) + 0.25);
  const raw = 100 * (
    returnComponent * 0.32 + hitRate * 0.24 + (1 - rugRate) * 0.14 +
    entryQuality * 0.1 + drawdownQuality * 0.08 + consistency * 0.08 + capitalQuality * 0.04
  );
  const sampleConfidence = round(clamp01(1 - Math.exp(-n / 18)));
  const score = round(raw * sampleConfidence + 35 * (1 - sampleConfidence), 1);
  const uncertainty = 35 * (1 - sampleConfidence) + 8 / Math.sqrt(n);
  return {
    score,
    sampleConfidence,
    intervalLow: round(clamp(score - uncertainty, 0, 100), 1),
    intervalHigh: round(clamp(score + uncertainty, 0, 100), 1),
    sampleSize: n,
    medianReturnPct: round(median, 2),
    hitRate: round(hitRate, 4),
    rugRate: round(rugRate, 4),
    consistency: round(consistency, 4),
    components: {
      bayesianReturn: round(bayesianMedian, 2), hitRate: round(hitRate, 4), entryQuality: round(entryQuality, 4),
      drawdownQuality: round(drawdownQuality, 4), capitalQuality: round(capitalQuality, 4)
    }
  };
}

export interface DecayProjectionInput {
  identityConfidence: number;
  currentRelevance: number;
  historicalAlphaScore: number;
  wakeUpPotential: number;
  lastEvidenceAt: Date;
  lastCoreActivityAt: Date | null;
  now: Date;
}

export function computeEntityDecay(input: DecayProjectionInput) {
  const evidenceDays = daysBetween(input.lastEvidenceAt, input.now);
  const activityDays = input.lastCoreActivityAt ? daysBetween(input.lastCoreActivityAt, input.now) : evidenceDays;
  const evidenceFreshness = round(Math.pow(0.5, evidenceDays / 90));
  // Identity evidence decays slowly and bottoms at 70% of its prior value;
  // current relevance is intentionally much more time-sensitive.
  const identityConfidence = round(input.identityConfidence * (0.7 + 0.3 * Math.pow(0.5, evidenceDays / 365)));
  const currentRelevance = round(input.currentRelevance * Math.pow(0.5, activityDays / 45));
  return {
    identityConfidence, currentRelevance, evidenceFreshness,
    historicalAlphaScore: input.historicalAlphaScore,
    wakeUpPotential: input.wakeUpPotential,
    dormantDays: Math.floor(activityDays),
    halfLives: { identityDays: 365, relevanceDays: 45, freshnessDays: 90 },
    reasonCodes: [activityDays >= 30 ? 'entity_core_dormant' : 'entity_core_active', 'alpha_and_wakeup_not_decayed']
  };
}

export interface ActivationParticipant {
  profileId: string;
  entityId: string | null;
  clusterKey: string;
  capitalRootKey: string;
  scope: MembershipScope;
  historicalAlphaScore: number;
  evidenceScore: number;
  identityConfidence: number;
  evidenceFreshness: number;
  dormantAwakened: boolean;
  fundingExecution: boolean;
}

export interface ActivationScore {
  score: number;
  lifecycleStage: 'OBSERVATION' | 'WATCH' | 'STRONG_WATCH' | 'HIGH_CONVICTION' | 'EXCEPTIONAL';
  independentEntityCount: number;
  independentCapitalRootCount: number;
  coreWalletCount: number;
  peripheralWalletCount: number;
  decomposition: Record<string, { raw: number; weight: number; contribution: number; explanation: string }>;
}

/** Entity-level activation scoring. Multiple wallets belonging to one entity
 * contribute behavioral evidence but count as one independent confirmation. */
export function scoreAdaptiveActivation(participants: ActivationParticipant[]): ActivationScore {
  const eligible = participants.filter((row) => row.scope !== 'infrastructure');
  const independentEntities = new Set(eligible.map((row) => row.entityId ?? `cluster:${row.clusterKey}`));
  const walletsByEntity = new Map<string, number>();
  for (const row of eligible) {
    const key = row.entityId ?? `cluster:${row.clusterKey}`;
    walletsByEntity.set(key, (walletsByEntity.get(key) ?? 0) + 1);
  }
  const sameEntityMultiWallet = [...walletsByEntity.values()].some((count) => count >= 2);
  const roots = new Set(eligible.map((row) => row.capitalRootKey).filter(Boolean));
  const core = eligible.filter((row) => row.scope === 'core');
  const peripheral = eligible.filter((row) => row.scope === 'peripheral');
  const weighted = eligible.map((row) => ({ row, weight: row.scope === 'core' ? 1 : 0.35 }));
  const weightedAverage = (pick: (row: ActivationParticipant) => number) => {
    const totalWeight = weighted.reduce((sum, row) => sum + row.weight, 0);
    return totalWeight ? weighted.reduce((sum, item) => sum + pick(item.row) * item.weight, 0) / totalWeight : 0;
  };
  const raw = {
    // Multiple wallets controlled by one entity are useful behavioral
    // confirmation, but can never equal a second independent entity.
    entityConfluence: Math.max(clamp01(independentEntities.size - 1), sameEntityMultiWallet ? 0.35 : 0),
    independentCapital: clamp01(roots.size - 1),
    dormantAwakening: clamp01(eligible.filter((row) => row.dormantAwakened).length / 2),
    fundingExecution: clamp01(eligible.filter((row) => row.fundingExecution).length / 2),
    historicalAlpha: clamp01(weightedAverage((row) => row.historicalAlphaScore) / 100),
    evidenceQuality: clamp01(weightedAverage((row) => row.evidenceScore * row.identityConfidence) / 100),
    coreParticipation: clamp01(core.length / Math.max(1, eligible.length)),
    freshness: clamp01(weightedAverage((row) => row.evidenceFreshness))
  };
  const descriptions: Record<keyof typeof raw, string> = {
    entityConfluence: `${independentEntities.size} independently inferred entities${sameEntityMultiWallet ? '; multi-wallet entity activation' : ''}`,
    independentCapital: `${roots.size} independent capital roots`,
    dormantAwakening: `${eligible.filter((row) => row.dormantAwakened).length} core/member awakenings`,
    fundingExecution: `${eligible.filter((row) => row.fundingExecution).length} funding-to-execution sequences`,
    historicalAlpha: 'Bayesian/sample-size-adjusted participant history',
    evidenceQuality: 'membership evidence and identity confidence',
    coreParticipation: `${core.length} core and ${peripheral.length} peripheral wallets`,
    freshness: 'time-decayed evidence freshness'
  };
  const decomposition = Object.fromEntries(Object.entries(raw).map(([key, value]) => {
    const weight = ADAPTIVE_WEIGHTS[key as keyof typeof ADAPTIVE_WEIGHTS];
    return [key, { raw: round(value, 4), weight, contribution: round(value * weight, 2), explanation: descriptions[key as keyof typeof raw] }];
  })) as ActivationScore['decomposition'];
  const score = round(Object.values(decomposition).reduce((sum, row) => sum + row.contribution, 0), 1);
  return {
    score,
    lifecycleStage: lifecycleStageForScore(score),
    independentEntityCount: independentEntities.size,
    independentCapitalRootCount: roots.size,
    coreWalletCount: core.length,
    peripheralWalletCount: peripheral.length,
    decomposition
  };
}

export function lifecycleStageForScore(score: number): ActivationScore['lifecycleStage'] {
  if (score >= ADAPTIVE_THRESHOLDS.exceptional) return 'EXCEPTIONAL';
  if (score >= ADAPTIVE_THRESHOLDS.highConviction) return 'HIGH_CONVICTION';
  if (score >= ADAPTIVE_THRESHOLDS.strongWatch) return 'STRONG_WATCH';
  if (score >= ADAPTIVE_THRESHOLDS.watch) return 'WATCH';
  return 'OBSERVATION';
}

export function membershipPriority(scope: MembershipScope, status: MembershipStatus, alpha: number, wake: number): MonitoringPriority {
  if (scope === 'infrastructure' || status === 'rejected') return 'weak_cold';
  if (scope === 'core' && (status === 'confirmed' || status === 'strong')) return 'root_permanent';
  if (alpha >= 70 || wake >= 70) return 'strong_link';
  if (status === 'probable' || status === 'strong') return 'probable_link';
  return 'weak_cold';
}

export interface DeterministicOutcomeMetrics {
  maxReturnPct: number | null;
  realizedReturnPct: number | null;
  maxDrawdownPct: number | null;
  rugPullDetected: boolean;
  tradingHalted: boolean;
  liquidityRetentionPct: number | null;
  coverage: string;
}

export function deterministicOutcomeLabel(input: DeterministicOutcomeMetrics) {
  if (input.coverage !== 'full' || input.maxReturnPct === null) return 'insufficient_data';
  if (input.rugPullDetected) return 'rug_pull';
  if (input.tradingHalted) return 'invalidated';
  if ((input.realizedReturnPct ?? input.maxReturnPct) <= -70 || (input.maxDrawdownPct ?? 0) <= -85) return 'severe_failure';
  if ((input.realizedReturnPct ?? input.maxReturnPct) < -20) return 'failed';
  if (input.maxReturnPct >= 300 && (input.liquidityRetentionPct ?? 100) >= 40) return 'exceptional';
  if (input.maxReturnPct >= 100) return 'strong';
  if (input.maxReturnPct >= 35) return 'moderate';
  return 'neutral';
}

function daysBetween(from: Date, to: Date) { return Math.max(0, (to.getTime() - from.getTime()) / 86_400_000); }
function percentile(sorted: number[], q: number) { const index = (sorted.length - 1) * q; const lo = Math.floor(index); const hi = Math.ceil(index); return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (index - lo); }
function normalize01(value: number) { return clamp01(value > 1 ? value / 100 : value); }
function clamp01(value: number) { return clamp(value, 0, 1); }
function clamp(value: number, min: number, max: number) { return Math.max(min, Math.min(max, value)); }
function average(values: number[]) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }
function finiteNumber(value: number | null | undefined): value is number { return typeof value === 'number' && Number.isFinite(value); }
function round(value: number, digits = 4) { const scale = 10 ** digits; return Math.round(value * scale) / scale; }
