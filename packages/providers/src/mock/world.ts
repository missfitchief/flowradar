// FlowRadar — deterministic mock world (Task 4 brief).
//
// createMockWorld(opts) builds an entire in-memory universe of wallets,
// tokens, transactions, market history, and risk reports, driven ONLY by
// (seed, genesis). No Date.now(), no Math.random() — every random draw comes
// from a mulberry32 Rng seeded from `opts.seed` (default 20260705). Same
// (seed, genesis) always produces bit-identical output; changing `seed`
// changes wallet/token/tx content (timestamps only shift with `genesis`).
//
// The world contains 7 scripted scenarios (NOVA, QUIET, SEED, ALPHA->BETA,
// DUMP, RUGZ, graph demo) layered on top of ~150 background "noise" wallets
// and ~21 noise tokens, so every rule/page has realistic surrounding data to
// distinguish signal from noise. Scenario addresses/token addresses are
// exported via `world.meta.scenarios` so tests and seed scripts can reference
// them programmatically instead of re-deriving them.

import type { Chain, NormalizedTx, RiskReport, TokenMarket, WalletLabel } from '@flowradar/core';
import { mixSeed, mulberry32 } from './prng.js';
import type { Rng } from './prng.js';
import { fakeBscAddress, fakeSolanaAddress } from './address.js';
import { buildScenarios } from './scenarios.js';
import type { ScenarioHandles } from './scenarios.js';

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

export interface MockWallet {
  id: string;
  chain: Chain;
  address: string;
  labels: WalletLabel[];
  /** Composite quality score in [0,100] used to seed WalletScore-like ordering in the mock world. */
  walletScore: number;
  /** True if this wallet has zero transactions before `firstTxTs` (used by scenario E / SEED). */
  fresh: boolean;
  /** Timestamp of this wallet's first-ever tx in the mock world, if it has any. */
  firstTxTs: Date | null;
}

export interface MockToken {
  id: string;
  chain: Chain;
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  createdAt: Date;
}

export interface MockMarketPoint {
  ts: Date;
  market: TokenMarket;
}

export interface CreateMockWorldOpts {
  /** PRNG seed. Defaults to 20260705 per the Task 4 brief. */
  seed?: number;
  /** World epoch — all scenario/noise timestamps are genesis + offset. */
  genesis: Date;
}

export interface MockWorld {
  wallets: MockWallet[];
  tokens: MockToken[];
  /** Keyed by wallet address; each wallet's txs are sorted by ts ascending. */
  txsByWallet: Map<string, NormalizedTx[]>;
  /** Keyed by token address; hourly (or finer, during scenario windows) points sorted by ts ascending. */
  marketSeries: Map<string, MockMarketPoint[]>;
  /** Keyed by token address. */
  riskByToken: Map<string, RiskReport>;
  meta: {
    seed: number;
    genesis: Date;
    /** genesis + 72h — the upper time bound of all generated content. */
    horizon: Date;
    scenarios: ScenarioHandles;
  };
}

// ---------------------------------------------------------------------------
// Internal generation constants
// ---------------------------------------------------------------------------

const HOUR_MS = 60 * 60 * 1000;
const MIN_MS = 60 * 1000;
const HORIZON_HOURS = 72;

// Noise-wallet budget is sized so that noise (30) + scenario-dedicated
// wallets (131, fixed by the scenario invariants below) lands the world
// total near the brief's "~160 wallets". Cohort counts (14/7/5) carry a
// small margin over the brief's minimums (12 possible_bot/6 sniper/4
// cex_related).
const NOISE_WALLET_COUNT = 26; // == cohorts only (14 possible_bot + 7 sniper + 5 cex_related); no extra general noise
const NOISE_BSC_WALLET_COUNT = 4;
const NOISE_TOKEN_COUNT = 21;

const WALLET_LABEL_POOL: WalletLabel[] = [
  'human_like',
  'smart_money',
  'whale',
  'copy_trader',
  'bridge_related',
  'unknown',
  'mev',
  'deployer_related'
];

// ---------------------------------------------------------------------------
// Builder context — mutable scratch state shared with scenarios.ts while the
// world is under construction. Finalized (frozen into plain arrays/Maps) by
// createMockWorld before returning.
// ---------------------------------------------------------------------------

export interface WorldBuilder {
  genesis: Date;
  horizon: Date;
  rng: Rng;
  wallets: Map<string, MockWallet>;
  tokens: Map<string, MockToken>;
  txsByWallet: Map<string, NormalizedTx[]>;
  marketSeries: Map<string, MockMarketPoint[]>;
  riskByToken: Map<string, RiskReport>;
  /** Monotonic per-chain slot/block counter so blockOrSlot ordering matches ts ordering. */
  slotCounters: Map<Chain, bigint>;
}

function nextSlot(builder: WorldBuilder, chain: Chain): bigint {
  const current = builder.slotCounters.get(chain) ?? 0n;
  const next = current + 1n;
  builder.slotCounters.set(chain, next);
  return next;
}

/** Appends `tx` to `wallet`'s tx list (keeping every leg's participants indexed under this address too). */
function recordTx(builder: WorldBuilder, tx: NormalizedTx, participantAddresses: string[]): void {
  for (const addr of new Set(participantAddresses)) {
    const list = builder.txsByWallet.get(addr) ?? [];
    list.push(tx);
    builder.txsByWallet.set(addr, list);
  }
}

/**
 * Builds and records a simple two-party tx with exactly one leg. Returns the
 * created tx. `ts` must be within [genesis, horizon] for scenario code to
 * respect the world's time bounds (not enforced here — callers control ts).
 */
export function makeSimpleTx(
  builder: WorldBuilder,
  opts: {
    chain: Chain;
    ts: Date;
    kind: NormalizedTx['legs'][number]['kind'];
    from: string;
    to: string;
    asset: { address?: string; symbol: string; decimals: number };
    amountToken: string;
    amountUsd?: number;
    programOrContract?: string;
  }
): NormalizedTx {
  const tx: NormalizedTx = {
    txHash: fakeTxHashFor(builder, opts.ts, opts.from, opts.to),
    blockOrSlot: nextSlot(builder, opts.chain),
    ts: opts.ts,
    legs: [
      {
        kind: opts.kind,
        from: opts.from,
        to: opts.to,
        asset: opts.asset,
        amountToken: opts.amountToken,
        amountUsd: opts.amountUsd,
        programOrContract: opts.programOrContract
      }
    ]
  };
  recordTx(builder, tx, [opts.from, opts.to]);
  markWalletActivity(builder, opts.from, tx.ts);
  markWalletActivity(builder, opts.to, tx.ts);
  return tx;
}

function fakeTxHashFor(builder: WorldBuilder, ts: Date, from: string, to: string): string {
  // Deterministic per (ts, from, to) without drawing from the shared rng
  // (keeps tx-hash generation from perturbing the rest of the sequence when
  // scenario code calls makeSimpleTx a variable number of times).
  const raw = `${ts.getTime()}:${from}:${to}:${builder.txsByWallet.size}`;
  let h1 = 0xdeadbeef ^ raw.length;
  let h2 = 0x41c6ce57 ^ raw.length;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = (Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)) >>> 0;
  h2 = (Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)) >>> 0;
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).repeat(4).slice(0, 64);
}

/** Marks a wallet's first-seen tx timestamp (used to compute `fresh`/firstTxTs). */
function markWalletActivity(builder: WorldBuilder, address: string, ts: Date): void {
  const wallet = builder.wallets.get(address);
  if (!wallet) return; // token contracts / external addresses aren't tracked wallets
  if (wallet.firstTxTs === null || ts.getTime() < wallet.firstTxTs.getTime()) {
    wallet.firstTxTs = ts;
  }
}

// ---------------------------------------------------------------------------
// Wallet generation
// ---------------------------------------------------------------------------

function pickLabels(rng: Rng): WalletLabel[] {
  const count = rng() < 0.7 ? 1 : 2;
  const labels = new Set<WalletLabel>();
  while (labels.size < count) {
    labels.add(WALLET_LABEL_POOL[Math.floor(rng() * WALLET_LABEL_POOL.length)]!);
  }
  return [...labels];
}

function generateNoiseWallets(builder: WorldBuilder, rng: Rng): void {
  let idx = 0;

  // Exactly-labeled cohorts first (brief: >=12 possible_bot, >=6 sniper,
  // >=4 cex_related), then general noise wallets with mixed labels.
  const cohorts: { count: number; label: WalletLabel }[] = [
    { count: 14, label: 'possible_bot' },
    { count: 7, label: 'sniper' },
    { count: 5, label: 'cex_related' }
  ];

  for (const cohort of cohorts) {
    for (let i = 0; i < cohort.count; i++) {
      const address = fakeSolanaAddress(rng);
      const id = `wallet-noise-${idx++}`;
      builder.wallets.set(address, {
        id,
        chain: 'SOLANA',
        address,
        labels: [cohort.label],
        walletScore: Math.round(rng() * 40), // noise cohorts skew low quality
        fresh: true,
        firstTxTs: null
      });
    }
  }

  const remaining = NOISE_WALLET_COUNT - cohorts.reduce((s, c) => s + c.count, 0);
  for (let i = 0; i < remaining; i++) {
    const address = fakeSolanaAddress(rng);
    const id = `wallet-noise-${idx++}`;
    builder.wallets.set(address, {
      id,
      chain: 'SOLANA',
      address,
      labels: pickLabels(rng),
      walletScore: Math.round(rng() * 100),
      fresh: true,
      firstTxTs: null
    });
  }

  for (let i = 0; i < NOISE_BSC_WALLET_COUNT; i++) {
    const address = fakeBscAddress(rng);
    const id = `wallet-noise-bsc-${idx++}`;
    builder.wallets.set(address, {
      id,
      chain: 'BSC',
      address,
      labels: pickLabels(rng),
      walletScore: Math.round(rng() * 100),
      fresh: true,
      firstTxTs: null
    });
  }
}

// ---------------------------------------------------------------------------
// Token generation
// ---------------------------------------------------------------------------

const NOISE_TOKEN_NAME_PARTS = [
  'Fox',
  'Moon',
  'Rocket',
  'Doge',
  'Pepe',
  'Frog',
  'Cat',
  'Chain',
  'Base',
  'Nova',
  'Star',
  'Wave',
  'Byte',
  'Sol',
  'Coin',
  'Verse',
  'Grid',
  'Node',
  'Loop',
  'Drift',
  'Echo'
];

function generateNoiseTokens(builder: WorldBuilder, rng: Rng): void {
  for (let i = 0; i < NOISE_TOKEN_COUNT; i++) {
    const chain: Chain = rng() < 0.8 ? 'SOLANA' : 'BSC';
    const address = chain === 'SOLANA' ? fakeSolanaAddress(rng) : fakeBscAddress(rng);
    const symbol = `NOISE${String(i + 1).padStart(2, '0')}`;
    const name = `${rngPickName(rng)} Token`;
    const ageDays = Math.floor(rng() * 60);
    const createdAt = new Date(builder.genesis.getTime() - ageDays * 24 * HOUR_MS);
    builder.tokens.set(address, {
      id: `token-${symbol.toLowerCase()}`,
      chain,
      address,
      symbol,
      name,
      decimals: 9,
      createdAt
    });
  }
}

function rngPickName(rng: Rng): string {
  return NOISE_TOKEN_NAME_PARTS[Math.floor(rng() * NOISE_TOKEN_NAME_PARTS.length)]!;
}

// ---------------------------------------------------------------------------
// Background noise trades + market series (every token gets baseline activity
// and a full hourly market series across the 72h window; scenarios layer
// their scripted points/trades on top / override specific hours).
// ---------------------------------------------------------------------------

function generateNoiseTradesForToken(builder: WorldBuilder, rng: Rng, token: MockToken, wallets: MockWallet[]): void {
  const sameChainWallets = wallets.filter((w) => w.chain === token.chain);
  if (sameChainWallets.length === 0) return;

  const tradeCount = 20 + Math.floor(rng() * 30);
  for (let i = 0; i < tradeCount; i++) {
    const walletA = sameChainWallets[Math.floor(rng() * sameChainWallets.length)]!;
    const offsetMs = Math.floor(rng() * HORIZON_HOURS * HOUR_MS);
    const ts = new Date(builder.genesis.getTime() + offsetMs);
    const isBuy = rng() < 0.6;
    const amountToken = 100 + rng() * 5000;
    const priceUsd = 0.001 + rng() * 2;
    const amountUsd = amountToken * priceUsd;

    makeSimpleTx(builder, {
      chain: token.chain,
      ts,
      kind: 'swap_leg',
      from: isBuy ? token.address : walletA.address,
      to: isBuy ? walletA.address : token.address,
      asset: { address: token.address, symbol: token.symbol, decimals: token.decimals },
      amountToken: amountToken.toFixed(4),
      amountUsd
    });
  }
}

function generateBaselineMarketSeries(
  builder: WorldBuilder,
  rng: Rng,
  token: MockToken,
  opts?: { basePrice?: number; baseMcap?: number; baseLiquidity?: number }
): MockMarketPoint[] {
  const basePrice = opts?.basePrice ?? 0.01 + rng() * 0.5;
  const baseMcap = opts?.baseMcap ?? 50_000 + rng() * 200_000;
  const baseLiquidity = opts?.baseLiquidity ?? 10_000 + rng() * 40_000;

  const points: MockMarketPoint[] = [];
  for (let hour = 0; hour <= HORIZON_HOURS; hour++) {
    const ts = new Date(builder.genesis.getTime() + hour * HOUR_MS);
    const drift = 1 + (rng() - 0.5) * 0.1;
    const priceUsd = Math.max(0.0000001, basePrice * drift ** hour);
    const marketCapUsd = Math.max(1, baseMcap * drift ** hour);
    const liquidityUsd = Math.max(1, baseLiquidity * (1 + (rng() - 0.5) * 0.05));

    points.push({
      ts,
      market: {
        priceUsd,
        marketCapUsd,
        fdvUsd: marketCapUsd,
        liquidityUsd,
        vol5m: rng() * 5000,
        vol1h: rng() * 20000,
        vol6h: rng() * 80000,
        vol24h: rng() * 200000,
        holderCount: Math.floor(50 + rng() * 500),
        dex: token.chain === 'SOLANA' ? 'Raydium' : 'PancakeSwap'
      }
    });
  }

  builder.marketSeries.set(token.address, points);
  return points;
}

// ---------------------------------------------------------------------------
// createMockWorld
// ---------------------------------------------------------------------------

export function createMockWorld(opts: CreateMockWorldOpts): MockWorld {
  const seed = opts.seed ?? 20260705;
  const genesis = opts.genesis;
  const horizon = new Date(genesis.getTime() + HORIZON_HOURS * HOUR_MS);

  // Independent-but-deterministic sub-seeds per generation phase, all mixed
  // from the single (seed) input — genesis never feeds the rng, only ts
  // math, so world *content* stays stable if only genesis moves and *does*
  // change if seed moves (satisfies both determinism tests).
  const walletsRng = mulberry32(mixSeed(seed, 1));
  const tokensRng = mulberry32(mixSeed(seed, 2));
  const noiseRng = mulberry32(mixSeed(seed, 3));
  const scenarioRng = mulberry32(mixSeed(seed, 4));

  const builder: WorldBuilder = {
    genesis,
    horizon,
    rng: noiseRng,
    wallets: new Map(),
    tokens: new Map(),
    txsByWallet: new Map(),
    marketSeries: new Map(),
    riskByToken: new Map(),
    slotCounters: new Map()
  };

  generateNoiseWallets(builder, walletsRng);
  generateNoiseTokens(builder, tokensRng);

  // Scenarios create their own scripted wallets/tokens/txs/market series and
  // return handles identifying every address/token involved. Scenario
  // construction happens BEFORE noise trades/market series so noise
  // generation can skip scenario tokens (which get their own scripted
  // series) and include scenario wallets in the general noise-trading pool
  // for realism (a NOVA buyer might also noise-trade some NOISE07 token).
  const scenarios = buildScenarios(builder, scenarioRng);

  const scenarioTokenAddresses = new Set(
    [...builder.tokens.values()]
      .filter((t) => ['NOVA', 'QUIET', 'SEED', 'ALPHA', 'BETA', 'DUMP', 'RUGZ'].includes(t.symbol))
      .map((t) => t.address)
  );

  // Only genuinely-noise wallets (id prefix "wallet-noise") trade noise
  // tokens. Scenario-dedicated wallets (nova-*, seed-*, dump-*, ...) stay
  // fully scripted — mixing them into noise trading risks placing a random
  // tx before a scenario's scripted "first tx" moment, which would break
  // freshness-sensitive invariants like $SEED's "0 prior txs" requirement.
  const noiseWallets = [...builder.wallets.values()].filter((w) => w.id.startsWith('wallet-noise'));
  for (const token of builder.tokens.values()) {
    if (scenarioTokenAddresses.has(token.address)) continue; // scripted separately
    generateNoiseTradesForToken(builder, noiseRng, token, noiseWallets);
    generateBaselineMarketSeries(builder, noiseRng, token);
  }

  // Freshness is finalized after ALL tx generation (noise + scenario): a
  // wallet is "fresh" (per SEED scenario semantics: 0 prior txs before a
  // specific funding tx) only relative to that funding tx, which
  // scenarios.ts checks directly against firstTxTs. Here we just expose the
  // flag as "this wallet's only tx activity is at/after firstTxTs with no
  // earlier noise" for general consumers.
  for (const wallet of builder.wallets.values()) {
    wallet.fresh = wallet.firstTxTs === null;
  }

  return {
    wallets: [...builder.wallets.values()],
    tokens: [...builder.tokens.values()],
    txsByWallet: mapWithSortedTxs(builder.txsByWallet),
    marketSeries: builder.marketSeries,
    riskByToken: builder.riskByToken,
    meta: {
      seed,
      genesis,
      horizon,
      scenarios
    }
  };
}

function mapWithSortedTxs(map: Map<string, NormalizedTx[]>): Map<string, NormalizedTx[]> {
  const out = new Map<string, NormalizedTx[]>();
  for (const [key, txs] of map.entries()) {
    out.set(
      key,
      [...txs].sort((a, b) => a.ts.getTime() - b.ts.getTime())
    );
  }
  return out;
}

// Re-export generation helpers scenarios.ts needs, so it has a single import
// surface (`./world.js`) for builder-context utilities.
export { generateBaselineMarketSeries, HOUR_MS, MIN_MS };
