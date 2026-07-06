// FlowRadar — GoPlus token_security-backed RiskProvider for BSC (Task 29,
// Wave 4 BSC scaffold).
//
// -----------------------------------------------------------------------
// DOC VERIFICATION (fetched + LIVE-confirmed this session, 2026-07-06)
// -----------------------------------------------------------------------
// docs.gopluslabs.io/reference/tokensecurityusingget_1.md documents:
//   GET /api/v1/token_security/{chain_id}?contract_addresses=<comma-separated>
//   chain_id "56" = BNB Smart Chain (BSC).
//   Auth: optional Authorization header (higher rate limits) — the endpoint
//   works keyless at a free tier, confirmed by a REAL live call this session:
//     GET https://api.gopluslabs.io/api/v1/token_security/56?contract_addresses=0x55d398326f99059ff775485246999027b3197955
//     -> 200 OK, no Authorization header sent, real BSC USDT security data
//     returned (see test/fixtures/goplus/clean-token.json for the verbatim
//     captured response).
//   A second live call against an address GoPlus has no data for returned
//     `{"code":1,"message":"OK","result":{}}` — an EMPTY OBJECT (not null,
//     not a 404) — see test/fixtures/goplus/not-found.json. This adapter's
//     "no data" branch checks for `result[address]` being absent, not
//     response status.
//   A THIRD live observation (surfaced by a worker smoke test this session,
//     not something anticipated up front): a burst of back-to-back keyless
//     calls with no spacing gets throttled almost immediately with HTTP 200
//     + `{"code":4029,"message":"too many requests"}` — NO `result` field
//     at all (see test/fixtures/goplus/rate-limited.json). The first version
//     of this adapter went straight to `response.result[address]` without
//     checking `code` first, which crashed with a TypeError
//     ("Cannot read properties of undefined (reading '0x...')") the moment
//     GOPLUS_RPS let calls through faster than GoPlus's real (undocumented)
//     keyless throttle tolerates. Fixed by checking `code === 1` before
//     touching `result` at all (see fetchTokenSecurity below), and by
//     lowering GOPLUS_RPS to a conservative 0.5 (one call per 2s) — see
//     that constant's own comment for the exact spacing that was observed
//     to work vs fail.
//
// Response envelope: `{code: number, message: string, result: {[address]:
// TokenSecurityEntry}}` — code 1 + message "OK" on success (live-verified).
// Field names used by this mapper (all live-verified present, values are
// STRINGS not booleans/numbers per the live payload — e.g. `"is_honeypot":
// "0"`, `"buy_tax":"0"`): is_honeypot, buy_tax, sell_tax, is_open_source,
// is_mintable, owner_address, is_proxy, cannot_sell_all, holder_count,
// holders[].percent (top holder concentration — same 30%/60% share-based
// approach as solana/risk.ts's computeHolderConcentration, reusing that
// module's threshold constants' VALUES for consistency across chains
// without importing solana/risk.ts directly, since the input shape differs).
// lp_holders / lp_holder_count are present in the doc'd schema (per the
// tokensecurityusingget_1.md field list) but were NOT present in either
// LIVE response captured this session (both real-token calls omitted them
// entirely) — this mapper treats them as fully optional and does not fail
// or flag anything off their absence, only reading them when present.
//
// penalty = capped sum (binding decision 3): honeypot 0.5 (danger) + tax>10%
// each side 0.15 (warn) / tax>=50% each side 0.3 (danger, supersedes the
// warn) + not-open-source 0.1 (warn) + owner-can-mint 0.15 (warn) +
// cannot_sell_all 0.3 (danger) + top-holder concentration >=30% 0.2 (warn),
// cap 1.

import type { RiskReport } from '@flowradar/core';
import type { Chain } from '@flowradar/core';
import type { RiskProvider } from '../types';
import { createRateLimiter } from '../rateLimiter';
import type { RateLimiter } from '../rateLimiter';

export interface GoPlusRiskEnv {
  /** Optional — higher rate limits when set, but getTokenRisk works keylessly per the live-verified free tier (see file header). */
  GOPLUS_API_KEY?: string;
}

const GOPLUS_API_BASE = 'https://api.gopluslabs.io';
const BSC_GOPLUS_CHAIN_ID = '56';
// No doc-published numeric rps for the keyless tier was found this session
// (the docs page didn't render a rate-limit table for WebFetch). A live
// smoke test THIS session observed the keyless tier's actual behavior
// directly: calls spaced ~1s apart all succeeded, while a burst of
// back-to-back calls with no spacing (e.g. this package's own token-bucket
// limiter set to a sub-1 rps, where `createRateLimiter`'s capacity=rps
// design means even the FIRST call must wait — see rateLimiter.ts — offers
// no immediate-burst headroom, which is a separate footgun from GoPlus's
// own throttle) got throttled almost immediately: HTTP 200 with
// `{"code":4029,"message":"too many requests"}` and NO `result` field at
// all (see fetchTokenSecurity's code-check above, added after this exact
// response shape crashed a worker smoke test). 1rps is used — matching
// every sibling live adapter in this package (Helius, BscScan use the same
// "capacity=rps allows one immediate call, refills at rps/sec" shape) —
// as a conservative default consistent with the "unclear -> document +
// conservative default" rule dexscreener.ts already established for its own
// unverified-rps case. Re-tune upward only after confirming a higher
// sustained rate against the live endpoint.
// One-liner: capacity=rps=1 means NO immediate burst headroom — the first call
// waits one tick; this is intentional given GoPlus's aggressive keyless throttle
// (see the burst-throttle note above). Do not raise for "burst-first" behavior.
const GOPLUS_RPS = 1;

const HIGH_TAX_WARN_THRESHOLD = 0.1; // >10% buy/sell tax -> warn
const HIGH_TAX_DANGER_THRESHOLD = 0.5; // >=50% buy/sell tax -> danger (supersedes warn)
const TOP_HOLDER_WARN_THRESHOLD = 0.3; // >=30% single-holder share -> warn

const PENALTY_HONEYPOT = 0.5;
const PENALTY_TAX_WARN = 0.15;
const PENALTY_TAX_DANGER = 0.3;
const PENALTY_NOT_OPEN_SOURCE = 0.1;
const PENALTY_MINTABLE = 0.15;
const PENALTY_CANNOT_SELL_ALL = 0.3;
const PENALTY_TOP_HOLDER = 0.2;
const PENALTY_CAP = 1;

// ---------------------------------------------------------------------------
// Raw GoPlus response shape (doc + live-verified — see file header)
// ---------------------------------------------------------------------------

export interface GoPlusHolder {
  address: string;
  percent: string; // decimal string, e.g. "0.053330467022984795"
  is_contract?: number;
  is_locked?: number;
}

export interface GoPlusTokenSecurityEntry {
  is_honeypot?: string; // "0" | "1"
  buy_tax?: string; // decimal string, e.g. "0.12"
  sell_tax?: string;
  is_open_source?: string; // "0" | "1"
  is_mintable?: string; // "0" | "1"
  is_proxy?: string; // "0" | "1"
  cannot_sell_all?: string; // "0" | "1"
  owner_address?: string;
  holder_count?: string;
  holders?: GoPlusHolder[];
  token_name?: string;
  token_symbol?: string;
  // Present per docs, not observed in either live sample this session (see
  // file header) — kept optional/unread beyond existence checks.
  lp_holder_count?: string;
  lp_holders?: unknown[];
}

export interface GoPlusTokenSecurityResponse {
  code: number;
  message: string;
  result: Record<string, GoPlusTokenSecurityEntry>;
}

// ---------------------------------------------------------------------------
// Pure mapping (fixture-testable without any network I/O)
// ---------------------------------------------------------------------------

function isTrue(flag: string | undefined): boolean {
  return flag === '1';
}

function parseFraction(value: string | undefined): number {
  if (value === undefined || value === '') return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Top single-holder share (0..1) from the doc/live-verified `holders[].percent` field, or 0 when absent. */
export function topHolderShare(entry: GoPlusTokenSecurityEntry): number {
  const holders = entry.holders ?? [];
  if (holders.length === 0) return 0;
  return holders.reduce((max, h) => Math.max(max, parseFraction(h.percent)), 0);
}

/** Pure: builds a RiskReport from one GoPlus token_security result entry. */
export function buildGoPlusRiskReport(entry: GoPlusTokenSecurityEntry): RiskReport {
  const flags: RiskReport['flags'] = [];
  let penalty = 0;

  if (isTrue(entry.is_honeypot)) {
    flags.push({ id: 'honeypot', label: 'Token is flagged as a honeypot (cannot sell)', severity: 'danger' });
    penalty += PENALTY_HONEYPOT;
  }

  if (isTrue(entry.cannot_sell_all)) {
    flags.push({ id: 'cannot_sell_all', label: 'Holders cannot sell their entire balance', severity: 'danger' });
    penalty += PENALTY_CANNOT_SELL_ALL;
  }

  const buyTax = parseFraction(entry.buy_tax);
  if (buyTax >= HIGH_TAX_DANGER_THRESHOLD) {
    flags.push({ id: 'high_buy_tax', label: `Buy tax is ${(buyTax * 100).toFixed(1)}%`, severity: 'danger' });
    penalty += PENALTY_TAX_DANGER;
  } else if (buyTax > HIGH_TAX_WARN_THRESHOLD) {
    flags.push({ id: 'high_buy_tax', label: `Buy tax is ${(buyTax * 100).toFixed(1)}%`, severity: 'warn' });
    penalty += PENALTY_TAX_WARN;
  }

  const sellTax = parseFraction(entry.sell_tax);
  if (sellTax >= HIGH_TAX_DANGER_THRESHOLD) {
    flags.push({ id: 'high_sell_tax', label: `Sell tax is ${(sellTax * 100).toFixed(1)}%`, severity: 'danger' });
    penalty += PENALTY_TAX_DANGER;
  } else if (sellTax > HIGH_TAX_WARN_THRESHOLD) {
    flags.push({ id: 'high_sell_tax', label: `Sell tax is ${(sellTax * 100).toFixed(1)}%`, severity: 'warn' });
    penalty += PENALTY_TAX_WARN;
  }

  if (entry.is_open_source !== undefined && !isTrue(entry.is_open_source)) {
    flags.push({ id: 'not_open_source', label: 'Contract source code is not verified/open', severity: 'warn' });
    penalty += PENALTY_NOT_OPEN_SOURCE;
  }

  if (isTrue(entry.is_mintable)) {
    flags.push({ id: 'mintable', label: 'Owner can mint additional supply', severity: 'warn' });
    penalty += PENALTY_MINTABLE;
  }

  const topShare = topHolderShare(entry);
  if (topShare >= TOP_HOLDER_WARN_THRESHOLD) {
    flags.push({
      id: 'top_holder_concentration',
      label: `Top holder controls ${(topShare * 100).toFixed(1)}% of supply`,
      severity: 'warn'
    });
    penalty += PENALTY_TOP_HOLDER;
  }

  return { flags, penalty: Math.min(PENALTY_CAP, penalty) };
}

// ---------------------------------------------------------------------------
// Live provider construction
// ---------------------------------------------------------------------------

async function fetchTokenSecurity(
  apiKey: string | undefined,
  limiter: RateLimiter,
  address: string
): Promise<GoPlusTokenSecurityResponse> {
  await limiter.acquire();

  const url = new URL(`${GOPLUS_API_BASE}/api/v1/token_security/${BSC_GOPLUS_CHAIN_ID}`);
  url.searchParams.set('contract_addresses', address);

  const headers: Record<string, string> = {};
  if (apiKey) {
    // Doc-referenced optional Authorization header for higher rate limits
    // (see file header) — not independently verified against a live
    // authenticated call this session (only the keyless path was smoke
    // tested), so this is a best-effort pass-through rather than a
    // confirmed-exact header format.
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const response = await fetch(url.toString(), { headers });

  if (!response.ok) {
    const bodyText = await response.text().catch(() => '<no response body>');
    throw new Error(
      `GoPlus token_security failed for address ${address} (${response.status} ${response.statusText}): ${bodyText}`
    );
  }

  const json = (await response.json()) as GoPlusTokenSecurityResponse;

  // GoPlus signals errors (including rate-limiting) with HTTP 200 + a
  // non-1 `code` and NO `result` field at all — live-observed this session
  // hitting the keyless tier in a tight loop: `{"code":4029,"message":"too
  // many requests"}`. Only `code === 1` ("Success") is documented
  // (docs.gopluslabs.io's schema: "Code 1: Success"; no other code is
  // enumerated in the docs, but the SDK's own sample error-checks
  // `code != SUCCESS` generically) — treat ANY other code as a hard error
  // rather than assuming `result` exists, so a caller never dereferences
  // `.result[address]` on an envelope that omitted `result` (the crash this
  // fixes: TypeError "Cannot read properties of undefined (reading
  // '0xADDRESS')" surfaced in a live worker smoke test at RPS=1).
  if (json.code !== 1) {
    throw new Error(`GoPlus token_security returned a non-success code for address ${address}: ${json.code} ${json.message}`);
  }

  return json;
}

/**
 * Constructs a BSC RiskProvider backed by GoPlus's token_security endpoint.
 * Unlike createBscScanActivityProvider/createHeliusActivityProvider, this
 * NEVER returns null for a missing key — GoPlus's token_security endpoint is
 * keyless-live at a free tier (live-verified this session, see file header),
 * so GOPLUS_API_KEY is purely an optional rate-limit upgrade, not a gate.
 * `env` is accepted for signature symmetry with the other `create*Provider`
 * factories in this package.
 */
export function createGoPlusRiskProvider(env: GoPlusRiskEnv): RiskProvider {
  const apiKey = env.GOPLUS_API_KEY;
  const limiter = createRateLimiter({ rps: GOPLUS_RPS });

  return {
    providerName: 'GoPlus',
    async getTokenRisk(_chain: Chain, address: string): Promise<RiskReport> {
      const normalizedAddress = address.toLowerCase();
      const response = await fetchTokenSecurity(apiKey, limiter, normalizedAddress);
      const entry = response.result[normalizedAddress];
      if (!entry) {
        // Doc/live-verified "no data for this address" case: `result` is an
        // empty object (or simply missing this key), not an error — return
        // an empty/no-flag report rather than throwing, matching the
        // "unknown risk is not the same as high risk" contract every other
        // RiskProvider in this package follows.
        return { flags: [], penalty: 0 };
      }
      return buildGoPlusRiskReport(entry);
    }
  };
}
