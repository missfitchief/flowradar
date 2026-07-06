// FlowRadar — alertDispatch job (Task 16 binding decision 5).
//
// Thin wrapper around @flowradar/db's dispatchPendingAlerts — the actual
// per-signal cooldown/render/send/persist logic lives there (same
// worker/seed-sharing pattern as flowScoring.ts / signalDetection.ts — see
// those files' headers). Registered on settings.intervals.alertDispatchSec
// (apps/worker/src/index.ts).
//
// Sender resolution: createTelegramSender(process.env) returns null whenever
// TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is unset — which is always true in
// this repo's default MOCK/no-token local setup (Task 16 binding decision 5:
// "MOCK/no-token mode uses a null sender => every alert row lands
// skipped_no_token (payload still rendered — the text IS the artifact)").
// Resolved once per call rather than cached at module scope so a live
// deployment that sets TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID via a running
// process's env (or a future Settings-driven credential) is picked up
// without requiring a worker restart — dispatchPendingAlerts itself is cheap
// enough per cycle (Signals without an Alert row are typically few) that
// re-resolving the sender here has no measurable cost.

import { dispatchPendingAlerts } from '@flowradar/db';
import { createTelegramSender } from '@flowradar/providers';
import type { JobContext } from '../context';

export async function run(ctx: JobContext): Promise<void> {
  const { prisma, settings, log } = ctx;
  const sender = createTelegramSender({
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID
  });
  await dispatchPendingAlerts(prisma, settings, sender, log);
}
