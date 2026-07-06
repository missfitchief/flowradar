// FlowRadar — Helius live WalletActivityProvider (Task 27).
//
// DOC-VERIFIED endpoint (fetched this session — see task-27-report.md for the
// full source list): GET /v0/addresses/{address}/transactions on the Helius
// Enhanced Transactions API. Confirmed independently across 3 doc surfaces
// (main API-reference page, its llms.txt reference, and the mintlify mirror),
// all agreeing on:
//   - path: /v0/addresses/{address}/transactions
//   - auth: `api-key` query param
//   - pagination: `before-signature` (search backwards) / `after-signature`
//     (search forwards) — NOT a plain `before` param (the task brief's
//     assumption of a bare `before` cursor param does not match the current
//     docs; this adapter uses the doc-verified `before-signature` name and
//     documents the correction here rather than silently guessing).
//   - `limit`: 1-100 per request.
//   - `type` / `source` filters, `commitment`, slot/time range filters.
//   - response: JSON array of transaction objects (see heliusMapper.ts's
//     HeliusTransaction interface for the exact field shape used).
//
// Doc source (primary): https://www.helius.dev/docs/api-reference/enhanced-transactions/gettransactionsbyaddress
// (docs.helius.dev/... redirects here — 308 Permanent Redirect confirmed).

import type { Chain, NormalizedTx } from '@flowradar/core';
import type { GetWalletTransactionsOpts, GetWalletTransactionsResult, WalletActivityProvider } from '../types';
import { createRateLimiter } from '../rateLimiter';
import type { RateLimiter } from '../rateLimiter';
import { mapHeliusTransactions } from './heliusMapper';
import type { HeliusTransaction } from './heliusMapper';

export interface HeliusActivityEnv {
  HELIUS_API_KEY?: string;
}

const HELIUS_API_BASE = 'https://api-mainnet.helius-rpc.com';
const HELIUS_RPS = 9;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 100; // doc-verified hard cap ("1-100 transactions per request")

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const SOLANA_ADDRESS_MIN_LEN = 32;
const SOLANA_ADDRESS_MAX_LEN = 44;

// ---------------------------------------------------------------------------
// Base58 address validation — reuses the same shape-check contract as
// packages/db/src/csv/importWalletsCsv.ts's isValidSolanaAddress (that module
// can't be imported directly: packages/providers depends ONLY on
// @flowradar/core, and importWalletsCsv.ts pulls in @prisma/client). Kept as
// a local, dependency-free duplicate rather than a shared package to respect
// that dependency boundary — see importWalletsCsv.ts's own comment for the
// full base58-charset-plus-length-range rationale (real Solana addresses'
// encoded length varies 32-44 chars depending on leading zero-bytes).
// ---------------------------------------------------------------------------

function isValidBase58(s: string): boolean {
  if (s.length === 0) return false;
  for (const ch of s) {
    if (!BASE58_ALPHABET.includes(ch)) return false;
  }
  return true;
}

/** Solana addresses are base58-encoded ed25519 public keys, encoded length 32-44 chars. */
export function isValidSolanaAddress(address: string): boolean {
  if (!isValidBase58(address)) return false;
  return address.length >= SOLANA_ADDRESS_MIN_LEN && address.length <= SOLANA_ADDRESS_MAX_LEN;
}

// ---------------------------------------------------------------------------
// Helius API call
// ---------------------------------------------------------------------------

async function fetchHeliusTransactions(
  apiKey: string,
  limiter: RateLimiter,
  address: string,
  opts: { limit: number; before?: string }
): Promise<HeliusTransaction[]> {
  await limiter.acquire();

  const url = new URL(`${HELIUS_API_BASE}/v0/addresses/${address}/transactions`);
  url.searchParams.set('api-key', apiKey);
  url.searchParams.set('limit', String(opts.limit));
  if (opts.before) {
    url.searchParams.set('before-signature', opts.before);
  }

  const response = await fetch(url.toString());

  if (!response.ok) {
    const bodyText = await response.text().catch(() => '<no response body>');
    // Never interpolate `url.toString()` (contains api-key) into the thrown
    // message — build a redacted description instead so a caller that logs
    // this error can never leak the key.
    throw new Error(
      `Helius getTransactionsByAddress failed for address ${address} (${response.status} ${response.statusText}): ${bodyText}`
    );
  }

  return (await response.json()) as HeliusTransaction[];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Constructs a Solana WalletActivityProvider backed by the Helius Enhanced
 * Transactions API, or returns `null` when HELIUS_API_KEY is absent
 * (registry.ts's missing_key / mock-fallback path — Task 27 binding decision
 * 5). Rate-limited to ~9rps via createRateLimiter (shared per-provider
 * -instance limiter across calls, same pattern as risk.ts).
 */
export function createHeliusActivityProvider(env: HeliusActivityEnv): WalletActivityProvider | null {
  const apiKey = env.HELIUS_API_KEY;
  if (!apiKey) return null;

  const limiter = createRateLimiter({ rps: HELIUS_RPS });

  return {
    providerName: 'Helius',
    async getWalletTransactions(
      _chain: Chain,
      address: string,
      opts: GetWalletTransactionsOpts = {}
    ): Promise<GetWalletTransactionsResult> {
      if (!isValidSolanaAddress(address)) {
        throw new Error(`createHeliusActivityProvider.getWalletTransactions: invalid Solana address "${address}"`);
      }

      const limit = Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
      const rawTxs = await fetchHeliusTransactions(apiKey, limiter, address, {
        limit,
        before: opts.cursor
      });

      // `since` (opts.since) has no direct server-side param in this
      // doc-verified endpoint (time filters are gte-time/lte-time range
      // filters, not a single "only after" cursor semantic the shared
      // GetWalletTransactionsOpts.since contract expects) — filtered
      // client-side after mapping instead, so the contract's meaning
      // ("only return txs at or after this timestamp") holds regardless of
      // which server-side filters a future revision adds.
      let normalized: NormalizedTx[] = mapHeliusTransactions(rawTxs, address);
      if (opts.since) {
        const sinceMs = opts.since.getTime();
        normalized = normalized.filter((tx) => tx.ts.getTime() >= sinceMs);
      }

      // nextCursor = last signature per docs pagination ("before-signature":
      // paginate backwards using the last transaction signature from each
      // batch) — taken from the raw (pre-since-filter) page so a subsequent
      // call continues the server-side pagination correctly even when a
      // `since` filter dropped some mapped results from this page.
      const lastRaw = rawTxs[rawTxs.length - 1];
      const nextCursor = rawTxs.length === limit && lastRaw ? lastRaw.signature : undefined;

      return { txs: normalized, nextCursor };
    }
  };
}
