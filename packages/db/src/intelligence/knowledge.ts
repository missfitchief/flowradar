import { createHash } from 'node:crypto';
import { Prisma, type ChainId, type MonitoringPriority, type PrismaClient } from '@prisma/client';
import type { InvestigationMember, WalletInvestigationResult } from '../investigation/types';
import { normalizeAddress } from '../discovery/unified';
import { enrollObservationWallet, monitoringTierForRole } from './monitoring';
import { syncIntelligenceEntities } from './entities';

export const INTELLIGENCE_KNOWLEDGE_ENGINE_VERSION = 1;

export interface InvestigationKnowledgeReport {
  investigationId: string;
  qualifiedWallets: number;
  profilesCreated: number;
  profilesUpdated: number;
  observationsAppended: number;
  clustersCreated: number;
  clustersMerged: number;
  monitoringEnrolled: number;
}

type QualifiedMember = InvestigationMember & { intelligence: NonNullable<InvestigationMember['intelligence']> };

/**
 * Materializes one completed Wallet Investigation into permanent knowledge.
 * Current profile rows are projections; every conclusion change is preserved
 * first in the append-only observation tables.
 */
export async function persistInvestigationKnowledge(
  prisma: PrismaClient,
  investigation: WalletInvestigationResult,
  options: { now?: Date } = {}
): Promise<InvestigationKnowledgeReport> {
  const now = options.now ?? (investigation.completedAt ? new Date(investigation.completedAt) : new Date());
  const source = `wallet_investigation:${investigation.id}`;
  const qualified = investigation.members
    .filter((member): member is QualifiedMember => Boolean(member.intelligence) && qualifies(member))
    .map((member) => ({ ...member, address: normalizeAddress(member.chain, member.address) }));
  const report: InvestigationKnowledgeReport = {
    investigationId: investigation.id,
    qualifiedWallets: qualified.length,
    profilesCreated: 0,
    profilesUpdated: 0,
    observationsAppended: 0,
    clustersCreated: 0,
    clustersMerged: 0,
    monitoringEnrolled: 0
  };
  if (!qualified.length) return report;
  const touchedProfileIds: string[] = [];

  const walletByRef = new Map<string, Awaited<ReturnType<typeof enrollObservationWallet>>['wallet']>();
  for (const member of qualified) {
    const reason = reasonAdded(member);
    const enrollment = await enrollObservationWallet(prisma, {
      chain: member.chain,
      address: member.address,
      role: member.role,
      reason,
      firstSeenAt: new Date(member.firstLinkedAt),
      lastActiveAt: new Date(member.lastLinkedAt),
      now
    });
    walletByRef.set(refKey(member.chain, member.address), enrollment.wallet);
    report.monitoringEnrolled += 1;
  }

  const existingProfiles = await loadProfiles(prisma, qualified);
  const existingByRef = new Map(existingProfiles.map((profile) => [refKey(profile.chain, profile.address), profile]));
  const entityKeys = unique(qualified.map((member) => safeEntityKey(member)).filter(nonNull));
  const entityClusters = entityKeys.length
    ? await prisma.intelligenceCluster.findMany({ where: { entityKey: { in: entityKeys }, status: 'active' }, include: { mergedInto: true }, orderBy: { firstDiscoveredAt: 'asc' } })
    : [];
  const clustersByEntity = new Map(entityClusters.map((cluster) => [cluster.entityKey!, cluster]));

  const groups = new Map<string, QualifiedMember[]>();
  for (const member of qualified) {
    const existing = existingByRef.get(refKey(member.chain, member.address));
    const entityKey = safeEntityKey(member);
    const groupKey = entityKey ? `entity:${entityKey}` : existing ? `cluster:${existing.clusterId}` : `wallet:${member.chain}:${member.address}`;
    groups.set(groupKey, [...(groups.get(groupKey) ?? []), member]);
  }

  for (const [groupKey, members] of groups) {
    const entityKey = groupKey.startsWith('entity:') ? groupKey.slice('entity:'.length) : null;
    const candidateClusters = uniqueBy(
      [
        ...(entityKey && clustersByEntity.has(entityKey) ? [clustersByEntity.get(entityKey)!] : []),
        ...members.map((member) => existingByRef.get(refKey(member.chain, member.address))?.cluster).filter(nonNull)
      ].map(resolveMergedCluster),
      (cluster) => cluster.id
    ).sort((a, b) => a.firstDiscoveredAt.getTime() - b.firstDiscoveredAt.getTime() || a.clusterKey.localeCompare(b.clusterKey));

    let cluster = candidateClusters[0] ?? null;
    if (!cluster) {
      const clusterKey = stableClusterKey(groupKey);
      cluster = await prisma.intelligenceCluster.upsert({
        where: { clusterKey },
        create: {
          clusterKey,
          entityKey,
          confidence: average(members.map(observedConfidence)),
          walletCount: 0,
          firstDiscoveredAt: now,
          lastEvidenceAt: now,
          evidenceJson: json({ source, investigationId: investigation.id, groupKey })
        },
        update: { lastEvidenceAt: now, ...(entityKey ? { entityKey } : {}) }
      });
      report.clustersCreated += 1;
    }

    // An overlap may merge persistent clusters only when this investigation
    // supplies a multi-signal, non-infrastructure entity conclusion.
    if (entityKey && candidateClusters.length > 1) {
      for (const losing of candidateClusters.slice(1)) {
        if (losing.id === cluster.id) continue;
        const mergeKey = hash(`cluster-merge|${losing.id}|${cluster.id}|${investigation.id}|${now.toISOString()}`);
        await prisma.$transaction([
          prisma.walletIntelligenceProfile.updateMany({ where: { clusterId: losing.id }, data: { clusterId: cluster.id } }),
          prisma.intelligenceCluster.update({ where: { id: losing.id }, data: { status: 'merged', mergedIntoId: cluster.id, lastEvidenceAt: now } }),
          prisma.intelligenceClusterMerge.upsert({
            where: { mergeKey },
            create: {
              mergeKey,
              fromClusterId: losing.id,
              intoClusterId: cluster.id,
              investigationId: investigation.id,
              confidence: Math.min(cluster.confidence, losing.confidence),
              reason: 'multi_signal_entity_overlap',
              evidenceJson: json({ entityKey, source, memberRefs: members.map((member) => refKey(member.chain, member.address)) }),
              mergedAt: now
            },
            update: {}
          })
        ]);
        report.clustersMerged += 1;
      }
    }

    for (const member of members) {
      const ref = refKey(member.chain, member.address);
      const wallet = walletByRef.get(ref)!;
      const existing = existingByRef.get(ref);
      const observationKey = hash(`wallet-observation|${investigation.id}|${investigation.completedAt ?? now.toISOString()}|${ref}|${member.intelligence.scoreVersion}`);
      if (await prisma.walletIntelligenceObservation.findUnique({ where: { observationKey }, select: { id: true } })) continue;

      const evidenceHash = hash(JSON.stringify({
        signals: member.intelligence.evidenceSignals.map((signal) => [signal.code, signal.receiptCount]),
        contradictions: member.intelligence.contradictions,
        entityKey: safeEntityKey(member),
        role: member.role
      }));
      const nextConfidence = evolveConfidence(existing, member, evidenceHash);
      const memberAlpha = normalizedMemberAlpha(member);
      const priority = monitoringPriority(member);
      const evidenceSignals = member.intelligence.evidenceSignals.map((signal) => signal.code);
      const reason = reasonAdded(member);
      const activityAt = latestDate(wallet.lastActiveAt, new Date(member.lastLinkedAt));
      const profileData = {
        clusterId: cluster.id,
        entityKey: safeEntityKey(member),
        role: preferredRole(existing?.role, member.role),
        evidenceScore: rollingScore(existing?.evidenceScore, member.intelligence.evidenceScore),
        sourceScore: maxOptional(existing?.sourceScore, memberAlpha.sourceScore),
        rawHistoricalAlphaScore: rollingScore(existing?.rawHistoricalAlphaScore, memberAlpha.rawScore),
        sampleAdjustedAlphaScore: rollingScore(existing?.sampleAdjustedAlphaScore, memberAlpha.sampleAdjustedScore),
        alphaConfidence: Math.max(existing?.alphaConfidence ?? 0, memberAlpha.confidence),
        alphaSampleSize: Math.max(existing?.alphaSampleSize ?? 0, memberAlpha.sampleSize),
        alphaCalibrationJson: json(memberAlpha.calibration),
        historicalAlphaScore: rollingScore(existing?.historicalAlphaScore, memberAlpha.sampleAdjustedScore),
        // A previously valuable dormant wallet is never devalued merely because
        // it woke up; the awakening is captured separately by the lifecycle.
        wakeUpPotential: Math.max(existing?.wakeUpPotential ?? 0, member.intelligence.wakeUpPotential),
        intelligenceStatus: memberAlpha.status,
        confidence: nextConfidence,
        tier: betterTier(existing?.tier, member.intelligence.tier),
        lastDiscoverySource: source,
        lastObservedAt: now,
        lastActivityAt: activityAt,
        monitoringPriority: priority,
        reasonAdded: reason,
        observationCount: (existing?.observationCount ?? 0) + 1,
        independentSignals: member.intelligence.independentSignalCount,
        evidenceSignals,
        supportingEvidenceJson: json({
          whyImportant: member.intelligence.whyImportant,
          evidenceSignals: member.intelligence.evidenceSignals,
          metrics: member.intelligence.metrics,
          deploymentTokenAddresses: unique(investigation.deployments.filter((row) => row.chain === member.chain && normalizeAddress(row.chain, row.buyerAddress) === member.address).map((row) => row.tokenAddress)),
          alphaCalibration: memberAlpha.calibration,
          sourceScoreExcludedFromIdentityAndSignals: true,
          investigationId: investigation.id
        }),
        contradictingEvidenceJson: json({ contradictions: member.intelligence.contradictions }),
        scoreVersion: member.intelligence.scoreVersion
      } satisfies Prisma.WalletIntelligenceProfileUncheckedUpdateInput;

      const profile = existing
        ? await prisma.walletIntelligenceProfile.update({ where: { id: existing.id }, data: profileData })
        : await prisma.walletIntelligenceProfile.create({
          data: {
            walletId: wallet.id,
            chain: member.chain,
            address: member.address,
            clusterId: cluster.id,
            entityKey: safeEntityKey(member),
            role: member.role,
            evidenceScore: member.intelligence.evidenceScore,
            sourceScore: memberAlpha.sourceScore,
            rawHistoricalAlphaScore: memberAlpha.rawScore,
            sampleAdjustedAlphaScore: memberAlpha.sampleAdjustedScore,
            alphaConfidence: memberAlpha.confidence,
            alphaSampleSize: memberAlpha.sampleSize,
            alphaCalibrationJson: json(memberAlpha.calibration),
            historicalAlphaScore: memberAlpha.sampleAdjustedScore,
            wakeUpPotential: member.intelligence.wakeUpPotential,
            intelligenceStatus: memberAlpha.status,
            confidence: nextConfidence,
            tier: member.intelligence.tier,
            discoverySource: source,
            lastDiscoverySource: source,
            firstDiscoveredAt: now,
            lastObservedAt: now,
            lastActivityAt: activityAt,
            monitoringPriority: priority,
            reasonAdded: reason,
            observationCount: 1,
            independentSignals: member.intelligence.independentSignalCount,
            evidenceSignals,
            supportingEvidenceJson: profileData.supportingEvidenceJson,
            contradictingEvidenceJson: profileData.contradictingEvidenceJson,
            scoreVersion: member.intelligence.scoreVersion
          }
        });
      existing ? report.profilesUpdated += 1 : report.profilesCreated += 1;
      touchedProfileIds.push(profile.id);
      existingByRef.set(ref, { ...profile, cluster } as typeof existingProfiles[number]);

      await prisma.walletIntelligenceObservation.create({
        data: {
          observationKey,
          profileId: profile.id,
          investigationId: investigation.id,
          discoverySource: source,
          entityKey: safeEntityKey(member),
          role: member.role,
          evidenceScore: member.intelligence.evidenceScore,
          sourceScore: memberAlpha.sourceScore,
          rawHistoricalAlphaScore: memberAlpha.rawScore,
          sampleAdjustedAlphaScore: memberAlpha.sampleAdjustedScore,
          alphaConfidence: memberAlpha.confidence,
          alphaSampleSize: memberAlpha.sampleSize,
          alphaCalibrationJson: json(memberAlpha.calibration),
          historicalAlphaScore: memberAlpha.sampleAdjustedScore,
          wakeUpPotential: member.intelligence.wakeUpPotential,
          intelligenceStatus: memberAlpha.status,
          confidence: nextConfidence,
          previousConfidence: existing?.confidence ?? null,
          confidenceDelta: nextConfidence - (existing?.confidence ?? nextConfidence),
          tier: member.intelligence.tier,
          independentSignals: member.intelligence.independentSignalCount,
          evidenceSignals,
          supportingEvidenceJson: profileData.supportingEvidenceJson,
          contradictingEvidenceJson: profileData.contradictingEvidenceJson,
          reasonJson: json({ whyImportant: member.intelligence.whyImportant, reasonAdded: reason }),
          evidenceHash,
          scoreVersion: member.intelligence.scoreVersion,
          observedAt: now
        }
      });
      report.observationsAppended += 1;
    }

    const clusterProfiles = await prisma.walletIntelligenceProfile.findMany({ where: { clusterId: cluster.id }, select: { confidence: true } });
    const clusterConfidence = average(clusterProfiles.map((profile) => profile.confidence));
    const observationKey = hash(`cluster-observation|${cluster.id}|${investigation.id}|${investigation.completedAt ?? now.toISOString()}`);
    await prisma.intelligenceClusterObservation.upsert({
      where: { observationKey },
      create: {
        observationKey,
        clusterId: cluster.id,
        investigationId: investigation.id,
        confidence: clusterConfidence,
        walletCount: clusterProfiles.length,
        supportingEvidenceJson: json({ source, entityKey, members: members.map((member) => refKey(member.chain, member.address)) }),
        contradictingEvidenceJson: json({ contradictions: members.flatMap((member) => member.intelligence.contradictions) }),
        observedAt: now
      },
      update: {}
    });
    await prisma.intelligenceCluster.update({
      where: { id: cluster.id },
      data: {
        entityKey: entityKey ?? cluster.entityKey,
        confidence: clusterConfidence,
        walletCount: clusterProfiles.length,
        lastEvidenceAt: now,
        evidenceJson: json({ latestInvestigationId: investigation.id, source, observationKey })
      }
    });
  }

  await syncIntelligenceEntities(prisma, { profileIds: unique(touchedProfileIds), now, cause: source });
  return report;
}

function qualifies(member: InvestigationMember): member is QualifiedMember {
  const intel = member.intelligence;
  if (!intel || intel.clusterConclusion === 'infrastructure' || intel.trackingPriority === 'exclude') return false;
  if (member.role === 'root_main' || member.role === 'operator_root') return true;
  if (intel.tier === 'S' || intel.tier === 'A' || intel.tier === 'B') return true;
  if (intel.independentSignalCount >= 2 && intel.evidenceScore >= 40) return true;
  if (intel.historicalAlphaScore >= 45 || intel.wakeUpPotential >= 45) return true;
  return (intel.metrics.maxCoveredDormantDays ?? 0) >= 30 && intel.historicalAlphaScore >= 20;
}

function safeEntityKey(member: QualifiedMember) {
  return member.entityKey && member.intelligence.independentSignalCount >= 2 && ['supported', 'probable'].includes(member.intelligence.clusterConclusion)
    ? member.entityKey
    : null;
}

function observedConfidence(member: QualifiedMember) {
  const contradictionPenalty = Math.min(0.25, member.intelligence.contradictions.length * 0.04);
  return clamp01(member.intelligence.evidenceScore / 100 * 0.62 + normalizeConfidence(member.relationshipConfidence) * 0.38 - contradictionPenalty);
}

function evolveConfidence(
  existing: { confidence: number; entityKey: string | null; evidenceSignals: string[]; observations?: Array<{ evidenceHash: string }> } | undefined,
  member: QualifiedMember,
  evidenceHash: string
) {
  const observed = observedConfidence(member);
  if (!existing) return observed;
  const sameEntity = !existing.entityKey || !safeEntityKey(member) || existing.entityKey === safeEntityKey(member);
  const overlap = member.intelligence.evidenceSignals.filter((signal) => existing.evidenceSignals.includes(signal.code)).length;
  const repeatBoost = sameEntity && overlap >= 2 ? Math.min(0.08, 0.02 + overlap * 0.01) : 0;
  const entityConflict = existing.entityKey && safeEntityKey(member) && existing.entityKey !== safeEntityKey(member) ? 0.18 : 0;
  const contradictionPenalty = Math.min(0.2, member.intelligence.contradictions.length * 0.035);
  const novelty = existing.observations?.[0]?.evidenceHash === evidenceHash ? 0 : repeatBoost;
  return clamp01(existing.confidence * 0.6 + observed * 0.4 + novelty - entityConflict - contradictionPenalty);
}

async function loadProfiles(prisma: PrismaClient, members: QualifiedMember[]) {
  type LoadedProfile = Prisma.WalletIntelligenceProfileGetPayload<{ include: { cluster: { include: { mergedInto: true } }; observations: { select: { evidenceHash: true } } } }>;
  const rows: LoadedProfile[] = [];
  for (const chain of ['SOLANA', 'ETHEREUM', 'BASE', 'ARBITRUM', 'BSC'] as ChainId[]) {
    const addresses = unique(members.filter((member) => member.chain === chain).map((member) => member.address));
    for (const part of chunks(addresses, 5_000)) {
      rows.push(...await prisma.walletIntelligenceProfile.findMany({
        where: { chain, address: { in: part } },
        include: { cluster: { include: { mergedInto: true } }, observations: { orderBy: { observedAt: 'desc' }, take: 1, select: { evidenceHash: true } } }
      }));
    }
  }
  return rows as Array<Prisma.WalletIntelligenceProfileGetPayload<{ include: { cluster: { include: { mergedInto: true } }; observations: { select: { evidenceHash: true } } } }>>;
}

function resolveMergedCluster(cluster: Prisma.IntelligenceClusterGetPayload<{ include: { mergedInto: true } }>) {
  return cluster.mergedInto ?? cluster;
}

function monitoringPriority(member: QualifiedMember): MonitoringPriority {
  const byRole = monitoringTierForRole(member.role);
  if (member.intelligence.trackingPriority === 'track_now') return byRole === 'standard' ? 'strong_link' : byRole;
  if (member.intelligence.trackingPriority === 'watch') return byRole === 'standard' ? 'probable_link' : byRole;
  return byRole === 'standard' ? 'weak_cold' : byRole;
}

function reasonAdded(member: QualifiedMember) {
  const reasons = member.intelligence.whyImportant.length
    ? member.intelligence.whyImportant
    : member.intelligence.evidenceSignals.map((signal) => signal.label);
  return `intelligence:${member.intelligence.tier}:${reasons.slice(0, 3).join('; ')}`.slice(0, 500);
}

function maxOptional(a: number | null | undefined, b: number | null | undefined) {
  if (a === null || a === undefined) return b ?? null;
  if (b === null || b === undefined) return a;
  return Math.max(a, b);
}

function normalizedMemberAlpha(member: QualifiedMember) {
  const intel = member.intelligence as QualifiedMember['intelligence'] & Partial<{
    sourceScore: number | null;
    rawHistoricalAlphaScore: number;
    sampleAdjustedHistoricalAlphaScore: number;
    alphaConfidence: number;
    alphaSampleSize: number;
    alphaCalibration: Record<string, number | string | null>;
    status: string;
  }>;
  const sampleSize = intel.alphaSampleSize ?? intel.metrics.completedPositions ?? 0;
  const confidence = intel.alphaConfidence ?? (sampleSize ? 1 - Math.exp(-sampleSize / 18) : 0);
  const rawScore = intel.rawHistoricalAlphaScore ?? intel.historicalAlphaScore;
  const sampleAdjustedScore = intel.sampleAdjustedHistoricalAlphaScore ?? intel.historicalAlphaScore;
  const dormantDays = intel.metrics.maxCoveredDormantDays ?? 0;
  const status = intel.status ?? (dormantDays >= 30 && (sampleAdjustedScore >= 50 || intel.wakeUpPotential >= 55)
    ? 'dormant_high_value'
    : dormantDays >= 30 ? 'dormant_alpha'
      : sampleAdjustedScore >= 45 ? 'active_alpha' : 'inactive_low_value');
  return {
    sourceScore: intel.sourceScore ?? null,
    rawScore,
    sampleAdjustedScore,
    confidence,
    sampleSize,
    calibration: intel.alphaCalibration ?? { sampleSize, sampleConfidence: confidence, compatibilityProjection: 'legacy_intelligence_payload' },
    status
  };
}

const ROLE_ORDER = ['root_main', 'operator_root', 'funding_wallet', 'execution_wallet', 'profit_collector', 'profit_collection_wallet', 'bridge_destination', 'bridge_linked_receiver', 'dormant_funded_receiver', 'fresh_funded_receiver', 'probable_side_alt_wallet', 'probable_side_wallet', 'unknown_related_wallet'];
function preferredRole(previous: string | undefined, incoming: string) {
  if (!previous) return incoming;
  return roleRank(incoming) < roleRank(previous) ? incoming : previous;
}
function roleRank(role: string) { const index = ROLE_ORDER.indexOf(role); return index < 0 ? ROLE_ORDER.length : index; }
const TIER_ORDER = ['S', 'A', 'B', 'C'];
function betterTier(previous: string | undefined, incoming: string) { if (!previous) return incoming; return TIER_ORDER.indexOf(incoming) < TIER_ORDER.indexOf(previous) ? incoming : previous; }
function rollingScore(previous: number | undefined, observed: number) { return previous === undefined ? observed : Math.round(previous * 0.4 + observed * 0.6); }
function stableClusterKey(groupKey: string) { return `ic_${hash(groupKey).slice(0, 24)}`; }
function refKey(chain: ChainId, address: string) { return `${chain}:${normalizeAddress(chain, address)}`; }
function normalizeConfidence(value: number) { return clamp01(value > 1 ? value / 100 : value); }
function clamp01(value: number) { return Math.max(0, Math.min(1, value)); }
function hash(value: string) { return createHash('sha256').update(value).digest('hex'); }
function average(values: number[]) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }
function unique<T>(values: T[]) { return [...new Set(values)]; }
function uniqueBy<T>(values: T[], key: (value: T) => string) { return [...new Map(values.map((value) => [key(value), value])).values()]; }
function latestDate(...values: Array<Date | null | undefined>) { return values.filter(nonNull).sort((a, b) => b.getTime() - a.getTime())[0] ?? null; }
function chunks<T>(values: T[], size: number) { const result: T[][] = []; for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size)); return result; }
function nonNull<T>(value: T | null | undefined): value is T { return value !== null && value !== undefined; }
function json(value: unknown): Prisma.InputJsonValue { return value as Prisma.InputJsonValue; }
