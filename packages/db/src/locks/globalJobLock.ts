// FlowRadar — global job serialization (Prerequisite B, Capital Lineage
// Phase 6b; Codex-ledgered condition from the Phase 6a review).
//
// Mutually unsafe operations — db:seed's destructive wipe, root imports,
// live lineage expansion, historical backfill, live-DB resets — must never
// interleave. This module serializes them with a PostgreSQL SESSION
// advisory lock held on a DEDICATED single-connection PrismaClient:
//
//   - DEDICATED CLIENT, connection_limit=1: Prisma pools connections, and a
//     session advisory lock binds to ONE connection — acquiring and
//     releasing through a shared pooled client could land on different
//     connections and wedge. A dedicated client with a single connection
//     pins every lock call to the same session.
//   - SESSION lock (pg_try_advisory_lock), not transaction lock: the work
//     inside (imports, backfills) is deliberately multi-statement and
//     partial-progress-safe — wrapping hours of work in one transaction is
//     not an option.
//   - STALE-PROCESS SAFETY (requirement 6): if the holding process dies,
//     PostgreSQL releases session advisory locks when the connection drops —
//     the system can never be permanently locked by a killed job.
//   - HONEST FAILURE (requirement 5): acquisition polls up to waitMs and
//     then throws GlobalJobLockBusyError. Nothing is mutated on failure.

import { PrismaClient } from '@prisma/client';
import { resolveDatabaseUrl } from '../client';

// Fixed application-wide key (int8). Arbitrary but stable — every FlowRadar
// job that mutates shared wallet/lineage state must use THIS key.
const GLOBAL_JOB_LOCK_KEY = 731_842_009n;

export class GlobalJobLockBusyError extends Error {
  constructor(jobName: string, heldForMs: number) {
    super(
      `global job lock is held by another operation — '${jobName}' refused after waiting ${heldForMs}ms. ` +
        `Nothing was mutated. Retry after the running seed/import/backfill/reset finishes.`
    );
    this.name = 'GlobalJobLockBusyError';
  }
}

export interface GlobalJobLockOptions {
  /** How long to wait for the lock before failing honestly. Default 15s. */
  waitMs?: number;
  /** Poll interval while waiting. Default 250ms. */
  pollMs?: number;
}

function singleConnectionUrl(): string {
  const base = resolveDatabaseUrl();
  const separator = base.includes('?') ? '&' : '?';
  return `${base}${separator}connection_limit=1&pool_timeout=30`;
}

/**
 * Runs `fn` while holding the global job lock. The lock lives on its own
 * single-connection PrismaClient for the duration; it is always released
 * (finally) and the dedicated client always disconnected.
 */
export async function withGlobalJobLock<T>(
  jobName: string,
  fn: () => Promise<T>,
  opts: GlobalJobLockOptions = {}
): Promise<T> {
  const waitMs = opts.waitMs ?? 15_000;
  const pollMs = opts.pollMs ?? 250;

  const lockClient = new PrismaClient({ datasources: { db: { url: singleConnectionUrl() } } });
  try {
    const startedAt = Date.now();
    for (;;) {
      const rows = await lockClient.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_lock(${GLOBAL_JOB_LOCK_KEY}) AS locked`;
      if (rows[0]?.locked) break;
      const waited = Date.now() - startedAt;
      if (waited >= waitMs) {
        throw new GlobalJobLockBusyError(jobName, waited);
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    try {
      return await fn();
    } finally {
      await lockClient.$queryRaw`SELECT pg_advisory_unlock(${GLOBAL_JOB_LOCK_KEY})`.catch(() => undefined);
    }
  } finally {
    await lockClient.$disconnect().catch(() => undefined);
  }
}
