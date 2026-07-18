import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/client';
import {
  AUTHORITATIVE_CORE_AUTHORITY,
  importPriorityCoreWalletSeeds,
  previewPriorityCoreWalletSeeds,
  type PriorityCoreSeedRow
} from '../src/intelligence/coreWalletSeed';
import { runMonitoringScheduler } from '../src/lineage/runMonitoringScheduler';

const ADDRESS_A = '7hWXz2qyk8yNxxQJZ9TA7YDt5pvaKWs1ftDhVVRdJGMY';
const ADDRESS_B = 'DXZggMufSFqbKDVTuDfP7i6nz76D9qfzdXNNB9ZvkdwX';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const NOW = new Date('2039-07-14T12:00:00Z');

async function cleanup() {
  const imports = await prisma.coreWalletSeedImport.findMany({ where: { sourceHashes: { hasSome: [HASH_A, HASH_B] } }, select: { id: true } });
  await prisma.coreWalletSeedRecord.deleteMany({ where: { importId: { in: imports.map((row) => row.id) } } });
  await prisma.coreWalletSeedImport.deleteMany({ where: { id: { in: imports.map((row) => row.id) } } });
  const profiles = await prisma.walletIntelligenceProfile.findMany({ where: { address: { in: [ADDRESS_A, ADDRESS_B] } }, select: { id: true, clusterId: true } });
  const profileIds = profiles.map((row) => row.id);
  const clusterIds = profiles.map((row) => row.clusterId);
  const entityIds = (await prisma.intelligenceEntityMembership.findMany({ where: { profileId: { in: profileIds } }, select: { entityId: true } })).map((row) => row.entityId);
  await prisma.intelligenceEntityMembership.deleteMany({ where: { profileId: { in: profileIds } } });
  await prisma.walletIntelligenceObservation.deleteMany({ where: { profileId: { in: profileIds } } });
  await prisma.walletIntelligenceProfile.deleteMany({ where: { id: { in: profileIds } } });
  await prisma.intelligenceClusterObservation.deleteMany({ where: { clusterId: { in: clusterIds } } });
  await prisma.intelligenceCluster.deleteMany({ where: { id: { in: clusterIds } } });
  await prisma.intelligenceEntityVersion.deleteMany({ where: { entityId: { in: entityIds } } });
  await prisma.intelligenceEntityDecaySnapshot.deleteMany({ where: { entityId: { in: entityIds } } });
  await prisma.intelligenceEntity.deleteMany({ where: { id: { in: entityIds }, memberships: { none: {} } } });
  await prisma.monitoringSubscription.deleteMany({ where: { wallet: { address: { in: [ADDRESS_A, ADDRESS_B] } } } });
  await prisma.walletStats.deleteMany({ where: { wallet: { address: { in: [ADDRESS_A, ADDRESS_B] } } } });
  await prisma.wallet.deleteMany({ where: { address: { in: [ADDRESS_A, ADDRESS_B] } } });
}

beforeEach(cleanup);
afterAll(async () => { await cleanup(); await prisma.$disconnect(); });

describe('priority core wallet seeds', () => {
  it('validates threshold candidates, rejects test garbage, and deduplicates cross-source rows', () => {
    const preview = previewPriorityCoreWalletSeeds([
      row(HASH_A, 2, ADDRESS_A, 100),
      row(HASH_B, 2, ADDRESS_A, 88),
      row(HASH_A, 3, ADDRESS_B, 80),
      row(HASH_A, 4, 'TEST_WALLET_ABC', 88)
    ]);
    expect(preview).toMatchObject({ totalRows: 4, candidateRows: 3, acceptedRows: 2, uniqueWallets: 1, rejectedRows: 2, duplicateRows: 1 });
    expect(preview.entries.map((entry) => entry.decision)).toEqual(expect.arrayContaining([
      'accepted_primary', 'accepted_duplicate_source', 'rejected_below_threshold', 'rejected_invalid_address'
    ]));
  });

  it('preserves authoritative CSV metadata without promoting source score to evidence or Reliability', async () => {
    const rows: PriorityCoreSeedRow[] = [{
      ...row(HASH_A, 2, ADDRESS_A, 70, 'active'),
      category: 'manual_core',
      type: 'seed',
      reliabilityScore: null,
      classifications: ['insider'],
      raw: { address: ADDRESS_A, score: '70', status: 'active', label: 'Current Core', category: 'manual_core' }
    }];
    const first = await importPriorityCoreWalletSeeds(prisma, rows, {
      threshold: 0, authority: AUTHORITATIVE_CORE_AUTHORITY, now: NOW
    });
    expect(first).toMatchObject({
      authority: AUTHORITATIVE_CORE_AUTHORITY,
      acceptedRows: 1,
      uniqueWallets: 1,
      idempotentReplay: false,
      guardrails: {
        sourceScoreOwnershipEvidence: false,
        sourceScoreSignalEligibility: false,
        sourceScoreBuyCandidateTrigger: false
      }
    });
    const receipt = await prisma.coreWalletSeedImport.findUniqueOrThrow({ where: { id: first.importId } });
    expect(receipt.guardrailJson).toMatchObject({
      sourceAuthority: AUTHORITATIVE_CORE_AUTHORITY,
      authoritativeCoreMembership: true
    });
    const record = await prisma.coreWalletSeedRecord.findFirstOrThrow({ where: { importId: first.importId } });
    expect(record).toMatchObject({ sourceScore: 70, sourceLabel: 'candidate-2', sourceStatus: 'active' });
    expect(record.rawJson).toMatchObject({
      category: 'manual_core',
      _flowradarSourceMetadata: {
        category: 'manual_core', type: 'seed', reliabilityScore: null, classifications: ['insider']
      }
    });
    const profile = await prisma.walletIntelligenceProfile.findUniqueOrThrow({ where: { chain_address: { chain: 'SOLANA', address: ADDRESS_A } } });
    expect(profile).toMatchObject({ role: 'authoritative_core_list_candidate', evidenceScore: 0, confidence: 0, historicalAlphaScore: 35 });

    const replay = await importPriorityCoreWalletSeeds(prisma, rows, {
      threshold: 0, authority: AUTHORITATIVE_CORE_AUTHORITY, now: new Date(NOW.getTime() + 60_000)
    });
    expect(replay.idempotentReplay).toBe(true);
    expect(await prisma.coreWalletSeedRecord.count({ where: { importId: first.importId } })).toBe(1);
  }, 30_000);

  it('imports observation-only candidates, creates only singleton possible memberships, and remains idempotent', async () => {
    await prisma.wallet.create({ data: {
      address: ADDRESS_B, chain: 'SOLANA', firstSeenAt: NOW, lastActiveAt: NOW,
      isWatched: false, status: 'signal_eligible', notes: 'pre-existing operator decision'
    } });
    const rows = [
      row(HASH_A, 2, ADDRESS_A, 100, 'dormant'),
      row(HASH_B, 2, ADDRESS_A, 88, 'active'),
      row(HASH_A, 3, ADDRESS_B, 90, 'active'),
      row(HASH_A, 4, 'TEST_WALLET_ABC', 88, 'active')
    ];
    const first = await importPriorityCoreWalletSeeds(prisma, rows, { now: NOW });
    expect(first).toMatchObject({
      idempotentReplay: false,
      candidateRows: 4,
      acceptedRows: 3,
      uniqueWallets: 2,
      rejectedRows: 1,
      duplicateRows: 1,
      profilesCreated: 2,
      monitoringEnrolled: 2,
      guardrails: {
        sourceScoreOwnershipEvidence: false,
        sourceScoreSignalEligibility: false,
        sourceScoreBuyCandidateTrigger: false,
        newProfilesWithOwnershipEvidence: 0,
        unsafeEntityMemberships: 0,
        newWalletStatusEscalations: 0,
        walletStatsWrites: 0
      }
    });

    const newWallet = await prisma.wallet.findUniqueOrThrow({ where: { address_chain: { address: ADDRESS_A, chain: 'SOLANA' } } });
    const preserved = await prisma.wallet.findUniqueOrThrow({ where: { address_chain: { address: ADDRESS_B, chain: 'SOLANA' } } });
    expect(newWallet).toMatchObject({ status: 'observation_only', isWatched: true });
    expect(preserved).toMatchObject({ status: 'signal_eligible', isWatched: true });
    const profile = await prisma.walletIntelligenceProfile.findUniqueOrThrow({ where: { chain_address: { chain: 'SOLANA', address: ADDRESS_A } } });
    expect(profile).toMatchObject({
      entityKey: null,
      role: 'priority_core_seed_candidate',
      evidenceScore: 0,
      historicalAlphaScore: 35,
      wakeUpPotential: 45,
      confidence: 0,
      tier: 'C',
      independentSignals: 0,
      evidenceSignals: [],
      monitoringPriority: 'strong_link'
    });
    const membership = await prisma.intelligenceEntityMembership.findFirstOrThrow({ where: { profileId: profile.id } });
    expect(membership).toMatchObject({ status: 'possible', scope: 'peripheral', independentSignalCount: 0, evidenceTypes: [] });
    expect(await prisma.monitoringSubscription.count({ where: { active: true, priority: 'strong_link', wallet: { address: { in: [ADDRESS_A, ADDRESS_B] } } } })).toBe(2);
    expect(await prisma.walletStats.count({ where: { wallet: { address: { in: [ADDRESS_A, ADDRESS_B] } } } })).toBe(0);
    expect(await prisma.intelligenceSignal.count({ where: { walletAddresses: { hasSome: [ADDRESS_A, ADDRESS_B] } } })).toBe(0);
    expect(await prisma.intelligenceBuyCandidate.count({ where: { signal: { walletAddresses: { hasSome: [ADDRESS_A, ADDRESS_B] } } } })).toBe(0);

    await runMonitoringScheduler(prisma, {
      now: new Date('2040-07-14T12:00:00Z'),
      requestBudget: 10,
      walletAddressStartsWith: ADDRESS_A.slice(0, 8),
      poll: async () => ({ ok: true })
    });
    expect(await prisma.monitoringSubscription.findUniqueOrThrow({
      where: { walletId_priority: { walletId: newWallet.id, priority: 'strong_link' } }
    })).toMatchObject({ active: true, priority: 'strong_link' });

    const second = await importPriorityCoreWalletSeeds(prisma, rows, { now: new Date(NOW.getTime() + 60_000) });
    expect(second.idempotentReplay).toBe(true);
    expect(await prisma.coreWalletSeedImport.count({ where: { importKey: first.importKey } })).toBe(1);
    expect(await prisma.coreWalletSeedRecord.count({ where: { importId: first.importId } })).toBe(4);
    expect(await prisma.walletIntelligenceObservation.count({ where: { profile: { address: { in: [ADDRESS_A, ADDRESS_B] } }, discoverySource: 'priority_core_wallet_seed' } })).toBe(2);
  }, 30_000);
});

function row(hash: string, sourceRow: number, address: string, score: number, status = 'active'): PriorityCoreSeedRow {
  return {
    sourceFile: hash === HASH_A ? 'source-a.xlsx' : 'source-b.csv',
    sourceHash: hash,
    sourceSheet: 'Wallets',
    sourceRow,
    address,
    score,
    tier: 1,
    status,
    label: `candidate-${sourceRow}`,
    addedAt: '2039-01-01T00:00:00Z',
    lastActiveAt: status === 'dormant' ? '2038-01-01T00:00:00Z' : '2039-07-01T00:00:00Z'
  };
}
