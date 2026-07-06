// FlowRadar — walletGraph job (Task 20 binding decision 3).
//
// Thin wrapper around @flowradar/db's runGraphSearch, registered on the
// runner via `process()` (queue-worker pair, not `schedule()` — on-demand
// only, same pattern as apps/worker/src/jobs/walletImport.ts). This exists so
// async graph-search runs are POSSIBLE later (e.g. enqueueing a huge search
// instead of blocking a web request), but nothing in the web app's graph-
// search path depends on this job or on the worker process being up — see
// apps/web/app/api/graph/route.ts's own header comment (it calls
// runGraphSearch directly, inline, awaited).
//
// Payload shape: `{ searchId: string }` — the one input runGraphSearch needs
// beyond the shared `prisma` client.

import { runGraphSearch } from '@flowradar/db';
import type { JobContext } from '../context';

export interface WalletGraphPayload {
  searchId: string;
}

function isWalletGraphPayload(payload: unknown): payload is WalletGraphPayload {
  return (
    payload !== null &&
    typeof payload === 'object' &&
    typeof (payload as { searchId?: unknown }).searchId === 'string'
  );
}

/**
 * Registers the `walletGraph` handler on `ctx`'s runner via
 * `runner.process(...)` — call once at worker bootstrap (apps/worker/src/index.ts),
 * mirroring walletImport.ts's registration pattern exactly.
 */
export function register(ctx: JobContext, runner: { process: (name: string, fn: (payload: unknown) => Promise<void>) => void }): void {
  runner.process('walletGraph', async (payload: unknown) => {
    if (!isWalletGraphPayload(payload)) {
      ctx.log.error('walletGraph: received malformed payload (expected { searchId: string })');
      return;
    }
    const result = await runGraphSearch(ctx.prisma, payload.searchId);
    ctx.log.info('walletGraph: run complete', {
      searchId: payload.searchId,
      status: result.status,
      nodeCount: result.nodeCount,
      edgeCount: result.edgeCount
    });
  });
}
