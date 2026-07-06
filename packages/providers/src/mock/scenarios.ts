// FlowRadar — scripted mock-world scenarios (Task 4 brief invariants table).
//
// Each scenario function creates its own dedicated wallets/token/txs/market
// series/risk report directly on the shared WorldBuilder, then contributes a
// handle (addresses/token addresses/timestamps) to the returned
// ScenarioHandles so tests and later tasks (rules, seed script) can reference
// scripted content programmatically instead of re-deriving magic numbers.
//
// All timing/amount constants below are chosen to comfortably clear the
// invariants in docs/superpowers/... task-4-brief.md with margin (e.g. NOVA
// uses 40 buyers/87.5% smart-labeled against a ">=35 buyers/>=70%" bar) so
// the world stays robust to small implementation-detail changes elsewhere.

import type { Chain, NormalizedTx, RiskReport, WalletLabel } from '@flowradar/core';
import type { Rng } from './prng';
import { mixSeed, mulberry32, rngFloat, rngInt } from './prng';
import { fakeBscAddress, fakeSolanaAddress } from './address';
import { generateBaselineMarketSeries, makeSimpleTx, HOUR_MS, MIN_MS } from './world';
import type { MockToken, MockWallet, WorldBuilder } from './world';

// ---------------------------------------------------------------------------
// Public handles
// ---------------------------------------------------------------------------

export interface NovaHandle {
  tokenAddress: string;
  windowStart: Date;
  buyers: string[];
  whaleBuyer: string;
  funderCluster: { funder: string; fundedWallets: string[] };
}

export interface QuietHandle {
  tokenAddress: string;
  windowStart: Date;
}

export interface SeedHandle {
  tokenAddress: string;
  funder: string;
  fundedWallets: { address: string; fundingTxHash: string }[];
}

export interface AlphaToBetaHandle {
  alphaTokenAddress: string;
  betaTokenAddress: string;
  sourceWallet: string;
  destWallet: string;
}

export interface DumpHandle {
  tokenAddress: string;
  smartBuyers: string[];
}

export interface RugzHandle {
  tokenAddress: string;
}

export interface GraphDemoHandle {
  root: string;
  depth1: string;
  depth2: string;
  depth3: string;
  cexCounterparty: string;
  routerCounterparty: string;
  chainA: string;
  chainB: string;
  chainC: string;
}

export interface ScenarioHandles {
  nova: NovaHandle;
  quiet: QuietHandle;
  seed: SeedHandle;
  alphaToBeta: AlphaToBetaHandle;
  dump: DumpHandle;
  rugz: RugzHandle;
  graphDemo: GraphDemoHandle;
}

/** Stable root address for the graph-demo scenario, independent of world seed/genesis (a fixed demo fixture). */
export const GRAPH_DEMO_ROOT_ADDRESS = 'FLOWDEEMOroot11111111111111111111111111111';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function makeWallet(
  builder: WorldBuilder,
  chain: Chain,
  rng: Rng,
  labels: WalletLabel[],
  walletScore: number,
  idHint: string
): MockWallet {
  const address = chain === 'SOLANA' ? fakeSolanaAddress(rng) : fakeBscAddress(rng);
  const wallet: MockWallet = {
    id: `wallet-${idHint}`,
    chain,
    address,
    labels,
    walletScore,
    fresh: true,
    firstTxTs: null
  };
  builder.wallets.set(address, wallet);
  return wallet;
}

function makeToken(
  builder: WorldBuilder,
  chain: Chain,
  rng: Rng,
  symbol: string,
  name: string,
  createdAt: Date
): MockToken {
  const address = chain === 'SOLANA' ? fakeSolanaAddress(rng) : fakeBscAddress(rng);
  const token: MockToken = {
    id: `token-${symbol.toLowerCase()}`,
    chain,
    address,
    symbol,
    name,
    decimals: 9,
    createdAt
  };
  builder.tokens.set(address, token);
  return token;
}

/** A swap_leg tx recorded as a "buy" for `buyer` (token flows buyer <- pool/token address). */
function makeBuy(
  builder: WorldBuilder,
  token: MockToken,
  buyer: string,
  ts: Date,
  amountUsd: number,
  priceUsd: number
): NormalizedTx {
  const amountToken = amountUsd / priceUsd;
  return makeSimpleTx(builder, {
    chain: token.chain,
    ts,
    kind: 'swap_leg',
    from: token.address,
    to: buyer,
    asset: { address: token.address, symbol: token.symbol, decimals: token.decimals },
    amountToken: amountToken.toFixed(4),
    amountUsd
  });
}

/** A swap_leg tx recorded as a "sell" for `seller` (token flows seller -> pool/token address). */
function makeSell(
  builder: WorldBuilder,
  token: MockToken,
  seller: string,
  ts: Date,
  amountToken: number,
  priceUsd: number
): NormalizedTx {
  return makeSimpleTx(builder, {
    chain: token.chain,
    ts,
    kind: 'swap_leg',
    from: seller,
    to: token.address,
    asset: { address: token.address, symbol: token.symbol, decimals: token.decimals },
    amountToken: amountToken.toFixed(4),
    amountUsd: amountToken * priceUsd
  });
}

/** A native/token transfer funding tx from `funder` to `recipient`. */
function makeFundingTx(
  builder: WorldBuilder,
  chain: Chain,
  funder: string,
  recipient: string,
  ts: Date,
  amountUsd: number
): NormalizedTx {
  const priceUsd = chain === 'SOLANA' ? 150 : 600; // rough SOL/BNB price for token-amount cosmetics only
  const amountToken = amountUsd / priceUsd;
  return makeSimpleTx(builder, {
    chain,
    ts,
    kind: 'native_transfer',
    from: funder,
    to: recipient,
    asset: { symbol: chain === 'SOLANA' ? 'SOL' : 'BNB', decimals: 9 },
    amountToken: amountToken.toFixed(6),
    amountUsd
  });
}

// ---------------------------------------------------------------------------
// $NOVA — Rule A/C/D fixture
// ---------------------------------------------------------------------------

function buildNova(builder: WorldBuilder, rng: Rng): NovaHandle {
  const createdAt = new Date(builder.genesis.getTime() - 2 * 24 * HOUR_MS); // age < 7d
  const token = makeToken(builder, 'SOLANA', rng, 'NOVA', 'Nova', createdAt);

  // Window: day-2 start (24h after genesis) through +25min.
  const windowStart = new Date(builder.genesis.getTime() + 24 * HOUR_MS);
  const priceUsd = 0.02;

  // 40 buyers total; 35 smart_money/human_like (87.5% >= 70% bar), 5 other
  // labels so the ratio isn't a trivial 100%. Spread evenly across 25 min.
  const buyers: string[] = [];
  const smartLabelPool: WalletLabel[] = ['smart_money', 'human_like'];
  for (let i = 0; i < 40; i++) {
    const isSmart = i < 35;
    const labels: WalletLabel[] = isSmart ? [smartLabelPool[i % 2]!] : ['possible_bot'];
    const wallet = makeWallet(builder, 'SOLANA', rng, labels, isSmart ? 70 + Math.floor(rng() * 25) : 20, `nova-buyer-${i}`);
    buyers.push(wallet.address);

    const offsetMin = (25 * i) / 40; // evenly spread across [0, 25) minutes
    const ts = new Date(windowStart.getTime() + offsetMin * MIN_MS);
    const amountUsd = 500 + rng() * 2000;
    makeBuy(builder, token, wallet.address, ts, amountUsd, priceUsd);
  }

  // Exactly one whale buy >= $12k, inside the same window.
  const whale = makeWallet(builder, 'SOLANA', rng, ['whale', 'smart_money'], 90, 'nova-whale');
  const whaleTs = new Date(windowStart.getTime() + 12 * MIN_MS);
  makeBuy(builder, token, whale.address, whaleTs, 12_500, priceUsd);
  buyers.push(whale.address);

  // 18-wallet single-funder cluster: one funder wallet sends each of 18 of
  // the 35 smart buyers a small pre-buy funding tx (shortly before their
  // NOVA buy), establishing the "single-funder cluster" among NOVA buyers.
  const funder = makeWallet(builder, 'SOLANA', rng, ['smart_money'], 80, 'nova-funder');
  const fundedWallets = buyers.slice(0, 18);
  for (const funded of fundedWallets) {
    const fundedBuyTx = (builder.txsByWallet.get(funded) ?? []).find((tx) =>
      tx.legs.some((l) => l.to === funded && l.asset.address === token.address)
    )!;
    const fundingTs = new Date(fundedBuyTx.ts.getTime() - 3 * MIN_MS);
    makeFundingTx(builder, 'SOLANA', funder.address, funded, fundingTs, 50 + rng() * 100);
  }

  // Market series: mcap $300k (in [$100k,$5M]), liquidity $25k (>= $20k),
  // held roughly flat across the scenario window, otherwise the usual
  // baseline drift for the rest of the 72h so the token still has a full
  // hourly series for chart rendering.
  generateBaselineMarketSeries(builder, rng, token, { basePrice: priceUsd, baseMcap: 300_000, baseLiquidity: 25_000 });

  return {
    tokenAddress: token.address,
    windowStart,
    buyers,
    whaleBuyer: whale.address,
    funderCluster: { funder: funder.address, fundedWallets }
  };
}

// ---------------------------------------------------------------------------
// $QUIET — Rule B fixture
// ---------------------------------------------------------------------------

function buildQuiet(builder: WorldBuilder, rng: Rng): QuietHandle {
  const createdAt = new Date(builder.genesis.getTime() - 10 * 24 * HOUR_MS);
  const token = makeToken(builder, 'SOLANA', rng, 'QUIET', 'Quiet Accumulation', createdAt);

  const windowStart = new Date(builder.genesis.getTime() + 40 * HOUR_MS); // clear of NOVA's window
  const priceUsd = 0.05;

  // 22 distinct buyers within the first 2h.
  const earlyBuyers: string[] = [];
  for (let i = 0; i < 22; i++) {
    const wallet = makeWallet(builder, 'SOLANA', rng, ['human_like'], 60 + Math.floor(rng() * 20), `quiet-early-${i}`);
    earlyBuyers.push(wallet.address);
    const ts = new Date(windowStart.getTime() + rngFloat(rng, 0, 2 * 60) * MIN_MS);
    makeBuy(builder, token, wallet.address, ts, 300 + rng() * 700, priceUsd);
  }

  // 24 additional distinct buyers trickling in over hours 2..20 (Task 15
  // Fix C: compressed from the original (2h, 36h) spread), bringing the 20h
  // cumulative distinct-buyer count to 46 (>= 44 required) — WITHIN a single
  // 24h lookback. The original 36h-wide arc exceeded Rule B's 24h window:
  // aggregateWindow anchors `to` at this token's own LATEST trade, so a
  // handful of long-tail stragglers landing near the 36h ceiling dragged the
  // anchor 11h past the point where the buyer count had already cleared
  // both of Rule B's floors, leaving only 14 of 46 buyers inside the 24h
  // window actually evaluated (see task-15-report.md's investigated root
  // cause). Compressing the full arc to <= 20h means ANY anchor drawn from
  // this scenario's own trades sits within 20h of `windowStart`, so a 24h
  // lookback (from = anchor - 24h) always reaches back far enough to
  // capture the complete 46-buyer set with 4h of margin to spare.
  for (let i = 0; i < 24; i++) {
    const wallet = makeWallet(builder, 'SOLANA', rng, ['human_like'], 55 + Math.floor(rng() * 20), `quiet-late-${i}`);
    const hourOffset = 2 + rngFloat(rng, 0, 18); // spread across (2h, 20h)
    const ts = new Date(windowStart.getTime() + hourOffset * HOUR_MS);
    makeBuy(builder, token, wallet.address, ts, 300 + rng() * 700, priceUsd);
  }

  // Mcap expansion across the (compressed) 20h window: 200k -> 300k = 1.5x
  // (<= 1.8x maxMcapExpansion, unchanged invariant — only the timespan it's
  // measured over shrank, matching the buyer-growth arc's own compression).
  const startMcap = 200_000;
  const endMcap = 300_000;
  const points = generateBaselineMarketSeries(builder, rng, token, {
    basePrice: priceUsd,
    baseMcap: startMcap,
    baseLiquidity: 30_000
  });
  // Overwrite the scenario-relevant hours with a clean linear ramp so the
  // expansion assertion isn't at the mercy of the baseline's random drift.
  const startHourIdx = Math.floor((windowStart.getTime() - builder.genesis.getTime()) / HOUR_MS);
  const QUIET_ARC_HOURS = 20;
  for (let h = 0; h <= QUIET_ARC_HOURS && startHourIdx + h < points.length; h++) {
    const frac = h / QUIET_ARC_HOURS;
    const mcap = startMcap + (endMcap - startMcap) * frac;
    const point = points[startHourIdx + h]!;
    point.market.marketCapUsd = mcap;
    point.market.fdvUsd = mcap;
    point.market.liquidityUsd = 30_000;
  }

  return { tokenAddress: token.address, windowStart };
}

// ---------------------------------------------------------------------------
// $SEED — Rule E fixture
// ---------------------------------------------------------------------------

function buildSeed(builder: WorldBuilder, rng: Rng): SeedHandle {
  const createdAt = new Date(builder.genesis.getTime() - 1 * HOUR_MS);
  const token = makeToken(builder, 'SOLANA', rng, 'SEED', 'Seed Fund', createdAt);

  const funder = makeWallet(builder, 'SOLANA', rng, ['smart_money'], 85, 'seed-funder');
  const priceUsd = 0.001;
  const windowStart = new Date(builder.genesis.getTime() + 6 * HOUR_MS);

  const ratios = [0.55, 0.7, 0.85]; // all within [0.5, 0.9]
  const gapsMin = [18, 25, 35]; // all within [15, 40]

  const fundedWallets: { address: string; fundingTxHash: string }[] = [];
  for (let i = 0; i < 3; i++) {
    const fresh = makeWallet(builder, 'SOLANA', rng, ['unknown'], 30, `seed-fresh-${i}`);
    const fundingTs = new Date(windowStart.getTime() + i * 10 * MIN_MS);
    const fundedAmountUsd = 1000 + rng() * 500;
    const fundingTx = makeFundingTx(builder, 'SOLANA', funder.address, fresh.address, fundingTs, fundedAmountUsd);

    const buyTs = new Date(fundingTs.getTime() + gapsMin[i]! * MIN_MS);
    const buyAmountUsd = fundedAmountUsd * ratios[i]!;
    makeBuy(builder, token, fresh.address, buyTs, buyAmountUsd, priceUsd);

    fundedWallets.push({ address: fresh.address, fundingTxHash: fundingTx.txHash });
  }

  generateBaselineMarketSeries(builder, rng, token, { basePrice: priceUsd, baseMcap: 150_000, baseLiquidity: 22_000 });

  return { tokenAddress: token.address, funder: funder.address, fundedWallets };
}

// ---------------------------------------------------------------------------
// $ALPHA -> $BETA — Rule F fixture (bridge + rotation)
// ---------------------------------------------------------------------------

function buildAlphaToBeta(builder: WorldBuilder, rng: Rng): AlphaToBetaHandle {
  const alphaCreatedAt = new Date(builder.genesis.getTime() - 5 * 24 * HOUR_MS);
  const alpha = makeToken(builder, 'SOLANA', rng, 'ALPHA', 'Alpha Run', alphaCreatedAt);
  const betaCreatedAt = new Date(builder.genesis.getTime() - 1 * HOUR_MS);
  const beta = makeToken(builder, 'BSC', rng, 'BETA', 'Beta Landing', betaCreatedAt);

  const sourceWallet = makeWallet(builder, 'SOLANA', rng, ['smart_money'], 82, 'alpha-source');
  const destWallet = makeWallet(builder, 'BSC', rng, ['bridge_related'], 75, 'beta-dest');

  const rotationStart = new Date(builder.genesis.getTime() + 48 * HOUR_MS);

  // Buy ALPHA cheap, sell higher (realized profit).
  const buyTs = new Date(rotationStart.getTime());
  makeBuy(builder, alpha, sourceWallet.address, buyTs, 2000, 0.01); // 200,000 ALPHA @ $0.01

  const sellTs = new Date(rotationStart.getTime() + 6 * HOUR_MS);
  const sellPriceUsd = 0.025; // 2.5x — clears "exits with profit"
  makeSell(builder, alpha, sourceWallet.address, sellTs, 200_000, sellPriceUsd); // $5,000 realized vs $2,000 spent

  // Bridge deposit (Wormhole) SOL side.
  const depositTs = new Date(sellTs.getTime() + 10 * MIN_MS);
  const depositUsd = 4800; // most of the $5,000 realized proceeds
  makeSimpleTx(builder, {
    chain: 'SOLANA',
    ts: depositTs,
    kind: 'bridge_deposit',
    from: sourceWallet.address,
    to: 'wormhole-bridge-program',
    asset: { symbol: 'USDC', decimals: 6 },
    amountToken: depositUsd.toFixed(2),
    amountUsd: depositUsd,
    programOrContract: 'Wormhole'
  });

  // Bridge withdrawal BSC side: 97% of deposit (within [95%,100%]), 25 min gap (<60min).
  const withdrawTs = new Date(depositTs.getTime() + 25 * MIN_MS);
  const withdrawUsd = depositUsd * 0.97;
  makeSimpleTx(builder, {
    chain: 'BSC',
    ts: withdrawTs,
    kind: 'bridge_withdrawal',
    from: 'wormhole-bridge-program',
    to: destWallet.address,
    asset: { symbol: 'USDC', decimals: 18 },
    amountToken: withdrawUsd.toFixed(2),
    amountUsd: withdrawUsd,
    programOrContract: 'Wormhole'
  });

  // BSC wallet buys BETA 30 min after receiving the bridged funds (<45min).
  const betaBuyTs = new Date(withdrawTs.getTime() + 30 * MIN_MS);
  makeBuy(builder, beta, destWallet.address, betaBuyTs, withdrawUsd * 0.9, 0.002);

  generateBaselineMarketSeries(builder, rng, alpha, { basePrice: 0.015, baseMcap: 600_000, baseLiquidity: 40_000 });
  generateBaselineMarketSeries(builder, rng, beta, { basePrice: 0.002, baseMcap: 180_000, baseLiquidity: 25_000 });

  return {
    alphaTokenAddress: alpha.address,
    betaTokenAddress: beta.address,
    sourceWallet: sourceWallet.address,
    destWallet: destWallet.address
  };
}

// ---------------------------------------------------------------------------
// $DUMP — Rule G fixture
// ---------------------------------------------------------------------------

function buildDump(builder: WorldBuilder, rng: Rng): DumpHandle {
  const createdAt = new Date(builder.genesis.getTime() - 3 * 24 * HOUR_MS);
  const token = makeToken(builder, 'SOLANA', rng, 'DUMP', 'Dump Zone', createdAt);
  const priceUsd = 0.03;

  const accumulationTs = new Date(builder.genesis.getTime() + 4 * HOUR_MS);
  const smartBuyers: string[] = [];
  const boughtAmountToken = 10_000;

  for (let i = 0; i < 20; i++) {
    const wallet = makeWallet(builder, 'SOLANA', rng, ['smart_money'], 75, `dump-buyer-${i}`);
    smartBuyers.push(wallet.address);
    const ts = new Date(accumulationTs.getTime() + i * 20 * MIN_MS);
    makeBuy(builder, token, wallet.address, ts, boughtAmountToken * priceUsd, priceUsd);
  }

  // Final 6h of the 72h horizon: >= 40% (8 of 20) sell >= 80% of their position.
  //
  // Task 15 Fix B follow-up: the exit ratio Rule G / aggregateWindow measure
  // is on a USD basis (agg.exitedSmartPct = in-window sellUsd / pre-window
  // buyUsd), NOT a token-quantity basis. The original priceUsd * 0.6 dump
  // discount meant 85% of the TOKEN quantity sold recovered only 85% * 60%
  // = 51% of the buy's USD value — comfortably clearing the token-quantity
  // invariant packages/providers/test/scenarios.test.ts checks (amountToken
  // basis) but failing the USD-basis floor the aggregate/Rule G actually
  // evaluate. Reduced the discount to 5% (priceUsd * 0.95) and raised the
  // sold fraction to 90% of token quantity: 90% * 95% = 85.5% USD recovery,
  // ~5.5 points of margin over the 80% floor, while the token-quantity
  // invariant (>= 80% of position, by amountToken) still clears at 90%.
  const finalWindowStart = new Date(builder.horizon.getTime() - 6 * HOUR_MS);
  const exitCount = Math.ceil(20 * 0.5); // 10 of 20 = 50% > 40% bar, comfortable margin
  for (let i = 0; i < exitCount; i++) {
    const seller = smartBuyers[i]!;
    const ts = new Date(finalWindowStart.getTime() + i * 15 * MIN_MS);
    const sellAmount = boughtAmountToken * 0.9; // 90% > 80% bar (token-quantity basis)
    makeSell(builder, token, seller, ts, sellAmount, priceUsd * 0.95); // modest dump discount; 90%*95% = 85.5% USD recovery, clears the 80% USD-basis floor Rule G/aggregateWindow evaluate
  }

  // Liquidity drop >= 35% into the final 6h.
  const points = generateBaselineMarketSeries(builder, rng, token, {
    basePrice: priceUsd,
    baseMcap: 400_000,
    baseLiquidity: 50_000
  });
  const finalStartIdx = Math.floor((finalWindowStart.getTime() - builder.genesis.getTime()) / HOUR_MS);
  for (let idx = finalStartIdx; idx < points.length; idx++) {
    const point = points[idx]!;
    const frac = (idx - finalStartIdx) / Math.max(1, points.length - 1 - finalStartIdx);
    point.market.liquidityUsd = 50_000 * (1 - 0.5 * frac); // ramps down to 25,000 = -50% (>= -35%)
  }

  return { tokenAddress: token.address, smartBuyers };
}

// ---------------------------------------------------------------------------
// $RUGZ — risk flags fixture
// ---------------------------------------------------------------------------

function buildRugz(builder: WorldBuilder, rng: Rng): RugzHandle {
  const createdAt = new Date(builder.genesis.getTime() - 6 * HOUR_MS);
  const token = makeToken(builder, 'SOLANA', rng, 'RUGZ', 'Rugz Inc', createdAt);

  generateNoiseTradesForRugz(builder, rng, token);
  generateBaselineMarketSeries(builder, rng, token, { basePrice: 0.0005, baseMcap: 80_000, baseLiquidity: 8_000 });

  const risk: RiskReport = {
    flags: [
      { id: 'mint_authority_active', label: 'Mint authority is still active', severity: 'danger' },
      { id: 'top_holder_60pct', label: 'Top holder controls 60% of supply', severity: 'danger' }
    ],
    penalty: 0.65
  };
  builder.riskByToken.set(token.address, risk);

  return { tokenAddress: token.address };
}

function generateNoiseTradesForRugz(builder: WorldBuilder, rng: Rng, token: MockToken): void {
  // A few small trades so RUGZ isn't a total ghost token on the token-detail page.
  for (let i = 0; i < 8; i++) {
    const wallet = makeWallet(builder, 'SOLANA', rng, ['unknown'], 25, `rugz-trader-${i}`);
    const ts = new Date(builder.genesis.getTime() + rngInt(rng, 0, 71) * HOUR_MS);
    makeBuy(builder, token, wallet.address, ts, 50 + rng() * 200, 0.0005);
  }
}

// ---------------------------------------------------------------------------
// Graph demo
// ---------------------------------------------------------------------------

function buildGraphDemo(builder: WorldBuilder, rng: Rng): GraphDemoHandle {
  const root: MockWallet = {
    id: 'wallet-graph-demo-root',
    chain: 'SOLANA',
    address: GRAPH_DEMO_ROOT_ADDRESS,
    labels: ['unknown'],
    walletScore: 50,
    fresh: true,
    firstTxTs: null
  };
  builder.wallets.set(root.address, root);

  const depth1 = makeWallet(builder, 'SOLANA', rng, ['unknown'], 40, 'graph-demo-depth1');
  const depth2 = makeWallet(builder, 'SOLANA', rng, ['unknown'], 40, 'graph-demo-depth2');
  const depth3 = makeWallet(builder, 'SOLANA', rng, ['unknown'], 40, 'graph-demo-depth3');
  const cex = makeWallet(builder, 'SOLANA', rng, ['cex_related'], 50, 'graph-demo-cex');
  const router = makeWallet(builder, 'SOLANA', rng, ['unknown'], 30, 'graph-demo-router');

  const t0 = new Date(builder.genesis.getTime() + 10 * HOUR_MS);

  // Depth chain: root -> depth1 -> depth2 -> depth3 (each hop 1h apart).
  makeSimpleTx(builder, {
    chain: 'SOLANA',
    ts: t0,
    kind: 'native_transfer',
    from: root.address,
    to: depth1.address,
    asset: { symbol: 'SOL', decimals: 9 },
    amountToken: '50',
    amountUsd: 7500
  });
  makeSimpleTx(builder, {
    chain: 'SOLANA',
    ts: new Date(t0.getTime() + HOUR_MS),
    kind: 'native_transfer',
    from: depth1.address,
    to: depth2.address,
    asset: { symbol: 'SOL', decimals: 9 },
    amountToken: '40',
    amountUsd: 6000
  });
  makeSimpleTx(builder, {
    chain: 'SOLANA',
    ts: new Date(t0.getTime() + 2 * HOUR_MS),
    kind: 'native_transfer',
    from: depth2.address,
    to: depth3.address,
    asset: { symbol: 'SOL', decimals: 9 },
    amountToken: '30',
    amountUsd: 4500
  });

  // Root also touches a CEX-tagged wallet and a router-tagged counterparty
  // directly (depth 1 neighbors), rounding out the "3-depth web incl. 1 CEX +
  // 1 router node". Both use `token_transfer` (not `contract_interaction`):
  // ingest.ts's ingestLeg treats `contract_interaction` legs as an explicit
  // no-op (Task 5 decision — "skip, no row"), so a leg of that kind never
  // produces a MoneyFlowEdge row and would be invisible to Task 20's
  // DB-backed graph EdgeFetcher (which only reads MoneyFlowEdge rows). Using
  // `token_transfer` for the router touch (mirroring the CEX touch just
  // above it) keeps `programOrContract: 'ROUTER'` as a cosmetic tag while
  // ensuring the edge actually lands in the graph the BFS engine reads.
  makeSimpleTx(builder, {
    chain: 'SOLANA',
    ts: new Date(t0.getTime() + 30 * MIN_MS),
    kind: 'token_transfer',
    from: root.address,
    to: cex.address,
    asset: { symbol: 'SOL', decimals: 9 },
    amountToken: '10',
    amountUsd: 1500,
    programOrContract: 'CEX'
  });
  makeSimpleTx(builder, {
    chain: 'SOLANA',
    ts: new Date(t0.getTime() + 45 * MIN_MS),
    kind: 'token_transfer',
    from: root.address,
    to: router.address,
    asset: { symbol: 'SOL', decimals: 9 },
    amountToken: '5',
    amountUsd: 750,
    programOrContract: 'ROUTER'
  });

  // Value chain A -> B -> C: 10000 -> 9800 USDC-style token transfers. The
  // root wallet IS "A" (it already anchors the rest of the graph-demo web);
  // "B" and "C" are two more dedicated wallets one hop further out.
  const chainB = makeWallet(builder, 'SOLANA', rng, ['unknown'], 45, 'graph-demo-chain-b');
  const chainC = makeWallet(builder, 'SOLANA', rng, ['unknown'], 45, 'graph-demo-chain-c');
  const usdcMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'; // mainnet USDC mint, cosmetic only

  makeSimpleTx(builder, {
    chain: 'SOLANA',
    ts: new Date(t0.getTime() + 3 * HOUR_MS),
    kind: 'token_transfer',
    from: root.address,
    to: chainB.address,
    asset: { address: usdcMint, symbol: 'USDC', decimals: 6 },
    amountToken: '10000',
    amountUsd: 10000
  });
  makeSimpleTx(builder, {
    chain: 'SOLANA',
    ts: new Date(t0.getTime() + 4 * HOUR_MS),
    kind: 'token_transfer',
    from: chainB.address,
    to: chainC.address,
    asset: { address: usdcMint, symbol: 'USDC', decimals: 6 },
    amountToken: '9800',
    amountUsd: 9800
  });

  return {
    root: root.address,
    depth1: depth1.address,
    depth2: depth2.address,
    depth3: depth3.address,
    cexCounterparty: cex.address,
    routerCounterparty: router.address,
    chainA: root.address,
    chainB: chainB.address,
    chainC: chainC.address
  };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export function buildScenarios(builder: WorldBuilder, rng: Rng): ScenarioHandles {
  // Independent sub-seeds per scenario so each scenario's internal random
  // draws don't shift when another scenario's implementation changes (only
  // the shared top-level `rng` stream order would otherwise couple them).
  const novaRng = mulberry32(mixSeed(rngSeedFrom(rng), 11));
  const quietRng = mulberry32(mixSeed(rngSeedFrom(rng), 12));
  const seedRng = mulberry32(mixSeed(rngSeedFrom(rng), 13));
  const alphaBetaRng = mulberry32(mixSeed(rngSeedFrom(rng), 14));
  const dumpRng = mulberry32(mixSeed(rngSeedFrom(rng), 15));
  const rugzRng = mulberry32(mixSeed(rngSeedFrom(rng), 16));
  const graphRng = mulberry32(mixSeed(rngSeedFrom(rng), 17));

  const nova = buildNova(builder, novaRng);
  const quiet = buildQuiet(builder, quietRng);
  const seed = buildSeed(builder, seedRng);
  const alphaToBeta = buildAlphaToBeta(builder, alphaBetaRng);
  const dump = buildDump(builder, dumpRng);
  const rugz = buildRugz(builder, rugzRng);
  const graphDemo = buildGraphDemo(builder, graphRng);

  return { nova, quiet, seed, alphaToBeta, dump, rugz, graphDemo };
}

/** Draws a 32-bit integer from `rng` to use as a mixSeed salt input (keeps sub-seed derivation deterministic). */
function rngSeedFrom(rng: Rng): number {
  return Math.floor(rng() * 0xffffffff) >>> 0;
}
