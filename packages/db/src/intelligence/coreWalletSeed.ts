import { createHash } from 'node:crypto';
import { isValidSolanaAddress, tierPriorityValue } from '@flowradar/core';
import { Prisma, type ChainId, type PrismaClient } from '@prisma/client';
import { normalizeAddress, validAddress } from '../discovery/unified';
import { withGlobalJobLock } from '../locks/globalJobLock';
import { ADAPTIVE_RULE_VERSION } from './adaptive';
import { syncIntelligenceEntities } from './entities';
import { enrollObservationWallet } from './monitoring';

export const PRIORITY_CORE_SEED_POLICY_VERSION = 1;
export const DEFAULT_PRIORITY_CORE_SEED_THRESHOLD = 85;

const SOURCE_SIGNAL = 'external_priority_seed_discovery';
const SEED_ROLE = 'priority_core_seed_candidate';
const CHAINS: ChainId[] = ['SOLANA', 'ETHEREUM', 'BASE', 'ARBITRUM', 'BSC'];
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export interface PriorityCoreSeedRow {
  sourceFile: string;
  sourceHash: string;
  sourceSheet?: string | null;
  sourceRow: number;
  address: unknown;
  chain?: unknown;
  score: unknown;
  tier?: unknown;
  status?: unknown;
  label?: unknown;
  addedAt?: unknown;
  lastActiveAt?: unknown;
  raw?: Record<string, unknown>;
}

export type PriorityCoreSeedDecision =
  | 'accepted_primary'
  | 'accepted_duplicate_source'
  | 'rejected_below_threshold'
  | 'rejected_invalid_score'
  | 'rejected_invalid_address'
  | 'rejected_ambiguous_evm_chain';

export interface PriorityCoreSeedPreviewEntry {
  row: PriorityCoreSeedRow;
  recordKey: string;
  decision: PriorityCoreSeedDecision;
  reasonCodes: string[];
  chain: ChainId | null;
  address: string | null;
  sourceScore: number | null;
  sourceTier: string | null;
  sourceStatus: string | null;
  sourceLabel: string | null;
  sourceAddedAt: Date | null;
  sourceLastActiveAt: Date | null;
}

export interface PriorityCoreSeedPreview {
  importKey: string;
  threshold: number;
  totalRows: number;
  candidateRows: number;
  acceptedRows: number;
  uniqueWallets: number;
  rejectedRows: number;
  duplicateRows: number;
  sourceFiles: string[];
  sourceHashes: string[];
  entries: PriorityCoreSeedPreviewEntry[];
  acceptedGroups: Map<string, PriorityCoreSeedPreviewEntry[]>;
}

export interface PriorityCoreSeedImportReport {
  importId: string;
  importKey: string;
  idempotentReplay: boolean;
  totalRows: number;
  candidateRows: number;
  acceptedRows: number;
  uniqueWallets: number;
  rejectedRows: number;
  duplicateRows: number;
  profilesCreated: number;
  profilesUpdated: number;
  singletonClustersCreated: number;
  monitoringEnrolled: number;
  entitiesProjected: number;
  guardrails: {
    sourceScoreOwnershipEvidence: false;
    sourceScoreSignalEligibility: false;
    sourceScoreBuyCandidateTrigger: false;
    newProfilesWithOwnershipEvidence: number;
    unsafeEntityMemberships: number;
    newWalletStatusEscalations: number;
    walletStatsWrites: number;
  };
}

/**
 * Validates and deterministically deduplicates external seed rows without
 * touching the database. EVM rows require an explicit chain because one 0x
 * address cannot safely identify Ethereum/Base/Arbitrum/BSC on its own.
 */
export function previewPriorityCoreWalletSeeds(
  rows: PriorityCoreSeedRow[],
  threshold = DEFAULT_PRIORITY_CORE_SEED_THRESHOLD
): PriorityCoreSeedPreview {
  if (!Number.isFinite(threshold)) throw new Error('Priority core seed threshold must be finite');
  if (!rows.length) throw new Error('Priority core seed import requires at least one source row');
  const sourceFiles = unique(rows.map((row) => cleanText(row.sourceFile)).filter(nonNull)).sort();
  const sourceHashes = unique(rows.map((row) => cleanText(row.sourceHash)).filter(nonNull)).sort();
  if (!sourceFiles.length || !sourceHashes.length || rows.some((row) => !cleanText(row.sourceFile) || !/^[a-f0-9]{64}$/i.test(cleanText(row.sourceHash) ?? ''))) {
    throw new Error('Every priority core seed row requires a filename and SHA-256 source hash');
  }
  const importKey = hash(JSON.stringify({ policyVersion: PRIORITY_CORE_SEED_POLICY_VERSION, threshold, sourceHashes }));
  const entries = rows.map((row) => previewRow(row, importKey, threshold));
  const accepted = entries.filter((entry) => entry.decision === 'accepted_primary');
  const grouped = groupBy(accepted, (entry) => refKey(entry.chain!, entry.address!));
  const acceptedGroups = new Map<string, PriorityCoreSeedPreviewEntry[]>();
  for (const [ref, values] of grouped) {
    const sorted = [...values].sort(sourceOrder);
    sorted.forEach((entry, index) => {
      if (index > 0) {
        entry.decision = 'accepted_duplicate_source';
        entry.reasonCodes = ['duplicate_address_across_source_rows', 'source_score_discovery_prior_only'];
      }
    });
    acceptedGroups.set(ref, sorted);
  }
  const candidateRows = entries.filter((entry) => entry.sourceScore !== null && entry.sourceScore >= threshold).length;
  const acceptedRows = entries.filter((entry) => entry.decision.startsWith('accepted_')).length;
  return {
    importKey,
    threshold,
    totalRows: entries.length,
    candidateRows,
    acceptedRows,
    uniqueWallets: acceptedGroups.size,
    rejectedRows: entries.length - acceptedRows,
    duplicateRows: entries.filter((entry) => entry.decision === 'accepted_duplicate_source').length,
    sourceFiles,
    sourceHashes,
    entries,
    acceptedGroups
  };
}

/**
 * Permanently imports high-score seed candidates into the observation-only
 * knowledge and monitoring universe. The source score is deliberately absent
 * from entity evidence, alpha calibration, confidence, and signal generation.
 */
export async function importPriorityCoreWalletSeeds(
  prisma: PrismaClient,
  rows: PriorityCoreSeedRow[],
  options: { threshold?: number; now?: Date } = {}
): Promise<PriorityCoreSeedImportReport> {
  const preview = previewPriorityCoreWalletSeeds(rows, options.threshold ?? DEFAULT_PRIORITY_CORE_SEED_THRESHOLD);
  const now = options.now ?? new Date();

  return withGlobalJobLock(`priority-core-wallet-seed:${preview.importKey.slice(0, 12)}`, async () => {
    const completed = await prisma.coreWalletSeedImport.findUnique({ where: { importKey: preview.importKey } });
    if (completed?.status === 'completed') {
      const completedRecords = await prisma.coreWalletSeedRecord.findMany({
        where: { importId: completed.id, walletId: { not: null } },
        select: { walletId: true }
      });
      await reconcileSeedSubscriptions(prisma, unique(completedRecords.map((row) => row.walletId).filter(nonNull)), now);
      return reportFromReceipt(completed, true);
    }

    const receipt = await prisma.coreWalletSeedImport.upsert({
      where: { importKey: preview.importKey },
      create: {
        importKey: preview.importKey,
        status: 'running',
        policyVersion: PRIORITY_CORE_SEED_POLICY_VERSION,
        scoreThreshold: preview.threshold,
        sourceFiles: preview.sourceFiles,
        sourceHashes: preview.sourceHashes,
        totalRows: preview.totalRows,
        candidateRows: preview.candidateRows,
        acceptedRows: preview.acceptedRows,
        uniqueWallets: preview.uniqueWallets,
        rejectedRows: preview.rejectedRows,
        duplicateRows: preview.duplicateRows,
        guardrailJson: json(guardrailPolicy()),
        errorsJson: json({ rejectedByDecision: decisionCounts(preview.entries) }),
        startedAt: now
      },
      update: { status: 'running', startedAt: now, completedAt: null }
    });

    try {
      await prisma.coreWalletSeedRecord.createMany({
        data: preview.entries.map((entry) => ({
          recordKey: entry.recordKey,
          importId: receipt.id,
          sourceFile: entry.row.sourceFile,
          sourceHash: entry.row.sourceHash.toLowerCase(),
          sourceSheet: cleanText(entry.row.sourceSheet),
          sourceRow: entry.row.sourceRow,
          chain: entry.chain,
          address: entry.address,
          sourceScore: entry.sourceScore,
          sourceTier: entry.sourceTier,
          sourceStatus: entry.sourceStatus,
          sourceLabel: entry.sourceLabel,
          sourceAddedAt: entry.sourceAddedAt,
          sourceLastActiveAt: entry.sourceLastActiveAt,
          rawJson: json(safeJson(entry.row.raw ?? sourceFields(entry.row))),
          decision: entry.decision,
          reasonCodes: entry.reasonCodes
        })),
        skipDuplicates: true
      });

      let profilesCreated = 0;
      let profilesUpdated = 0;
      let singletonClustersCreated = 0;
      let monitoringEnrolled = 0;
      let newWalletStatusEscalations = 0;
      let walletStatsWrites = 0;
      const newProfileIds: string[] = [];

      for (const [ref, group] of preview.acceptedGroups) {
        const primary = group[0]!;
        const chain = primary.chain!;
        const address = primary.address!;
        const addedAt = earliestDate(...group.map((entry) => entry.sourceAddedAt));
        const sourceLastActiveAt = latestDate(...group.map((entry) => entry.sourceLastActiveAt));
        const sourceDormant = group.some((entry) => /dormant/i.test(entry.sourceStatus ?? ''));
        const sourceScore = Math.max(...group.map((entry) => entry.sourceScore ?? 0));
        const existingWallet = await prisma.wallet.findUnique({
          where: { address_chain: { address, chain } },
          select: { id: true, status: true, _count: { select: { stats: true } } }
        });
        const reason = `priority_core_seed score>=${preview.threshold}; discovery prior only; ownership, alpha and signal eligibility unverified`;
        const enrollment = await enrollObservationWallet(prisma, {
          chain,
          address,
          role: SEED_ROLE,
          reason,
          firstSeenAt: addedAt ?? sourceLastActiveAt ?? now,
          lastActiveAt: sourceLastActiveAt ?? addedAt ?? now,
          now
        });
        monitoringEnrolled += 1;
        if (!existingWallet && enrollment.wallet.status !== 'observation_only') newWalletStatusEscalations += 1;

        let profile = await prisma.walletIntelligenceProfile.findUnique({
          where: { chain_address: { chain, address } }
        });
        const observationKey = hash(`priority-core-seed-observation|${preview.importKey}|${ref}`);
        const existingObservation = profile
          ? await prisma.walletIntelligenceObservation.findUnique({ where: { observationKey }, select: { id: true } })
          : null;
        let clusterId: string;

        if (!profile) {
          const clusterKey = `ics_seed_${hash(ref).slice(0, 24)}`;
          const existingCluster = await prisma.intelligenceCluster.findUnique({ where: { clusterKey }, select: { id: true } });
          const cluster = await prisma.intelligenceCluster.upsert({
            where: { clusterKey },
            create: {
              clusterKey,
              entityKey: null,
              confidence: 0,
              walletCount: 0,
              firstDiscoveredAt: addedAt ?? now,
              lastEvidenceAt: now,
              evidenceJson: json({
                source: 'priority_core_wallet_seed',
                importKey: preview.importKey,
                singletonCandidate: true,
                noOwnershipClaim: true,
                sourceScoreExcludedFromOwnership: true
              })
            },
            update: { lastEvidenceAt: now }
          });
          if (!existingCluster) singletonClustersCreated += 1;
          clusterId = cluster.id;
          profile = await prisma.walletIntelligenceProfile.create({
            data: {
              walletId: enrollment.wallet.id,
              chain,
              address,
              clusterId,
              entityKey: null,
              role: SEED_ROLE,
              evidenceScore: 0,
              sourceScore,
              rawHistoricalAlphaScore: 35,
              sampleAdjustedAlphaScore: 35,
              alphaConfidence: 0,
              alphaSampleSize: 0,
              alphaCalibrationJson: json({ status: 'unverified', sourceScoreExcluded: true }),
              historicalAlphaScore: 35,
              wakeUpPotential: sourceDormant ? 45 : 35,
              intelligenceStatus: 'inactive_low_value',
              confidence: 0,
              tier: 'C',
              discoverySource: 'priority_core_wallet_seed',
              lastDiscoverySource: 'priority_core_wallet_seed',
              firstDiscoveredAt: addedAt ?? now,
              lastObservedAt: now,
              lastActivityAt: sourceLastActiveAt,
              monitoringPriority: 'strong_link',
              reasonAdded: reason,
              observationCount: 1,
              independentSignals: 0,
              evidenceSignals: [],
              supportingEvidenceJson: json(seedSupport(preview, group, sourceDormant)),
              contradictingEvidenceJson: json({
                contradictions: [],
                unresolved: ['ownership_unverified', 'historical_alpha_unverified', 'source_dormancy_unverified']
              }),
              scoreVersion: ADAPTIVE_RULE_VERSION
            }
          });
          profilesCreated += 1;
          newProfileIds.push(profile.id);
          await prisma.intelligenceClusterObservation.upsert({
            where: { observationKey: hash(`priority-core-seed-cluster|${preview.importKey}|${ref}`) },
            create: {
              observationKey: hash(`priority-core-seed-cluster|${preview.importKey}|${ref}`),
              clusterId,
              confidence: 0,
              walletCount: 1,
              supportingEvidenceJson: json({ source: 'priority_core_wallet_seed', singletonCandidate: true, noOwnershipClaim: true }),
              contradictingEvidenceJson: json({ unresolved: ['no_independent_ownership_evidence'] }),
              observedAt: now
            },
            update: {}
          });
          await prisma.intelligenceCluster.update({ where: { id: clusterId }, data: { walletCount: 1 } });
        } else {
          clusterId = profile.clusterId;
          if (!existingObservation) {
            profile = await prisma.walletIntelligenceProfile.update({
              where: { id: profile.id },
              data: {
                lastDiscoverySource: 'priority_core_wallet_seed',
                sourceScore: Math.max(profile.sourceScore ?? 0, sourceScore),
                observationCount: { increment: 1 }
              }
            });
            profilesUpdated += 1;
          }
        }

        if (!existingObservation) {
          await prisma.walletIntelligenceObservation.create({
            data: {
              observationKey,
              profileId: profile.id,
              discoverySource: 'priority_core_wallet_seed',
              entityKey: profile.entityKey,
              role: profile.role,
              evidenceScore: profile.evidenceScore,
              sourceScore,
              rawHistoricalAlphaScore: profile.rawHistoricalAlphaScore,
              sampleAdjustedAlphaScore: profile.sampleAdjustedAlphaScore,
              alphaConfidence: profile.alphaConfidence,
              alphaSampleSize: profile.alphaSampleSize,
              alphaCalibrationJson: json(profile.alphaCalibrationJson),
              historicalAlphaScore: profile.historicalAlphaScore,
              wakeUpPotential: profile.wakeUpPotential,
              intelligenceStatus: profile.intelligenceStatus,
              confidence: profile.confidence,
              previousConfidence: profile.confidence,
              confidenceDelta: 0,
              tier: profile.tier,
              independentSignals: 0,
              evidenceSignals: [SOURCE_SIGNAL],
              supportingEvidenceJson: json(seedSupport(preview, group, sourceDormant)),
              contradictingEvidenceJson: json({ unresolved: ['not_ownership_evidence', 'not_alpha_validation'] }),
              reasonJson: json({
                reason: 'priority monitoring seed selected by external score threshold',
                sourceScoreUsedOnlyFor: ['candidate_threshold', 'monitoring_queue_priority', 'audit_provenance'],
                sourceScoreNeverUsedFor: ['ownership', 'cluster_merge', 'signal_eligibility', 'historical_alpha_score', 'buy_candidate']
              }),
              evidenceHash: hash(JSON.stringify(group.map((entry) => [entry.row.sourceHash, entry.row.sourceRow, entry.sourceScore]))),
              scoreVersion: ADAPTIVE_RULE_VERSION,
              observedAt: now
            }
          });
        }

        const statsAfter = await prisma.walletStats.count({ where: { walletId: enrollment.wallet.id } });
        walletStatsWrites += Math.max(0, statsAfter - (existingWallet?._count.stats ?? 0));
        await prisma.coreWalletSeedRecord.updateMany({
          where: { recordKey: { in: group.map((entry) => entry.recordKey) } },
          data: { walletId: enrollment.wallet.id, profileId: profile.id, clusterId }
        });
      }

      const entityReport = newProfileIds.length
        ? await syncIntelligenceEntities(prisma, {
            profileIds: newProfileIds,
            now,
            cause: `priority_core_wallet_seed:${preview.importKey}`
          })
        : { entitiesCreated: 0, entitiesUpdated: 0 };
      await reconcileSeedSubscriptions(
        prisma,
        unique((await prisma.coreWalletSeedRecord.findMany({
          where: { importId: receipt.id, walletId: { not: null } },
          select: { walletId: true }
        })).map((row) => row.walletId).filter(nonNull)),
        now
      );
      const newProfilesWithOwnershipEvidence = newProfileIds.length
        ? await prisma.walletIntelligenceProfile.count({ where: { id: { in: newProfileIds }, OR: [{ evidenceScore: { gt: 0 } }, { independentSignals: { gt: 0 } }, { evidenceSignals: { isEmpty: false } }, { entityKey: { not: null } }] } })
        : 0;
      const unsafeEntityMemberships = newProfileIds.length
        ? await prisma.intelligenceEntityMembership.count({ where: { profileId: { in: newProfileIds }, OR: [{ scope: { not: 'peripheral' } }, { status: { not: 'possible' } }, { independentSignalCount: { gt: 0 } }] } })
        : 0;
      const guardrails = {
        sourceScoreOwnershipEvidence: false as const,
        sourceScoreSignalEligibility: false as const,
        sourceScoreBuyCandidateTrigger: false as const,
        newProfilesWithOwnershipEvidence,
        unsafeEntityMemberships,
        newWalletStatusEscalations,
        walletStatsWrites
      };
      if (Object.values(guardrails).some((value) => typeof value === 'number' && value !== 0)) {
        throw new Error(`Priority core seed guardrail failure: ${JSON.stringify(guardrails)}`);
      }

      const completedReceipt = await prisma.coreWalletSeedImport.update({
        where: { id: receipt.id },
        data: {
          status: 'completed',
          profilesCreated,
          profilesUpdated,
          singletonClustersCreated,
          monitoringEnrolled,
          entitiesProjected: entityReport.entitiesCreated + entityReport.entitiesUpdated,
          guardrailJson: json({ ...guardrailPolicy(), observed: guardrails }),
          completedAt: now
        }
      });
      return reportFromReceipt(completedReceipt, false);
    } catch (error) {
      await prisma.coreWalletSeedImport.update({
        where: { id: receipt.id },
        data: {
          status: 'failed',
          errorsJson: json({
            rejectedByDecision: decisionCounts(preview.entries),
            runtimeError: error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000)
          }),
          completedAt: new Date()
        }
      }).catch(() => undefined);
      throw error;
    }
  }, { waitMs: 60_000 });
}

function previewRow(row: PriorityCoreSeedRow, importKey: string, threshold: number): PriorityCoreSeedPreviewEntry {
  const sourceScore = finiteNumber(row.score);
  const addressText = cleanText(row.address);
  const chainResult = inferChain(row.chain, addressText);
  const base = {
    row,
    recordKey: hash(`priority-core-seed-row|${importKey}|${row.sourceHash.toLowerCase()}|${row.sourceSheet ?? ''}|${row.sourceRow}`),
    chain: chainResult.chain,
    address: chainResult.address,
    sourceScore,
    sourceTier: cleanText(row.tier),
    sourceStatus: cleanText(row.status)?.toLowerCase() ?? null,
    sourceLabel: cleanText(row.label),
    sourceAddedAt: parseDate(row.addedAt),
    sourceLastActiveAt: parseDate(row.lastActiveAt)
  };
  if (sourceScore === null) return { ...base, decision: 'rejected_invalid_score', reasonCodes: ['missing_or_non_finite_score'] };
  if (sourceScore < threshold) return { ...base, decision: 'rejected_below_threshold', reasonCodes: ['source_score_below_threshold'] };
  if (chainResult.reason === 'ambiguous_evm_chain') return { ...base, decision: 'rejected_ambiguous_evm_chain', reasonCodes: ['evm_address_requires_explicit_chain'] };
  if (!chainResult.chain || !chainResult.address) return { ...base, decision: 'rejected_invalid_address', reasonCodes: ['invalid_or_unsupported_wallet_address'] };
  return { ...base, decision: 'accepted_primary', reasonCodes: ['source_score_threshold_met', 'source_score_discovery_prior_only'] };
}

function inferChain(rawChain: unknown, rawAddress: string | null): { chain: ChainId | null; address: string | null; reason?: string } {
  if (!rawAddress) return { chain: null, address: null };
  const supplied = cleanText(rawChain)?.toUpperCase() as ChainId | undefined;
  if (supplied && CHAINS.includes(supplied)) {
    if (!validAddress(supplied, rawAddress)) return { chain: null, address: null };
    return { chain: supplied, address: normalizeAddress(supplied, rawAddress) };
  }
  if (EVM_ADDRESS.test(rawAddress)) return { chain: null, address: rawAddress.toLowerCase(), reason: 'ambiguous_evm_chain' };
  if (isValidSolanaAddress(rawAddress)) return { chain: 'SOLANA', address: rawAddress };
  return { chain: null, address: null };
}

function seedSupport(preview: PriorityCoreSeedPreview, group: PriorityCoreSeedPreviewEntry[], sourceDormant: boolean) {
  return {
    source: 'priority_core_wallet_seed',
    importKey: preview.importKey,
    sourceRows: group.map((entry) => ({
      file: entry.row.sourceFile,
      hash: entry.row.sourceHash,
      sheet: entry.row.sourceSheet ?? null,
      row: entry.row.sourceRow,
      score: entry.sourceScore,
      tier: entry.sourceTier,
      status: entry.sourceStatus,
      label: entry.sourceLabel
    })),
    sourceDormantClaim: sourceDormant,
    sourceDormantVerified: false,
    historicalSampleSize: 0,
    ownershipEvidenceExcluded: true,
    sourceScoreExcludedFromAlphaCalibration: true,
    sourceScoreExcludedFromSignals: true,
    enrichmentState: 'queued_via_monitoring_subscription'
  };
}

function guardrailPolicy() {
  return {
    sourceScoreUsedOnlyFor: ['candidate_threshold', 'monitoring_queue_priority', 'audit_provenance'],
    sourceScoreNeverUsedFor: ['ownership', 'entity_merge', 'cluster_merge', 'signal_eligibility', 'historical_alpha_score', 'buy_candidate'],
    newWalletStatus: 'observation_only',
    initialEntityMembership: 'possible_peripheral_singleton',
    signalGenerationInvoked: false,
    buyCandidateGenerationInvoked: false
  };
}

async function reconcileSeedSubscriptions(prisma: PrismaClient, walletIds: string[], now: Date) {
  if (!walletIds.length) return;
  const rows = await prisma.monitoringSubscription.findMany({
    where: { walletId: { in: walletIds }, reason: { startsWith: 'priority_core_seed' } },
    orderBy: [{ walletId: 'asc' }, { createdAt: 'asc' }]
  });
  for (const row of rows) {
    if (row.priority === 'strong_link') {
      await prisma.monitoringSubscription.update({
        where: { id: row.id },
        data: { active: true, tierPriority: tierPriorityValue('strong_link'), nextPollAt: now, hotUntil: null }
      });
      continue;
    }
    const collision = await prisma.monitoringSubscription.findUnique({
      where: { walletId_priority: { walletId: row.walletId, priority: 'strong_link' } }
    });
    if (collision) {
      await prisma.monitoringSubscription.update({
        where: { id: collision.id },
        data: { active: true, tierPriority: tierPriorityValue('strong_link'), nextPollAt: now }
      });
      await prisma.monitoringSubscription.delete({ where: { id: row.id } });
    } else {
      await prisma.monitoringSubscription.update({
        where: { id: row.id },
        data: { priority: 'strong_link', active: true, tierPriority: tierPriorityValue('strong_link'), nextPollAt: now, hotUntil: null }
      });
    }
  }
}

function reportFromReceipt(row: {
  id: string; importKey: string; totalRows: number; candidateRows: number; acceptedRows: number; uniqueWallets: number;
  rejectedRows: number; duplicateRows: number; profilesCreated: number; profilesUpdated: number;
  singletonClustersCreated: number; monitoringEnrolled: number; entitiesProjected: number; guardrailJson: Prisma.JsonValue;
}, idempotentReplay: boolean): PriorityCoreSeedImportReport {
  const observed = recordOf(recordOf(row.guardrailJson).observed);
  return {
    importId: row.id,
    importKey: row.importKey,
    idempotentReplay,
    totalRows: row.totalRows,
    candidateRows: row.candidateRows,
    acceptedRows: row.acceptedRows,
    uniqueWallets: row.uniqueWallets,
    rejectedRows: row.rejectedRows,
    duplicateRows: row.duplicateRows,
    profilesCreated: row.profilesCreated,
    profilesUpdated: row.profilesUpdated,
    singletonClustersCreated: row.singletonClustersCreated,
    monitoringEnrolled: row.monitoringEnrolled,
    entitiesProjected: row.entitiesProjected,
    guardrails: {
      sourceScoreOwnershipEvidence: false,
      sourceScoreSignalEligibility: false,
      sourceScoreBuyCandidateTrigger: false,
      newProfilesWithOwnershipEvidence: numberField(observed.newProfilesWithOwnershipEvidence),
      unsafeEntityMemberships: numberField(observed.unsafeEntityMemberships),
      newWalletStatusEscalations: numberField(observed.newWalletStatusEscalations),
      walletStatsWrites: numberField(observed.walletStatsWrites)
    }
  };
}

function decisionCounts(entries: PriorityCoreSeedPreviewEntry[]) {
  const counts: Record<string, number> = {};
  for (const entry of entries) counts[entry.decision] = (counts[entry.decision] ?? 0) + 1;
  return counts;
}

function sourceFields(row: PriorityCoreSeedRow) {
  return { address: row.address, chain: row.chain, score: row.score, tier: row.tier, status: row.status, label: row.label, addedAt: row.addedAt, lastActiveAt: row.lastActiveAt };
}
function sourceOrder(a: PriorityCoreSeedPreviewEntry, b: PriorityCoreSeedPreviewEntry) {
  return a.row.sourceHash.localeCompare(b.row.sourceHash) || (a.row.sourceSheet ?? '').localeCompare(b.row.sourceSheet ?? '') || a.row.sourceRow - b.row.sourceRow;
}
function refKey(chain: ChainId, address: string) { return `${chain}:${normalizeAddress(chain, address)}`; }
function groupBy<T, K>(values: T[], pick: (value: T) => K) { const map = new Map<K, T[]>(); for (const value of values) map.set(pick(value), [...(map.get(pick(value)) ?? []), value]); return map; }
function unique<T>(values: T[]) { return [...new Set(values)]; }
function nonNull<T>(value: T | null): value is T { return value !== null; }
function cleanText(value: unknown) { if (value === null || value === undefined) return null; const text = String(value).trim(); return text || null; }
function finiteNumber(value: unknown) { const number = typeof value === 'number' ? value : Number(cleanText(value)); return Number.isFinite(number) ? number : null; }
function parseDate(value: unknown) { const text = cleanText(value); if (!text) return null; const date = new Date(text); return Number.isFinite(date.getTime()) ? date : null; }
function latestDate(...values: Array<Date | null>) { return values.filter(nonNull).sort((a, b) => b.getTime() - a.getTime())[0] ?? null; }
function earliestDate(...values: Array<Date | null>) { return values.filter(nonNull).sort((a, b) => a.getTime() - b.getTime())[0] ?? null; }
function safeJson(value: unknown): unknown { return JSON.parse(JSON.stringify(value, (_key, item) => item === undefined ? null : item)); }
function json(value: unknown): Prisma.InputJsonValue { return safeJson(value) as Prisma.InputJsonValue; }
function hash(value: string) { return createHash('sha256').update(value).digest('hex'); }
function recordOf(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function numberField(value: unknown) { const number = Number(value); return Number.isFinite(number) ? number : 0; }
