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
import { createMockWorld, MockProvider } from '@flowradar/providers';
import type { MockWorld } from '@flowradar/providers';
import type { Prisma } from '@prisma/client';
import { prisma } from './client';
import { ingestNormalizedTxs, snapshotMarket } from './ingest';
import { runFlowScoringPass } from './scoring-pass';
import { runSignalDetectionPass } from './signals';
import { importWalletsCsv } from './csv/importWalletsCsv';

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
  signalsByToken: SignalsByToken
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

  const novaSnapshot = topFlowSnapshots.find((s) => s.token.address === novaAddress);
  const novaIsHighest = topFlowSnapshots[0]?.token.address === novaAddress;
  const novaScore = novaSnapshot?.flowScore ?? -1;
  const novaAtLeast60 = novaScore >= 60;
  rows.push({
    check: 'NOVA flowScore strictly highest AND >= 60 (target >= 70)',
    expected: 'highest, >= 60 (target >= 70)',
    actual: `highest=${novaIsHighest}, score=${novaScore.toFixed(1)}`,
    pass: novaIsHighest && novaAtLeast60
  });
  if (novaIsHighest && novaAtLeast60 && novaScore < 70) {
    concerns.push(
      `NOVA flowScore ${novaScore.toFixed(1)} is in the 60-70 "pass but flag" band (target >= 70) — ` +
        `componentBreakdown: ${JSON.stringify(novaSnapshot?.componentBreakdown ?? {})}`
    );
  }

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

  const anyFFired = [...signalsByToken.values()].some((entry) => entry.fired.some((f) => f.rule === 'F'));
  rows.push({
    check: 'no F anywhere (rotation matcher arrives Wave 3 / Task 23)',
    expected: 'F fires nowhere',
    actual: anyFFired ? 'F fired somewhere' : 'F fired nowhere',
    pass: !anyFFired
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

async function printSummaryTable(): Promise<void> {
  const [wallets, tokens, trades, snapshots, flowSnapshots, addressRegistry, csvImportJob] = await Promise.all([
    prisma.wallet.count(),
    prisma.token.count(),
    prisma.walletTokenTrade.count(),
    prisma.tokenMarketSnapshot.count(),
    prisma.tokenFlowSnapshot.count(),
    prisma.addressRegistry.count(),
    prisma.importJob.findFirst({ where: { filename: 'wallets.csv' }, orderBy: { createdAt: 'desc' } })
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
  const { summary: signalResult, perToken: signalsByToken } = await runSignalDetectionPass(prisma, settings, {
    info: (msg, meta) => log(msg, meta),
    error: (msg, meta) => log(`ERROR: ${msg}`, meta)
  });
  log('signal detection pass complete.', { ...signalResult });

  // Phase 8: self-check.
  const { rows: selfCheckRows, hardFail, concerns } = await runSelfCheck(world, signalsByToken);
  printSelfCheckTable(selfCheckRows);
  printSignalSummaryTable(signalsByToken);

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

main()
  .catch((err) => {
    console.error('[seed] fatal error:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
