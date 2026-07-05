// FlowRadar — createRunner(): picks InlineRunner (LITE, default) or
// BullMqRunner (FULL) based on REDIS_URL. LITE mode never constructs
// BullMqRunner (and per bullmq.ts's own header, its dynamic imports mean LITE
// mode never even loads bullmq/ioredis's module code), matching the Task 5
// brief's "guard the import/construction so LITE never needs a Redis
// connection" requirement.

import type { JobRunner } from '@flowradar/core';
import { InlineRunner } from './inline.js';
import { BullMqRunner } from './bullmq.js';

export type { JobRunner } from '@flowradar/core';
export { InlineRunner } from './inline.js';
export { BullMqRunner } from './bullmq.js';

/**
 * Chooses the JobRunner implementation by REDIS_URL: empty/unset => LITE
 * mode's InlineRunner (in-process, no external dependency); non-empty =>
 * FULL mode's BullMqRunner, connected to that Redis instance.
 */
export function createRunner(): JobRunner {
  const redisUrl = process.env.REDIS_URL?.trim();
  if (redisUrl) {
    return new BullMqRunner(redisUrl);
  }
  return new InlineRunner();
}
