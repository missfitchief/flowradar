import { createHash, randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { ADAPTIVE_MODEL_VERSION, ADAPTIVE_RULE_VERSION, ADAPTIVE_THRESHOLDS, ADAPTIVE_WEIGHTS } from './adaptive';
import { runEntityDecayPass, syncIntelligenceEntities } from './entities';
import { enrollObservationWallet, monitoringTierForRole } from './monitoring';
import { loadAdaptivePerformanceMetrics, runAdaptiveReplay, runIntelligenceOutcomePass } from './outcomes';

/** Idempotent/resumable projection backfill. Legacy signal scores are never
 * presented as freshly decomposed adaptive scores; their receipt is explicitly
 * marked legacy/unknown and outcomes still use strict signal-time snapshots. */
export async function runAdaptiveIntelligenceBackfill(prisma: PrismaClient, options: { runId?: string; now?: Date } = {}) {
  const now = options.now ?? new Date();
  const runId = options.runId ?? randomUUID();
  const existingRun = await prisma.intelligenceBackfillRun.findUnique({ where: { id: runId } });
  if (!existingRun) {
    await prisma.intelligenceBackfillRun.create({ data: {
      id: runId, backfillType: 'adaptive_intelligence_v1', status: 'running', cursorJson: json({ phase: 'entities' }),
      errorsJson: json([]), ruleVersion: ADAPTIVE_RULE_VERSION, startedAt: now
    }});
  } else if (existingRun.status === 'completed') {
    return { runId, resumed: true, status: 'completed', metrics: await loadAdaptivePerformanceMetrics(prisma) };
  } else {
    await prisma.intelligenceBackfillRun.update({ where: { id: runId }, data: { status: 'running' } });
  }

  await prisma.intelligenceModelVersion.upsert({
    where: { version: ADAPTIVE_MODEL_VERSION },
    create: {
      version: ADAPTIVE_MODEL_VERSION, status: 'active', weightsJson: json(ADAPTIVE_WEIGHTS), thresholdsJson: json(ADAPTIVE_THRESHOLDS),
      trainingWindowJson: json({ source: 'initial_rule_model' }), validationWindowJson: json({ source: 'initial_rule_model' }),
      holdoutWindowJson: json({ source: 'initial_rule_model' }), metricsJson: json({ initial: true, automaticPromotion: false }),
      source: 'checked_in_rule_model', approvedAt: now, activatedAt: now
    }, update: {}
  });

  try {
    const legacyKnowledge = await backfillLegacyKnowledge(prisma, now);
    const entityReport = await syncIntelligenceEntities(prisma, { now, cause: `backfill:${runId}` });
    await prisma.intelligenceBackfillRun.update({ where: { id: runId }, data: {
      cursorJson: json({ phase: 'legacy_signals' }), scannedCount: entityReport.profilesScanned,
      createdCount: entityReport.entitiesCreated + entityReport.membershipsCreated,
      updatedCount: entityReport.entitiesUpdated + entityReport.membershipsUpdated,
      unknownCount: entityReport.infrastructureRejected
    }});

    const signals = await prisma.intelligenceSignal.findMany({ orderBy: [{ activatedAt: 'asc' }, { id: 'asc' }] });
    let legacySignalsUpdated = 0;
    let legacySignalUnknowns = 0;
    for (const signal of signals) {
      const adaptiveAlready = signal.modelVersion >= ADAPTIVE_MODEL_VERSION && signal.ruleVersion >= ADAPTIVE_RULE_VERSION
        && Object.keys(asRecord(signal.scoreDecompositionJson)).length > 0;
      if (adaptiveAlready) continue;
      const memberships = await prisma.intelligenceEntityMembership.findMany({
        where: { profile: { cluster: { clusterKey: { in: signal.clusterKeys } } }, status: { not: 'rejected' }, scope: { not: 'infrastructure' } },
        include: { entity: true }
      });
      const entityIds = unique(memberships.map((row) => row.entityId));
      const token = await prisma.token.findUnique({ where: { chain_address: { chain: signal.chain, address: signal.tokenAddress } }, select: { id: true } });
      const entry = token ? await prisma.tokenMarketSnapshot.findFirst({ where: { tokenId: token.id, ts: { lte: signal.activatedAt } }, orderBy: [{ ts: 'desc' }, { id: 'desc' }] }) : null;
      await prisma.intelligenceSignal.update({ where: { id: signal.id }, data: {
        entityIds,
        independentEntityCount: entityIds.length,
        coreWalletCount: memberships.filter((row) => row.scope === 'core').length,
        peripheralWalletCount: memberships.filter((row) => row.scope === 'peripheral').length,
        scoreDecompositionJson: json({
          legacyScore: { raw: signal.score / 100, weight: 100, contribution: signal.score, explanation: 'Legacy score retained; adaptive component decomposition unknown at original signal time.' }
        }),
        entryMarketJson: json({
          capturedAt: signal.activatedAt.toISOString(), snapshotId: entry?.id ?? null, snapshotTs: entry?.ts.toISOString() ?? null,
          priceUsd: decimal(entry?.priceUsd), marketCapUsd: decimal(entry?.marketCapUsd), liquidityUsd: decimal(entry?.liquidityUsd),
          provenance: 'legacy_signal_time_backfill', noLookahead: Boolean(!entry || entry.ts <= signal.activatedAt)
        }),
        rejectionReceiptJson: signal.qualityAssessmentId ? Prisma.JsonNull : json({ reason: 'legacy_quality_assessment_unavailable', unknown: true }),
        lifecycleStage: signal.level,
        modelVersion: 0,
        ruleVersion: 0
      }});
      legacySignalsUpdated += 1;
      if (!entry || !entityIds.length) legacySignalUnknowns += 1;
    }

    await prisma.intelligenceBackfillRun.update({ where: { id: runId }, data: {
      cursorJson: json({ phase: 'outcomes' }), scannedCount: { increment: signals.length },
      updatedCount: { increment: legacySignalsUpdated }, unknownCount: { increment: legacySignalUnknowns }
    }});
    const [outcomes, decay] = await Promise.all([
      runIntelligenceOutcomePass(prisma, { now, take: 100_000 }),
      runEntityDecayPass(prisma, now)
    ]);
    await prisma.intelligenceBackfillRun.update({ where: { id: runId }, data: { cursorJson: json({ phase: 'replay' }) } });
    const replay = await runAdaptiveReplay(prisma, now);
    const metrics = await loadAdaptivePerformanceMetrics(prisma);
    await prisma.intelligenceBackfillRun.update({ where: { id: runId }, data: {
      status: 'completed', cursorJson: json({ phase: 'completed' }), completedAt: new Date(),
      updatedCount: { increment: outcomes.horizonsUpserted + decay.entitiesUpdated }
    }});
    return { runId, resumed: Boolean(existingRun), status: 'completed', legacyKnowledge, entityReport, legacySignalsUpdated, legacySignalUnknowns, outcomes, decay, replay, metrics };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.intelligenceBackfillRun.update({ where: { id: runId }, data: {
      status: 'failed', errorCount: { increment: 1 }, errorsJson: json([{ at: new Date().toISOString(), message }]), completedAt: new Date()
    }});
    throw error;
  }
}

async function backfillLegacyKnowledge(prisma: PrismaClient, now: Date) {
  const [unified, dnaRows, roleRows] = await Promise.all([
    prisma.unifiedEntity.findMany({ include: { addresses: true }, orderBy: { entityKey: 'asc' } }),
    prisma.walletDnaProfile.findMany(),
    prisma.walletRoleAssignment.findMany({ orderBy: { confidence: 'desc' } })
  ]);
  const dnaByRef = new Map(dnaRows.map((row) => [`${row.chain}:${row.walletAddress}`, row]));
  const roleByRef = new Map(roleRows.map((row) => [`${row.chain}:${row.walletAddress}`, row]));
  let candidates = 0;
  let profilesCreated = 0;
  let profilesPreserved = 0;
  let observationsCreated = 0;
  let clustersCreated = 0;
  let infrastructureSkipped = 0;
  for (const unifiedEntity of unified) {
    const entityEvidenceTypes = unifiedEvidenceTypes(unifiedEntity.evidenceJson);
    const qualified = unifiedEntity.addresses.filter((address) => {
      const dna = dnaByRef.get(`${address.chain}:${address.address}`);
      const role = roleByRef.get(`${address.chain}:${address.address}`);
      if (/service|router|cex|contract|pool|vault/i.test(`${address.role} ${role?.role ?? ''}`)) { infrastructureSkipped += 1; return false; }
      if (dna && dna.confidence >= 0.35 && dna.coverage !== 'minimal') return true;
      const safeRole = /root|funding|execution|profit|bridge|dormant|fresh/i.test(address.role) && !/unknown|possible/i.test(address.role);
      const safeTier = /direct|repeated|exact_bridge|verified_official_bridge|operator_seed|relationship_tier/i.test(`${address.evidenceTier} ${role?.evidenceTier ?? ''}`);
      return safeRole && safeTier && Math.max(normalize01(address.confidence), normalize01(role?.confidence ?? 0)) >= 0.5;
    });
    if (!qualified.length) continue;
    const clusterKey = `ic_legacy_${hash(unifiedEntity.entityKey).slice(0, 20)}`;
    const existingCluster = await prisma.intelligenceCluster.findUnique({ where: { clusterKey } });
    const cluster = await prisma.intelligenceCluster.upsert({
      where: { clusterKey },
      create: {
        clusterKey, entityKey: unifiedEntity.entityKey, confidence: normalize01(unifiedEntity.confidence), walletCount: 0,
        firstDiscoveredAt: unifiedEntity.createdAt, lastEvidenceAt: unifiedEntity.computedAt,
        evidenceJson: json({ source: 'unified_entity_backfill', unifiedEntityId: unifiedEntity.id, evidence: unifiedEntity.evidenceJson, caveats: unifiedEntity.caveats })
      },
      update: { lastEvidenceAt: unifiedEntity.computedAt }
    });
    if (!existingCluster) clustersCreated += 1;
    for (const address of qualified) {
      candidates += 1;
      const dna = dnaByRef.get(`${address.chain}:${address.address}`);
      const role = roleByRef.get(`${address.chain}:${address.address}`);
      const existing = await prisma.walletIntelligenceProfile.findUnique({ where: { chain_address: { chain: address.chain, address: address.address } } });
      if (existing) { profilesPreserved += 1; continue; }
      const evidenceTypes = unique([address.evidenceTier, role?.evidenceTier, ...entityEvidenceTypes].filter(nonNull).map(normalizeEvidenceType));
      const confidence = Math.max(normalize01(address.confidence), normalize01(role?.confidence ?? 0), normalize01(dna?.confidence ?? 0));
      const evidenceScore = Math.round(Math.min(100, confidence * 70 + Math.min(30, evidenceTypes.length * 10)));
      const alpha = dnaAlpha(dna);
      const wake = dnaWake(dna);
      const discoveredAt = earliestDate(address.createdAt, dna?.createdAt, role?.createdAt) ?? now;
      const lastObservedAt = latestDate(address.updatedAt, dna?.computedAt, role?.computedAt) ?? now;
      const enrollment = await enrollObservationWallet(prisma, {
        chain: address.chain, address: address.address, role: address.role,
        reason: `adaptive_legacy_backfill:${unifiedEntity.entityKey}`, firstSeenAt: discoveredAt, lastActiveAt: lastObservedAt, now
      });
      const profile = await prisma.walletIntelligenceProfile.create({ data: {
        walletId: enrollment.wallet.id, chain: address.chain, address: address.address, clusterId: cluster.id,
        entityKey: unifiedEntity.entityKey, role: preferredRole(address.role, role?.role), evidenceScore,
        sourceScore: null, rawHistoricalAlphaScore: alpha.rawScore,
        sampleAdjustedAlphaScore: alpha.score, alphaConfidence: alpha.sampleConfidence,
        alphaSampleSize: alpha.sampleSize, alphaCalibrationJson: json(alpha),
        historicalAlphaScore: alpha.score, wakeUpPotential: wake, confidence,
        intelligenceStatus: intelligenceStatus(enrollment.wallet.lastActiveAt, alpha.score, wake, now),
        tier: evidenceScore >= 80 && alpha.score >= 60 ? 'A' : evidenceScore >= 55 || alpha.score >= 50 ? 'B' : 'C',
        discoverySource: 'legacy_unified_entity_backfill', lastDiscoverySource: 'legacy_unified_entity_backfill',
        firstDiscoveredAt: discoveredAt, lastObservedAt, lastActivityAt: enrollment.wallet.lastActiveAt,
        monitoringPriority: monitoringTierForRole(preferredRole(address.role, role?.role)),
        reasonAdded: `Evidence-backed legacy knowledge: ${evidenceTypes.join(', ')}`.slice(0, 500),
        observationCount: 1, independentSignals: evidenceTypes.length, evidenceSignals: evidenceTypes,
        supportingEvidenceJson: json({
          unifiedEntityId: unifiedEntity.id, unifiedEntityKey: unifiedEntity.entityKey, unifiedAddressId: address.id,
          roleAssignmentId: role?.id ?? null, dnaProfileId: dna?.id ?? null, historicalSampleSize: alpha.sampleSize,
          alphaCalibration: alpha, sourceReceipts: { unified: address.evidenceJson, role: role?.receiptsJson ?? null, dna: dna?.receiptsJson ?? null }
        }),
        contradictingEvidenceJson: json({ caveats: [...unifiedEntity.caveats, ...(role?.caveats ?? []), ...(dna?.caveats ?? [])], negativeEvidence: dna?.negativeEvidenceJson ?? null }),
        scoreVersion: ADAPTIVE_RULE_VERSION
      }});
      profilesCreated += 1;
      const observationKey = hash(`legacy-profile-observation|${profile.id}|${unifiedEntity.computedAt.toISOString()}|v${ADAPTIVE_RULE_VERSION}`);
      await prisma.walletIntelligenceObservation.upsert({ where: { observationKey }, create: {
        observationKey, profileId: profile.id, discoverySource: 'legacy_unified_entity_backfill', entityKey: unifiedEntity.entityKey,
        role: profile.role, evidenceScore, sourceScore: null, rawHistoricalAlphaScore: alpha.rawScore,
        sampleAdjustedAlphaScore: alpha.score, alphaConfidence: alpha.sampleConfidence,
        alphaSampleSize: alpha.sampleSize, alphaCalibrationJson: json(alpha),
        historicalAlphaScore: alpha.score, wakeUpPotential: wake, intelligenceStatus: profile.intelligenceStatus, confidence,
        previousConfidence: null, confidenceDelta: 0, tier: profile.tier, independentSignals: evidenceTypes.length,
        evidenceSignals: evidenceTypes, supportingEvidenceJson: json(profile.supportingEvidenceJson),
        contradictingEvidenceJson: json(profile.contradictingEvidenceJson),
        reasonJson: json({ qualification: dna ? 'wallet_dna_quality' : 'safe_role_and_evidence_tier', alpha }),
        evidenceHash: hash(JSON.stringify({ evidenceTypes, alpha, confidence, unified: unifiedEntity.entityKey })),
        scoreVersion: ADAPTIVE_RULE_VERSION, observedAt: lastObservedAt
      }, update: {} });
      observationsCreated += 1;
    }
    const count = await prisma.walletIntelligenceProfile.count({ where: { clusterId: cluster.id } });
    await prisma.intelligenceCluster.update({ where: { id: cluster.id }, data: { walletCount: count } });
  }
  return { unifiedEntitiesScanned: unified.length, candidates, profilesCreated, profilesPreserved, observationsCreated, clustersCreated, infrastructureSkipped };
}

type DnaRow = NonNullable<Awaited<ReturnType<PrismaClient['walletDnaProfile']['findFirst']>>>;
function dnaAlpha(dna: DnaRow | null | undefined) {
  if (!dna) return { rawScore: 35, score: 35, sampleConfidence: 0, sampleSize: 0, source: 'unknown' };
  const n = dna.completedPositions;
  const sampleConfidence = 1 - Math.exp(-n / 18);
  const hit = dna.winRate ?? 0.35;
  const median = dna.medianReturn ?? dna.avgReturn ?? 0;
  const returnQuality = Math.max(0, Math.min(1, (median + 100) / 300));
  const repeatQuality = Math.min(1, (dna.repeatRunnerCount ?? 0) / Math.max(3, n));
  const oneWinnerPenalty = Math.max(0, Math.min(1, dna.oneWinnerDependence ?? 0));
  const rugPenalty = Math.max(0, Math.min(1, dna.deadRugExposureRate ?? 0));
  const raw = 100 * (hit * 0.4 + returnQuality * 0.25 + repeatQuality * 0.15 + (1 - oneWinnerPenalty) * 0.1 + (1 - rugPenalty) * 0.1);
  return { rawScore: round(raw, 2), score: round(raw * sampleConfidence + 35 * (1 - sampleConfidence), 2), sampleConfidence: round(sampleConfidence, 4), sampleSize: n, source: 'wallet_dna_bayesian_summary', oneWinnerPenalty, rugPenalty };
}
function intelligenceStatus(lastActivityAt: Date | null, alpha: number, wake: number, now: Date) {
  const dormant = Boolean(lastActivityAt && now.getTime() - lastActivityAt.getTime() >= 30 * 86_400_000);
  if (dormant && (alpha >= 50 || wake >= 55)) return 'dormant_high_value';
  if (dormant) return 'dormant_alpha';
  return alpha >= 45 ? 'active_alpha' : 'inactive_low_value';
}
function dnaWake(dna: DnaRow | null | undefined) {
  if (!dna) return 20;
  const dormancy = asRecord(dna.dormancySummaryJson);
  const maxDays = Math.max(numberValue(dormancy.maxCoveredDormantDays) ?? 0, numberValue(dormancy.dormantDays) ?? 0);
  return round(Math.min(100, dnaAlpha(dna).score * 0.65 + Math.min(35, maxDays / 3)), 2);
}
function unifiedEvidenceTypes(value: Prisma.JsonValue) { const links = Array.isArray(asRecord(value).links) ? asRecord(value).links as unknown[] : []; return unique(links.map((link) => normalizeEvidenceType(String(asRecord(link).kind ?? ''))).filter(Boolean)); }
function normalizeEvidenceType(value: string) { const lower = value.toLowerCase(); if (/direct/.test(lower)) return 'direct_funding'; if (/multi.?hop/.test(lower)) return 'multi_hop_funding'; if (/bridge/.test(lower)) return 'exact_bridge'; if (/same_evm/.test(lower)) return 'same_evm_account'; if (/operator/.test(lower)) return 'operator_seed'; if (/repeat/.test(lower)) return 'repeated_behavior'; if (/execution/.test(lower)) return 'execution_pattern'; if (/relationship/.test(lower)) return 'relationship_tier'; if (/top.?pnl|profitable/.test(lower)) return 'historical_alpha'; return lower.replace(/[^a-z0-9]+/g, '_'); }
function preferredRole(primary: string, secondary?: string) { const values = [primary, secondary].filter(nonNull); const order = ['root_main', 'operator_root', 'funding_wallet', 'execution_wallet', 'profit_collection_wallet', 'bridge_linked_receiver', 'dormant_funded_receiver', 'fresh_funded_receiver', 'probable_side_wallet', 'unknown_related_wallet']; const rank = (role: string) => { const index = order.indexOf(role); return index < 0 ? order.length : index; }; return values.sort((a, b) => rank(a) - rank(b))[0] ?? 'unknown_related_wallet'; }
function earliestDate(...values: Array<Date | null | undefined>) { return values.filter(nonNull).sort((a, b) => a.getTime() - b.getTime())[0] ?? null; }
function latestDate(...values: Array<Date | null | undefined>) { return values.filter(nonNull).sort((a, b) => b.getTime() - a.getTime())[0] ?? null; }
function normalize01(value: number) { return Math.max(0, Math.min(1, value > 1 ? value / 100 : value)); }
function numberValue(value: unknown) { const number = Number(value); return Number.isFinite(number) ? number : null; }
function round(value: number, digits = 4) { const scale = 10 ** digits; return Math.round(value * scale) / scale; }
function hash(value: string) { return createHash('sha256').update(value).digest('hex'); }
function nonNull<T>(value: T | null | undefined): value is T { return value !== null && value !== undefined; }

function decimal(value: unknown) { if (value === null || value === undefined) return null; const number = Number(value); return Number.isFinite(number) ? number : null; }
function unique<T>(values: T[]) { return [...new Set(values)]; }
function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function json(value: unknown): Prisma.InputJsonValue { return value as Prisma.InputJsonValue; }
