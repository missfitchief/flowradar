// FlowRadar — profitRotation job (Task 23 binding decision 4).
//
// Thin wrapper around @flowradar/db's runProfitRotation — matches
// ProfitExit/TransferRec/DestBuy rows into RotationCandidates and persists
// ProfitRotationSignal rows (deduped on sourceWallet+destWallet+destToken
// within 24h — see rotation.ts's own header). Registered on
// settings.intervals.profitRotationSec.
//
// Note: packages/db/src/signals.ts's runSignalDetectionPass ALSO calls
// runProfitRotation once per signal-detection tick (so Rule F always has a
// fresh rotationCandidates list to evaluate against, without waiting for
// this job's own independently-scheduled interval) — calling it a second
// time here on its own schedule is safe and NOT redundant duplicate-signal
// risk: runProfitRotation's own dedupe (on sourceWalletId+destWalletId+
// destTokenId within the last 24h) makes every extra call beyond the first
// in any given window a no-op for persistence purposes. This job exists
// independently anyway so profit-rotation matching keeps running (and its
// own ProfitRotationSignal rows stay fresh) even on a deployment where
// signalDetection's interval is tuned far apart from this one.
import { runProfitRotation } from '@flowradar/db';
import type { JobContext } from '../context';

export async function run(ctx: JobContext): Promise<void> {
  const { prisma, settings, log } = ctx;
  await runProfitRotation(prisma, settings, new Date(), log);
}
