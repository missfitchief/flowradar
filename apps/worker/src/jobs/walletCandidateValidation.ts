// FlowRadar — walletCandidateValidation job (Task 35, Wave 4.5, Spec §5b).
//
// Thin wrapper around @flowradar/db's runCandidateValidation — the actual
// evidence-assembly / evaluateCandidate / promote-or-reject logic lives there
// (same worker/seed-sharing pattern as every other job in this directory —
// see apps/worker/src/jobs/walletStatsRefresh.ts's header). Registered on
// settings.connectors.syncHours (Task 35 binding decision 2: "reuse
// connectors.syncHours or a validation interval — settings.connectors.syncHours
// acceptable; document" — this job shares that same interval with
// externalWalletSource rather than introducing a new settings field, since
// validating shortly after each sync pass is the natural cadence: there is
// nothing new to validate between sync passes).
//
// No provider wallet-PnL capability is resolvable yet (no live adapter exists
// for it — Wave 4.5's Birdeye wallet-PnL adapter is a later task), so
// resolveProviderPnl is always undefined here: every candidate's evidence
// falls through to local computeFifoPnl (or 'insufficient' when neither
// exists), exactly as runCandidateValidation's own fallback order documents.

import { runCandidateValidation } from '@flowradar/db';
import type { JobContext } from '../context';

export async function run(ctx: JobContext): Promise<void> {
  const { prisma, settings, log } = ctx;
  await runCandidateValidation(prisma, settings, undefined, log);
}
