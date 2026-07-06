// FlowRadar — web-app DuneClient resolver (Task 38, Wave 4.6).
//
// The web app is otherwise DB-only (every other page/route reads persisted
// tables — see apps/web/lib/db.ts's own header); this is the one place it
// needs to reach into @flowradar/providers directly, because POST
// /api/overlap runs a Dune-backed overlap search SYNCHRONOUSLY INLINE (same
// "must work with only `npm run dev` running, no worker process required"
// reasoning as /api/graph's runGraphSearch call — see that route's header).
//
// Mirrors apps/worker/src/jobs/duneQuery.ts's own resolveClient EXACTLY:
// MOCK_MODE (default true) => one process-lifetime shared MockDuneClient
// wrapping a MockWorld with the same 72h genesis convention; live mode =>
// createDuneClient(env), cached, null when DUNE_API_KEY is absent
// (missing_key, graceful — POST /api/overlap surfaces this as a 4xx with a
// clear message rather than crashing).

import { createDuneClient, createMockDuneClient, createMockWorld } from '@flowradar/providers';
import type { DuneClient } from '@flowradar/providers';

const HOUR_MS = 60 * 60 * 1000;
const WORLD_HORIZON_HOURS = 72;

export function isMockMode(): boolean {
  return process.env.MOCK_MODE !== 'false';
}

let sharedMockDuneClient: DuneClient | null = null;

function getSharedMockDuneClient(): DuneClient {
  if (!sharedMockDuneClient) {
    const genesis = new Date(Date.now() - WORLD_HORIZON_HOURS * HOUR_MS);
    const world = createMockWorld({ genesis });
    sharedMockDuneClient = createMockDuneClient(world);
  }
  return sharedMockDuneClient;
}

let liveDuneClientCache: DuneClient | null | undefined;

function resolveLiveDuneClient(): DuneClient | null {
  if (liveDuneClientCache !== undefined) return liveDuneClientCache;
  liveDuneClientCache = createDuneClient({
    DUNE_API_KEY: process.env.DUNE_API_KEY,
    DUNE_USE_LATEST_RESULT: process.env.DUNE_USE_LATEST_RESULT,
    DUNE_EXECUTE_FRESH: process.env.DUNE_EXECUTE_FRESH
  });
  return liveDuneClientCache;
}

/** Resolves a DuneClient for this process — MOCK_MODE's shared mock client, or the live client (null when DUNE_API_KEY is absent). */
export function resolveDuneClient(): DuneClient | null {
  return isMockMode() ? getSharedMockDuneClient() : resolveLiveDuneClient();
}
