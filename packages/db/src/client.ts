import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { LIVE_LITE_DATABASE_URL, resolveDatabaseUrlForEnv } from './testDb';

// LITE-mode default connection string (spec §13) now lives in ./testDb
// (LIVE_LITE_DATABASE_URL) so the TEST/LIVE isolation rule and the default
// share one definition. Must stay in sync with the LITE_* constants in
// scripts/db-local.ts (source of truth for the running cluster).
const LITE_DEFAULT_DATABASE_URL = LIVE_LITE_DATABASE_URL;

/**
 * Git-worktree-aware .env fallback: linked worktrees don't share the main
 * checkout's untracked .env, so runs launched from a worktree used to see
 * every provider as "missing key" even though the repository IS configured.
 * A worktree's `.git` is a FILE containing `gitdir: <main>/.git/worktrees/<name>`
 * — resolve the MAIN worktree root from it and return its .env path.
 * Values are only ever loaded via dotenv's fill-missing-only semantics and
 * are never printed or copied anywhere.
 */
function mainWorktreeEnvPath(repoRoot: string): string | null {
  try {
    const dotGit = path.join(repoRoot, '.git');
    if (!existsSync(dotGit) || !statSync(dotGit).isFile()) return null;
    const m = /gitdir:\s*(.+)/.exec(readFileSync(dotGit, 'utf8'));
    if (!m) return null;
    const gitDir = path.resolve(repoRoot, m[1].trim()); // <main>/.git/worktrees/<name>
    const worktreesDir = path.dirname(gitDir); // <main>/.git/worktrees
    if (path.basename(worktreesDir) !== 'worktrees') return null;
    const mainRoot = path.dirname(path.dirname(worktreesDir)); // <main>
    const candidate = path.join(mainRoot, '.env');
    return existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

function loadEnvFromRepoRoot(): void {
  // packages/db/src -> repo root is two levels up.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, '..', '..', '..');
  const envPath = path.join(repoRoot, '.env');
  // Root .env may not exist (LITE mode works from defaults alone) — only load if present.
  if (existsSync(envPath)) {
    loadDotenv({ path: envPath });
  }
  // Worktree fallback fills in ONLY variables still missing (dotenv never
  // overrides existing process.env) — explicit DATABASE_URL etc. always win.
  const mainEnv = mainWorktreeEnvPath(repoRoot);
  if (mainEnv) {
    loadDotenv({ path: mainEnv });
  }
}

/**
 * TEST/LIVE isolation (overnight Task A): under vitest this resolves to the
 * dedicated *_test database and FAILS CLOSED on any live/test collision —
 * tests can no longer write to the live/operator DB (the root cause of the
 * earlier leaked-fixture incident). Outside vitest, behavior is unchanged.
 * All ambient consumers (the prisma singleton below, withGlobalJobLock's
 * single-connection client) flow through this one rule.
 */
function resolveDatabaseUrl(): string {
  loadEnvFromRepoRoot();
  return resolveDatabaseUrlForEnv(process.env);
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
