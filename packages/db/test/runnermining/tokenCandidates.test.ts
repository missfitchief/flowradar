// FlowRadar — automatic token-candidate feed tests (working loop).

import { describe, expect, it, afterAll, beforeEach } from 'vitest';
import net from 'node:net';
import { prisma } from '../../src/client';
import { buildTokenCandidateScores, deriveCandidateState, candidateScore } from '../../src/runnermining/tokenCandidates';

const PREFIX = 'CANDF'; // base58-safe (no 0/O/I/l)

function probePort(host: string, port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (ok: boolean) => { socket.removeAllListeners(); socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}
const dbReachable = await probePort('localhost', 5439);
const T0 = new Date('2026-06-01T00:00:00Z');
const addr = (s: string) => `${PREFIX}${s}`;

async function cleanup() {
  await prisma.tokenCandidateScore.deleteMany({ where: { mint: { startsWith: PREFIX } } });
  await prisma.receiverEnrollment.deleteMany({ where: { receiverAddress: { startsWith: PREFIX } } });
  await prisma.walletDnaProfile.deleteMany({ where: { walletAddress: { startsWith: PREFIX } } });
  await prisma.walletTokenTrade.deleteMany({ where: { txHash: { startsWith: PREFIX } } });
  await prisma.tokenMarketSnapshot.deleteMany({ where: { token: { address: { startsWith: PREFIX } } } });
  await prisma.tokenLifecycle.deleteMany({ where: { mint: { startsWith: PREFIX } } });
  await prisma.wallet.deleteMany({ where: { address: { startsWith: PREFIX } } });
  await prisma.token.deleteMany({ where: { address: { startsWith: PREFIX } } });
}

async function seedDnaWallet(suffix: string, status = 'observation_only') {
  const address = addr(suffix);
  const w = await prisma.wallet.create({
    data: { address, chain: 'SOLANA', firstSeenAt: T0, lastActiveAt: T0, status: status as never },
    select: { id: true }
  });
  await prisma.walletDnaProfile.create({
    data: {
      chain: 'SOLANA', walletAddress: address, coverage: 'partial', confidence: 45,
      reasonCodes: [], receiptsJson: {}, caveats: [], engineVersion: 1, computedAt: T0
    }
  });
  return { id: w.id, address };
}

let seq = 0;
async function seedToken(suffix: string) {
  return prisma.token.create({
    data: { chain: 'SOLANA', address: addr(suffix), symbol: suffix, name: suffix, decimals: 9, firstSeenAt: T0, riskFlags: [] },
    select: { id: true, address: true }
  });
}

async function seedBuy(walletId: string, tokenId: string, ts: Date) {
  seq += 1;
  return prisma.walletTokenTrade.create({
    data: {
      walletId, tokenId, chain: 'SOLANA', action: 'BUY', amountToken: '10', amountUsd: '100',
      txHash: addr(`TX${seq}`), blockOrSlot: 1n, ts, priceUsd: '1', marketCapAtTrade: '50000',
      walletScoreAtTime: 50, provider: 'test'
    }
  });
}

beforeEach(async () => { if (dbReachable) await cleanup(); });
afterAll(async () => { if (!dbReachable) return; await cleanup(); await prisma.$disconnect(); });

describe('deriveCandidateState / candidateScore (pure)', () => {
  const base = {
    invalidated: false,
    qualifiedWithPostEntry: 0,
    distributionBehaviorCount: 0,
    kolContamination: 0,
    cohortBuyers: 2,
    nonCohortBuyers: 0,
    independentEntityCount: 2
  };
  it('fixed precedence; unknowns never raise the state', () => {
    expect(deriveCandidateState(base).state).toBe('STEALTH_ACCUMULATION');
    expect(deriveCandidateState({ ...base, independentEntityCount: 3 }).state).toBe('EARLY_INDEPENDENT_CONFIRMATION');
    expect(deriveCandidateState({ ...base, independentEntityCount: 1 }).state).toBe('WATCHING');
    expect(deriveCandidateState({ ...base, kolContamination: 1 }).state).toBe('PUBLIC_KOL_ARRIVAL');
    expect(deriveCandidateState({ ...base, nonCohortBuyers: 20 }).state).toBe('CROWD_EXPANSION');
    expect(deriveCandidateState({ ...base, qualifiedWithPostEntry: 2, distributionBehaviorCount: 1 }).state).toBe('DISTRIBUTION_RISK');
    expect(deriveCandidateState({ ...base, invalidated: true, kolContamination: 5 }).state).toBe('INVALIDATED');
    // A single entity with zero other evidence is never STEALTH.
    expect(deriveCandidateState({ ...base, independentEntityCount: 1, cohortBuyers: 1 }).state).toBe('WATCHING');
  });
  it('KOL contamination and distribution only ever REDUCE the score; INVALIDATED zeroes it', () => {
    const clean = candidateScore({
      independentEntityCount: 3, dormantReactivations: 1, fundedPathCount: 1,
      receiverDeployments: 1, durableBehaviorCount: 1, qualifiedWithPostEntry: 1,
      kolContamination: 0, state: 'EARLY_INDEPENDENT_CONFIRMATION'
    });
    const contaminated = candidateScore({
      independentEntityCount: 3, dormantReactivations: 1, fundedPathCount: 1,
      receiverDeployments: 1, durableBehaviorCount: 1, qualifiedWithPostEntry: 1,
      kolContamination: 2, state: 'PUBLIC_KOL_ARRIVAL'
    });
    expect(contaminated).toBeLessThan(clean);
    expect(
      candidateScore({
        independentEntityCount: 4, dormantReactivations: 4, fundedPathCount: 2,
        receiverDeployments: 3, durableBehaviorCount: 0, qualifiedWithPostEntry: 0,
        kolContamination: 0, state: 'INVALIDATED'
      })
    ).toBe(0);
  });
});

describe.skipIf(!dbReachable)('buildTokenCandidateScores', () => {
  it('discovers candidates from cohort buys, entity-adjusts, excludes historical runners, idempotently', async () => {
    const w1 = await seedDnaWallet('WA1');
    const w2 = await seedDnaWallet('WA2');
    const cand = await seedToken('CTKA');
    const runner = await seedToken('RTKA');
    await prisma.tokenLifecycle.create({
      data: {
        mint: runner.address, enteredUniverseAt: T0, sourcesJson: {}, coverage: 'covered',
        runnerClass: 'verified_above_10m', confidence: 'high', classifiedAt: T0
      }
    });
    await seedBuy(w1.id, cand.id, T0);
    await seedBuy(w2.id, cand.id, new Date(T0.getTime() + 1000));
    await seedBuy(w1.id, runner.id, T0); // historical runner: PAST evidence, never a candidate
    await prisma.tokenMarketSnapshot.create({
      data: {
        tokenId: cand.id, ts: T0, priceUsd: '1', marketCapUsd: '75000', fdvUsd: '75000',
        liquidityUsd: '10000', vol5m: '0', vol1h: '0', vol6h: '0', vol24h: '0', holderCount: 10
      }
    });

    const r = await buildTokenCandidateScores(prisma, { chain: 'SOLANA', walletAddresses: [w1.address, w2.address] });
    expect(r.errors).toBe(0);
    expect(r.mintsWritten).toBe(1);

    const row = await prisma.tokenCandidateScore.findUniqueOrThrow({
      where: { chain_mint: { chain: 'SOLANA', mint: cand.address } }
    });
    expect(row.state).toBe('STEALTH_ACCUMULATION'); // 2 independent entities, no KOL
    expect(row.stateBasis).toBe('mining_derived');
    expect(row.independentEntityCount).toBe(2);
    expect(Number(row.currentMcapUsd)).toBe(75_000);
    expect(row.score).toBeGreaterThan(0);
    expect(row.stealthEngineState).toBeNull(); // no snapshot — never fabricated
    expect(await prisma.tokenCandidateScore.count({ where: { mint: runner.address } })).toBe(0);

    const r2 = await buildTokenCandidateScores(prisma, { chain: 'SOLANA', walletAddresses: [w1.address, w2.address] });
    expect(r2.mintsWritten).toBe(1);
    expect(await prisma.tokenCandidateScore.count({ where: { mint: cand.address } })).toBe(1);
  });

  it('KOL buyer forces PUBLIC_KOL_ARRIVAL and reduces the score; receiver collapses into source entity', async () => {
    const w1 = await seedDnaWallet('WB1');
    const kol = await seedDnaWallet('WBK', 'public_kol');
    const cand = await seedToken('CTKB');
    await seedBuy(w1.id, cand.id, T0);
    await seedBuy(kol.id, cand.id, new Date(T0.getTime() + 1000));

    // Receiver enrolled FROM w1's entity buying the same token — must NOT
    // add an independent entity.
    const recvAddr = addr('WBR');
    const recv = await prisma.wallet.create({
      data: { address: recvAddr, chain: 'SOLANA', firstSeenAt: T0, lastActiveAt: T0 },
      select: { id: true }
    });
    await prisma.receiverEnrollment.create({
      data: {
        chain: 'SOLANA', receiverAddress: recvAddr, receiverClass: 'fresh_receiver',
        sourceEntityKeys: [w1.address], sourceWallets: [w1.address], evidenceTiers: ['direct_transfer'],
        firstReceiptTs: T0, deploymentsJson: [], reasonCodes: [], receiptsJson: {}, caveats: [], engineVersion: 1
      }
    });
    await seedBuy(recv.id, cand.id, new Date(T0.getTime() + 2000));

    await buildTokenCandidateScores(prisma, { chain: 'SOLANA', walletAddresses: [w1.address, kol.address] });
    const row = await prisma.tokenCandidateScore.findUniqueOrThrow({
      where: { chain_mint: { chain: 'SOLANA', mint: cand.address } }
    });
    expect(row.kolContamination).toBe(1);
    expect(row.state).toBe('PUBLIC_KOL_ARRIVAL');
    // w1 + its receiver = ONE entity; kol = another.
    expect(row.independentEntityCount).toBe(2);
    expect(row.receiverDeployments).toBe(1);
    expect(row.qualifiedBuyerCount).toBe(3);
  });
});
