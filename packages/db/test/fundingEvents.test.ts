// FlowRadar — buildFundingEvents integration tests (Task 15 binding decision 5).
//
// Integration test against the real LITE-mode Postgres (embedded-postgres,
// port 5439), same prefix-cleanup pattern as packages/db/test/ingest.test.ts
// (T5TEST-style prefix, address-scoped afterAll cleanup, describe.skipIf when
// the LITE cluster isn't reachable).

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import net from 'node:net';
import { DEFAULT_SETTINGS } from '@flowradar/core';
import { prisma } from '../src/client';
import { buildFundingEvents } from '../src/fundingEvents';

const ADDR_PREFIX = 'T15FUND';
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
      '[fundingEvents.test] LITE Postgres not reachable on localhost:5439 — skipping ' +
        'integration tests. Run `npm run db:migrate` first to exercise this suite.'
    );
  }
});

afterAll(async () => {
  if (!dbReachable) return;
  await prisma.moneyFlowEdge.deleteMany({ where: { sourceAddress: { startsWith: ADDR_PREFIX } } });
  await prisma.walletTokenTrade.deleteMany({ where: { wallet: { address: { startsWith: ADDR_PREFIX } } } });
  await prisma.walletStats.deleteMany({ where: { wallet: { address: { startsWith: ADDR_PREFIX } } } });
  await prisma.wallet.deleteMany({ where: { address: { startsWith: ADDR_PREFIX } } });
  await prisma.token.deleteMany({ where: { address: { startsWith: ADDR_PREFIX } } });
  await prisma.$disconnect();
});

describe.skipIf(!(await probePort('localhost', 5439)))('buildFundingEvents', () => {
  it('happy path: watched funder -> fresh funded wallet -> buys THIS token -> produces a matching FundingEvent', async () => {
    const funderAddr = `${ADDR_PREFIX}_funder_happy`;
    const fundedAddr = `${ADDR_PREFIX}_funded_happy_fresh`;
    const tokenAddr = `${ADDR_PREFIX}_token_happy`;
    const now = new Date('2026-07-05T12:00:00Z');

    const funder = await prisma.wallet.upsert({
      where: { address_chain: { address: funderAddr, chain: CHAIN } },
      create: { address: funderAddr, chain: CHAIN, firstSeenAt: now, lastActiveAt: now, isWatched: true, status: 'signal_eligible' },
      update: { isWatched: true, status: 'signal_eligible' }
    });
    const funded = await prisma.wallet.upsert({
      where: { address_chain: { address: fundedAddr, chain: CHAIN } },
      create: { address: fundedAddr, chain: CHAIN, firstSeenAt: now, lastActiveAt: now, isWatched: false },
      update: {}
    });
    const token = await prisma.token.upsert({
      where: { chain_address: { chain: CHAIN, address: tokenAddr } },
      create: {
        chain: CHAIN,
        address: tokenAddr,
        symbol: 'T15F',
        name: 'T15 Funding Token',
        decimals: 9,
        firstSeenAt: now,
        riskFlags: []
      },
      update: {}
    });

    const transferTs = new Date(now.getTime() - 30 * 60_000); // 30min before now
    await prisma.moneyFlowEdge.create({
      data: {
        sourceAddress: funderAddr,
        destinationAddress: fundedAddr,
        sourceChain: CHAIN,
        destinationChain: CHAIN,
        asset: 'SOL',
        amountToken: 5,
        amountUsd: 1000,
        ts: transferTs,
        txHash: `${ADDR_PREFIX}_tx_transfer_happy`,
        actionType: 'transfer',
        confidence: 100,
        providerSource: 'test',
        metadata: {}
      }
    });

    // Funded wallet's FIRST-EVER trade is this BUY, occurring AFTER the transfer (fresh).
    const buyTs = new Date(transferTs.getTime() + 20 * 60_000); // 20min after transfer
    await prisma.walletTokenTrade.create({
      data: {
        walletId: funded.id,
        tokenId: token.id,
        chain: CHAIN,
        action: 'BUY',
        amountToken: 1000,
        amountUsd: 600, // 60% of the $1000 funding
        txHash: `${ADDR_PREFIX}_tx_buy_happy`,
        blockOrSlot: 1n,
        ts: buyTs,
        priceUsd: 0.6,
        marketCapAtTrade: 200_000,
        walletScoreAtTime: 30,
        provider: 'test'
      }
    });

    const windowFrom = new Date(now.getTime() - 2 * 60 * 60_000); // 2h lookback
    const events = await buildFundingEvents(prisma, token.id, windowFrom, now, DEFAULT_SETTINGS);

    const match = events.find((e) => e.funderWalletId === funder.id && e.fundedWalletId === funded.id);
    expect(match).toBeDefined();
    expect(match!.fundedAddressFresh).toBe(true);
    expect(match!.amountUsd).toBeCloseTo(1000, 4);
    expect(match!.fundedFirstBuy).toBeDefined();
    expect(match!.fundedFirstBuy!.tokenId).toBe(token.id);
    expect(match!.fundedFirstBuy!.usd).toBeCloseTo(600, 4);
    expect(match!.fundedFirstBuy!.mcapAtBuy).toBeCloseTo(200_000, 4);
  });

  it('not-fresh case: funded wallet already had a trade BEFORE the transfer -> fundedAddressFresh is false', async () => {
    const funderAddr = `${ADDR_PREFIX}_funder_notfresh`;
    const fundedAddr = `${ADDR_PREFIX}_funded_notfresh`;
    const tokenAddr = `${ADDR_PREFIX}_token_notfresh`;
    const otherTokenAddr = `${ADDR_PREFIX}_token_notfresh_other`;
    const now = new Date('2026-07-05T12:00:00Z');

    const funder = await prisma.wallet.upsert({
      where: { address_chain: { address: funderAddr, chain: CHAIN } },
      create: { address: funderAddr, chain: CHAIN, firstSeenAt: now, lastActiveAt: now, isWatched: true, status: 'signal_eligible' },
      update: { isWatched: true, status: 'signal_eligible' }
    });
    const funded = await prisma.wallet.upsert({
      where: { address_chain: { address: fundedAddr, chain: CHAIN } },
      create: { address: fundedAddr, chain: CHAIN, firstSeenAt: now, lastActiveAt: now, isWatched: false },
      update: {}
    });
    const token = await prisma.token.upsert({
      where: { chain_address: { chain: CHAIN, address: tokenAddr } },
      create: {
        chain: CHAIN,
        address: tokenAddr,
        symbol: 'T15FN',
        name: 'T15 Not Fresh Token',
        decimals: 9,
        firstSeenAt: now,
        riskFlags: []
      },
      update: {}
    });
    const otherToken = await prisma.token.upsert({
      where: { chain_address: { chain: CHAIN, address: otherTokenAddr } },
      create: {
        chain: CHAIN,
        address: otherTokenAddr,
        symbol: 'T15FNO',
        name: 'T15 Not Fresh Other Token',
        decimals: 9,
        firstSeenAt: now,
        riskFlags: []
      },
      update: {}
    });

    const transferTs = new Date(now.getTime() - 30 * 60_000);

    // Funded wallet already traded (a DIFFERENT token) BEFORE the transfer -> not fresh.
    const priorTradeTs = new Date(transferTs.getTime() - 60 * 60_000); // 1h before the transfer
    await prisma.walletTokenTrade.create({
      data: {
        walletId: funded.id,
        tokenId: otherToken.id,
        chain: CHAIN,
        action: 'BUY',
        amountToken: 500,
        amountUsd: 100,
        txHash: `${ADDR_PREFIX}_tx_prior_trade`,
        blockOrSlot: 1n,
        ts: priorTradeTs,
        priceUsd: 0.2,
        marketCapAtTrade: 100_000,
        walletScoreAtTime: 20,
        provider: 'test'
      }
    });

    await prisma.moneyFlowEdge.create({
      data: {
        sourceAddress: funderAddr,
        destinationAddress: fundedAddr,
        sourceChain: CHAIN,
        destinationChain: CHAIN,
        asset: 'SOL',
        amountToken: 5,
        amountUsd: 1000,
        ts: transferTs,
        txHash: `${ADDR_PREFIX}_tx_transfer_notfresh`,
        actionType: 'transfer',
        confidence: 100,
        providerSource: 'test',
        metadata: {}
      }
    });

    const buyTs = new Date(transferTs.getTime() + 20 * 60_000);
    await prisma.walletTokenTrade.create({
      data: {
        walletId: funded.id,
        tokenId: token.id,
        chain: CHAIN,
        action: 'BUY',
        amountToken: 1000,
        amountUsd: 600,
        txHash: `${ADDR_PREFIX}_tx_buy_notfresh`,
        blockOrSlot: 2n,
        ts: buyTs,
        priceUsd: 0.6,
        marketCapAtTrade: 200_000,
        walletScoreAtTime: 30,
        provider: 'test'
      }
    });

    const windowFrom = new Date(now.getTime() - 2 * 60 * 60_000);
    const events = await buildFundingEvents(prisma, token.id, windowFrom, now, DEFAULT_SETTINGS);

    const match = events.find((e) => e.funderWalletId === funder.id && e.fundedWalletId === funded.id);
    expect(match).toBeDefined();
    expect(match!.fundedAddressFresh).toBe(false);
  });

  it('funder that is neither watched nor profitable produces NO FundingEvent for that transfer', async () => {
    const funderAddr = `${ADDR_PREFIX}_funder_unqualified`;
    const fundedAddr = `${ADDR_PREFIX}_funded_unqualified`;
    const tokenAddr = `${ADDR_PREFIX}_token_unqualified`;
    const now = new Date('2026-07-05T12:00:00Z');

    const funder = await prisma.wallet.upsert({
      where: { address_chain: { address: funderAddr, chain: CHAIN } },
      create: { address: funderAddr, chain: CHAIN, firstSeenAt: now, lastActiveAt: now, isWatched: false },
      update: { isWatched: false }
    });
    const funded = await prisma.wallet.upsert({
      where: { address_chain: { address: fundedAddr, chain: CHAIN } },
      create: { address: fundedAddr, chain: CHAIN, firstSeenAt: now, lastActiveAt: now, isWatched: false },
      update: {}
    });
    const token = await prisma.token.upsert({
      where: { chain_address: { chain: CHAIN, address: tokenAddr } },
      create: {
        chain: CHAIN,
        address: tokenAddr,
        symbol: 'T15FU',
        name: 'T15 Unqualified Funder Token',
        decimals: 9,
        firstSeenAt: now,
        riskFlags: []
      },
      update: {}
    });

    const transferTs = new Date(now.getTime() - 30 * 60_000);
    await prisma.moneyFlowEdge.create({
      data: {
        sourceAddress: funderAddr,
        destinationAddress: fundedAddr,
        sourceChain: CHAIN,
        destinationChain: CHAIN,
        asset: 'SOL',
        amountToken: 5,
        amountUsd: 1000,
        ts: transferTs,
        txHash: `${ADDR_PREFIX}_tx_transfer_unqualified`,
        actionType: 'transfer',
        confidence: 100,
        providerSource: 'test',
        metadata: {}
      }
    });

    const windowFrom = new Date(now.getTime() - 2 * 60 * 60_000);
    const events = await buildFundingEvents(prisma, token.id, windowFrom, now, DEFAULT_SETTINGS);

    const match = events.find((e) => e.funderWalletId === funder.id && e.fundedWalletId === funded.id);
    expect(match).toBeUndefined();
  });
});
