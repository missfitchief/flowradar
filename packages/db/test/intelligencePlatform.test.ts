import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { InvestigationMember, WalletInvestigationResult } from '../src/investigation/types';
import { prisma } from '../src/client';
import { persistInvestigationKnowledge } from '../src/intelligence/knowledge';
import { intelligenceSignalLevelForScore, runIntelligenceLifecycle } from '../src/intelligence/lifecycle';
import { applyEntityMerge, proposeEntityMerge, rollbackEntityAction } from '../src/intelligence/entities';
import { runIntelligenceOutcomePass } from '../src/intelligence/outcomes';
import { OperatorService } from '../src/operator/service';

const PREFIX = 'INTELLIGENCE_PLATFORM_TEST';
const ADDRESSES = ['a1', 'b2', 'c3', 'd4'].map((byte) => `0x${byte.repeat(20)}`);
const TOKENS = ['e1', 'e2', 'e3'].map((byte) => `0x${byte.repeat(20)}`);
const NOW = new Date('2038-01-15T12:00:00Z');

async function cleanup() {
  await prisma.operatorWatchAlert.deleteMany({ where: { watch: { userId: PREFIX } } });
  await prisma.operatorWatch.deleteMany({ where: { userId: PREFIX } });
  await prisma.intelligenceBuyCandidate.deleteMany({ where: { tokenAddress: { in: TOKENS } } });
  await prisma.intelligenceSignalOutcomeLabel.deleteMany({ where: { signal: { tokenAddress: { in: TOKENS } } } });
  await prisma.intelligenceSignalOutcome.deleteMany({ where: { signal: { tokenAddress: { in: TOKENS } } } });
  await prisma.intelligenceSignal.deleteMany({ where: { tokenAddress: { in: TOKENS } } });
  await prisma.tokenQualityAssessment.deleteMany({ where: { tokenAddress: { in: TOKENS } } });
  await prisma.trackedTokenActivationAlert.deleteMany({ where: { tokenAddress: { in: TOKENS } } });
  await prisma.walletIntelligenceEvent.deleteMany({ where: { walletAddress: { in: ADDRESSES } } });
  await prisma.walletIntelligenceObservation.deleteMany({ where: { profile: { address: { in: ADDRESSES } } } });
  await prisma.intelligenceClusterObservation.deleteMany({ where: { cluster: { profiles: { some: { address: { in: ADDRESSES } } } } } });
  await prisma.intelligenceClusterMerge.deleteMany({ where: { OR: [{ fromCluster: { profiles: { some: { address: { in: ADDRESSES } } } } }, { intoCluster: { profiles: { some: { address: { in: ADDRESSES } } } } }] } });
  const testProfiles = await prisma.walletIntelligenceProfile.findMany({ where: { address: { in: ADDRESSES } }, select: { id: true, clusterId: true } });
  const clusterIds = testProfiles.map((row) => row.clusterId);
  const entityIds = (await prisma.intelligenceEntityMembership.findMany({ where: { profileId: { in: testProfiles.map((row) => row.id) } }, select: { entityId: true } })).map((row) => row.entityId);
  await prisma.intelligenceEntityMembership.deleteMany({ where: { profileId: { in: testProfiles.map((row) => row.id) } } });
  await prisma.walletIntelligenceProfile.deleteMany({ where: { address: { in: ADDRESSES } } });
  if (clusterIds.length) {
    await prisma.intelligenceClusterMerge.deleteMany({ where: { OR: [{ fromClusterId: { in: clusterIds } }, { intoClusterId: { in: clusterIds } }] } });
    await prisma.intelligenceClusterObservation.deleteMany({ where: { clusterId: { in: clusterIds } } });
    await prisma.intelligenceCluster.deleteMany({ where: { id: { in: clusterIds } } });
  }
  if (entityIds.length) {
    await prisma.intelligenceEntityAction.deleteMany({ where: { OR: [{ sourceEntityIds: { hasSome: entityIds } }, { targetEntityIds: { hasSome: entityIds } }] } });
    await prisma.intelligenceEntityDecaySnapshot.deleteMany({ where: { entityId: { in: entityIds } } });
    await prisma.intelligenceEntityVersion.deleteMany({ where: { entityId: { in: entityIds } } });
    await prisma.intelligenceEntity.deleteMany({ where: { id: { in: entityIds }, memberships: { none: {} } } });
  }
  await prisma.intelligenceLifecycleRun.deleteMany({ where: { startedAt: { gte: new Date('2038-01-01T00:00:00Z') } } });
  await prisma.massTransactionEvent.deleteMany({ where: { eventId: { startsWith: PREFIX } } });
  await prisma.monitoringSubscription.deleteMany({ where: { wallet: { address: { in: ADDRESSES } } } });
  await prisma.wallet.deleteMany({ where: { address: { in: ADDRESSES } } });
  await prisma.tokenRiskSnapshot.deleteMany({ where: { tokenAddress: { in: TOKENS } } });
  await prisma.tokenMarketSnapshot.deleteMany({ where: { token: { address: { in: TOKENS } } } });
  await prisma.token.deleteMany({ where: { address: { in: TOKENS } } });
}

beforeEach(cleanup);
afterAll(async () => { await cleanup(); await prisma.$disconnect(); });

describe('persistent intelligence platform', () => {
  it('accumulates wallet conclusions, evolves confidence, and merges overlapping clusters without deleting history', async () => {
    const first = investigation('inv-1', NOW, [member(ADDRESSES[0], 'entity-alpha', 72, 65, 62), member(ADDRESSES[1], 'entity-alpha', 70, 60, 58)]);
    const firstReport = await persistInvestigationKnowledge(prisma, first, { now: NOW });
    expect(firstReport).toMatchObject({ qualifiedWallets: 2, profilesCreated: 2, observationsAppended: 2, clustersCreated: 1 });

    const original = await prisma.walletIntelligenceProfile.findUniqueOrThrow({ where: { chain_address: { chain: 'BASE', address: ADDRESSES[0] } } });
    const strongerAt = new Date(NOW.getTime() + 86_400_000);
    await persistInvestigationKnowledge(prisma, investigation('inv-2', strongerAt, [member(ADDRESSES[0], 'entity-alpha', 92, 78, 72)]), { now: strongerAt });
    const stronger = await prisma.walletIntelligenceProfile.findUniqueOrThrow({ where: { chain_address: { chain: 'BASE', address: ADDRESSES[0] } } });
    expect(stronger.confidence).toBeGreaterThan(original.confidence);

    const contradictedAt = new Date(NOW.getTime() + 2 * 86_400_000);
    const contradicted = member(ADDRESSES[0], 'entity-alpha', 20, 65, 70, ['bridge inference is not ownership', 'CEX correlation', 'timing mismatch', 'route contradiction']);
    await persistInvestigationKnowledge(prisma, investigation('inv-3', contradictedAt, [contradicted]), { now: contradictedAt });
    const lowered = await prisma.walletIntelligenceProfile.findUniqueOrThrow({ where: { chain_address: { chain: 'BASE', address: ADDRESSES[0] } } });
    expect(lowered.confidence).toBeLessThan(stronger.confidence);
    expect(await prisma.walletIntelligenceObservation.count({ where: { profileId: lowered.id } })).toBe(3);

    const standaloneAt = new Date(NOW.getTime() + 3 * 86_400_000);
    await persistInvestigationKnowledge(prisma, investigation('inv-4', standaloneAt, [member(ADDRESSES[2], null, 45, 70, 60)]), { now: standaloneAt });
    const standalone = await prisma.walletIntelligenceProfile.findUniqueOrThrow({ where: { chain_address: { chain: 'BASE', address: ADDRESSES[2] } } });
    expect(standalone.clusterId).not.toBe(lowered.clusterId);

    const mergeAt = new Date(NOW.getTime() + 4 * 86_400_000);
    const mergeReport = await persistInvestigationKnowledge(prisma, investigation('inv-5', mergeAt, [
      member(ADDRESSES[0], 'entity-alpha', 80, 70, 70),
      member(ADDRESSES[2], 'entity-alpha', 78, 68, 66)
    ]), { now: mergeAt });
    const merged = await prisma.walletIntelligenceProfile.findUniqueOrThrow({ where: { chain_address: { chain: 'BASE', address: ADDRESSES[2] } } });
    expect(merged.clusterId).toBe((await prisma.walletIntelligenceProfile.findUniqueOrThrow({ where: { chain_address: { chain: 'BASE', address: ADDRESSES[0] } } })).clusterId);
    expect(mergeReport.clustersMerged).toBe(1);
    expect(await prisma.intelligenceClusterMerge.count()).toBeGreaterThanOrEqual(1);
    expect(await prisma.walletIntelligenceObservation.count({ where: { profile: { address: { in: ADDRESSES.slice(0, 3) } } } })).toBe(7);
    expect(await prisma.monitoringSubscription.count({ where: { active: true, wallet: { address: { in: ADDRESSES.slice(0, 3) } } } })).toBeGreaterThanOrEqual(3);
  }, 30_000);

  it('rejects single-wallet buys, emits dormant/cluster signals, and creates Buy Candidates only after token quality passes', async () => {
    await persistInvestigationKnowledge(prisma, investigation('lifecycle-seed', new Date(NOW.getTime() - 70 * 86_400_000), [
      member(ADDRESSES[0], 'entity-live', 90, 82, 88),
      member(ADDRESSES[1], 'entity-live', 88, 78, 85)
    ]), { now: new Date(NOW.getTime() - 70 * 86_400_000) });
    await prisma.walletIntelligenceProfile.updateMany({
      where: { address: { in: ADDRESSES.slice(0, 2) } },
      data: { lastActivityAt: new Date(NOW.getTime() - 60 * 86_400_000), historicalAlphaScore: 80, evidenceScore: 90, confidence: 0.9 }
    });

    await createQualityToken(TOKENS[0], true);
    await createQualityToken(TOKENS[1], false);
    await prisma.token.create({ data: { chain: 'BASE', address: TOKENS[2], symbol: 'SINGLE', name: 'Single', decimals: 18, firstSeenAt: NOW, riskFlags: [] } });
    await prisma.massTransactionEvent.createMany({ data: [
      massBuy('good-1', ADDRESSES[0], TOKENS[0], new Date(NOW.getTime() - 120_000)),
      massBuy('good-2', ADDRESSES[1], TOKENS[0], new Date(NOW.getTime() - 110_000)),
      massBuy('bad-1', ADDRESSES[0], TOKENS[1], new Date(NOW.getTime() - 100_000)),
      massBuy('bad-2', ADDRESSES[1], TOKENS[1], new Date(NOW.getTime() - 90_000)),
      massBuy('single', ADDRESSES[0], TOKENS[2], new Date(NOW.getTime() - 80_000))
    ] });

    const report = await runIntelligenceLifecycle(prisma, { since: new Date(NOW.getTime() - 3_600_000), now: NOW });
    expect(report.dormantAwakenings).toBe(2);
    expect(report.signalsCreated).toBe(2);
    expect(report.singleWalletGroupsRejected).toBe(1);
    expect(await prisma.walletIntelligenceEvent.count({ where: { eventType: 'Dormant Wallet Awakened' } })).toBe(2);
    expect(await prisma.intelligenceSignal.count({ where: { tokenAddress: TOKENS[2] } })).toBe(0);

    const goodSignal = await prisma.intelligenceSignal.findFirstOrThrow({ where: { tokenAddress: TOKENS[0] }, include: { qualityAssessment: true, buyCandidate: true } });
    expect(['STRONG_WATCH', 'HIGH_CONVICTION']).toContain(goodSignal.level);
    expect(goodSignal.qualityAssessment).toMatchObject({ passed: true });
    expect(goodSignal.buyCandidate).not.toBeNull();

    const badSignal = await prisma.intelligenceSignal.findFirstOrThrow({ where: { tokenAddress: TOKENS[1] }, include: { qualityAssessment: true, buyCandidate: true } });
    expect(badSignal.qualityAssessment).toMatchObject({ passed: false });
    expect(badSignal.buyCandidate).toBeNull();
    expect(report.buyCandidatesCreated).toBe(1);
    expect(await prisma.trackedTokenActivationAlert.count({ where: { tokenAddress: { in: TOKENS.slice(0, 2) }, alertType: { startsWith: 'cluster_intelligence_' } } })).toBe(2);

    const cluster = await prisma.intelligenceCluster.findFirstOrThrow({ where: { profiles: { some: { address: ADDRESSES[0] } } } });
    const watch = await prisma.operatorWatch.create({ data: {
      userId: PREFIX, chatId: PREFIX, targetType: 'entity', targetKey: cluster.clusterKey, chain: 'BASE',
      alertTypes: ['dormant_wallet_reactivated', 'receiver_bought_token']
    } });
    const materialized = await new OperatorService(prisma).materializeWatchAlerts(new Date(NOW.getTime() - 3_600_000));
    const watchAlerts = await prisma.operatorWatchAlert.findMany({ where: { watchId: watch.id } });
    expect(materialized).toBeGreaterThanOrEqual(3);
    expect(new Set(watchAlerts.map((alert) => alert.alertType))).toEqual(new Set(['dormant_wallet_reactivated', 'receiver_bought_token']));
  }, 30_000);

  it('uses the exact three-level conviction thresholds', () => {
    expect(intelligenceSignalLevelForScore(50)).toBe('WATCH');
    expect(intelligenceSignalLevelForScore(70)).toBe('STRONG_WATCH');
    expect(intelligenceSignalLevelForScore(85)).toBe('HIGH_CONVICTION');
  });

  it('requires two independent merge evidence types and can roll an applied merge back', async () => {
    await persistInvestigationKnowledge(prisma, investigation('merge-a', NOW, [member(ADDRESSES[0], 'entity-merge-a', 88, 72, 70)]), { now: NOW });
    await persistInvestigationKnowledge(prisma, investigation('merge-b', NOW, [member(ADDRESSES[1], 'entity-merge-b', 86, 68, 65)]), { now: NOW });
    const entities = await prisma.intelligenceEntity.findMany({ where: { memberships: { some: { profile: { address: { in: ADDRESSES.slice(0, 2) } } } } }, include: { memberships: true } });
    expect(entities).toHaveLength(2);

    const unsafe = await proposeEntityMerge(prisma, { sourceEntityIds: entities.map((row) => row.id), independentEvidenceTypes: ['timing_correlation'], reasons: ['test_single_signal'], now: NOW });
    expect(unsafe.status).toBe('rejected');

    const proposal = await proposeEntityMerge(prisma, { sourceEntityIds: entities.map((row) => row.id), independentEvidenceTypes: ['direct_funding', 'execution_pattern'], reasons: ['repeated_direct_funding', 'matched_execution'], now: new Date(NOW.getTime() + 1_000) });
    expect(proposal.status).toBe('proposed');
    const applied = await applyEntityMerge(prisma, proposal.id, new Date(NOW.getTime() + 2_000));
    expect(applied.status).toBe('applied');
    expect(await prisma.intelligenceEntity.count({ where: { id: { in: entities.map((row) => row.id) }, status: 'merged' } })).toBe(1);

    const rolledBack = await rollbackEntityAction(prisma, proposal.id, new Date(NOW.getTime() + 3_000));
    expect(rolledBack.status).toBe('rolled_back');
    expect(await prisma.intelligenceEntity.count({ where: { id: { in: entities.map((row) => row.id) }, status: 'active' } })).toBe(2);
    expect(await prisma.intelligenceEntityMembership.count({ where: { entityId: { in: entities.map((row) => row.id) }, status: 'rejected' } })).toBe(0);
  }, 30_000);

  it('evaluates horizon outcomes without lookahead and remains idempotent', async () => {
    const activatedAt = new Date(NOW.getTime() - 2 * 60 * 60_000);
    const token = await prisma.token.create({ data: {
      chain: 'BASE', address: TOKENS[0], symbol: 'OUT', name: 'Outcome', decimals: 18,
      firstSeenAt: new Date(activatedAt.getTime() - 86_400_000), pairAddress: 'pair-out', dex: 'test', riskFlags: []
    } });
    const entry = await prisma.tokenMarketSnapshot.create({ data: {
      tokenId: token.id, ts: new Date(activatedAt.getTime() - 60_000), priceUsd: 1, marketCapUsd: 100_000, fdvUsd: 100_000,
      liquidityUsd: 50_000, vol5m: 100, vol1h: 1_000, vol6h: 2_000, vol24h: 5_000, holderCount: 100, source: 'persisted-provider-test'
    } });
    const five = await prisma.tokenMarketSnapshot.create({ data: {
      tokenId: token.id, ts: new Date(activatedAt.getTime() + 5 * 60_000), priceUsd: 1.5, marketCapUsd: 150_000, fdvUsd: 150_000,
      liquidityUsd: 55_000, vol5m: 200, vol1h: 1_500, vol6h: 2_500, vol24h: 6_000, holderCount: 110, source: 'persisted-provider-test'
    } });
    const thirty = await prisma.tokenMarketSnapshot.create({ data: {
      tokenId: token.id, ts: new Date(activatedAt.getTime() + 30 * 60_000), priceUsd: 2, marketCapUsd: 200_000, fdvUsd: 200_000,
      liquidityUsd: 60_000, vol5m: 300, vol1h: 2_000, vol6h: 3_000, vol24h: 7_000, holderCount: 125, source: 'persisted-provider-test'
    } });
    const afterOneHour = await prisma.tokenMarketSnapshot.create({ data: {
      tokenId: token.id, ts: new Date(activatedAt.getTime() + 90 * 60_000), priceUsd: 0.5, marketCapUsd: 50_000, fdvUsd: 50_000,
      liquidityUsd: 30_000, vol5m: 50, vol1h: 500, vol6h: 1_000, vol24h: 2_000, holderCount: 90, source: 'persisted-provider-test'
    } });
    const signal = await prisma.intelligenceSignal.create({ data: {
      dedupeKey: `${PREFIX}:outcome`, chain: 'BASE', tokenAddress: TOKENS[0], signalType: 'same_cluster_multi_wallet_buy',
      level: 'STRONG_WATCH', lifecycleStage: 'STRONG_WATCH', score: 75, activatedAt,
      clusterKeys: ['test-cluster'], entityKeys: [], entityIds: [], walletAddresses: ADDRESSES.slice(0, 2), sourceEventIds: [], reasons: ['test'],
      evidenceJson: {}, historySupportJson: {}, scoreDecompositionJson: { entityConfluence: { raw: 1, weight: 24, contribution: 24 } },
      entryMarketJson: { snapshotId: entry.id, capturedAt: activatedAt.toISOString(), noLookahead: true }, explanation: 'test outcome',
      independentEntityCount: 1, independentCapitalRootCount: 1, coreWalletCount: 2, peripheralWalletCount: 0,
      engineVersion: 2, ruleVersion: 1, modelVersion: 1
    } });

    const first = await runIntelligenceOutcomePass(prisma, { now: NOW, signalIds: [signal.id] });
    expect(first.horizonsUpserted).toBe(8);
    const oneHour = await prisma.intelligenceSignalOutcome.findUniqueOrThrow({ where: { signalId_horizon: { signalId: signal.id, horizon: '1h' } } });
    expect(oneHour.status).toBe('complete');
    expect(oneHour.sourceSnapshotIds).toEqual(expect.arrayContaining([entry.id, five.id, thirty.id]));
    expect(oneHour.sourceSnapshotIds).not.toContain(afterOneHour.id);
    expect((await prisma.intelligenceSignalOutcomeLabel.findUniqueOrThrow({ where: { signalId: signal.id } }))).toMatchObject({ label: 'strong', basisHorizon: '1h' });

    await runIntelligenceOutcomePass(prisma, { now: NOW, signalIds: [signal.id] });
    expect(await prisma.intelligenceSignalOutcome.count({ where: { signalId: signal.id } })).toBe(8);
  }, 30_000);
});

function member(address: string, entityKey: string | null, evidence: number, alpha: number, wake: number, contradictions: string[] = []): InvestigationMember {
  return {
    chain: 'BASE', address, role: 'execution_wallet', parentChain: 'BASE', parentAddress: ADDRESSES[3], entityKey,
    relationshipConfidence: evidence / 100, evidenceTier: 'multi_signal_test', firstLinkedAt: new Date(NOW.getTime() - 90 * 86_400_000).toISOString(),
    lastLinkedAt: new Date(NOW.getTime() - 60 * 86_400_000).toISOString(), observationOnly: true,
    intelligence: {
      evidenceScore: evidence, historicalAlphaScore: alpha, wakeUpPotential: wake, tier: evidence >= 65 ? 'A' : 'B',
      trackingPriority: 'track_now', independentSignalCount: 3, clusterConclusion: evidence >= 65 ? 'supported' : 'probable',
      evidenceSignals: [
        { code: 'direct_funding', label: 'Direct funding', strength: 0.9, weight: 24, receiptCount: 2 },
        { code: 'repeated_behavior', label: 'Repeated behavior', strength: 0.8, weight: 18, receiptCount: 3 },
        { code: 'execution_pattern', label: 'Execution pattern', strength: 0.8, weight: 16, receiptCount: 2 }
      ],
      whyImportant: ['Repeated funded execution behavior', 'Historically profitable participation'], contradictions,
      historicalCoverage: 'full',
      metrics: { transferCount: 4, uniqueTokensAfterFunding: 3, completedPositions: 8, winRate: 0.75, repeatRunnerCount: 3, realizedPnlUsd: 25_000, medianEntryMcapUsd: 150_000, maxCoveredDormantDays: 60 },
      scoreVersion: 1
    }
  };
}

function investigation(id: string, completedAt: Date, members: InvestigationMember[]): WalletInvestigationResult {
  return {
    id: `${PREFIX}:${id}`, investigationKey: `${PREFIX}:${id}`, rootAddress: ADDRESSES[3], addressKind: 'evm', maxDepth: 4,
    status: 'completed', entityKey: members[0]?.entityKey ?? null, coverageStatus: 'complete', activityChains: ['BASE'], coverage: [],
    counts: { directReceivers: 0, multiHopWallets: 0, bridgeDestinations: 0, probableAltExecutionWallets: members.length, profitCollectors: 0, tokenDeployments: 0, possibleCexLinks: 0, strongLinks: members.length, probableLinks: 0, possibleLinks: 0 },
    paths: [], members, deployments: [], providerReceipts: {}, completedAt: completedAt.toISOString()
  };
}

async function createQualityToken(address: string, safe: boolean) {
  const token = await prisma.token.create({ data: {
    chain: 'BASE', address, symbol: safe ? 'GOOD' : 'BAD', name: safe ? 'Good Token' : 'Bad Token', decimals: 18,
    firstSeenAt: new Date(NOW.getTime() - 86_400_000), tokenCreatedAt: new Date(NOW.getTime() - 86_400_000),
    pairAddress: `pair:${address}`, dex: 'test-dex', riskFlags: []
  } });
  await prisma.tokenMarketSnapshot.create({ data: {
    tokenId: token.id, ts: new Date(NOW.getTime() - 300_000), priceUsd: 0.01, marketCapUsd: 500_000, fdvUsd: 500_000,
    liquidityUsd: safe ? 100_000 : 5_000, vol5m: 5_000, vol1h: 20_000, vol6h: 40_000, vol24h: 80_000, holderCount: safe ? 300 : 10, source: 'intelligence-platform-test'
  } });
  await prisma.tokenRiskSnapshot.create({ data: {
    tokenId: token.id, chain: 'BASE', tokenAddress: address, provider: 'test', requestedAt: new Date(NOW.getTime() - 600_000), observedAt: new Date(NOW.getTime() - 600_000),
    status: 'ok', flags: safe ? [{ id: 'lp_locked', label: 'LP locked', severity: 'info' }] : [{ id: 'honeypot', label: 'Honeypot', severity: 'danger' }], penalty: safe ? 0 : 0.9,
    confidence: 100, expiresAt: new Date(NOW.getTime() + 86_400_000), nextRefreshAt: new Date(NOW.getTime() + 86_400_000)
  } });
  await prisma.massTransactionEvent.create({ data: {
    eventId: `${PREFIX}:lp:${address}`, chain: 'BASE', txHash: `${PREFIX}:lp:${address}:tx`, eventIndex: 0, blockOrSlot: 1n,
    ts: new Date(NOW.getTime() - 1_200_000), kind: 'lp_add', status: 'succeeded', fromAddress: ADDRESSES[3], toAddress: address,
    actorAddress: ADDRESSES[3], assetAddress: address, assetSymbol: safe ? 'GOOD' : 'BAD', assetDecimals: 18,
    amountToken: '1000', amountUsd: safe ? 100_000 : 5_000, provider: 'test', observedAt: new Date(NOW.getTime() - 1_200_000),
    relevanceCategory: 'capital_transfer', relevanceScore: 90, reasonCodes: ['lp_locked'], safeEntityLink: false,
    enrollmentCandidate: false, metadataJson: { locked: safe, testPrefix: PREFIX }
  } });
}

function massBuy(id: string, wallet: string, token: string, ts: Date) {
  return {
    eventId: `${PREFIX}:${id}`, chain: 'BASE' as const, txHash: `${PREFIX}:${id}:tx`, eventIndex: 0, blockOrSlot: BigInt(id.length),
    ts, kind: 'token_buy', status: 'succeeded', fromAddress: wallet, toAddress: wallet, actorAddress: wallet, assetAddress: token,
    assetSymbol: 'TEST', assetDecimals: 18, amountToken: '1000', amountUsd: 1_000, provider: 'test', observedAt: ts,
    relevanceCategory: 'token_deployment', relevanceScore: 90, reasonCodes: ['test_buy'], safeEntityLink: false,
    enrollmentCandidate: false, metadataJson: { testPrefix: PREFIX }
  };
}
