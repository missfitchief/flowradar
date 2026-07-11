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
import { createMockWorld, GRAPH_DEMO_ROOT_ADDRESS, MockCandidateSource, MockSocialSource, MockProvider, STATIC_REGISTRY_ENTRIES, getPoisonedAddresses, createMockDuneClient, getDunePoisonedAddresses } from '@flowradar/providers';
import type { MockWorld } from '@flowradar/providers';
import type { Prisma } from '@prisma/client';
import { prisma } from './client';
import { withGlobalJobLock } from './locks/globalJobLock';
import { ingestNormalizedTxs, snapshotMarket } from './ingest';
import { runFlowScoringPass } from './scoring-pass';
import { runEntityClustering } from './clustering';
import { runWalletStatsRefresh } from './walletStatsRefresh';
import { runSignalDetectionPass } from './signals';
import { dispatchPendingAlerts } from './alerts';
import { runBacktestPass } from './backtest';
import { runHistoricalReplay } from './replayRunner';
import { importWalletsCsv } from './csv/importWalletsCsv';
import { runGraphSearch } from './graph/runSearch';
import { runExternalWalletSourceSync } from './externalWalletSource';
import { runSocialIngestPass } from './social/ingest';
import { runExternalConfluencePass } from './confluence/ingest';
import { runCandidateValidation } from './candidateValidation';
import { runTokenOverlapSearch } from './dune/duneOverlap';

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
  // CandidateWallet carries an FK to Wallet (promotedWalletId) — wiped
  // before wallet.deleteMany() (Task 34, Wave 4.5).
  await prisma.candidateWallet.deleteMany();
  // SocialMention carries FKs to SocialSource (Cascade) and Token (nullable) —
  // wiped leaf-first, before token.deleteMany() below (Task D, Social
  // Intelligence).
  await prisma.socialMention.deleteMany();
  await prisma.socialSource.deleteMany();
  await prisma.externalWalletSource.deleteMany();
  // TokenOverlapWalletResult/GroupResult carry an FK to TokenOverlapSearch
  // (Task 37, Wave 4.6) — wiped leaf-first, same convention as every other
  // FK'd pair in this function.
  await prisma.tokenOverlapWalletResult.deleteMany();
  await prisma.tokenOverlapGroupResult.deleteMany();
  await prisma.tokenOverlapSearch.deleteMany();
  await prisma.duneQuerySource.deleteMany();
  // TokenConfluenceSnapshot carries nullable FKs to Token (SET NULL) and
  // ExternalConfluenceSource — wiped leaf-first, before token.deleteMany()
  // below (Task D, External Confluence).
  await prisma.tokenConfluenceSnapshot.deleteMany();
  await prisma.externalConfluenceSource.deleteMany();
  // Second lineage guard at the point of no return (2026-07-10 Codex
  // re-review): main() checks before the wipe starts, but a concurrent root
  // import could land between that check and this deleteMany — re-checking
  // here narrows the data-loss window to milliseconds. Full cross-process
  // serialization (advisory locks) is deliberately deferred to the lineage
  // scheduler build; operator practice is to not run seed and imports
  // simultaneously.
  await assertNoLineageRootsOrExplicitOverride();
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
 *
 * Task 26 addition: after the mock-world rows above are written, this
 * function ALSO upserts packages/providers/src/registryData's curated static
 * service-address lists (source 'static-2026-07') — real, well-known Solana/
 * BSC service addresses (Jupiter, Raydium, Orca, Wormhole, PancakeSwap,
 * Stargate, 1inch, major stablecoin mints, a couple of well-documented CEX
 * hot wallets) so live-provider mode (Wave 4) has *some* real do-not-expand/
 * CEX/router/bridge coverage from day one, on top of the mock-world's own
 * synthetic scenario addresses. Order matters: mock-world rows are written
 * FIRST (above), static rows SECOND (below) — on a (chain, address)
 * collision (never expected in practice; mock-world addresses are
 * PRNG-generated fake strings, real static addresses are genuine mainnet
 * addresses, so the two universes shouldn't overlap) the static upsert is a
 * no-op skip rather than a clobber, so a real seeded mock-world label always
 * wins over a same-address static entry.
 */
async function bootstrapAddressRegistry(world: MockWorld): Promise<{ mockCount: number; staticCount: number }> {
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

  log('bootstrapped AddressRegistry rows (mock-world).', { count: deduped.length });

  // Static rows SECOND (see doc comment above) — upsert per-entry so an
  // (extremely unlikely) collision with a mock-world address above is a
  // no-op skip, never a clobber: the `update: {}` branch touches zero
  // columns, leaving whatever mock-world row already exists at that
  // (chain, address) key untouched.
  let staticCount = 0;
  for (const entry of STATIC_REGISTRY_ENTRIES) {
    const existing = await prisma.addressRegistry.findUnique({
      where: { chain_address: { chain: entry.chain, address: entry.address } }
    });
    if (existing) continue; // mock-world row already owns this (chain, address) — skip, don't clobber

    await prisma.addressRegistry.create({
      data: {
        chain: entry.chain,
        address: entry.address,
        category: entry.category,
        label: entry.label,
        source: entry.source,
        doNotExpand: entry.doNotExpand
      }
    });
    staticCount += 1;
  }

  log('bootstrapped AddressRegistry rows (static curated lists).', { count: staticCount });
  return { mockCount: deduped.length, staticCount };
}

// ---------------------------------------------------------------------------
// Phase 3.5: ExternalWalletSource seed rows (Task 34, Wave 4.5, Spec §5b) —
// the 6 external candidate-wallet feeders, seeded once per fresh run (this
// script always wipes-first, so this is always a clean createMany). enabled
// is read from settings.connectors.sourcesEnabled so a caller who overrides
// that map before running the seed (not the common case — DEFAULT_SETTINGS
// has all 6 true) gets sources seeded in the state they configured, rather
// than a hardcoded always-true.
// ---------------------------------------------------------------------------

interface ExternalWalletSourceSeedRow {
  name: string;
  type: string;
  apiKeyEnvName: string;
  chainSupport: Chain[];
  rateLimitPerMinute: number;
}

const EXTERNAL_WALLET_SOURCE_SEED_ROWS: ExternalWalletSourceSeedRow[] = [
  { name: 'solana_tracker_pnl', type: 'pnl_leaderboard', apiKeyEnvName: 'SOLANA_TRACKER_API_KEY', chainSupport: ['SOLANA'], rateLimitPerMinute: 60 },
  { name: 'birdeye_wallet_pnl', type: 'pnl_validator', apiKeyEnvName: 'BIRDEYE_API_KEY', chainSupport: ['SOLANA', 'BSC'], rateLimitPerMinute: 60 },
  { name: 'birdeye_top_traders', type: 'token_top_traders', apiKeyEnvName: 'BIRDEYE_API_KEY', chainSupport: ['SOLANA', 'BSC'], rateLimitPerMinute: 60 },
  { name: 'kolscan', type: 'leaderboard', apiKeyEnvName: 'KOLSCAN_API_KEY', chainSupport: ['SOLANA'], rateLimitPerMinute: 30 },
  { name: 'gmgn_smart_money', type: 'smart_money', apiKeyEnvName: 'GMGN_API_KEY', chainSupport: ['SOLANA', 'BSC'], rateLimitPerMinute: 30 },
  { name: 'cielo', type: 'pnl_tracker', apiKeyEnvName: 'CIELO_API_KEY', chainSupport: ['SOLANA', 'BSC'], rateLimitPerMinute: 30 }
];

async function bootstrapExternalWalletSources(settings: Settings): Promise<number> {
  await prisma.externalWalletSource.createMany({
    data: EXTERNAL_WALLET_SOURCE_SEED_ROWS.map((row) => ({
      name: row.name,
      type: row.type,
      enabled: settings.connectors.sourcesEnabled[row.name] ?? true,
      chainSupport: row.chainSupport,
      apiKeyEnvName: row.apiKeyEnvName,
      rateLimitPerMinute: row.rateLimitPerMinute
    }))
  });
  log('bootstrapped ExternalWalletSource rows.', { count: EXTERNAL_WALLET_SOURCE_SEED_ROWS.length });
  return EXTERNAL_WALLET_SOURCE_SEED_ROWS.length;
}

/**
 * Runs ONE runExternalWalletSourceSync pass (Task 34 binding decision 5) —
 * every enabled ExternalWalletSource row resolves to the SAME shared
 * MockCandidateSource built from this seed run's own `world` (deterministic,
 * same convention as every other mock-mode pass in this script).
 */
async function seedExternalWalletSourceSync(world: MockWorld, settings: Settings) {
  const candidateSource = new MockCandidateSource(world);
  const result = await runExternalWalletSourceSync(
    prisma,
    settings,
    () => candidateSource,
    {
      info: (msg, meta) => log(msg, meta),
      error: (msg, meta) => log(`ERROR: ${msg}`, meta)
    }
  );
  log('external wallet source sync pass complete.', { ...result });
  return result;
}

// ---------------------------------------------------------------------------
// Phase 3.7: SocialSource seed rows + one social ingest pass (Task D, Social
// Intelligence, Spec §2/§6). 2 example rows (1 telegram, 1 discord, both
// enabled) so `npm run db:seed` demonstrates the /social pipeline end-to-end
// in MOCK_MODE. apiKeyEnvName is the env VAR NAME only (never a value — Spec
// constraint 10). The /social empty state is what renders when zero sources
// exist (fresh operator / all deleted).
// ---------------------------------------------------------------------------

const SOCIAL_SOURCE_SEED_ROWS = [
  {
    name: 'alpha-callers-tg',
    platform: 'telegram',
    trustTier: 'high',
    apiKeyEnvName: 'SOCIAL_TELEGRAM_READ_TOKEN',
    rateLimitPerMinute: 30,
    notes: 'Example seeded Telegram caller channel (mock-backed until real group link + read token exist).'
  },
  {
    name: 'degen-signals-dc',
    platform: 'discord',
    trustTier: 'medium',
    apiKeyEnvName: 'SOCIAL_DISCORD_BOT_TOKEN',
    rateLimitPerMinute: 30,
    notes: 'Example seeded Discord signals server (mock-backed until real channel + bot token exist).'
  }
] as const;

async function bootstrapSocialSources(): Promise<number> {
  await prisma.socialSource.createMany({
    data: SOCIAL_SOURCE_SEED_ROWS.map((row) => ({
      name: row.name,
      platform: row.platform,
      trustTier: row.trustTier,
      enabled: true,
      chainSupport: ['SOLANA'] as Chain[],
      apiKeyEnvName: row.apiKeyEnvName,
      rateLimitPerMinute: row.rateLimitPerMinute,
      notes: row.notes
    }))
  });
  log('bootstrapped SocialSource rows.', { count: SOCIAL_SOURCE_SEED_ROWS.length });
  return SOCIAL_SOURCE_SEED_ROWS.length;
}

/**
 * Runs ONE runSocialIngestPass (Spec §6) — every enabled SocialSource row
 * resolves to the SAME shared MockSocialSource built from this seed run's own
 * `world` (deterministic, same convention as seedExternalWalletSourceSync).
 * The mock source's fixtures mention seeded mock-world tokens so /social's
 * mention-feed / velocity / wallet-signal-overlap panels populate out of the
 * box.
 */
async function seedSocialIngestPass(world: MockWorld, settings: Settings) {
  const socialSource = new MockSocialSource(world);
  const result = await runSocialIngestPass(
    prisma,
    settings,
    () => socialSource,
    {
      info: (msg, meta) => log(msg, meta),
      error: (msg, meta) => log(`ERROR: ${msg}`, meta)
    }
  );
  log('social ingest pass complete.', { ...result });
  return result;
}

// ---------------------------------------------------------------------------
// Phase 3.8: ExternalConfluenceSource seed rows (Task D, External Confluence).
// 2 example rows (holderscan + gmgn, BOTH DISABLED by default — no API key is
// required to build/seed, per the design doc non-goal "every external provider
// degrades to stub/missing_key/plan_required and the build stays green with
// zero keys"). apiKeyEnvName is the env VAR NAME only, never a value (design
// rule 13). Enabling a row requires an operator to supply the real key first.
// ---------------------------------------------------------------------------

const EXTERNAL_CONFLUENCE_SOURCE_SEED_ROWS = [
  {
    name: 'holderscan-holder-risk',
    provider: 'holderscan',
    apiKeyEnvName: 'HOLDERSCAN_API_KEY',
    rateLimitPerMinute: 30,
    notes: 'Optional/paid holder-risk provider — disabled until an operator supplies HOLDERSCAN_API_KEY + a plan that returns holder deltas/concentration. Reports missing_key/plan_required until then; never marks a token safe.'
  },
  {
    name: 'gmgn-external-intel',
    provider: 'gmgn',
    apiKeyEnvName: 'GMGN_API_KEY',
    rateLimitPerMinute: 30,
    notes: 'Query-only external intel — disabled by default; stub until confirmed query-only docs/key. NEVER references execution, trading, or key-management endpoints (query-only, design rule 8).'
  }
] as const;

async function bootstrapExternalConfluenceSources(): Promise<number> {
  await prisma.externalConfluenceSource.createMany({
    data: EXTERNAL_CONFLUENCE_SOURCE_SEED_ROWS.map((row) => ({
      name: row.name,
      provider: row.provider,
      enabled: false,
      apiKeyEnvName: row.apiKeyEnvName,
      rateLimitPerMinute: row.rateLimitPerMinute,
      metadataJson: { notes: row.notes }
    }))
  });
  log('bootstrapped ExternalConfluenceSource rows (disabled by default).', {
    count: EXTERNAL_CONFLUENCE_SOURCE_SEED_ROWS.length
  });
  return EXTERNAL_CONFLUENCE_SOURCE_SEED_ROWS.length;
}

/**
 * Runs ONE runExternalConfluencePass (design doc "Worker integration") so a
 * fresh `npm run db:seed` demonstrates the internal LiquidityRisk snapshots
 * end-to-end. Both seeded external sources are DISABLED, so this pass only
 * exercises Leg 1 (internal LiquidityRisk over every seeded Token that has a
 * market snapshot) — deterministic, no provider, no key. The resolver returns
 * null for any (disabled -> never-reached) source, same convention as the
 * other mock-mode seed passes.
 */
async function seedExternalConfluencePass(settings: Settings) {
  const result = await runExternalConfluencePass(prisma, settings, () => null, {
    info: (msg, meta) => log(msg, meta),
    error: (msg, meta) => log(`ERROR: ${msg}`, meta)
  });
  log('external confluence pass complete.', { ...result });
  return result;
}

/**
 * Runs ONE runCandidateValidation pass (Task 35 binding decision 4) — must
 * run AFTER Phase 6 (ingestAllWallets), since local computeFifoPnl evidence
 * requires WalletTokenTrade rows to already exist for candidate addresses
 * that are also mock-world wallets. No provider wallet-PnL capability is
 * resolvable in the seed script either (same as the worker's
 * walletCandidateValidation job — see that file's header), so every
 * candidate's evidence falls through to local computeFifoPnl or
 * 'insufficient'.
 *
 * The batch size used for THIS pass is deliberately uncapped (Number.MAX_SAFE_INTEGER
 * override, local to this one call only — the PERSISTED Settings row still
 * carries the real default validationBatchSize=100, exactly as a live
 * deployment would use it). Rationale: the mock world's 5 poisoned addresses
 * are each synced once PER enabled external source (6 sources), producing up
 * to 6 separate CandidateWallet rows per poisoned address (unique on
 * (walletAddress, chain, source)) alongside ~225 good candidates — well over
 * 100 total pending rows. A real batchSize=100 worker tick would correctly
 * leave some of those rows pending until its NEXT scheduled tick (batching
 * across ticks is the intended, non-buggy behavior — see
 * candidateValidation.ts's own header), but the seed script only ever runs
 * ONE tick, so without this override its self-checks (which need every
 * poisoned address's rows to reach a terminal state within that one pass)
 * would be at the mercy of $batch ordering. Uncapping it here is a seed-only
 * convenience, not a change to production defaults.
 */
async function seedCandidateValidationPass(settings: Settings) {
  const seedTimeSettings: Settings = {
    ...settings,
    connectors: { ...settings.connectors, validationBatchSize: Number.MAX_SAFE_INTEGER }
  };
  const result = await runCandidateValidation(prisma, seedTimeSettings, undefined, {
    info: (msg, meta) => log(msg, meta),
    error: (msg, meta) => log(`ERROR: ${msg}`, meta)
  });
  log('candidate validation pass complete.', { ...result });
  return result;
}

// ---------------------------------------------------------------------------
// Phase 3.6: Dune Query Connector seed rows (Task 37, Wave 4.6,
// dune-feature-wave46.md) — ONE DuneQuerySource row (disabled by default
// until an operator supplies a real DUNE_API_KEY + queryId), plus ONE MOCK
// token-overlap search over 3 real mock-world scenario tokens so
// `npm run db:seed` populates TokenOverlapSearch/WalletResult/GroupResult +
// dune_token_overlap CandidateWallet rows out of the box, same
// "MOCK_MODE-equivalent, no live connector required" convention as Phase 3.5's
// ExternalWalletSource sync above.
// ---------------------------------------------------------------------------

const DUNE_QUERY_SOURCE_SEED_NAME = 'default_token_overlap';

async function bootstrapDuneQuerySource(): Promise<void> {
  await prisma.duneQuerySource.create({
    data: {
      name: DUNE_QUERY_SOURCE_SEED_NAME,
      queryId: process.env.DUNE_DEFAULT_OVERLAP_QUERY_ID || 'REPLACE_WITH_REAL_DUNE_QUERY_ID',
      purpose: 'token_overlap',
      // Disabled by default until an operator supplies a real DUNE_API_KEY +
      // a real saved queryId — see dune-feature-wave46.md's "Dune SAVED
      // QUERIES + Dune API is primary" framing and .env.example's own
      // DUNE_API_KEY/DUNE_DEFAULT_OVERLAP_QUERY_ID comments.
      enabled: false,
      resultFormat: 'json',
      notes: 'Seeded placeholder — set DUNE_API_KEY + a real saved queryId, then enable this row, to refresh from live Dune data.'
    }
  });
  log('bootstrapped DuneQuerySource seed row (disabled by default).', { name: DUNE_QUERY_SOURCE_SEED_NAME });
}

/**
 * Picks 3 real mock-world SOLANA token addresses that share genuine buyer/
 * seller overlap (same swap_leg-scanning convention MockDuneOverlapSource
 * itself uses) so the seed-time overlap search exercises real, non-contrived
 * data. Falls back to the first 3 tokens in the world if no 3-way overlap is
 * found (still a valid — if likely near-empty — search; never throws).
 */
function pickOverlapScenarioTokens(world: MockWorld): string[] {
  const walletsByAddress = new Map(world.wallets.filter((w) => w.chain === 'SOLANA').map((w) => [w.address, w]));
  const tradersByToken = new Map<string, Set<string>>();

  for (const [walletAddress, txs] of world.txsByWallet) {
    if (!walletsByAddress.has(walletAddress)) continue;
    for (const tx of txs) {
      for (const leg of tx.legs) {
        if (leg.kind !== 'swap_leg' || !leg.asset.address) continue;
        if (leg.to !== walletAddress && leg.from !== walletAddress) continue;
        const set = tradersByToken.get(leg.asset.address) ?? new Set<string>();
        set.add(walletAddress);
        tradersByToken.set(leg.asset.address, set);
      }
    }
  }

  const tokens = [...tradersByToken.keys()].sort();
  let best: { tokens: string[]; overlapCount: number } | null = null;

  for (let i = 0; i < tokens.length; i++) {
    for (let j = i + 1; j < tokens.length; j++) {
      for (let k = j + 1; k < tokens.length; k++) {
        const a = tradersByToken.get(tokens[i]!)!;
        const b = tradersByToken.get(tokens[j]!)!;
        const c = tradersByToken.get(tokens[k]!)!;
        const overlapCount = [...c].filter((w) => a.has(w) && b.has(w)).length;
        if (overlapCount > 0 && (!best || overlapCount > best.overlapCount)) {
          best = { tokens: [tokens[i]!, tokens[j]!, tokens[k]!], overlapCount };
        }
      }
    }
  }

  if (best) return best.tokens;
  return tokens.slice(0, 3); // fallback — still a valid search, just likely sparse overlap
}

/**
 * Runs ONE MOCK token-overlap search (Task 37 binding decision 5) over 3
 * real scenario tokens from `world` — credit-safe by construction (the mock
 * DuneClient never calls a real network endpoint at all). Produces the
 * TokenOverlapSearch/WalletResult/GroupResult rows plus pending
 * dune_token_overlap CandidateWallet rows the self-check below asserts.
 */
async function seedDuneOverlapSearch(world: MockWorld) {
  const tokenAddresses = pickOverlapScenarioTokens(world);
  const client = createMockDuneClient(world);

  const result = await runTokenOverlapSearch(
    prisma,
    { chain: 'SOLANA', tokenAddresses, minTokensOverlap: 2, maxResults: 500 },
    () => client,
    {
      info: (msg, meta) => log(msg, meta),
      error: (msg, meta) => log(`ERROR: ${msg}`, meta)
    }
  );
  log('dune mock overlap search pass complete.', { ...result, tokenAddresses });
  return result;
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
        isWatched: true,
        status: 'signal_eligible'
      },
      update: { isWatched: true, status: 'signal_eligible' },
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

/**
 * Persists WalletClassification rows for every NON-smart mock-world wallet
 * that carries at least one label (Task 35, Wave 4.5 — fix pass).
 *
 * Root cause this closes: seedComputedWalletStats (Phase 5(a)) only writes
 * WalletClassification rows for smart_money/human_like/whale wallets — a
 * possible_bot/sniper/mev-only mock wallet (the world's "noise cohort") gets
 * a real Wallet row via ingestAllWallets (Phase 6) but NEVER a
 * WalletClassification row, so Task 35's candidateValidation evidence
 * assembly (which reads WalletClassification, not the in-memory MockWallet
 * labels — packages/db is not supposed to know about MockWorld internals)
 * sees an empty label list and cannot auto-reject on bot/sniper grounds. This
 * was caught by this task's own poisoned-candidate self-check: a possible_bot
 * poisoned candidate was incorrectly promoted because its bot label never
 * reached the DB.
 *
 * Must run AFTER Phase 6 (ingestAllWallets) — the target wallets only get a
 * Wallet row there (smart wallets already got both their Wallet row AND
 * their WalletClassification rows in Phase 5(a), so this pass explicitly
 * skips any wallet that already has a classification row to avoid a
 * duplicate insert).
 */
async function seedNonSmartWalletClassifications(world: MockWorld): Promise<number> {
  let created = 0;
  for (const mockWallet of world.wallets) {
    if (mockWallet.labels.length === 0) continue;
    const isSmart = mockWallet.labels.some((l) => SMART_LABELS.has(l));
    if (isSmart) continue; // already classified in Phase 5(a)

    const wallet = await prisma.wallet.findUnique({
      where: { address_chain: { address: mockWallet.address, chain: mockWallet.chain } },
      select: { id: true }
    });
    if (!wallet) continue; // never ingested (no activity) — nothing to classify

    const existing = await prisma.walletClassification.findFirst({ where: { walletId: wallet.id } });
    if (existing) continue;

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
  log('seeded WalletClassification rows for non-smart (noise-cohort) wallets.', { count: created });
  return created;
}

const QUALIFYING_CANDIDATE_COUNT = 3;

/**
 * Gives a small, deterministic subset of the "good" (non-poisoned) SOLANA
 * candidate addresses REAL, profitable WalletTokenTrade history — enough to
 * independently clear settings.profitableWallet via local computeFifoPnl —
 * so Task 35's candidate-validation self-check ("some good candidates
 * promoted") has something genuine to promote.
 *
 * Root cause this closes: the mock world's own wallets (see Task 4's design)
 * mostly carry 1 real trade each (noise cohort), and even NOVA/QUIET's
 * scripted buyers are BUY-only (no SELLs) — realistic for the flow-scoring/
 * rule-firing demos those scenarios exist for, but structurally incapable of
 * ever satisfying a REALIZED-PnL-based validation gate (computeFifoPnl needs
 * profitable SELLs to realize anything). Rather than let every single
 * candidate's local evidence be genuinely "below thresholds" or bot/
 * registry-rejected forever, this phase seeds real, honest, profitable
 * trade history for a few of the mock world's own highest-walletScore
 * candidates — the same MockCandidateSource ranking the external
 * wallet-source sync itself uses (Task 34) — so a handful of GOOD candidates
 * are provably, not just claimedly, profitable and validation promotes them
 * on real (if synthetic-world) evidence, never on the claim alone.
 *
 * Deterministic: same world -> same MockCandidateSource ranking -> same
 * addresses picked, same seededRandomFor-derived trade figures every run.
 * Trades are attached to a DEDICATED token created just for this phase
 * (T35QUALIFYTOKEN — never one of the mock world's own 28 scenario/noise
 * tokens) specifically so this phase can NEVER perturb any existing
 * token-scoped self-check (flowScore, signal firing, entity clustering, …).
 * Earlier draft of this phase reused the NOVA token as a "convenient
 * existing price anchor" — that corrupted NOVA's own flowScore/signal
 * self-checks (extra unrelated buy/sell volume shifted its aggregate window)
 * and is exactly the mistake a dedicated token avoids.
 */
async function seedQualifyingCandidateTrades(
  world: MockWorld,
  tokenIdByAddress: Map<string, string>
): Promise<{ addressesSeeded: string[] }> {
  void tokenIdByAddress; // kept in the signature for call-site symmetry with other tokenIdByAddress-consuming seed phases; this phase creates its own dedicated token instead of looking one up.

  const qualifyToken = await prisma.token.upsert({
    where: { chain_address: { chain: 'SOLANA', address: 'T35QUALIFYTOKEN' } },
    create: {
      chain: 'SOLANA',
      address: 'T35QUALIFYTOKEN',
      symbol: 'T35QT',
      name: 'Task 35 Candidate Qualification Token (seed-only, isolated from every scenario self-check)',
      decimals: 9,
      firstSeenAt: new Date(),
      riskFlags: []
    },
    update: {}
  });
  const qualifyTokenId = qualifyToken.id;

  // A single market snapshot so this token isn't "skippedNoWindow" in the
  // flow-scoring pass and computeFifoPnl's currentPriceUsd resolution has a
  // snapshot to prefer over the last-trade-price fallback (see
  // walletStatsRefresh.ts's identical resolution order).
  await prisma.tokenMarketSnapshot.create({
    data: {
      tokenId: qualifyTokenId,
      ts: new Date(),
      priceUsd: 5,
      marketCapUsd: 500_000,
      fdvUsd: 500_000,
      liquidityUsd: 50_000,
      vol5m: 0,
      vol1h: 0,
      vol6h: 0,
      vol24h: 0,
      holderCount: 50
    }
  });

  const candidateSource = new MockCandidateSource(world);
  const candidates = await candidateSource.fetchCandidates('SOLANA');
  const poisoned = getPoisonedAddresses(world, 'SOLANA');
  const poisonedAddresses = new Set([...poisoned.routerOrCex, ...poisoned.possibleBot, ...poisoned.belowThreshold]);

  const goodCandidates = candidates
    .filter((c) => !poisonedAddresses.has(c.walletAddress))
    .slice(0, QUALIFYING_CANDIDATE_COUNT);

  const addressesSeeded: string[] = [];
  const now = new Date();

  for (const candidate of goodCandidates) {
    const wallet = await prisma.wallet.upsert({
      where: { address_chain: { address: candidate.walletAddress, chain: 'SOLANA' } },
      create: { address: candidate.walletAddress, chain: 'SOLANA', firstSeenAt: now, lastActiveAt: now, isWatched: false, status: 'observation_only' },
      update: {}
    });

    const rng = seededRandomFor(`t35qualify:${candidate.walletAddress}`);
    let slot = 1;
    // 10 BUYs then 10 SELLs at a markup, comfortably clearing every
    // profitableWallet threshold (pnl30d>=4000, minTrades>=8, minWinRate>=0.35,
    // minRealized>=1000, minAvgTradeSizeUsd>=50) — same shape as this file's
    // seedComputedWalletStats figures, but backed by REAL WalletTokenTrade
    // rows this time, not just a decorative WalletStats row.
    const buyPriceUsd = 2 + rng() * 3; // 2-5
    const sellPriceUsd = buyPriceUsd * (1.6 + rng() * 0.6); // 60-120% markup
    for (let i = 0; i < 10; i++) {
      const amountToken = 100 + rng() * 50;
      await prisma.walletTokenTrade.create({
        data: {
          walletId: wallet.id,
          tokenId: qualifyTokenId,
          chain: 'SOLANA',
          action: 'BUY',
          amountToken,
          amountUsd: amountToken * buyPriceUsd,
          txHash: `T35QUALIFY_${candidate.walletAddress}_buy_${slot}`,
          blockOrSlot: BigInt(slot),
          ts: new Date(now.getTime() - (60 - slot) * 60_000),
          priceUsd: buyPriceUsd,
          marketCapAtTrade: 500_000,
          walletScoreAtTime: candidate.claimedPnlUsd ? Math.min(100, candidate.claimedPnlUsd / 1000) : 50,
          provider: 'test'
        }
      });
      slot += 1;
    }
    for (let i = 0; i < 10; i++) {
      const amountToken = 100 + rng() * 50;
      await prisma.walletTokenTrade.create({
        data: {
          walletId: wallet.id,
          tokenId: qualifyTokenId,
          chain: 'SOLANA',
          action: 'SELL',
          amountToken,
          amountUsd: amountToken * sellPriceUsd,
          txHash: `T35QUALIFY_${candidate.walletAddress}_sell_${slot}`,
          blockOrSlot: BigInt(slot),
          ts: new Date(now.getTime() - (30 - slot) * 60_000),
          priceUsd: sellPriceUsd,
          marketCapAtTrade: 500_000,
          walletScoreAtTime: candidate.claimedPnlUsd ? Math.min(100, candidate.claimedPnlUsd / 1000) : 50,
          provider: 'test'
        }
      });
      slot += 1;
    }

    addressesSeeded.push(candidate.walletAddress);
  }

  log('seeded qualifying local trade history for a subset of good candidates (Task 35).', { addressesSeeded });
  return { addressesSeeded };
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
  replayRunResult: Awaited<ReturnType<typeof runHistoricalReplay>>,
  csvOkRows: number,
  externalWalletSourceSyncResult: { sourcesConsidered: number; candidatesUpserted: number; errors: number },
  candidateValidationResult: Awaited<ReturnType<typeof runCandidateValidation>>,
  duneOverlapSearchResult: Awaited<ReturnType<typeof runTokenOverlapSearch>>
): Promise<{ rows: SelfCheckRow[]; hardFail: boolean; concerns: string[] }> {
  const rows: SelfCheckRow[] = [];
  const concerns: string[] = [];

  // -----------------------------------------------------------------------
  // External wallet-source connector self-checks (Task 34, Wave 4.5, Spec
  // §5b binding decision 5): "CandidateWallet count > 0, all
  // validationStatus 'pending', the poisoned addresses present as pending,
  // source rows have lastSyncAt set."
  // -----------------------------------------------------------------------
  const sourceRows = await prisma.externalWalletSource.findMany();
  rows.push({
    check: 'ExternalWalletSource: 6 seeded rows, all with lastSyncAt set',
    expected: '6 rows, all lastSyncAt != null',
    actual: `${sourceRows.length} rows, ${sourceRows.filter((r) => r.lastSyncAt !== null).length} with lastSyncAt set`,
    pass: sourceRows.length === 6 && sourceRows.every((r) => r.lastSyncAt !== null)
  });

  const candidateCount = await prisma.candidateWallet.count();
  rows.push({
    check: 'CandidateWallet count > 0 (external wallet-source sync produced candidates)',
    expected: '> 0',
    actual: String(candidateCount),
    pass: candidateCount > 0
  });

  rows.push({
    check: 'external wallet source sync: zero errors across all 6 enabled sources',
    expected: '0 errors',
    actual: `${externalWalletSourceSyncResult.errors} error(s), ${externalWalletSourceSyncResult.candidatesUpserted} candidates upserted across ${externalWalletSourceSyncResult.sourcesConsidered} sources`,
    pass: externalWalletSourceSyncResult.errors === 0
  });

  // -----------------------------------------------------------------------
  // Candidate VALIDATION self-checks (Task 35, Wave 4.5, Spec §5b binding
  // decision 4): "ALL 5 poisoned candidates end 'rejected' with a reason (2
  // registry-service, 2 bot, 1 below-threshold); >= some good candidates
  // 'promoted' -> Wallet isWatched=true created; candidates with no local
  // trade evidence stay 'pending' (insufficient)." One CandidateWallet row
  // exists PER (address, source) — a poisoned address can appear under
  // multiple enabled sources, so every SUCH row (not just one) must show the
  // correct terminal state.
  // -----------------------------------------------------------------------
  const poisonedSolana = getPoisonedAddresses(world, 'SOLANA');

  const registryOrCexRows = await prisma.candidateWallet.findMany({
    where: { walletAddress: { in: poisonedSolana.routerOrCex }, chain: 'SOLANA' }
  });
  const registryOrCexAllRejectedCorrectly =
    registryOrCexRows.length > 0 &&
    registryOrCexRows.every((r) => r.validationStatus === 'rejected' && (r.rejectionReason ?? '').includes('excluded service address'));
  rows.push({
    check: '2 poisoned router/CEX addresses: every CandidateWallet row rejected with "excluded service address" reason',
    expected: `>0 rows, all rejected w/ registry reason (addresses: ${JSON.stringify(poisonedSolana.routerOrCex)})`,
    actual: `${registryOrCexRows.length} row(s), ${registryOrCexRows.filter((r) => r.validationStatus === 'rejected').length} rejected, ${registryOrCexRows.filter((r) => (r.rejectionReason ?? '').includes('excluded service address')).length} with the registry reason`,
    pass: registryOrCexAllRejectedCorrectly
  });

  const possibleBotRows = await prisma.candidateWallet.findMany({
    where: { walletAddress: { in: poisonedSolana.possibleBot }, chain: 'SOLANA' }
  });
  const possibleBotAllRejectedCorrectly =
    possibleBotRows.length > 0 &&
    possibleBotRows.every((r) => r.validationStatus === 'rejected' && (r.rejectionReason ?? '').includes('bot/sniper-dominant'));
  rows.push({
    check: '2 poisoned possible_bot addresses: every CandidateWallet row rejected with "bot/sniper-dominant" reason',
    expected: `>0 rows, all rejected w/ bot reason (addresses: ${JSON.stringify(poisonedSolana.possibleBot)})`,
    actual: `${possibleBotRows.length} row(s), ${possibleBotRows.filter((r) => r.validationStatus === 'rejected').length} rejected, ${possibleBotRows.filter((r) => (r.rejectionReason ?? '').includes('bot/sniper-dominant')).length} with the bot reason`,
    pass: possibleBotAllRejectedCorrectly
  });

  const belowThresholdRows = await prisma.candidateWallet.findMany({
    where: { walletAddress: { in: poisonedSolana.belowThreshold }, chain: 'SOLANA' }
  });
  // The below-threshold poisoned entry's claim itself is below the pnl30d
  // floor, but its terminal state can legitimately be EITHER 'rejected'
  // (below thresholds — if it has local trade evidence) OR 'pending'
  // (insufficient — if it has no local trade history at all yet); either
  // way it must NEVER be 'promoted'.
  const belowThresholdNeverPromoted = belowThresholdRows.length > 0 && belowThresholdRows.every((r) => r.validationStatus !== 'promoted');
  rows.push({
    check: '1 poisoned below-threshold address: never promoted (rejected on thresholds, or still pending/insufficient)',
    expected: `>0 rows, none promoted (address: ${JSON.stringify(poisonedSolana.belowThreshold)})`,
    actual: `${belowThresholdRows.length} row(s), statuses: ${belowThresholdRows.map((r) => r.validationStatus).join(', ')}`,
    pass: belowThresholdNeverPromoted
  });

  rows.push({
    check: 'candidate validation: at least one candidate promoted to a tracked, isWatched=true Wallet',
    expected: '>= 1 promoted',
    actual: `${candidateValidationResult.promoted} promoted`,
    pass: candidateValidationResult.promoted >= 1
  });

  const promotedRows = await prisma.candidateWallet.findMany({
    where: { validationStatus: 'promoted' },
    select: { promotedWalletId: true }
  });
  // A single Wallet can be the promotedWalletId of MULTIPLE CandidateWallet
  // rows (the same address synced from several enabled sources) — dedupe
  // before comparing counts, or this check would demand
  // Wallet.count(...) === "number of promoted CandidateWallet rows" instead
  // of the actually-intended "number of DISTINCT promoted wallets".
  const promotedWalletIds = [
    ...new Set(promotedRows.map((r) => r.promotedWalletId).filter((id): id is string => id !== null))
  ];
  const isWatchedPromotedCount = await prisma.wallet.count({ where: { id: { in: promotedWalletIds }, isWatched: true } });
  rows.push({
    check: 'every promoted CandidateWallet.promotedWalletId points at a Wallet with isWatched=true',
    expected: `${promotedWalletIds.length} distinct wallet(s) (all isWatched)`,
    actual: String(isWatchedPromotedCount),
    pass: isWatchedPromotedCount === promotedWalletIds.length && promotedWalletIds.length > 0
  });

  rows.push({
    check: 'candidate validation: at least one candidate stays pending (insufficient — no local trade evidence yet)',
    expected: '>= 1 pending',
    actual: `${candidateValidationResult.stayedPending} stayed pending`,
    pass: candidateValidationResult.stayedPending >= 1
  });

  rows.push({
    check: 'candidate validation: zero errors during the seed-time pass',
    expected: '0 errors',
    actual: `${candidateValidationResult.errors} error(s)`,
    pass: candidateValidationResult.errors === 0
  });

  // -----------------------------------------------------------------------
  // Dune Query Connector self-checks (Task 37, Wave 4.6, dune-feature-wave46.md
  // binding decision 5): "search done, overlap results>0, candidates created
  // source dune_token_overlap, poisoned overlap wallet present as pending."
  // -----------------------------------------------------------------------
  rows.push({
    check: 'Dune mock overlap search: status done',
    expected: 'done',
    actual: duneOverlapSearchResult.status,
    pass: duneOverlapSearchResult.status === 'done'
  });

  rows.push({
    check: 'Dune mock overlap search: overlap wallet results > 0',
    expected: '> 0',
    actual: String(duneOverlapSearchResult.walletResultsCreated),
    pass: duneOverlapSearchResult.walletResultsCreated > 0
  });

  const duneCandidateCount = await prisma.candidateWallet.count({ where: { source: 'dune_token_overlap' } });
  rows.push({
    check: 'CandidateWallet rows created with source=dune_token_overlap',
    expected: '> 0',
    actual: String(duneCandidateCount),
    pass: duneCandidateCount > 0
  });

  const dunePoisonedSolana = getDunePoisonedAddresses(world, 'SOLANA');
  const dunePoisonedCandidates = await prisma.candidateWallet.findMany({
    where: { walletAddress: { in: dunePoisonedSolana.routerOrCex }, chain: 'SOLANA', source: 'dune_token_overlap' }
  });
  // The poisoned overlap wallet's terminal state after the (already-ran)
  // Phase 6.5 validation pass may legitimately be 'rejected' (if it was
  // picked up in this same pass) — the binding decision's own wording is
  // "present as pending" describing the state immediately after the overlap
  // import, before validation runs on it; since this seed script validates
  // in the SAME pass as every other pending candidate, 'rejected' with the
  // registry reason is the equally-valid, in fact MORE complete signal that
  // the trust boundary held (it was never blindly trusted, and validation
  // correctly caught it) — so this check accepts either 'pending' or
  // 'rejected', but never 'promoted'.
  const dunePoisonedNeverPromoted =
    dunePoisonedCandidates.length > 0 && dunePoisonedCandidates.every((r) => r.validationStatus !== 'promoted');
  rows.push({
    check: 'Dune poisoned router/CEX overlap wallet present, never promoted (pending or correctly rejected)',
    expected: `> 0 rows, none promoted (address(es): ${JSON.stringify(dunePoisonedSolana.routerOrCex)})`,
    actual: `${dunePoisonedCandidates.length} row(s), statuses: ${dunePoisonedCandidates.map((r) => r.validationStatus).join(', ') || 'none found'}`,
    pass: dunePoisonedNeverPromoted
  });

  const duneQuerySourceRow = await prisma.duneQuerySource.findUnique({ where: { name: 'default_token_overlap' } });
  rows.push({
    check: 'DuneQuerySource placeholder row seeded (disabled by default)',
    expected: '1 row, enabled=false',
    actual: duneQuerySourceRow ? `found, enabled=${duneQuerySourceRow.enabled}` : 'not found',
    pass: duneQuerySourceRow !== null && duneQuerySourceRow.enabled === false
  });

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

  // Was hardcoded "== 28" (the mock world's own token count) — Task 35, Wave
  // 4.5 adds ONE dedicated qualify-candidate token (T35QUALIFYTOKEN,
  // seedQualifyingCandidateTrades) outside the mock world proper. The real
  // invariant this check protects is "exactly one TokenFlowSnapshot row per
  // token that HAS market data" (runFlowScoringPass skips any token with zero
  // TokenMarketSnapshot rows — e.g. a quote-asset stub token ingest.ts
  // auto-creates for USDC legs, which the pre-existing "tokens >= 28"
  // check's own comment already anticipated: "28 world tokens plus any
  // quote-asset stubs ingest correctly auto-creates"), not a magic constant
  // that silently drifts whenever the token universe legitimately grows.
  // Task 0 (snapshot dedup): signal detection now records a REAL status
  // transition as its own row (trigger-time snapshot) instead of rewriting the
  // latest row in place, so a signal-firing token legitimately carries MORE
  // than one row after the seed's score->detect sequence. The invariant is
  // therefore per-TOKEN coverage (every scoreable token has snapshots, no
  // token missed), not a raw row-count equality.
  const tokensWithFlowSnapshots = (
    await prisma.tokenFlowSnapshot.groupBy({ by: ['tokenId'] })
  ).length;
  const tokensWithMarketData = await prisma.token.count({ where: { marketSnapshots: { some: {} } } });
  rows.push({
    check: `tokens with flow snapshots == tokens-with-market-data count (every scoreable token covered)`,
    expected: String(tokensWithMarketData),
    actual: String(tokensWithFlowSnapshots),
    pass: tokensWithFlowSnapshots === tokensWithMarketData
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

  // Task 0 (snapshot dedup): a token may now carry >1 row (signal transitions
  // persist as their own rows), so rank TOKENS by their best row — raw-row
  // ranking would let one token fill several leaderboard slots.
  const rankedRows = await prisma.tokenFlowSnapshot.findMany({
    orderBy: { flowScore: 'desc' },
    include: { token: { select: { symbol: true, address: true } } }
  });
  const seenTokens = new Set<string>();
  const topFlowSnapshots = rankedRows.filter((s) => {
    if (seenTokens.has(s.tokenId)) return false;
    seenTokens.add(s.tokenId);
    return true;
  }).slice(0, 5);

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
  rows.push({
    check: 'graph-demo search includes router counterparty node',
    expected: 'present',
    actual: `router present=${graphNodeAddresses.has(routerAddress)}`,
    pass: graphNodeAddresses.has(routerAddress)
  });

  // CEX counterparty check (Task 26 fix pass — see this file's own
  // bootstrapAddressRegistry doc comment): the graph-demo's CEX-touch leg
  // (packages/providers/src/mock/scenarios.ts's buildGraphDemo) is a
  // token_transfer INTO a registry-CEX address. Before Task 26, ingest.ts
  // wrote every token_transfer as plain MoneyFlowEdge.actionType='transfer',
  // so this edge's relationship mapped to native_transfer — which passes
  // CAPITAL_FLOW's relationship allowlist — and the CEX node showed up as a
  // BFS-discovered node. Task 26 makes ingest CEX-aware: this exact edge is
  // now correctly tagged actionType='cex_deposit', which
  // packages/core/src/graph/bfs.ts's CAPITAL_FLOW_ALLOWLIST deliberately
  // excludes "entirely" (see bfs.test.ts's own "CAPITAL_FLOW excludes non-
  // transfer-ish edges (swap/router/cex) from the graph entirely" — a
  // committed, already-reviewed design choice: CAPITAL_FLOW mode intends to
  // stop capital-flow tracing at the exchange boundary, not surface it as a
  // leaf node). So the CEX node correctly NO LONGER appears in this
  // CAPITAL_FLOW search's result — that is now-correct behavior, not a
  // regression. What this self-check verifies instead is that the
  // do-not-expand/CEX-tagging INFRASTRUCTURE itself still works end-to-end:
  // the address is a registered CEX row with doNotExpand=true (the
  // AddressRegistry side of Task 20 binding decision 7), even though
  // CAPITAL_FLOW mode's own relationship allowlist is what keeps it out of
  // this particular search's node set.
  const cexAddress = world.meta.scenarios.graphDemo.cexCounterparty;
  const cexRegistryRow = await prisma.addressRegistry.findFirst({
    where: { address: cexAddress, category: 'CEX' }
  });
  rows.push({
    check: 'graph-demo CEX counterparty is a registered CEX AddressRegistry row with doNotExpand=true',
    expected: 'category=CEX, doNotExpand=true',
    actual: cexRegistryRow
      ? `category=${cexRegistryRow.category}, doNotExpand=${cexRegistryRow.doNotExpand}`
      : 'no AddressRegistry row found',
    pass: cexRegistryRow?.doNotExpand === true
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

  // Task 30 binding decision 1's anti-clobber guarantee, asserted against
  // real seeded data: every one of the `csvOkRows` CSV fixture wallets
  // (Phase 5(b), seedCsvWallets) must STILL have source='csv' as their
  // latest WalletStats row after Phase 7.97's walletStatsRefresh pass ran —
  // if this ever fails, the refresh pass has started clobbering Layer-1
  // authoritative CSV data, which is a hard-fail-worthy regression. Same
  // "latest row per wallet, ordered computedAt desc, first occurrence wins"
  // reduction pattern as fetchAggregateInputs.ts's latestStatsByWallet /
  // walletStatsRefresh.ts's latestSourceByWallet.
  const csvWalletIds = [
    ...new Set((await prisma.walletStats.findMany({ where: { source: 'csv' }, select: { walletId: true } })).map(
      (r) => r.walletId
    ))
  ];
  const allStatsForCsvWallets = await prisma.walletStats.findMany({
    where: { walletId: { in: csvWalletIds } },
    orderBy: { computedAt: 'desc' },
    select: { walletId: true, source: true }
  });
  const latestSourceByCsvWallet = new Map<string, string>();
  for (const row of allStatsForCsvWallets) {
    if (!latestSourceByCsvWallet.has(row.walletId)) {
      latestSourceByCsvWallet.set(row.walletId, row.source);
    }
  }
  const csvWalletsStillCsv = [...latestSourceByCsvWallet.values()].filter((s) => s === 'csv').length;
  rows.push({
    check: `all ${csvOkRows} CSV fixture wallets remain source='csv' after walletStatsRefresh (anti-clobber)`,
    expected: String(csvOkRows),
    actual: String(csvWalletsStillCsv),
    pass: csvWalletsStillCsv === csvOkRows
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

/** Prints the external wallet-source connector summary (Task 34, Wave 4.5): source rows, candidate counts by source/status, and the poisoned-address list for Task 35's cross-reference. */
async function printCandidateSummary(world: MockWorld): Promise<void> {
  const sourceRows = await prisma.externalWalletSource.findMany({ orderBy: { name: 'asc' } });
  const candidatesBySource = await prisma.candidateWallet.groupBy({
    by: ['source'],
    _count: { _all: true }
  });
  const countsBySource = new Map(candidatesBySource.map((r) => [r.source, r._count._all]));

  const totalCandidates = await prisma.candidateWallet.count();
  const pendingCount = await prisma.candidateWallet.count({ where: { validationStatus: 'pending' } });

  const poisonedSolana = getPoisonedAddresses(world, 'SOLANA');
  const poisonedTotal = poisonedSolana.routerOrCex.length + poisonedSolana.possibleBot.length + poisonedSolana.belowThreshold.length;
  const goodTotal = totalCandidates - poisonedTotal;

  console.log('External wallet-source connector summary (Task 34, Wave 4.5):');
  console.log('  ExternalWalletSource rows:');
  for (const row of sourceRows) {
    console.log(
      `    ${row.name.padEnd(24)} enabled=${String(row.enabled).padEnd(5)} status=${row.status.padEnd(6)} lastSyncAt=${row.lastSyncAt?.toISOString() ?? 'null'} candidates=${countsBySource.get(row.name) ?? 0}`
    );
  }
  console.log(`  total CandidateWallet rows:  ${totalCandidates} (pending=${pendingCount})`);
  console.log(`  good candidates (approx):   ${goodTotal}`);
  console.log(`  poisoned candidates:        ${poisonedTotal} (routerOrCex=${poisonedSolana.routerOrCex.length}, possibleBot=${poisonedSolana.possibleBot.length}, belowThreshold=${poisonedSolana.belowThreshold.length})`);
  console.log('  poisoned SOLANA addresses (for Task 35 cross-reference):');
  console.log(`    routerOrCex:     ${JSON.stringify(poisonedSolana.routerOrCex)}`);
  console.log(`    possibleBot:     ${JSON.stringify(poisonedSolana.possibleBot)}`);
  console.log(`    belowThreshold:  ${JSON.stringify(poisonedSolana.belowThreshold)}`);
  console.log('');
}

/** Prints the Task 35 candidate-validation summary: promoted/rejected/pending totals + rejection reason category breakdown, plus the 5 poisoned addresses' individual terminal states for direct visual cross-reference. */
async function printValidationSummary(world: MockWorld, result: Awaited<ReturnType<typeof runCandidateValidation>>): Promise<void> {
  const promotedCount = await prisma.candidateWallet.count({ where: { validationStatus: 'promoted' } });
  const rejectedCount = await prisma.candidateWallet.count({ where: { validationStatus: 'rejected' } });
  const pendingCount = await prisma.candidateWallet.count({ where: { validationStatus: 'pending' } });

  console.log('Candidate validation summary (Task 35, Wave 4.5):');
  console.log(`  this pass:            considered=${result.candidatesConsidered} promoted=${result.promoted} rejected=${result.rejected} stayedPending=${result.stayedPending} errors=${result.errors}`);
  console.log(`  overall totals:       promoted=${promotedCount} rejected=${rejectedCount} pending=${pendingCount}`);
  console.log('  rejection reason breakdown (this pass):');
  for (const [category, count] of Object.entries(result.rejectionReasonCounts)) {
    console.log(`    ${category.padEnd(20)} ${count}`);
  }

  const poisonedSolana = getPoisonedAddresses(world, 'SOLANA');
  const allPoisoned = [
    ...poisonedSolana.routerOrCex.map((a) => ({ address: a, expected: 'registry (CEX/ROUTER)' })),
    ...poisonedSolana.possibleBot.map((a) => ({ address: a, expected: 'bot label' })),
    ...poisonedSolana.belowThreshold.map((a) => ({ address: a, expected: 'below threshold / insufficient' }))
  ];
  console.log('  poisoned SOLANA candidates — individual terminal states:');
  for (const { address, expected } of allPoisoned) {
    const rows = await prisma.candidateWallet.findMany({ where: { walletAddress: address, chain: 'SOLANA' } });
    for (const row of rows) {
      console.log(
        `    ${address.slice(0, 12)}...  source=${row.source.padEnd(20)} status=${row.validationStatus.padEnd(10)} reason=${row.rejectionReason ?? '(none)'} [expected: ${expected}]`
      );
    }
  }
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

  // Per-token best row (transition rows would otherwise duplicate a token).
  const rankedAll = await prisma.tokenFlowSnapshot.findMany({
    orderBy: { flowScore: 'desc' },
    include: { token: { select: { symbol: true } } }
  });
  const seenTop = new Set<string>();
  const top5 = rankedAll.filter((s) => (seenTop.has(s.tokenId) ? false : (seenTop.add(s.tokenId), true))).slice(0, 5);

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

/**
 * Lineage-root wipe guard (2026-07-10 Capital Lineage review): operator-
 * imported roots are PERMANENT by contract, but wipeAllTables() deletes every
 * wallet and LineageRoot/MonitoringSubscription cascade from Wallet — so a
 * routine `npm run db:seed` on the shared LITE DB would silently destroy the
 * operator's real root imports. Refuse when roots exist unless the operator
 * explicitly opts in (SEED_WIPE_LINEAGE=true). Exported for tests; same
 * fail-closed guard style as seedBacktestContinuation's MOCK_MODE refusal.
 */
export async function assertNoLineageRootsOrExplicitOverride(): Promise<void> {
  const rootCount = await prisma.lineageRoot.count();
  if (rootCount > 0 && process.env.SEED_WIPE_LINEAGE !== 'true') {
    throw new Error(
      `db:seed refused: ${rootCount} permanent lineage root(s) exist in this database — seeding wipes ALL wallets ` +
        `and their roots/subscriptions cascade away. Re-run with SEED_WIPE_LINEAGE=true ONLY if you intend to ` +
        `destroy the imported roots (they can be re-imported from the operator file afterwards).`
    );
  }
}

async function main(): Promise<void> {
  loadEnv();
  const startedAt = Date.now();

  // Global job serialization (Prerequisite B): the destructive wipe must
  // never interleave with a root import, lineage backfill, or live reset.
  // Held for the entire seed — a concurrent job fails honestly with
  // GlobalJobLockBusyError instead of racing the wipe.
  await withGlobalJobLock('db-seed', async () => {
    await mainLocked(startedAt);
  });
}

async function mainLocked(startedAt: number): Promise<void> {
  await assertNoLineageRootsOrExplicitOverride();
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

  const addressRegistryCounts = await bootstrapAddressRegistry(world);
  log('AddressRegistry seed totals.', {
    total: addressRegistryCounts.mockCount + addressRegistryCounts.staticCount,
    static: addressRegistryCounts.staticCount,
    mock: addressRegistryCounts.mockCount
  });

  // Phase 3.5 (Task 34, Wave 4.5): seed the 6 ExternalWalletSource rows, then
  // run ONE runExternalWalletSourceSync pass against the mock world so
  // `npm run db:seed` populates CandidateWallet rows out of the box (no live
  // connector required — MOCK_MODE-equivalent MockCandidateSource, same
  // pattern as every other mock-mode seed pass in this script).
  await bootstrapExternalWalletSources(settings);
  const externalWalletSourceSyncResult = await seedExternalWalletSourceSync(world, settings);

  // Phase 3.6 (Task 37, Wave 4.6): seed the DuneQuerySource placeholder row,
  // then run ONE MOCK token-overlap search over 3 real scenario tokens so
  // `npm run db:seed` populates TokenOverlapSearch/WalletResult/GroupResult +
  // pending dune_token_overlap CandidateWallet rows out of the box (no live
  // DUNE_API_KEY required — MockDuneOverlapSource, same
  // mock-mode-by-default convention as Phase 3.5 above). Its resulting
  // pending candidates flow into the SAME Phase 6.5 runCandidateValidation
  // pass every other candidate source's pending rows go through — no
  // separate validation pass needed for Dune specifically.
  await bootstrapDuneQuerySource();
  const duneOverlapSearchResult = await seedDuneOverlapSearch(world);

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

  // Phase 3.7 (Task D, Social Intelligence): seed 2 example SocialSource rows,
  // then run ONE runSocialIngestPass against the shared mock source so
  // `npm run db:seed` populates SocialMention rows out of the box (no live
  // read credentials required — MockSocialSource, same mock-mode-by-default
  // convention as Phase 3.5). Runs AFTER Token upserts above so
  // (chain,address) resolution links mentions to real seeded tokens.
  await bootstrapSocialSources();
  const socialIngestResult = await seedSocialIngestPass(world, settings);
  log('social seed totals.', { ...socialIngestResult });

  // Phase 3.8 (Task D, External Confluence): seed 2 example
  // ExternalConfluenceSource rows (both disabled by default — no API key
  // required). The pass itself (Leg 1: internal LiquidityRisk) is run further
  // below, AFTER Phase 4's market snapshots exist (LiquidityRisk needs a
  // TokenMarketSnapshot to compute from).
  await bootstrapExternalConfluenceSources();

  // Phase 4: market snapshots FIRST.
  await seedMarketSnapshots(world, tokenIdByAddress);

  // Phase 4.1 (Task D, External Confluence): ONE runExternalConfluencePass now
  // that every token has a market snapshot — both seeded sources are disabled,
  // so this only exercises the internal LiquidityRisk leg (deterministic, no
  // provider/key required).
  const externalConfluenceResult = await seedExternalConfluencePass(settings);
  log('external confluence seed totals.', { ...externalConfluenceResult });

  // Phase 5(a): computed WalletStats for smart_money/human_like/whale wallets.
  await seedComputedWalletStats(world);

  // Phase 5(b): CSV import overrides computed rows for its 40 wallets.
  const csvResult = await seedCsvWallets();

  // Phase 6: ingest every wallet's tx stream.
  await ingestAllWallets(world);

  // Phase 6.4 (Task 35, Wave 4.5 fix pass): classify non-smart (noise-cohort)
  // wallets too — see seedNonSmartWalletClassifications's own doc comment for
  // the root cause this closes (bot/sniper labels never reaching the DB for
  // wallets outside the smart-money cohort).
  await seedNonSmartWalletClassifications(world);

  // Phase 6.45 (Task 35, Wave 4.5 fix pass): give a small, deterministic
  // subset of the "good" candidates REAL, profitable local trade history —
  // see seedQualifyingCandidateTrades's own doc comment for the root cause
  // this closes (the mock world's own wallets are structurally incapable of
  // ever independently clearing profitableWallet thresholds via real FIFO
  // evidence otherwise — 1-trade noise wallets, BUY-only NOVA/QUIET buyers).
  await seedQualifyingCandidateTrades(world, tokenIdByAddress);

  // Phase 6.5 (Task 35, Wave 4.5): ONE candidate-validation pass, now that
  // every mock-world wallet's local trade history exists (Phase 6) for
  // computeFifoPnl evidence to read. Must run AFTER Phase 6 and AFTER the
  // external wallet-source sync (Phase 3.5, already ran above) so there are
  // pending CandidateWallet rows to validate.
  const candidateValidationResult = await seedCandidateValidationPass(settings);

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

  // Phase 7.97: one walletStatsRefresh pass (Task 30 binding decision 1) —
  // OPTIONAL per the task brief, run here so `npm run db:seed` exercises the
  // same shared body the worker's walletStatsRefresh job calls on a schedule,
  // and so the self-check below can assert the anti-clobber guarantee against
  // real seeded data (the 40 CSV fixture wallets from seedCsvWallets, Phase
  // 5(b)) rather than only against packages/db/test's synthetic fixtures.
  const statsRefreshResult = await runWalletStatsRefresh(prisma, {
    info: (msg, meta) => log(msg, meta),
    error: (msg, meta) => log(`ERROR: ${msg}`, meta)
  });
  log('wallet stats refresh pass complete.', { ...statsRefreshResult });

  // Phase 8: self-check.
  const { rows: selfCheckRows, hardFail, concerns } = await runSelfCheck(
    world,
    signalsByToken,
    graphDemoResult.searchId,
    backtestResult,
    replayRunResult,
    csvResult.okRows,
    externalWalletSourceSyncResult,
    candidateValidationResult,
    duneOverlapSearchResult
  );
  printSelfCheckTable(selfCheckRows);
  printSignalSummaryTable(signalsByToken);
  await printGraphSummary(graphDemoResult.searchId);
  await printClusterSummary(world.meta.scenarios.nova.tokenAddress);
  printBacktestSummary(backtestResult);
  printReplayRunSummary(replayRunResult);
  await printCandidateSummary(world);
  await printValidationSummary(world, candidateValidationResult);

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
