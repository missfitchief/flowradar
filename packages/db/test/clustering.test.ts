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
  // Both sourceAddress AND destinationAddress must be checked: bridge/router
  // intermediary "addresses" (bridge program addrs, router program addrs)
  // are ADDR_PREFIX-scoped by construction in the evidence-path tests below,
  // but appear as the non-tracked-wallet side of an edge — a
  // sourceAddress-only filter would miss rows where the intermediary is the
  // destinationAddress.
  await prisma.moneyFlowEdge.deleteMany({
    where: { OR: [{ sourceAddress: { startsWith: ADDR_PREFIX } }, { destinationAddress: { startsWith: ADDR_PREFIX } }] }
  });
  await prisma.addressRegistry.deleteMany({ where: { address: { startsWith: ADDR_PREFIX } } });
  await prisma.walletStats.deleteMany({ where: { wallet: { address: { startsWith: ADDR_PREFIX } } } });
  await prisma.token.deleteMany({ where: { address: { startsWith: ADDR_PREFIX } } });
  await prisma.wallet.deleteMany({ where: { address: { startsWith: ADDR_PREFIX } } });
  await prisma.$disconnect();
});

async function upsertWallet(address: string, isWatched: boolean, now: Date) {
  return prisma.wallet.upsert({
    where: { address_chain: { address, chain: CHAIN } },
    create: { address, chain: CHAIN, firstSeenAt: now, lastActiveAt: now, isWatched },
    update: { isWatched }
  });
}

async function findPairEvidence(walletAId: string, walletBId: string): Promise<Record<string, unknown> | undefined> {
  const clusterWalletA = await prisma.entityClusterWallet.findFirst({
    where: { walletId: walletAId },
    include: { cluster: true }
  });
  if (!clusterWalletA) return undefined;
  const evidenceByPair = clusterWalletA.cluster.evidence as Record<string, Record<string, unknown>>;
  const keyAB = `${walletAId}:${walletBId}`;
  const keyBA = `${walletBId}:${walletAId}`;
  return evidenceByPair[keyAB] ?? evidenceByPair[keyBA];
}

describe.skipIf(!(await probePort('localhost', 5439)))('runEntityClustering', () => {
  it('funder -> N funded wallets (same funding source, fresh + buy-within-60m) forms one cluster >= threshold', async () => {
    const now = new Date('2026-07-05T12:00:00Z');
    const funderAddr = `${ADDR_PREFIX}_funder`;

    const funder = await prisma.wallet.upsert({
      where: { address_chain: { address: funderAddr, chain: CHAIN } },
      create: { address: funderAddr, chain: CHAIN, firstSeenAt: now, lastActiveAt: now, isWatched: true, status: 'signal_eligible' },
      update: { isWatched: true, status: 'signal_eligible' }
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

  it('per-member linkConfidence reflects EACH member\'s own max-confidence qualifying pair, not the cluster mean', async () => {
    // Funder F -> A and F -> B (single direct transfer each, both fresh +
    // buy-within-60m): pair F-A / F-B confidence = directTransfer(35) +
    // freshWalletActivated(15) + destBuysNewTokenWithin60m(15) = 65 each.
    // A and B ALSO share the same funding source (F) AND both exhibit
    // freshWalletActivated/destBuysNewTokenWithin60m (evaluated per-pair as
    // "either member" — see deriveCandidateLinks), so on top of their own
    // direct transfers (repeatedDirectTransfers), pair A-B's confidence =
    // directTransfer(35) + repeatedDirectTransfers(20) + sameFundingSource(25)
    // + freshWalletActivated(15) + destBuysNewTokenWithin60m(15) = 110,
    // clamped to 100 -- a DIFFERENT (higher) confidence than either F-A or
    // F-B. So: funder F's own max touching pair is 65 (its only pairs are
    // F-A/F-B), while A's and B's own max touching pair is 100 (via A-B,
    // which beats their own 65 F-* pair) -- three members, two distinct
    // per-member values, neither equal to the cluster's mean. This proves a
    // member's row must be ITS OWN max touching pair, not the cluster mean
    // and not whichever pair the derivation happens to encounter first.
    const now = new Date('2026-07-05T13:00:00Z');
    const funderAddr = `${ADDR_PREFIX}_pm_funder`;
    const funder = await prisma.wallet.upsert({
      where: { address_chain: { address: funderAddr, chain: CHAIN } },
      create: { address: funderAddr, chain: CHAIN, firstSeenAt: now, lastActiveAt: now, isWatched: true, status: 'signal_eligible' },
      update: { isWatched: true, status: 'signal_eligible' }
    });

    const token = await prisma.token.upsert({
      where: { chain_address: { chain: CHAIN, address: `${ADDR_PREFIX}_pm_token` } },
      create: {
        chain: CHAIN,
        address: `${ADDR_PREFIX}_pm_token`,
        symbol: 'T22PM',
        name: 'T22 Per-Member Token',
        decimals: 9,
        firstSeenAt: now,
        riskFlags: []
      },
      update: {}
    });

    async function makeFundedWallet(suffix: string, fundingTs: Date): Promise<{ id: string; address: string }> {
      const address = `${ADDR_PREFIX}_pm_${suffix}`;
      const wallet = await prisma.wallet.upsert({
        where: { address_chain: { address, chain: CHAIN } },
        create: { address, chain: CHAIN, firstSeenAt: now, lastActiveAt: now, isWatched: false },
        update: {}
      });
      await prisma.moneyFlowEdge.create({
        data: {
          sourceAddress: funderAddr,
          destinationAddress: address,
          sourceChain: CHAIN,
          destinationChain: CHAIN,
          asset: 'SOL',
          amountToken: 1,
          amountUsd: 80,
          ts: fundingTs,
          txHash: `${ADDR_PREFIX}_pm_tx_fund_${suffix}`,
          actionType: 'transfer',
          confidence: 100,
          providerSource: 'test',
          metadata: {}
        }
      });
      const buyTs = new Date(fundingTs.getTime() + 3 * 60_000);
      await prisma.walletTokenTrade.create({
        data: {
          walletId: wallet.id,
          tokenId: token.id,
          chain: CHAIN,
          action: 'BUY',
          amountToken: 100,
          amountUsd: 300,
          txHash: `${ADDR_PREFIX}_pm_tx_buy_${suffix}`,
          blockOrSlot: BigInt(1),
          ts: buyTs,
          priceUsd: 3,
          marketCapAtTrade: 200_000,
          walletScoreAtTime: 40,
          provider: 'test'
        }
      });
      return { id: wallet.id, address };
    }

    const a = await makeFundedWallet('a', new Date(now.getTime() - 90 * 60_000));
    const b = await makeFundedWallet('b', new Date(now.getTime() - 80 * 60_000));

    // A <-> B: two direct transfers (repeatedDirectTransfers) -- combined
    // with the sameFundingSource/freshWalletActivated/destBuysNewTokenWithin60m
    // evidence the pair also qualifies for (see comment above), this pair's
    // confidence (100, clamped) is HIGHER than either F-A or F-B (65).
    for (let i = 0; i < 2; i++) {
      await prisma.moneyFlowEdge.create({
        data: {
          sourceAddress: a.address,
          destinationAddress: b.address,
          sourceChain: CHAIN,
          destinationChain: CHAIN,
          asset: 'SOL',
          amountToken: 1,
          amountUsd: 50,
          ts: new Date(now.getTime() - (50 - i) * 60_000),
          txHash: `${ADDR_PREFIX}_pm_tx_ab_${i}`,
          actionType: 'transfer',
          confidence: 100,
          providerSource: 'test',
          metadata: {}
        }
      });
    }

    await runEntityClustering(prisma, DEFAULT_SETTINGS);

    const funderRow = await prisma.entityClusterWallet.findFirst({ where: { walletId: funder.id } });
    const aRow = await prisma.entityClusterWallet.findFirst({ where: { walletId: a.id } });
    const bRow = await prisma.entityClusterWallet.findFirst({ where: { walletId: b.id } });

    expect(funderRow).toBeDefined();
    expect(aRow).toBeDefined();
    expect(bRow).toBeDefined();

    // Funder's own max touching pair is 65 (F-A/F-B); A's and B's own max
    // touching pair is 100 (via the stronger A-B pair) -- if the bug were
    // present (falling back to the cluster's own mean confidence for every
    // member), all three rows would instead show the SAME cluster-mean
    // value, which is neither 65 nor 100 (three members averaging
    // 65+100+100 -> mean ~88.3).
    expect(funderRow!.linkConfidence).toBeCloseTo(65, 5);
    expect(aRow!.linkConfidence).toBeCloseTo(100, 5);
    expect(bRow!.linkConfidence).toBeCloseTo(100, 5);
  });

  it('bridgeAmountTimeMatch: bridge_deposit(A) + bridge_withdrawal(B) within 10% amount / 2h -> evidence.bridgeAmountTimeMatch = true', async () => {
    const now = new Date();
    const a = await upsertWallet(`${ADDR_PREFIX}_bridge_a`, true, now);
    const b = await upsertWallet(`${ADDR_PREFIX}_bridge_b`, false, now);

    const depositTs = new Date(now.getTime() - 60 * 60_000);
    await prisma.moneyFlowEdge.create({
      data: {
        sourceAddress: a.address,
        destinationAddress: `${ADDR_PREFIX}_bridge_program`,
        sourceChain: CHAIN,
        destinationChain: CHAIN,
        asset: 'USDC',
        amountToken: 1000,
        amountUsd: 1000,
        ts: depositTs,
        txHash: `${ADDR_PREFIX}_tx_dep`,
        actionType: 'bridge_deposit',
        bridgeProtocol: 'Wormhole',
        confidence: 100,
        providerSource: 'test',
        metadata: {}
      }
    });
    const withdrawTs = new Date(depositTs.getTime() + 20 * 60_000); // <2h
    await prisma.moneyFlowEdge.create({
      data: {
        sourceAddress: `${ADDR_PREFIX}_bridge_program`,
        destinationAddress: b.address,
        sourceChain: CHAIN,
        destinationChain: CHAIN,
        asset: 'USDC',
        amountToken: 970, // within 10% of 1000
        amountUsd: 970,
        ts: withdrawTs,
        txHash: `${ADDR_PREFIX}_tx_wd`,
        actionType: 'bridge_withdrawal',
        bridgeProtocol: 'Wormhole',
        confidence: 100,
        providerSource: 'test',
        metadata: {}
      }
    });
    // Also a direct transfer between A and B so combined confidence
    // (bridgeAmountTimeMatch 30 + amountSimilarityAbove90 15 + directTransfer
    // 35 = 80) clears the 61 threshold and the pair actually clusters.
    await prisma.moneyFlowEdge.create({
      data: {
        sourceAddress: a.address,
        destinationAddress: b.address,
        sourceChain: CHAIN,
        destinationChain: CHAIN,
        asset: 'SOL',
        amountToken: 5,
        amountUsd: 500,
        ts: new Date(now.getTime() - 90 * 60_000),
        txHash: `${ADDR_PREFIX}_tx_direct`,
        actionType: 'transfer',
        confidence: 100,
        providerSource: 'test',
        metadata: {}
      }
    });

    await runEntityClustering(prisma, DEFAULT_SETTINGS);

    const evidence = await findPairEvidence(a.id, b.id);
    expect(evidence).toBeDefined();
    expect(evidence!.bridgeAmountTimeMatch).toBe(true);
  });

  it('cexOrMixerInterruption: both wallets touch a registry-tagged CEX address -> evidence.cexOrMixerInterruption = true', async () => {
    const now = new Date();
    const a = await upsertWallet(`${ADDR_PREFIX}_cex_a`, true, now);
    const b = await upsertWallet(`${ADDR_PREFIX}_cex_b`, false, now);
    const cexAddress = `${ADDR_PREFIX}_cex_hotwallet`;

    await prisma.addressRegistry.upsert({
      where: { chain_address: { chain: CHAIN, address: cexAddress } },
      create: { chain: CHAIN, address: cexAddress, category: 'CEX', label: 'test CEX', source: 'test' },
      update: {}
    });

    // A -> CEX, CEX -> B (interruption path), PLUS a direct transfer so the
    // pair's combined confidence (directTransfer 35 + repeatedDirectTransfers
    // 20 + cexOrMixerInterruption -30 = 25... not enough) needs more: add
    // sameFundingSource too by giving both A and B their earliest incoming
    // transfer from the same funder address.
    await prisma.moneyFlowEdge.create({
      data: {
        sourceAddress: a.address,
        destinationAddress: cexAddress,
        sourceChain: CHAIN,
        destinationChain: CHAIN,
        asset: 'SOL',
        amountToken: 10,
        amountUsd: 1000,
        ts: new Date(now.getTime() - 60 * 60_000),
        txHash: `${ADDR_PREFIX}_tx_a_to_cex`,
        actionType: 'cex_deposit',
        confidence: 100,
        providerSource: 'test',
        metadata: {}
      }
    });
    await prisma.moneyFlowEdge.create({
      data: {
        sourceAddress: cexAddress,
        destinationAddress: b.address,
        sourceChain: CHAIN,
        destinationChain: CHAIN,
        asset: 'SOL',
        amountToken: 10,
        amountUsd: 1000,
        ts: new Date(now.getTime() - 50 * 60_000),
        txHash: `${ADDR_PREFIX}_tx_cex_to_b`,
        actionType: 'cex_withdrawal',
        confidence: 100,
        providerSource: 'test',
        metadata: {}
      }
    });

    // Direct transfers A<->B (x2, so repeatedDirectTransfers also true):
    // directTransfer 35 + repeatedDirectTransfers 20 + amountSimilarityAbove90
    // 15 + cexOrMixerInterruption -30 = 40 — still short of 61. Add
    // sameFundingSource (25) by funding both from a shared funder wallet that
    // is ALSO a tracked wallet (so it counts toward the pair via the funder
    // relationship path) — simplest: fund B from A directly (so A IS the
    // "same funding source" as far as B's earliest incoming transfer is
    // concerned) is already covered by the direct transfers below; instead
    // give both A and B an even earlier incoming transfer from a third
    // funder wallet.
    const funder = await upsertWallet(`${ADDR_PREFIX}_cex_funder`, true, now);
    const fundTs = new Date(now.getTime() - 120 * 60_000);
    await prisma.moneyFlowEdge.create({
      data: {
        sourceAddress: funder.address,
        destinationAddress: a.address,
        sourceChain: CHAIN,
        destinationChain: CHAIN,
        asset: 'SOL',
        amountToken: 1,
        amountUsd: 100,
        ts: fundTs,
        txHash: `${ADDR_PREFIX}_tx_fund_a`,
        actionType: 'transfer',
        confidence: 100,
        providerSource: 'test',
        metadata: {}
      }
    });
    await prisma.moneyFlowEdge.create({
      data: {
        sourceAddress: funder.address,
        destinationAddress: b.address,
        sourceChain: CHAIN,
        destinationChain: CHAIN,
        asset: 'SOL',
        amountToken: 1,
        amountUsd: 100,
        ts: fundTs,
        txHash: `${ADDR_PREFIX}_tx_fund_b`,
        actionType: 'transfer',
        confidence: 100,
        providerSource: 'test',
        metadata: {}
      }
    });
    // Direct transfers A -> B x2 (directTransfer + repeatedDirectTransfers).
    await prisma.moneyFlowEdge.create({
      data: {
        sourceAddress: a.address,
        destinationAddress: b.address,
        sourceChain: CHAIN,
        destinationChain: CHAIN,
        asset: 'SOL',
        amountToken: 5,
        amountUsd: 500,
        ts: new Date(now.getTime() - 40 * 60_000),
        txHash: `${ADDR_PREFIX}_tx_direct_1`,
        actionType: 'transfer',
        confidence: 100,
        providerSource: 'test',
        metadata: {}
      }
    });
    await prisma.moneyFlowEdge.create({
      data: {
        sourceAddress: a.address,
        destinationAddress: b.address,
        sourceChain: CHAIN,
        destinationChain: CHAIN,
        asset: 'SOL',
        amountToken: 5,
        amountUsd: 510,
        ts: new Date(now.getTime() - 30 * 60_000),
        txHash: `${ADDR_PREFIX}_tx_direct_2`,
        actionType: 'transfer',
        confidence: 100,
        providerSource: 'test',
        metadata: {}
      }
    });

    await runEntityClustering(prisma, DEFAULT_SETTINGS);

    const evidence = await findPairEvidence(a.id, b.id);
    expect(evidence).toBeDefined();
    expect(evidence!.cexOrMixerInterruption).toBe(true);
  });

  it('routerOnlyInteraction: only interaction between the pair is via an AddressRegistry ROUTER -> evidence.routerOnlyInteraction = true (no direct transfer)', async () => {
    const now = new Date();
    const a = await upsertWallet(`${ADDR_PREFIX}_router_a`, true, now);
    const b = await upsertWallet(`${ADDR_PREFIX}_router_b`, false, now);
    const routerAddress = `${ADDR_PREFIX}_router_program`;

    await prisma.addressRegistry.upsert({
      where: { chain_address: { chain: CHAIN, address: routerAddress } },
      create: { chain: CHAIN, address: routerAddress, category: 'ROUTER', label: 'test router', source: 'test' },
      update: {}
    });

    // A -> router, router -> B — NO direct (actionType='transfer') A<->B
    // edge at all, so routerOnlyInteraction's own directTransferCount===0
    // guard stays satisfied.
    await prisma.moneyFlowEdge.create({
      data: {
        sourceAddress: a.address,
        destinationAddress: routerAddress,
        sourceChain: CHAIN,
        destinationChain: CHAIN,
        asset: 'SOL',
        amountToken: 10,
        amountUsd: 1000,
        ts: new Date(now.getTime() - 60 * 60_000),
        txHash: `${ADDR_PREFIX}_tx_a_to_router`,
        actionType: 'contract_interaction',
        confidence: 100,
        providerSource: 'test',
        metadata: {}
      }
    });
    await prisma.moneyFlowEdge.create({
      data: {
        sourceAddress: routerAddress,
        destinationAddress: b.address,
        sourceChain: CHAIN,
        destinationChain: CHAIN,
        asset: 'SOL',
        amountToken: 10,
        amountUsd: 1000,
        ts: new Date(now.getTime() - 55 * 60_000),
        txHash: `${ADDR_PREFIX}_tx_router_to_b`,
        actionType: 'contract_interaction',
        confidence: 100,
        providerSource: 'test',
        metadata: {}
      }
    });

    // Push the a<->b pair itself over threshold WITHOUT ever adding a direct
    // (actionType='transfer') edge between them: a bridge_deposit(a) +
    // bridge_withdrawal(b) pair scores bridgeAmountTimeMatch(30) +
    // amountSimilarityAbove90(15, via the bridge-match ratio path) on TOP of
    // routerOnlyInteraction(-20) = 25, still short — add sameFundingSource
    // (25) via a shared funder for the final push: 25+30+15-20 = 50... one
    // more: freshWalletActivated(15) from the funded side brings it to 65.
    const depositTs = new Date(now.getTime() - 50 * 60_000);
    await prisma.moneyFlowEdge.create({
      data: {
        sourceAddress: a.address,
        destinationAddress: `${ADDR_PREFIX}_router_bridge_program`,
        sourceChain: CHAIN,
        destinationChain: CHAIN,
        asset: 'USDC',
        amountToken: 1000,
        amountUsd: 1000,
        ts: depositTs,
        txHash: `${ADDR_PREFIX}_tx_router_bridge_dep`,
        actionType: 'bridge_deposit',
        bridgeProtocol: 'TestBridge',
        confidence: 100,
        providerSource: 'test',
        metadata: {}
      }
    });
    await prisma.moneyFlowEdge.create({
      data: {
        sourceAddress: `${ADDR_PREFIX}_router_bridge_program`,
        destinationAddress: b.address,
        sourceChain: CHAIN,
        destinationChain: CHAIN,
        asset: 'USDC',
        amountToken: 970,
        amountUsd: 970,
        ts: new Date(depositTs.getTime() + 20 * 60_000),
        txHash: `${ADDR_PREFIX}_tx_router_bridge_wd`,
        actionType: 'bridge_withdrawal',
        bridgeProtocol: 'TestBridge',
        confidence: 100,
        providerSource: 'test',
        metadata: {}
      }
    });

    const funder = await upsertWallet(`${ADDR_PREFIX}_router_funder`, true, now);
    const fundTs = new Date(now.getTime() - 90 * 60_000);
    await prisma.moneyFlowEdge.create({
      data: {
        sourceAddress: funder.address,
        destinationAddress: a.address,
        sourceChain: CHAIN,
        destinationChain: CHAIN,
        asset: 'SOL',
        amountToken: 1,
        amountUsd: 100,
        ts: fundTs,
        txHash: `${ADDR_PREFIX}_tx_fund_router_a`,
        actionType: 'transfer',
        confidence: 100,
        providerSource: 'test',
        metadata: {}
      }
    });
    await prisma.moneyFlowEdge.create({
      data: {
        sourceAddress: funder.address,
        destinationAddress: b.address,
        sourceChain: CHAIN,
        destinationChain: CHAIN,
        asset: 'SOL',
        amountToken: 1,
        amountUsd: 100,
        ts: fundTs,
        txHash: `${ADDR_PREFIX}_tx_fund_router_b`,
        actionType: 'transfer',
        confidence: 100,
        providerSource: 'test',
        metadata: {}
      }
    });

    await runEntityClustering(prisma, DEFAULT_SETTINGS);

    // sameFundingSource(25) + bridgeAmountTimeMatch(30) +
    // amountSimilarityAbove90(15) + freshWalletActivated(15) -
    // routerOnlyInteraction(20) = 65 >= 61 — the a<->b pair itself now
    // qualifies and its evidence entry is directly inspectable.
    const evidence = await findPairEvidence(a.id, b.id);
    expect(evidence).toBeDefined();
    expect(evidence!.routerOnlyInteraction).toBe(true);
  });

  it('dustOnlyInteraction: every direct transfer between the pair is < $10 -> evidence.dustOnlyInteraction = true', async () => {
    const now = new Date();
    const a = await upsertWallet(`${ADDR_PREFIX}_dust_a`, true, now);
    const b = await upsertWallet(`${ADDR_PREFIX}_dust_b`, false, now);

    // Two dust-sized direct transfers (repeatedDirectTransfers 20 +
    // directTransfer 35 - dustOnlyInteraction 25 = 30 -- still short of 61,
    // add sameFundingSource via a shared funder too).
    await prisma.moneyFlowEdge.create({
      data: {
        sourceAddress: a.address,
        destinationAddress: b.address,
        sourceChain: CHAIN,
        destinationChain: CHAIN,
        asset: 'SOL',
        amountToken: 0.01,
        amountUsd: 2,
        ts: new Date(now.getTime() - 40 * 60_000),
        txHash: `${ADDR_PREFIX}_tx_dust_1`,
        actionType: 'transfer',
        confidence: 100,
        providerSource: 'test',
        metadata: {}
      }
    });
    await prisma.moneyFlowEdge.create({
      data: {
        sourceAddress: a.address,
        destinationAddress: b.address,
        sourceChain: CHAIN,
        destinationChain: CHAIN,
        asset: 'SOL',
        amountToken: 0.02,
        amountUsd: 5,
        ts: new Date(now.getTime() - 30 * 60_000),
        txHash: `${ADDR_PREFIX}_tx_dust_2`,
        actionType: 'transfer',
        confidence: 100,
        providerSource: 'test',
        metadata: {}
      }
    });

    const funder = await upsertWallet(`${ADDR_PREFIX}_dust_funder`, true, now);
    const fundTs = new Date(now.getTime() - 90 * 60_000);
    await prisma.moneyFlowEdge.create({
      data: {
        sourceAddress: funder.address,
        destinationAddress: a.address,
        sourceChain: CHAIN,
        destinationChain: CHAIN,
        asset: 'SOL',
        amountToken: 1,
        amountUsd: 100,
        ts: fundTs,
        txHash: `${ADDR_PREFIX}_tx_fund_dust_a`,
        actionType: 'transfer',
        confidence: 100,
        providerSource: 'test',
        metadata: {}
      }
    });
    await prisma.moneyFlowEdge.create({
      data: {
        sourceAddress: funder.address,
        destinationAddress: b.address,
        sourceChain: CHAIN,
        destinationChain: CHAIN,
        asset: 'SOL',
        amountToken: 1,
        amountUsd: 100,
        ts: fundTs,
        txHash: `${ADDR_PREFIX}_tx_fund_dust_b`,
        actionType: 'transfer',
        confidence: 100,
        providerSource: 'test',
        metadata: {}
      }
    });

    await runEntityClustering(prisma, DEFAULT_SETTINGS);

    // funder<->a and funder<->b each qualify on directTransfer(35) +
    // sameFundingSource(25) = 60... still short of 61. Add a fresh BUY so
    // freshWalletActivated/destBuysNewTokenWithin60m push funder<->a and
    // funder<->b over threshold, forming the (funder, a, b) cluster whose
    // evidence includes the dust-only a<->b pair.
    const token = await prisma.token.upsert({
      where: { chain_address: { chain: CHAIN, address: `${ADDR_PREFIX}_dust_token` } },
      create: {
        chain: CHAIN,
        address: `${ADDR_PREFIX}_dust_token`,
        symbol: 'T23DT',
        name: 'T23 Dust Token',
        decimals: 9,
        firstSeenAt: fundTs,
        riskFlags: []
      },
      update: {}
    });
    const buyTs = new Date(fundTs.getTime() + 5 * 60_000);
    for (const wallet of [a, b]) {
      await prisma.walletTokenTrade.create({
        data: {
          walletId: wallet.id,
          tokenId: token.id,
          chain: CHAIN,
          action: 'BUY',
          amountToken: 100,
          amountUsd: 300,
          txHash: `${ADDR_PREFIX}_tx_dust_buy_${wallet.id}`,
          blockOrSlot: BigInt(1),
          ts: buyTs,
          priceUsd: 3,
          marketCapAtTrade: 200_000,
          walletScoreAtTime: 40,
          provider: 'test'
        }
      });
    }

    await runEntityClustering(prisma, DEFAULT_SETTINGS);

    const clusterWalletA = await prisma.entityClusterWallet.findFirst({
      where: { walletId: a.id },
      include: { cluster: true }
    });
    expect(clusterWalletA).toBeDefined();
    const evidenceByPair = clusterWalletA!.cluster.evidence as Record<string, Record<string, unknown>>;
    const abEvidence = evidenceByPair[`${a.id}:${b.id}`] ?? evidenceByPair[`${b.id}:${a.id}`];
    expect(abEvidence).toBeDefined();
    expect(abEvidence!.dustOnlyInteraction).toBe(true);
  });

  it('amountSimilarityAbove90 / weakAmountMatch: two direct transfer amounts drive the ratio-based flags', async () => {
    const now = new Date();

    // Strong-match pair: $1000 and $960 (ratio 0.96 >= 0.9) -> amountSimilarityAbove90.
    const strongA = await upsertWallet(`${ADDR_PREFIX}_amt_strong_a`, true, now);
    const strongB = await upsertWallet(`${ADDR_PREFIX}_amt_strong_b`, false, now);
    await prisma.moneyFlowEdge.create({
      data: {
        sourceAddress: strongA.address,
        destinationAddress: strongB.address,
        sourceChain: CHAIN,
        destinationChain: CHAIN,
        asset: 'SOL',
        amountToken: 10,
        amountUsd: 1000,
        ts: new Date(now.getTime() - 40 * 60_000),
        txHash: `${ADDR_PREFIX}_tx_amt_strong_1`,
        actionType: 'transfer',
        confidence: 100,
        providerSource: 'test',
        metadata: {}
      }
    });
    await prisma.moneyFlowEdge.create({
      data: {
        sourceAddress: strongA.address,
        destinationAddress: strongB.address,
        sourceChain: CHAIN,
        destinationChain: CHAIN,
        asset: 'SOL',
        amountToken: 9.6,
        amountUsd: 960,
        ts: new Date(now.getTime() - 30 * 60_000),
        txHash: `${ADDR_PREFIX}_tx_amt_strong_2`,
        actionType: 'transfer',
        confidence: 100,
        providerSource: 'test',
        metadata: {}
      }
    });
    // directTransfer(35) + repeatedDirectTransfers(20) + amountSimilarityAbove90(15) = 70 >= 61.

    // Weak-match pair: $1000 and $400 (ratio 0.4 < 0.9) -> weakAmountMatch.
    // Needs extra positive evidence to clear 61 (directTransfer 35 +
    // repeatedDirectTransfers 20 - weakAmountMatch 15 = 40): add a shared
    // funder to push sameFundingSource(25) on top -> 65.
    const weakA = await upsertWallet(`${ADDR_PREFIX}_amt_weak_a`, true, now);
    const weakB = await upsertWallet(`${ADDR_PREFIX}_amt_weak_b`, false, now);
    await prisma.moneyFlowEdge.create({
      data: {
        sourceAddress: weakA.address,
        destinationAddress: weakB.address,
        sourceChain: CHAIN,
        destinationChain: CHAIN,
        asset: 'SOL',
        amountToken: 10,
        amountUsd: 1000,
        ts: new Date(now.getTime() - 40 * 60_000),
        txHash: `${ADDR_PREFIX}_tx_amt_weak_1`,
        actionType: 'transfer',
        confidence: 100,
        providerSource: 'test',
        metadata: {}
      }
    });
    await prisma.moneyFlowEdge.create({
      data: {
        sourceAddress: weakA.address,
        destinationAddress: weakB.address,
        sourceChain: CHAIN,
        destinationChain: CHAIN,
        asset: 'SOL',
        amountToken: 4,
        amountUsd: 400,
        ts: new Date(now.getTime() - 30 * 60_000),
        txHash: `${ADDR_PREFIX}_tx_amt_weak_2`,
        actionType: 'transfer',
        confidence: 100,
        providerSource: 'test',
        metadata: {}
      }
    });
    const weakFunder = await upsertWallet(`${ADDR_PREFIX}_amt_weak_funder`, true, now);
    const weakFundTs = new Date(now.getTime() - 90 * 60_000);
    await prisma.moneyFlowEdge.create({
      data: {
        sourceAddress: weakFunder.address,
        destinationAddress: weakA.address,
        sourceChain: CHAIN,
        destinationChain: CHAIN,
        asset: 'SOL',
        amountToken: 1,
        amountUsd: 100,
        ts: weakFundTs,
        txHash: `${ADDR_PREFIX}_tx_amt_weak_fund_a`,
        actionType: 'transfer',
        confidence: 100,
        providerSource: 'test',
        metadata: {}
      }
    });
    await prisma.moneyFlowEdge.create({
      data: {
        sourceAddress: weakFunder.address,
        destinationAddress: weakB.address,
        sourceChain: CHAIN,
        destinationChain: CHAIN,
        asset: 'SOL',
        amountToken: 1,
        amountUsd: 100,
        ts: weakFundTs,
        txHash: `${ADDR_PREFIX}_tx_amt_weak_fund_b`,
        actionType: 'transfer',
        confidence: 100,
        providerSource: 'test',
        metadata: {}
      }
    });

    await runEntityClustering(prisma, DEFAULT_SETTINGS);

    const strongEvidence = await findPairEvidence(strongA.id, strongB.id);
    expect(strongEvidence).toBeDefined();
    expect(strongEvidence!.amountSimilarityAbove90).toBe(true);
    expect(strongEvidence!.weakAmountMatch).toBe(false);

    const weakEvidence = await findPairEvidence(weakA.id, weakB.id);
    expect(weakEvidence).toBeDefined();
    expect(weakEvidence!.weakAmountMatch).toBe(true);
    expect(weakEvidence!.amountSimilarityAbove90).toBe(false);
  });
});
