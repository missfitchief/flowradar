// FlowRadar — Dune API client (Task 37, Wave 4.6). Implements DuneClient
// against the docs-verified Query Execution API endpoints (see types.ts
// header for the 4 fetched pages + verified shapes).
//
// -----------------------------------------------------------------------
// CREDIT-SAFETY CONTRACT (binding, restated from the user's 5 hard
// constraints — this is the load-bearing behavior this file exists to
// enforce)
// -----------------------------------------------------------------------
//   1. DEFAULT = latest cached result ONLY. useLatestCached defaults to true
//      (DUNE_USE_LATEST_RESULT env, default 'true') => this client calls
//      ONLY GET /v1/query/{query_id}/results (doc-verified: "does NOT trigger
//      a new execution — it returns the latest cached result"). The
//      /execute POST is NEVER called on this path.
//   2. Execute a fresh query ONLY when DUNE_EXECUTE_FRESH=true. When both the
//      caller's useLatestCached is false (or DUNE_EXECUTE_FRESH=true
//      globally overrides the default) => POST /v1/query/{query_id}/execute,
//      then poll GET /v1/execution/{execution_id}/status until
//      is_execution_finished, then GET /v1/execution/{execution_id}/results.
//   3. Rate-limited via the fixed createRateLimiter (packages/providers/src/
//      rateLimiter.ts, capacity=max(1,rps) — sub-1 rps no longer hangs, see
//      that file's own header for the fix). Dune's free tier is low, so a
//      conservative sub-1 rps (0.5, i.e. one call every 2s) is used by
//      default — no doc-published numeric rate-limit figure was found for
//      the free tier this session, so this is a deliberately conservative
//      default, documented here rather than guessed generously.
//   4. Missing DUNE_API_KEY => createDuneClient returns null (missing_key,
//      same "null => caller falls back gracefully" contract as
//      solanaTracker.ts/birdeyeCandidates.ts's key-gated factories).
//   5. Non-2xx responses throw an Error whose message NEVER contains the API
//      key (the key is header-only, never interpolated into any thrown
//      message or URL — see redaction test in client.test.ts).

import { createRateLimiter } from '../../rateLimiter';
import type { RateLimiter } from '../../rateLimiter';
import type { DuneClient, DuneRawRow, DuneResultSet, ExecuteQueryOpts } from './types';

export interface DuneEnv {
  DUNE_API_KEY?: string;
  /** Credit safety: serve the query's latest cached result instead of executing fresh. Default true (unset/anything other than the literal string 'false' is treated as true). */
  DUNE_USE_LATEST_RESULT?: string;
  /** Credit safety: allow fresh (paid) query execution. Off by default (unset or anything other than the literal string 'true'). */
  DUNE_EXECUTE_FRESH?: string;
}

const DUNE_API_BASE = 'https://api.dune.com/api';
// No doc-published free-tier numeric rate limit was found this session
// (out of scope for the 4 Query Execution API pages fetched) — a
// conservative sub-1 rps default, made safe by the createRateLimiter fix
// (commit a2859ab) that floors capacity at 1 token rather than hanging below
// rps=1.
const DEFAULT_RPS = 0.5;
const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_POLL_TIMEOUT_MS = 60_000;
const DEFAULT_LIMIT = 1000;

const TERMINAL_STATES = new Set([
  'QUERY_STATE_COMPLETED',
  'QUERY_STATE_FAILED',
  'QUERY_STATE_CANCELED',
  'QUERY_STATE_EXPIRED',
  'QUERY_STATE_COMPLETED_PARTIAL'
]);

// Terminal-but-unusable states. A poll or results payload landing on one of
// these must THROW, never resolve as an empty-but-successful result set — an
// empty success is indistinguishable from "query matched nothing", which
// callers (runDuneQuerySync, overlap search) treat as a real answer.
// COMPLETED_PARTIAL is unusable TOO (2026-07-10 Codex review, doc-verified):
// Dune only serves partial results when the request sets
// allow_partial_results=true, which this client never sends — so a partial
// payload reaching us is out-of-contract, and silently treating one as a
// complete result would misreport coverage. Deliberate partial-result support
// would mean sending that flag AND forcing truncated=true; until someone
// needs it, refuse-and-surface is the honest behavior.
const FAILURE_STATES = new Set([
  'QUERY_STATE_FAILED',
  'QUERY_STATE_CANCELED',
  'QUERY_STATE_EXPIRED',
  'QUERY_STATE_COMPLETED_PARTIAL'
]);

/**
 * Throws when a Dune payload reports a failed/canceled/expired execution or
 * carries the documented `error` object. `error.message`/`error.type` come
 * from Dune's own response body (same trust stance as throwForNonOk) and
 * never contain this client's API key.
 */
function assertExecutionUsable(
  state: string | undefined,
  error: { type?: string; message?: string } | undefined,
  context: string
): void {
  if (error || (state !== undefined && FAILURE_STATES.has(state))) {
    const detail = error?.message ?? error?.type ?? state ?? 'unknown error';
    throw new Error(`Dune API ${context}: execution unsuccessful (state=${state ?? 'unknown'}): ${detail}`);
  }
}

interface ExecuteResponse {
  execution_id: string;
  state: string;
}

interface StatusResponse {
  execution_id: string;
  query_id?: number;
  is_execution_finished: boolean;
  state: string;
  error?: { type?: string; message?: string };
}

interface ResultsResponse {
  execution_id?: string;
  state?: string;
  result?: {
    rows?: DuneRawRow[];
    metadata?: { row_count?: number };
  };
  error?: { type?: string; message?: string };
}

function envFlagDefaultTrue(value: string | undefined): boolean {
  return value !== 'false';
}

function envFlagDefaultFalse(value: string | undefined): boolean {
  return value === 'true';
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

/** Never interpolates the API key into a thrown message — only status/statusText/response body text (the body itself is the remote server's own text, not something this client controls, but Dune's own error bodies do not echo the request's auth header back). */
async function throwForNonOk(response: Response, context: string): Promise<never> {
  const bodyText = await response.text().catch(() => '<no response body>');
  throw new Error(`Dune API ${context} failed (${response.status} ${response.statusText}): ${bodyText}`);
}

/**
 * Constructs a Dune API client, or `null` when DUNE_API_KEY is absent
 * (missing_key — mirrors every other key-gated adapter's null-return
 * contract in this codebase). `rps` lets callers override the conservative
 * default (e.g. tests exercising the fractional-rate non-hang proof).
 */
export function createDuneClient(env: DuneEnv, opts: { rps?: number } = {}): DuneClient | null {
  const rawApiKey = env.DUNE_API_KEY;
  if (!rawApiKey) return null;
  // Re-bound to a definite `string` const (rather than relying on narrowing
  // of `rawApiKey` to persist across the nested async function declarations
  // below) — some TS configurations (this repo's apps/web tsconfig, which
  // type-checks this file's source directly via the workspace path mapping,
  // under a different lib/fetch typing than packages/providers' own
  // standalone tsconfig) do not retain the `!rawApiKey` guard's narrowing
  // inside function bodies declared further down in the same closure scope.
  const apiKey: string = rawApiKey;

  const useLatestCachedDefault = envFlagDefaultTrue(env.DUNE_USE_LATEST_RESULT);
  const executeFreshAllowed = envFlagDefaultFalse(env.DUNE_EXECUTE_FRESH);

  const limiter: RateLimiter = createRateLimiter({ rps: opts.rps ?? DEFAULT_RPS });

  async function fetchLatestCachedResult(queryId: string, limit: number): Promise<DuneResultSet> {
    await limiter.acquire();

    const url = new URL(`/api/v1/query/${queryId}/results`, DUNE_API_BASE);
    url.searchParams.set('limit', String(limit));

    const response = await fetch(url.toString(), { headers: { 'X-Dune-API-Key': apiKey } });
    if (!response.ok) {
      await throwForNonOk(response, `get-query-result(query_id=${queryId})`);
    }
    const json = await readJson<ResultsResponse>(response);
    assertExecutionUsable(json.state, json.error, `get-query-result(query_id=${queryId})`);
    const rows = json.result?.rows ?? [];

    return {
      rows,
      executionId: json.execution_id,
      usedCached: true,
      truncated: rows.length >= limit,
      rowsReturned: rows.length
    };
  }

  async function executeFreshQuery(
    queryId: string,
    params: Record<string, string | number | boolean> | undefined,
    limit: number
  ): Promise<DuneResultSet> {
    await limiter.acquire();

    const executeUrl = new URL(`/api/v1/query/${queryId}/execute`, DUNE_API_BASE);
    const executeResponse = await fetch(executeUrl.toString(), {
      method: 'POST',
      headers: { 'X-Dune-API-Key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(params ? { query_parameters: params } : {})
    });
    if (!executeResponse.ok) {
      await throwForNonOk(executeResponse, `execute-query(query_id=${queryId})`);
    }
    const executeJson = await readJson<ExecuteResponse>(executeResponse);
    const executionId = executeJson.execution_id;

    const deadline = Date.now() + DEFAULT_POLL_TIMEOUT_MS;
    let finished = false;
    let finalStatus: StatusResponse | undefined;
    while (!finished) {
      await limiter.acquire();
      const statusUrl = new URL(`/api/v1/execution/${executionId}/status`, DUNE_API_BASE);
      const statusResponse = await fetch(statusUrl.toString(), { headers: { 'X-Dune-API-Key': apiKey } });
      if (!statusResponse.ok) {
        await throwForNonOk(statusResponse, `get-execution-status(execution_id=${executionId})`);
      }
      const statusJson = await readJson<StatusResponse>(statusResponse);
      finished = statusJson.is_execution_finished || TERMINAL_STATES.has(statusJson.state);

      if (!finished) {
        if (Date.now() > deadline) {
          throw new Error(`Dune API execute-query(query_id=${queryId}): polling timed out after ${DEFAULT_POLL_TIMEOUT_MS}ms`);
        }
        await new Promise((resolve) => setTimeout(resolve, DEFAULT_POLL_INTERVAL_MS));
      } else {
        finalStatus = statusJson;
      }
    }

    // A terminal-but-failed execution must throw HERE, before the results
    // fetch — /results for a failed execution is a wasted call whose empty
    // payload would otherwise masquerade as a successful zero-row answer.
    assertExecutionUsable(finalStatus?.state, finalStatus?.error, `execute-query(query_id=${queryId})`);

    await limiter.acquire();
    const resultsUrl = new URL(`/api/v1/execution/${executionId}/results`, DUNE_API_BASE);
    resultsUrl.searchParams.set('limit', String(limit));
    const resultsResponse = await fetch(resultsUrl.toString(), { headers: { 'X-Dune-API-Key': apiKey } });
    if (!resultsResponse.ok) {
      await throwForNonOk(resultsResponse, `get-execution-result(execution_id=${executionId})`);
    }
    const resultsJson = await readJson<ResultsResponse>(resultsResponse);
    assertExecutionUsable(resultsJson.state, resultsJson.error, `get-execution-result(execution_id=${executionId})`);
    const rows = resultsJson.result?.rows ?? [];

    return {
      rows,
      executionId,
      usedCached: false,
      truncated: rows.length >= limit,
      rowsReturned: rows.length
    };
  }

  return {
    async executeQuery(queryId: string, callOpts: ExecuteQueryOpts = {}): Promise<DuneResultSet> {
      const limit = callOpts.limit ?? DEFAULT_LIMIT;
      // Per-call useLatestCached, if the caller supplies it, wins; otherwise
      // fall back to the env-derived default. executeFreshAllowed is the
      // GLOBAL kill switch (constraint #2): even if a caller explicitly
      // passes useLatestCached=false, a fresh execution is only actually
      // attempted when DUNE_EXECUTE_FRESH=true — this can never be bypassed
      // per-call, since a Dune credit is real money regardless of who asked.
      const wantsCached = callOpts.useLatestCached ?? useLatestCachedDefault;
      if (wantsCached || !executeFreshAllowed) {
        return fetchLatestCachedResult(queryId, limit);
      }
      return executeFreshQuery(queryId, callOpts.params, limit);
    }
  };
}
