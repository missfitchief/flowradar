// FlowRadar — runTokenTopTraderBackfill integration tests (Task 35, Wave 4.5,
// Spec §5b). Same LITE-Postgres integration pattern as
// externalWalletSource.test.ts.

import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import net from 'node:net';
import { DEFAULT_SETTINGS } from '@flowradar/core';
import type { Chain } from '@flowradar/core';
import type { TokenTopTradersProvider, TokenTopTrader } from '@flowradar/providers';
import { prisma } from '../src/client';
import { runTokenTopTraderBackfill } from '../src/tokenTopTraderBackfill';

const ADDR_PREFIX = 'T35BACKFILL';
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
      '[tokenTopTraderBackfill.test] LITE Postgres not reachable on localhost:5439 — skipping ' +
        'integration tests. Run `npm run db:migrate` first to exercise this suite.'
    );
  }
});

async function cleanup() {
  await prisma.candidateWallet.deleteMany({ where: { walletAddress: { startsWith: ADDR_PREFIX } } });
  await prisma.tokenMarketSnapshot.deleteMany({ where: { token: { address: { startsWith: ADDR_PREFIX } } } });
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

/**
 * Fake provider scoped to ONE token address — every other token in the
 * shared DB (leftover seed data, or other tests' fixtures) resolves to an
 * empty trader list rather than this test's own fixture traders, so
 * assertions on candidate rows / call counts aren't polluted by unrelated
 * qualifying tokens already present in the shared LITE-Postgres instance.
 */
function makeFakeProvider(
  tokenAddress: string,
  traders: TokenTopTrader[]
): TokenTopTradersProvider & { callCount: number; scopedCallCount: number } {
  return {
    callCount: 0,
    scopedCallCount: 0,
    async getTopTraders(_chain: Chain, requestedTokenAddress: string) {
      this.callCount += 1;
      if (requestedTokenAddress !== tokenAddress) return [];
      this.scopedCallCount += 1;
      return traders;
    }
  };
}

async function makeTokenWithSnapshots(
  addressSuffix: string,
  now: Date,
  lookbackHours: number,
  { lookbackMcap, latestMcap }: { lookbackMcap: number; latestMcap: number }
) {
  const token = await prisma.token.create({
    data: {
      chain: CHAIN,
      address: `${ADDR_PREFIX}_${addressSuffix}`,
      symbol: 'T35BF',
      name: 'T35 Backfill Token',
      decimals: 9,
      firstSeenAt: new Date(now.getTime() - (lookbackHours + 10) * 60 * 60 * 1000),
      riskFlags: []
    }
  });

  await prisma.tokenMarketSnapshot.create({
    data: {
      tokenId: token.id,
      ts: new Date(now.getTime() - (lookbackHours + 1) * 60 * 60 * 1000),
      priceUsd: 1,
      marketCapUsd: lookbackMcap,
      fdvUsd: lookbackMcap,
      liquidityUsd: 50000,
      vol5m: 0,
      vol1h: 0,
      vol6h: 0,
      vol24h: 0,
      holderCount: 100
    }
  });
  await prisma.tokenMarketSnapshot.create({
    data: {
      tokenId: token.id,
      ts: now,
      priceUsd: 5,
      marketCapUsd: latestMcap,
      fdvUsd: latestMcap,
      liquidityUsd: 80000,
      vol5m: 0,
      vol1h: 0,
      vol6h: 0,
      vol24h: 0,
      holderCount: 200
    }
  });

  return token;
}

describe.skipIf(!(await probePort('localhost', 5439)))('runTokenTopTraderBackfill', () => {
  it('a qualifying token (mcap expanded past the threshold) backfills top traders as pending CandidateWallet rows', async () => {
    const now = new Date();
    const lookbackHours = DEFAULT_SETTINGS.connectors.topTraderBackfill.lookbackHours;
    const token = await makeTokenWithSnapshots('qualify', now, lookbackHours, { lookbackMcap: 100_000, latestMcap: 300_000 }); // 3x >= 2x min

    const provider = makeFakeProvider(token.address, [
      { walletAddress: `${ADDR_PREFIX}_trader1`, chain: CHAIN, pnlUsd: 8000, winRate: 0.5, tradeCount: 20 }
    ]);

    const result = await runTokenTopTraderBackfill(prisma, DEFAULT_SETTINGS, () => provider, undefined, now);

    expect(result.tokensQualified).toBeGreaterThanOrEqual(1);
    expect(result.candidatesUpserted).toBeGreaterThanOrEqual(1);
    expect(provider.scopedCallCount).toBe(1);

    const candidate = await prisma.candidateWallet.findFirst({
      where: { walletAddress: `${ADDR_PREFIX}_trader1`, source: 'birdeye_top_traders' }
    });
    expect(candidate).not.toBeNull();
    expect(candidate!.validationStatus).toBe('pending');
    expect(Number(candidate!.claimedPnlUsd)).toBe(8000);
  });

  it('a non-qualifying token (mcap did NOT expand past the threshold) is skipped — provider never called for it', async () => {
    const now = new Date();
    const lookbackHours = DEFAULT_SETTINGS.connectors.topTraderBackfill.lookbackHours;
    const token = await makeTokenWithSnapshots('noqualify', now, lookbackHours, { lookbackMcap: 100_000, latestMcap: 110_000 }); // 1.1x < 2x min

    const provider = makeFakeProvider(token.address, [
      { walletAddress: `${ADDR_PREFIX}_shouldnotexist`, chain: CHAIN, pnlUsd: 8000 }
    ]);

    await runTokenTopTraderBackfill(prisma, DEFAULT_SETTINGS, () => provider, undefined, now);

    expect(provider.scopedCallCount).toBe(0); // this specific token never qualified, so getTopTraders was never asked about it
    const candidate = await prisma.candidateWallet.findFirst({ where: { walletAddress: `${ADDR_PREFIX}_shouldnotexist` } });
    expect(candidate).toBeNull();
  });

  it('a token with no snapshot old enough for a lookback baseline is skipped gracefully (not an infinite expansion)', async () => {
    const now = new Date();
    const token = await prisma.token.create({
      data: {
        chain: CHAIN,
        address: `${ADDR_PREFIX}_toonew`,
        symbol: 'T35NEW',
        name: 'Too New',
        decimals: 9,
        firstSeenAt: now,
        riskFlags: []
      }
    });
    await prisma.tokenMarketSnapshot.create({
      data: {
        tokenId: token.id,
        ts: now,
        priceUsd: 1,
        marketCapUsd: 500_000,
        fdvUsd: 500_000,
        liquidityUsd: 50_000,
        vol5m: 0,
        vol1h: 0,
        vol6h: 0,
        vol24h: 0,
        holderCount: 50
      }
    });

    const provider = makeFakeProvider(token.address, [{ walletAddress: `${ADDR_PREFIX}_shouldnotexist2`, chain: CHAIN }]);
    const result = await runTokenTopTraderBackfill(prisma, DEFAULT_SETTINGS, () => provider, undefined, now);

    expect(provider.scopedCallCount).toBe(0); // no lookback baseline => never asked about THIS token
    const candidate = await prisma.candidateWallet.findFirst({ where: { walletAddress: `${ADDR_PREFIX}_shouldnotexist2` } });
    expect(candidate).toBeNull();
    void result;
  });

  it('graceful when no provider is available for the chain — no crash, zero candidates', async () => {
    const now = new Date();
    const lookbackHours = DEFAULT_SETTINGS.connectors.topTraderBackfill.lookbackHours;
    const token = await makeTokenWithSnapshots('noprovider', now, lookbackHours, { lookbackMcap: 100_000, latestMcap: 500_000 });

    const result = await runTokenTopTraderBackfill(prisma, DEFAULT_SETTINGS, () => null, undefined, now);

    expect(result.errors).toBe(0);
    const candidate = await prisma.candidateWallet.findFirst({ where: { walletAddress: { startsWith: `${ADDR_PREFIX}_noprovider` } } });
    expect(candidate).toBeNull();
    void token;
  });

  it('re-sync (second run) does not downgrade an already-promoted candidate, and dedupes on (walletAddress, chain, source)', async () => {
    const now = new Date();
    const lookbackHours = DEFAULT_SETTINGS.connectors.topTraderBackfill.lookbackHours;
    const token = await makeTokenWithSnapshots('resync', now, lookbackHours, { lookbackMcap: 100_000, latestMcap: 400_000 });

    const provider = makeFakeProvider(token.address, [{ walletAddress: `${ADDR_PREFIX}_resync1`, chain: CHAIN, pnlUsd: 5000 }]);
    await runTokenTopTraderBackfill(prisma, DEFAULT_SETTINGS, () => provider, undefined, now);

    const row = await prisma.candidateWallet.findFirst({ where: { walletAddress: `${ADDR_PREFIX}_resync1` } });
    await prisma.candidateWallet.update({ where: { id: row!.id }, data: { validationStatus: 'promoted' } });

    const provider2 = makeFakeProvider(token.address, [{ walletAddress: `${ADDR_PREFIX}_resync1`, chain: CHAIN, pnlUsd: 9000 }]);
    await runTokenTopTraderBackfill(prisma, DEFAULT_SETTINGS, () => provider2, undefined, now);

    const allRows = await prisma.candidateWallet.findMany({ where: { walletAddress: `${ADDR_PREFIX}_resync1` } });
    expect(allRows).toHaveLength(1);
    expect(allRows[0]!.validationStatus).toBe('promoted');
    expect(Number(allRows[0]!.claimedPnlUsd)).toBe(9000);
  });

  it('one token throwing never aborts the pass for other qualifying tokens (per-token try/catch)', async () => {
    const now = new Date();
    const lookbackHours = DEFAULT_SETTINGS.connectors.topTraderBackfill.lookbackHours;
    await makeTokenWithSnapshots('good', now, lookbackHours, { lookbackMcap: 100_000, latestMcap: 300_000 });
    await makeTokenWithSnapshots('bad', now, lookbackHours, { lookbackMcap: 100_000, latestMcap: 300_000 });

    const result = await runTokenTopTraderBackfill(
      prisma,
      DEFAULT_SETTINGS,
      () => ({
        async getTopTraders(_chain: Chain, tokenAddress: string) {
          if (tokenAddress.includes('_bad')) throw new Error('simulated provider failure');
          return [{ walletAddress: `${ADDR_PREFIX}_fromgood`, chain: CHAIN, pnlUsd: 5000 }];
        }
      }),
      undefined,
      now
    );

    expect(result.errors).toBeGreaterThanOrEqual(1);
    const goodCandidate = await prisma.candidateWallet.findFirst({ where: { walletAddress: `${ADDR_PREFIX}_fromgood` } });
    expect(goodCandidate).not.toBeNull();
  });
});
