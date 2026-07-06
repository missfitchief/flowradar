// FlowRadar — runLocalOverlapSearch tests (Task 38, Wave 4.6). Same
// LITE-Postgres integration pattern as duneOverlap.test.ts.
//
// Covers: finds a wallet that bought >= minTokensOverlap of the given tokens,
// respects min_trade_usd on BUY rows, groups wallets sharing the exact same
// token set, and never creates a CandidateWallet row (local overlap has no
// candidate gate — see localOverlap.ts's own header).

import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import net from 'node:net';
import { prisma } from '../../src/client';
import { runLocalOverlapSearch } from '../../src/dune/localOverlap';

const PREFIX = 'T38LOCAL';
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
    console.warn('[localOverlap.test] LITE Postgres not reachable on localhost:5439 — skipping integration tests.');
  }
});

async function cleanup() {
  await prisma.tokenOverlapSearch.deleteMany({ where: { tokenAddresses: { hasSome: [`${PREFIX}_tokA`] } } });
  await prisma.walletTokenTrade.deleteMany({ where: { txHash: { startsWith: PREFIX } } });
  await prisma.candidateWallet.deleteMany({ where: { walletAddress: { startsWith: PREFIX } } });
  await prisma.wallet.deleteMany({ where: { address: { startsWith: PREFIX } } });
  await prisma.token.deleteMany({ where: { address: { startsWith: PREFIX } } });
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

async function seedTokenAndWallet(tokenAddr: string, walletAddr: string) {
  const now = new Date();
  const token = await prisma.token.upsert({
    where: { chain_address: { chain: CHAIN, address: tokenAddr } },
    create: {
      chain: CHAIN,
      address: tokenAddr,
      symbol: tokenAddr,
      name: tokenAddr,
      decimals: 9,
      firstSeenAt: now,
      riskFlags: {}
    },
    update: {}
  });
  const wallet = await prisma.wallet.upsert({
    where: { address_chain: { address: walletAddr, chain: CHAIN } },
    create: { address: walletAddr, chain: CHAIN, firstSeenAt: now, lastActiveAt: now },
    update: {}
  });
  return { token, wallet };
}

async function trade(opts: {
  wallet: { id: string };
  token: { id: string };
  action: 'BUY' | 'SELL';
  amountUsd: number;
  txHash: string;
  ts?: Date;
}) {
  await prisma.walletTokenTrade.create({
    data: {
      walletId: opts.wallet.id,
      tokenId: opts.token.id,
      chain: CHAIN,
      action: opts.action,
      amountToken: 100,
      amountUsd: opts.amountUsd,
      txHash: opts.txHash,
      blockOrSlot: 1,
      ts: opts.ts ?? new Date(),
      priceUsd: 1,
      marketCapAtTrade: 1_000_000,
      walletScoreAtTime: 50,
      provider: 'test'
    }
  });
}

describe.skipIf(!(await probePort('localhost', 5439)))('runLocalOverlapSearch', () => {
  it('finds a wallet that bought all N tokens, aggregates buy/sell/pnl, never creates a CandidateWallet', async () => {
    const tokA = `${PREFIX}_tokA`;
    const tokB = `${PREFIX}_tokB`;
    const w1 = `${PREFIX}_w1`;

    const { token: tA, wallet } = await seedTokenAndWallet(tokA, w1);
    const { token: tB } = await seedTokenAndWallet(tokB, w1);

    await trade({ wallet, token: tA, action: 'BUY', amountUsd: 500, txHash: `${PREFIX}_tx1` });
    await trade({ wallet, token: tB, action: 'BUY', amountUsd: 300, txHash: `${PREFIX}_tx2` });
    await trade({ wallet, token: tB, action: 'SELL', amountUsd: 900, txHash: `${PREFIX}_tx3` });

    const result = await runLocalOverlapSearch(prisma, { chain: CHAIN, tokenAddresses: [tokA, tokB] });

    expect(result.status).toBe('done');
    expect(result.walletResultsCreated).toBe(1);

    const walletResults = await prisma.tokenOverlapWalletResult.findMany({ where: { searchId: result.searchId } });
    expect(walletResults).toHaveLength(1);
    expect(walletResults[0]!.walletAddress).toBe(w1);
    expect(walletResults[0]!.tokensOverlapCount).toBe(2);
    expect(Number(walletResults[0]!.totalBuyUsd)).toBe(800);
    expect(Number(walletResults[0]!.totalSellUsd)).toBe(900);
    expect(Number(walletResults[0]!.estimatedPnlUsd)).toBe(100);

    const candidates = await prisma.candidateWallet.findMany({ where: { walletAddress: w1 } });
    expect(candidates).toHaveLength(0);

    const search = await prisma.tokenOverlapSearch.findUnique({ where: { id: result.searchId } });
    expect(search?.usedCachedResult).toBeNull();
  });

  it('excludes a wallet whose BUYs are all below min_trade_usd', async () => {
    const tokA = `${PREFIX}_tokA2`;
    const tokB = `${PREFIX}_tokB2`;
    const w1 = `${PREFIX}_w2`;

    const { token: tA, wallet } = await seedTokenAndWallet(tokA, w1);
    const { token: tB } = await seedTokenAndWallet(tokB, w1);

    await trade({ wallet, token: tA, action: 'BUY', amountUsd: 10, txHash: `${PREFIX}_tx4` });
    await trade({ wallet, token: tB, action: 'BUY', amountUsd: 10, txHash: `${PREFIX}_tx5` });

    const result = await runLocalOverlapSearch(prisma, {
      chain: CHAIN,
      tokenAddresses: [tokA, tokB],
      minTradeUsd: 100
    });

    expect(result.walletResultsCreated).toBe(0);
  });

  it('groups wallets sharing the exact same overlapping-token set into a TokenOverlapGroupResult', async () => {
    const tokA = `${PREFIX}_tokA3`;
    const tokB = `${PREFIX}_tokB3`;
    const w1 = `${PREFIX}_w3`;
    const w2 = `${PREFIX}_w4`;

    const { token: tA, wallet: wallet1 } = await seedTokenAndWallet(tokA, w1);
    const { token: tB } = await seedTokenAndWallet(tokB, w1);
    const { wallet: wallet2 } = await seedTokenAndWallet(tokA, w2);
    await prisma.walletTokenTrade.deleteMany({ where: { walletId: wallet2.id } }); // ensure clean slate for w2

    await trade({ wallet: wallet1, token: tA, action: 'BUY', amountUsd: 500, txHash: `${PREFIX}_tx6` });
    await trade({ wallet: wallet1, token: tB, action: 'BUY', amountUsd: 500, txHash: `${PREFIX}_tx7` });
    await trade({ wallet: wallet2, token: tA, action: 'BUY', amountUsd: 500, txHash: `${PREFIX}_tx8` });
    await trade({ wallet: wallet2, token: tB, action: 'BUY', amountUsd: 500, txHash: `${PREFIX}_tx9` });

    const result = await runLocalOverlapSearch(prisma, { chain: CHAIN, tokenAddresses: [tokA, tokB] });

    expect(result.walletResultsCreated).toBe(2);
    expect(result.groupResultsCreated).toBe(1);

    const groups = await prisma.tokenOverlapGroupResult.findMany({ where: { searchId: result.searchId } });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.walletCount).toBe(2);
    expect(groups[0]!.walletAddresses.sort()).toEqual([w1, w2].sort());
  });

  it('no matching tokens in DB => done with 0 rows, never throws', async () => {
    const result = await runLocalOverlapSearch(prisma, {
      chain: CHAIN,
      tokenAddresses: [`${PREFIX}_nonexistentA`, `${PREFIX}_nonexistentB`]
    });
    expect(result.status).toBe('done');
    expect(result.rowsReturned).toBe(0);
  });
});
