// FlowRadar — scoring-pass snapshot dedup integration tests (sprint Task 0).

import { describe, expect, it, afterAll, beforeEach } from 'vitest';
import net from 'node:net';
import { prisma } from '../src/client';
import { runFlowScoringPass } from '../src/scoring-pass';
import { DEFAULT_SETTINGS } from '@flowradar/core';
import type { RiskReport } from '@flowradar/core';

const PREFIX = 'T0DEDUP';

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
const risk: RiskReport = { flags: [], penalty: 0 };
const resolver = () => ({ getTokenRisk: async () => risk });

async function cleanup() {
  await prisma.tokenFlowSnapshot.deleteMany({ where: { token: { address: { startsWith: PREFIX } } } });
  await prisma.walletTokenTrade.deleteMany({ where: { txHash: { startsWith: PREFIX } } });
  await prisma.wallet.deleteMany({ where: { address: { startsWith: PREFIX } } });
  await prisma.token.deleteMany({ where: { address: { startsWith: PREFIX } } });
}

async function seedTradedToken() {
  const token = await prisma.token.create({
    data: { chain: 'SOLANA', address: `${PREFIX}TOK`, symbol: 'T0D', name: 'T0', decimals: 9, firstSeenAt: new Date(), riskFlags: [] }
  });
  const wallet = await prisma.wallet.create({
    data: { chain: 'SOLANA', address: `${PREFIX}W1`, firstSeenAt: new Date(), lastActiveAt: new Date() }
  });
  await prisma.walletTokenTrade.create({
    data: {
      walletId: wallet.id, tokenId: token.id, chain: 'SOLANA', action: 'BUY', amountToken: '100', amountUsd: '500',
      txHash: `${PREFIX}TX1`, blockOrSlot: 1n, ts: new Date(Date.now() - 3600_000), priceUsd: '5',
      marketCapAtTrade: '100000', walletScoreAtTime: 50, provider: 'test'
    }
  });
  return { token, wallet };
}

beforeEach(async () => {
  if (dbReachable) await cleanup();
});

afterAll(async () => {
  if (!dbReachable) return;
  await cleanup();
  await prisma.$disconnect();
});

describe.skipIf(!dbReachable)('flow snapshot dedup (Task 0)', () => {
  it('back-to-back identical passes persist exactly ONE row, with honest metrics', async () => {
    const { token } = await seedTradedToken();

    const r1 = await runFlowScoringPass(prisma, DEFAULT_SETTINGS, resolver);
    const mine1 = await prisma.tokenFlowSnapshot.count({ where: { tokenId: token.id } });
    expect(mine1).toBe(1);
    expect(r1.snapshotPersistence.attempted).toBeGreaterThanOrEqual(1);

    const r2 = await runFlowScoringPass(prisma, DEFAULT_SETTINGS, resolver);
    const mine2 = await prisma.tokenFlowSnapshot.count({ where: { tokenId: token.id } });
    expect(mine2).toBe(1); // unchanged repeat suppressed
    expect(r2.snapshotPersistence.suppressedUnchanged).toBeGreaterThanOrEqual(1);
    expect(r2.scored).toBe(r1.scored); // scoring accounting unchanged by suppression
    // accounting adds up — nothing silently dropped
    expect(r2.snapshotPersistence.attempted).toBe(r2.snapshotPersistence.inserted + r2.snapshotPersistence.suppressedUnchanged);
  });

  it('a real change (new trade) persists a new row', async () => {
    const { token, wallet } = await seedTradedToken();
    await runFlowScoringPass(prisma, DEFAULT_SETTINGS, resolver);

    await prisma.walletTokenTrade.create({
      data: {
        walletId: wallet.id, tokenId: token.id, chain: 'SOLANA', action: 'BUY', amountToken: '50', amountUsd: '300',
        txHash: `${PREFIX}TX2`, blockOrSlot: 2n, ts: new Date(Date.now() - 60_000), priceUsd: '6',
        marketCapAtTrade: '120000', walletScoreAtTime: 50, provider: 'test'
      }
    });
    await runFlowScoringPass(prisma, DEFAULT_SETTINGS, resolver);
    expect(await prisma.tokenFlowSnapshot.count({ where: { tokenId: token.id } })).toBe(2);
  });

  it('scoring CARRIES the latest signalStatus forward — a hot token never oscillates or double-writes', async () => {
    const { token, wallet } = await seedTradedToken();
    await runFlowScoringPass(prisma, DEFAULT_SETTINGS, resolver);

    // signalDetection marks the token hot (status lifecycle owner)
    const latest = await prisma.tokenFlowSnapshot.findFirst({ where: { tokenId: token.id }, orderBy: [{ ts: 'desc' }, { id: 'desc' }] });
    await prisma.tokenFlowSnapshot.update({ where: { id: latest!.id }, data: { signalStatus: 'hot' } });

    // unchanged scoring pass: carried status makes the row identical -> suppressed,
    // and the hot status is NOT clobbered back to watching
    await runFlowScoringPass(prisma, DEFAULT_SETTINGS, resolver);
    let rows = await prisma.tokenFlowSnapshot.findMany({ where: { tokenId: token.id } });
    expect(rows.length).toBe(1);
    expect(rows[0].signalStatus).toBe('hot');

    // a REAL scalar change persists a new row that still carries 'hot'
    await prisma.walletTokenTrade.create({
      data: {
        walletId: wallet.id, tokenId: token.id, chain: 'SOLANA', action: 'BUY', amountToken: '10', amountUsd: '100',
        txHash: `${PREFIX}TX3`, blockOrSlot: 3n, ts: new Date(Date.now() - 30_000), priceUsd: '10',
        marketCapAtTrade: '150000', walletScoreAtTime: 50, provider: 'test'
      }
    });
    await runFlowScoringPass(prisma, DEFAULT_SETTINGS, resolver);
    rows = await prisma.tokenFlowSnapshot.findMany({ where: { tokenId: token.id }, orderBy: { ts: 'asc' } });
    expect(rows.length).toBe(2);
    expect(rows[1].signalStatus).toBe('hot'); // carried, not reset — no fabricated watching->hot transitions
  });
});
