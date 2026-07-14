export const MIN_QUALIFYING_BUY_USD = 100;
export const CORE_CONFLUENCE_WINDOW_MS = 15 * 60_000;
export const CORE_ALERT_POLICY_VERSION = 2;

export type CoreBuyRole = 'core' | 'related';
export type CoreSignalTier = 'WATCH' | 'STRONG_WATCH' | 'HIGH_CONVICTION';

export interface CoreBuyCandidate {
  eventId: string;
  wallet: string;
  role: CoreBuyRole;
  ts: Date;
  amountUsd: number | null;
  amountToken?: number | null;
  entityKey?: string | null;
  entityLabel?: string | null;
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
  rejectionReason: 'below_minimum_buy_threshold' | 'usd_value_unavailable' | 'insufficient_wallet_quality' | 'solo_core_buy_no_confluence' | 'critical_token_risk' | null;
}

export interface CoreConfluenceEvaluation {
  qualifies: boolean;
  triggerType: 'core_wallet_confluence' | 'same_entity_cluster_buy' | 'multi_entity_confluence' | 'funded_execution_buy' | null;
  tier: CoreSignalTier | null;
  participants: CoreBuyParticipant[];
  audits: CoreBuyAuditDecision[];
  rawWalletCount: number;
  coreWalletCount: number;
  relatedWalletCount: number;
  entityCount: number;
  independentEntityCount: number;
  sameEntityWalletCount: number;
  effectiveConfirmationCount: number;
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
  const rawWalletCount = participants.length;
  const coreWalletCount = participants.filter((participant) => participant.role === 'core').length;
  const relatedWalletCount = participants.filter((participant) => participant.role === 'related').length;
  const independentEntityCount = entityGroups.size;
  const sameEntityWalletCount = Math.max(0, ...[...entityGroups.values()].map((members) => members.length));
  const fundingPathCount = participants.filter((participant) => participant.role === 'related'
    && Boolean(participant.fundingSource)
    && ['direct_transfer', 'exact_bridge'].includes(participant.relationshipRoute ?? '')
    && (participant.relationshipConfidence ?? 0) >= 0.5).length;
  const dormantWakeUpCount = participants.filter((participant) => (participant.dormantDays ?? 0) > 0).length;

  const triggerType = tokenRisk.criticalRisk ? null
    : independentEntityCount >= 2 ? 'multi_entity_confluence'
      : sameEntityWalletCount >= 2 ? 'same_entity_cluster_buy'
        : coreWalletCount >= 2 ? 'core_wallet_confluence'
          : fundingPathCount >= 1 ? 'funded_execution_buy'
            : null;
  const qualifies = triggerType !== null;
  const strongProfile = participants.some((participant) => Math.max(participant.evidenceScore ?? 0, participant.historicalAlphaScore ?? 0) >= 70);
  const tier: CoreSignalTier | null = !qualifies ? null
    : tokenRisk.qualityPassed === true && independentEntityCount >= 2 && strongProfile && (dormantWakeUpCount > 0 || fundingPathCount > 0)
      ? 'HIGH_CONVICTION'
      : strongProfile && (coreWalletCount >= 2 || independentEntityCount >= 2 || (fundingPathCount > 0 && rawWalletCount >= 2))
        ? 'STRONG_WATCH' : 'WATCH';
  const effectiveConfirmationCount = independentEntityCount >= 2 ? independentEntityCount
    : sameEntityWalletCount >= 2 ? 1
      : fundingPathCount > 0 ? 2
        : coreWalletCount >= 2 ? coreWalletCount : rawWalletCount;
  const combinedBuyUsd = participants.reduce((sum, participant) => sum + participant.cumulativeBuyUsd, 0);
  const tokenAmounts = participants.map((participant) => participant.cumulativeTokenAmount).filter((value): value is number => value !== null);
  const sourceEventIds = [...new Set(participants.flatMap((participant) => participant.sourceEventIds))].sort();
  const windowStart = ordered[0]?.ts ?? null;
  const windowEnd = ordered.at(-1)?.ts ?? null;
  const confidence = qualifies ? Math.min(0.99, 0.5
    + Math.min(0.2, independentEntityCount * 0.1)
    + Math.min(0.12, coreWalletCount * 0.04)
    + Math.min(0.08, fundingPathCount * 0.08)
    + (strongProfile ? 0.07 : 0)
    + (tokenRisk.qualityPassed === true ? 0.02 : 0)) : 0;

  const audits: CoreBuyAuditDecision[] = ordered.map((candidate) => {
    const cumulative = cumulativeByWallet.get(candidate.wallet) ?? null;
    if (candidate.amountUsd === null || !Number.isFinite(candidate.amountUsd)) return audit(candidate, cumulative, 'rejected', 'usd_value_unavailable');
    if (!candidate.qualityQualified) return audit(candidate, cumulative, 'rejected', 'insufficient_wallet_quality');
    if (cumulative === null || cumulative < MIN_QUALIFYING_BUY_USD) return audit(candidate, cumulative, 'rejected', 'below_minimum_buy_threshold');
    if (tokenRisk.criticalRisk) return audit(candidate, cumulative, 'rejected', 'critical_token_risk');
    return qualifies
      ? audit(candidate, cumulative, 'eligible_cluster_confluence', null)
      : audit(candidate, cumulative, 'eligible_for_future_confluence', 'solo_core_buy_no_confluence');
  });

  return {
    qualifies, triggerType, tier, participants, audits,
    rawWalletCount, coreWalletCount, relatedWalletCount, entityCount: entityGroups.size,
    independentEntityCount, sameEntityWalletCount, effectiveConfirmationCount,
    combinedBuyUsd, combinedTokenAmount: tokenAmounts.length ? tokenAmounts.reduce((sum, value) => sum + value, 0) : null,
    windowMs: windowStart && windowEnd ? windowEnd.getTime() - windowStart.getTime() : 0,
    windowStart, windowEnd, confidence, dormantWakeUpCount, fundingPathCount, sourceEventIds
  };
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
