// FlowRadar — buildRotationInputs / runProfitRotation integration tests (Task
// 23 binding decision 2). Same LITE-Postgres integration pattern as
// clustering.test.ts / fundingEvents.test.ts (prefix-cleanup, describe.skipIf
// when the embedded Postgres isn't reachable).
//
// Builds a minimal ALPHA(SOLANA)->BETA(BSC) shaped fixture directly against
// the DB: a wallet SELLs ALPHA at a realized profit, bridges the proceeds via
// a bridge_deposit(SOLANA)+bridge_withdrawal(BSC) MoneyFlowEdge pair, and the
// BSC wallet BUYs BETA shortly after — mirrors
// packages/providers/src/mock/scenarios.ts's buildAlphaToBeta but constructed
// directly via Prisma so this test doesn't depend on the mock-world module.

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import net from 'node:net';
import { DEFAULT_SETTINGS, matchRotations } from '@flowradar/core';
import { prisma } from '../src/client';
import { buildRotationInputs, runProfitRotation } from '../src/rotation';

const ADDR_PREFIX = 'T23ROTATION';

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
      '[rotation.test] LITE Postgres not reachable on localhost:5439 — skipping ' +
        'integration tests. Run `npm run db:migrate` first to exercise this suite.'
    );
  }
});

afterAll(async () => {
  if (!dbReachable) return;
  await prisma.profitRotationSignal.deleteMany({ where: { sourceWallet: { address: { startsWith: ADDR_PREFIX } } } });
  await prisma.walletTokenTrade.deleteMany({ where: { wallet: { address: { startsWith: ADDR_PREFIX } } } });
  // Both sourceAddress AND destinationAddress must be checked: the bridge
  // deposit/withdrawal pair's intermediary leg (the 'wormhole-bridge-program'
  // address) is NOT itself ADDR_PREFIX-scoped — it appears as the
  // destinationAddress on the deposit row and the sourceAddress on the
  // withdrawal row, so a sourceAddress-only filter misses the withdrawal row
  // and leaves it behind for a later run to collide with on the
  // (txHash, sourceAddress, destinationAddress, actionType) unique constraint.
  await prisma.moneyFlowEdge.deleteMany({
    where: {
      OR: [{ sourceAddress: { startsWith: ADDR_PREFIX } }, { destinationAddress: { startsWith: ADDR_PREFIX } }]
    }
  });
  await prisma.tokenMarketSnapshot.deleteMany({ where: { token: { address: { startsWith: ADDR_PREFIX } } } });
  await prisma.wallet.deleteMany({ where: { address: { startsWith: ADDR_PREFIX } } });
  await prisma.token.deleteMany({ where: { address: { startsWith: ADDR_PREFIX } } });
  await prisma.$disconnect();
});

describe.skipIf(!(await probePort('localhost', 5439)))('buildRotationInputs / runProfitRotation', () => {
  it('assembles a known exit+bridge-transfer+buy into one matched candidate, then persists + dedupes a ProfitRotationSignal', async () => {
    const now = new Date();
    const windowFrom = new Date(now.getTime() - 48 * 60 * 60_000);

    const alphaAddr = `${ADDR_PREFIX}_alpha_token`;
    const betaAddr = `${ADDR_PREFIX}_beta_token`;
    const sourceAddr = `${ADDR_PREFIX}_source_wallet`;
    const destAddr = `${ADDR_PREFIX}_dest_wallet`;

    const alphaToken = await prisma.token.upsert({
      where: { chain_address: { chain: 'SOLANA', address: alphaAddr } },
      create: { chain: 'SOLANA', address: alphaAddr, symbol: 'T23A', name: 'T23 Alpha', decimals: 9, firstSeenAt: windowFrom, riskFlags: [] },
      update: {}
    });
    const betaToken = await prisma.token.upsert({
      where: { chain_address: { chain: 'BSC', address: betaAddr } },
      create: { chain: 'BSC', address: betaAddr, symbol: 'T23B', name: 'T23 Beta', decimals: 18, firstSeenAt: windowFrom, riskFlags: [] },
      update: {}
    });

    const sourceWallet = await prisma.wallet.upsert({
      where: { address_chain: { address: sourceAddr, chain: 'SOLANA' } },
      create: { address: sourceAddr, chain: 'SOLANA', firstSeenAt: windowFrom, lastActiveAt: now, isWatched: true },
      update: {}
    });
    const destWallet = await prisma.wallet.upsert({
      where: { address_chain: { address: destAddr, chain: 'BSC' } },
      create: { address: destAddr, chain: 'BSC', firstSeenAt: windowFrom, lastActiveAt: now, isWatched: false },
      update: {}
    });

    // Buy ALPHA cheap, then sell at a profit (realized ~$3,000).
    const buyTs = new Date(now.getTime() - 20 * 60 * 60_000);
    await prisma.walletTokenTrade.create({
      data: {
        walletId: sourceWallet.id,
        tokenId: alphaToken.id,
        chain: 'SOLANA',
        action: 'BUY',
        amountToken: 200_000,
        amountUsd: 2000,
        txHash: `${ADDR_PREFIX}_tx_alpha_buy`,
        blockOrSlot: BigInt(1),
        ts: buyTs,
        priceUsd: 0.01,
        marketCapAtTrade: 600_000,
        walletScoreAtTime: 80,
        provider: 'test'
      }
    });
    const sellTs = new Date(buyTs.getTime() + 6 * 60 * 60_000);
    await prisma.walletTokenTrade.create({
      data: {
        walletId: sourceWallet.id,
        tokenId: alphaToken.id,
        chain: 'SOLANA',
        action: 'SELL',
        amountToken: 200_000,
        amountUsd: 5000,
        txHash: `${ADDR_PREFIX}_tx_alpha_sell`,
        blockOrSlot: BigInt(2),
        ts: sellTs,
        priceUsd: 0.025,
        marketCapAtTrade: 900_000,
        walletScoreAtTime: 80,
        provider: 'test'
      }
    });

    // Bridge deposit (Wormhole) SOL side, 10 min after the sell.
    const depositTs = new Date(sellTs.getTime() + 10 * 60_000);
    const depositUsd = 4800;
    await prisma.moneyFlowEdge.create({
      data: {
        sourceAddress: sourceAddr,
        destinationAddress: 'wormhole-bridge-program',
        sourceChain: 'SOLANA',
        destinationChain: 'SOLANA',
        asset: 'USDC',
        amountToken: depositUsd,
        amountUsd: depositUsd,
        ts: depositTs,
        txHash: `${ADDR_PREFIX}_tx_bridge_deposit`,
        actionType: 'bridge_deposit',
        bridgeProtocol: 'Wormhole',
        confidence: 100,
        providerSource: 'test',
        metadata: {}
      }
    });

    // Bridge withdrawal BSC side: 97% of deposit, 25 min gap.
    const withdrawTs = new Date(depositTs.getTime() + 25 * 60_000);
    const withdrawUsd = depositUsd * 0.97;
    await prisma.moneyFlowEdge.create({
      data: {
        sourceAddress: 'wormhole-bridge-program',
        destinationAddress: destAddr,
        sourceChain: 'BSC',
        destinationChain: 'BSC',
        asset: 'USDC',
        amountToken: withdrawUsd,
        amountUsd: withdrawUsd,
        ts: withdrawTs,
        txHash: `${ADDR_PREFIX}_tx_bridge_withdraw`,
        actionType: 'bridge_withdrawal',
        bridgeProtocol: 'Wormhole',
        confidence: 100,
        providerSource: 'test',
        metadata: {}
      }
    });

    // BSC wallet buys BETA 30 min after receiving the bridged funds.
    const betaBuyTs = new Date(withdrawTs.getTime() + 30 * 60_000);
    await prisma.walletTokenTrade.create({
      data: {
        walletId: destWallet.id,
        tokenId: betaToken.id,
        chain: 'BSC',
        action: 'BUY',
        amountToken: withdrawUsd * 0.9 / 0.002,
        amountUsd: withdrawUsd * 0.9,
        txHash: `${ADDR_PREFIX}_tx_beta_buy`,
        blockOrSlot: BigInt(3),
        ts: betaBuyTs,
        priceUsd: 0.002,
        marketCapAtTrade: 800_000,
        walletScoreAtTime: 75,
        provider: 'test'
      }
    });

    // A market snapshot for BETA so currentDestPerfPct has something to compare against.
    await prisma.tokenMarketSnapshot.create({
      data: {
        tokenId: betaToken.id,
        ts: now,
        priceUsd: 0.003,
        marketCapUsd: 1_200_000,
        fdvUsd: 1_200_000,
        liquidityUsd: 50_000,
        vol5m: 0,
        vol1h: 0,
        vol6h: 0,
        vol24h: 0,
        holderCount: 10
      }
    });

    // -- buildRotationInputs assembles the known exit+transfer+buy. ----------
    const inputs = await buildRotationInputs(prisma, windowFrom, now);

    const exit = inputs.exits.find((e) => e.walletId === sourceWallet.id && e.tokenId === alphaToken.id);
    expect(exit).toBeDefined();
    expect(exit!.realizedProfitUsd).toBeCloseTo(3000, 0);

    const destBuy = inputs.destBuys.find((b) => b.walletId === destWallet.id && b.tokenId === betaToken.id);
    expect(destBuy).toBeDefined();
    expect(destBuy!.mcapAtBuy).toBe(800_000);

    // -- runProfitRotation matches + persists a ProfitRotationSignal row. ----
    const { result: firstResult, candidates } = await runProfitRotation(prisma, DEFAULT_SETTINGS, now);

    const ourCandidate = candidates.find(
      (c) => c.sourceWalletId === sourceWallet.id && c.destWalletId === destWallet.id && c.destTokenId === betaToken.id
    );
    expect(ourCandidate).toBeDefined();
    expect(ourCandidate!.bridged).toBe(true);
    expect(ourCandidate!.chainPath).toEqual(['SOLANA', 'BSC']);
    expect(firstResult.signalsCreated).toBeGreaterThanOrEqual(1);

    const signalRow = await prisma.profitRotationSignal.findFirst({
      where: { sourceWalletId: sourceWallet.id, destWalletId: destWallet.id, destTokenId: betaToken.id }
    });
    expect(signalRow).toBeDefined();
    expect(signalRow!.chainPath).toEqual(['SOLANA', 'BSC']);
    expect(Number(signalRow!.realizedProfitUsd)).toBeCloseTo(3000, 0);

    // receivedValueUsd (Task 43 review fix: real match-%, not the settings
    // floor) must be persisted verbatim from the matched candidate — the
    // withdrawal leg was built as 97% of the deposit amount above, so the
    // real value-match% (receivedValueUsd/transferredValueUsd*100) is ~97%,
    // not the settings floor.
    expect(signalRow!.receivedValueUsd).not.toBeNull();
    expect(Number(signalRow!.receivedValueUsd)).toBeCloseTo(withdrawUsd, 2);
    const realValueMatchPct = (Number(signalRow!.receivedValueUsd) / Number(signalRow!.transferredValueUsd)) * 100;
    expect(realValueMatchPct).toBeCloseTo(97, 0);

    // -- Second run dedupes: no additional row for the same wallet pair + dest token. --
    const countBefore = await prisma.profitRotationSignal.count({
      where: { sourceWalletId: sourceWallet.id, destWalletId: destWallet.id, destTokenId: betaToken.id }
    });
    const { result: secondResult } = await runProfitRotation(prisma, DEFAULT_SETTINGS, now);
    const countAfter = await prisma.profitRotationSignal.count({
      where: { sourceWalletId: sourceWallet.id, destWalletId: destWallet.id, destTokenId: betaToken.id }
    });
    expect(countAfter).toBe(countBefore);
    expect(secondResult.signalsDeduped).toBeGreaterThanOrEqual(1);
  });

  it('two INDEPENDENT same-protocol bridge hops (different wallets/amounts) do not cross-wire each other\'s transfer.chainTo/toWalletId', async () => {
    // Reproduces a real cross-contamination bug: buildRotationInputs' bridge
    // pairing used to match a deposit-transfer's destination to the FIRST
    // same-bridgeProtocol withdrawal found anywhere in the (unscoped, global)
    // query result — with NO amount/time proximity check — so two unrelated
    // bridge hops using the same protocol name (e.g. two different users both
    // using "Wormhole" close together in time) could have their destinations
    // swapped. This is exactly what made packages/db/test/rotation.test.ts's
    // main fixture flaky whenever it ran in the same vitest process as
    // clusteringEvidence.test.ts's own "Wormhole" bridge fixture.
    const now = new Date();

    const alphaAddr = `${ADDR_PREFIX}_x2_alpha_token`;
    const betaAddr = `${ADDR_PREFIX}_x2_beta_token`;
    const gammaAddr = `${ADDR_PREFIX}_x2_gamma_token`;

    const alphaToken = await prisma.token.upsert({
      where: { chain_address: { chain: 'SOLANA', address: alphaAddr } },
      create: { chain: 'SOLANA', address: alphaAddr, symbol: 'T23X2A', name: 'T23 X2 Alpha', decimals: 9, firstSeenAt: now, riskFlags: [] },
      update: {}
    });
    const betaToken = await prisma.token.upsert({
      where: { chain_address: { chain: 'BSC', address: betaAddr } },
      create: { chain: 'BSC', address: betaAddr, symbol: 'T23X2B', name: 'T23 X2 Beta', decimals: 18, firstSeenAt: now, riskFlags: [] },
      update: {}
    });
    const gammaToken = await prisma.token.upsert({
      where: { chain_address: { chain: 'BSC', address: gammaAddr } },
      create: { chain: 'BSC', address: gammaAddr, symbol: 'T23X2G', name: 'T23 X2 Gamma', decimals: 18, firstSeenAt: now, riskFlags: [] },
      update: {}
    });

    async function makeSourceWallet(suffix: string): Promise<{ id: string; address: string }> {
      const address = `${ADDR_PREFIX}_x2_source_${suffix}`;
      const w = await prisma.wallet.upsert({
        where: { address_chain: { address, chain: 'SOLANA' } },
        create: { address, chain: 'SOLANA', firstSeenAt: now, lastActiveAt: now, isWatched: true },
        update: {}
      });
      return { id: w.id, address };
    }
    async function makeDestWallet(suffix: string): Promise<{ id: string; address: string }> {
      const address = `${ADDR_PREFIX}_x2_dest_${suffix}`;
      const w = await prisma.wallet.upsert({
        where: { address_chain: { address, chain: 'BSC' } },
        create: { address, chain: 'BSC', firstSeenAt: now, lastActiveAt: now, isWatched: false },
        update: {}
      });
      return { id: w.id, address };
    }

    const source1 = await makeSourceWallet('1');
    const dest1 = await makeDestWallet('1');
    const source2 = await makeSourceWallet('2');
    const dest2 = await makeDestWallet('2');

    // Hop 1: source1 exits ALPHA at a profit, bridges $4,800 -> dest1 buys BETA.
    const buy1Ts = new Date(now.getTime() - 20 * 60 * 60_000);
    await prisma.walletTokenTrade.create({
      data: {
        walletId: source1.id, tokenId: alphaToken.id, chain: 'SOLANA', action: 'BUY',
        amountToken: 200_000, amountUsd: 2000, txHash: `${ADDR_PREFIX}_x2_tx_alpha_buy_1`,
        blockOrSlot: BigInt(10), ts: buy1Ts, priceUsd: 0.01, marketCapAtTrade: 600_000,
        walletScoreAtTime: 80, provider: 'test'
      }
    });
    const sell1Ts = new Date(buy1Ts.getTime() + 6 * 60 * 60_000);
    await prisma.walletTokenTrade.create({
      data: {
        walletId: source1.id, tokenId: alphaToken.id, chain: 'SOLANA', action: 'SELL',
        amountToken: 200_000, amountUsd: 5000, txHash: `${ADDR_PREFIX}_x2_tx_alpha_sell_1`,
        blockOrSlot: BigInt(11), ts: sell1Ts, priceUsd: 0.025, marketCapAtTrade: 900_000,
        walletScoreAtTime: 80, provider: 'test'
      }
    });
    const deposit1Ts = new Date(sell1Ts.getTime() + 10 * 60_000);
    const deposit1Usd = 4800;
    await prisma.moneyFlowEdge.create({
      data: {
        sourceAddress: source1.address, destinationAddress: `${ADDR_PREFIX}_x2_bridge_program`,
        sourceChain: 'SOLANA', destinationChain: 'SOLANA', asset: 'USDC',
        amountToken: deposit1Usd, amountUsd: deposit1Usd, ts: deposit1Ts,
        txHash: `${ADDR_PREFIX}_x2_tx_dep_1`, actionType: 'bridge_deposit', bridgeProtocol: 'Wormhole',
        confidence: 100, providerSource: 'test', metadata: {}
      }
    });
    const withdraw1Ts = new Date(deposit1Ts.getTime() + 25 * 60_000);
    const withdraw1Usd = deposit1Usd * 0.97;
    await prisma.moneyFlowEdge.create({
      data: {
        sourceAddress: `${ADDR_PREFIX}_x2_bridge_program`, destinationAddress: dest1.address,
        sourceChain: 'BSC', destinationChain: 'BSC', asset: 'USDC',
        amountToken: withdraw1Usd, amountUsd: withdraw1Usd, ts: withdraw1Ts,
        txHash: `${ADDR_PREFIX}_x2_tx_wd_1`, actionType: 'bridge_withdrawal', bridgeProtocol: 'Wormhole',
        confidence: 100, providerSource: 'test', metadata: {}
      }
    });
    const betaBuyTs = new Date(withdraw1Ts.getTime() + 30 * 60_000);
    await prisma.walletTokenTrade.create({
      data: {
        walletId: dest1.id, tokenId: betaToken.id, chain: 'BSC', action: 'BUY',
        amountToken: (withdraw1Usd * 0.9) / 0.002, amountUsd: withdraw1Usd * 0.9,
        txHash: `${ADDR_PREFIX}_x2_tx_beta_buy_1`, blockOrSlot: BigInt(12), ts: betaBuyTs,
        priceUsd: 0.002, marketCapAtTrade: 800_000, walletScoreAtTime: 75, provider: 'test'
      }
    });

    // Hop 2: a COMPLETELY DIFFERENT wallet, ALSO via "Wormhole", overlapping
    // in time with hop 1, but a very different amount ($1,200 vs $4,800) so
    // amount-proximity matching can tell the two hops apart.
    const buy2Ts = new Date(now.getTime() - 19 * 60 * 60_000);
    await prisma.walletTokenTrade.create({
      data: {
        walletId: source2.id, tokenId: alphaToken.id, chain: 'SOLANA', action: 'BUY',
        amountToken: 50_000, amountUsd: 500, txHash: `${ADDR_PREFIX}_x2_tx_alpha_buy_2`,
        blockOrSlot: BigInt(20), ts: buy2Ts, priceUsd: 0.01, marketCapAtTrade: 600_000,
        walletScoreAtTime: 80, provider: 'test'
      }
    });
    const sell2Ts = new Date(buy2Ts.getTime() + 5 * 60 * 60_000);
    await prisma.walletTokenTrade.create({
      data: {
        walletId: source2.id, tokenId: alphaToken.id, chain: 'SOLANA', action: 'SELL',
        amountToken: 50_000, amountUsd: 1250, txHash: `${ADDR_PREFIX}_x2_tx_alpha_sell_2`,
        blockOrSlot: BigInt(21), ts: sell2Ts, priceUsd: 0.025, marketCapAtTrade: 900_000,
        walletScoreAtTime: 80, provider: 'test'
      }
    });
    const deposit2Ts = new Date(sell2Ts.getTime() + 10 * 60_000);
    const deposit2Usd = 1200;
    await prisma.moneyFlowEdge.create({
      data: {
        sourceAddress: source2.address, destinationAddress: `${ADDR_PREFIX}_x2_bridge_program`,
        sourceChain: 'SOLANA', destinationChain: 'SOLANA', asset: 'USDC',
        amountToken: deposit2Usd, amountUsd: deposit2Usd, ts: deposit2Ts,
        txHash: `${ADDR_PREFIX}_x2_tx_dep_2`, actionType: 'bridge_deposit', bridgeProtocol: 'Wormhole',
        confidence: 100, providerSource: 'test', metadata: {}
      }
    });
    const withdraw2Ts = new Date(deposit2Ts.getTime() + 20 * 60_000);
    const withdraw2Usd = deposit2Usd * 0.97;
    await prisma.moneyFlowEdge.create({
      data: {
        sourceAddress: `${ADDR_PREFIX}_x2_bridge_program`, destinationAddress: dest2.address,
        sourceChain: 'BSC', destinationChain: 'BSC', asset: 'USDC',
        amountToken: withdraw2Usd, amountUsd: withdraw2Usd, ts: withdraw2Ts,
        txHash: `${ADDR_PREFIX}_x2_tx_wd_2`, actionType: 'bridge_withdrawal', bridgeProtocol: 'Wormhole',
        confidence: 100, providerSource: 'test', metadata: {}
      }
    });
    const gammaBuyTs = new Date(withdraw2Ts.getTime() + 15 * 60_000);
    await prisma.walletTokenTrade.create({
      data: {
        walletId: dest2.id, tokenId: gammaToken.id, chain: 'BSC', action: 'BUY',
        amountToken: (withdraw2Usd * 0.9) / 0.001, amountUsd: withdraw2Usd * 0.9,
        txHash: `${ADDR_PREFIX}_x2_tx_gamma_buy_2`, blockOrSlot: BigInt(22), ts: gammaBuyTs,
        priceUsd: 0.001, marketCapAtTrade: 700_000, walletScoreAtTime: 75, provider: 'test'
      }
    });

    const windowFrom = new Date(now.getTime() - 48 * 60 * 60_000);
    const inputs = await buildRotationInputs(prisma, windowFrom, now);

    // Each deposit-transfer must resolve to ITS OWN withdrawal's destination
    // — hop 1's transfer must point at dest1/BSC (not dest2), and hop 2's
    // transfer must point at dest2/BSC (not dest1). If the bug is present,
    // whichever withdrawal the (unscoped) query happens to return first for
    // the "Wormhole" protocol gets applied to BOTH transfers.
    const transfer1 = inputs.transfers.find((t) => t.fromWalletId === source1.id && t.bridged);
    const transfer2 = inputs.transfers.find((t) => t.fromWalletId === source2.id && t.bridged);
    expect(transfer1).toBeDefined();
    expect(transfer2).toBeDefined();
    expect(transfer1!.toWalletId).toBe(dest1.id);
    expect(transfer2!.toWalletId).toBe(dest2.id);

    const candidates = matchRotations({ ...inputs, settings: DEFAULT_SETTINGS });
    const candidate1 = candidates.find((c) => c.sourceWalletId === source1.id);
    const candidate2 = candidates.find((c) => c.sourceWalletId === source2.id);
    expect(candidate1).toBeDefined();
    expect(candidate1!.destWalletId).toBe(dest1.id);
    expect(candidate1!.destTokenId).toBe(betaToken.id);
    expect(candidate2).toBeDefined();
    expect(candidate2!.destWalletId).toBe(dest2.id);
    expect(candidate2!.destTokenId).toBe(gammaToken.id);
  });
});
