// FlowRadar — Dune Query Connector types + row schema (Task 37, Wave 4.6,
// dune-feature-wave46.md BINDING capture; folded into spec per Task 37's own
// task board entry).
//
// -----------------------------------------------------------------------
// DOC VERIFICATION (WebFetch'd this session, 2026-07-06)
// -----------------------------------------------------------------------
// https://docs.dune.com/api-reference/executions/endpoint/execute-query.md
//   POST /api/v1/query/{query_id}/execute
//   Query params: performance ('small'|'medium'|'large', optional), query_parameters
//     (JSON string, optional), api_key (optional alt auth)
//   Body: { query_parameters: {...}, performance: 'large' }
//   Header: X-Dune-API-Key (required)
//   Response 200: { execution_id: string, state: string }
//   Errors: 400/401/402 (credit limit exceeded)/403/404/500
//
// https://docs.dune.com/api-reference/executions/endpoint/get-execution-status.md
//   GET /v1/execution/{execution_id}/status
//   Header: X-Dune-Api-Key (or api_key query param)
//   Response: { execution_id, query_id, is_execution_finished, state,
//     submitted_at, expires_at, execution_started_at, execution_ended_at,
//     execution_cost_credits, cancelled_at?, queue_position?,
//     result_metadata?, error? }
//   state enum: QUERY_STATE_PENDING | QUERY_STATE_EXECUTING | QUERY_STATE_FAILED
//     | QUERY_STATE_COMPLETED | QUERY_STATE_CANCELED | QUERY_STATE_EXPIRED
//     | QUERY_STATE_COMPLETED_PARTIAL
//
// https://docs.dune.com/api-reference/executions/endpoint/get-execution-result.md
//   GET /v1/execution/{execution_id}/results
//   Query params: limit, offset, filters, sort_by, columns, sample_count,
//     allow_partial_results, ignore_max_credits_per_request
//   Header: X-Dune-Api-Key
//   Response: { execution_id, query_id, state, is_execution_finished,
//     submitted_at, execution_started_at, execution_ended_at, expires_at,
//     cancelled_at?, result: { rows: [{...}], metadata: { column_names,
//     column_types, row_count, total_row_count, execution_time_millis,
//     pending_time_millis, datapoint_count, result_set_bytes,
//     total_result_set_bytes } }, error?, next_offset?, next_uri? }
//
// https://docs.dune.com/api-reference/executions/endpoint/get-query-result.md
//   GET /v1/query/{query_id}/results  <-- CREDIT-SAFE DEFAULT PATH
//   Same query params + response shape as get-execution-result above, keyed
//   by query_id instead of execution_id. Doc-verified: "This endpoint does
//   NOT trigger a new execution — it returns the latest cached result."
//   (credit consumption applies only to result-size data transfer, never an
//   execute POST). This is the ONLY endpoint createDuneClient's default path
//   (DUNE_USE_LATEST_RESULT=true, DUNE_EXECUTE_FRESH=false) calls — see
//   client.ts header for the full credit-safety contract this repo enforces
//   on top of Dune's own docs.
//
// Auth header: X-Dune-API-Key (docs show both `X-Dune-Api-Key` and
// `X-Dune-API-Key` casings across pages; HTTP header names are
// case-insensitive so either casing is accepted by the API — this codebase
// uses `X-Dune-API-Key` consistently, matching dune-feature-wave46.md's own
// "auth header X-Dune-API-Key" wording).
//
// Query params for the overlap use case (dune-feature-wave46.md, NOT
// doc-verified against a specific saved query's own parameter names since no
// real saved query exists in this repo — these are the query_parameters this
// connector SENDS when DUNE_EXECUTE_FRESH=true): chain, token_address_1..5
// (one key per token address actually searched, 2-5 of them — see
// duneOverlap.ts's runTokenOverlapSearch, the source of truth for the exact
// object built), start_time, end_time (only when provided), min_trade_usd,
// min_tokens_overlap. NOTE: max_results is NOT one of these query_parameters
// — it's passed as ExecuteQueryOpts.limit (client.ts), applied as the `limit`
// URL query param on the results-fetch call, not a SQL {{...}} placeholder.
// Operator setup guide (creating a real saved query + binding these
// {{parameter}} names in Dune's UI): docs/dune/README.md — resolved by
// Task 39, which also aligned docs/dune/*.sql's placeholder names to this
// exact key set. If you rename a param here, update that saved query (and
// docs/dune/README.md's §3 table) to match.

import { z } from 'zod';
import type { Chain } from '@flowradar/core';

// ---------------------------------------------------------------------------
// Query execution result set
// ---------------------------------------------------------------------------

/** One raw row from a Dune query result — shape is query-dependent, validated downstream by DuneOverlapRowSchema. */
export type DuneRawRow = Record<string, unknown>;

export interface DuneResultSet {
  rows: DuneRawRow[];
  /** Present when the result came from executing a fresh run (DUNE_EXECUTE_FRESH=true); absent for a latest-cached-result fetch that predates this connector's own execution. */
  executionId?: string;
  /** true when this result was served from the query's existing cached result (GET .../query/{id}/results) rather than a fresh execute+poll cycle. */
  usedCached: boolean;
  /** true when rowsReturned hit the caller's own max_results cap (result may be incomplete, not a Dune-side truncation flag). */
  truncated: boolean;
  rowsReturned: number;
}

export interface ExecuteQueryOpts {
  /** Query parameter bindings, sent as the documented `query_parameters` JSON body field on POST .../execute, or ignored entirely on the cached-latest-result path (that endpoint takes no query_parameters — it serves whatever the query's last execution already ran with). */
  params?: Record<string, string | number | boolean>;
  /** Credit-safety switch (see client.ts header). true (default) => GET latest cached result only, no execute POST. false => POST execute + poll status + GET result. */
  useLatestCached?: boolean;
  /** Row cap applied by this connector (Dune's own `limit` query param on the results fetch) — NOT a Dune API "max_results" concept, just this repo's own overlap-search cap wired through. */
  limit?: number;
}

/** A Dune API client — execute (or fetch cached results for) one saved query. Never throws out of a CandidateSourceProvider-style caller; runTokenOverlapSearch/duneQuery worker are the ones that catch and record failures (client.ts itself DOES throw on a non-2xx response — see that file's own contract). */
export interface DuneClient {
  executeQuery(queryId: string, opts?: ExecuteQueryOpts): Promise<DuneResultSet>;
}

// ---------------------------------------------------------------------------
// Overlap row schema (dune-feature-wave46.md's documented row shape) — lenient
// parse: only `wallet_address` is required; every other field is optional so
// a saved query that omits a column (or Dune adding new columns later) never
// breaks ingestion. Extra/unknown fields are tolerated (Zod's default
// behavior for z.object without .strict()).
// ---------------------------------------------------------------------------

export const DuneOverlapRowSchema = z.object({
  wallet_address: z.string().min(1),
  chain: z.string().optional(),
  token_address: z.string().optional(),
  token_symbol: z.string().optional(),
  first_buy_time: z.union([z.string(), z.number()]).optional(),
  buy_count: z.number().optional(),
  sell_count: z.number().optional(),
  total_buy_usd: z.number().optional(),
  total_sell_usd: z.number().optional(),
  estimated_pnl_usd: z.number().optional(),
  entry_market_cap_usd: z.number().optional(),
  tx_hashes: z.array(z.string()).optional(),
  tokens_overlap_count: z.number().optional(),
  overlap_group_id: z.string().optional()
});

export type DuneOverlapRow = z.infer<typeof DuneOverlapRowSchema>;

export interface ParsedOverlapRows {
  rows: DuneOverlapRow[];
  /** Rows dropped because they failed schema validation (missing wallet_address, or a field present but the wrong type) — counted, never thrown. */
  droppedCount: number;
}

/** Why a raw row was dropped — `missing_wallet_address` (the one required field) vs `type_mismatch` (a present field with the wrong type). */
export type OverlapRowDropReason = 'missing_wallet_address' | 'type_mismatch';

/**
 * Zod-validates a raw Dune result set against DuneOverlapRowSchema. Rows
 * missing `wallet_address` (or otherwise failing validation) are dropped and
 * counted, never thrown — same "one bad row never aborts the batch"
 * convention as every other per-item try/catch in this codebase (e.g.
 * externalWalletSource.ts's per-source try/catch).
 *
 * `onDrop` is an optional per-dropped-row callback so a caller can log the
 * drop reason at DEBUG (distinguishing "no wallet_address at all" from "a
 * field was the wrong type") without coupling this pure function to a logger.
 */
export function parseOverlapRows(
  rawRows: DuneRawRow[],
  onDrop?: (reason: OverlapRowDropReason, rowIndex: number) => void
): ParsedOverlapRows {
  const rows: DuneOverlapRow[] = [];
  let droppedCount = 0;

  for (let i = 0; i < rawRows.length; i++) {
    const raw = rawRows[i]!;
    const result = DuneOverlapRowSchema.safeParse(raw);
    if (result.success) {
      rows.push(result.data);
    } else {
      droppedCount += 1;
      if (onDrop) {
        // wallet_address is the ONLY required field; if any issue targets it
        // (absent or non-string), classify as missing_wallet_address, else a
        // type mismatch on some optional field.
        const walletIssue = result.error.issues.some(
          (issue) => issue.path[0] === 'wallet_address'
        );
        onDrop(walletIssue ? 'missing_wallet_address' : 'type_mismatch', i);
      }
    }
  }

  return { rows, droppedCount };
}

// ---------------------------------------------------------------------------
// Overlap search input (runTokenOverlapSearch's own request shape)
// ---------------------------------------------------------------------------

export interface TokenOverlapSearchParams {
  chain: Chain;
  tokenAddresses: string[];
  minTradeUsd?: number;
  minTokensOverlap?: number;
  maxResults?: number;
  startTime?: string;
  endTime?: string;
}
