// FlowRadar — top-PnL discovery tests (scope-correction pipeline, DB).

import { describe, expect, it, afterAll, beforeEach } from 'vitest';
import net from 'node:net';
import type { TokenTopTrader, TokenTopTradersProvider } from '@flowradar/providers';
import { prisma } from '../../src/client';
import { buildTokenTopPnlCandidates, validateProviderClaim } from '../../src/runnermining/topPnl';

const PREFIX = 'DRMTP'; // base58-safe (no 0/O/I/l)

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
  await prisma.tokenTopPnlCandidate.deleteMany({ where: { mint: { startsWith: PREFIX } } });
  await prisma.topPnlFetchState.deleteMany({ where: { mint: { startsWith: PREFIX } } });
  await prisma.walletTokenTrade.deleteMany({ where: { txHash: { startsWith: PREFIX } } });
  await prisma.tokenLifecycle.deleteMany({ where: { mint: { startsWith: PREFIX } } });
  await prisma.wallet.deleteMany({ where: { address: { startsWith: PREFIX } } });
  await prisma.token.deleteMany({ where: { address: { startsWith: PREFIX } } });
}

let tokenSeq = 0;
async function seedRunnerToken() {
  tokenSeq += 1;
  const a = addr(`TK${tokenSeq}`);
  const token = await prisma.token.create({
    data: { chain: 'SOLANA', address: a, symbol: `T${tokenSeq}`, name: a, decimals: 9, firstSeenAt: T0, riskFlags: [] },
    select: { id: true, address: true }
  });
  await prisma.tokenLifecycle.create({
    data: {
      mint: a, enteredUniverseAt: T0, sourcesJson: {}, coverage: 'covered',
      runnerClass: 'verified_above_10m', confidence: 'high', classifiedAt: T0
    }
  });
  return token;
}

async function seedWallet(suffix: string) {
  return prisma.wallet.create({
    data: { address: addr(suffix), chain: 'SOLANA', firstSeenAt: T0, lastActiveAt: T0 },
    select: { id: true, address: true }
  });
}

let txSeq = 0;
async function seedTrade(walletId: string, tokenId: string, action: 'BUY' | 'SELL', usd: number, ts: Date) {
  txSeq += 1;
  return prisma.walletTokenTrade.create({
    data: {
      walletId, tokenId, chain: 'SOLANA', action, amountToken: '10', amountUsd: String(usd),
      txHash: addr(`TX${txSeq}`), blockOrSlot: 1n, ts, priceUsd: '1', marketCapAtTrade: '100000',
      walletScoreAtTime: 50, provider: 'test'
    }
  });
}

function mockProvider(itemsByMint: Record<string, TokenTopTrader[]>, calls: string[] = []): TokenTopTradersProvider {
  return {
    async getTopTraders(_chain, tokenAddress) {
      calls.push(tokenAddress);
      const items = itemsByMint[tokenAddress];
      if (items === undefined) throw new Error('mock provider error');
      return items;
    }
  };
}

const claim = (wallet: string, realized: number | null): TokenTopTrader => ({
  walletAddress: wallet,
  chain: 'SOLANA',
  realizedPnlUsd: realized,
  unrealizedPnlUsd: 0,
  totalPnlUsd: realized,
  volumeBuyUsd: 100,
  volumeSellUsd: realized === null ? null : 100 + realized,
  tradeBuy: 1,
  tradeSell: 1,
  tags: [],
  raw: { owner: wallet }
});

beforeEach(async () => {
  if (dbReachable) await cleanup();
});

afterAll(async () => {
  if (!dbReachable) return;
  await cleanup();
  await prisma.$disconnect();
});

describe('validateProviderClaim (pure)', () => {
  const base = {
    claimedRealizedPnlUsd: 100,
    localRealizedProxyUsd: 90,
    hasLocalTrades: true,
    localUnpriced: false,
    localTruncated: false,
    malformed: false
  };
  it('covers every honesty branch', () => {
    expect(validateProviderClaim(base).validation).toBe('locally_verified');
    expect(validateProviderClaim({ ...base, localRealizedProxyUsd: 10 }).validation).toBe('partially_verified'); // magnitude differs
    expect(validateProviderClaim({ ...base, localRealizedProxyUsd: -50 }).validation).toBe('conflicting'); // sign conflict
    expect(validateProviderClaim({ ...base, hasLocalTrades: false }).validation).toBe('provider_only');
    expect(validateProviderClaim({ ...base, localUnpriced: true, localRealizedProxyUsd: null }).validation).toBe('incomplete');
    expect(validateProviderClaim({ ...base, localTruncated: true }).validation).toBe('incomplete');
    expect(validateProviderClaim({ ...base, malformed: true }).validation).toBe('invalid');
    expect(validateProviderClaim({ ...base, claimedRealizedPnlUsd: null }).validation).toBe('partially_verified');
  });
  it('incomparable provider windows can never verify NOR conflict', () => {
    const r = validateProviderClaim({ ...base, windowsComparable: false });
    expect(r.validation).toBe('partially_verified');
    expect(r.reasonCodes).toContain('provider_window_not_comparable_to_local_history');
    // Even a wild sign conflict is NOT 'conflicting' across incomparable windows.
    expect(
      validateProviderClaim({ ...base, localRealizedProxyUsd: -500, windowsComparable: false }).validation
    ).toBe('partially_verified');
  });
});

describe.skipIf(!dbReachable)('buildTokenTopPnlCandidates (discovery builder)', () => {
  it('local reconstruction ranks priced wallets, withholds proxies on unpriced legs, idempotently', async () => {
    const tok = await seedRunnerToken();
    const winner = await seedWallet('WW');
    const loser = await seedWallet('WL');
    const unpriced = await seedWallet('WU');
    await seedTrade(winner.id, tok.id, 'BUY', 100, T0);
    await seedTrade(winner.id, tok.id, 'SELL', 500, new Date(T0.getTime() + 1000));
    await seedTrade(loser.id, tok.id, 'BUY', 100, T0);
    await seedTrade(loser.id, tok.id, 'SELL', 40, new Date(T0.getTime() + 2000));
    await seedTrade(unpriced.id, tok.id, 'BUY', 0, T0); // legacy 0-for-unpriced

    const r = await buildTokenTopPnlCandidates(prisma, { chain: 'SOLANA', mints: [tok.address] });
    expect(r.errors).toBe(0);
    expect(r.localRowsWritten).toBe(3);
    expect(r.provider.enabled).toBe(false);

    const rows = await prisma.tokenTopPnlCandidate.findMany({
      where: { mint: tok.address },
      orderBy: { providerRank: 'asc' }
    });
    expect(rows[0].walletAddress).toBe(winner.address); // rank 1 = best proxy
    expect(Number(rows[0].localRealizedProxyUsd)).toBe(400);
    expect(rows[0].validation).toBe('locally_verified');
    expect(rows[1].walletAddress).toBe(loser.address);
    expect(Number(rows[1].localRealizedProxyUsd)).toBe(-60);
    const unpricedRow = rows.find((x) => x.walletAddress === unpriced.address);
    expect(unpricedRow?.validation).toBe('incomplete');
    expect(unpricedRow?.localRealizedProxyUsd).toBeNull(); // withheld, never fabricated
    expect(unpricedRow?.caveats.join(' ')).toContain('withheld rather than fabricated');

    await buildTokenTopPnlCandidates(prisma, { chain: 'SOLANA', mints: [tok.address] });
    expect(await prisma.tokenTopPnlCandidate.count({ where: { mint: tok.address } })).toBe(3);
  });

  it('provider rows validate against the local view; provider-only wallets never gain local truth', async () => {
    const tok = await seedRunnerToken();
    const known = await seedWallet('WK');
    await seedTrade(known.id, tok.id, 'BUY', 100, T0);
    await seedTrade(known.id, tok.id, 'SELL', 190, new Date(T0.getTime() + 1000));

    const provider = mockProvider({
      [tok.address]: [
        claim(known.address, 95), // close to local proxy 90 => locally_verified
        claim(addr('GHST'), 5000) // no local trades => provider_only
      ]
    });
    const r = await buildTokenTopPnlCandidates(prisma, {
      chain: 'SOLANA',
      mints: [tok.address],
      provider
    });
    expect(r.providerRowsWritten).toBe(2);
    expect(r.provider.mintsFetched).toBe(1);

    const verified = await prisma.tokenTopPnlCandidate.findUniqueOrThrow({
      where: {
        chain_mint_walletAddress_source: {
          chain: 'SOLANA', mint: tok.address, walletAddress: known.address, source: 'birdeye_top_traders'
        }
      }
    });
    // Birdeye's 24h present window is never comparable against the
    // all-history local view — the claim caps at partially_verified.
    expect(verified.validation).toBe('partially_verified');
    expect(verified.reasonCodes).toContain('provider_window_not_comparable_to_local_history');
    expect(verified.providerRank).toBe(1);
    expect(Number(verified.claimedRealizedPnlUsd)).toBe(95);
    expect(verified.providerTimeFrame).toBe('24h');
    expect(verified.caveats.join(' ')).toContain('PRESENT window');

    const ghost = await prisma.tokenTopPnlCandidate.findUniqueOrThrow({
      where: {
        chain_mint_walletAddress_source: {
          chain: 'SOLANA', mint: tok.address, walletAddress: addr('GHST'), source: 'birdeye_top_traders'
        }
      }
    });
    expect(ghost.validation).toBe('provider_only');
    expect(ghost.localBuyCount).toBe(0);
    expect(ghost.localRealizedProxyUsd).toBeNull();
  });

  it('provider fetches are BUDGETED and RESUMABLE; errors are receipted in fetch state', async () => {
    const tok1 = await seedRunnerToken();
    const tok2 = await seedRunnerToken();
    const calls: string[] = [];
    const provider = mockProvider({ [tok1.address]: [], [tok2.address]: [] }, calls);

    // Budget 1: only the first mint (stable mint order) is fetched.
    const r1 = await buildTokenTopPnlCandidates(prisma, {
      chain: 'SOLANA',
      mints: [tok1.address, tok2.address],
      provider,
      requestBudget: 1
    });
    expect(r1.provider.requestsUsed).toBe(1);
    expect(r1.provider.budgetExhausted).toBe(true);
    expect(calls).toHaveLength(1);

    // Resume: the fetched mint is skipped, the remaining one is fetched.
    const r2 = await buildTokenTopPnlCandidates(prisma, {
      chain: 'SOLANA',
      mints: [tok1.address, tok2.address],
      provider,
      requestBudget: 10
    });
    expect(r2.provider.mintsSkippedResume).toBe(1);
    expect(r2.provider.requestsUsed).toBe(1);
    expect(calls).toHaveLength(2);

    // Provider error: state row provider_error with the message, retry counted.
    const tok3 = await seedRunnerToken();
    const failing = mockProvider({}); // every call throws
    const r3 = await buildTokenTopPnlCandidates(prisma, {
      chain: 'SOLANA',
      mints: [tok3.address],
      provider: failing
    });
    expect(r3.provider.mintsErrored).toBe(1);
    expect(r3.errors).toBe(0); // provider errors are isolated per mint, not batch errors
    const state = await prisma.topPnlFetchState.findUniqueOrThrow({
      where: { chain_mint_provider: { chain: 'SOLANA', mint: tok3.address, provider: 'birdeye_top_traders' } }
    });
    expect(state.status).toBe('provider_error');
    expect(state.retryCount).toBe(1);
    expect(state.lastError).toContain('mock provider error');
    // retryErrored:false skips it without a request.
    const r4 = await buildTokenTopPnlCandidates(prisma, {
      chain: 'SOLANA',
      mints: [tok3.address],
      provider: failing,
      retryErrored: false
    });
    expect(r4.provider.requestsUsed).toBe(0);
    expect(r4.provider.mintsSkippedResume).toBe(1);
  });

  it('malformed provider items classify invalid — never poison the table silently', async () => {
    const tok = await seedRunnerToken();
    const provider = mockProvider({
      [tok.address]: [
        { walletAddress: addr('BAD'), chain: 'SOLANA', realizedPnlUsd: Number.NaN, raw: {} } as TokenTopTrader
      ]
    });
    await buildTokenTopPnlCandidates(prisma, { chain: 'SOLANA', mints: [tok.address], provider });
    const row = await prisma.tokenTopPnlCandidate.findFirstOrThrow({
      where: { mint: tok.address, source: 'birdeye_top_traders' }
    });
    expect(row.validation).toBe('invalid');
    expect(row.confidence).toBeLessThanOrEqual(5);
  });
});
