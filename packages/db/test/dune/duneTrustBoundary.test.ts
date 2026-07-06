// FlowRadar — Wave 4.6 Dune trust-boundary tests (Task 37). Mirrors Task 35's
// own trust-boundary test shape (candidateValidation.test.ts) but sources the
// pending CandidateWallet via runTokenOverlapSearch (source=dune_token_overlap)
// instead of a raw fixture insert — proving the SAME "never counted until
// promoted" guarantee holds for Dune-originated candidates specifically, not
// just the generic external-source path Task 35 already covers.

import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import net from 'node:net';
import { DEFAULT_SETTINGS, aggregateWindow } from '@flowradar/core';
import type { DuneClient, DuneResultSet } from '@flowradar/providers';
import { prisma } from '../../src/client';
import { fetchAggregateInputs } from '../../src/fetchAggregateInputs';
import { runTokenOverlapSearch } from '../../src/dune/duneOverlap';
import { runCandidateValidation } from '../../src/candidateValidation';

const ADDR_PREFIX = 'T37TRUST';
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
      '[duneTrustBoundary.test] LITE Postgres not reachable on localhost:5439 — skipping ' +
        'integration tests. Run `npm run db:migrate` first to exercise this suite.'
    );
  }
});

async function cleanup() {
  await prisma.walletTokenTrade.deleteMany({ where: { wallet: { address: { startsWith: ADDR_PREFIX } } } });
  await prisma.walletStats.deleteMany({ where: { wallet: { address: { startsWith: ADDR_PREFIX } } } });
  await prisma.candidateWallet.deleteMany({ where: { walletAddress: { startsWith: ADDR_PREFIX } } });
  await prisma.tokenOverlapSearch.deleteMany({ where: { tokenAddresses: { hasSome: [`${ADDR_PREFIX}_tokA`] } } });
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

function makeFakeDuneClient(resultSet: DuneResultSet): DuneClient {
  return { async executeQuery() { return resultSet; } };
}

async function makeToken(addressSuffix: string) {
  return prisma.token.upsert({
    where: { chain_address: { chain: CHAIN, address: `${ADDR_PREFIX}_${addressSuffix}` } },
    create: {
      chain: CHAIN,
      address: `${ADDR_PREFIX}_${addressSuffix}`,
      symbol: 'T37TOK',
      name: 'T37 Dune Trust Boundary Token',
      decimals: 9,
      firstSeenAt: new Date(),
      riskFlags: []
    },
    update: {}
  });
}

async function seedQualifyingTrades(walletId: string, tokenId: string, now: Date) {
  let slot = 1;
  for (let i = 0; i < 10; i++) {
    await prisma.walletTokenTrade.create({
      data: {
        walletId,
        tokenId,
        chain: CHAIN,
        action: 'BUY',
        amountToken: 100,
        amountUsd: 1000,
        txHash: `${ADDR_PREFIX}_tx_${walletId}_${slot}`,
        blockOrSlot: BigInt(slot),
        ts: new Date(now.getTime() - (40 - i) * 60_000),
        priceUsd: 10,
        marketCapAtTrade: 500_000,
        walletScoreAtTime: 50,
        provider: 'test'
      }
    });
    slot += 1;
  }
  for (let i = 0; i < 10; i++) {
    await prisma.walletTokenTrade.create({
      data: {
        walletId,
        tokenId,
        chain: CHAIN,
        action: 'SELL',
        amountToken: 100,
        amountUsd: 1900,
        txHash: `${ADDR_PREFIX}_tx_${walletId}_${slot}`,
        blockOrSlot: BigInt(slot),
        ts: new Date(now.getTime() - (20 - i) * 60_000),
        priceUsd: 19,
        marketCapAtTrade: 500_000,
        walletScoreAtTime: 50,
        provider: 'test'
      }
    });
    slot += 1;
  }
}

describe.skipIf(!(await probePort('localhost', 5439)))('Dune trust boundary (Wave 4.6)', () => {
  it('TRUST BOUNDARY: a pending dune_token_overlap CandidateWallet contributes ZERO to smartWalletCount/uniqueEntityCount until Task-35 promotion', async () => {
    const now = new Date();
    const freshAddress = `${ADDR_PREFIX}_overlapwallet`;
    const token = await makeToken('trustboundary');

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
        txHash: `${ADDR_PREFIX}_tx_seed_buy`,
        blockOrSlot: 1n,
        ts: now,
        priceUsd: 50,
        marketCapAtTrade: 500_000,
        walletScoreAtTime: 0,
        provider: 'test'
      }
    });

    // This wallet arrives as a Dune overlap candidate with an extremely
    // strong (never-trusted) claim — estimated_pnl_usd alone must never be
    // enough to count.
    const client = makeFakeDuneClient({
      rows: [
        {
          wallet_address: freshAddress,
          chain: CHAIN,
          buy_count: 200,
          sell_count: 200,
          estimated_pnl_usd: 500_000,
          tokens_overlap_count: 3
        }
      ],
      usedCached: true,
      truncated: false,
      rowsReturned: 1
    });

    const searchResult = await runTokenOverlapSearch(
      prisma,
      { chain: CHAIN, tokenAddresses: [`${ADDR_PREFIX}_tokA`, `${ADDR_PREFIX}_tokB`] },
      () => client
    );
    expect(searchResult.status).toBe('done');
    expect(searchResult.candidatesUpserted).toBe(1);

    const candidateBefore = await prisma.candidateWallet.findFirst({ where: { walletAddress: freshAddress } });
    expect(candidateBefore!.source).toBe('dune_token_overlap');
    expect(candidateBefore!.validationStatus).toBe('pending');

    // --- BEFORE promotion: zero contribution to the signal aggregate ---
    const inputsBefore = await fetchAggregateInputs(prisma, token.id, DEFAULT_SETTINGS);
    const aggregateBefore = aggregateWindow({ ...inputsBefore, windowMinutes: 1440, now });

    const buyerBefore = aggregateBefore.buyers.find((b) => b.walletId === freshWallet.id);
    expect(buyerBefore).toBeDefined();
    expect(buyerBefore!.isWatched).toBe(false);
    expect(aggregateBefore.smartWalletCount).toBe(0);
    expect(aggregateBefore.uniqueEntityCount).toBe(0);

    // --- Give it qualifying local trades so Task 35's validation can promote it ---
    await seedQualifyingTrades(freshWallet.id, token.id, now);
    const validationResult = await runCandidateValidation(prisma, DEFAULT_SETTINGS);
    expect(validationResult.promoted).toBeGreaterThanOrEqual(1);

    const candidateAfter = await prisma.candidateWallet.findFirst({ where: { walletAddress: freshAddress } });
    expect(candidateAfter!.validationStatus).toBe('promoted');

    // --- AFTER promotion: now it counts ---
    const inputsAfter = await fetchAggregateInputs(prisma, token.id, DEFAULT_SETTINGS);
    const aggregateAfter = aggregateWindow({ ...inputsAfter, windowMinutes: 1440, now });

    const buyerAfter = aggregateAfter.buyers.find((b) => b.walletId === freshWallet.id);
    expect(buyerAfter!.isWatched).toBe(true);
    expect(aggregateAfter.smartWalletCount).toBeGreaterThanOrEqual(1);
    expect(aggregateAfter.uniqueEntityCount).toBeGreaterThanOrEqual(1);
  });
});
