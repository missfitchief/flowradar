#!/usr/bin/env tsx
/**
 * LITE-mode Postgres lifecycle helper (spec §2 / task-2-brief).
 *
 * FlowRadar ships two infra modes with identical application code:
 *   - FULL: Docker Compose postgres:16 (+ redis:7 for BullMQ). Detected when
 *     REDIS_URL is set, or DATABASE_URL points at the FULL-mode port (5432).
 *   - LITE (default, no Docker): a real PostgreSQL 16 cluster started from the
 *     `embedded-postgres` npm package's bundled binaries, data persisted in
 *     ./.pgdata, listening on port 5439.
 *
 * Subcommands:
 *   ensure  Idempotent. No-op in FULL mode. In LITE mode: initialises
 *           ./.pgdata if absent, starts Postgres on 5439 if not already
 *           accepting connections, and creates the flowradar role/database if
 *           missing. Safe to call from every `npm run db:*` script.
 *   stop    Idempotent. Stops the LITE-mode cluster if running; no-op
 *           otherwise (including when never initialised, or in FULL mode).
 *
 * Cross-command persistence (critical requirement): each `npm run db:*`
 * invocation is a brand-new Node process. The `embedded-postgres` package's
 * own `.start()`/`.stop()` API registers a Node exit hook that shuts the
 * cluster down the moment the *calling* script's process exits — which would
 * kill Postgres the instant `ensure` returns. To avoid that, this script never
 * calls `.start()` on an EmbeddedPostgres instance for the long-lived server;
 * it shells out to the `pg_ctl` binary directly (resolved from the
 * platform-specific `@embedded-postgres/<platform>` binary package's
 * `native/bin/` directory — a published, `files`-manifested layout, not a
 * private subpath of `embedded-postgres` itself). `pg_ctl start` daemonizes
 * Postgres as an independent OS process unmanaged by any Node process's
 * lifetime, and `pg_ctl stop`/`status` control that same process from any
 * later, unrelated invocation purely via the data directory — which is
 * exactly the "survives across separate npm commands" behavior this script
 * needs. Verified manually against this cluster (see task-2-report.md for the
 * two-separate-command proof).
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import EmbeddedPostgres from 'embedded-postgres';
import { Client } from 'pg';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(REPO_ROOT, '.pgdata');
// Server log lives inside .pgdata itself (already gitignored) rather than a new
// root-level pattern.
const LOG_FILE = path.join(DATA_DIR, 'server.log');
// Prisma CLI (migrate/studio/validate) auto-loads a .env from its own CWD,
// which for `npm run db:migrate -w packages/db` is packages/db/ itself — not
// the repo root. `ensure` writes the effective LITE DATABASE_URL there so
// every child `prisma` invocation picks it up with zero extra configuration.
const DB_PACKAGE_ENV_FILE = path.join(REPO_ROOT, 'packages', 'db', '.env');
// Sentinel written once ensureDatabaseAndRole() confirms/creates the
// flowradar database. Nothing in this codebase ever drops that database, so
// once this marker exists there is no need to open a fresh maintenance
// connection and re-query pg_database on every subsequent `ensure` call —
// which otherwise happens on every single `npm run db:migrate`/`db:studio`
// invocation, forever, even once the database has existed for months.
const DATABASE_READY_MARKER = path.join(DATA_DIR, 'flowradar-db-ready');

// This is the source of truth for the actual LITE cluster's host/port/creds.
// packages/db/src/client.ts keeps its own last-resort fallback copy of these
// same values (LITE_DEFAULT_*) for when it's imported without `ensure` having
// run first — keep both in sync if these ever change.
const LITE_HOST = 'localhost';
const LITE_PORT = 5439;
const LITE_USER = 'flowradar';
const LITE_PASSWORD = 'flowradar';
const LITE_DATABASE = 'flowradar';
// Postgres's own default port. Also the port Docker Compose's FULL-mode
// postgres:16 service publishes (docker-compose.yml maps 5432:5432), so this
// single constant doubles as both "Postgres's implicit default" (used when a
// DATABASE_URL omits a port) and "the FULL-mode signal port".
const FULL_MODE_PORT = 5432;

function loadEnv(): void {
  const envPath = path.join(REPO_ROOT, '.env');
  if (existsSync(envPath)) {
    loadDotenv({ path: envPath });
  }
  // Root .env may not exist at all — LITE mode must still work from defaults.
}

function parsePort(databaseUrl: string | undefined): number | undefined {
  if (!databaseUrl) return undefined;
  try {
    const url = new URL(databaseUrl);
    // A postgresql:// URL with no explicit port (e.g.
    // postgresql://user:pass@host/db) implicitly means Postgres's own default
    // port, 5432. Treating "no port" as "no signal" would misclassify a real
    // FULL-mode connection string (which may legitimately omit an explicit
    // :5432) as LITE mode.
    return url.port ? Number(url.port) : FULL_MODE_PORT;
  } catch {
    return undefined;
  }
}

/**
 * FULL mode is signalled by REDIS_URL being set (BullMQ needs Redis, which
 * only exists in the Docker Compose FULL path), or DATABASE_URL explicitly
 * pointing at the FULL-mode Postgres port (5432, i.e. Docker Compose's
 * postgres:16 service). Absent both signals, LITE mode is assumed — matching
 * the .env.example default (DATABASE_URL at :5439, REDIS_URL empty).
 */
function isFullMode(): boolean {
  const redisUrl = process.env.REDIS_URL?.trim();
  if (redisUrl) return true;
  const port = parsePort(process.env.DATABASE_URL);
  return port === FULL_MODE_PORT;
}

function probePort(host: string, port: number, timeoutMs = 800): Promise<boolean> {
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

function isInitialised(): boolean {
  // A cluster data directory is considered initialised once initdb has
  // written PG_VERSION into it.
  return existsSync(path.join(DATA_DIR, 'PG_VERSION'));
}

/** Maps Node's process.platform/arch to the `@embedded-postgres/<name>` binary package name. */
function platformPackageName(): string {
  const platformMap: Record<string, string> = {
    win32: 'windows',
    darwin: 'darwin',
    linux: 'linux',
  };
  const archMap: Record<string, string> = {
    x64: 'x64',
    arm64: 'arm64',
    arm: 'arm',
    ia32: 'ia32',
    ppc64: 'ppc64',
  };
  const platform = platformMap[process.platform];
  const arch = archMap[process.arch];
  if (!platform || !arch) {
    throw new Error(
      `Unsupported platform for embedded-postgres: ${process.platform}/${process.arch}`,
    );
  }
  return `@embedded-postgres/${platform}-${arch}`;
}

/**
 * Resolves the `pg_ctl` binary shipped by the platform-specific
 * `@embedded-postgres/<platform>` package. That package's only public
 * `exports` entry is its main `dist/index.js` (its `package.json` itself is
 * NOT resolvable as a subpath under Node's strict ESM `exports` map), so this
 * resolves the main entry point and walks up one directory to the package
 * root, then joins the `native/bin/` layout that package publishes (declared
 * in its own `files` manifest) — stable across embedded-postgres versions
 * without reaching into `embedded-postgres`'s own private dist/ subpaths.
 */
async function resolvePgCtlPath(): Promise<string> {
  const pkgName = platformPackageName();
  const entryUrl = import.meta.resolve(pkgName);
  const pkgDir = path.dirname(path.dirname(fileURLToPath(entryUrl))); // dist/index.js -> dist -> package root
  const exeName = process.platform === 'win32' ? 'pg_ctl.exe' : 'pg_ctl';
  const binPath = path.join(pkgDir, 'native', 'bin', exeName);
  if (!existsSync(binPath)) {
    throw new Error(`Could not find pg_ctl binary at expected path: ${binPath}`);
  }
  return binPath;
}

async function initialiseCluster(): Promise<void> {
  mkdirSync(DATA_DIR, { recursive: true });
  const pg = new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    port: LITE_PORT,
    user: LITE_USER,
    password: LITE_PASSWORD,
    authMethod: 'password',
    persistent: true,
  });
  console.log(`[db-local] initialising Postgres 16 cluster in ${DATA_DIR} ...`);
  await pg.initialise();
  console.log('[db-local] cluster initialised.');
}

async function startCluster(): Promise<void> {
  const pgCtl = await resolvePgCtlPath();
  console.log(`[db-local] starting Postgres on port ${LITE_PORT} via pg_ctl ...`);
  // `pg_ctl start` launches `postgres` as a detached grandchild that inherits
  // pg_ctl's own stdio handles. On Windows, spawnSync's default `stdio: 'pipe'`
  // then blocks waiting for those pipes to close — which only happens when the
  // (intentionally long-lived, detached) postgres process itself exits, i.e.
  // never, hanging the ensure command forever even though startup already
  // succeeded. `stdio: 'ignore'` sidesteps the inherited-handle problem
  // entirely; readiness is confirmed independently via waitForPort() below,
  // and failures surface through pg_ctl's own non-zero exit code plus the
  // -l LOG_FILE server log rather than captured stdout/stderr text.
  const result = spawnSync(
    pgCtl,
    ['-D', DATA_DIR, '-l', LOG_FILE, '-o', `-p ${LITE_PORT}`, 'start'],
    { stdio: 'ignore' },
  );
  if (result.status !== 0) {
    // Benign-race check: probePort() and pg_ctl start are not atomic, so two
    // `ensure` invocations started within the same window (e.g. `db:migrate`
    // and `db:studio` launched back-to-back) can both observe the port as
    // down and both attempt to start the cluster. The loser's `pg_ctl start`
    // fails (lock file already held by the winner), but Postgres itself is
    // fine — only re-report failure if the port is genuinely still
    // unreachable after this attempt.
    if (await probePort(LITE_HOST, LITE_PORT)) {
      console.log(
        '[db-local] pg_ctl start reported an error, but Postgres is already accepting ' +
          'connections — likely a concurrent `ensure` invocation won the race. Continuing.',
      );
      return;
    }
    throw new Error(
      `pg_ctl start failed (exit ${result.status}). See log: ${LOG_FILE}`,
    );
  }
  console.log('[db-local] pg_ctl reported the server started.');
}

async function ensureDatabaseAndRole(): Promise<void> {
  if (existsSync(DATABASE_READY_MARKER)) {
    // Already confirmed on a previous `ensure` call — skip the maintenance
    // connection + query entirely.
    return;
  }

  const client = new Client({
    host: LITE_HOST,
    port: LITE_PORT,
    user: LITE_USER,
    password: LITE_PASSWORD,
    database: 'postgres',
  });
  await client.connect();
  try {
    const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      LITE_DATABASE,
    ]);
    if (existing.rowCount === 0) {
      console.log(`[db-local] creating database "${LITE_DATABASE}" ...`);
      // Database names cannot be parameterised; LITE_DATABASE is a fixed
      // internal constant, never user input.
      await client.query(`CREATE DATABASE "${LITE_DATABASE}"`);
    }
  } finally {
    await client.end();
  }

  writeFileSync(DATABASE_READY_MARKER, `${new Date().toISOString()}\n`, 'utf-8');
}

async function waitForPort(host: string, port: number, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await probePort(host, port, 500)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Postgres did not become reachable on ${host}:${port} within ${timeoutMs}ms`);
}

function effectiveLiteDatabaseUrl(): string {
  return `postgresql://${LITE_USER}:${LITE_PASSWORD}@${LITE_HOST}:${LITE_PORT}/${LITE_DATABASE}`;
}

/**
 * Writes the effective LITE-mode DATABASE_URL to packages/db/.env so that
 * `prisma migrate dev` / `prisma studio` / `prisma validate` — each invoked as
 * a separate child process from within packages/db — pick it up automatically
 * via Prisma CLI's own .env auto-loading, without needing DATABASE_URL to
 * already be exported in the caller's shell.
 */
function writeEffectiveDatabaseUrlForChildCommands(): void {
  const contents = `# Auto-generated by scripts/db-local.ts ensure — do not edit by hand.\nDATABASE_URL="${effectiveLiteDatabaseUrl()}"\n`;
  writeFileSync(DB_PACKAGE_ENV_FILE, contents, 'utf-8');
  console.log(`[db-local] wrote ${DB_PACKAGE_ENV_FILE}`);
}

async function ensure(): Promise<void> {
  loadEnv();

  if (isFullMode()) {
    console.log(
      '[db-local] FULL mode detected (REDIS_URL set or DATABASE_URL uses port 5432) — ' +
        'skipping LITE-mode Postgres lifecycle. Run `docker compose up -d` if Postgres/Redis are not already up.',
    );
    return;
  }

  console.log('[db-local] LITE mode — ensuring embedded Postgres 16 is available.');

  // Everything below (including the already-running fast path) shares one
  // failure handler, so a connection error in ensureDatabaseAndRole() gets
  // the same friendly Docker-fallback message as a cold-start failure.
  try {
    const alreadyUp = await probePort(LITE_HOST, LITE_PORT);
    if (alreadyUp) {
      console.log(`[db-local] Postgres already accepting connections on port ${LITE_PORT}.`);
    } else {
      if (!isInitialised()) {
        await initialiseCluster();
      } else {
        console.log(`[db-local] existing data directory found at ${DATA_DIR}, skipping initdb.`);
      }

      await startCluster();
      await waitForPort(LITE_HOST, LITE_PORT);
    }

    await ensureDatabaseAndRole();
    writeEffectiveDatabaseUrlForChildCommands();

    console.log(`[db-local] ready. DATABASE_URL=${effectiveLiteDatabaseUrl()}`);
  } catch (err) {
    console.error('[db-local] failed to start LITE-mode Postgres.');
    console.error(err instanceof Error ? err.message : err);
    console.error(
      '\n[db-local] Fallback: install Docker Desktop and run FULL mode instead:\n' +
        '  docker compose up -d\n' +
        '  # then set REDIS_URL (see .env.example) and re-run this command.\n' +
        'See README.md "LITE mode" section for details.',
    );
    process.exitCode = 1;
  }
}

async function stop(): Promise<void> {
  loadEnv();

  if (isFullMode()) {
    console.log('[db-local] FULL mode detected — nothing for this script to stop (use `docker compose down`).');
    return;
  }

  if (!existsSync(DATA_DIR) || !isInitialised()) {
    console.log('[db-local] no LITE-mode data directory found — nothing to stop.');
    return;
  }

  const pgCtl = await resolvePgCtlPath();
  const result = spawnSync(pgCtl, ['-D', DATA_DIR, 'stop'], { encoding: 'utf-8' });
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.status === 0) {
    console.log('[db-local] Postgres stopped.');
  } else if (/is not running|no server running/i.test(output)) {
    console.log('[db-local] Postgres was not running.');
  } else {
    console.error(`[db-local] pg_ctl stop failed (exit ${result.status}):\n${output}`);
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  const [, , subcommand] = process.argv;
  switch (subcommand) {
    case 'ensure':
      await ensure();
      break;
    case 'stop':
      await stop();
      break;
    default:
      console.error('Usage: tsx scripts/db-local.ts <ensure|stop>');
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('[db-local] unexpected error:', err);
  process.exitCode = 1;
});
