// FlowRadar — one-shot risk-cache pre-warm (Task 1 rollout, Step 5).
//
// Warms the canonical TokenRiskSnapshot cache for every traded token BEFORE
// the worker resumes on the cached-risk code path, so the cutover is
// zero-score-change (every scored token reads a FRESH snapshot, byte-for-byte
// the penalty a direct call would have produced at warm time).
//
// Safety posture:
//   - LIVE-DB write of ONLY token_risk_snapshots rows (that is the point).
//     Asserts the table exists (migration applied) before doing anything.
//   - Refuses to run against a mock risk provider (providerName must be
//     'Helius') — the live cache must never be warmed with fabricated data.
//   - All fetching goes through TokenRiskCache/runTokenRiskRefresh: provider
//     RPS limiter, Retry-After honored, bounded exponential backoff,
//     unavailable/throttled recorded honestly (never fabricated safe).
//   - Bounded: per-batch limit + a total wall-clock budget + a sustained-
//     throttle circuit breaker (3 consecutive batches >=50% throttled).
//
// Usage (from the repo root, worker STOPPED):
//   npx tsx scripts/prewarm-risk-cache.mts [--batch 200] [--max-minutes 45]
//
// Writes a JSON report to runs/<activeOrLatestRunId>/prewarm-report.json when
// a run dir is present, and always prints it to stdout.

import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
loadDotenv({ path: path.join(REPO_ROOT, '.env') });

const { prisma } = await import('@flowradar/db');
const { TokenRiskCache, runTokenRiskRefresh } = await import('@flowradar/db');
const { getProvider } = await import('@flowradar/providers');

function argNum(flag: string, dflt: number): number {
  const i = process.argv.indexOf(flag);
  if (i === -1) return dflt;
  const n = Number(process.argv[i + 1]);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

const BATCH = argNum('--batch', 200);
const MAX_MINUTES = argNum('--max-minutes', 45);

async function main(): Promise<void> {
  // 1. Migration gate: the cache table must exist (Step 4 applied it).
  const present = await prisma.$queryRawUnsafe<{ present: boolean }[]>(
    "SELECT to_regclass('public.token_risk_snapshots') IS NOT NULL AS present"
  );
  if (!present[0]?.present) {
    throw new Error('token_risk_snapshots does not exist — apply the migration (Step 4) before pre-warming');
  }

  // 2. Live-provider gate: never warm the live cache from a mock.
  const riskProvider = getProvider('SOLANA', 'risk');
  const providerName = (riskProvider as { providerName?: string }).providerName ?? 'unknown';
  if (providerName !== 'Helius') {
    throw new Error(`SOLANA risk provider resolved to "${providerName}" (not the live Helius adapter) — refusing to pre-warm with non-live data. Check HELIUS_API_KEY.`);
  }

  const cache = new TokenRiskCache({
    prisma,
    resolveFetcher: () => riskProvider,
    log: {
      error: (m: string, meta?: Record<string, unknown>) => console.error(`[prewarm] ${m}`, JSON.stringify(meta ?? {}))
    }
  });

  const universe = await prisma.token.count({ where: { chain: 'SOLANA', trades: { some: {} } } });
  console.log(`[prewarm] SOLANA traded-token universe: ${universe}; batch=${BATCH}, budget=${MAX_MINUTES}min, projection ~${universe * 2} RPC calls`);

  // READINESS is the cutover gate (Codex final-gate REJECT fix): a token is
  // READY iff its snapshot has observedAt != null — i.e. a real observation
  // (status ok) or an honest provider-returned `unavailable` (which is exactly
  // what a direct call would yield for that mint). A token that only ever
  // FAILED (throttled/error, observedAt null) is NOT ready even though it is
  // not "due" while backing off — `considered === 0` therefore must NOT be
  // read as completion. The loop keeps going (waiting out backoff windows)
  // until notReady === 0 or a budget/circuit-breaker stop, and the report's
  // stopReason is 'complete' ONLY when notReady === 0.
  const notReadyCount = async (): Promise<number> =>
    prisma.token.count({
      where: {
        chain: 'SOLANA',
        trades: { some: {} },
        OR: [{ riskSnapshot: null }, { riskSnapshot: { observedAt: null } }]
      }
    });

  const startedAt = Date.now();
  const totals = { batches: 0, considered: 0, refreshed: 0, unavailable: 0, throttled: 0, errors: 0, skipped: 0 };
  let consecutiveThrottledBatches = 0;
  let stopReason = 'incomplete';

  for (;;) {
    if ((Date.now() - startedAt) / 60000 > MAX_MINUTES) { stopReason = 'time_budget_exhausted'; break; }
    const notReady = await notReadyCount();
    if (notReady === 0) { stopReason = 'complete'; break; } // every traded token has a usable observation
    const m = await runTokenRiskRefresh(cache, prisma, { limit: BATCH, chain: 'SOLANA' });
    totals.batches += 1;
    totals.considered += m.considered;
    totals.refreshed += m.refreshed;
    totals.unavailable += m.unavailable;
    totals.throttled += m.throttled;
    totals.errors += m.errors;
    totals.skipped += m.skipped;
    console.log(`[prewarm] batch ${totals.batches}: notReady=${notReady} ${JSON.stringify(m)}`);
    if (m.considered === 0) {
      // Not-ready tokens exist but none are due: they are inside backoff
      // windows. Wait (bounded) for the earliest nextRefreshAt, then retry —
      // do NOT declare completion.
      const next = await prisma.tokenRiskSnapshot.findFirst({
        where: { observedAt: null, chain: 'SOLANA' },
        orderBy: { nextRefreshAt: 'asc' },
        select: { nextRefreshAt: true }
      });
      const waitMs = Math.min(Math.max((next?.nextRefreshAt.getTime() ?? Date.now()) - Date.now(), 1000), 60_000);
      console.log(`[prewarm] ${notReady} token(s) backing off; waiting ${Math.round(waitMs / 1000)}s for the earliest retry window`);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }
    // Circuit breaker: sustained throttling means stop and let backoff drain.
    if (m.throttled / m.considered >= 0.5) {
      consecutiveThrottledBatches += 1;
      if (consecutiveThrottledBatches >= 3) { stopReason = 'sustained_throttling'; break; }
    } else {
      consecutiveThrottledBatches = 0;
    }
  }

  // Coverage census (honest states, never fabricated).
  const byStatus = await prisma.tokenRiskSnapshot.groupBy({ by: ['status'], _count: { _all: true } });
  const covered = await prisma.token.count({ where: { chain: 'SOLANA', trades: { some: {} }, riskSnapshot: { isNot: null } } });
  const notReadyFinal = await notReadyCount();
  const report = {
    ts: new Date().toISOString(),
    stopReason,
    /** THE cutover gate: resume the worker only when this is true. */
    readyForCutover: notReadyFinal === 0,
    notReadyTokens: notReadyFinal,
    elapsedSec: Math.round((Date.now() - startedAt) / 1000),
    universeSolanaTraded: universe,
    coveredSolanaTraded: covered,
    readyPct: universe > 0 ? Math.round(((universe - notReadyFinal) / universe) * 1000) / 10 : 100,
    snapshotsByStatus: Object.fromEntries(byStatus.map((r) => [r.status, r._count._all])),
    totals,
    approxProviderRpcCalls: totals.refreshed * 2 + totals.errors + totals.throttled,
    batchSize: BATCH
  };
  console.log(`[prewarm] REPORT ${JSON.stringify(report, null, 2)}`);
  if (!report.readyForCutover) {
    console.error(`[prewarm] NOT READY FOR CUTOVER — ${notReadyFinal} traded token(s) still lack a usable observation. Do not resume the worker on the cached path.`);
  }

  // Drop the report next to the active run's artifacts when present.
  const runsDir = path.join(REPO_ROOT, 'runs');
  if (existsSync(runsDir)) {
    const runDirs = readdirSync(runsDir).filter((d) => d.startsWith('shadow-'));
    const target = runDirs.sort().at(-1);
    if (target) writeFileSync(path.join(runsDir, target, 'prewarm-report.json'), JSON.stringify(report, null, 2));
  }
  await prisma.$disconnect();
  if (stopReason === 'sustained_throttling') process.exitCode = 3;
  else if (!report.readyForCutover) process.exitCode = 4; // any non-ready exit blocks cutover
}

main().catch(async (err) => {
  console.error('[prewarm] FATAL', err instanceof Error ? err.message : String(err));
  await prisma.$disconnect();
  process.exit(1);
});
