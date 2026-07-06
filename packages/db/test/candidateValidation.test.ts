// FlowRadar — runCandidateValidation integration tests (Task 35, Wave 4.5,
// Spec §5b). Same LITE-Postgres integration pattern as
// externalWalletSource.test.ts (prefix-cleanup, describe.skipIf when the
// embedded Postgres isn't reachable).
//
// Includes the TRUST-BOUNDARY test (Task 35's required product guarantee):
// a pending CandidateWallet contributes NOTHING to the signal engine's
// aggregateWindow (smartWalletCount/uniqueEntityCount) until promoted.

import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import net from 'node:net';
import { DEFAULT_SETTINGS, aggregateWindow } from '@flowradar/core';
import { prisma } from '../src/client';
import { runCandidateValidation } from '../src/candidateValidation';
import { fetchAggregateInputs } from '../src/fetchAggregateInputs';

const ADDR_PREFIX = 'T35VAL';
const CHAIN = 'SOLANA' as const;

function probePort(host: string, port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

let dbReachable = false;

beforeAll(async () => {
  dbReachable = await probePort('localhost', 5439);
  if (!dbReachable) {
    // eslint-disable-next-line no-console
    console.warn(
      '[candidateValidation.test] LITE Postgres not reachable on localhost:5439 — skipping ' +
        'integration tests. Run `npm run db:migrate` first to exercise this suite.'
    );
  }
});

async function cleanup() {
  await prisma.walletTokenTrade.deleteMany({ where: { wallet: { address: { startsWith: ADDR_PREFIX } } } });
  await prisma.walletClassification.deleteMany({ where: { wallet: { address: { startsWith: ADDR_PREFIX } } } });
  await prisma.walletStats.deleteMany({ where: { wallet: { address: { startsWith: ADDR_PREFIX } } } });
  await prisma.candidateWallet.deleteMany({ where: { walletAddress: { startsWith: ADDR_PREFIX } } });
  await prisma.addressRegistry.deleteMany({ where: { address: { startsWith: ADDR_PREFIX } } });
  await prisma.wallet.deleteMany({ where: { address: { startsWith: ADDR_PREFIX } } });
  await prisma.token.deleteMany({ where: { address: { startsWith: ADDR_PREFIX } } });
}

afterAll(async () => {
  if (!dbReachable) return;
  await cleanup();
  await prisma.$disconnect();
});

beforeEach(async () => {
  if (!dbReachable) return;
  await cleanup();
});

async function makeCandidate(overrides: Partial<Parameters<typeof prisma.candidateWallet.create>[0]['data']> = {}) {
  const now = new Date();
  return prisma.candidateWallet.create({
    data: {
      walletAddress: `${ADDR_PREFIX}_default`,
      chain: CHAIN,
      source: 'test_source',
      firstSeenAt: now,
      lastSeenAt: now,
      validationStatus: 'pending',
      ...overrides
    }
  });
}

async function makeToken(addressSuffix: string) {
  return prisma.token.upsert({
    where: { chain_address: { chain: CHAIN, address: `${ADDR_PREFIX}_${addressSuffix}` } },
    create: {
      chain: CHAIN,
      address: `${ADDR_PREFIX}_${addressSuffix}`,
      symbol: 'T35TOK',
      name: 'T35 Validation Token',
      decimals: 9,
      firstSeenAt: new Date(),
      riskFlags: []
    },
    update: {}
  });
}

/** Seeds `count` profitable BUY+SELL trades for `walletId` on `tokenId`, all clearing DEFAULT_SETTINGS.profitableWallet thresholds. */
async function seedQualifyingTrades(walletId: string, tokenId: string, now: Date) {
  const trades: { action: 'BUY' | 'SELL'; amountToken: number; amountUsd: number; ts: Date }[] = [];
  for (let i = 0; i < 10; i++) {
    trades.push({ action: 'BUY', amountToken: 100, amountUsd: 1000, ts: new Date(now.getTime() - (40 - i) * 60_000) });
  }
  for (let i = 0; i < 10; i++) {
    trades.push({ action: 'SELL', amountToken: 100, amountUsd: 1900, ts: new Date(now.getTime() - (20 - i) * 60_000) });
  }

  let slot = 1;
  for (const t of trades) {
    await prisma.walletTokenTrade.create({
      data: {
        walletId,
        tokenId,
        chain: CHAIN,
        action: t.action,
        amountToken: t.amountToken,
        amountUsd: t.amountUsd,
        txHash: `${ADDR_PREFIX}_tx_${walletId}_${slot}`,
        blockOrSlot: BigInt(slot),
        ts: t.ts,
        priceUsd: t.amountUsd / t.amountToken,
        marketCapAtTrade: 500_000,
        walletScoreAtTime: 50,
        provider: 'test'
      }
    });
    slot += 1;
  }
}

describe.skipIf(!(await probePort('localhost', 5439)))('runCandidateValidation', () => {
  it('promotes a candidate whose local trade history clears every threshold', async () => {
    const now = new Date();
    const address = `${ADDR_PREFIX}_promote1`;
    const token = await makeToken('promote1');

    const wallet = await prisma.wallet.create({
      data: { address, chain: CHAIN, firstSeenAt: now, lastActiveAt: now, isWatched: false }
    });
    await seedQualifyingTrades(wallet.id, token.id, now);

    await makeCandidate({
      walletAddress: address,
      claimedPnlUsd: 9000,
      claimedWinRate: 0.5,
      claimedTradeCount: 20
    });

    const result = await runCandidateValidation(prisma, DEFAULT_SETTINGS);

    expect(result.promoted).toBeGreaterThanOrEqual(1);

    const row = await prisma.candidateWallet.findFirst({ where: { walletAddress: address } });
    expect(row!.validationStatus).toBe('promoted');
    expect(row!.promotedWalletId).not.toBeNull();
    expect(row!.validationConfidence).toBeGreaterThan(0);

    const promotedWallet = await prisma.wallet.findUnique({ where: { id: row!.promotedWalletId! } });
    expect(promotedWallet!.isWatched).toBe(true);
    expect(promotedWallet!.notes).toContain('promoted from test_source');

    const stats = await prisma.walletStats.findFirst({ where: { walletId: row!.promotedWalletId! } });
    expect(stats).not.toBeNull();
    expect(stats!.source).toBe('computed');
  });

  it('rejects a candidate whose registry category is CEX, regardless of local trades', async () => {
    const address = `${ADDR_PREFIX}_cexreject`;
    await prisma.addressRegistry.create({
      data: { chain: CHAIN, address, category: 'CEX', label: 'test CEX', source: 'test' }
    });
    await makeCandidate({ walletAddress: address, claimedPnlUsd: 100000 });

    await runCandidateValidation(prisma, DEFAULT_SETTINGS);

    const row = await prisma.candidateWallet.findFirst({ where: { walletAddress: address } });
    expect(row!.validationStatus).toBe('rejected');
    expect(row!.rejectionReason).toContain('excluded service address');
    expect(row!.rejectionReason).toContain('CEX');
  });

  it('rejects a candidate whose existing WalletClassification is possible_bot', async () => {
    const now = new Date();
    const address = `${ADDR_PREFIX}_botreject`;
    const wallet = await prisma.wallet.create({
      data: { address, chain: CHAIN, firstSeenAt: now, lastActiveAt: now, isWatched: false }
    });
    await prisma.walletClassification.create({
      data: { walletId: wallet.id, label: 'possible_bot', confidence: 80, evidence: {} }
    });
    await makeCandidate({ walletAddress: address, claimedPnlUsd: 100000 });

    await runCandidateValidation(prisma, DEFAULT_SETTINGS);

    const row = await prisma.candidateWallet.findFirst({ where: { walletAddress: address } });
    expect(row!.validationStatus).toBe('rejected');
    expect(row!.rejectionReason).toContain('bot/sniper-dominant');
  });

  it('rejects a candidate with local trades below threshold', async () => {
    const now = new Date();
    const address = `${ADDR_PREFIX}_belowthresh`;
    const token = await makeToken('belowthresh');
    const wallet = await prisma.wallet.create({
      data: { address, chain: CHAIN, firstSeenAt: now, lastActiveAt: now, isWatched: false }
    });
    // One tiny trade — well below every threshold.
    await prisma.walletTokenTrade.create({
      data: {
        walletId: wallet.id,
        tokenId: token.id,
        chain: CHAIN,
        action: 'BUY',
        amountToken: 1,
        amountUsd: 10,
        txHash: `${ADDR_PREFIX}_tx_belowthresh`,
        blockOrSlot: 1n,
        ts: now,
        priceUsd: 10,
        marketCapAtTrade: 500_000,
        walletScoreAtTime: 10,
        provider: 'test'
      }
    });
    await makeCandidate({ walletAddress: address, claimedPnlUsd: 1200, claimedWinRate: 0.4, claimedTradeCount: 10 });

    await runCandidateValidation(prisma, DEFAULT_SETTINGS);

    const row = await prisma.candidateWallet.findFirst({ where: { walletAddress: address } });
    expect(row!.validationStatus).toBe('rejected');
    expect(row!.rejectionReason).toContain('below thresholds');
  });

  it('stays pending (insufficient) when there is no local trade history and no provider evidence', async () => {
    const address = `${ADDR_PREFIX}_nodata`;
    await makeCandidate({ walletAddress: address, claimedPnlUsd: 999999, claimedWinRate: 0.99, claimedTradeCount: 500 });

    const result = await runCandidateValidation(prisma, DEFAULT_SETTINGS);
    expect(result.stayedPending).toBeGreaterThanOrEqual(1);

    const row = await prisma.candidateWallet.findFirst({ where: { walletAddress: address } });
    expect(row!.validationStatus).toBe('pending');
    expect(row!.promotedWalletId).toBeNull();

    const meta = row!.metadataJson as Record<string, unknown>;
    expect(meta.validationAttempts).toBe(1);
  });

  it('uses provider wallet-PnL evidence when a resolver is supplied, source="provider"', async () => {
    const now = new Date();
    const address = `${ADDR_PREFIX}_providered`;
    await makeCandidate({ walletAddress: address, claimedPnlUsd: 9000 });

    const result = await runCandidateValidation(prisma, DEFAULT_SETTINGS, async (chain, walletAddress) => {
      if (walletAddress !== address) return null;
      return { pnl30d: 9500, realizedPnlUsd: 6000, winRate: 0.55, tradeCount: 25, avgTradeSizeUsd: 300, confidence: 80 };
    });

    expect(result.promoted).toBeGreaterThanOrEqual(1);
    const row = await prisma.candidateWallet.findFirst({ where: { walletAddress: address } });
    expect(row!.validationStatus).toBe('promoted');

    const stats = await prisma.walletStats.findFirst({ where: { walletId: row!.promotedWalletId! } });
    expect(stats!.source).toBe('provider');
    void now;
  });

  it('one candidate throwing never aborts the batch (per-candidate try/catch)', async () => {
    const now = new Date();
    const goodAddress = `${ADDR_PREFIX}_batchgood`;
    const badAddress = `${ADDR_PREFIX}_batchbad`;
    const token = await makeToken('batch');

    const goodWallet = await prisma.wallet.create({
      data: { address: goodAddress, chain: CHAIN, firstSeenAt: now, lastActiveAt: now, isWatched: false }
    });
    await seedQualifyingTrades(goodWallet.id, token.id, now);
    await makeCandidate({ walletAddress: goodAddress });
    await makeCandidate({ walletAddress: badAddress });

    const result = await runCandidateValidation(prisma, DEFAULT_SETTINGS, async (chain, walletAddress) => {
      if (walletAddress === badAddress) throw new Error('simulated provider failure');
      return null;
    });

    const goodRow = await prisma.candidateWallet.findFirst({ where: { walletAddress: goodAddress } });
    expect(goodRow!.validationStatus).toBe('promoted');
    // badAddress: provider threw, no local trades either => insufficient (pending), not a batch-aborting error.
    const badRow = await prisma.candidateWallet.findFirst({ where: { walletAddress: badAddress } });
    expect(badRow!.validationStatus).toBe('pending');
    expect(result.errors).toBe(0);
  });

  // -------------------------------------------------------------------------
  // TRUST BOUNDARY (Task 35's required product guarantee): a pending
  // CandidateWallet must contribute ZERO to the signal engine's aggregate
  // until it is promoted. This is the load-bearing test for the whole task.
  // -------------------------------------------------------------------------
  it('TRUST BOUNDARY: a pending candidate contributes zero to smartWalletCount/uniqueEntityCount; promotion flips it to count', async () => {
    const now = new Date();
    const freshAddress = `${ADDR_PREFIX}_trustboundary_fresh`;
    const token = await makeToken('trustboundary');

    // The fresh candidate address "bought" the token (a real WalletTokenTrade
    // row must exist for aggregateWindow to see it as a buyer at all — but
    // per fetchAggregateInputs, wallets are looked up by isWatched/meetsProfitable;
    // a wallet with no WalletStats row and isWatched=false can never satisfy
    // either condition).
    const freshWallet = await prisma.wallet.create({
      data: { address: freshAddress, chain: CHAIN, firstSeenAt: now, lastActiveAt: now, isWatched: false }
    });
    await prisma.walletTokenTrade.create({
      data: {
        walletId: freshWallet.id,
        tokenId: token.id,
        chain: CHAIN,
        action: 'BUY',
        amountToken: 100,
        amountUsd: 5000,
        txHash: `${ADDR_PREFIX}_tx_trustboundary_1`,
        blockOrSlot: 1n,
        ts: now,
        priceUsd: 50,
        marketCapAtTrade: 500_000,
        walletScoreAtTime: 0,
        provider: 'test'
      }
    });

    // A CandidateWallet row exists for this SAME address, strong claims,
    // still validationStatus='pending' — it must NOT be trusted yet.
    await makeCandidate({
      walletAddress: freshAddress,
      claimedPnlUsd: 500000,
      claimedWinRate: 0.95,
      claimedTradeCount: 200,
      claimedRoi: 10
    });

    // --- BEFORE promotion: build the aggregate and assert zero contribution ---
    const inputsBefore = await fetchAggregateInputs(prisma, token.id, DEFAULT_SETTINGS);
    const aggregateBefore = aggregateWindow({ ...inputsBefore, windowMinutes: 1440, now });

    const freshBuyerBefore = aggregateBefore.buyers.find((b) => b.walletId === freshWallet.id);
    expect(freshBuyerBefore).toBeDefined(); // it DOES appear as a raw buyer...
    expect(freshBuyerBefore!.isWatched).toBe(false); // ...but not watched...
    expect(aggregateBefore.smartWalletCount).toBe(0); // ...and contributes NOTHING to smartWalletCount
    expect(aggregateBefore.uniqueEntityCount).toBe(0); // ...nor to uniqueEntityCount

    const candidateBefore = await prisma.candidateWallet.findFirst({ where: { walletAddress: freshAddress } });
    expect(candidateBefore!.validationStatus).toBe('pending');

    // --- Give it qualifying local trades so validation actually promotes it ---
    await seedQualifyingTrades(freshWallet.id, token.id, now);

    const validationResult = await runCandidateValidation(prisma, DEFAULT_SETTINGS);
    expect(validationResult.promoted).toBeGreaterThanOrEqual(1);

    const candidateAfter = await prisma.candidateWallet.findFirst({ where: { walletAddress: freshAddress } });
    expect(candidateAfter!.validationStatus).toBe('promoted');

    const walletAfter = await prisma.wallet.findUnique({ where: { id: freshWallet.id } });
    expect(walletAfter!.isWatched).toBe(true);

    // --- AFTER promotion: re-aggregate and assert it NOW counts ---
    const inputsAfter = await fetchAggregateInputs(prisma, token.id, DEFAULT_SETTINGS);
    const aggregateAfter = aggregateWindow({ ...inputsAfter, windowMinutes: 1440, now });

    const freshBuyerAfter = aggregateAfter.buyers.find((b) => b.walletId === freshWallet.id);
    expect(freshBuyerAfter).toBeDefined();
    expect(freshBuyerAfter!.isWatched).toBe(true);
    expect(aggregateAfter.smartWalletCount).toBeGreaterThanOrEqual(1);
    expect(aggregateAfter.uniqueEntityCount).toBeGreaterThanOrEqual(1);
  });
});
