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
import { DEFAULT_SETTINGS, aggregateWindow, isProfitableWallet } from '@flowradar/core';
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

  // ---------------------------------------------------------------------------
  // Task 35 Critical fix: promoteCandidate must persist the SAME evidence the
  // verdict was computed from, not re-derive via computeLocalPnlEvidence.
  // A candidate with NO local WalletTokenTrade rows, promoted purely on
  // PROVIDER evidence, used to get its WalletStats row written all-zero
  // (source='provider' but pnl/realized/winRate/tradeCount/avgTradeSize all
  // 0) because the re-derivation found no local trades to FIFO over. That
  // zeroed row then made fetchAggregateInputs derive meetsProfitable=false,
  // so a provider-promoted wallet with no local trades would never count
  // toward smartWalletCount — a self-inflicted trust-boundary breach.
  // ---------------------------------------------------------------------------
  it('PROVIDER-evidence promotion (no local trades) writes CORRECT (non-zeroed) stats, and meetsProfitable is true', async () => {
    const address = `${ADDR_PREFIX}_providercorrect`;
    await makeCandidate({ walletAddress: address, claimedPnlUsd: 9500, claimedWinRate: 0.6, claimedTradeCount: 20 });

    // No Wallet row, no WalletTokenTrade rows at all for this address —
    // computeLocalPnlEvidence would find nothing. The only evidence is what
    // the provider resolver returns.
    const result = await runCandidateValidation(prisma, DEFAULT_SETTINGS, async (chain, walletAddress) => {
      if (walletAddress !== address) return null;
      return { pnl30d: 9500, realizedPnlUsd: 6000, winRate: 0.6, tradeCount: 20, avgTradeSizeUsd: 500, confidence: 80 };
    });

    expect(result.promoted).toBeGreaterThanOrEqual(1);
    const row = await prisma.candidateWallet.findFirst({ where: { walletAddress: address } });
    expect(row!.validationStatus).toBe('promoted');
    expect(row!.promotedWalletId).not.toBeNull();

    const stats = await prisma.walletStats.findFirst({ where: { walletId: row!.promotedWalletId! } });
    expect(stats).not.toBeNull();
    expect(stats!.source).toBe('provider');
    // THE numeric assertions — not zeroed, matches the provider evidence.
    expect(Number(stats!.pnlUsd)).toBeCloseTo(9500, 5);
    expect(Number(stats!.realizedPnlUsd)).toBeCloseTo(6000, 5);
    expect(stats!.winRate).toBeCloseTo(0.6, 5);
    expect(stats!.tradeCount).toBe(20);
    expect(Number(stats!.avgTradeSizeUsd)).toBeCloseTo(500, 5);

    // THE trust-boundary tie-in: this stats row must actually clear
    // isProfitableWallet, so it WILL count in the aggregate.
    expect(
      isProfitableWallet(
        {
          pnlUsd: Number(stats!.pnlUsd),
          realizedPnlUsd: Number(stats!.realizedPnlUsd),
          winRate: stats!.winRate,
          tradeCount: stats!.tradeCount,
          avgTradeSizeUsd: Number(stats!.avgTradeSizeUsd)
        },
        DEFAULT_SETTINGS.profitableWallet
      )
    ).toBe(true);
  });

  it('LOCAL-evidence promotion still writes source="computed" from FIFO over injected trades', async () => {
    const now = new Date();
    const address = `${ADDR_PREFIX}_localcomputed`;
    const token = await makeToken('localcomputed');
    const wallet = await prisma.wallet.create({
      data: { address, chain: CHAIN, firstSeenAt: now, lastActiveAt: now, isWatched: false }
    });
    await seedQualifyingTrades(wallet.id, token.id, now);
    await makeCandidate({ walletAddress: address, claimedPnlUsd: 9000, claimedWinRate: 0.5, claimedTradeCount: 20 });

    const result = await runCandidateValidation(prisma, DEFAULT_SETTINGS);
    expect(result.promoted).toBeGreaterThanOrEqual(1);

    const row = await prisma.candidateWallet.findFirst({ where: { walletAddress: address } });
    expect(row!.validationStatus).toBe('promoted');

    const stats = await prisma.walletStats.findFirst({ where: { walletId: row!.promotedWalletId! } });
    expect(stats).not.toBeNull();
    expect(stats!.source).toBe('computed');
    expect(Number(stats!.pnlUsd)).toBeGreaterThan(0);
    expect(stats!.tradeCount).toBeGreaterThan(0);
  });

  it('re-aggregate after a provider-evidence promotion: the provider-promoted wallet CONTRIBUTES to smartWalletCount', async () => {
    const now = new Date();
    const address = `${ADDR_PREFIX}_provideraggregate`;
    const token = await makeToken('provideraggregate');

    // A real Wallet + a BUY trade so it appears as a raw buyer in the
    // aggregate — but deliberately NO local trade history rich enough to
    // clear thresholds via FIFO (mirrors the trust-boundary test's fresh
    // wallet setup): the ONLY qualifying evidence is provider-sourced.
    const wallet = await prisma.wallet.create({
      data: { address, chain: CHAIN, firstSeenAt: now, lastActiveAt: now, isWatched: false }
    });
    await prisma.walletTokenTrade.create({
      data: {
        walletId: wallet.id,
        tokenId: token.id,
        chain: CHAIN,
        action: 'BUY',
        amountToken: 100,
        amountUsd: 5000,
        txHash: `${ADDR_PREFIX}_tx_provideraggregate_1`,
        blockOrSlot: 1n,
        ts: now,
        priceUsd: 50,
        marketCapAtTrade: 500_000,
        walletScoreAtTime: 0,
        provider: 'test'
      }
    });
    await makeCandidate({ walletAddress: address, claimedPnlUsd: 9500, claimedWinRate: 0.6, claimedTradeCount: 20 });

    const inputsBefore = await fetchAggregateInputs(prisma, token.id, DEFAULT_SETTINGS);
    const aggregateBefore = aggregateWindow({ ...inputsBefore, windowMinutes: 1440, now });
    expect(aggregateBefore.smartWalletCount).toBe(0);

    const result = await runCandidateValidation(prisma, DEFAULT_SETTINGS, async (chain, walletAddress) => {
      if (walletAddress !== address) return null;
      return { pnl30d: 9500, realizedPnlUsd: 6000, winRate: 0.6, tradeCount: 20, avgTradeSizeUsd: 500, confidence: 80 };
    });
    expect(result.promoted).toBeGreaterThanOrEqual(1);

    const row = await prisma.candidateWallet.findFirst({ where: { walletAddress: address } });
    expect(row!.validationStatus).toBe('promoted');
    const walletAfter = await prisma.wallet.findUnique({ where: { id: wallet.id } });
    expect(walletAfter!.isWatched).toBe(true);

    const inputsAfter = await fetchAggregateInputs(prisma, token.id, DEFAULT_SETTINGS);
    const aggregateAfter = aggregateWindow({ ...inputsAfter, windowMinutes: 1440, now });

    const buyerAfter = aggregateAfter.buyers.find((b) => b.walletId === wallet.id);
    expect(buyerAfter).toBeDefined();
    expect(buyerAfter!.isWatched).toBe(true);
    // THE proof the zeroed-stats breach is gone: a provider-promoted wallet
    // with no local FIFO-qualifying trades still contributes, because its
    // WalletStats row now carries the real provider figures.
    expect(aggregateAfter.smartWalletCount).toBeGreaterThanOrEqual(1);
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

  // ---------------------------------------------------------------------------
  // Atomic promotion (2026-07-10 cross-model audit finding): promoteCandidate
  // (Wallet.isWatched=true + WalletStats write) and the CandidateWallet
  // 'promoted' status write must be ONE transaction. Pre-fix, the wallet was
  // promoted first and the status written second, so a crash between the two
  // left a WATCHED wallet (already influencing signals) whose candidate row
  // was reset to 'pending' by the error handler — a wallet in the tracked set
  // that validation bookkeeping says was never promoted.
  //
  // The proxy below simulates that crash: it lets every DB call through
  // except the candidateWallet.update that writes validationStatus='promoted'
  // (both on the root client and inside any interactive $transaction).
  // ---------------------------------------------------------------------------
  it('ATOMIC PROMOTION: a crash on the candidate status write rolls back the wallet promotion (no watched wallet without a promoted candidate)', async () => {
    const address = `${ADDR_PREFIX}_atomicpromo`;
    await makeCandidate({ walletAddress: address, claimedPnlUsd: 9500, claimedWinRate: 0.6, claimedTradeCount: 20 });

    function crashingStatusWriteProxy<T extends object>(client: T): T {
      return new Proxy(client, {
        get(target, prop, receiver) {
          if (prop === 'candidateWallet') {
            const delegate = Reflect.get(target, prop, receiver) as Record<string, unknown>;
            return new Proxy(delegate, {
              get(dTarget, dProp, dReceiver) {
                const original = Reflect.get(dTarget, dProp, dReceiver);
                if (dProp === 'update' && typeof original === 'function') {
                  return (args: { data?: { validationStatus?: string } }) => {
                    if (args?.data?.validationStatus === 'promoted') {
                      throw new Error('simulated crash between wallet promotion and candidate status write');
                    }
                    return (original as (a: unknown) => unknown).call(dTarget, args);
                  };
                }
                return typeof original === 'function' ? (original as CallableFunction).bind(dTarget) : original;
              }
            });
          }
          if (prop === '$transaction') {
            const original = Reflect.get(target, prop, receiver) as CallableFunction;
            return (arg: unknown, opts?: unknown) => {
              if (typeof arg === 'function') {
                return original.call(target, (tx: object) => (arg as (t: object) => unknown)(crashingStatusWriteProxy(tx)), opts);
              }
              return original.call(target, arg, opts);
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === 'function' ? (value as CallableFunction).bind(target) : value;
        }
      });
    }

    const crashingPrisma = crashingStatusWriteProxy(prisma);
    const result = await runCandidateValidation(crashingPrisma as typeof prisma, DEFAULT_SETTINGS, async (chain, walletAddress) => {
      if (walletAddress !== address) return null;
      return { pnl30d: 9500, realizedPnlUsd: 6000, winRate: 0.6, tradeCount: 20, avgTradeSizeUsd: 500, confidence: 80 };
    });

    // The crash is counted as an error, not a promotion. promoted===0 is
    // exact-safe even against foreign pending rows in the shared LITE DB (the
    // proxy blocks EVERY 'promoted' status write); errors uses >= like the
    // rest of this file because foreign candidates can add their own.
    expect(result.promoted).toBe(0);
    expect(result.errors).toBeGreaterThanOrEqual(1);

    // Error handler resets the candidate to pending (existing behavior).
    const candidate = await prisma.candidateWallet.findFirst({ where: { walletAddress: address } });
    expect(candidate!.validationStatus).toBe('pending');
    expect(candidate!.promotedWalletId).toBeNull();

    // THE invariant: the interrupted promotion must not leave a watched
    // wallet behind. Rolled back => no Wallet row (it was created inside the
    // transaction) and no stats row.
    const wallet = await prisma.wallet.findUnique({
      where: { address_chain: { address, chain: CHAIN } },
      include: { stats: true }
    });
    expect(wallet?.isWatched ?? false).toBe(false);
    expect(wallet?.stats ?? []).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Concurrent-pass safety (2026-07-10 Codex review Critical): two validation
  // passes racing on the same pending candidate must not double-process it or
  // clobber each other's terminal writes. Two guards under test:
  //   1. CLAIM: each row is claimed with an atomic pending->validating
  //      updateMany; a row whose status changed since the batch select is
  //      skipped, never re-claimed (the old blanket updateMany would even
  //      demote a just-promoted row back to 'validating').
  //   2. RESET: the error handler's reset-to-pending only fires while the row
  //      is still 'validating' — it must not overwrite a terminal status a
  //      concurrent pass committed.
  // ---------------------------------------------------------------------------
  it('CLAIM GUARD: a candidate whose status changed after the batch select is skipped, not re-processed', async () => {
    const address = `${ADDR_PREFIX}_claimrace`;
    const created = await makeCandidate({ walletAddress: address, claimedPnlUsd: 9500, claimedWinRate: 0.6, claimedTradeCount: 20 });

    // Proxy: after runCandidateValidation's batch findMany returns, simulate
    // a concurrent pass claiming the row (status -> 'validating') before this
    // pass gets to claim it.
    const raceyPrisma = new Proxy(prisma, {
      get(target, prop, receiver) {
        if (prop === 'candidateWallet') {
          const delegate = Reflect.get(target, prop, receiver) as Record<string, unknown>;
          return new Proxy(delegate, {
            get(dTarget, dProp, dReceiver) {
              const original = Reflect.get(dTarget, dProp, dReceiver);
              if (dProp === 'findMany' && typeof original === 'function') {
                return async (args: unknown) => {
                  const rows = await (original as (a: unknown) => Promise<unknown[]>).call(dTarget, args);
                  await prisma.candidateWallet.update({ where: { id: created.id }, data: { validationStatus: 'validating' } });
                  return rows;
                };
              }
              return typeof original === 'function' ? (original as CallableFunction).bind(dTarget) : original;
            }
          });
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? (value as CallableFunction).bind(target) : value;
      }
    });

    const result = await runCandidateValidation(raceyPrisma as typeof prisma, DEFAULT_SETTINGS, async (chain, walletAddress) => {
      if (walletAddress !== address) return null;
      return { pnl30d: 9500, realizedPnlUsd: 6000, winRate: 0.6, tradeCount: 20, avgTradeSizeUsd: 500, confidence: 80 };
    });

    // The row belongs to the other pass now: skipped, untouched. Row-level
    // assertions only — global counters could see foreign pending rows from
    // the shared LITE DB (seed leaves some behind by design), and with 100+
    // foreign rows the batch could even exclude this candidate entirely;
    // either way the row-level invariant below is what the guard promises.
    const row = await prisma.candidateWallet.findFirst({ where: { walletAddress: address } });
    expect(row!.validationStatus).toBe('validating');
    const wallet = await prisma.wallet.findUnique({ where: { address_chain: { address, chain: CHAIN } } });
    expect(wallet).toBeNull();
  });

  it('RESET GUARD: the error-handler reset must not clobber a terminal status a concurrent pass committed', async () => {
    const address = `${ADDR_PREFIX}_resetrace`;
    const created = await makeCandidate({ walletAddress: address, claimedPnlUsd: 9500, claimedWinRate: 0.6, claimedTradeCount: 20 });

    // Proxy: this pass's own 'promoted' status write first observes a
    // concurrent pass committing 'promoted' for the same row, then crashes.
    // The catch handler's reset must leave the concurrent 'promoted' intact.
    function crashingAfterConcurrentCommitProxy<T extends object>(client: T): T {
      return new Proxy(client, {
        get(target, prop, receiver) {
          if (prop === 'candidateWallet') {
            const delegate = Reflect.get(target, prop, receiver) as Record<string, unknown>;
            return new Proxy(delegate, {
              get(dTarget, dProp, dReceiver) {
                const original = Reflect.get(dTarget, dProp, dReceiver);
                if (dProp === 'update' && typeof original === 'function') {
                  return async (args: { data?: { validationStatus?: string } }) => {
                    if (args?.data?.validationStatus === 'promoted') {
                      await prisma.candidateWallet.update({
                        where: { id: created.id },
                        data: { validationStatus: 'promoted' }
                      });
                      throw new Error('simulated crash after a concurrent pass committed promoted');
                    }
                    return (original as (a: unknown) => unknown).call(dTarget, args);
                  };
                }
                return typeof original === 'function' ? (original as CallableFunction).bind(dTarget) : original;
              }
            });
          }
          if (prop === '$transaction') {
            const original = Reflect.get(target, prop, receiver) as CallableFunction;
            return (arg: unknown, opts?: unknown) => {
              if (typeof arg === 'function') {
                return original.call(target, (tx: object) => (arg as (t: object) => unknown)(crashingAfterConcurrentCommitProxy(tx)), opts);
              }
              return original.call(target, arg, opts);
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === 'function' ? (value as CallableFunction).bind(target) : value;
        }
      });
    }

    const result = await runCandidateValidation(
      crashingAfterConcurrentCommitProxy(prisma) as typeof prisma,
      DEFAULT_SETTINGS,
      async (chain, walletAddress) => {
        if (walletAddress !== address) return null;
        return { pnl30d: 9500, realizedPnlUsd: 6000, winRate: 0.6, tradeCount: 20, avgTradeSizeUsd: 500, confidence: 80 };
      }
    );

    expect(result.errors).toBeGreaterThanOrEqual(1);
    const row = await prisma.candidateWallet.findFirst({ where: { walletAddress: address } });
    expect(row!.validationStatus).toBe('promoted');
  });
});
