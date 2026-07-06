// FlowRadar — worker bootstrap (Task 5 brief decision 4).
//
// Boot sequence:
//   1. Load .env from the repo root (dotenv) — same convention as
//      packages/db/src/client.ts / scripts/db-local.ts.
//   2. Ensure the LITE-mode embedded Postgres cluster is up (spawns
//      `tsx ../../scripts/db-local.ts ensure` as a child process — db-local.ts
//      only exposes its ensure/stop logic through its CLI `main()`, not as an
//      importable function, so spawning is the integration point; it's a
//      no-op in FULL mode per db-local.ts's own isFullMode() check).
//   3. Read/create the Settings singleton row (see readOrCreateSettings()
//      below for why this queries by "the one row that exists" rather than a
//      literal id — schema.prisma's Settings.id is a cuid()-default String
//      PK, not an integer "1").
//   4. In MOCK_MODE (default), construct ONE shared MockProvider bound to
//      `now = real wall-clock time at boot` (world genesis = now - 72h) and
//      route every ctx.providers(chain, capability) call in every job to
//      that single instance, so every job sees a mutually consistent world
//      snapshot for the life of this process. Live mode instead routes
//      straight through @flowradar/providers's getProvider (Wave 4 — reports
//      missing_key/stub rather than crashing).
//   5. createRunner() (InlineRunner in LITE/no-REDIS_URL, BullMqRunner in
//      FULL), register the scheduled jobs (walletActivity, marketDataHot,
//      marketDataNormal, flowScoring, entityClustering, moneyFlow,
//      bridgeFlow, profitRotation, signalDetection, alertDispatch, backtest —
//      entityClustering added Task 22; moneyFlow/bridgeFlow/profitRotation
//      added Task 23; backtest added Task 40 (its own intervals.backtestHours
//      converted to seconds before sharing the same ms pipeline every other
//      job uses)) on schedule() with settings.intervals.* converted to ms,
//      plus walletImport/walletGraph registered on-demand via process() (see
//      below) — WORKER_FAST=1 overrides every scheduled interval to 3s so a
//      manual verification run doesn't need to wait minutes for a full cycle
//      of the slowest job (marketDataNormalSec, default 300s).
//   6. runner.start(). SIGINT/SIGTERM => runner.stop() => prisma.$disconnect()
//      => process.exit(0).

import { config as loadDotenv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { DEFAULT_SETTINGS, parseSettings } from '@flowradar/core';
import type { Chain, Settings } from '@flowradar/core';
import { prisma } from '@flowradar/db';
import { createMockWorld, MockProvider } from '@flowradar/providers';
import { createRunner } from './runner/index';
import { createConsoleLogger, defaultProviderResolver } from './context';
import type { JobContext, ProviderResolver } from './context';
import * as walletActivity from './jobs/walletActivity';
import * as marketDataHot from './jobs/marketDataHot';
import * as marketDataNormal from './jobs/marketDataNormal';
import * as flowScoring from './jobs/flowScoring';
import * as entityClustering from './jobs/entityClustering';
import * as moneyFlow from './jobs/moneyFlow';
import * as bridgeFlow from './jobs/bridgeFlow';
import * as profitRotation from './jobs/profitRotation';
import * as signalDetection from './jobs/signalDetection';
import * as alertDispatch from './jobs/alertDispatch';
import * as backtest from './jobs/backtest';
import * as walletImport from './jobs/walletImport';
import * as walletGraph from './jobs/walletGraph';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const HOUR_MS = 60 * 60 * 1000;
const WORLD_HORIZON_HOURS = 72;
const WORKER_FAST_INTERVAL_MS = 3000;

function loadEnv(): void {
  const envPath = path.join(REPO_ROOT, '.env');
  if (existsSync(envPath)) {
    loadDotenv({ path: envPath });
  }
}

function isMockMode(): boolean {
  return process.env.MOCK_MODE !== 'false';
}

/**
 * Runs `scripts/db-local.ts ensure` as a child process (no-op in FULL mode —
 * see db-local.ts's own isFullMode() check). Spawns the current Node binary
 * directly against tsx's resolved CLI entry point rather than shelling out to
 * the `npx`/`tsx` command-name shims — `npx`/`tsx.cmd` are `.cmd` files on
 * Windows, which `child_process.spawn` can only invoke via `shell: true`
 * (itself a documented Node deprecation warning as of Node 22+ when combined
 * with an args array). Resolving tsx's actual entry script and running it
 * with `node <script>` avoids both the shim and the shell entirely.
 */
function ensureLiteDatabase(log: ReturnType<typeof createConsoleLogger>): void {
  const scriptPath = path.join(REPO_ROOT, 'scripts', 'db-local.ts');
  const tsxCliPath = fileURLToPath(import.meta.resolve('tsx/cli'));
  log.info('ensuring LITE-mode database is reachable...');
  const result = spawnSync(process.execPath, [tsxCliPath, scriptPath, 'ensure'], {
    cwd: REPO_ROOT,
    stdio: 'inherit'
  });
  if (result.status !== 0) {
    throw new Error(`db-local.ts ensure failed (exit ${result.status ?? 'unknown'})`);
  }
}

/**
 * Settings is a singleton table (see schema.prisma comment on the model),
 * but its `id` is a cuid()-default String PK — there is no stable literal
 * value ("1") to query by directly. findFirst() reads whichever row exists
 * (there is only ever meant to be one); if none exists yet, one is created
 * from DEFAULT_SETTINGS. Either way, the returned row's `values` Json column
 * is parsed/validated through parseSettings (deep-merges over
 * DEFAULT_SETTINGS + Zod validation) before use.
 */
async function readOrCreateSettings(log: ReturnType<typeof createConsoleLogger>): Promise<Settings> {
  const existing = await prisma.settings.findFirst();
  if (existing) {
    log.info('loaded existing Settings row');
    return parseSettings(existing.values);
  }
  log.info('no Settings row found — creating from DEFAULT_SETTINGS');
  const created = await prisma.settings.create({ data: { values: DEFAULT_SETTINGS } });
  return parseSettings(created.values);
}

/** Builds the ctx.providers resolver: one shared MockProvider in MOCK_MODE, or the real getProvider registry in live mode. */
function buildProviderResolver(log: ReturnType<typeof createConsoleLogger>): ProviderResolver {
  if (!isMockMode()) {
    return defaultProviderResolver;
  }
  const now = new Date();
  const genesis = new Date(now.getTime() - WORLD_HORIZON_HOURS * HOUR_MS);
  const world = createMockWorld({ genesis });
  const sharedProvider = new MockProvider(world, { now });
  log.info('MOCK_MODE active — constructed shared MockProvider', {
    genesis: genesis.toISOString(),
    now: now.toISOString()
  });
  // MockProvider implements every ProviderCapabilityMap interface on one
  // class (same pattern as @flowradar/providers's own registry.ts getProvider
  // — see its "narrows the shared instance to the specific capability" cast
  // comment); the cast here mirrors that one exactly, just applied at the
  // resolver-function level since this resolver always returns the same
  // shared instance regardless of which (chain, capability) was requested.
  return ((_chain: Chain, _capability: string) => sharedProvider) as unknown as ProviderResolver;
}

function intervalMsFor(settingsSec: number, fast: boolean): number {
  return fast ? WORKER_FAST_INTERVAL_MS : settingsSec * 1000;
}

async function main(): Promise<void> {
  loadEnv();
  const bootLog = createConsoleLogger('worker');

  ensureLiteDatabase(bootLog);

  const settings = await readOrCreateSettings(bootLog);
  const providers = buildProviderResolver(bootLog);

  const fast = process.env.WORKER_FAST === '1';
  if (fast) {
    bootLog.info('WORKER_FAST=1 — all job intervals overridden to 3s for verification runs');
  }

  const runner = createRunner();

  const jobs: { name: string; run: (ctx: JobContext) => Promise<void>; intervalSec: number }[] = [
    { name: 'walletActivity', run: walletActivity.run, intervalSec: settings.intervals.walletActivitySec },
    { name: 'marketDataHot', run: marketDataHot.run, intervalSec: settings.intervals.marketDataHotSec },
    { name: 'marketDataNormal', run: marketDataNormal.run, intervalSec: settings.intervals.marketDataNormalSec },
    { name: 'flowScoring', run: flowScoring.run, intervalSec: settings.intervals.flowScoringSec },
    { name: 'entityClustering', run: entityClustering.run, intervalSec: settings.intervals.entityClusteringSec },
    { name: 'moneyFlow', run: moneyFlow.run, intervalSec: settings.intervals.moneyFlowSec },
    { name: 'bridgeFlow', run: bridgeFlow.run, intervalSec: settings.intervals.bridgeFlowSec },
    { name: 'profitRotation', run: profitRotation.run, intervalSec: settings.intervals.profitRotationSec },
    { name: 'signalDetection', run: signalDetection.run, intervalSec: settings.intervals.signalDetectionSec },
    { name: 'alertDispatch', run: alertDispatch.run, intervalSec: settings.intervals.alertDispatchSec },
    // backtestHours is expressed in HOURS (not seconds, like every other
    // intervals.* field above) — converted to seconds here so it can share
    // the same `intervalSec` -> intervalMsFor() pipeline (and therefore the
    // same WORKER_FAST=1 -> 3s override) as every other scheduled job.
    { name: 'backtest', run: backtest.run, intervalSec: settings.intervals.backtestHours * 3600 }
  ];

  for (const job of jobs) {
    const intervalMs = intervalMsFor(job.intervalSec, fast);
    const log = createConsoleLogger(job.name);
    runner.schedule(job.name, intervalMs, async () => {
      const startedAt = Date.now();
      try {
        await job.run({ prisma, settings, providers, log });
      } catch (err) {
        // Belt-and-suspenders: every job's own run() is written to catch its
        // own per-item errors and never rethrow (Task 5 brief decision 3),
        // but guard here too so a truly unexpected throw still gets logged
        // with a duration line instead of silently vanishing into the
        // runner's own catch (InlineRunner/BullMqRunner both log unhandled
        // job errors, but without the structured "name/duration" line below).
        log.error(`${job.name} threw unexpectedly`, { error: err instanceof Error ? err.message : String(err) });
      } finally {
        const durationMs = Date.now() - startedAt;
        log.info(`${job.name} run finished`, { durationMs });
      }
    });
    bootLog.info(`registered job "${job.name}"`, { intervalMs });
  }

  // walletImport (Task 12 binding decision 6): registered via
  // runner.process(...), not runner.schedule(...) — on-demand only, no
  // interval. Uses the same JobContext (prisma/settings/providers/log) as
  // every scheduled job above, even though the job itself only needs
  // ctx.prisma + ctx.log (settings/providers are unused by walletImport but
  // JobContext is a fixed shape every job receives, per context.ts).
  walletImport.register({ prisma, settings, providers, log: createConsoleLogger('walletImport') }, runner);
  bootLog.info('registered job "walletImport" (on-demand, no schedule)');

  // walletGraph (Task 20 binding decision 3): registered via runner.process(...),
  // on-demand only, same pattern as walletImport above.
  walletGraph.register({ prisma, settings, providers, log: createConsoleLogger('walletGraph') }, runner);
  bootLog.info('registered job "walletGraph" (on-demand, no schedule)');

  await runner.start();
  bootLog.info('worker started — runner is now ticking scheduled jobs');

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    bootLog.info(`received ${signal} — shutting down`);
    await runner.stop();
    await prisma.$disconnect();
    bootLog.info('shutdown complete');
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[worker] fatal error during bootstrap:', err);
  process.exitCode = 1;
});
