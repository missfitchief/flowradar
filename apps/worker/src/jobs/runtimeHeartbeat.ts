import { recordRuntimeHeartbeat } from '@flowradar/db';
import type { JobContext } from '../context';

const PROCESS_STARTED_AT = new Date();

export async function run(ctx: JobContext) {
  await recordRuntimeHeartbeat(ctx.prisma, {
    component: 'worker', status: 'healthy', startedAt: PROCESS_STARTED_AT, success: true,
    metadata: { mockMode: process.env.MOCK_MODE !== 'false', durableQueue: Boolean(process.env.REDIS_URL) }
  });
}
