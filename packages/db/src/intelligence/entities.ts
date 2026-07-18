import { createHash, randomUUID } from 'node:crypto';
import { Prisma, type IntelligenceEntity, type PrismaClient, type WalletIntelligenceProfile } from '@prisma/client';
import { normalizeAddress } from '../discovery/unified';
import {
  ADAPTIVE_RULE_VERSION, ENTITY_DECAY_POLICY_VERSION, computeEntityDecay,
  membershipPriority, projectEntityMembership
} from './adaptive';

export interface EntitySyncReport {
  profilesScanned: number;
  entitiesCreated: number;
  entitiesUpdated: number;
  membershipsCreated: number;
  membershipsUpdated: number;
  infrastructureRejected: number;
  versionsAppended: number;
}

type ProfileWithCluster = Prisma.WalletIntelligenceProfileGetPayload<{ include: { cluster: true } }>;

/** Builds/updates the cautious entity projection from the existing permanent
 * wallet profiles. It does not alter cluster membership and is idempotent when
 * no profile evidence changed. */
export async function syncIntelligenceEntities(
  prisma: PrismaClient,
  options: { profileIds?: string[]; now?: Date; take?: number; cause?: string } = {}
): Promise<EntitySyncReport> {
  const now = options.now ?? new Date();
  const profiles = await prisma.walletIntelligenceProfile.findMany({
    where: options.profileIds?.length ? { id: { in: options.profileIds } } : undefined,
    include: { cluster: true },
    orderBy: [{ clusterId: 'asc' }, { id: 'asc' }],
    take: Math.max(1, Math.min(options.take ?? 100_000, 250_000))
  });
  const report: EntitySyncReport = { profilesScanned: profiles.length, entitiesCreated: 0, entitiesUpdated: 0, membershipsCreated: 0, membershipsUpdated: 0, infrastructureRejected: 0, versionsAppended: 0 };
  if (!profiles.length) return report;

  const registryRows = await loadRegistry(prisma, profiles);
  const registryByRef = new Map(registryRows.map((row) => [`${row.chain}:${normalizeAddress(row.chain, row.address)}`, row]));
  const groups = groupBy(profiles, (profile) => canonicalEntityKey(profile));

  for (const [entityKey, members] of groups) {
    const existing = await prisma.intelligenceEntity.findUnique({ where: { entityKey }, include: { memberships: true } });
    const projections = members.map((profile) => {
      const registry = registryByRef.get(`${profile.chain}:${normalizeAddress(profile.chain, profile.address)}`);
      const contradictions = jsonStrings(profile.contradictingEvidenceJson, 'contradictions');
      const projected = projectEntityMembership({
        role: profile.role,
        evidenceScore: profile.evidenceScore,
        confidence: profile.confidence,
        independentSignalCount: profile.independentSignals,
        evidenceTypes: profile.evidenceSignals,
        contradictions,
        daysSinceEvidence: daysBetween(profile.lastObservedAt, now),
        registryCategory: registry ? `${registry.category}:${registry.doNotExpand ? 'do_not_expand' : ''}` : null
      });
      return { profile, registry, contradictions, projected };
    });
    const nonInfrastructure = projections.filter((row) => row.projected.scope !== 'infrastructure');
    const core = nonInfrastructure.filter((row) => row.projected.scope === 'core');
    const peripheral = nonInfrastructure.filter((row) => row.projected.scope === 'peripheral');
    const weighted = nonInfrastructure.map((row) => ({ row, weight: row.projected.scope === 'core' ? 1 : 0.3 }));
    const scoreAverage = (pick: (profile: ProfileWithCluster) => number) => weightedAverage(weighted.map((item) => ({ value: pick(item.row.profile), weight: item.weight })));
    const identityConfidence = weightedAverage(weighted.map((item) => ({ value: item.row.projected.identityConfidence, weight: item.weight })));
    const currentRelevance = weightedAverage(weighted.map((item) => ({ value: item.row.projected.currentRelevance, weight: item.weight })));
    const evidenceFreshness = weightedAverage(weighted.map((item) => ({ value: item.row.projected.evidenceFreshness, weight: item.weight })));
    const historicalAlphaScore = scoreAverage((profile) => profile.historicalAlphaScore);
    const alphaSamples = nonInfrastructure.reduce((sum, row) => sum + row.profile.alphaSampleSize, 0);
    const historicalAlphaConfidence = clamp01(1 - Math.exp(-alphaSamples / 18));
    const wakeUpPotential = nonInfrastructure.length ? Math.max(...nonInfrastructure.map((row) => row.profile.wakeUpPotential)) : 0;
    const lastActivityAt = latestDate(...nonInfrastructure.map((row) => row.profile.lastActivityAt));
    const lastCoreActivityAt = latestDate(...core.map((row) => row.profile.lastActivityAt));
    const firstDiscoveredAt = earliestDate(...members.map((profile) => profile.firstDiscoveredAt)) ?? now;
    const lastEvidenceAt = latestDate(...members.map((profile) => profile.lastObservedAt)) ?? now;
    const priority = bestPriority(nonInfrastructure.map((row) => membershipPriority(row.projected.scope, row.projected.status, row.profile.historicalAlphaScore, row.profile.wakeUpPotential)));
    const historicalTokenAddresses = unique(nonInfrastructure.flatMap((row) => jsonStrings(row.profile.supportingEvidenceJson, 'deploymentTokenAddresses'))).sort();
    const strongestEvidence = projections
      .filter((row) => row.projected.scope !== 'infrastructure')
      .flatMap((row) => row.projected.evidenceTypes.map((type) => ({
        profileId: row.profile.id, type, scope: row.projected.scope,
        membershipStatus: row.projected.status, evidenceScore: row.profile.evidenceScore,
        identityConfidence: row.projected.identityConfidence
      })))
      .sort((a, b) => b.identityConfidence - a.identityConfidence || b.evidenceScore - a.evidenceScore)
      .slice(0, 20);
    const counterEvidence = projections.flatMap((row) => row.contradictions.map((reason) => ({ profileId: row.profile.id, reason }))).slice(0, 50);
    const infrastructureExclusions = projections.filter((row) => row.projected.scope === 'infrastructure').map((row) => ({
      profileId: row.profile.id, address: row.profile.address, reasonCodes: row.projected.reasonCodes
    }));
    const state = {
      identityConfidence: round(identityConfidence),
      currentRelevance: round(currentRelevance),
      historicalAlphaScore: round(historicalAlphaScore, 2),
      historicalAlphaConfidence: round(historicalAlphaConfidence),
      wakeUpPotential: round(wakeUpPotential, 2),
      evidenceFreshness: round(evidenceFreshness),
      monitoringPriority: priority,
      chains: unique(members.map((profile) => profile.chain)).sort(),
      clusterKeys: unique(members.map((profile) => profile.cluster.clusterKey)).sort(),
      coreWalletCount: core.length,
      peripheralWalletCount: peripheral.length,
      historicalTokenAddresses,
      strongestEvidenceJson: json({ evidence: strongestEvidence }),
      counterEvidenceJson: json({ contradictions: counterEvidence, infrastructureExclusions }),
      lastEvidenceAt,
      lastCoreActivityAt,
      lastActivityAt,
      dormantSince: lastCoreActivityAt && daysBetween(lastCoreActivityAt, now) >= 30 ? lastCoreActivityAt : null,
      type: entityType(core.map((row) => row.profile.role)),
      status: nonInfrastructure.length ? 'active' : 'rejected_infrastructure',
      stateHash: hash(JSON.stringify(projections.map((row) => ({
        id: row.profile.id, scoreVersion: row.profile.scoreVersion, observedAt: row.profile.lastObservedAt.toISOString(),
        status: row.projected.status, scope: row.projected.scope, types: row.projected.evidenceTypes
      }))))
    };
    const changed = !existing || jsonField(existing.provenanceJson, 'stateHash') !== state.stateHash;
    const nextVersion = existing ? existing.currentVersion + (changed ? 1 : 0) : 1;
    const entity = await prisma.intelligenceEntity.upsert({
      where: { entityKey },
      create: {
        entityKey, label: entityLabel(entityKey, members), type: state.type, status: state.status,
        identityConfidence: state.identityConfidence, currentRelevance: state.currentRelevance,
        historicalAlphaScore: state.historicalAlphaScore, historicalAlphaConfidence: state.historicalAlphaConfidence,
        wakeUpPotential: state.wakeUpPotential, evidenceFreshness: state.evidenceFreshness,
        monitoringPriority: state.monitoringPriority, chains: state.chains, clusterKeys: state.clusterKeys,
        coreWalletCount: state.coreWalletCount, peripheralWalletCount: state.peripheralWalletCount,
        tokenCount: state.historicalTokenAddresses.length, historicalTokenAddresses: state.historicalTokenAddresses,
        strongestEvidenceJson: state.strongestEvidenceJson, counterEvidenceJson: state.counterEvidenceJson,
        firstDiscoveredAt, lastEvidenceAt: state.lastEvidenceAt, lastCoreActivityAt: state.lastCoreActivityAt,
        lastActivityAt: state.lastActivityAt, dormantSince: state.dormantSince,
        provenanceJson: json({ stateHash: state.stateHash, source: options.cause ?? 'profile_projection', alphaSamples, ruleVersion: ADAPTIVE_RULE_VERSION }),
        currentVersion: nextVersion
      },
      update: {
        label: entityLabel(entityKey, members), type: state.type, status: state.status,
        identityConfidence: state.identityConfidence, currentRelevance: state.currentRelevance,
        historicalAlphaScore: state.historicalAlphaScore, historicalAlphaConfidence: state.historicalAlphaConfidence,
        wakeUpPotential: state.wakeUpPotential, evidenceFreshness: state.evidenceFreshness,
        monitoringPriority: state.monitoringPriority, chains: state.chains, clusterKeys: state.clusterKeys,
        coreWalletCount: state.coreWalletCount, peripheralWalletCount: state.peripheralWalletCount,
        tokenCount: state.historicalTokenAddresses.length, historicalTokenAddresses: state.historicalTokenAddresses,
        strongestEvidenceJson: state.strongestEvidenceJson, counterEvidenceJson: state.counterEvidenceJson,
        lastEvidenceAt: state.lastEvidenceAt, lastCoreActivityAt: state.lastCoreActivityAt,
        lastActivityAt: state.lastActivityAt, dormantSince: state.dormantSince,
        provenanceJson: json({ stateHash: state.stateHash, source: options.cause ?? 'profile_projection', alphaSamples, ruleVersion: ADAPTIVE_RULE_VERSION }),
        currentVersion: nextVersion
      }
    });
    existing ? report.entitiesUpdated += 1 : report.entitiesCreated += 1;

    for (const row of projections) {
      const membershipKey = hash(`membership|${entity.id}|${row.profile.id}`);
      const previous = existing?.memberships.find((membership) => membership.profileId === row.profile.id);
      const evidenceChanged = !previous
        || previous.status !== row.projected.status
        || previous.scope !== row.projected.scope
        || previous.evidenceTypes.join('|') !== row.projected.evidenceTypes.join('|');
      await prisma.intelligenceEntityMembership.upsert({
        where: { membershipKey },
        create: {
          membershipKey, entityId: entity.id, profileId: row.profile.id, role: row.profile.role,
          scope: row.projected.scope, status: row.projected.status, confidence: row.profile.confidence,
          evidenceScore: row.profile.evidenceScore, identityConfidence: row.projected.identityConfidence,
          currentRelevance: row.projected.currentRelevance, evidenceFreshness: row.projected.evidenceFreshness,
          independentSignalCount: row.projected.evidenceTypes.length, evidenceTypes: row.projected.evidenceTypes,
          supportingEvidenceJson: json({ profile: row.profile.supportingEvidenceJson, reasonCodes: row.projected.reasonCodes, registry: row.registry }),
          contradictingEvidenceJson: json({ profile: row.profile.contradictingEvidenceJson, contradictions: row.contradictions }),
          firstSeenAt: row.profile.firstDiscoveredAt, lastConfirmedAt: row.profile.lastObservedAt,
          lastObservedAt: now, staleAt: row.projected.status === 'stale' ? now : null,
          rejectedAt: row.projected.status === 'rejected' ? now : null
        },
        update: {
          role: row.profile.role, scope: row.projected.scope, status: row.projected.status,
          confidence: row.profile.confidence, evidenceScore: row.profile.evidenceScore,
          identityConfidence: row.projected.identityConfidence, currentRelevance: row.projected.currentRelevance,
          evidenceFreshness: row.projected.evidenceFreshness, independentSignalCount: row.projected.evidenceTypes.length,
          evidenceTypes: row.projected.evidenceTypes,
          supportingEvidenceJson: json({ profile: row.profile.supportingEvidenceJson, reasonCodes: row.projected.reasonCodes, registry: row.registry }),
          contradictingEvidenceJson: json({ profile: row.profile.contradictingEvidenceJson, contradictions: row.contradictions }),
          lastConfirmedAt: row.profile.lastObservedAt, lastObservedAt: now,
          staleAt: row.projected.status === 'stale' ? now : null,
          rejectedAt: row.projected.status === 'rejected' ? now : null,
          version: previous ? previous.version + (evidenceChanged ? 1 : 0) : 1
        }
      });
      previous ? report.membershipsUpdated += 1 : report.membershipsCreated += 1;
      if (row.projected.scope === 'infrastructure') report.infrastructureRejected += 1;
    }

    if (changed) {
      await prisma.intelligenceEntityVersion.create({
        data: {
          entityId: entity.id, version: nextVersion, cause: options.cause ?? 'profile_projection',
          identityConfidence: state.identityConfidence, currentRelevance: state.currentRelevance,
          historicalAlphaScore: state.historicalAlphaScore, historicalAlphaConfidence: state.historicalAlphaConfidence,
          wakeUpPotential: state.wakeUpPotential, evidenceFreshness: state.evidenceFreshness,
          coreWalletRefs: core.map((row) => `${row.profile.chain}:${row.profile.address}`).sort(),
          peripheralWalletRefs: peripheral.map((row) => `${row.profile.chain}:${row.profile.address}`).sort(),
          evidenceJson: json({
            projections: projections.map((row) => ({ profileId: row.profile.id, status: row.projected.status, scope: row.projected.scope, reasonCodes: row.projected.reasonCodes })),
            strongestEvidence, counterEvidence, infrastructureExclusions, historicalTokenAddresses
          }),
          provenanceJson: json({ stateHash: state.stateHash, source: options.cause ?? 'profile_projection', noIdentityClaim: true }),
          ruleVersion: ADAPTIVE_RULE_VERSION, observedAt: now
        }
      });
      report.versionsAppended += 1;
    }
  }
  return report;
}

export async function runEntityDecayPass(prisma: PrismaClient, now = new Date(), take = 100_000) {
  const entities = await prisma.intelligenceEntity.findMany({ where: { status: 'active' }, orderBy: { lastEvidenceAt: 'asc' }, take: Math.max(1, Math.min(take, 250_000)) });
  let snapshotsCreated = 0;
  let entitiesUpdated = 0;
  for (const entity of entities) {
    const bucket = now.toISOString().slice(0, 10);
    const snapshotKey = hash(`entity-decay|${entity.id}|${bucket}|v${ENTITY_DECAY_POLICY_VERSION}`);
    if (await prisma.intelligenceEntityDecaySnapshot.findUnique({ where: { snapshotKey }, select: { id: true } })) continue;
    const next = computeEntityDecay({
      identityConfidence: entity.identityConfidence, currentRelevance: entity.currentRelevance,
      historicalAlphaScore: entity.historicalAlphaScore, wakeUpPotential: entity.wakeUpPotential,
      lastEvidenceAt: entity.lastEvidenceAt, lastCoreActivityAt: entity.lastCoreActivityAt, now
    });
    await prisma.$transaction([
      prisma.intelligenceEntityDecaySnapshot.create({ data: {
        snapshotKey, entityId: entity.id, identityConfidence: next.identityConfidence,
        currentRelevance: next.currentRelevance, historicalAlphaScore: next.historicalAlphaScore,
        wakeUpPotential: next.wakeUpPotential, evidenceFreshness: next.evidenceFreshness,
        previousJson: json({ identityConfidence: entity.identityConfidence, currentRelevance: entity.currentRelevance, evidenceFreshness: entity.evidenceFreshness }),
        halfLivesJson: json(next.halfLives), reasonCodes: next.reasonCodes,
        policyVersion: ENTITY_DECAY_POLICY_VERSION, computedAt: now
      }}),
      prisma.intelligenceEntity.update({ where: { id: entity.id }, data: {
        identityConfidence: next.identityConfidence, currentRelevance: next.currentRelevance,
        evidenceFreshness: next.evidenceFreshness,
        dormantSince: next.dormantDays >= 30 ? entity.lastCoreActivityAt ?? entity.lastEvidenceAt : null
      }})
    ]);
    snapshotsCreated += 1;
    entitiesUpdated += 1;
  }
  return { entitiesScanned: entities.length, entitiesUpdated, snapshotsCreated, policyVersion: ENTITY_DECAY_POLICY_VERSION };
}

export interface EntityActionInput {
  sourceEntityIds: string[];
  membershipIds?: string[];
  independentEvidenceTypes: string[];
  reasons: string[];
  evidence?: unknown;
  now?: Date;
}

export async function proposeEntityMerge(prisma: PrismaClient, input: EntityActionInput) {
  const now = input.now ?? new Date();
  const sourceEntityIds = unique(input.sourceEntityIds).sort();
  const evidenceTypes = unique(input.independentEvidenceTypes.map((value) => value.toLowerCase())).sort();
  if (sourceEntityIds.length < 2) throw new Error('entity_merge_requires_two_entities');
  const entities = await prisma.intelligenceEntity.findMany({ where: { id: { in: sourceEntityIds }, status: 'active' }, include: { memberships: true } });
  if (entities.length !== sourceEntityIds.length) throw new Error('entity_merge_source_missing_or_inactive');
  const infrastructure = entities.some((entity) => entity.status.includes('infrastructure') || entity.memberships.some((membership) => membership.scope === 'infrastructure'));
  const eligible = evidenceTypes.length >= 2 && !infrastructure;
  const actionKey = hash(`entity-merge|${sourceEntityIds.join(',')}|${evidenceTypes.join(',')}|${now.toISOString()}`);
  return prisma.intelligenceEntityAction.create({ data: {
    actionKey, actionType: 'merge', status: eligible ? 'proposed' : 'rejected', sourceEntityIds,
    targetEntityIds: [], membershipIds: entities.flatMap((entity) => entity.memberships.map((row) => row.id)),
    independentEvidenceTypes: evidenceTypes,
    beforeJson: json(entities.map(entityReceipt)), afterJson: json({}), reasons: input.reasons,
    evidenceJson: json({ supplied: input.evidence ?? null, infrastructure, eligible }), rollbackJson: json({}),
    ruleVersion: ADAPTIVE_RULE_VERSION, proposedAt: now
  }});
}

export async function applyEntityMerge(prisma: PrismaClient, actionId: string, now = new Date()) {
  const action = await prisma.intelligenceEntityAction.findUnique({ where: { id: actionId } });
  if (!action || action.actionType !== 'merge' || action.status !== 'proposed') throw new Error('entity_merge_not_applicable');
  if (action.independentEvidenceTypes.length < 2) throw new Error('entity_merge_requires_two_independent_evidence_types');
  const entities = await prisma.intelligenceEntity.findMany({ where: { id: { in: action.sourceEntityIds } }, include: { memberships: true }, orderBy: [{ firstDiscoveredAt: 'asc' }, { id: 'asc' }] });
  if (entities.length < 2 || entities.some((entity) => entity.status !== 'active')) throw new Error('entity_merge_sources_changed');
  const target = entities[0]!;
  const losers = entities.slice(1);
  const targetProfiles = new Set(target.memberships.map((row) => row.profileId));
  const movable = losers.flatMap((entity) => entity.memberships).filter((membership) => !targetProfiles.has(membership.profileId));
  const duplicates = losers.flatMap((entity) => entity.memberships).filter((membership) => targetProfiles.has(membership.profileId));
  await prisma.$transaction([
    ...movable.map((membership) => prisma.intelligenceEntityMembership.update({ where: { id: membership.id }, data: { entityId: target.id, version: { increment: 1 } } })),
    ...duplicates.map((membership) => prisma.intelligenceEntityMembership.update({ where: { id: membership.id }, data: { status: 'rejected', rejectedAt: now, version: { increment: 1 } } })),
    ...losers.map((entity) => prisma.intelligenceEntity.update({ where: { id: entity.id }, data: { status: 'merged', mergedIntoId: target.id } })),
    prisma.intelligenceEntityAction.update({ where: { id: action.id }, data: {
      status: 'applied', targetEntityIds: [target.id], appliedAt: now,
      afterJson: json({ targetEntityId: target.id, movedMembershipIds: movable.map((row) => row.id), rejectedDuplicateMembershipIds: duplicates.map((row) => row.id) }),
      rollbackJson: json({
        membershipStates: losers.flatMap((entity) => entity.memberships.map((membership) => ({
          id: membership.id, entityId: entity.id, status: membership.status,
          rejectedAt: membership.rejectedAt?.toISOString() ?? null
        }))),
        loserEntityIds: losers.map((entity) => entity.id)
      })
    }})
  ]);
  await refreshOneEntity(prisma, target.id, now, 'merge_applied');
  return prisma.intelligenceEntityAction.findUniqueOrThrow({ where: { id: action.id } });
}

export async function proposeEntitySplit(prisma: PrismaClient, entityId: string, input: Omit<EntityActionInput, 'sourceEntityIds'>) {
  const now = input.now ?? new Date();
  const evidenceTypes = unique(input.independentEvidenceTypes.map((value) => value.toLowerCase())).sort();
  const memberships = await prisma.intelligenceEntityMembership.findMany({ where: { entityId, id: { in: input.membershipIds ?? [] } } });
  if (!memberships.length) throw new Error('entity_split_requires_memberships');
  const eligible = evidenceTypes.length >= 2;
  const actionKey = hash(`entity-split|${entityId}|${memberships.map((row) => row.id).sort().join(',')}|${evidenceTypes.join(',')}|${now.toISOString()}`);
  return prisma.intelligenceEntityAction.create({ data: {
    actionKey, actionType: 'split', status: eligible ? 'proposed' : 'rejected', sourceEntityIds: [entityId], targetEntityIds: [],
    membershipIds: memberships.map((row) => row.id), independentEvidenceTypes: evidenceTypes,
    beforeJson: json(memberships.map((row) => ({ id: row.id, entityId: row.entityId, profileId: row.profileId, status: row.status }))),
    afterJson: json({}), reasons: input.reasons, evidenceJson: json({ supplied: input.evidence ?? null, eligible }), rollbackJson: json({}),
    ruleVersion: ADAPTIVE_RULE_VERSION, proposedAt: now
  }});
}

export async function applyEntitySplit(prisma: PrismaClient, actionId: string, now = new Date()) {
  const action = await prisma.intelligenceEntityAction.findUnique({ where: { id: actionId } });
  if (!action || action.actionType !== 'split' || action.status !== 'proposed') throw new Error('entity_split_not_applicable');
  if (action.independentEvidenceTypes.length < 2) throw new Error('entity_split_requires_two_independent_evidence_types');
  const source = await prisma.intelligenceEntity.findUniqueOrThrow({ where: { id: action.sourceEntityIds[0] } });
  const memberships = await prisma.intelligenceEntityMembership.findMany({ where: { id: { in: action.membershipIds }, entityId: source.id } });
  if (!memberships.length) throw new Error('entity_split_memberships_changed');
  const entityKey = `ie_split_${hash(`${source.entityKey}|${action.id}`).slice(0, 24)}`;
  const target = await prisma.intelligenceEntity.create({ data: {
    entityKey, label: `${source.label} split`, type: source.type, status: 'active',
    identityConfidence: weightedAverage(memberships.map((row) => ({ value: row.identityConfidence, weight: 1 }))),
    currentRelevance: weightedAverage(memberships.map((row) => ({ value: row.currentRelevance, weight: 1 }))),
    historicalAlphaScore: source.historicalAlphaScore, historicalAlphaConfidence: source.historicalAlphaConfidence,
    wakeUpPotential: source.wakeUpPotential, evidenceFreshness: weightedAverage(memberships.map((row) => ({ value: row.evidenceFreshness, weight: 1 }))),
    monitoringPriority: source.monitoringPriority, chains: source.chains, clusterKeys: source.clusterKeys,
    coreWalletCount: memberships.filter((row) => row.scope === 'core').length,
    peripheralWalletCount: memberships.filter((row) => row.scope === 'peripheral').length,
    firstDiscoveredAt: now, lastEvidenceAt: now, lastCoreActivityAt: source.lastCoreActivityAt,
    lastActivityAt: source.lastActivityAt, dormantSince: source.dormantSince,
    provenanceJson: json({ sourceActionId: action.id, splitFromEntityId: source.id, ruleVersion: ADAPTIVE_RULE_VERSION })
  }});
  await prisma.$transaction([
    ...memberships.map((membership) => prisma.intelligenceEntityMembership.update({ where: { id: membership.id }, data: { entityId: target.id, version: { increment: 1 } } })),
    prisma.intelligenceEntityAction.update({ where: { id: action.id }, data: {
      status: 'applied', targetEntityIds: [target.id], appliedAt: now,
      afterJson: json({ targetEntityId: target.id, membershipIds: memberships.map((row) => row.id) }),
      rollbackJson: json({ sourceEntityId: source.id, membershipIds: memberships.map((row) => row.id), targetEntityId: target.id })
    }})
  ]);
  await refreshOneEntity(prisma, source.id, now, 'split_applied');
  await refreshOneEntity(prisma, target.id, now, 'split_applied');
  return prisma.intelligenceEntityAction.findUniqueOrThrow({ where: { id: action.id } });
}

export async function rollbackEntityAction(prisma: PrismaClient, actionId: string, now = new Date()) {
  const action = await prisma.intelligenceEntityAction.findUnique({ where: { id: actionId } });
  if (!action || action.status !== 'applied') throw new Error('entity_action_not_rollbackable');
  const rollback = asRecord(action.rollbackJson);
  if (action.actionType === 'split') {
    const sourceEntityId = String(rollback.sourceEntityId ?? '');
    const membershipIds = stringArray(rollback.membershipIds);
    const targetEntityId = String(rollback.targetEntityId ?? '');
    await prisma.$transaction([
      ...membershipIds.map((id) => prisma.intelligenceEntityMembership.update({ where: { id }, data: { entityId: sourceEntityId, version: { increment: 1 } } })),
      prisma.intelligenceEntity.update({ where: { id: targetEntityId }, data: { status: 'split_rolled_back' } }),
      prisma.intelligenceEntityAction.update({ where: { id: action.id }, data: { status: 'rolled_back', rolledBackAt: now } })
    ]);
    await refreshOneEntity(prisma, sourceEntityId, now, 'split_rollback');
  } else if (action.actionType === 'merge') {
    const states = Array.isArray(rollback.membershipStates) ? rollback.membershipStates : [];
    const updates = states.flatMap((value) => {
      const state = asRecord(value);
      if (typeof state.id !== 'string' || typeof state.entityId !== 'string' || typeof state.status !== 'string') return [];
      return [prisma.intelligenceEntityMembership.update({ where: { id: state.id }, data: {
        entityId: state.entityId, status: state.status,
        rejectedAt: typeof state.rejectedAt === 'string' ? new Date(state.rejectedAt) : null,
        version: { increment: 1 }
      } })];
    });
    const loserIds = stringArray(rollback.loserEntityIds);
    await prisma.$transaction([
      ...updates,
      ...loserIds.map((id) => prisma.intelligenceEntity.update({ where: { id }, data: { status: 'active', mergedIntoId: null } })),
      prisma.intelligenceEntityAction.update({ where: { id: action.id }, data: { status: 'rolled_back', rolledBackAt: now } })
    ]);
  }
  return prisma.intelligenceEntityAction.findUniqueOrThrow({ where: { id: action.id } });
}

async function refreshOneEntity(prisma: PrismaClient, entityId: string, now: Date, cause: string) {
  const entity = await prisma.intelligenceEntity.findUnique({ where: { id: entityId }, include: { memberships: { include: { profile: true } } } });
  if (!entity) return;
  const active = entity.memberships.filter((row) => row.status !== 'rejected' && row.scope !== 'infrastructure');
  const core = active.filter((row) => row.scope === 'core');
  const nextVersion = entity.currentVersion + 1;
  await prisma.$transaction([
    prisma.intelligenceEntity.update({ where: { id: entity.id }, data: {
      coreWalletCount: core.length, peripheralWalletCount: active.length - core.length,
      identityConfidence: weightedAverage(active.map((row) => ({ value: row.identityConfidence, weight: row.scope === 'core' ? 1 : 0.3 }))),
      currentRelevance: weightedAverage(active.map((row) => ({ value: row.currentRelevance, weight: row.scope === 'core' ? 1 : 0.3 }))),
      lastEvidenceAt: now, currentVersion: nextVersion
    }}),
    prisma.intelligenceEntityVersion.create({ data: {
      entityId: entity.id, version: nextVersion, cause,
      identityConfidence: entity.identityConfidence, currentRelevance: entity.currentRelevance,
      historicalAlphaScore: entity.historicalAlphaScore, historicalAlphaConfidence: entity.historicalAlphaConfidence,
      wakeUpPotential: entity.wakeUpPotential, evidenceFreshness: entity.evidenceFreshness,
      coreWalletRefs: core.map((row) => `${row.profile.chain}:${row.profile.address}`),
      peripheralWalletRefs: active.filter((row) => row.scope !== 'core').map((row) => `${row.profile.chain}:${row.profile.address}`),
      evidenceJson: json({ membershipIds: active.map((row) => row.id) }), provenanceJson: json({ cause }),
      ruleVersion: ADAPTIVE_RULE_VERSION, observedAt: now
    }})
  ]);
}

async function loadRegistry(prisma: PrismaClient, profiles: ProfileWithCluster[]) {
  const rows = [] as Awaited<ReturnType<PrismaClient['addressRegistry']['findMany']>>;
  for (const [chain, chainProfiles] of groupBy(profiles, (profile) => profile.chain)) {
    for (const part of chunks(unique(chainProfiles.map((profile) => profile.address)), 5_000)) {
      rows.push(...await prisma.addressRegistry.findMany({ where: { chain, address: { in: part } } }));
    }
  }
  return rows;
}

function canonicalEntityKey(profile: ProfileWithCluster) {
  return profile.entityKey ? `ie_${hash(`entity-key|${profile.entityKey}`).slice(0, 24)}` : `ie_${hash(`cluster-key|${profile.cluster.clusterKey}`).slice(0, 24)}`;
}
function entityType(roles: string[]) {
  if (roles.some((role) => /insider/i.test(role))) return 'insider_group';
  if (roles.some((role) => /operator|root/i.test(role))) return 'funding_structure';
  if (roles.some((role) => /deployer|lp/i.test(role))) return 'deployer_group';
  if (roles.some((role) => /funding|collector/i.test(role))) return 'funding_structure';
  if (roles.some((role) => /execution|trader/i.test(role))) return 'trading_operation';
  return 'anonymous_cluster';
}
function entityLabel(entityKey: string, profiles: ProfileWithCluster[]) { const named = profiles.find((profile) => profile.entityKey)?.entityKey; return named ? `Entity ${named}`.slice(0, 120) : `Entity ${entityKey.slice(-8)}`; }
function entityReceipt(entity: IntelligenceEntity & { memberships: Array<{ id: string; profileId: string; status: string }> }) { return { id: entity.id, entityKey: entity.entityKey, status: entity.status, currentVersion: entity.currentVersion, memberships: entity.memberships }; }
const PRIORITY_ORDER = ['fresh_receiver_hot', 'root_permanent', 'strong_link', 'probable_link', 'standard', 'weak_cold', 'cold_archive'];
function bestPriority(values: IntelligenceEntity['monitoringPriority'][]) { return values.sort((a, b) => PRIORITY_ORDER.indexOf(a) - PRIORITY_ORDER.indexOf(b))[0] ?? 'weak_cold'; }
function weightedAverage(rows: Array<{ value: number; weight: number }>) { const total = rows.reduce((sum, row) => sum + row.weight, 0); return total ? rows.reduce((sum, row) => sum + row.value * row.weight, 0) / total : 0; }
function groupBy<T, K>(values: T[], key: (value: T) => K) { const map = new Map<K, T[]>(); for (const value of values) map.set(key(value), [...(map.get(key(value)) ?? []), value]); return map; }
function chunks<T>(values: T[], size: number) { const result: T[][] = []; for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size)); return result; }
function unique<T>(values: T[]) { return [...new Set(values)]; }
function jsonStrings(value: Prisma.JsonValue, key: string) { const row = asRecord(value); return stringArray(row[key]); }
function stringArray(value: unknown) { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []; }
function jsonField(value: Prisma.JsonValue, key: string) { const row = asRecord(value); return typeof row[key] === 'string' ? row[key] as string : null; }
function jsonNumber(value: Prisma.JsonValue, key: string) { const row = asRecord(value); const number = Number(row[key]); return Number.isFinite(number) ? number : null; }
function asRecord(value: Prisma.JsonValue | unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function latestDate(...values: Array<Date | null | undefined>) { return values.filter((value): value is Date => Boolean(value)).sort((a, b) => b.getTime() - a.getTime())[0] ?? null; }
function earliestDate(...values: Array<Date | null | undefined>) { return values.filter((value): value is Date => Boolean(value)).sort((a, b) => a.getTime() - b.getTime())[0] ?? null; }
function daysBetween(from: Date, to: Date) { return Math.max(0, (to.getTime() - from.getTime()) / 86_400_000); }
function clamp01(value: number) { return Math.max(0, Math.min(1, value)); }
function round(value: number, digits = 4) { const scale = 10 ** digits; return Math.round(value * scale) / scale; }
function hash(value: string) { return createHash('sha256').update(value).digest('hex'); }
function json(value: unknown): Prisma.InputJsonValue { return value as Prisma.InputJsonValue; }
