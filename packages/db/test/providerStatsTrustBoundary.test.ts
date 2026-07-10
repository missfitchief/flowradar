// FlowRadar — provider-claimed stats must not confer smart-money status
// (2026-07-10 cross-model audit finding, extends Wave 4.5's trust boundary).
//
// The Wave 4.5 boundary proved a CandidateWallet row influences nothing until
// promoted. This file closes the SIDE DOOR the audit found: the legacy
// walletDiscovery job (Task 30) creates Wallet rows directly with
// provider-reported WalletStats (source='provider', isWatched=false), and
// fetchAggregateInputs derived meetsProfitable from the latest stats row
// REGARDLESS of source — so a wallet an external provider merely CLAIMED was
// profitable counted as smart money (aggregate.ts isSmart = isWatched ||
// meetsProfitable) with no validation, no promotion, no operator action.
//
// The rule these tests enforce: provider-sourced stats confer meetsProfitable
// ONLY when the wallet is watched (i.e. it cleared candidate validation —
// promoteCandidate sets isWatched=true — or an operator explicitly watches
// it). csv stats are operator-vouched and computed stats are FIFO over real
// ingested trades, so both stay trusted on their own.

import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import net from 'node:net';
import { DEFAULT_SETTINGS, aggregateWindow } from '@flowradar/core';
import { prisma } from '../src/client';
import { fetchAggregateInputs } from '../src/fetchAggregateInputs';

const ADDR_PREFIX = 'PROVTB';
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
});

async function cleanup() {
  await prisma.walletTokenTrade.deleteMany({ where: { wallet: { address: { startsWith: ADDR_PREFIX } } } });
  await prisma.walletStats.deleteMany({ where: { wallet: { address: { startsWith: ADDR_PREFIX } } } });
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

// Numbers that comfortably clear every DEFAULT_SETTINGS.profitableWallet
// threshold — the SAME shape the T35 provider-promotion test uses, so a
// wallet carrying them fails meetsProfitable only because of the source gate,
// never because of the thresholds.
const CLEARLY_PROFITABLE = {
  pnlUsd: 9500,
  realizedPnlUsd: 6000,
  unrealizedPnlUsd: 3500,
  winRate: 0.6,
  tradeCount: 20,
  avgTradeSizeUsd: 500
};

async function makeWalletWithStats(
  suffix: string,
  isWatched: boolean,
  source: 'csv' | 'computed' | 'provider'
): Promise<string> {
  const now = new Date();
  const wallet = await prisma.wallet.create({
    data: { address: `${ADDR_PREFIX}_${suffix}`, chain: CHAIN, firstSeenAt: now, lastActiveAt: now, isWatched }
  });
  await prisma.walletStats.create({
    data: {
      walletId: wallet.id,
      window: '30d',
      ...CLEARLY_PROFITABLE,
      walletScore: 70,
      scoreComponents: {},
      pnlConfidence: 80,
      source,
      computedAt: now
    }
  });
  return wallet.id;
}

async function makeTokenWithBuysFrom(walletIds: string[]): Promise<string> {
  const now = new Date();
  const token = await prisma.token.create({
    data: { chain: CHAIN, address: `${ADDR_PREFIX}_tok`, symbol: 'PTB', name: 'PTB token', decimals: 9, firstSeenAt: now, riskFlags: [] }
  });
  for (const [i, walletId] of walletIds.entries()) {
    await prisma.walletTokenTrade.create({
      data: {
        walletId,
        tokenId: token.id,
        chain: CHAIN,
        action: 'BUY',
        amountToken: 100,
        amountUsd: 1000,
        txHash: `${ADDR_PREFIX}_tx_${i}`,
        blockOrSlot: BigInt(i + 1),
        ts: new Date(now.getTime() - (30 - i) * 60_000),
        priceUsd: 10,
        marketCapAtTrade: 500_000,
        walletScoreAtTime: 50,
        provider: 'test'
      }
    });
  }
  return token.id;
}

describe.skipIf(!(await probePort('localhost', 5439)))('provider-claimed stats trust boundary', () => {
  it('UNWATCHED wallet with clearly-profitable PROVIDER stats gets meetsProfitable=false (provider claims alone confer nothing)', async () => {
    const walletId = await makeWalletWithStats('prov_unwatched', false, 'provider');
    const tokenId = await makeTokenWithBuysFrom([walletId]);

    const inputs = await fetchAggregateInputs(prisma, tokenId, DEFAULT_SETTINGS);
    const info = inputs.wallets.find((w) => w.walletId === walletId);

    expect(info).toBeDefined();
    expect(info!.isWatched).toBe(false);
    expect(info!.meetsProfitable).toBe(false);
  });

  it('WATCHED wallet with the same PROVIDER stats keeps meetsProfitable=true (promotion/operator vetting is the gate)', async () => {
    const walletId = await makeWalletWithStats('prov_watched', true, 'provider');
    const tokenId = await makeTokenWithBuysFrom([walletId]);

    const inputs = await fetchAggregateInputs(prisma, tokenId, DEFAULT_SETTINGS);
    const info = inputs.wallets.find((w) => w.walletId === walletId);

    expect(info!.meetsProfitable).toBe(true);
  });

  it('UNWATCHED wallet with COMPUTED (local FIFO) stats keeps meetsProfitable=true — locally-derived profitability is not a provider claim', async () => {
    const walletId = await makeWalletWithStats('comp_unwatched', false, 'computed');
    const tokenId = await makeTokenWithBuysFrom([walletId]);

    const inputs = await fetchAggregateInputs(prisma, tokenId, DEFAULT_SETTINGS);
    const info = inputs.wallets.find((w) => w.walletId === walletId);

    expect(info!.meetsProfitable).toBe(true);
  });

  it('UNWATCHED wallet with CSV stats keeps meetsProfitable=true — operator-vouched Layer-1 figures are trusted on their own', async () => {
    const walletId = await makeWalletWithStats('csv_unwatched', false, 'csv');
    const tokenId = await makeTokenWithBuysFrom([walletId]);

    const inputs = await fetchAggregateInputs(prisma, tokenId, DEFAULT_SETTINGS);
    const info = inputs.wallets.find((w) => w.walletId === walletId);

    expect(info!.meetsProfitable).toBe(true);
  });

  it('AGGREGATE TIE-IN: smartWalletCount excludes the unwatched provider-stats buyer but counts watched-provider and computed buyers', async () => {
    const provUnwatched = await makeWalletWithStats('agg_prov_unw', false, 'provider');
    const provWatched = await makeWalletWithStats('agg_prov_w', true, 'provider');
    const compUnwatched = await makeWalletWithStats('agg_comp_unw', false, 'computed');
    const tokenId = await makeTokenWithBuysFrom([provUnwatched, provWatched, compUnwatched]);

    const inputs = await fetchAggregateInputs(prisma, tokenId, DEFAULT_SETTINGS);
    const agg = aggregateWindow({
      trades: inputs.trades,
      wallets: inputs.wallets,
      clusters: inputs.clusters,
      market: inputs.market,
      windowMinutes: 1440,
      now: new Date()
    });

    // 3 buyers, but only 2 smart: the unwatched provider-claimed wallet is out.
    expect(agg.buyers).toHaveLength(3);
    expect(agg.smartWalletCount).toBe(2);
  });
});
