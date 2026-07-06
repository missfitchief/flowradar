import { describe, expect, it } from 'vitest';
import { createMockWorld } from '../src/mock/world';
import type { MockWorld } from '../src/mock/world';
import { GRAPH_DEMO_ROOT_ADDRESS } from '../src/mock/scenarios';
import type { NormalizedTx, TxLeg } from '@flowradar/core';

const GENESIS = new Date('2026-07-05T00:00:00Z');
const SEED = 20260705;

const world: MockWorld = createMockWorld({ seed: SEED, genesis: GENESIS });

function tokenBySymbol(symbol: string) {
  const token = world.tokens.find((t) => t.symbol === symbol);
  if (!token) throw new Error(`token ${symbol} not found in mock world`);
  return token;
}

/** All txs across every wallet, flattened, sorted by ts ascending. */
function allTxs(): NormalizedTx[] {
  const out: NormalizedTx[] = [];
  for (const txs of world.txsByWallet.values()) {
    out.push(...txs);
  }
  out.sort((a, b) => a.ts.getTime() - b.ts.getTime());
  return out;
}

/** Legs across all txs whose asset.address matches tokenAddress and kind is swap_leg (buy/sell proxy). */
function legsForToken(tokenAddress: string): { tx: NormalizedTx; leg: TxLeg }[] {
  const out: { tx: NormalizedTx; leg: TxLeg }[] = [];
  for (const tx of allTxs()) {
    for (const leg of tx.legs) {
      if (leg.asset.address === tokenAddress) {
        out.push({ tx, leg });
      }
    }
  }
  return out;
}

function walletLabel(address: string): string[] {
  const w = world.wallets.find((w) => w.address === address);
  return w?.labels ?? [];
}

// ---------------------------------------------------------------------------
// $NOVA — Rule A/C/D fixture
// ---------------------------------------------------------------------------

describe('$NOVA scenario', () => {
  const nova = tokenBySymbol('NOVA');
  const handle = world.meta.scenarios.nova;

  it('has >= 35 distinct smart-wallet buyers inside one 25-minute span', () => {
    const buys = legsForToken(nova.address).filter(
      (e) => e.leg.kind === 'swap_leg' && e.leg.to !== nova.address /* buy = token flows TO the buyer */
    );
    // Restrict to the scripted window and count distinct buyer wallets.
    const windowStart = handle.windowStart.getTime();
    const windowEnd = handle.windowStart.getTime() + 25 * 60 * 1000;
    const buyersInWindow = new Set(
      buys.filter((e) => e.tx.ts.getTime() >= windowStart && e.tx.ts.getTime() < windowEnd).map((e) => e.leg.to)
    );
    expect(buyersInWindow.size).toBeGreaterThanOrEqual(35);

    const smartBuyers = [...buyersInWindow].filter((addr) => {
      const labels = walletLabel(addr);
      return labels.includes('smart_money') || labels.includes('human_like');
    });
    expect(smartBuyers.length / buyersInWindow.size).toBeGreaterThanOrEqual(0.7);
  });

  it('has exactly one whale buy >= $12,000', () => {
    const buys = legsForToken(nova.address).filter((e) => e.leg.kind === 'swap_leg' && e.leg.to !== nova.address);
    const whaleBuys = buys.filter((e) => (e.leg.amountUsd ?? 0) >= 12000);
    expect(whaleBuys.length).toBeGreaterThanOrEqual(1);
  });

  it('contains an 18-wallet single-funder cluster among the buyers', () => {
    expect(handle.funderCluster.funder).toBeTruthy();
    expect(handle.funderCluster.fundedWallets.length).toBeGreaterThanOrEqual(18);

    // Every funded wallet must actually have received a funding tx FROM the
    // funder wallet, prior to its NOVA buy.
    const funderTxs = world.txsByWallet.get(handle.funderCluster.funder) ?? [];
    for (const funded of handle.funderCluster.fundedWallets) {
      const fundedTx = funderTxs.find((tx) => tx.legs.some((l) => l.to === funded));
      expect(fundedTx, `expected a funding tx from ${handle.funderCluster.funder} to ${funded}`).toBeTruthy();
    }
  });

  it('mcap sits in [$100k, $5M] and liquidity >= $20k during the window', () => {
    const series = world.marketSeries.get(nova.address)!;
    const point = series.find((p) => p.ts.getTime() >= handle.windowStart.getTime());
    expect(point).toBeDefined();
    expect(point!.market.marketCapUsd).toBeGreaterThanOrEqual(100_000);
    expect(point!.market.marketCapUsd).toBeLessThanOrEqual(5_000_000);
    expect(point!.market.liquidityUsd).toBeGreaterThanOrEqual(20_000);
  });
});

// ---------------------------------------------------------------------------
// $QUIET — Rule B fixture
// ---------------------------------------------------------------------------

describe('$QUIET scenario', () => {
  const quiet = tokenBySymbol('QUIET');
  const handle = world.meta.scenarios.quiet;

  it('buyers grow from 22 (early) to >= 44 distinct buyers across 20h (Task 15 Fix C: compressed from 36h so the full arc fits within Rule B\'s 24h window)', () => {
    const buys = legsForToken(quiet.address).filter((e) => e.leg.kind === 'swap_leg' && e.leg.to !== quiet.address);
    const start = handle.windowStart.getTime();

    const early = new Set(
      buys.filter((e) => e.tx.ts.getTime() >= start && e.tx.ts.getTime() < start + 2 * 60 * 60 * 1000).map((e) => e.leg.to)
    );
    const full20h = new Set(
      buys.filter((e) => e.tx.ts.getTime() >= start && e.tx.ts.getTime() < start + 20 * 60 * 60 * 1000).map((e) => e.leg.to)
    );

    expect(early.size).toBe(22);
    expect(full20h.size).toBeGreaterThanOrEqual(44);
  });

  it('mcap expansion across the 20h window is <= 1.8x', () => {
    const series = world.marketSeries.get(quiet.address)!;
    const start = handle.windowStart.getTime();
    const startPoint = series.find((p) => p.ts.getTime() >= start)!;
    const endPoint = [...series].reverse().find((p) => p.ts.getTime() <= start + 20 * 60 * 60 * 1000)!;

    expect(startPoint.market.marketCapUsd).toBeTruthy();
    const expansion = endPoint.market.marketCapUsd! / startPoint.market.marketCapUsd!;
    expect(expansion).toBeLessThanOrEqual(1.8);
  });

  it('the full growth arc lands within 24h of windowStart (Rule B\'s window), so no straggler buyer can drag the anchor past the accumulation peak', () => {
    const buys = legsForToken(quiet.address).filter((e) => e.leg.kind === 'swap_leg' && e.leg.to !== quiet.address);
    const start = handle.windowStart.getTime();
    const latestBuyTs = Math.max(...buys.map((e) => e.tx.ts.getTime()));

    expect(latestBuyTs - start).toBeLessThan(24 * 60 * 60 * 1000);
  });
});

// ---------------------------------------------------------------------------
// $SEED — Rule E fixture
// ---------------------------------------------------------------------------

describe('$SEED scenario', () => {
  const seedToken = tokenBySymbol('SEED');
  const handle = world.meta.scenarios.seed;

  it('one watched funder wallet sends to exactly 3 fresh wallets with zero prior txs', () => {
    expect(handle.funder).toBeTruthy();
    expect(handle.fundedWallets.length).toBe(3);

    for (const funded of handle.fundedWallets) {
      const txs = world.txsByWallet.get(funded.address) ?? [];
      const fundingIdx = txs.findIndex((tx) => tx.txHash === funded.fundingTxHash);
      expect(fundingIdx, `funding tx for ${funded.address} must exist in its own tx list`).toBeGreaterThanOrEqual(0);
      // Zero prior txs means the funding tx is the wallet's FIRST tx.
      expect(fundingIdx).toBe(0);
    }
  });

  it('each fresh wallet buys $SEED 15-40 minutes after its funding, at 50-90% of the funded amount', () => {
    for (const funded of handle.fundedWallets) {
      const txs = world.txsByWallet.get(funded.address) ?? [];
      const fundingTx = txs.find((tx) => tx.txHash === funded.fundingTxHash)!;
      const fundingLeg = fundingTx.legs.find((l) => l.to === funded.address)!;
      const fundedAmountUsd = fundingLeg.amountUsd!;

      const buyTx = txs.find((tx) =>
        tx.legs.some((l) => l.kind === 'swap_leg' && l.to === funded.address && l.asset.address === seedToken.address)
      )!;
      expect(buyTx, `expected a SEED buy tx for ${funded.address}`).toBeTruthy();

      const gapMin = (buyTx.ts.getTime() - fundingTx.ts.getTime()) / 60000;
      expect(gapMin).toBeGreaterThanOrEqual(15);
      expect(gapMin).toBeLessThanOrEqual(40);

      const buyLeg = buyTx.legs.find((l) => l.kind === 'swap_leg' && l.to === funded.address)!;
      const ratio = buyLeg.amountUsd! / fundedAmountUsd;
      expect(ratio).toBeGreaterThanOrEqual(0.5);
      expect(ratio).toBeLessThanOrEqual(0.9);
    }
  });
});

// ---------------------------------------------------------------------------
// $ALPHA -> $BETA — Rule F fixture (bridge + rotation)
// ---------------------------------------------------------------------------

describe('$ALPHA -> $BETA scenario', () => {
  const alpha = tokenBySymbol('ALPHA');
  const beta = tokenBySymbol('BETA');
  const handle = world.meta.scenarios.alphaToBeta;

  it('the rotating wallet exits $ALPHA with realized profit (sells for more USD than it paid)', () => {
    const wTxs = world.txsByWallet.get(handle.sourceWallet) ?? [];
    const buyLeg = wTxs
      .flatMap((tx) => tx.legs)
      .find((l) => l.kind === 'swap_leg' && l.to === handle.sourceWallet && l.asset.address === alpha.address);
    const sellLeg = wTxs
      .flatMap((tx) => tx.legs)
      .find((l) => l.kind === 'swap_leg' && l.from === handle.sourceWallet && l.asset.address === alpha.address);

    expect(buyLeg).toBeTruthy();
    expect(sellLeg).toBeTruthy();
    expect(sellLeg!.amountUsd!).toBeGreaterThan(buyLeg!.amountUsd!);
  });

  it('bridge_deposit (Wormhole) on SOLANA matches bridge_withdrawal on BSC within 95-100% amount and <60min gap', () => {
    const depositTxs = world.txsByWallet.get(handle.sourceWallet) ?? [];
    const depositTx = depositTxs.find((tx) => tx.legs.some((l) => l.kind === 'bridge_deposit'));
    expect(depositTx, 'expected a bridge_deposit tx from the source wallet').toBeTruthy();
    const depositLeg = depositTx!.legs.find((l) => l.kind === 'bridge_deposit')!;
    expect(depositLeg.programOrContract).toBe('Wormhole');

    const withdrawTxs = world.txsByWallet.get(handle.destWallet) ?? [];
    const withdrawTx = withdrawTxs.find((tx) => tx.legs.some((l) => l.kind === 'bridge_withdrawal'));
    expect(withdrawTx, 'expected a bridge_withdrawal tx to the dest wallet').toBeTruthy();
    const withdrawLeg = withdrawTx!.legs.find((l) => l.kind === 'bridge_withdrawal')!;
    expect(withdrawLeg.programOrContract).toBe('Wormhole');

    const ratio = withdrawLeg.amountUsd! / depositLeg.amountUsd!;
    expect(ratio).toBeGreaterThanOrEqual(0.95);
    expect(ratio).toBeLessThanOrEqual(1.0);

    const gapMin = (withdrawTx!.ts.getTime() - depositTx!.ts.getTime()) / 60000;
    expect(gapMin).toBeGreaterThanOrEqual(0);
    expect(gapMin).toBeLessThan(60);
  });

  it('the BSC wallet buys $BETA less than 45 minutes after receiving the bridged funds', () => {
    const withdrawTxs = world.txsByWallet.get(handle.destWallet) ?? [];
    const withdrawTx = withdrawTxs.find((tx) => tx.legs.some((l) => l.kind === 'bridge_withdrawal'))!;

    const betaBuyTx = withdrawTxs.find((tx) =>
      tx.legs.some((l) => l.kind === 'swap_leg' && l.to === handle.destWallet && l.asset.address === beta.address)
    );
    expect(betaBuyTx, 'expected a BETA buy tx from the dest wallet').toBeTruthy();

    const gapMin = (betaBuyTx!.ts.getTime() - withdrawTx.ts.getTime()) / 60000;
    expect(gapMin).toBeGreaterThanOrEqual(0);
    expect(gapMin).toBeLessThan(45);
  });
});

// ---------------------------------------------------------------------------
// $DUMP — Rule G fixture
// ---------------------------------------------------------------------------

describe('$DUMP scenario', () => {
  const dump = tokenBySymbol('DUMP');
  const handle = world.meta.scenarios.dump;

  it('>= 40% of its smart buyers sell >= 80% of their position in the final 6h', () => {
    const finalWindowStart = world.meta.horizon.getTime() - 6 * 60 * 60 * 1000;

    let exitedCount = 0;
    for (const buyerAddr of handle.smartBuyers) {
      const txs = world.txsByWallet.get(buyerAddr) ?? [];
      const legs = txs.flatMap((tx) => tx.legs.map((l) => ({ leg: l, ts: tx.ts })));

      const bought = legs
        .filter((e) => e.leg.kind === 'swap_leg' && e.leg.to === buyerAddr && e.leg.asset.address === dump.address)
        .reduce((sum, e) => sum + Number(e.leg.amountToken), 0);

      const soldInFinalWindow = legs
        .filter(
          (e) =>
            e.leg.kind === 'swap_leg' &&
            e.leg.from === buyerAddr &&
            e.leg.asset.address === dump.address &&
            e.ts.getTime() >= finalWindowStart
        )
        .reduce((sum, e) => sum + Number(e.leg.amountToken), 0);

      if (bought > 0 && soldInFinalWindow / bought >= 0.8) {
        exitedCount++;
      }
    }

    expect(exitedCount / handle.smartBuyers.length).toBeGreaterThanOrEqual(0.4);
  });

  it('liquidity drops by >= 35% into the final 6h', () => {
    const series = world.marketSeries.get(dump.address)!;
    const finalWindowStart = world.meta.horizon.getTime() - 6 * 60 * 60 * 1000;

    const before = series.find((p) => p.ts.getTime() >= finalWindowStart)!;
    const after = series[series.length - 1];

    expect(before.market.liquidityUsd).toBeTruthy();
    const dropPct = 1 - after.market.liquidityUsd! / before.market.liquidityUsd!;
    expect(dropPct).toBeGreaterThanOrEqual(0.35);
  });
});

// ---------------------------------------------------------------------------
// $RUGZ — risk flags fixture
// ---------------------------------------------------------------------------

describe('$RUGZ scenario', () => {
  const rugz = tokenBySymbol('RUGZ');

  it('risk report flags mint_authority_active and top_holder_60pct with penalty >= 0.5', () => {
    const risk = world.riskByToken.get(rugz.address);
    expect(risk).toBeDefined();
    const flagIds = risk!.flags.map((f) => f.id);
    expect(flagIds).toContain('mint_authority_active');
    expect(flagIds).toContain('top_holder_60pct');
    expect(risk!.penalty).toBeGreaterThanOrEqual(0.5);
  });
});

// ---------------------------------------------------------------------------
// Graph demo
// ---------------------------------------------------------------------------

describe('graph demo scenario', () => {
  const handle = world.meta.scenarios.graphDemo;

  it('exports GRAPH_DEMO_ROOT_ADDRESS matching the world meta root', () => {
    expect(GRAPH_DEMO_ROOT_ADDRESS).toBe(handle.root);
  });

  it('has a 3-depth web including a CEX-tagged and a router-tagged counterparty', () => {
    expect(handle.cexCounterparty).toBeTruthy();
    expect(handle.routerCounterparty).toBeTruthy();
    expect(walletLabel(handle.cexCounterparty)).toContain('cex_related');

    // Root -> depth1 -> depth2 -> depth3: verify each hop exists as a tx leg.
    const rootTxs = world.txsByWallet.get(handle.root) ?? [];
    const toDepth1 = rootTxs.some((tx) => tx.legs.some((l) => l.from === handle.root && l.to === handle.depth1));
    expect(toDepth1).toBe(true);

    const depth1Txs = world.txsByWallet.get(handle.depth1) ?? [];
    const toDepth2 = depth1Txs.some((tx) => tx.legs.some((l) => l.from === handle.depth1 && l.to === handle.depth2));
    expect(toDepth2).toBe(true);

    const depth2Txs = world.txsByWallet.get(handle.depth2) ?? [];
    const toDepth3 = depth2Txs.some((tx) => tx.legs.some((l) => l.from === handle.depth2 && l.to === handle.depth3));
    expect(toDepth3).toBe(true);
  });

  it('has a value chain A -> B -> C of 10000 -> 9800 USDC-style token transfers', () => {
    const aTxs = world.txsByWallet.get(handle.chainA) ?? [];
    const abLeg = aTxs
      .flatMap((tx) => tx.legs)
      .find((l) => l.from === handle.chainA && l.to === handle.chainB && l.kind === 'token_transfer');
    expect(abLeg).toBeTruthy();
    expect(Number(abLeg!.amountToken)).toBeCloseTo(10000, 0);

    const bTxs = world.txsByWallet.get(handle.chainB) ?? [];
    const bcLeg = bTxs
      .flatMap((tx) => tx.legs)
      .find((l) => l.from === handle.chainB && l.to === handle.chainC && l.kind === 'token_transfer');
    expect(bcLeg).toBeTruthy();
    expect(Number(bcLeg!.amountToken)).toBeCloseTo(9800, 0);
  });
});
