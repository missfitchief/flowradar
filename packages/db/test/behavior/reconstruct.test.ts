// FlowRadar — behavior-reconstruction DB driver tests (directive Tasks 3-4).

import { describe, expect, it, afterAll, beforeEach } from 'vitest';
import net from 'node:net';
import { prisma } from '../../src/client';
import { reconstructWalletBehavior, runBehaviorReconstruction } from '../../src/behavior/reconstruct';

const PREFIX = 'T3BEH';

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
const NOW = new Date('2026-07-11T12:00:00Z');

async function cleanup() {
  await prisma.walletBehaviorProfile.deleteMany({ where: { walletAddress: { startsWith: PREFIX } } });
  await prisma.candidateWallet.deleteMany({ where: { walletAddress: { startsWith: PREFIX } } });
  await prisma.gmgnObservation.deleteMany({ where: { walletAddress: { startsWith: PREFIX } } });
  await prisma.observationProviderSnapshot.deleteMany({ where: { wallet: { address: { startsWith: PREFIX } } } });
  await prisma.walletTokenTrade.deleteMany({ where: { txHash: { startsWith: PREFIX } } });
  await prisma.wallet.deleteMany({ where: { address: { startsWith: PREFIX } } });
  await prisma.token.deleteMany({ where: { address: { startsWith: PREFIX } } });
}

beforeEach(async () => {
  if (dbReachable) await cleanup();
});

afterAll(async () => {
  if (!dbReachable) return;
  await cleanup();
  await prisma.$disconnect();
});

describe.skipIf(!dbReachable)('reconstructWalletBehavior', () => {
  it('merges local trades + provider claims into a persisted profile with separated provenance', async () => {
    const w = await prisma.wallet.create({
      data: { chain: 'SOLANA', address: `${PREFIX}W1`, status: 'observation_only', firstSeenAt: NOW, lastActiveAt: NOW }
    });
    const tok = await prisma.token.create({
      data: { chain: 'SOLANA', address: `${PREFIX}TOK1`, symbol: 'T3T', name: 'T3', decimals: 9, firstSeenAt: NOW, riskFlags: [] }
    });
    await prisma.walletTokenTrade.create({
      data: {
        walletId: w.id, tokenId: tok.id, chain: 'SOLANA', action: 'BUY', amountToken: '100', amountUsd: '500',
        txHash: `${PREFIX}TX1`, blockOrSlot: 1n, ts: new Date(NOW.getTime() - 7200_000), priceUsd: '5',
        marketCapAtTrade: '250000', walletScoreAtTime: 50, provider: 'test'
      }
    });
    await prisma.walletTokenTrade.create({
      data: {
        walletId: w.id, tokenId: tok.id, chain: 'SOLANA', action: 'SELL', amountToken: '100', amountUsd: '750',
        txHash: `${PREFIX}TX2`, blockOrSlot: 2n, ts: new Date(NOW.getTime() - 3600_000), priceUsd: '7.5',
        marketCapAtTrade: '400000', walletScoreAtTime: 50, provider: 'test'
      }
    });
    await prisma.observationProviderSnapshot.create({
      data: { walletId: w.id, source: 'gmgn:wallet stats', window: '30d', providerClaimed: true, pnlUsd: 12345, winRate: 0.8, tradeCount: 20, observedAt: NOW }
    });

    const { profile, classification } = await reconstructWalletBehavior(prisma, { chain: 'SOLANA', address: `${PREFIX}W1` }, { now: NOW });
    expect(profile.dataQuality).toBe('local_and_provider');
    expect(profile.local.tradeCount.value).toBe(2);
    expect(profile.local.tradeCount.provenance).toBe('locally_observed');
    expect(profile.provider.pnlUsd.value).toBe(12345);
    expect(profile.provider.pnlUsd.provenance).toBe('provider_claimed');
    expect(profile.local.tokenPositions[0].entryMcap).toBe(250000);
    expect(classification.grantsEligibility).toBe(false);

    const row = await prisma.walletBehaviorProfile.findUnique({
      where: { chain_walletAddress: { chain: 'SOLANA', walletAddress: `${PREFIX}W1` } }
    });
    expect(row).not.toBeNull();
    expect(row!.dataQuality).toBe('local_and_provider');
    expect((row!.profileJson as { provider: { pnlUsd: { provenance: string } } }).provider.pnlUsd.provenance).toBe('provider_claimed');
    expect((row!.classifierJson as { grantsEligibility: boolean }).grantsEligibility).toBe(false);
  });

  it('provider-only wallets (no local wallet row) reconstruct honestly', async () => {
    await prisma.gmgnObservation.create({
      data: {
        chain: 'SOLANA', sourceCommand: 'track smartmoney', walletAddress: `${PREFIX}GHOST`, side: 'buy',
        isKolTagged: false, isPromoterTagged: false, retrievedAt: NOW, dataQuality: 'complete',
        dedupeKey: `${PREFIX}GHOSTKEY1`
      }
    });
    const { profile } = await reconstructWalletBehavior(prisma, { chain: 'SOLANA', address: `${PREFIX}GHOST` }, { now: NOW });
    expect(profile.dataQuality).toBe('provider_only');
    expect(profile.local.tradeCount.provenance).toBe('unknown'); // nothing local fabricated
    expect(profile.provider.activityBuys.value).toBe(1);
    expect(profile.provider.activityBuys.provenance).toBe('provider_claimed');
  });

  it('runBehaviorReconstruction is bounded, resilient, and reports label/quality distributions', async () => {
    for (let i = 0; i < 4; i++) {
      await prisma.candidateWallet.create({
        data: {
          walletAddress: `${PREFIX}C${i}`, chain: 'SOLANA', source: 'gmgn:track smartmoney',
          firstSeenAt: NOW, lastSeenAt: new Date(NOW.getTime() + i * 1000)
        }
      });
    }
    const report = await runBehaviorReconstruction(prisma, { limit: 3, now: NOW });
    expect(report.candidatesConsidered).toBe(3); // bounded by limit
    expect(report.profilesWritten).toBe(3);
    expect(report.errors).toBe(0);
    expect(Object.values(report.byPrimaryLabel).reduce((a, b) => a + b, 0)).toBe(3);
    // no local data + no provider stats -> insufficient/provider_only shapes only, never fabricated
    const rows = await prisma.walletBehaviorProfile.findMany({ where: { walletAddress: { startsWith: `${PREFIX}C` } } });
    expect(rows.every((r) => ['insufficient', 'provider_only'].includes(r.dataQuality))).toBe(true);
  });
});
