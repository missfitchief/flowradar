// FlowRadar — walletImport job (Task 12 binding decision 2 & 6).
//
// Thin wrapper around @flowradar/db's importWalletsCsv, registered on the
// runner via `process()` (queue-worker pair, not `schedule()` — decision 6:
// "no schedule — on-demand only"). This exists so async/scheduled CSV
// imports are POSSIBLE later (e.g. a future admin action that calls
// `runner.enqueue('walletImport', payload)` instead of hitting the web app's
// synchronous /api/import route), but nothing in the web app's import path
// depends on this job or on the worker process being up at all — see
// apps/web/app/api/import/route.ts's own header comment.
//
// Payload shape: `{ csvText: string; filename: string }` — the same two
// inputs importWalletsCsv itself takes (beyond the shared `prisma` client),
// so this wrapper does no transformation of its own, just payload
// unwrapping + a runtime shape check (JobRunner.process's `fn` receives
// `payload: unknown`, so this is the one spot that needs to validate the
// shape before calling into typed code).

import { importWalletsCsv } from '@flowradar/db';
import type { JobContext } from '../context';

export interface WalletImportPayload {
  csvText: string;
  filename: string;
}

function isWalletImportPayload(payload: unknown): payload is WalletImportPayload {
  return (
    payload !== null &&
    typeof payload === 'object' &&
    typeof (payload as { csvText?: unknown }).csvText === 'string' &&
    typeof (payload as { filename?: unknown }).filename === 'string'
  );
}

/**
 * Registers the `walletImport` handler on `ctx`'s runner via
 * `runner.process(...)` — call once at worker bootstrap (apps/worker/src/index.ts),
 * mirroring how the other 4 jobs are registered via `runner.schedule(...)` in
 * that same file, just using `process` instead of `schedule` since this job
 * is enqueue-triggered, not interval-ticked.
 */
export function register(ctx: JobContext, runner: { process: (name: string, fn: (payload: unknown) => Promise<void>) => void }): void {
  runner.process('walletImport', async (payload: unknown) => {
    if (!isWalletImportPayload(payload)) {
      ctx.log.error('walletImport: received malformed payload (expected { csvText: string; filename: string })');
      return;
    }
    const result = await importWalletsCsv(ctx.prisma, payload.csvText, payload.filename);
    ctx.log.info('walletImport: run complete', {
      importJobId: result.importJobId,
      totalRows: result.totalRows,
      okRows: result.okRows,
      errorRows: result.errorRows
    });
  });
}
