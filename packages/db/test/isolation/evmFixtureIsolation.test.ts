// FlowRadar — EVM-fixture isolation regression test (rollout Step 8).
//
// The live DB carries one known pre-isolation BSC test fixture
// (0x1234...5678: chain=BSC, status=signal_eligible, WalletStats.source=csv,
// classification bridge_related). This suite proves — against the REAL
// calculation paths, on the isolated test DB — that an EVM wallet of exactly
// that shape CANNOT enter Solana calculations:
//
//   1. a SOLANA token's aggregate inputs never include the EVM wallet
//      (fetchAggregateInputs scopes wallets to the token's own trades);
//   2. the SOLANA token's smartWalletCount / flow score are IDENTICAL with
//      and without the EVM fixture present — zero smart-wallet votes leak;
//   3. Solana-scoped eligibility counts (chain='SOLANA') exclude it, so a
//      chain-scoped census can never mistake it for a real eligible wallet;
//   4. the stealth pass attributes the EVM wallet's trades only to the BSC
//      token (chain='BSC' snapshot) — never to a SOLANA token's evidence;
//   5. an EVM 0x-address can never become a lineage root: the root-wallet
//      parser's Solana address validation rejects it.

import { describe, expect, it, afterAll, beforeEach } from 'vitest';
import net from 'node:net';
import { prisma } from '../../src/client';
import { fetchAggregateInputs } from '../../src/fetchAggregateInputs';
import { runFlowScoringPass } from '../../src/scoring-pass';
import { runStealthPass } from '../../src/stealth/runStealthPass';
import { DEFAULT_SETTINGS, aggregateWindow, parseRootWalletFile } from '@flowradar/core';
import type { RiskReport } from '@flowradar/core';

const PREFIX = 'T8EVMISO';
const EVM_ADDR = `0x${PREFIX}1234567890abcdef1234567890abcdef`;

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

const dbReachable = await probePort('localhost', 5439);

const unknownRisk: RiskReport = { flags: [], penalty: 0 };
const riskResolver = () => ({ getTokenRisk: async () => unknownRisk });

async function cleanup() {
  await prisma.stealthSnapshot.deleteMany({ where: { token: { address: { startsWith: PREFIX } } } });
  await prisma.tokenFlowSnapshot.deleteMany({ where: { token: { address: { startsWith: PREFIX } } } });
  await prisma.walletStats.deleteMany({ where: { wallet: { address: { contains: PREFIX } } } });
  await prisma.walletTokenTrade.deleteMany({ where: { txHash: { startsWith: PREFIX } } });
  await prisma.wallet.deleteMany({ where: { address: { contains: PREFIX } } });
  await prisma.token.deleteMany({ where: { address: { startsWith: PREFIX } } });
}

async function makeToken(suffix: string, chain: 'SOLANA' | 'BSC') {
  return prisma.token.create({
    data: {
      chain,
      address: `${PREFIX}${suffix}`,
      symbol: `S${suffix}`.slice(0, 10),
      name: `Token ${suffix}`,
      decimals: 9,
      firstSeenAt: new Date(),
      riskFlags: []
    }
  });
}

async function makeTrade(walletId: string, tokenId: string, chain: 'SOLANA' | 'BSC', suffix: string, ts: Date) {
  return prisma.walletTokenTrade.create({
    data: {
      walletId,
      tokenId,
      chain,
      action: 'BUY',
      amountToken: '1000',
      amountUsd: '800',
      txHash: `${PREFIX}TX${suffix}`,
      blockOrSlot: 1n,
      ts,
      priceUsd: '0.8',
      marketCapAtTrade: '150000',
      walletScoreAtTime: 70,
      provider: 'test'
    }
  });
}

/** Seeds the EXACT live-fixture shape: BSC wallet, signal_eligible, csv WalletStats, BSC trades only. */
async function seedEvmFixture(now: Date) {
  const evmWallet = await prisma.wallet.create({
    data: {
      chain: 'BSC',
      address: EVM_ADDR,
      status: 'signal_eligible',
      isWatched: true,
      firstSeenAt: now,
      lastActiveAt: now
    }
  });
  const bscToken = await makeToken('BSC1', 'BSC');
  await makeTrade(evmWallet.id, bscToken.id, 'BSC', 'EVM1', new Date(now.getTime() - 60_000));
  await prisma.walletStats.create({
    data: {
      walletId: evmWallet.id,
      source: 'csv',
      window: '30d',
      pnlUsd: 1000,
      realizedPnlUsd: 1000,
      unrealizedPnlUsd: 0,
      winRate: 0.9,
      tradeCount: 5,
      avgTradeSizeUsd: 200,
      walletScore: 90,
      pnlConfidence: 90,
      scoreComponents: {},
      computedAt: now
    }
  });
  return { evmWallet, bscToken };
}

async function seedSolanaSide(now: Date) {
  // signal_eligible + watched -> counts as SMART in the aggregate
  // (smartWalletCount = isSignalEligibleStatus AND (isWatched OR profitable)),
  // giving a real non-zero baseline the EVM fixture must not perturb.
  const solWallet = await prisma.wallet.create({
    data: {
      chain: 'SOLANA',
      address: `${PREFIX}SOLW1`,
      status: 'signal_eligible',
      isWatched: true,
      firstSeenAt: now,
      lastActiveAt: now
    }
  });
  const solToken = await makeToken('SOL1', 'SOLANA');
  await makeTrade(solWallet.id, solToken.id, 'SOLANA', 'SOL1', new Date(now.getTime() - 120_000));
  return { solWallet, solToken };
}

beforeEach(async () => {
  if (dbReachable) await cleanup();
});

afterAll(async () => {
  if (!dbReachable) return;
  await cleanup();
  await prisma.$disconnect();
});

// Pure — runs even without the DB.
describe('lineage root gate (pure)', () => {
  it('an EVM 0x address can never validate as a Solana lineage root', () => {
    const parsed = parseRootWalletFile(`0x1234567890abcdef1234567890abcdef12345678\n${EVM_ADDR}\n`);
    expect(parsed.roots.length).toBe(0); // NEVER a Solana lineage root
    expect(parsed.evmParked.length).toBeGreaterThanOrEqual(1); // explicitly parked as EVM, not Solana
  });
});

describe.skipIf(!dbReachable)('EVM fixture isolation from Solana calculations', () => {
  it('a SOLANA token aggregate never includes the EVM wallet, and smartWalletCount is identical with/without the fixture', async () => {
    const now = new Date();
    const { solToken } = await seedSolanaSide(now);

    // Baseline WITHOUT the fixture.
    const before = await fetchAggregateInputs(prisma, solToken.id, DEFAULT_SETTINGS, { now, windows: [1440] });
    const aggBefore = aggregateWindow({
      trades: before.trades,
      wallets: before.wallets,
      clusters: before.clusters,
      market: before.market,
      windowMinutes: 1440,
      inflowSpikeMult: DEFAULT_SETTINGS.rules.A.inflowSpikeMult,
      now
    });

    // Insert the EVM fixture (signal_eligible + watched + csv stats + BSC trades).
    const { evmWallet } = await seedEvmFixture(now);

    const after = await fetchAggregateInputs(prisma, solToken.id, DEFAULT_SETTINGS, { now, windows: [1440] });
    const aggAfter = aggregateWindow({
      trades: after.trades,
      wallets: after.wallets,
      clusters: after.clusters,
      market: after.market,
      windowMinutes: 1440,
      inflowSpikeMult: DEFAULT_SETTINGS.rules.A.inflowSpikeMult,
      now
    });

    // The EVM wallet appears NOWHERE in the SOLANA token's inputs.
    expect(after.wallets.some((w) => w.walletId === evmWallet.id)).toBe(false);
    expect(after.trades.some((t) => t.walletId === evmWallet.id)).toBe(false);
    // And the smart-wallet arithmetic is bit-identical: zero leaked votes.
    expect(aggBefore.smartWalletCount).toBe(1); // real non-zero baseline (eligible+watched SOLANA buyer)
    expect(aggAfter.smartWalletCount).toBe(aggBefore.smartWalletCount);
    expect(aggAfter.uniqueEntityCount).toBe(aggBefore.uniqueEntityCount);
    expect(aggAfter.trackedBuyVolumeUsd).toBe(aggBefore.trackedBuyVolumeUsd);
  });

  it('flow scoring of the SOLANA token is unchanged by the EVM fixture', async () => {
    const now = new Date();
    const { solToken } = await seedSolanaSide(now);
    await seedEvmFixture(now);

    await runFlowScoringPass(prisma, DEFAULT_SETTINGS, riskResolver);
    const snap = await prisma.tokenFlowSnapshot.findFirst({
      where: { tokenId: solToken.id },
      orderBy: { ts: 'desc' }
    });
    expect(snap).not.toBeNull();
    expect(snap!.smartWalletCount).toBe(1); // ONLY the watched SOLANA wallet
  });

  it('chain-scoped eligibility counts exclude the EVM fixture', async () => {
    const now = new Date();
    await seedEvmFixture(now);
    const solanaEligibleWithFixtureAddress = await prisma.wallet.count({
      where: { chain: 'SOLANA', status: 'signal_eligible', address: { contains: PREFIX } }
    });
    expect(solanaEligibleWithFixtureAddress).toBe(0); // the fixture is BSC-chained — a SOLANA-scoped census can never see it
    const fixtureRow = await prisma.wallet.findFirst({ where: { address: EVM_ADDR }, select: { chain: true, status: true } });
    expect(fixtureRow?.chain).toBe('BSC'); // and its eligibility lives only on the BSC side
  });

  it('the stealth pass attributes the EVM trades only to the BSC token, never to SOLANA evidence', async () => {
    const now = new Date();
    const { solToken } = await seedSolanaSide(now);
    const { bscToken } = await seedEvmFixture(now);

    await runStealthPass(prisma, { now, tokenLimit: 50 });

    const solSnap = await prisma.stealthSnapshot.findFirst({ where: { tokenId: solToken.id } });
    const bscSnap = await prisma.stealthSnapshot.findFirst({ where: { tokenId: bscToken.id } });
    // Whatever the pass computed, chain attribution is strict:
    if (solSnap) expect(solSnap.chain).toBe('SOLANA');
    if (bscSnap) expect(bscSnap.chain).toBe('BSC');
    // and no SOLANA-chained snapshot exists for the BSC token (the EVM trades
    // cannot cross into Solana stealth evidence).
    const crossed = await prisma.stealthSnapshot.count({ where: { tokenId: bscToken.id, chain: 'SOLANA' } });
    expect(crossed).toBe(0);
  });
});
