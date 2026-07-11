// FlowRadar — stealthAccumulation job (Priority 2, 2026-07-11).
//
// Thin wrapper around @flowradar/db's runStealthPass: bounded per-token
// cohort aggregation over the last 24h of trades → the APPROVED pure stealth
// engine → one SHADOW StealthSnapshot per (token, bucket), replay-idempotent.
// Reads trades/wallets/clusters/subscriptions; writes ONLY stealth_snapshots
// — no FlowScore, no thresholds, no eligibility, no Wallet/WalletStats
// mutation. Token budget bounds each pass; per-token failures are isolated
// inside runStealthPass and surfaced as a count.

import { runStealthPass } from '@flowradar/db';
import type { JobContext } from '../context';

// Bounded per pass — the interval cadence covers the active-token tail.
const TOKEN_BUDGET = 50;

export async function run(ctx: JobContext): Promise<void> {
  const { prisma, settings, log } = ctx;
  const result = await runStealthPass(prisma, {
    tokenLimit: TOKEN_BUDGET,
    bucketSec: settings.intervals.stealthAccumulationSec
  });
  log.info('stealthAccumulation pass complete', {
    tokensEvaluated: result.tokensEvaluated,
    snapshotsWritten: result.snapshotsWritten,
    errors: result.errors,
    byState: JSON.stringify(result.byState)
  });
}
