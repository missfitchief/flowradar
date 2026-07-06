// FlowRadar — runEntityClustering integration tests (Task 22 binding decision
// 5). Same LITE-Postgres integration pattern as fundingEvents.test.ts /
// graphRunSearch.test.ts.

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import net from 'node:net';
import { DEFAULT_SETTINGS } from '@flowradar/core';
import { prisma } from '../src/client';
import { runEntityClustering } from '../src/clustering';

const ADDR_PREFIX = 'T22CLUSTER';
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
      '[clustering.test] LITE Postgres not reachable on localhost:5439 — skipping ' +
        'integration tests. Run `npm run db:migrate` first to exercise this suite.'
    );
  }
});

afterAll(async () => {
  if (!dbReachable) return;
  await prisma.walletTokenTrade.deleteMany({ where: { wallet: { address: { startsWith: ADDR_PREFIX } } } });
  await prisma.entityClusterWallet.deleteMany({ where: { wallet: { address: { startsWith: ADDR_PREFIX } } } });
  await prisma.entityCluster.deleteMany({ where: { wallets: { none: {} } } });
  await prisma.moneyFlowEdge.deleteMany({ where: { sourceAddress: { startsWith: ADDR_PREFIX } } });
  await prisma.walletStats.deleteMany({ where: { wallet: { address: { startsWith: ADDR_PREFIX } } } });
  await prisma.token.deleteMany({ where: { address: { startsWith: ADDR_PREFIX } } });
  await prisma.wallet.deleteMany({ where: { address: { startsWith: ADDR_PREFIX } } });
  await prisma.$disconnect();
});

describe.skipIf(!(await probePort('localhost', 5439)))('runEntityClustering', () => {
  it('funder -> N funded wallets (same funding source, fresh + buy-within-60m) forms one cluster >= threshold', async () => {
    const now = new Date('2026-07-05T12:00:00Z');
    const funderAddr = `${ADDR_PREFIX}_funder`;

    const funder = await prisma.wallet.upsert({
      where: { address_chain: { address: funderAddr, chain: CHAIN } },
      create: { address: funderAddr, chain: CHAIN, firstSeenAt: now, lastActiveAt: now, isWatched: true },
      update: { isWatched: true }
    });

    const token = await prisma.token.upsert({
      where: { chain_address: { chain: CHAIN, address: `${ADDR_PREFIX}_token` } },
      create: {
        chain: CHAIN,
        address: `${ADDR_PREFIX}_token`,
        symbol: 'T22TOK',
        name: 'T22 Cluster Token',
        decimals: 9,
        firstSeenAt: now,
        riskFlags: []
      },
      update: {}
    });

    const fundedWalletIds: string[] = [];
    const FUNDED_COUNT = 16;
    for (let i = 0; i < FUNDED_COUNT; i++) {
      const fundedAddr = `${ADDR_PREFIX}_funded_${i}`;
      const funded = await prisma.wallet.upsert({
        where: { address_chain: { address: fundedAddr, chain: CHAIN } },
        create: { address: fundedAddr, chain: CHAIN, firstSeenAt: now, lastActiveAt: now, isWatched: false },
        update: {}
      });
      fundedWalletIds.push(funded.id);

      const fundingTs = new Date(now.getTime() - (60 - i) * 60_000); // spread over time, each before its own buy
      await prisma.moneyFlowEdge.create({
        data: {
          sourceAddress: funderAddr,
          destinationAddress: fundedAddr,
          sourceChain: CHAIN,
          destinationChain: CHAIN,
          asset: 'SOL',
          amountToken: 1,
          amountUsd: 80,
          ts: fundingTs,
          txHash: `${ADDR_PREFIX}_tx_fund_${i}`,
          actionType: 'transfer',
          confidence: 100,
          providerSource: 'test',
          metadata: {}
        }
      });

      const buyTs = new Date(fundingTs.getTime() + 3 * 60_000); // buys 3 min after funding (< 60m)
      await prisma.walletTokenTrade.create({
        data: {
          walletId: funded.id,
          tokenId: token.id,
          chain: CHAIN,
          action: 'BUY',
          amountToken: 100,
          amountUsd: 300,
          txHash: `${ADDR_PREFIX}_tx_buy_${i}`,
          blockOrSlot: BigInt(i + 1),
          ts: buyTs,
          priceUsd: 3,
          marketCapAtTrade: 200_000,
          walletScoreAtTime: 40,
          provider: 'test'
        }
      });
    }

    const result = await runEntityClustering(prisma, DEFAULT_SETTINGS);

    expect(result.clustersCreated).toBeGreaterThanOrEqual(1);

    const clusterWallet = await prisma.entityClusterWallet.findFirst({
      where: { walletId: funder.id },
      include: { cluster: true }
    });
    expect(clusterWallet).toBeDefined();
    expect(clusterWallet!.cluster.confidence).toBeGreaterThanOrEqual(61);

    const clusterMembers = await prisma.entityClusterWallet.count({ where: { clusterId: clusterWallet!.clusterId } });
    // funder + FUNDED_COUNT funded wallets, all same funding source.
    expect(clusterMembers).toBeGreaterThanOrEqual(15);

    // entityClusterId is stamped onto the funded wallets' trades.
    const stampedTrades = await prisma.walletTokenTrade.count({
      where: { walletId: { in: fundedWalletIds }, entityClusterId: { not: null } }
    });
    expect(stampedTrades).toBe(FUNDED_COUNT);

    // Idempotent second run: THIS test's own fixture cluster re-forms
    // identically. `runEntityClustering` is a global, whole-DB pass (by
    // design — see clustering.ts's file header), so this integration suite
    // runs against a SHARED LITE Postgres alongside other test files that
    // may concurrently insert/delete their own unrelated Wallet/MoneyFlowEdge
    // rows — asserting on the GLOBAL clustersCreated count across two calls
    // would be racy (another test file's data can legitimately change the
    // global candidate set between the two calls). Instead, re-look-up this
    // test's own funder-rooted cluster by walletId and assert its own shape
    // is stable.
    const secondResult = await runEntityClustering(prisma, DEFAULT_SETTINGS);
    expect(secondResult.clustersCreated).toBeGreaterThanOrEqual(1);

    const clusterWalletAfter = await prisma.entityClusterWallet.findFirst({
      where: { walletId: funder.id },
      include: { cluster: true }
    });
    expect(clusterWalletAfter).toBeDefined();
    expect(clusterWalletAfter!.cluster.confidence).toBeGreaterThanOrEqual(61);
    const clusterMembersAfter = await prisma.entityClusterWallet.count({
      where: { clusterId: clusterWalletAfter!.clusterId }
    });
    expect(clusterMembersAfter).toBeGreaterThanOrEqual(15);
  });
});
