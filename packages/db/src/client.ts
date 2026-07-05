import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { PrismaClient } from '@prisma/client';

// LITE-mode default connection string (spec §13). Must stay in sync with the
// LITE_HOST/LITE_PORT/LITE_USER/LITE_PASSWORD/LITE_DATABASE constants in
// scripts/db-local.ts, which is the source of truth for the actual running
// cluster's credentials/port — this is only the last-resort fallback used
// when neither a root .env nor packages/db/.env (written by db-local.ts
// ensure) supplies DATABASE_URL.
const LITE_DEFAULT_HOST = 'localhost';
const LITE_DEFAULT_PORT = 5439;
const LITE_DEFAULT_USER = 'flowradar';
const LITE_DEFAULT_PASSWORD = 'flowradar';
const LITE_DEFAULT_DATABASE = 'flowradar';
const LITE_DEFAULT_DATABASE_URL = `postgresql://${LITE_DEFAULT_USER}:${LITE_DEFAULT_PASSWORD}@${LITE_DEFAULT_HOST}:${LITE_DEFAULT_PORT}/${LITE_DEFAULT_DATABASE}`;

function loadEnvFromRepoRoot(): void {
  // packages/db/src -> repo root is two levels up.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, '..', '..', '..');
  const envPath = path.join(repoRoot, '.env');
  // Root .env may not exist (LITE mode works from defaults alone) — only load if present.
  if (existsSync(envPath)) {
    loadDotenv({ path: envPath });
  }
}

function resolveDatabaseUrl(): string {
  loadEnvFromRepoRoot();
  return process.env.DATABASE_URL ?? LITE_DEFAULT_DATABASE_URL;
}

/**
 * Singleton PrismaClient, constructed once at module load using DATABASE_URL
 * resolved from a root .env (if present) or the LITE default otherwise.
 * `new PrismaClient()` does not itself open a database connection — Prisma's
 * client is internally lazy and only connects on the first query — so this
 * eager construction has the same "no connection until first real use"
 * behavior as a hand-rolled lazy wrapper, without adding Proxy indirection on
 * every property access for the life of the process.
 */
export const prisma: PrismaClient = new PrismaClient({
  datasources: {
    db: {
      url: resolveDatabaseUrl(),
    },
  },
});

export { resolveDatabaseUrl, LITE_DEFAULT_DATABASE_URL };
