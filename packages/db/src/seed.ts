#!/usr/bin/env tsx
// FlowRadar — seed script (Task 6 brief).
//
// Deterministic, rerunnable seed pass: wipe every app table, bootstrap
// Chains/Settings/AddressRegistry, build the mock world, write a full 72h
// hourly market-snapshot series for every token FIRST, seed WalletStats
// (computed, then CSV-overridden) BEFORE ingesting trades, ingest every
// wallet's tx stream, then run one flow-scoring pass. Ordering matters — see
// each phase's comment for why (this fixes the known scoring gap flagged in
// Task 5's report: marketCapAtTrade/walletScoreAtTime need an "as of trade
// time" lookup, which packages/db/src/ingest.ts now does — see that file's
// updated header comment).
//
// Run: `npm run db:seed` (root) — forwards to `db:seed -w packages/db`,
// which itself runs `tsx ../../scripts/db-local.ts ensure && tsx src/seed.ts`.

import { config as loadDotenv } from 'dotenv';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { DEFAULT_SETTINGS } from '@flowradar/core';
import type { Chain, Settings } from '@flowradar/core';
import { computeWalletScore } from '@flowradar/core';
import { createMockWorld, GRAPH_DEMO_ROOT_ADDRESS, MockProvider } from '@flowradar/providers';
import type { MockWorld } from '@flowradar/providers';
import type { Prisma } from '@prisma/client';
import { prisma } from './client';
import { ingestNormalizedTxs, snapshotMarket } from './ingest';
import { runFlowScoringPass } from './scoring-pass';
import { runEntityClustering } from './clustering';
import { runSignalDetectionPass } from './signals';
import { dispatchPendingAlerts } from './alerts';
import { runBacktestPass } from './backtest';
import { runHistoricalReplay } from './replayRunner';
import { importWalletsCsv } from './csv/importWalletsCsv';
import { runGraphSearch } from './graph/runSearch';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const FIXTURE_CSV_PATH = path.join(HERE, '..', 'fixtures', 'wallets.csv');

const HOUR_MS = 60 * 60 * 1000;
const WORLD_HORIZON_HOURS = 72;

const SMART_LABELS = new Set(['smart_money', 'human_like', 'whale']);

function loadEnv(): void {
  const envPath = path.join(REPO_ROOT, '.env');
  loadDotenv({ path: envPath }); // no-op silently if the file doesn't exist (dotenv's own behavior)
}

function log(message: string, meta?: Record<string, unknown>): void {
  const suffix = meta ? ` ${JSON.stringify(meta)}` : '';
  // eslint-disable-next-line no-console
  console.log(`[seed] ${message}${suffix}`);
}

// ---------------------------------------------------------------------------
// Phase 1: wipe-first (FK-safe leaf-to-root order — see report for the full
// dependency reasoning). Every app table gets deleteMany'd so the seed is
// fully deterministic and rerunnable from a clean slate every time.
// ---------------------------------------------------------------------------

async function wipeAllTables(): Promise<void> {
  log('wiping all app tables (FK-safe leaf-to-root order)...');
  // BacktestRun carries no FK to any other app table (see schema.prisma's own
  // "kind + params + summary Json" shape) — wiped here too (Task 42) so a
  // rerun of this fully-rerunnable script doesn't leave a stale prior
  // replay-run row sitting alongside the fresh one this run creates below.
  await prisma.backtestRun.deleteMany();
  await prisma.backtestResult.deleteMany();
  await prisma.alert.deleteMany();
  await prisma.signal.deleteMany();
  await prisma.walletGraphEdge.deleteMany();
  await prisma.walletGraphNode.deleteMany();
  await prisma.walletGraphSearch.deleteMany();
  await prisma.profitRotationSignal.deleteMany();
  await prisma.entityClusterWallet.deleteMany();
  await prisma.walletTokenTrade.deleteMany();
  await prisma.tokenFlowSnapshot.deleteMany();
  await prisma.tokenMarketSnapshot.deleteMany();
  await prisma.entityCluster.deleteMany();
  await prisma.walletClassification.deleteMany();
  await prisma.walletStats.deleteMany();
  await prisma.moneyFlowEdge.deleteMany();
  await prisma.wallet.deleteMany();
  await prisma.token.deleteMany();
  await prisma.importJob.deleteMany();
  await prisma.addressRegistry.deleteMany();
  await prisma.providerSyncState.deleteMany();
  await prisma.settings.deleteMany();
  await prisma.chain.deleteMany();
  log('wipe complete.');
}

// ---------------------------------------------------------------------------
// Phase 2: bootstrap — Chain rows, Settings row, AddressRegistry rows.
// ---------------------------------------------------------------------------

async function bootstrapChains(): Promise<void> {
  await prisma.chain.createMany({
    data: [
      {
        id: 'SOLANA',
        name: 'Solana',
        nativeSymbol: 'SOL',
        explorerTxUrl: 'https://solscan.io/tx/{hash}',
        explorerAddressUrl: 'https://solscan.io/account/{address}'
      },
      {
        id: 'BSC',
        name: 'BNB Smart Chain',
        nativeSymbol: 'BNB',
        explorerTxUrl: 'https://bscscan.com/tx/{hash}',
        explorerAddressUrl: 'https://bscscan.com/address/{address}'
      }
    ]
  });
  log('bootstrapped Chain rows (SOLANA, BSC).');
}

async function bootstrapSettings(): Promise<Settings> {
  // Wipe-first already removed any prior Settings row, so this always
  // creates fresh from DEFAULT_SETTINGS (no clobber-risk of a user's live
  // edits — those only exist once the app has been used post-seed, and this
  // seed script's whole contract is "start from empty").
  await prisma.settings.create({ data: { values: DEFAULT_SETTINGS } });
  log('bootstrapped Settings row from DEFAULT_SETTINGS.');
  return DEFAULT_SETTINGS;
}

/**
 * AddressRegistry rows for every CEX/router/bridge-tagged counterparty the
 * mock world exposes. Two distinct sources of such counterparties:
 *   1. MockWallet rows whose WalletLabel includes 'cex_related' or
 *      'bridge_related' (noise cohort wallets + the graph-demo CEX wallet +
 *      ALPHA->BETA's bridge-related destination wallet).
 *   2. The graph-demo's router-tagged counterparty, which is a MockWallet
 *      labeled 'unknown' but whose only distinguishing tag is the
 *      `programOrContract: 'ROUTER'` value on the tx leg that touches it
 *      (there's no WalletLabel enum value for "router" itself) — tagged
 *      explicitly by address below since MockWorld doesn't expose a
 *      ByProgramOrContract index.
 *   3. The literal 'wormhole-bridge-program' address used as the bridge
 *      counterparty in the ALPHA->BETA scenario — not a MockWallet at all
 *      (just a raw string used as tx from/to), tagged BRIDGE explicitly.
 */
async function bootstrapAddressRegistry(world: MockWorld): Promise<number> {
  const rows: {
    chain: Chain;
    address: string;
    category: 'CEX' | 'BRIDGE' | 'ROUTER';
    label: string;
  }[] = [];

  for (const wallet of world.wallets) {
    if (wallet.labels.includes('cex_related')) {
      rows.push({ chain: wallet.chain, address: wallet.address, category: 'CEX', label: 'Mock CEX hot wallet' });
    }
    if (wallet.labels.includes('bridge_related')) {
      rows.push({ chain: wallet.chain, address: wallet.address, category: 'BRIDGE', label: 'Mock bridge-related wallet' });
    }
  }

  // Graph-demo's router counterparty (WalletLabel 'unknown', tagged via
  // programOrContract on its incoming leg instead — see doc comment above).
  rows.push({
    chain: 'SOLANA',
    address: world.meta.scenarios.graphDemo.routerCounterparty,
    category: 'ROUTER',
    label: 'Mock DEX router'
  });

  // ALPHA->BETA's bridge program address (a raw string, not a MockWallet).
  rows.push({
    chain: 'SOLANA',
    address: 'wormhole-bridge-program',
    category: 'BRIDGE',
    label: 'Mock Wormhole bridge program'
  });

  // De-dupe by (chain, address) — a wallet could in principle carry both
  // cex_related and bridge_related labels (pickLabels() can assign 2 labels
  // to a noise wallet), which would otherwise violate AddressRegistry's
  // @@unique([chain, address]) constraint on a second createMany row for the
  // same address.
  const seen = new Set<string>();
  const deduped = rows.filter((r) => {
    const key = `${r.chain}:${r.address}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  await prisma.addressRegistry.createMany({
    data: deduped.map((r) => ({
      chain: r.chain,
      address: r.address,
      category: r.category,
      label: r.label,
      source: 'mock-world',
      doNotExpand: true
    }))
  });

  log('bootstrapped AddressRegistry rows.', { count: deduped.length });
  return deduped.length;
}

// ---------------------------------------------------------------------------
// Phase 4: market snapshots FIRST — full hourly TokenMarketSnapshot series
// for every token across the mock world's full 72h horizon, written BEFORE
// any trade is ingested. This matters because ingest.ts's
// marketCapAtTrade/walletScoreAtTime lookups are "latest snapshot/stats row
// with ts/computedAt <= the trade's own ts" (fixed in this task — see
// ingest.ts's header comment for the full "latest overall" vs "latest as-of"
// history) — writing the complete series up front means every later
// ingested trade, regardless of which hour it falls in, finds a correctly
// dated snapshot to attribute its marketCapAtTrade to.
// ---------------------------------------------------------------------------

async function seedMarketSnapshots(world: MockWorld, tokenIdByAddress: Map<string, string>): Promise<number> {
  let written = 0;
  for (const token of world.tokens) {
    const series = world.marketSeries.get(token.address);
    if (!series) continue;
    const tokenId = tokenIdByAddress.get(token.address);
    if (!tokenId) continue;
    for (const point of series) {
      await snapshotMarket(prisma, tokenId, point.market, point.ts);
      written += 1;
    }
  }
  log('seeded market snapshots for all tokens.', { tokens: world.tokens.length, snapshots: written });
  return written;
}

// ---------------------------------------------------------------------------
// Phase 7.94: post-signal price continuation (Task 40 — backtest evaluator
// needs REAL post-triggeredAt market data to evaluate against; see this
// file's own "seedBacktestContinuation" doc comment below for the full root
// cause this phase works around).
// ---------------------------------------------------------------------------

/** Simple deterministic PRNG seeded from a string — same shape as this file's own seededRandomFor (kept as a separate local copy so this phase's determinism is self-contained and doesn't depend on that function's own call-site ordering elsewhere in the script). */
function seededRng(seedStr: string): () => number {
  let h = 0;
  for (let i = 0; i < seedStr.length; i++) {
    h = Math.imul(h ^ seedStr.charCodeAt(i), 2654435761);
    h ^= h >>> 13;
  }
  let state = (h >>> 0) || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0xffffffff;
  };
}

/**
 * Every Signal.triggeredAt is stamped `now` at signal-detection time (see
 * packages/db/src/signals.ts's runSignalDetectionPass), which — in this
 * one-shot seed script — lands within seconds of world.meta.horizon, i.e.
 * the very LAST hourly TokenMarketSnapshot point Phase 4 wrote for any
 * token. There is therefore ZERO seeded market data with ts >= triggeredAt
 * for ANY signal: evaluateSignalOutcome's "ignore everything before
 * triggeredAt" rule (by design — see evaluate.ts's header) would legitimately
 * see an empty post-trigger series for every single seeded signal and return
 * neutral_pending across the board, which is not a bug in the evaluator or
 * in runBacktestPass — it is a genuine "no post-signal data exists yet"
 * situation. A real, running FlowRadar deployment doesn't have this problem
 * (its worker keeps ingesting live market snapshots long after a signal
 * fires), but a one-shot seed script that builds its entire world up to "now"
 * and immediately evaluates has no such luxury.
 *
 * This phase closes that gap by writing a further ~7 days (7*24 hourly
 * points) of DELIBERATELY SYNTHETIC continuation snapshots per token that
 * fired >=1 signal, starting 1 hour after that token's OWN signal(s')
 * triggeredAt (using the EARLIEST triggeredAt when a token fired >1 signal,
 * so every signal on that token has a fully-continuous post-trigger series).
 * Each token's continuation path is a deterministic BOUNDED ramp — a
 * straight-line interpolation from 1.0x (entry) to a fixed targetMultiple
 * over the first RAMP_HOURS hours, then held flat (plus small noise) for the
 * remainder of the week — anchored at that token's OWN mcapAtTrigger (from
 * its Signal row — a more representative entry point than the noisy final
 * baseline-series point). Deliberately NOT a compounding %/hour random walk:
 * an early draft of this function multiplied mcap by (1 + drift + noise)
 * every hour, which even at a modest-looking 9%/hour compounds to ~880,000x
 * over 168 hours (1.09^168) — wildly unrealistic. The bounded-ramp model
 * avoids that blowup by construction (the multiple can never exceed
 * targetMultiple + noise, no matter how many hours elapse). targetMultiple is
 * chosen PER SCENARIO so the resulting label distribution is a realistic,
 * non-uniform mix rather than "every seeded signal wins" or "every seeded
 * signal is neutral":
 *   NOVA (flagship "hot" signal)  -> strong sustained pump (targets major_win)
 *   QUIET (accumulation signal)   -> steady moderate growth (targets good_win)
 *   SEED (fresh-wallet-funded)    -> modest growth then partial pullback (small_win/neutral)
 *   ALPHA (rotation source)       -> mixed/declining (targets failure)
 *   BETA (rotation dest)          -> modest growth (targets small_win/good_win)
 *   DUMP (exit-warning signal)    -> continued liquidity/price collapse (targets hard_failure)
 *   every NOISE* (rule G noise)   -> flat/mildly random (targets neutral_pending — these
 *                                    are noise-cohort tokens, not meant to demonstrate a
 *                                    strong outcome either way)
 * This is explicitly a SEED-SCRIPT-ONLY device to give the backtest
 * self-check real series coverage to prove evaluateSignalOutcome's code path
 * runs correctly end-to-end — per this repo's hard-framing rule (see
 * evaluate.ts/backtest.ts headers), it does NOT claim FlowRadar's rules have
 * real trading edge; these synthetic continuations are labeled as such in
 * this comment for exactly that reason.
 *
 * Machine-detectable provenance (Task 40 fix pass): every row this function
 * writes is passed source='seed_synthetic_continuation' (see
 * snapshotMarket's `source` param) instead of the 'ingest' default every real
 * TokenMarketSnapshot row gets — so runBacktestPass (and eventually T42's
 * pages) can programmatically tell "real market data" from "this seed-only
 * device" at the row level, not just via this comment. Downstream,
 * runBacktestPass appends 'synthetic_continuation' to BacktestResult.notes
 * for any signal whose evaluated series contains >=1 such row.
 *
 * Defense-in-depth guard: this function throws unless called with
 * `{ allowSynthetic: true }` AND `process.env.MOCK_MODE !== 'false'` — see
 * the two checks at the top of the function body. Only this file's own
 * main() passes the flag; nothing else in the codebase (worker jobs, API
 * routes) has any legitimate reason to fabricate synthetic market data, so an
 * accidental call from anywhere else fails loudly instead of silently
 * writing fake rows into a real deployment's data.
 */
export async function seedBacktestContinuation(
  tokenIdByAddress: Map<string, string>,
  world: MockWorld,
  options: { allowSynthetic: boolean }
): Promise<{ tokensExtended: number; snapshotsWritten: number }> {
  if (!options.allowSynthetic) {
    throw new Error(
      'seedBacktestContinuation writes DELIBERATELY SYNTHETIC market data and must only be ' +
        'called with { allowSynthetic: true } — refusing to run without it (defense-in-depth ' +
        'guard, Task 40 fix pass: nothing but this file\'s own seed main() should ever call this).'
    );
  }
  if (process.env.MOCK_MODE === 'false') {
    throw new Error(
      'seedBacktestContinuation refuses to run when MOCK_MODE=\'false\' — synthetic continuation ' +
        'data must never be written against a real (non-mock) deployment (defense-in-depth guard, ' +
        'Task 40 fix pass).'
    );
  }

  const SYNTHETIC_SOURCE = 'seed_synthetic_continuation';
  const CONTINUATION_HOURS = 7 * 24; // 7 days, matching BacktestHorizon's longest window (D7)
  const HOUR = 60 * 60 * 1000;
  const RAMP_HOURS = 30; // hours to reach targetMultiple, then hold with noise for the remainder

  // Bounded "ramp to a target multiple-of-entry over RAMP_HOURS, then hold
  // with mild noise" model (NOT compounding %/hour — compounding even a
  // modest hourly drift over 168 hours explodes exponentially, e.g. 1.09^168
  // is in the hundreds of thousands — wildly unrealistic for a 7-day window).
  // targetMultiple is the intended multiple-of-entry-mcap this scenario's
  // continuation should reach by the end of its ramp.
  type Trajectory = { targetMultiple: number; volatility: number };
  const TRAJECTORY_BY_SYMBOL: Record<string, Trajectory> = {
    NOVA: { targetMultiple: 6.5, volatility: 0.04 }, // strong sustained pump -> major_win (5x+)
    QUIET: { targetMultiple: 2.3, volatility: 0.03 }, // steady moderate growth -> good_win (2x+)
    SEED: { targetMultiple: 1.4, volatility: 0.06 }, // modest growth, choppier -> small_win/neutral
    ALPHA: { targetMultiple: 0.15, volatility: 0.05 }, // sustained decline, never reaches 2x -> failure
    BETA: { targetMultiple: 1.7, volatility: 0.04 }, // modest growth -> small_win
    DUMP: { targetMultiple: 0.05, volatility: 0.03 } // continued collapse -> hard_failure (paired with liquidity decay below)
  };
  const DEFAULT_TRAJECTORY: Trajectory = { targetMultiple: 1.05, volatility: 0.02 }; // NOISE*/anything else -> flat/mild -> neutral_pending

  // Group signals by tokenId, taking the EARLIEST triggeredAt per token (a
  // token with multiple fired rules, e.g. NOVA's A/C/D, gets ONE continuation
  // series covering every one of its signals).
  const signalRows = await prisma.signal.findMany({ select: { tokenId: true, triggeredAt: true } });
  const earliestTriggerByToken = new Map<string, Date>();
  for (const s of signalRows) {
    const existing = earliestTriggerByToken.get(s.tokenId);
    if (!existing || s.triggeredAt.getTime() < existing.getTime()) {
      earliestTriggerByToken.set(s.tokenId, s.triggeredAt);
    }
  }

  const tokenIdToAddress = new Map([...tokenIdByAddress.entries()].map(([addr, id]) => [id, addr]));
  const tokenIdToSymbol = new Map(world.tokens.map((t) => [t.address, t.symbol] as const));

  let tokensExtended = 0;
  let snapshotsWritten = 0;

  for (const [tokenId, earliestTriggeredAt] of earliestTriggerByToken) {
    const address = tokenIdToAddress.get(tokenId);
    const symbol = address ? tokenIdToSymbol.get(address) : undefined;
    if (!symbol) continue;

    const signal = await prisma.signal.findFirst({
      where: { tokenId, triggeredAt: earliestTriggeredAt },
      select: { mcapAtTrigger: true }
    });
    const entryMcap = signal ? Number(signal.mcapAtTrigger) : null;
    if (entryMcap === null || entryMcap <= 0) continue; // nothing sensible to anchor a continuation to

    const latestSnapshot = await prisma.tokenMarketSnapshot.findFirst({
      where: { tokenId },
      orderBy: { ts: 'desc' },
      select: { priceUsd: true, marketCapUsd: true, liquidityUsd: true }
    });
    const entryPrice = latestSnapshot ? Number(latestSnapshot.priceUsd) : null;
    const entryLiquidity = latestSnapshot && latestSnapshot.liquidityUsd !== null ? Number(latestSnapshot.liquidityUsd) : 25_000;
    // Scale factor from mcap -> price (mcap and price move together at a
    // fixed ratio for a fixed-supply mock token — same assumption
    // scenarios.ts's own generateBaselineMarketSeries makes).
    const priceToMcapRatio = entryPrice !== null && entryPrice > 0 ? entryMcap / entryPrice : 1;

    const trajectory = TRAJECTORY_BY_SYMBOL[symbol] ?? DEFAULT_TRAJECTORY;
    const rng = seededRng(`backtest-continuation-${symbol}`);
    const isDumpScenario = symbol === 'DUMP';

    let liquidity = entryLiquidity;

    for (let h = 1; h <= CONTINUATION_HOURS; h++) {
      const ts = new Date(earliestTriggeredAt.getTime() + h * HOUR);

      // Ramp fraction: 0 at h=0, 1 at h=RAMP_HOURS, held at 1 afterwards —
      // a straight-line interpolation from 1.0x (entry) to targetMultiple,
      // so the trajectory is bounded by construction (no compounding).
      const rampFrac = Math.min(1, h / RAMP_HOURS);
      const baseMultiple = 1 + (trajectory.targetMultiple - 1) * rampFrac;
      const noise = (rng() * 2 - 1) * trajectory.volatility;
      const multiple = Math.max(0.001, baseMultiple + noise);
      const mcap = entryMcap * multiple;

      // DUMP's own signal is an exit-warning (rule G) — its continuation
      // ALSO decays liquidity sharply within the first few hours so the
      // hard_failure liquidity-collapse gate (>=90% drop, or <$1k) is hit
      // deterministically well before any 2x could occur, on top of its
      // already-negative price trajectory.
      if (isDumpScenario) {
        liquidity = h <= 5 ? liquidity * 0.55 : Math.max(200, liquidity * 0.97);
      } else {
        liquidity = Math.max(1000, liquidity * (1 + (rng() * 2 - 1) * 0.02));
      }

      const price = priceToMcapRatio > 0 ? mcap / priceToMcapRatio : mcap;

      await snapshotMarket(
        prisma,
        tokenId,
        {
          priceUsd: price,
          marketCapUsd: mcap,
          fdvUsd: mcap,
          liquidityUsd: liquidity,
          vol5m: 0,
          vol1h: 0,
          vol6h: 0,
          vol24h: 0,
          holderCount: null
        },
        ts,
        SYNTHETIC_SOURCE
      );
      snapshotsWritten += 1;
    }
    tokensExtended += 1;
  }

  return { tokensExtended, snapshotsWritten };
}

// ---------------------------------------------------------------------------
// Phase 5(a): computed WalletStats for every smart_money/human_like/whale
// labeled mock-world wallet — BEFORE trades are ingested, so
// ingest.ts's latestWalletScore() as-of lookup has a real WalletStats row to
// find once trades start landing.
// ---------------------------------------------------------------------------

function pnlConfidenceFor(rng: () => number): number {
  return 60 + rng() * 30; // 60-90, per brief decision 5(a)
}

/** Simple deterministic PRNG seeded from a string (wallet address), independent of the mock world's own internal rng streams (kept out of MockWorld's determinism contract entirely — this only affects computed-stats cosmetics, not any scenario invariant). */
function seededRandomFor(seedStr: string): () => number {
  let h = 0;
  for (let i = 0; i < seedStr.length; i++) {
    h = Math.imul(h ^ seedStr.charCodeAt(i), 2654435761);
    h ^= h >>> 13;
  }
  let state = (h >>> 0) || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0xffffffff;
  };
}

async function seedComputedWalletStats(world: MockWorld): Promise<number> {
  const now = new Date();
  let created = 0;

  for (const mockWallet of world.wallets) {
    const isSmart = mockWallet.labels.some((l) => SMART_LABELS.has(l));
    if (!isSmart) continue;

    const rng = seededRandomFor(mockWallet.address);

    const pnl30d = 4000 + rng() * 56000; // 4k-60k per brief decision 5(a)
    const winRate = 0.35 + rng() * 0.45; // 0.35-0.8
    const tradeCount = Math.round(8 + rng() * 52); // 8-60
    const avgTradeSizeUsd = 100 + rng() * 2000;
    const pnlConfidence = pnlConfidenceFor(rng);
    const realizedPnlUsd = pnl30d * (0.6 + rng() * 0.3); // 60-90% realized
    const unrealizedPnlUsd = pnl30d - realizedPnlUsd;

    const scoreInput = {
      pnl30d,
      winRate,
      tradeCount,
      humanLikelihood: mockWallet.labels.includes('human_like') ? 0.8 : 0.6,
      entryQuality: 0.6 + rng() * 0.3,
      holdingQuality: 0.6 + rng() * 0.3,
      recentPerf: 0.5 + rng() * 0.4,
      botLikelihood: mockWallet.labels.includes('possible_bot') ? 0.6 : 0,
      pnlConfidence
    };
    const scoreResult = computeWalletScore(scoreInput);

    const wallet = await prisma.wallet.upsert({
      where: { address_chain: { address: mockWallet.address, chain: mockWallet.chain } },
      create: {
        address: mockWallet.address,
        chain: mockWallet.chain,
        firstSeenAt: mockWallet.firstTxTs ?? now,
        lastActiveAt: mockWallet.firstTxTs ?? now,
        isWatched: true
      },
      update: { isWatched: true },
      select: { id: true }
    });

    await prisma.walletStats.create({
      data: {
        walletId: wallet.id,
        window: '30d',
        pnlUsd: pnl30d,
        realizedPnlUsd,
        unrealizedPnlUsd,
        winRate,
        tradeCount,
        avgTradeSizeUsd,
        walletScore: scoreResult.score,
        scoreComponents: scoreResult.components,
        pnlConfidence,
        source: 'computed',
        computedAt: now
      }
    });

    for (const label of mockWallet.labels) {
      await prisma.walletClassification.create({
        data: {
          walletId: wallet.id,
          label,
          confidence: 80,
          evidence: { source: 'mock-world-label' }
        }
      });
    }

    created += 1;
  }

  log('seeded computed WalletStats for smart_money/human_like/whale wallets.', { count: created });
  return created;
}

// ---------------------------------------------------------------------------
// Phase 5(b): CSV fixture import — overrides computed rows for the 40
// wallets it lists (a later WalletStats.computedAt row naturally wins any
// "latest per wallet" lookup; see importWalletsCsv.ts's file header).
// ---------------------------------------------------------------------------

async function seedCsvWallets(): Promise<{ okRows: number; importJobId: string }> {
  const csvText = readFileSync(FIXTURE_CSV_PATH, 'utf-8');
  const result = await importWalletsCsv(prisma, csvText, 'wallets.csv');
  log('imported CSV wallet fixture.', { okRows: result.okRows, errorRows: result.errorRows, importJobId: result.importJobId });
  return { okRows: result.okRows, importJobId: result.importJobId };
}

// ---------------------------------------------------------------------------
// Phase 6: ingest every wallet's tx stream via ingestNormalizedTxs (mirrors
// the real walletActivity job's per-wallet call pattern exactly).
// ---------------------------------------------------------------------------

async function ingestAllWallets(world: MockWorld): Promise<{ walletsIngested: number }> {
  let walletsIngested = 0;
  for (const wallet of world.wallets) {
    const txs = world.txsByWallet.get(wallet.address);
    if (!txs || txs.length === 0) continue;
    await ingestNormalizedTxs(prisma, wallet.chain, wallet.address, txs);
    walletsIngested += 1;
  }
  log('ingested tx streams for all wallets with activity.', { walletsIngested, totalWallets: world.wallets.length });
  return { walletsIngested };
}

// ---------------------------------------------------------------------------
// Phase 7.9: demo WalletGraphSearch (Task 20 binding decision 7) — one
// CAPITAL_FLOW/depth-3 search rooted at the graph-demo scenario's fixed root
// address (GRAPH_DEMO_ROOT_ADDRESS), run via the same runGraphSearch shared
// body apps/worker's walletGraph job and /api/graph both use. Must run AFTER
// Phase 6 (ingestAllWallets) — the graph search reads MoneyFlowEdge rows,
// which only exist once the graph-demo scenario's txs have been ingested.
// ---------------------------------------------------------------------------

async function seedGraphDemoSearch(): Promise<{ searchId: string; status: string; nodeCount: number; edgeCount: number }> {
  const search = await prisma.walletGraphSearch.create({
    data: {
      rootAddress: GRAPH_DEMO_ROOT_ADDRESS,
      chain: 'SOLANA',
      mode: 'CAPITAL_FLOW',
      params: { maxDepth: 3 },
      status: 'queued',
      nodeCount: 0,
      edgeCount: 0
    }
  });

  const result = await runGraphSearch(prisma, search.id);
  log('seeded demo WalletGraphSearch (CAPITAL_FLOW, depth 3, rooted at GRAPH_DEMO_ROOT_ADDRESS).', {
    searchId: search.id,
    ...result
  });
  return { searchId: search.id, ...result };
}

// ---------------------------------------------------------------------------
// Phase 8: self-check
// ---------------------------------------------------------------------------

interface SelfCheckRow {
  check: string;
  expected: string;
  actual: string;
  pass: boolean;
  /**
   * True for a check whose numeric target is structurally unreachable given
   * ALREADY-COMMITTED, ALREADY-REVIEWED upstream work this task cannot touch
   * — not a defect in this task's own seed.ts. The printed table still shows
   * the row's true PASS/FAIL against the brief's literal numeric target
   * (never fudged); this flag only affects whether the row counts toward
   * the process's exit code, mirroring the "still pass but report
   * DONE_WITH_CONCERNS" treatment the brief specifies for NOVA's 60-70
   * flowScore band. As of the Task 15 semantic-gap fix pass, NO check
   * currently sets this (the 4 signal self-checks that previously used it —
   * NOVA/QUIET/SEED/DUMP — are now hard requirements; see the signal
   * self-checks section below). Kept on the shape for a future check that
   * may need the identical carve-out pattern again.
   */
  structurallyCapped?: boolean;
}

type SignalsByToken = Map<string, { symbol: string; fired: { rule: string; severity: string }[] }>;

async function runSelfCheck(
  world: MockWorld,
  signalsByToken: SignalsByToken,
  graphDemoSearchId: string,
  backtestResult: { signalsEvaluated: number; rowsUpserted: number; labelCounts: Record<string, number> },
  replayRunResult: Awaited<ReturnType<typeof runHistoricalReplay>>
): Promise<{ rows: SelfCheckRow[]; hardFail: boolean; concerns: string[] }> {
  const rows: SelfCheckRow[] = [];
  const concerns: string[] = [];

  // Bars recalibrated 2026-07-05 (controller): matched to the Task-4 mock world's real scale
  // (~160 wallets, ~920 swap txs, 28 tokens + incidental quote-asset stubs from ingest).
  // If dashboard pages look sparse, densify the world in packages/providers/src/mock/world.ts.
  const walletCount = await prisma.wallet.count();
  const walletsPass = walletCount >= 150;
  rows.push({
    check: 'wallets >= 150 total',
    expected: '>= 150',
    actual: String(walletCount),
    pass: walletsPass
  });

  // >= 28: the 28 world tokens plus any quote-asset stubs ingest correctly auto-creates (e.g. USDC).
  const tokenCount = await prisma.token.count();
  rows.push({
    check: 'tokens >= 28',
    expected: '>= 28',
    actual: String(tokenCount),
    pass: tokenCount >= 28
  });

  const tradeCount = await prisma.walletTokenTrade.count();
  rows.push({
    check: 'trades > 800',
    expected: '> 800',
    actual: String(tradeCount),
    pass: tradeCount > 800
  });

  const snapshotCount = await prisma.tokenMarketSnapshot.count();
  rows.push({
    check: 'market snapshots > 600',
    expected: '> 600',
    actual: String(snapshotCount),
    pass: snapshotCount > 600
  });

  const flowSnapshotCount = await prisma.tokenFlowSnapshot.count();
  rows.push({
    check: 'flow snapshots == 28',
    expected: '28',
    actual: String(flowSnapshotCount),
    pass: flowSnapshotCount === 28
  });

  const csvImportJob = await prisma.importJob.findFirst({
    where: { filename: 'wallets.csv' },
    orderBy: { createdAt: 'desc' }
  });
  const csvOk = csvImportJob !== null && csvImportJob.okRows === 40;
  rows.push({
    check: 'ImportJob for CSV fixture, okRows == 40',
    expected: 'exists, okRows=40',
    actual: csvImportJob ? `okRows=${csvImportJob.okRows}` : 'missing',
    pass: csvOk
  });

  const novaAddress = world.meta.scenarios.nova.tokenAddress;
  const rugzAddress = world.meta.scenarios.rugz.tokenAddress;

  const topFlowSnapshots = await prisma.tokenFlowSnapshot.findMany({
    orderBy: { flowScore: 'desc' },
    take: 5,
    include: { token: { select: { symbol: true, address: true } } }
  });

  // Recalibrated 2026-07-05 (controller): after the window-anchor fix QUIET
  // legitimately scores ~even with NOVA (88.0 vs 87.9). The demo guarantee is
  // that the two flagship scenarios dominate — not their mutual 0.1-pt order.
  const novaSnapshot = topFlowSnapshots.find((s) => s.token.address === novaAddress);
  const novaScore = novaSnapshot?.flowScore ?? -1;
  const topTwoSymbols = topFlowSnapshots.slice(0, 2).map((s) => s.token.symbol).sort();
  const topTwoAreFlagships = topTwoSymbols.join('+') === 'NOVA+QUIET';
  rows.push({
    check: 'top-2 flowScores are {NOVA, QUIET} (order free) AND NOVA >= 70',
    expected: 'top2={NOVA,QUIET}, NOVA >= 70',
    actual: `top2={${topTwoSymbols.join(',')}}, NOVA=${novaScore.toFixed(1)}`,
    pass: topTwoAreFlagships && novaScore >= 70
  });

  const rugzToken = await prisma.token.findFirst({ where: { address: rugzAddress } });
  const rugzFlags = Array.isArray(rugzToken?.riskFlags) ? (rugzToken!.riskFlags as unknown[]) : [];
  const rugzHasFlags = rugzFlags.length > 0;
  rows.push({
    check: 'RUGZ riskFlags non-empty',
    expected: '> 0 flags',
    actual: `${rugzFlags.length} flags`,
    pass: rugzHasFlags
  });

  // ---------------------------------------------------------------------
  // Signal self-checks (Task 15 brief; HARD requirements per the Task 15
  // semantic-gap fix pass — see task-15-report.md's "Fix report" section):
  // NOVA >= {A(HIGH), C, D(HIGH)}; QUIET >= {B}; SEED >= {E}; DUMP >= {G};
  // no F anywhere. These were PREVIOUSLY marked structurallyCapped (excluded
  // from hardFail) because the 3 scenario gaps (NOVA/C, QUIET/B, DUMP/G)
  // were root-caused as unreachable without touching aggregateWindow/rule
  // semantics or Task 4's scenario timing. Task 15's fix pass resolved all
  // 3 root causes directly (Rule C's human-or-smart union ratio, holder-
  // based exit metrics so DUMP's accumulate-then-dump-much-later shape is
  // measurable, QUIET's growth arc compressed to fit a 24h lookback), so
  // there is no longer any structural carve-out for any of these checks —
  // every one below is now a genuine hard requirement whose failure fails
  // the seed script's exit code, exactly like the market-snapshot/flow-
  // snapshot/CSV-import/RUGZ checks above. A scenario's fired-rule set for
  // its OWN token is looked up by symbol (perToken entries carry `symbol`,
  // keyed by tokenId — cheaper than re-deriving tokenId from
  // world.meta.scenarios' addresses via another DB round trip).
  // ---------------------------------------------------------------------
  function firedRulesFor(symbol: string): { rule: string; severity: string }[] {
    for (const entry of signalsByToken.values()) {
      if (entry.symbol === symbol) return entry.fired;
    }
    return [];
  }

  function checkSupersetOf(label: string, symbol: string, expectedRules: { rule: string; severity?: string }[]): void {
    const fired = firedRulesFor(symbol);
    const missing = expectedRules.filter(
      (exp) => !fired.some((f) => f.rule === exp.rule && (exp.severity === undefined || f.severity === exp.severity))
    );
    const actualDesc = fired.length > 0 ? fired.map((f) => `${f.rule}(${f.severity})`).join(',') : 'none fired';
    const expectedDesc = expectedRules.map((e) => (e.severity ? `${e.rule}(${e.severity})` : e.rule)).join(',');
    const pass = missing.length === 0;
    rows.push({
      check: label,
      expected: `>= {${expectedDesc}}`,
      actual: actualDesc,
      pass
    });
    if (missing.length > 0) {
      const missingDesc = missing.map((m) => (m.severity ? `${m.rule}(${m.severity})` : m.rule)).join(',');
      concerns.push(
        `${label} — missing ${missingDesc}. ${symbol} actually fired: ${actualDesc}. This is now a HARD requirement (Task 15 fix pass resolved the prior root cause) — investigate before loosening any rule threshold.`
      );
    }
  }

  checkSupersetOf('NOVA signals >= {A(HIGH), C, D(HIGH)}', 'NOVA', [
    { rule: 'A', severity: 'HIGH' },
    { rule: 'C' },
    { rule: 'D', severity: 'HIGH' }
  ]);
  checkSupersetOf('QUIET signals >= {B}', 'QUIET', [{ rule: 'B' }]);
  checkSupersetOf('SEED signals >= {E}', 'SEED', [{ rule: 'E' }]);
  checkSupersetOf('DUMP signals >= {G}', 'DUMP', [{ rule: 'G' }]);
  checkSupersetOf('BETA signals >= {F}', 'BETA', [{ rule: 'F' }]);

  // Task 23 (this task) supersedes the prior "no F anywhere" self-check: the
  // rotation matcher now exists and Task 4's ALPHA->BETA scenario is
  // SPECIFICALLY shaped to trigger it (a wallet exits ALPHA profitably,
  // bridges the proceeds via Wormhole, the BSC-side wallet buys BETA within
  // the re-buy window). "F fires nowhere" is no longer the correct
  // invariant — "F fires on BETA and ONLY BETA" is (every OTHER scenario's
  // token is deliberately NOT shaped to produce a qualifying
  // RotationCandidate, so F firing anywhere else would indicate a
  // false-positive rotation match, not intended behavior).
  const tokensWhereFFired = [...signalsByToken.values()]
    .filter((entry) => entry.fired.some((f) => f.rule === 'F'))
    .map((entry) => entry.symbol);
  const fFiresOnBetaOnly = tokensWhereFFired.length === 1 && tokensWhereFFired[0] === 'BETA';
  rows.push({
    check: 'F fires on BETA exactly (rotation matcher — Task 23; supersedes the old "no F anywhere" check)',
    expected: 'fired only for BETA',
    actual: tokensWhereFFired.length > 0 ? `fired for: ${tokensWhereFFired.join(', ')}` : 'fired nowhere',
    pass: fFiresOnBetaOnly
  });

  // ---------------------------------------------------------------------
  // Entity-clustering self-checks (Task 22 binding decision 6): NOVA's
  // 18-wallet single-funder cluster (packages/providers/src/mock/
  // scenarios.ts's buildNova) must surface as >=1 EntityCluster with >=15
  // members and confidence >=61, AND NOVA's latest TokenFlowSnapshot must
  // show uniqueEntityCount < smartWalletCount (raw vs unique DIVERGE) — this
  // requires the flow-scoring pass to have been RE-RUN after clustering
  // (Phase 7.6, main()) so aggregateWindow's EntityClusterWallet read picks
  // up the freshly-stamped memberships.
  // ---------------------------------------------------------------------
  const largestCluster = await prisma.entityCluster.findFirst({
    orderBy: { walletCount: 'desc' }
  });
  const largestClusterOk = (largestCluster?.walletCount ?? 0) >= 15 && (largestCluster?.confidence ?? 0) >= 61;
  rows.push({
    check: 'largest EntityCluster has >=15 members and confidence >=61 (NOVA single-funder cluster)',
    expected: 'walletCount >= 15, confidence >= 61',
    actual: largestCluster
      ? `walletCount=${largestCluster.walletCount}, confidence=${largestCluster.confidence.toFixed(1)}`
      : 'no EntityCluster rows',
    pass: largestClusterOk
  });

  const novaFlowSnapshot = await prisma.tokenFlowSnapshot.findFirst({
    where: { token: { address: novaAddress } },
    orderBy: { ts: 'desc' }
  });
  const novaRawCount = novaFlowSnapshot?.smartWalletCount ?? -1;
  const novaUniqueCount = novaFlowSnapshot?.uniqueEntityCount ?? -1;
  const novaDivergenceOk = novaFlowSnapshot !== null && novaUniqueCount < novaRawCount;
  rows.push({
    check: 'NOVA TokenFlowSnapshot uniqueEntityCount < smartWalletCount (raw vs unique diverge post-clustering)',
    expected: 'uniqueEntityCount < smartWalletCount',
    actual: novaFlowSnapshot ? `raw(smartWalletCount)=${novaRawCount}, unique(uniqueEntityCount)=${novaUniqueCount}` : 'no NOVA TokenFlowSnapshot found',
    pass: novaDivergenceOk
  });

  // ---------------------------------------------------------------------
  // Profit-rotation self-check (Task 23 binding decision: "a
  // ProfitRotationSignal row exists (source ALPHA-side wallet, dest
  // BETA-side, bridged true)") — runProfitRotation runs as part of
  // runSignalDetectionPass (packages/db/src/signals.ts), so by the time
  // this self-check runs (after the signal-detection re-pass above), the
  // ALPHA->BETA scenario's rotation should already be persisted.
  // ---------------------------------------------------------------------
  const alphaBetaHandle = world.meta.scenarios.alphaToBeta;
  const rotationRow = await prisma.profitRotationSignal.findFirst({
    where: {
      sourceToken: { address: alphaBetaHandle.alphaTokenAddress },
      destToken: { address: alphaBetaHandle.betaTokenAddress }
    },
    include: { sourceWallet: true, destWallet: true }
  });
  const rotationRowOk =
    rotationRow !== null &&
    rotationRow.sourceWallet.address === alphaBetaHandle.sourceWallet &&
    rotationRow.destWallet.address === alphaBetaHandle.destWallet &&
    rotationRow.chainPath.includes('SOLANA') &&
    rotationRow.chainPath.includes('BSC') &&
    rotationRow.chainPath.length >= 2;
  rows.push({
    check: 'ProfitRotationSignal row exists: source=ALPHA-side wallet, dest=BETA-side wallet, bridged (chainPath includes SOLANA+BSC)',
    expected: 'exists, source/dest wallets match scenario, chainPath=[SOLANA,BSC]-shaped',
    actual: rotationRow
      ? `chainPath=${JSON.stringify(rotationRow.chainPath)}, sourceWallet match=${rotationRow.sourceWallet.address === alphaBetaHandle.sourceWallet}, destWallet match=${rotationRow.destWallet.address === alphaBetaHandle.destWallet}`
      : 'no ProfitRotationSignal row found for ALPHA->BETA',
    pass: rotationRowOk
  });

  // ---------------------------------------------------------------------
  // Alert self-checks (Task 16 binding decision 7): "Alert rows exist for
  // every seeded signal, all 'skipped_no_token', payload text non-empty
  // containing '$NOVA' for the NOVA A alert; print alert count." — this
  // runs AFTER dispatchPendingAlerts(prisma, settings, null, ...) (Phase
  // 7.75, main()), which by construction gives every Signal row exactly one
  // Alert row (see packages/db/src/alerts.ts's file header: "Every Signal
  // this pass ever looks at ends up with EXACTLY ONE Alert row").
  // ---------------------------------------------------------------------
  // Task 23 update: dispatchPendingAlerts now ALSO drains ProfitRotationSignal
  // rows into their own type=ROTATION Alert rows (see this file's "ROTATION
  // alert self-check" above) — these are NOT backed by a Signal row at all
  // (ProfitRotationSignal has no relation to Signal), so the "one Alert per
  // pending item" invariant now spans TWO source tables, not one. The correct
  // total is Signal count + ProfitRotationSignal count, not Signal count alone.
  const totalSignalCount = await prisma.signal.count();
  const totalRotationSignalCount = await prisma.profitRotationSignal.count();
  const totalAlertCount = await prisma.alert.count();
  const expectedAlertCount = totalSignalCount + totalRotationSignalCount;
  rows.push({
    check: 'Alert row count == Signal row count + ProfitRotationSignal row count (every seeded signal/rotation got exactly one alert)',
    expected: `== ${expectedAlertCount} (${totalSignalCount} signals + ${totalRotationSignalCount} rotations)`,
    actual: String(totalAlertCount),
    pass: totalAlertCount === expectedAlertCount
  });

  const nonSkippedAlerts = await prisma.alert.count({ where: { deliveryStatus: { not: 'skipped_no_token' } } });
  rows.push({
    check: "every Alert row is deliveryStatus 'skipped_no_token' (seed dispatches with a null sender)",
    expected: '0 alerts with any other deliveryStatus',
    actual: `${nonSkippedAlerts} alert(s) with a different deliveryStatus`,
    pass: nonSkippedAlerts === 0
  });

  const novaAlertA = await prisma.alert.findFirst({
    where: { token: { address: novaAddress }, rule: 'A' },
    orderBy: { sentAt: 'desc' }
  });
  const novaAlertPayload = novaAlertA?.payload as { text?: string } | undefined;
  const novaAlertText = novaAlertPayload?.text ?? '';
  const novaAlertOk = novaAlertText.length > 0 && novaAlertText.includes('$NOVA');
  rows.push({
    check: "NOVA rule-A Alert payload.text is non-empty and contains '$NOVA'",
    expected: 'non-empty, contains "$NOVA"',
    actual: novaAlertA ? `${novaAlertText.length} chars, contains $NOVA: ${novaAlertText.includes('$NOVA')}` : 'no Alert row found',
    pass: novaAlertOk
  });

  // ---------------------------------------------------------------------
  // ROTATION alert self-check (Task 23 binding decision 4): the
  // ALPHA->BETA ProfitRotationSignal row above must have produced exactly
  // one type=ROTATION Alert row (deliveryStatus 'skipped_no_token', same as
  // every other seeded alert — see the "every Alert row is
  // deliveryStatus 'skipped_no_token'" check above, which already covers
  // ROTATION rows too since it counts across the WHOLE Alert table).
  // ---------------------------------------------------------------------
  const rotationAlert = rotationRow
    ? await prisma.alert.findFirst({ where: { rotationSignalId: rotationRow.id } })
    : null;
  const rotationAlertPayload = rotationAlert?.payload as { text?: string } | undefined;
  const rotationAlertText = rotationAlertPayload?.text ?? '';
  const rotationAlertOk =
    rotationAlert !== null &&
    rotationAlert.type === 'ROTATION' &&
    rotationAlert.deliveryStatus === 'skipped_no_token' &&
    rotationAlertText.length > 0;
  rows.push({
    check: "ROTATION Alert row exists for the ALPHA->BETA ProfitRotationSignal (type ROTATION, deliveryStatus 'skipped_no_token')",
    expected: "exists, type=ROTATION, deliveryStatus='skipped_no_token', non-empty payload.text",
    actual: rotationAlert
      ? `type=${rotationAlert.type}, deliveryStatus=${rotationAlert.deliveryStatus}, textLen=${rotationAlertText.length}`
      : 'no ROTATION Alert row found',
    pass: rotationAlertOk
  });

  // ---------------------------------------------------------------------
  // Graph-demo self-check (Task 20 binding decision 7): the demo
  // WalletGraphSearch seeded in Phase 7.9 (seedGraphDemoSearch) must have
  // reached a terminal non-failed status, discovered >= 4 nodes, and include
  // both the graph-demo's router and CEX counterparties as non-expanded
  // nodes (both are AddressRegistry rows with doNotExpand=true — see
  // bootstrapAddressRegistry above — so they must appear in the node set
  // without ever being expanded further), plus at least one extracted
  // TransactionPath.
  // ---------------------------------------------------------------------
  const graphSearch = await prisma.walletGraphSearch.findUnique({
    where: { id: graphDemoSearchId },
    include: { nodes: true, edges: true }
  });
  const graphStatusOk = graphSearch?.status === 'done' || graphSearch?.status === 'truncated';
  rows.push({
    check: 'graph-demo WalletGraphSearch status is done|truncated',
    expected: 'done|truncated',
    actual: graphSearch?.status ?? 'not found',
    pass: graphStatusOk
  });

  const graphNodeCount = graphSearch?.nodes.length ?? 0;
  rows.push({
    check: 'graph-demo search nodeCount >= 4',
    expected: '>= 4',
    actual: String(graphNodeCount),
    pass: graphNodeCount >= 4
  });

  const graphNodeAddresses = new Set((graphSearch?.nodes ?? []).map((n) => n.address));
  const routerAddress = world.meta.scenarios.graphDemo.routerCounterparty;
  const cexAddress = world.meta.scenarios.graphDemo.cexCounterparty;
  const includesRouterAndCex = graphNodeAddresses.has(routerAddress) && graphNodeAddresses.has(cexAddress);
  rows.push({
    check: 'graph-demo search includes router + CEX counterparty nodes',
    expected: 'both present',
    actual: `router present=${graphNodeAddresses.has(routerAddress)}, cex present=${graphNodeAddresses.has(cexAddress)}`,
    pass: includesRouterAndCex
  });

  const graphPathCount = Array.isArray((graphSearch?.resultSummary as { paths?: unknown[] } | null)?.paths)
    ? ((graphSearch!.resultSummary as { paths: unknown[] }).paths.length)
    : 0;
  rows.push({
    check: 'graph-demo search found >= 1 TransactionPath',
    expected: '>= 1',
    actual: String(graphPathCount),
    pass: graphPathCount >= 1
  });

  // ---------------------------------------------------------------------
  // Backtest self-checks (Task 40 binding decision 3): "BacktestResult rows
  // exist for seeded signals (count > 0), every row has outcomeLabel, at
  // least one signal labeled non-neutral ... if ALL neutral_pending,
  // investigate series coverage before accepting." runBacktestPass has
  // already run by the time this self-check executes (see main(), Phase
  // 7.95) — these checks read the persisted BacktestResult rows directly
  // rather than re-deriving from backtestResult's own in-memory summary, so
  // a bug in the upsert path itself (not just the evaluator) would surface
  // here too.
  // ---------------------------------------------------------------------
  const backtestRowCount = await prisma.backtestResult.count();
  rows.push({
    check: 'BacktestResult rows exist for seeded signals (count > 0)',
    expected: '> 0',
    actual: String(backtestRowCount),
    pass: backtestRowCount > 0
  });

  const backtestRowsMissingLabel = await prisma.backtestResult.count({ where: { outcomeLabel: null } });
  rows.push({
    check: 'every BacktestResult row has a non-null outcomeLabel',
    expected: '0 rows missing outcomeLabel',
    actual: `${backtestRowsMissingLabel} row(s) missing outcomeLabel`,
    pass: backtestRowsMissingLabel === 0
  });

  const nonNeutralLabelCount = Object.entries(backtestResult.labelCounts)
    .filter(([label]) => label !== 'neutral_pending')
    .reduce((sum, [, count]) => sum + count, 0);
  const labelDistributionDesc = Object.entries(backtestResult.labelCounts)
    .map(([label, count]) => `${label}=${count}`)
    .join(', ') || '(no signals evaluated)';
  rows.push({
    check: 'at least one evaluated signal labeled non-neutral (label distribution: see below)',
    expected: '>= 1 non-neutral_pending signal',
    actual: `${nonNeutralLabelCount} non-neutral of ${backtestResult.signalsEvaluated} evaluated; distribution: ${labelDistributionDesc}`,
    pass: nonNeutralLabelCount >= 1
  });
  if (nonNeutralLabelCount === 0 && backtestResult.signalsEvaluated > 0) {
    concerns.push(
      `Backtest label distribution is 100% neutral_pending across ${backtestResult.signalsEvaluated} evaluated signal(s) — investigate TokenMarketSnapshot series coverage for seeded signals before accepting (the mock world's NOVA/QUIET trajectories should produce measurable post-trigger movement).`
    );
  }

  // ---------------------------------------------------------------------
  // BacktestRun self-check (Task 42 binding decision 6): "BacktestRun exists
  // with summary.rulePerformance non-empty + syntheticEvidence true (mock
  // world) + page-critical fields present." Reads the JUST-CREATED replay
  // run's own persisted row back from the DB (rather than trusting the
  // in-memory replayRunResult alone) so a bug in runHistoricalReplay's own
  // persistence step (not just its pure-function pipeline) would surface
  // here too — same "read the DB, don't just trust the in-memory summary"
  // precedent the backtest self-checks above already follow.
  // ---------------------------------------------------------------------
  const persistedRun = await prisma.backtestRun.findUnique({ where: { id: replayRunResult.backtestRunId } });
  const persistedRunExists = persistedRun !== null && persistedRun.status === 'complete';
  rows.push({
    check: 'BacktestRun row exists (status=complete) for the seed-time replay run',
    expected: 'exists, status=complete',
    actual: persistedRun ? `status=${persistedRun.status}` : 'missing',
    pass: persistedRunExists
  });

  const persistedSummary = persistedRun?.summary as
    | { rulePerformance?: Record<string, unknown>; walkForward?: unknown; thresholdTuning?: unknown; bucketPerformance?: unknown }
    | null
    | undefined;
  const rulePerformanceKeys = persistedSummary?.rulePerformance ? Object.keys(persistedSummary.rulePerformance) : [];
  const rulePerformanceNonEmpty = rulePerformanceKeys.length > 0;
  rows.push({
    check: 'BacktestRun.summary.rulePerformance is non-empty (all 7 rule keys present)',
    expected: '7 rule keys (A-G)',
    actual: `${rulePerformanceKeys.length} key(s): ${rulePerformanceKeys.join(',') || '(none)'}`,
    pass: rulePerformanceNonEmpty
  });

  const pageCriticalFieldsPresent =
    persistedSummary?.walkForward !== undefined &&
    persistedSummary?.thresholdTuning !== undefined &&
    persistedSummary?.bucketPerformance !== undefined;
  rows.push({
    check: 'BacktestRun.summary carries every /backtest page-critical field (walkForward, thresholdTuning, bucketPerformance)',
    expected: 'all 3 present',
    actual: `walkForward=${persistedSummary?.walkForward !== undefined}, thresholdTuning=${persistedSummary?.thresholdTuning !== undefined}, bucketPerformance=${persistedSummary?.bucketPerformance !== undefined}`,
    pass: pageCriticalFieldsPresent
  });

  rows.push({
    check: 'BacktestRun.syntheticEvidence is true (mock world — every seeded market series is synthetic)',
    expected: 'true',
    actual: String(persistedRun?.syntheticEvidence ?? 'missing'),
    pass: persistedRun?.syntheticEvidence === true
  });

  // Hard-fail checks (brief: "exit code 1 if any fails") exclude only the
  // NOVA 60-70 flowScore band (the brief's own explicit "still pass but
  // flag" carve-out, handled separately above via `concerns.push` while
  // keeping `pass: true` — it never sets `structurallyCapped`). As of the
  // Task 15 semantic-gap fix pass, NO row sets `structurallyCapped: true`
  // anymore: the 4 signal self-checks (NOVA/QUIET/SEED/DUMP) that previously
  // used that carve-out are now genuine hard requirements (see the signal
  // self-checks section above), same as market snapshots, flow snapshots,
  // CSV import okRows, and RUGZ risk flags. `structurallyCapped` stays on
  // the SelfCheckRow shape/print-table handling in case a future task needs
  // the identical carve-out pattern again, but nothing currently uses it.
  const hardFail = rows.some((r) => !r.pass && !r.structurallyCapped);

  return { rows, hardFail, concerns };
}

// ---------------------------------------------------------------------------
// Phase 9: summary table
// ---------------------------------------------------------------------------

function printSelfCheckTable(rows: SelfCheckRow[]): void {
  const colWidths = {
    check: Math.max(...rows.map((r) => r.check.length), 'CHECK'.length),
    expected: Math.max(...rows.map((r) => r.expected.length), 'EXPECTED'.length),
    actual: Math.max(...rows.map((r) => r.actual.length), 'ACTUAL'.length)
  };
  const pad = (s: string, width: number) => s.padEnd(width);
  console.log('');
  console.log('Self-check:');
  console.log(`  ${pad('CHECK', colWidths.check)}  ${pad('EXPECTED', colWidths.expected)}  ${pad('ACTUAL', colWidths.actual)}  RESULT`);
  for (const r of rows) {
    let result: string;
    if (r.pass) {
      result = 'PASS';
    } else if (r.structurallyCapped) {
      result = 'FAIL (structural — see concerns)';
    } else {
      result = 'FAIL';
    }
    console.log(`  ${pad(r.check, colWidths.check)}  ${pad(r.expected, colWidths.expected)}  ${pad(r.actual, colWidths.actual)}  ${result}`);
  }
  console.log('');
}

/** Prints a token x rules x severities table for every token that fired >=1 rule this signal pass. */
function printSignalSummaryTable(signalsByToken: SignalsByToken): void {
  const withSignals = [...signalsByToken.values()]
    .filter((entry) => entry.fired.length > 0)
    .sort((a, b) => a.symbol.localeCompare(b.symbol));

  console.log('Signal summary (token x fired rules x severities):');
  if (withSignals.length === 0) {
    console.log('  (no tokens fired any rule this pass)');
    console.log('');
    return;
  }

  const symbolWidth = Math.max(...withSignals.map((e) => e.symbol.length), 'TOKEN'.length);
  console.log(`  ${'TOKEN'.padEnd(symbolWidth)}  RULES (severity)`);
  for (const entry of withSignals) {
    const ruleDesc = entry.fired.map((f) => `${f.rule}(${f.severity})`).join(', ');
    console.log(`  ${entry.symbol.padEnd(symbolWidth)}  ${ruleDesc}`);
  }
  console.log('');
}

/** Prints the demo WalletGraphSearch's own summary: status, node/edge/path counts, node-type breakdown. */
async function printGraphSummary(searchId: string): Promise<void> {
  const search = await prisma.walletGraphSearch.findUnique({
    where: { id: searchId },
    include: { nodes: true, edges: true }
  });
  if (!search) {
    console.log('Graph-demo search summary: (not found)');
    console.log('');
    return;
  }

  const pathCount = Array.isArray((search.resultSummary as { paths?: unknown[] } | null)?.paths)
    ? (search.resultSummary as { paths: unknown[] }).paths.length
    : 0;

  const nodeTypeCounts = new Map<string, number>();
  for (const n of search.nodes) {
    nodeTypeCounts.set(n.nodeType, (nodeTypeCounts.get(n.nodeType) ?? 0) + 1);
  }
  const nodeTypeDesc = [...nodeTypeCounts.entries()].map(([t, c]) => `${t}=${c}`).join(', ');

  console.log('Graph-demo search summary:');
  console.log(`  searchId:    ${search.id}`);
  console.log(`  rootAddress: ${search.rootAddress}`);
  console.log(`  status:      ${search.status}`);
  console.log(`  nodes:       ${search.nodes.length} (${nodeTypeDesc})`);
  console.log(`  edges:       ${search.edges.length}`);
  console.log(`  paths:       ${pathCount}`);
  console.log('');
}

/** Prints the entity-clustering pass's own summary: cluster count, largest cluster size, NOVA raw vs unique counts (Task 22). */
async function printClusterSummary(novaAddress: string): Promise<void> {
  const clusterCount = await prisma.entityCluster.count();
  const largestCluster = await prisma.entityCluster.findFirst({ orderBy: { walletCount: 'desc' } });
  const novaFlowSnapshot = await prisma.tokenFlowSnapshot.findFirst({
    where: { token: { address: novaAddress } },
    orderBy: { ts: 'desc' }
  });

  console.log('Entity-clustering summary:');
  console.log(`  clusters created:       ${clusterCount}`);
  console.log(
    `  largest cluster:        ${largestCluster ? `${largestCluster.walletCount} members, confidence=${largestCluster.confidence.toFixed(1)}` : '(none)'}`
  );
  console.log(
    `  NOVA raw vs unique:     smartWalletCount(raw)=${novaFlowSnapshot?.smartWalletCount ?? 'n/a'}, uniqueEntityCount(unique)=${novaFlowSnapshot?.uniqueEntityCount ?? 'n/a'}`
  );
  console.log('');
}

/** Prints the backtest pass's own summary: signals evaluated, rows upserted, and the label distribution across this pass (Task 40). */
function printBacktestSummary(result: { signalsConsidered: number; signalsEvaluated: number; rowsUpserted: number; labelCounts: Record<string, number> }): void {
  console.log('Backtest summary:');
  console.log(`  signals considered:  ${result.signalsConsidered}`);
  console.log(`  signals evaluated:   ${result.signalsEvaluated}`);
  console.log(`  BacktestResult rows: ${result.rowsUpserted}`);
  console.log('  label distribution:');
  const labels = ['major_win', 'good_win', 'small_win', 'neutral_pending', 'failure', 'hard_failure'];
  for (const label of labels) {
    const count = result.labelCounts[label] ?? 0;
    if (count > 0) {
      console.log(`    ${label.padEnd(16)} ${count}`);
    }
  }
  const knownLabels = new Set(labels);
  for (const [label, count] of Object.entries(result.labelCounts)) {
    if (!knownLabels.has(label)) {
      console.log(`    ${label.padEnd(16)} ${count}`);
    }
  }
  console.log('');
}

/** Prints the seed-time historical-replay run's own summary (Task 42 binding decision 6) so /backtest's expected content is visible directly in seed output. */
function printReplayRunSummary(result: Awaited<ReturnType<typeof runHistoricalReplay>>): void {
  console.log('Historical replay run summary (feeds /backtest page):');
  console.log(`  BacktestRun id:          ${result.backtestRunId}`);
  console.log(`  replayed signal count:   ${result.summary.replayedSignalCount}`);
  console.log(`  synthetic evidence:      ${result.summary.syntheticEvidencePresent}`);
  console.log(`  walk-forward verdict:    ${result.summary.walkForward.verdict}`);
  console.log(`  overfitting warning:     ${result.summary.thresholdTuning.overfittingWarning.slice(0, 80)}...`);
  console.log('');
}

async function printSummaryTable(): Promise<void> {
  const [wallets, tokens, trades, snapshots, flowSnapshots, addressRegistry, csvImportJob, signals, alerts] = await Promise.all([
    prisma.wallet.count(),
    prisma.token.count(),
    prisma.walletTokenTrade.count(),
    prisma.tokenMarketSnapshot.count(),
    prisma.tokenFlowSnapshot.count(),
    prisma.addressRegistry.count(),
    prisma.importJob.findFirst({ where: { filename: 'wallets.csv' }, orderBy: { createdAt: 'desc' } }),
    prisma.signal.count(),
    prisma.alert.count()
  ]);

  const top5 = await prisma.tokenFlowSnapshot.findMany({
    orderBy: { flowScore: 'desc' },
    take: 5,
    include: { token: { select: { symbol: true } } }
  });

  console.log('Seed summary:');
  console.log(`  wallets:              ${wallets}`);
  console.log(`  tokens:               ${tokens}`);
  console.log(`  trades:               ${trades}`);
  console.log(`  market snapshots:     ${snapshots}`);
  console.log(`  flow snapshots:       ${flowSnapshots}`);
  console.log(`  address registry:     ${addressRegistry}`);
  console.log(`  CSV import (okRows):  ${csvImportJob?.okRows ?? 'n/a'}`);
  console.log(`  signals:              ${signals}`);
  console.log(`  alerts:               ${alerts}`);
  console.log('');
  console.log('  Top 5 tokens by flowScore:');
  top5.forEach((s, i) => {
    console.log(`    ${i + 1}. ${s.token.symbol.padEnd(8)} flowScore=${s.flowScore.toFixed(1)}`);
  });
  console.log('');
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  loadEnv();
  const startedAt = Date.now();

  await wipeAllTables();

  await bootstrapChains();
  const settings = await bootstrapSettings();

  const genesis = new Date(Date.now() - WORLD_HORIZON_HOURS * HOUR_MS);
  const world = createMockWorld({ genesis });
  log('built mock world.', {
    genesis: genesis.toISOString(),
    horizon: world.meta.horizon.toISOString(),
    wallets: world.wallets.length,
    tokens: world.tokens.length
  });

  await bootstrapAddressRegistry(world);

  // Token rows must exist before market snapshots / trades can reference
  // them (Token.chain_address is the FK target) — upsert every mock-world
  // token up front (riskFlags persisted here too, per brief item 8's "persist
  // riskFlags from provider getTokenRisk during seed for all tokens").
  const provider = new MockProvider(world, { now: world.meta.horizon });
  const tokenIdByAddress = new Map<string, string>();
  for (const token of world.tokens) {
    const risk = await provider.getTokenRisk(token.chain, token.address);
    const created = await prisma.token.upsert({
      where: { chain_address: { chain: token.chain, address: token.address } },
      create: {
        chain: token.chain,
        address: token.address,
        symbol: token.symbol,
        name: token.name,
        decimals: token.decimals,
        firstSeenAt: token.createdAt,
        tokenCreatedAt: token.createdAt,
        riskFlags: risk.flags as unknown as Prisma.InputJsonValue
      },
      update: { riskFlags: risk.flags as unknown as Prisma.InputJsonValue },
      select: { id: true }
    });
    tokenIdByAddress.set(token.address, created.id);
  }
  log('upserted Token rows + persisted riskFlags.', { count: tokenIdByAddress.size });

  // Phase 4: market snapshots FIRST.
  await seedMarketSnapshots(world, tokenIdByAddress);

  // Phase 5(a): computed WalletStats for smart_money/human_like/whale wallets.
  await seedComputedWalletStats(world);

  // Phase 5(b): CSV import overrides computed rows for its 40 wallets.
  const csvResult = await seedCsvWallets();

  // Phase 6: ingest every wallet's tx stream.
  await ingestAllWallets(world);

  // Phase 7: scoring pass (shared with the worker's flowScoring job — see
  // scoring-pass.ts's file header). Must run BEFORE the signal pass:
  // signals.ts's updateSnapshotSignalStatus() edits the most recent
  // TokenFlowSnapshot row, which this phase is what creates it.
  const scoringResult = await runFlowScoringPass(prisma, settings, () => provider, {
    info: (msg, meta) => log(msg, meta),
    error: (msg, meta) => log(`ERROR: ${msg}`, meta)
  });
  log('flow scoring pass complete.', { ...scoringResult });

  // Phase 7.5: signal pass (Task 15) — shared body with
  // apps/worker/src/jobs/signalDetection.ts, same worker/seed-sharing
  // pattern as the scoring pass above.
  await runSignalDetectionPass(prisma, settings, {
    info: (msg, meta) => log(msg, meta),
    error: (msg, meta) => log(`ERROR: ${msg}`, meta)
  }).then((r) => log('signal detection pass complete.', { ...r.summary }));

  // Phase 7.6: entity clustering pass (Task 22 binding decision 5/6) — shared
  // body with apps/worker/src/jobs/entityClustering.ts. Runs AFTER the signal
  // pass (clustering reads MoneyFlowEdge/WalletTokenTrade rows the signal
  // pass doesn't mutate, so ordering relative to signals is otherwise free,
  // but running it here keeps every "pass" phase grouped together before the
  // alert/graph-demo/self-check phases).
  //
  // Per binding decision 6's documented order (signals -> clustering ->
  // RE-SCORE), the flow-scoring pass is re-run immediately after so
  // uniqueEntityCount reflects the freshly stamped entityClusterId
  // memberships — otherwise TokenFlowSnapshot rows would still show the
  // pre-clustering uniqueEntityCount===smartWalletCount shape from Phase 7
  // and the NOVA raw-vs-unique divergence this task's self-check proves
  // would never appear.
  //
  // TokenFlowSnapshot is an APPEND-ONLY time series in normal (worker-tick)
  // operation — each call legitimately represents a new point in time. A
  // one-shot seed script re-scoring twice within the same conceptual "now"
  // is different: it would leave TWO snapshot rows per token (breaking the
  // "flow snapshots == 28" / "latest 5 by flowScore" self-checks/pages,
  // which assume one authoritative row per token). So the seed script
  // deletes Phase 7's now-superseded snapshot rows before re-scoring, then
  // re-runs signal detection ONE more time (dedupe means no duplicate
  // Signal rows are created — see signals.ts's 24h dedupe window) purely so
  // `updateSnapshotSignalStatus` writes signalStatus onto the NEW
  // post-clustering snapshot row instead of leaving it at the scoring
  // pass's default 'watching'. `signalsByToken` from this SECOND run is
  // what feeds the self-check below (it reflects the exact same fired-rule
  // set as the first run — clustering doesn't change which rules fire,
  // only uniqueEntityCount/entityClusterId — so this is not a second
  // independent signal computation, just re-attaching status to the
  // surviving snapshot row).
  const clusteringResult = await runEntityClustering(prisma, settings, {
    info: (msg, meta) => log(msg, meta),
    error: (msg, meta) => log(`ERROR: ${msg}`, meta)
  });
  log('entity clustering pass complete.', { ...clusteringResult });

  await prisma.tokenFlowSnapshot.deleteMany();

  const rescoringResult = await runFlowScoringPass(prisma, settings, () => provider, {
    info: (msg, meta) => log(msg, meta),
    error: (msg, meta) => log(`ERROR: ${msg}`, meta)
  });
  log('flow re-scoring pass complete (post-clustering).', { ...rescoringResult });

  const { summary: signalResult, perToken: signalsByToken } = await runSignalDetectionPass(prisma, settings, {
    info: (msg, meta) => log(msg, meta),
    error: (msg, meta) => log(`ERROR: ${msg}`, meta)
  });
  log('signal detection re-pass complete (post-clustering, for signalStatus only).', { ...signalResult });

  // Phase 7.75: alert dispatch pass (Task 16 binding decision 7) — shared
  // body with apps/worker/src/jobs/alertDispatch.ts. `sender: null` here
  // (this seed script never reads TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID) is
  // deliberate, not an oversight: a fresh `npm run db:seed` run has no
  // reason to actually deliver Telegram messages to whatever chat the
  // developer's env happens to point at — the point of this phase is to
  // populate every seeded Signal with a real, fully-rendered Alert row
  // (deliveryStatus 'skipped_no_token') so the Alerts page has data to show
  // and the payload text itself is exercised end-to-end, matching Task 16
  // binding decision 5's "MOCK/no-token mode ... the text IS the artifact".
  const alertResult = await dispatchPendingAlerts(prisma, settings, null, {
    info: (msg, meta) => log(msg, meta),
    error: (msg, meta) => log(`ERROR: ${msg}`, meta)
  });
  log('alert dispatch pass complete.', { ...alertResult });

  // Phase 7.9: demo WalletGraphSearch (Task 20 binding decision 7) — must run
  // after Phase 6 (ingestAllWallets), which is what populates the
  // MoneyFlowEdge rows the graph search reads.
  const graphDemoResult = await seedGraphDemoSearch();

  // Phase 7.94: post-signal price continuation (Task 40) — see
  // seedBacktestContinuation's own doc comment above for the full "why":
  // every Signal.triggeredAt lands within seconds of world.meta.horizon (the
  // last hourly point Phase 4 wrote), so without this phase there is
  // ZERO seeded market data after any signal fires and the backtest pass
  // below would legitimately see an empty post-trigger series for every
  // signal. Must run AFTER the signal-detection passes above (it reads
  // Signal.triggeredAt/mcapAtTrigger).
  const continuationResult = await seedBacktestContinuation(tokenIdByAddress, world, { allowSynthetic: true });
  log('seeded post-signal price continuation for backtest evaluation.', continuationResult);

  // Phase 7.95: backtest pass (Task 40 binding decision 3) — shared body with
  // apps/worker/src/jobs/backtest.ts. Must run AFTER the continuation phase
  // above (needs real market data past triggeredAt) and after the
  // signal-detection passes (evaluates existing Signal rows). `now` is
  // pinned past the END of every continuation series (triggeredAt + 7 days +
  // a margin) so every horizon's window (up to D7) is treated as fully
  // elapsed for THIS seed run — a real worker tick instead always passes
  // real wall-clock `now` (see apps/worker/src/jobs/backtest.ts), so most
  // horizons stay legitimately `notes: 'window_incomplete'` until enough
  // real time has passed.
  const latestSignal = await prisma.signal.findFirst({ orderBy: { triggeredAt: 'desc' }, select: { triggeredAt: true } });
  const latestSignalTrigger = latestSignal?.triggeredAt ?? new Date();
  const backtestNow = new Date(latestSignalTrigger.getTime() + (7 * 24 + 1) * 60 * 60 * 1000);
  const backtestResult = await runBacktestPass(prisma, settings, backtestNow, {
    info: (msg, meta) => log(msg, meta),
    error: (msg, meta) => log(`ERROR: ${msg}`, meta)
  });
  log('backtest pass complete.', { ...backtestResult, labelCounts: JSON.stringify(backtestResult.labelCounts) });

  // Phase 7.96: ONE historical-replay run over the seeded 72h period (Task 42
  // binding decision 6) — "after existing passes, run ONE runHistoricalReplay
  // over the seeded period so /backtest renders content out of the box."
  // Replays [genesis, world.meta.horizon] (the exact window every trade/
  // market-snapshot/signal in this seed run was built against) at the
  // default 30-minute step. This is a real (if seed-scoped) no-lookahead
  // replay pass — NOT a second, different data source — so its own
  // syntheticEvidence flag legitimately comes back true here (the mock
  // world's TokenMarketSnapshot rows, plus seedBacktestContinuation's
  // seed_synthetic_continuation rows above, are exactly what Task 41's
  // evaluateReplay flags as synthetic evidence).
  const replayRunResult = await runHistoricalReplay(prisma, { from: genesis, to: world.meta.horizon });
  log('historical replay run complete (seeds /backtest page content).', {
    backtestRunId: replayRunResult.backtestRunId,
    replayedSignalCount: replayRunResult.summary.replayedSignalCount,
    syntheticEvidencePresent: replayRunResult.summary.syntheticEvidencePresent
  });

  // Phase 8: self-check.
  const { rows: selfCheckRows, hardFail, concerns } = await runSelfCheck(
    world,
    signalsByToken,
    graphDemoResult.searchId,
    backtestResult,
    replayRunResult
  );
  printSelfCheckTable(selfCheckRows);
  printSignalSummaryTable(signalsByToken);
  await printGraphSummary(graphDemoResult.searchId);
  await printClusterSummary(world.meta.scenarios.nova.tokenAddress);
  printBacktestSummary(backtestResult);
  printReplayRunSummary(replayRunResult);

  // Phase 9: summary table.
  await printSummaryTable();

  const durationMs = Date.now() - startedAt;
  log('seed complete.', { durationMs, csvOkRows: csvResult.okRows });

  if (concerns.length > 0) {
    console.log('');
    console.log(hardFail ? '[seed] DONE_WITH_CONCERNS (also has hard self-check failures below):' : '[seed] DONE_WITH_CONCERNS:');
    for (const c of concerns) {
      console.log(`  - ${c}`);
      console.log('');
    }
  }

  if (hardFail) {
    console.error('[seed] SELF-CHECK FAILED — see table + concerns above.');
    process.exitCode = 1;
  }
}

// Guarded so this file is safely importable (e.g. by
// packages/db/test/backtest.test.ts, which imports seedBacktestContinuation
// to test its defense-in-depth guard) without triggering a full seed run as
// a side effect of the import — `npm run db:seed`'s `tsx src/seed.ts`
// invocation is still the only thing that ever sets import.meta.main here.
if (import.meta.main) {
  main()
    .catch((err) => {
      console.error('[seed] fatal error:', err);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
