export const MIN_QUALIFYING_BUY_USD = 100;
export const CORE_CONFLUENCE_WINDOW_MS = 15 * 60_000;
export const MAX_PUSH_EVENT_AGE_MS = 10 * 60_000;
export const MIN_PUSH_CONFIDENCE = 0.65;
export const MIN_PUSH_ALERT_SCORE = 70;
export const MIN_ENTITY_INDEPENDENCE_CONFIDENCE = 0.7;
export const FRESH_LAUNCH_MAX_AGE_MS = 60 * 60_000;
export const EARLY_TOKEN_MAX_AGE_MS = 24 * 60 * 60_000;
export const ESTABLISHED_TOKEN_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
export const CORE_ALERT_POLICY_VERSION = 3;

export type CoreBuyRole = 'core' | 'related';
export type CoreSignalTier = 'WATCH' | 'STRONG_WATCH' | 'HIGH_CONVICTION';
export type CoreTokenLifecycle = 'fresh_launch' | 'early' | 'established' | 'stale_legacy' | 'unavailable';
export type CoreAlertRejectionReason =
  | 'solo_core_buy_no_confluence'
  | 'below_minimum_buy_threshold'
  | 'usd_value_unavailable'
  | 'insufficient_wallet_quality'
  | 'stale_event_not_push_eligible'
  | 'token_too_old_for_push'
  | 'token_age_unavailable'
  | 'insufficient_independent_confirmation'
  | 'confidence_below_push_threshold'
  | 'liquidity_unavailable_fail_closed'
  | 'critical_token_risk'
  | 'duplicate_signal_lifecycle'
  | 'same_entity_only_no_required_confirmation';

export interface CoreBuyCandidate {
  eventId: string;
  wallet: string;
  role: CoreBuyRole;
  ts: Date;
  amountUsd: number | null;
  amountToken?: number | null;
  entityKey?: string | null;
  entityLabel?: string | null;
  entityIdentityConfidence?: number | null;
  clusterKey?: string | null;
  evidenceScore?: number | null;
  historicalAlphaScore?: number | null;
  qualityQualified: boolean;
  relationshipRoute?: string | null;
  relationshipConfidence?: number | null;
  fundingSource?: string | null;
  dormantDays?: number | null;
}

export interface CoreBuyParticipant {
  wallet: string;
  role: CoreBuyRole;
  cumulativeBuyUsd: number;
  cumulativeTokenAmount: number | null;
  sourceEventIds: string[];
  firstBuyAt: Date;
  lastBuyAt: Date;
  entityKey: string | null;
  entityLabel: string | null;
  entityIdentityConfidence: number | null;
  clusterKey: string | null;
  evidenceScore: number | null;
  historicalAlphaScore: number | null;
  relationshipRoute: string | null;
  relationshipConfidence: number | null;
  fundingSource: string | null;
  dormantDays: number | null;
}

export interface CoreBuyAuditDecision {
  eventId: string;
  wallet: string;
  cumulativeWalletBuyUsd: number | null;
  eligibility: 'eligible_cluster_confluence' | 'eligible_for_future_confluence' | 'rejected';
  rejectionReason: CoreAlertRejectionReason | null;
}

export interface CoreConfluenceEvaluation {
  qualifies: boolean;
  triggerType: 'core_wallet_confluence' | 'same_entity_cluster_buy' | 'multi_entity_confluence' | 'funded_execution_buy' | null;
  tier: CoreSignalTier | null;
  participants: CoreBuyParticipant[];
  audits: CoreBuyAuditDecision[];
  rawWalletCount: number;
  qualifyingWalletCount: number;
  coreWalletCount: number;
  relatedWalletCount: number;
  entityCount: number;
  independentEntityCount: number;
  sameEntityWalletCount: number;
  effectiveConfirmationCount: number;
  entityConcentration: number;
  independenceConfidence: number;
  totalBuyUsd: number;
  combinedBuyUsd: number;
  combinedTokenAmount: number | null;
  windowMs: number;
  windowStart: Date | null;
  windowEnd: Date | null;
  confidence: number;
  dormantWakeUpCount: number;
  fundingPathCount: number;
  sourceEventIds: string[];
}

export function evaluateCoreBuyWindow(
  candidates: readonly CoreBuyCandidate[],
  tokenRisk: { criticalRisk: boolean; qualityPassed: boolean | null } = { criticalRisk: false, qualityPassed: null }
): CoreConfluenceEvaluation {
  const ordered = [...candidates].sort((left, right) => left.ts.getTime() - right.ts.getTime() || left.eventId.localeCompare(right.eventId));
  const byWallet = new Map<string, CoreBuyCandidate[]>();
  for (const candidate of ordered) {
    const bucket = byWallet.get(candidate.wallet) ?? [];
    bucket.push(candidate);
    byWallet.set(candidate.wallet, bucket);
  }

  const participants: CoreBuyParticipant[] = [];
  const cumulativeByWallet = new Map<string, number | null>();
  for (const [wallet, events] of byWallet) {
    const known = events.filter((event) => event.amountUsd !== null && Number.isFinite(event.amountUsd) && event.amountUsd >= 0);
    const cumulativeBuyUsd = known.reduce((sum, event) => sum + event.amountUsd!, 0);
    cumulativeByWallet.set(wallet, known.length ? cumulativeBuyUsd : null);
    const representative = [...events].sort((left, right) => qualityScore(right) - qualityScore(left))[0]!;
    if (!representative.qualityQualified || cumulativeBuyUsd < MIN_QUALIFYING_BUY_USD) continue;
    const tokenAmounts = known.map((event) => event.amountToken).filter((value): value is number => value !== null && value !== undefined && Number.isFinite(value));
    participants.push({
      wallet, role: representative.role, cumulativeBuyUsd,
      cumulativeTokenAmount: tokenAmounts.length ? tokenAmounts.reduce((sum, value) => sum + value, 0) : null,
      sourceEventIds: events.map((event) => event.eventId).sort(),
      firstBuyAt: events[0]!.ts, lastBuyAt: events.at(-1)!.ts,
      entityKey: representative.entityKey ?? null, entityLabel: representative.entityLabel ?? null,
      entityIdentityConfidence: finiteOrNull(representative.entityIdentityConfidence),
      clusterKey: representative.clusterKey ?? null,
      evidenceScore: finiteOrNull(representative.evidenceScore), historicalAlphaScore: finiteOrNull(representative.historicalAlphaScore),
      relationshipRoute: representative.relationshipRoute ?? null,
      relationshipConfidence: finiteOrNull(representative.relationshipConfidence), fundingSource: representative.fundingSource ?? null,
      dormantDays: finiteOrNull(representative.dormantDays)
    });
  }
  participants.sort((left, right) => right.cumulativeBuyUsd - left.cumulativeBuyUsd || left.wallet.localeCompare(right.wallet));

  const entityGroups = new Map<string, CoreBuyParticipant[]>();
  for (const participant of participants) {
    const key = participant.entityKey ? `entity:${participant.entityKey}` : participant.clusterKey ? `cluster:${participant.clusterKey}` : null;
    if (!key) continue;
    const bucket = entityGroups.get(key) ?? [];
    bucket.push(participant);
    entityGroups.set(key, bucket);
  }
  // Alert receipts intentionally define "raw" at the eligibility boundary:
  // dust/unpriced wallets are still present in per-event audits, but they must
  // not inflate any signal-level wallet/entity count.
  const rawWalletCount = participants.length;
  const qualifyingWalletCount = participants.length;
  const coreWalletCount = participants.filter((participant) => participant.role === 'core').length;
  const relatedWalletCount = participants.filter((participant) => participant.role === 'related').length;
  const independentGroups = [...entityGroups.values()].filter((members) => Math.max(...members.map((member) => member.entityIdentityConfidence ?? 0)) >= MIN_ENTITY_INDEPENDENCE_CONFIDENCE);
  const independentEntityCount = independentGroups.length;
  const sameEntityWalletCount = Math.max(0, ...[...entityGroups.values()].map((members) => members.length));
  const fundingPathCount = participants.filter((participant) => participant.role === 'related'
    && Boolean(participant.fundingSource)
    && ['direct_transfer', 'exact_bridge'].includes(participant.relationshipRoute ?? '')
    && (participant.relationshipConfidence ?? 0) >= 0.5).length;
  const dormantWakeUpCount = participants.filter((participant) => (participant.dormantDays ?? 0) > 0).length;
  const strongProfile = participants.some((participant) => Math.max(participant.evidenceScore ?? 0, participant.historicalAlphaScore ?? 0) >= 70);

  const triggerType = tokenRisk.criticalRisk || qualifyingWalletCount < 2 ? null
    : independentEntityCount >= 2 ? 'multi_entity_confluence'
      : coreWalletCount >= 2 ? 'core_wallet_confluence'
        : sameEntityWalletCount >= 2 && strongProfile && (fundingPathCount >= 2 || dormantWakeUpCount > 0) ? 'same_entity_cluster_buy'
          : fundingPathCount >= 1 && (fundingPathCount >= 2 || coreWalletCount >= 1) ? 'funded_execution_buy'
            : null;
  const qualifies = triggerType !== null;
  const tier: CoreSignalTier | null = !qualifies ? null
    : tokenRisk.qualityPassed === true && independentEntityCount >= 2 && strongProfile && (dormantWakeUpCount > 0 || fundingPathCount > 0)
      ? 'HIGH_CONVICTION'
      : strongProfile && (coreWalletCount >= 2 || independentEntityCount >= 2 || (fundingPathCount > 0 && rawWalletCount >= 2))
        ? 'STRONG_WATCH' : 'WATCH';
  const effectiveConfirmationCount = independentEntityCount >= 2 ? independentEntityCount : qualifyingWalletCount > 0 ? 1 : 0;
  const combinedBuyUsd = participants.reduce((sum, participant) => sum + participant.cumulativeBuyUsd, 0);
  const totalBuyUsd = [...cumulativeByWallet.values()].reduce<number>((sum, value) => sum + (value ?? 0), 0);
  const entityConcentration = qualifyingWalletCount ? sameEntityWalletCount / qualifyingWalletCount : 0;
  const independentlyResolvedWallets = independentGroups.flat().length;
  const averageIndependentConfidence = independentGroups.length
    ? independentGroups.reduce((sum, members) => sum + Math.max(...members.map((member) => member.entityIdentityConfidence ?? 0)), 0) / independentGroups.length
    : 0;
  const independenceConfidence = qualifyingWalletCount
    ? averageIndependentConfidence * (independentlyResolvedWallets / qualifyingWalletCount)
    : 0;
  const tokenAmounts = participants.map((participant) => participant.cumulativeTokenAmount).filter((value): value is number => value !== null);
  const sourceEventIds = [...new Set(participants.flatMap((participant) => participant.sourceEventIds))].sort();
  const windowStart = ordered[0]?.ts ?? null;
  const windowEnd = ordered.at(-1)?.ts ?? null;
  const confidence = qualifies ? Math.min(0.99, 0.45
    + Math.min(0.12, qualifyingWalletCount * 0.04)
    + Math.min(0.2, independentEntityCount * 0.1)
    + Math.min(0.08, coreWalletCount * 0.04)
    + Math.min(0.08, fundingPathCount * 0.08)
    + (strongProfile ? 0.07 : 0)
    + (tokenRisk.qualityPassed === true ? 0.04 : 0)
    + Math.min(0.05, independenceConfidence * 0.05)) : 0;

  const audits: CoreBuyAuditDecision[] = ordered.map((candidate) => {
    const cumulative = cumulativeByWallet.get(candidate.wallet) ?? null;
    if (candidate.amountUsd === null || !Number.isFinite(candidate.amountUsd)) return audit(candidate, cumulative, 'rejected', 'usd_value_unavailable');
    if (!candidate.qualityQualified) return audit(candidate, cumulative, 'rejected', 'insufficient_wallet_quality');
    if (cumulative === null || cumulative < MIN_QUALIFYING_BUY_USD) return audit(candidate, cumulative, 'rejected', 'below_minimum_buy_threshold');
    if (tokenRisk.criticalRisk) return audit(candidate, cumulative, 'rejected', 'critical_token_risk');
    return qualifies
      ? audit(candidate, cumulative, 'eligible_cluster_confluence', null)
      : audit(candidate, cumulative, 'eligible_for_future_confluence', qualifyingWalletCount === 1
        ? 'solo_core_buy_no_confluence'
        : sameEntityWalletCount >= 2 && independentEntityCount < 2
          ? 'same_entity_only_no_required_confirmation'
          : 'insufficient_independent_confirmation');
  });

  return {
    qualifies, triggerType, tier, participants, audits,
    rawWalletCount, qualifyingWalletCount, coreWalletCount, relatedWalletCount, entityCount: entityGroups.size,
    independentEntityCount, sameEntityWalletCount, effectiveConfirmationCount,
    entityConcentration, independenceConfidence, totalBuyUsd,
    combinedBuyUsd, combinedTokenAmount: tokenAmounts.length ? tokenAmounts.reduce((sum, value) => sum + value, 0) : null,
    windowMs: windowStart && windowEnd ? windowEnd.getTime() - windowStart.getTime() : 0,
    windowStart, windowEnd, confidence, dormantWakeUpCount, fundingPathCount, sourceEventIds
  };
}

export interface CorePushContext {
  evaluatedAt: Date;
  tokenAgeSec: number | null;
  liquidityUsd: number | null;
  liquidityAvailable: boolean;
  holderCount: number | null;
  holdersAvailable: boolean;
  marketCapUsd: number | null;
  tokenQualityPassed: boolean | null;
  tokenQualityScore: number | null;
  criticalTokenRisk: boolean;
  infrastructureContamination?: boolean;
}

export interface AlertScoreContribution {
  feature: string;
  value: number | string | boolean | null;
  weight: number;
  contribution: number;
  explanation: string;
}

export interface CorePushDecision {
  pushEligible: boolean;
  eligibilityResult: 'REJECTED' | 'INBOX_ONLY' | CoreSignalTier;
  rejectionReason: CoreAlertRejectionReason | null;
  acceptedReason: string | null;
  alertScore: number;
  contributions: AlertScoreContribution[];
  tokenLifecycle: CoreTokenLifecycle;
  eventAgeMs: number | null;
  signalTier: CoreSignalTier | null;
}

export function classifyCoreTokenLifecycle(tokenAgeSec: number | null): CoreTokenLifecycle {
  if (tokenAgeSec === null || !Number.isFinite(tokenAgeSec) || tokenAgeSec < 0) return 'unavailable';
  const ageMs = tokenAgeSec * 1_000;
  if (ageMs <= FRESH_LAUNCH_MAX_AGE_MS) return 'fresh_launch';
  if (ageMs <= EARLY_TOKEN_MAX_AGE_MS) return 'early';
  if (ageMs <= ESTABLISHED_TOKEN_MAX_AGE_MS) return 'established';
  return 'stale_legacy';
}

export function evaluateCorePushEligibility(evaluation: CoreConfluenceEvaluation, context: CorePushContext): CorePushDecision {
  const tokenLifecycle = classifyCoreTokenLifecycle(context.tokenAgeSec);
  const eventAgeMs = evaluation.windowEnd ? Math.max(0, context.evaluatedAt.getTime() - evaluation.windowEnd.getTime()) : null;
  const contributions = scoreContributions(evaluation, context, tokenLifecycle);
  const alertScore = Math.max(0, Math.min(100, round(contributions.reduce((sum, item) => sum + item.contribution, 0))));
  const rejected = (reason: CoreAlertRejectionReason): CorePushDecision => ({
    pushEligible: false, eligibilityResult: 'REJECTED', rejectionReason: reason, acceptedReason: null,
    alertScore, contributions, tokenLifecycle, eventAgeMs, signalTier: null
  });
  const inbox = (reason: CoreAlertRejectionReason): CorePushDecision => ({
    pushEligible: false, eligibilityResult: 'INBOX_ONLY', rejectionReason: reason, acceptedReason: null,
    alertScore, contributions, tokenLifecycle, eventAgeMs, signalTier: null
  });

  if (context.criticalTokenRisk) return rejected('critical_token_risk');
  if (evaluation.qualifyingWalletCount < 2) {
    if (evaluation.qualifyingWalletCount === 1) return rejected('solo_core_buy_no_confluence');
    if (evaluation.audits.some((audit) => audit.rejectionReason === 'usd_value_unavailable')) return rejected('usd_value_unavailable');
    if (evaluation.audits.some((audit) => audit.rejectionReason === 'below_minimum_buy_threshold')) return rejected('below_minimum_buy_threshold');
    return rejected('insufficient_independent_confirmation');
  }
  if (!evaluation.qualifies || !evaluation.triggerType) {
    if (evaluation.sameEntityWalletCount >= 2 && evaluation.independentEntityCount < 2) return rejected('same_entity_only_no_required_confirmation');
    return rejected('insufficient_independent_confirmation');
  }
  if (eventAgeMs === null || eventAgeMs > MAX_PUSH_EVENT_AGE_MS) return rejected('stale_event_not_push_eligible');
  if (tokenLifecycle === 'unavailable') return inbox('token_age_unavailable');
  if (tokenLifecycle === 'stale_legacy') return rejected('token_too_old_for_push');
  if (!context.liquidityAvailable || context.liquidityUsd === null) return inbox('liquidity_unavailable_fail_closed');
  if (evaluation.confidence < MIN_PUSH_CONFIDENCE) return inbox('confidence_below_push_threshold');
  if (alertScore < MIN_PUSH_ALERT_SCORE) return inbox('confidence_below_push_threshold');
  if (tokenLifecycle === 'established' && !(
    evaluation.independentEntityCount >= 2 && evaluation.confidence >= 0.8 && alertScore >= 82 && context.tokenQualityPassed === true
  )) return rejected('token_too_old_for_push');

  const signalTier: CoreSignalTier = alertScore >= 90 ? 'HIGH_CONVICTION' : alertScore >= 82 ? 'STRONG_WATCH' : 'WATCH';
  const acceptedReason = evaluation.triggerType === 'multi_entity_confluence'
    ? `${evaluation.independentEntityCount} independent quality entities confirmed the entry.`
    : evaluation.triggerType === 'core_wallet_confluence'
      ? `${evaluation.coreWalletCount} qualifying Core wallets entered the same token.`
      : evaluation.triggerType === 'same_entity_cluster_buy'
        ? `${evaluation.sameEntityWalletCount} same-entity wallets repeated a supported coordinated pattern.`
        : 'A qualified funding-to-execution path received an additional confirmation.';
  return {
    pushEligible: true, eligibilityResult: signalTier, rejectionReason: null, acceptedReason,
    alertScore, contributions, tokenLifecycle, eventAgeMs, signalTier
  };
}

export function validateCorePushPayload(payload: Record<string, unknown>, now = new Date()): CoreAlertRejectionReason | null {
  const policy = record(payload.policy);
  if (number(policy.version) !== CORE_ALERT_POLICY_VERSION || payload.pushEligible !== true) return 'duplicate_signal_lifecycle';
  if ((number(payload.qualifyingWalletCount) ?? 0) < 2) return 'solo_core_buy_no_confluence';
  if (!['core_wallet_confluence', 'same_entity_cluster_buy', 'multi_entity_confluence', 'funded_execution_buy'].includes(String(payload.triggerType ?? ''))) {
    return 'insufficient_independent_confirmation';
  }
  const windowEnd = typeof payload.windowEnd === 'string' ? new Date(payload.windowEnd) : null;
  if (!windowEnd || Number.isNaN(windowEnd.getTime()) || now.getTime() - windowEnd.getTime() > MAX_PUSH_EVENT_AGE_MS) return 'stale_event_not_push_eligible';
  if (payload.tokenLifecycle === 'stale_legacy') return 'token_too_old_for_push';
  if (!['fresh_launch', 'early', 'established'].includes(String(payload.tokenLifecycle ?? ''))) return 'token_age_unavailable';
  const liquidityUsd = number(payload.liquidityUsd);
  if (payload.liquidityAvailable !== true || liquidityUsd === null) return 'liquidity_unavailable_fail_closed';
  if (liquidityUsd === 0 || payload.criticalRisk === true) return 'critical_token_risk';
  if ((number(payload.confidence) ?? 0) < MIN_PUSH_CONFIDENCE || (number(payload.alertScore) ?? 0) < MIN_PUSH_ALERT_SCORE) return 'confidence_below_push_threshold';
  if (payload.tokenLifecycle === 'established' && !(
    (number(payload.independentEntityCount) ?? 0) >= 2 && (number(payload.confidence) ?? 0) >= 0.8
      && (number(payload.alertScore) ?? 0) >= 82 && payload.tokenQualityPassed === true
  )) return 'token_too_old_for_push';
  return null;
}

function scoreContributions(evaluation: CoreConfluenceEvaluation, context: CorePushContext, lifecycle: CoreTokenLifecycle): AlertScoreContribution[] {
  const quality = Math.max(0, ...evaluation.participants.flatMap((participant) => [participant.evidenceScore ?? 0, participant.historicalAlphaScore ?? 0]));
  const add = (feature: string, value: AlertScoreContribution['value'], weight: number, contribution: number, explanation: string): AlertScoreContribution => ({ feature, value, weight, contribution: round(contribution), explanation });
  const lifecycleContribution = lifecycle === 'fresh_launch' ? 8 : lifecycle === 'early' ? 6 : lifecycle === 'established' ? 2 : lifecycle === 'stale_legacy' ? -10 : 0;
  return [
    add('qualifying_wallet_count', evaluation.qualifyingWalletCount, 25, Math.min(25, evaluation.qualifyingWalletCount * 12.5), 'Only wallets with at least $100 cumulative buy count.'),
    add('independent_entity_count', evaluation.independentEntityCount, 22, Math.min(22, evaluation.independentEntityCount * 11), 'Identity-confidence-gated independent entities.'),
    add('core_wallet_count', evaluation.coreWalletCount, 12, Math.min(12, evaluation.coreWalletCount * 6), 'Operator-selected Core participation.'),
    add('entity_quality', quality, 16, quality / 100 * 16, 'Maximum existing Evidence/Historical Alpha score.'),
    add('dormant_wake_up', evaluation.dormantWakeUpCount, 8, Math.min(8, evaluation.dormantWakeUpCount * 4), 'Recent dormant participant activation.'),
    add('funding_path', evaluation.fundingPathCount, 8, Math.min(8, evaluation.fundingPathCount * 6), 'Direct or exact-bridge Core funding path.'),
    add('combined_buy_size', evaluation.combinedBuyUsd, 8, Math.min(8, Math.log10(Math.max(1, evaluation.combinedBuyUsd / 100) + 1) * 8), 'Qualifying USD buys only.'),
    add('token_lifecycle', lifecycle, 8, lifecycleContribution, 'Uses the existing 1h/24h/7d novelty calibration.'),
    add('token_quality', context.tokenQualityScore, 8, context.tokenQualityPassed === true ? 8 : Math.max(0, (context.tokenQualityScore ?? 0) / 100 * 4), 'Existing token-quality assessment; no new risk score.'),
    add('liquidity_coverage', context.liquidityAvailable, 4, context.liquidityAvailable ? 4 : 0, 'Unavailable liquidity is never converted to zero.'),
    add('holder_coverage', context.holdersAvailable, 2, context.holdersAvailable ? 2 : 0, 'Unavailable holders are never converted to zero.'),
    add('confluence_confidence', evaluation.confidence, 10, evaluation.confidence * 10, 'Deterministic confluence confidence.'),
    add('infrastructure_contamination', Boolean(context.infrastructureContamination), -15, context.infrastructureContamination ? -15 : 0, 'Router/CEX-only correlation is penalized and cannot establish independence.')
  ];
}

function audit(
  candidate: CoreBuyCandidate,
  cumulativeWalletBuyUsd: number | null,
  eligibility: CoreBuyAuditDecision['eligibility'],
  rejectionReason: CoreBuyAuditDecision['rejectionReason']
): CoreBuyAuditDecision {
  return { eventId: candidate.eventId, wallet: candidate.wallet, cumulativeWalletBuyUsd, eligibility, rejectionReason };
}

function qualityScore(candidate: CoreBuyCandidate) {
  return Math.max(candidate.evidenceScore ?? 0, candidate.historicalAlphaScore ?? 0, (candidate.relationshipConfidence ?? 0) * 100);
}

function finiteOrNull(value: number | null | undefined) { return value !== null && value !== undefined && Number.isFinite(value) ? value : null; }
function round(value: number) { return Math.round(value * 100) / 100; }
function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function number(value: unknown) { const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN; return Number.isFinite(parsed) ? parsed : null; }
