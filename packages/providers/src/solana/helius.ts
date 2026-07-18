// FlowRadar — Helius live WalletActivityProvider (Task 27; rate-limit hardening
// 2026-07-07).
//
// DOC-VERIFIED endpoint (fetched in Task 27 — see task-27-report.md for the
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
//
// RATE-LIMIT HARDENING (2026-07-07, live-validation finding): the request rate
// is (a) configurable via HELIUS_RPS — the hardcoded 9rps default 429s on a
// free-tier key, whose Enhanced-Tx limit is much lower — and (b) 429-aware: a
// 429 no longer immediately fails the wallet; it is retried with backoff
// (honoring a numeric Retry-After header when present) and, only after the
// retries are exhausted, surfaced as a typed HeliusRateLimitError so the
// caller (walletActivity) can log/count it honestly as rate_limited and keep
// polling the rest of the cycle. A single provider throttle never poisons the
// whole cycle, and the adapter never silently falls back to mock on 429.

import type { Chain, NormalizedTx } from '@flowradar/core';
import type { GetWalletTransactionsOpts, GetWalletTransactionsResult, WalletActivityProvider } from '../types';
import { createRateLimiter } from '../rateLimiter';
import type { RateLimiter } from '../rateLimiter';
import { mapHeliusTransactions } from './heliusMapper';
import type { HeliusTransaction } from './heliusMapper';

export interface HeliusActivityEnv {
  HELIUS_API_KEY?: string;
  /**
   * Optional requests/sec override for the Enhanced-Tx endpoint. The default
   * (HELIUS_RPS_DEFAULT) is tuned for a paid tier; free-tier keys throttle far
   * lower and should set this to e.g. `1` or `2` (see .env.example). Invalid /
   * non-positive values fall back to the default.
   */
  HELIUS_RPS?: string;
}

/**
 * Tuning knobs for the adapter's 429 retry/backoff, all with conservative
 * defaults. Primarily an injection seam for tests (a no-op `sleep` makes the
 * retry path instant); production callers construct with no opts.
 */
export interface HeliusActivityOpts {
  /** Max 429 retries per request before giving up (default 3 → up to 4 attempts). */
  maxRetries?: number;
  /** Base backoff (ms) for exponential 429 retry: wait ≈ base * 2**attempt (default 500). */
  baseBackoffMs?: number;
  /** Ceiling on a single backoff wait (ms), before Retry-After (default 8000). */
  maxBackoffMs?: number;
  /** Injectable sleep (default real setTimeout) — tests pass a no-op/controlled sleep. */
  sleep?: (ms: number) => Promise<void>;
}

const HELIUS_API_BASE = 'https://api-mainnet.helius-rpc.com';
const HELIUS_RPS_DEFAULT = 9;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 100; // doc-verified hard cap ("1-100 transactions per request")

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_BACKOFF_MS = 500;
const DEFAULT_MAX_BACKOFF_MS = 8000;

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const SOLANA_ADDRESS_MIN_LEN = 32;
const SOLANA_ADDRESS_MAX_LEN = 44;

// ---------------------------------------------------------------------------
// Rate-limit classification
// ---------------------------------------------------------------------------

/**
 * Thrown when Helius keeps returning HTTP 429 after the configured retries.
 * A distinct type (rather than a generic Error) lets walletActivity log/count
 * this honestly as `rate_limited` — never as an auth_error or unknown failure
 * — and treat it as a transient, non-cycle-poisoning skip. The message always
 * contains `429` and NEVER the api-key.
 */
export class HeliusRateLimitError extends Error {
  readonly rateLimited = true as const;
  constructor(message: string) {
    super(message);
    this.name = 'HeliusRateLimitError';
  }
}

/** Type guard: is this error a provider rate-limit throttle (HTTP 429), not an auth/logic error? */
export function isRateLimitError(err: unknown): boolean {
  if (err instanceof HeliusRateLimitError) return true;
  return typeof err === 'object' && err !== null && (err as { rateLimited?: unknown }).rateLimited === true;
}

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
// Helius API call (rate-limited + 429-retrying)
// ---------------------------------------------------------------------------

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Positive-number env parse (e.g. HELIUS_RPS="2"); undefined/invalid/≤0 → undefined so the caller uses its default. */
function parsePositiveNumber(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw.trim());
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Numeric `Retry-After` (seconds) → ms, or null when the header is absent or
 * non-numeric (HTTP-date form isn't parsed here — callers fall back to
 * exponential backoff, which is strictly safer than trusting a parsed clock).
 */
function parseRetryAfterMs(response: Response): number | null {
  const header = response.headers.get('retry-after');
  if (!header) return null;
  const seconds = Number(header.trim());
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : null;
}

interface RetryConfig {
  maxRetries: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  sleep: (ms: number) => Promise<void>;
}

async function fetchHeliusTransactions(
  apiKey: string,
  limiter: RateLimiter,
  address: string,
  opts: { limit: number; before?: string },
  retry: RetryConfig
): Promise<HeliusTransaction[]> {
  for (let attempt = 0; ; attempt++) {
    // The shared per-provider limiter spaces EVERY attempt (across wallets and
    // across retries) to HELIUS_RPS, so a burst of wallet polls is sequenced,
    // not fired concurrently.
    await limiter.acquire();

    const url = new URL(`${HELIUS_API_BASE}/v0/addresses/${address}/transactions`);
    url.searchParams.set('api-key', apiKey);
    url.searchParams.set('limit', String(opts.limit));
    if (opts.before) {
      url.searchParams.set('before-signature', opts.before);
    }

    const response = await fetch(url.toString(), { signal: AbortSignal.timeout(30_000) });

    if (response.status === 429) {
      // Drain the body so the socket can be reused and no stream is left open.
      await response.text().catch(() => undefined);
      if (attempt < retry.maxRetries) {
        const backoff = Math.min(retry.baseBackoffMs * 2 ** attempt, retry.maxBackoffMs);
        // Honor a numeric Retry-After, but bound it by maxBackoffMs: a broken or
        // hostile 429 (e.g. `Retry-After: 86400`) must never stall the whole
        // strictly-sequential wallet cycle for hours — better to retry sooner
        // and re-throttle if the server still 429s.
        const wait = Math.min(parseRetryAfterMs(response) ?? backoff, retry.maxBackoffMs);
        await retry.sleep(wait);
        continue;
      }
      // Retries exhausted → typed, key-safe rate-limit error (message carries
      // 429 for observability; the url — which holds the api-key — is never
      // interpolated in).
      throw new HeliusRateLimitError(
        `Helius getTransactionsByAddress rate-limited for address ${address} (429 Too Many Requests) after ${retry.maxRetries + 1} attempt(s)`
      );
    }

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
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Constructs a Solana WalletActivityProvider backed by the Helius Enhanced
 * Transactions API, or returns `null` when HELIUS_API_KEY is absent
 * (registry.ts's missing_key / mock-fallback path — Task 27 binding decision
 * 5). Rate-limited via a single shared createRateLimiter at HELIUS_RPS
 * (env-configurable, default HELIUS_RPS_DEFAULT) and 429-retrying with backoff
 * (see fetchHeliusTransactions). The limiter and retry config are created once
 * per provider instance and reused across every wallet poll (registry.ts
 * caches the instance), so the whole cycle's calls share one rate budget.
 */
export function createHeliusActivityProvider(
  env: HeliusActivityEnv,
  opts: HeliusActivityOpts = {}
): WalletActivityProvider | null {
  const apiKey = env.HELIUS_API_KEY;
  if (!apiKey) return null;

  const rps = parsePositiveNumber(env.HELIUS_RPS) ?? HELIUS_RPS_DEFAULT;
  const limiter = createRateLimiter({ rps });
  const retry: RetryConfig = {
    maxRetries: opts.maxRetries ?? DEFAULT_MAX_RETRIES,
    baseBackoffMs: opts.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS,
    maxBackoffMs: opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS,
    sleep: opts.sleep ?? realSleep
  };

  return {
    providerName: 'Helius',
    async getWalletTransactions(
      _chain: Chain,
      address: string,
      callOpts: GetWalletTransactionsOpts = {}
    ): Promise<GetWalletTransactionsResult> {
      if (!isValidSolanaAddress(address)) {
        throw new Error(`createHeliusActivityProvider.getWalletTransactions: invalid Solana address "${address}"`);
      }

      const limit = Math.min(callOpts.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
      const rawTxs = await fetchHeliusTransactions(apiKey, limiter, address, { limit, before: callOpts.cursor }, retry);

      // `since` (callOpts.since) has no direct server-side param in this
      // doc-verified endpoint (time filters are gte-time/lte-time range
      // filters, not a single "only after" cursor semantic the shared
      // GetWalletTransactionsOpts.since contract expects) — filtered
      // client-side after mapping instead, so the contract's meaning
      // ("only return txs at or after this timestamp") holds regardless of
      // which server-side filters a future revision adds.
      let normalized: NormalizedTx[] = mapHeliusTransactions(rawTxs, address);
      if (callOpts.since) {
        const sinceMs = callOpts.since.getTime();
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
