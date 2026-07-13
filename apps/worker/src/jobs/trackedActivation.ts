import { runIntelligenceLifecycle } from '@flowradar/db';
import type { JobContext } from '../context';

const MAX_TRACKED_WALLETS_PER_PASS = 50_000;
const MAX_BUY_EVENTS_PER_PASS = 100_000;

export async function run(ctx: JobContext): Promise<void> {
  const report = await runIntelligenceLifecycle(ctx.prisma, {
    maxProfiles: MAX_TRACKED_WALLETS_PER_PASS,
    maxEvents: MAX_BUY_EVENTS_PER_PASS
  });
  ctx.log?.info('intelligence lifecycle scan complete', {
    runId: report.runId,
    profilesTracked: report.profilesTracked,
    eventsProcessed: report.eventsProcessed,
    dormantAwakenings: report.dormantAwakenings,
    tokenGroupsConsidered: report.tokenGroupsConsidered,
    signalsCreated: report.signalsCreated,
    buyCandidatesCreated: report.buyCandidatesCreated,
    singleWalletGroupsRejected: report.singleWalletGroupsRejected,
    honestEmpty: report.honestEmpty,
  });
}
