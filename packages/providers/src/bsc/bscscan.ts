// FlowRadar — BscScan-backed WalletActivityProvider (Task 29, Wave 4 BSC scaffold).
//
// -----------------------------------------------------------------------
// DOC VERIFICATION (fetched + LIVE-confirmed this session, 2026-07-06)
// -----------------------------------------------------------------------
// docs.bscscan.com/api-endpoints/accounts 301-redirects straight to
// https://docs.etherscan.io/etherscan-v2 — BscScan's own docs now point at
// the unified Etherscan API V2 docs. The V2 migration is not just
// "recommended", it is ENFORCED: a live call this session to the legacy
// `https://api.bscscan.com/api?module=account&action=txlist&...` endpoint
// returned:
//   {"status":"0","message":"NOTOK","result":"You are using a deprecated V1
//    endpoint, switch to Etherscan API V2 using https://docs.etherscan.io/v2-migration"}
// So this adapter uses ONLY the V2 unified endpoint:
//   GET https://api.etherscan.io/v2/api?chainid=56&module=account&action=<txlist|tokentx>&...
// (chainid=56 for BNB Smart Chain Mainnet — doc-verified against
// https://docs.etherscan.io/supported-chains.md's table entry "BNB Smart
// Chain Mainnet | 56 | Available | Not Available").
//
// Doc-verified params (https://docs.etherscan.io/api-reference/endpoint/txlist.md
// and .../tokentx.md): chainid, module=account, action=txlist|tokentx,
// address, (tokentx also accepts contractaddress, unused here), startblock,
// endblock, page, offset, sort, apikey.
//
// Doc-verified response shape: `{status, message, result: [...]}` — status
// "1"/message "OK" on success; status "0" with message "No transactions
// found" and result=[] is the documented EMPTY case (not an error); status
// "0" with any other message (e.g. "NOTOK", a rate-limit or auth message) is
// a real error. Row fields: see bscscanMapper.ts's BscScanTxlistRow/
// BscScanTokentxRow interfaces (hash, from, to, value, input, isError,
// blockNumber, timeStamp for txlist; + contractAddress, tokenSymbol,
// tokenDecimal, tokenName for tokentx).
//
// A NEW Etherscan-issued API key is required (confirmed via
// https://docs.etherscan.io/v2-migration: "Pass in your Etherscan API key
// instead of the old explorer-specific one... a single new Etherscan key
// works across all 60+ supported chains"). This adapter still reads the
// `BSCSCAN_API_KEY` env var name (matches .env.example / the task's binding
// decision and keeps the user-facing name recognizable), even though the
// value itself must now be an Etherscan-V2-compatible key, not a legacy
// BscScan-only key.
//
// Rate limit: doc-verified free tier is **3 requests/second**, 100,000
// calls/day, "selected chains only" (https://docs.etherscan.io/resources/rate-limits.md)
// — the task brief's "confirm ~5rps" assumption does not match current docs;
// this adapter uses the doc-verified 3rps figure instead of silently
// keeping the brief's guess (same "correct the assumption, document it"
// approach helius.ts took for its pagination param name).
//
// Free-tier note also confirmed live: calling the V2 endpoint with a
// placeholder key for chainid=56 returned `{"status":"0","message":"NOTOK",
// "result":"Free API access is not supported for this chain. Please upgrade
// your api plan..."}` — i.e. a REAL (even if free-registered) Etherscan API
// key is required for BSC; a placeholder/missing key cannot work around
// this, consistent with this adapter's key-gated (`null` when absent) design.
//
// Swap detection: deliberately NOT synthesized here — see bscscanMapper.ts's
// file header for the full "docs first" rationale (txlist/tokentx carry no
// decoded swap-event field, unlike Helius's events.swap for Solana).

import type { Chain, NormalizedTx } from '@flowradar/core';
import type { GetWalletTransactionsOpts, GetWalletTransactionsResult, WalletActivityProvider } from '../types';
import { createRateLimiter } from '../rateLimiter';
import type { RateLimiter } from '../rateLimiter';
import { extractRows, mapBscScanTransactions } from './bscscanMapper';
import type { BscScanListResponse, BscScanTokentxRow, BscScanTxlistRow } from './bscscanMapper';

export interface BscScanActivityEnv {
  BSCSCAN_API_KEY?: string;
}

const ETHERSCAN_V2_API_BASE = 'https://api.etherscan.io/v2/api';
const BSC_CHAIN_ID = 56;
// Doc-verified free tier: 3 requests/second (https://docs.etherscan.io/resources/rate-limits.md).
const BSCSCAN_RPS = 3;
const DEFAULT_OFFSET = 100;
const MAX_OFFSET = 1000; // doc-verified: "Effective July 1, 2026, the maximum records returned per request will be reduced from 10,000 to 1,000 for Free tier API users."

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** BSC (EVM-style) address validation: 0x + 40 hex chars. Case-insensitive input; this repo's convention is to store/compare lowercase (see registryData/bsc.ts, mock/address.ts). */
export function isValidBscAddress(address: string): boolean {
  return EVM_ADDRESS_RE.test(address);
}

/** Lowercases a BSC address per this repo's storage/comparison convention. */
export function normalizeBscAddress(address: string): string {
  return address.toLowerCase();
}

// ---------------------------------------------------------------------------
// BscScan (Etherscan V2) API calls
// ---------------------------------------------------------------------------

async function fetchAction<T>(
  apiKey: string,
  limiter: RateLimiter,
  action: 'txlist' | 'tokentx',
  address: string,
  opts: { startblock: number; offset: number }
): Promise<T[]> {
  await limiter.acquire();

  const url = new URL(ETHERSCAN_V2_API_BASE);
  url.searchParams.set('chainid', String(BSC_CHAIN_ID));
  url.searchParams.set('module', 'account');
  url.searchParams.set('action', action);
  url.searchParams.set('address', address);
  url.searchParams.set('startblock', String(opts.startblock));
  url.searchParams.set('endblock', '999999999');
  url.searchParams.set('page', '1');
  url.searchParams.set('offset', String(opts.offset));
  url.searchParams.set('sort', 'asc');
  url.searchParams.set('apikey', apiKey);

  const response = await fetch(url.toString());

  if (!response.ok) {
    const bodyText = await response.text().catch(() => '<no response body>');
    // Never interpolate `url.toString()` (contains apikey) into the thrown
    // message — build a redacted description instead, matching helius.ts's
    // convention for this same failure class.
    throw new Error(
      `BscScan ${action} failed for address ${address} (${response.status} ${response.statusText}): ${bodyText}`
    );
  }

  const json = (await response.json()) as BscScanListResponse<T>;

  // status "0" + message "No transactions found" is the documented EMPTY
  // case, not an error — extractRows already returns [] for a non-array
  // `result` (an error string), so this just distinguishes "empty" from
  // "the docs' worded confirmation of empty" for clarity; no special
  // handling needed beyond extractRows itself.
  if (json.status === '0' && json.message !== 'No transactions found') {
    const resultText = typeof json.result === 'string' ? json.result : JSON.stringify(json.result).slice(0, 300);
    // `resultText` can echo API error prose (e.g. "Free API access is not
    // supported...") but never the apikey itself — BscScan's error bodies
    // don't echo the caller's own key back, so no redaction needed here
    // beyond what fetchAction already avoids interpolating (the URL).
    throw new Error(`BscScan ${action} returned an error for address ${address}: ${json.message} — ${resultText}`);
  }

  return extractRows(json);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Constructs a BSC WalletActivityProvider backed by BscScan (Etherscan API
 * V2, chainid=56), or returns `null` when BSCSCAN_API_KEY is absent
 * (registry.ts's missing_key / mock-fallback path, mirroring Helius's
 * pattern for SOLANA — Task 27 binding decision 5). Rate-limited to the
 * doc-verified free-tier 3rps via createRateLimiter (shared per-provider-
 * -instance limiter across both the txlist and tokentx calls each
 * getWalletTransactions call makes).
 */
export function createBscScanActivityProvider(env: BscScanActivityEnv): WalletActivityProvider | null {
  const apiKey = env.BSCSCAN_API_KEY;
  if (!apiKey) return null;

  const limiter = createRateLimiter({ rps: BSCSCAN_RPS });

  return {
    providerName: 'BscScan',
    async getWalletTransactions(
      _chain: Chain,
      address: string,
      opts: GetWalletTransactionsOpts = {}
    ): Promise<GetWalletTransactionsResult> {
      if (!isValidBscAddress(address)) {
        throw new Error(`createBscScanActivityProvider.getWalletTransactions: invalid BSC address "${address}"`);
      }
      const normalizedAddress = normalizeBscAddress(address);

      const offset = Math.min(opts.limit ?? DEFAULT_OFFSET, MAX_OFFSET);
      // Cursor = block number to resume from (startblock = last synced + 1),
      // per binding decision 2. An opaque string cursor is parsed back to a
      // number; a malformed/absent cursor starts from block 0 (full history).
      const startblock = opts.cursor ? Number(opts.cursor) : 0;

      const [txlistRows, tokentxRows] = await Promise.all([
        fetchAction<BscScanTxlistRow>(apiKey, limiter, 'txlist', normalizedAddress, {
          startblock,
          offset
        }),
        fetchAction<BscScanTokentxRow>(apiKey, limiter, 'tokentx', normalizedAddress, {
          startblock,
          offset
        })
      ]);

      let normalized: NormalizedTx[] = mapBscScanTransactions(txlistRows, tokentxRows);

      // `since` has no direct server-side param on this doc-verified
      // endpoint (only a block-number range, not a timestamp filter) —
      // filtered client-side after mapping, same approach as helius.ts.
      if (opts.since) {
        const sinceMs = opts.since.getTime();
        normalized = normalized.filter((tx) => tx.ts.getTime() >= sinceMs);
      }

      // nextCursor = highest block number seen + 1, so a subsequent call's
      // startblock resumes exactly after the last block this page covered.
      // Only set when either feed returned a FULL page (offset rows) —
      // otherwise we've reached the end of this wallet's history.
      const txlistFull = txlistRows.length === offset;
      const tokentxFull = tokentxRows.length === offset;
      let nextCursor: string | undefined;
      if (txlistFull || tokentxFull) {
        const maxBlock = normalized.reduce((max, tx) => (tx.blockOrSlot > max ? tx.blockOrSlot : max), 0n);
        if (maxBlock > 0n) {
          nextCursor = String(maxBlock + 1n);
        }
      }

      return { txs: normalized, nextCursor };
    }
  };
}
