import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { InvestigationMember, WalletInvestigationResult } from '../src/investigation/types';
import { prisma } from '../src/client';
import { persistInvestigationKnowledge } from '../src/intelligence/knowledge';
import { intelligenceSignalLevelForScore, runIntelligenceLifecycle } from '../src/intelligence/lifecycle';
import { OperatorService } from '../src/operator/service';

const PREFIX = 'INTELLIGENCE_PLATFORM_TEST';
const ADDRESSES = ['a1', 'b2', 'c3', 'd4'].map((byte) => `0x${byte.repeat(20)}`);
const TOKENS = ['e1', 'e2', 'e3'].map((byte) => `0x${byte.repeat(20)}`);
const NOW = new Date('2038-01-15T12:00:00Z');

async function cleanup() {
  await prisma.operatorWatchAlert.deleteMany({ where: { watch: { userId: PREFIX } } });
  await prisma.operatorWatch.deleteMany({ where: { userId: PREFIX } });
  await prisma.intelligenceBuyCandidate.deleteMany({ where: { tokenAddress: { in: TOKENS } } });
  await prisma.intelligenceSignal.deleteMany({ where: { tokenAddress: { in: TOKENS } } });
  await prisma.tokenQualityAssessment.deleteMany({ where: { tokenAddress: { in: TOKENS } } });
  await prisma.trackedTokenActivationAlert.deleteMany({ where: { tokenAddress: { in: TOKENS } } });
  await prisma.walletIntelligenceEvent.deleteMany({ where: { walletAddress: { in: ADDRESSES } } });
  await prisma.walletIntelligenceObservation.deleteMany({ where: { profile: { address: { in: ADDRESSES } } } });
  await prisma.intelligenceClusterObservation.deleteMany({ where: { cluster: { profiles: { some: { address: { in: ADDRESSES } } } } } });
  await prisma.intelligenceClusterMerge.deleteMany({ where: { OR: [{ fromCluster: { profiles: { some: { address: { in: ADDRESSES } } } } }, { intoCluster: { profiles: { some: { address: { in: ADDRESSES } } } } }] } });
  const clusterIds = (await prisma.walletIntelligenceProfile.findMany({ where: { address: { in: ADDRESSES } }, select: { clusterId: true } })).map((row) => row.clusterId);
  await prisma.walletIntelligenceProfile.deleteMany({ where: { address: { in: ADDRESSES } } });
  if (clusterIds.length) {
    await prisma.intelligenceClusterMerge.deleteMany({ where: { OR: [{ fromClusterId: { in: clusterIds } }, { intoClusterId: { in: clusterIds } }] } });
    await prisma.intelligenceClusterObservation.deleteMany({ where: { clusterId: { in: clusterIds } } });
    await prisma.intelligenceCluster.deleteMany({ where: { id: { in: clusterIds } } });
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
  const token = await prisma.token.create({ data: { chain: 'BASE', address, symbol: safe ? 'GOOD' : 'BAD', name: safe ? 'Good Token' : 'Bad Token', decimals: 18, firstSeenAt: new Date(NOW.getTime() - 86_400_000), riskFlags: [] } });
  await prisma.tokenMarketSnapshot.create({ data: {
    tokenId: token.id, ts: new Date(NOW.getTime() - 300_000), priceUsd: 0.01, marketCapUsd: 500_000, fdvUsd: 500_000,
    liquidityUsd: safe ? 100_000 : 5_000, vol5m: 5_000, vol1h: 20_000, vol6h: 40_000, vol24h: 80_000, holderCount: safe ? 300 : 10, source: 'intelligence-platform-test'
  } });
  await prisma.tokenRiskSnapshot.create({ data: {
    tokenId: token.id, chain: 'BASE', tokenAddress: address, provider: 'test', requestedAt: NOW, observedAt: NOW,
    status: 'ok', flags: safe ? [] : [{ id: 'honeypot', label: 'Honeypot', severity: 'danger' }], penalty: safe ? 0 : 0.9,
    confidence: 100, expiresAt: new Date(NOW.getTime() + 86_400_000), nextRefreshAt: new Date(NOW.getTime() + 86_400_000)
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
