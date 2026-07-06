// FlowRadar — BscScan (Etherscan API V2) txlist/tokentx -> NormalizedTx mapper
// (Task 29, Wave 4 BSC scaffold).
//
// Address convention: EIP-55 mixed-case checksum is NOT enforced. Every address
// this mapper emits is `.toLowerCase()`-normalized to case-insensitive lowercase
// hex (the repo-wide convention — every Wallet/AddressRegistry key is stored
// lowercased), so a checksummed input and its all-lowercase form collapse to the
// same key rather than being treated as two distinct addresses.
//
// Pure functions, no I/O. Maps the doc-verified `account` module response rows
// (see bscscan.ts's file header for the full doc-verification trail: V2
// endpoint `https://api.etherscan.io/v2/api?chainid=56&...`, confirmed live
// this session that the legacy `api.bscscan.com/api` V1 endpoint now hard-
// rejects with "You are using a deprecated V1 endpoint, switch to Etherscan
// API V2") into the shared NormalizedTx/TxLeg contract (@flowradar/core).
//
// Two independent doc-verified response shapes are merged per wallet:
//   - txlist rows: native BNB transfers (value in wei, `to`/`from` are the
//     transfer parties). A row with `value === "0"` and non-empty `input`
//     (a contract call, e.g. a DEX router `swapExactTokensForTokens` call —
//     see the txlist-page.json fixture's second row) is NOT a native
//     transfer; see buildLegsForTxlistRow below.
//   - tokentx rows: BEP-20 token transfer EVENTS (Transfer event logs), each
//     row already carries the token's own decimals (`tokenDecimal`) and
//     symbol/name directly — no separate metadata lookup needed.
//
// Swap-detection limitation (binding decision 2, documented here per the
// task instruction): BscScan's txlist/tokentx endpoints return raw
// transaction/event rows, NOT decoded swap semantics — there is no
// `events.swap`-equivalent field anywhere in the doc-verified response shape
// (unlike Helius's Enhanced Transactions API for Solana). This mapper
// therefore NEVER synthesizes a `swap_leg`: a swap performed through a known
// DEX router (see registryData/bsc.ts's ROUTER category, e.g. PancakeSwap's
// `0x10ed43c718714eb63d5aa57b78b54704e256024e`) shows up as whatever
// txlist/tokentx rows the swap produced (a zero-value `to`=router
// contract_interaction row from txlist, PLUS the token_transfer legs the same
// swap generated in tokentx — e.g. token OUT to the router, token/WBNB IN
// from the router) rather than one paired swap_leg pair. A future task that
// wants real swap_leg synthesis for BSC needs either (a) decoded event logs
// (the `logs`/`getLogs` endpoint family, doc-unverified this session) or (b)
// heuristic pairing of same-tx token_transfer + contract_interaction rows
// against the ROUTER registry — deliberately NOT attempted here per the
// "docs first, don't guess semantics" rule.

import type { LegKind, NormalizedTx, TxLeg } from '@flowradar/core';

// ---------------------------------------------------------------------------
// Raw BscScan/Etherscan-V2 payload shapes (doc-verified field names — see
// file header for the exact doc URLs: api-reference/endpoint/txlist.md and
// .../tokentx.md)
// ---------------------------------------------------------------------------

export interface BscScanTxlistRow {
  blockNumber: string;
  timeStamp: string;
  hash: string;
  from: string;
  to: string;
  value: string; // wei, decimal string
  input?: string;
  isError?: string; // "0" | "1"
  contractAddress?: string;
}

export interface BscScanTokentxRow {
  blockNumber: string;
  timeStamp: string;
  hash: string;
  from: string;
  to: string;
  contractAddress: string;
  value: string; // raw token units, decimal string
  tokenName?: string;
  tokenSymbol: string;
  tokenDecimal: string; // decimal string, e.g. "18"
}

export interface BscScanListResponse<T> {
  status: string; // "1" success, "0" error/empty
  message: string;
  result: T[] | string; // string when status "0" and result is an error message rather than an array
}

const BNB_DECIMALS = 18;
const NATIVE_BNB_SYMBOL = 'BNB';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Exact-enough decimal formatter — trims trailing zeros but keeps at least one digit if there's a fractional part. */
function toDecimalString(rawValue: string, decimals: number): string {
  let value: bigint;
  try {
    value = BigInt(rawValue);
  } catch {
    return '0';
  }
  if (decimals <= 0) return value.toString();

  const negative = value < 0n;
  const abs = negative ? -value : value;
  const divisor = 10n ** BigInt(decimals);
  const whole = abs / divisor;
  const frac = abs % divisor;
  const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '');
  const sign = negative ? '-' : '';
  return fracStr.length > 0 ? `${sign}${whole}.${fracStr}` : `${sign}${whole}`;
}

/** Response rows are always returned in ARRAY form here — a non-array `result` (an error string) maps to []. */
export function extractRows<T>(response: BscScanListResponse<T> | null | undefined): T[] {
  if (!response) return [];
  return Array.isArray(response.result) ? response.result : [];
}

// ---------------------------------------------------------------------------
// txlist row -> legs
// ---------------------------------------------------------------------------

/**
 * One txlist row -> zero or one leg. A native-value transfer (value > 0)
 * produces a `native_transfer` leg. A zero-value row with non-empty `input`
 * (a contract call — the doc-verified `input`/`methodId`/`functionName`
 * fields all describe this, e.g. a router's `swapExactTokensForTokens` call)
 * produces a `contract_interaction` leg instead (see file header's swap-
 * detection-limitation note — this is deliberately NOT a swap_leg). A
 * zero-value row with EMPTY input (a plain 0-value call, rare) is skipped
 * entirely: nothing of ledger interest happened.
 */
export function buildLegForTxlistRow(row: BscScanTxlistRow): TxLeg | null {
  const hasValue = (() => {
    try {
      return BigInt(row.value) > 0n;
    } catch {
      return false;
    }
  })();

  if (hasValue) {
    return {
      kind: 'native_transfer',
      from: row.from.toLowerCase(),
      to: row.to.toLowerCase(),
      asset: { symbol: NATIVE_BNB_SYMBOL, decimals: BNB_DECIMALS },
      amountToken: toDecimalString(row.value, BNB_DECIMALS)
    };
  }

  const input = row.input ?? '';
  const isContractCall = input !== '' && input !== '0x';
  if (isContractCall) {
    return {
      kind: 'contract_interaction' as LegKind,
      from: row.from.toLowerCase(),
      to: row.to.toLowerCase(),
      asset: { symbol: NATIVE_BNB_SYMBOL, decimals: BNB_DECIMALS },
      amountToken: '0',
      programOrContract: row.to.toLowerCase()
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// tokentx row -> leg
// ---------------------------------------------------------------------------

/** One tokentx row -> one token_transfer leg. Decimals/symbol come straight off the row (doc-verified, no extra lookup needed). */
export function buildLegForTokentxRow(row: BscScanTokentxRow): TxLeg {
  const decimals = Number(row.tokenDecimal);
  return {
    kind: 'token_transfer',
    from: row.from.toLowerCase(),
    to: row.to.toLowerCase(),
    asset: {
      address: row.contractAddress.toLowerCase(),
      symbol: row.tokenSymbol,
      decimals: Number.isFinite(decimals) ? decimals : 0
    },
    amountToken: toDecimalString(row.value, Number.isFinite(decimals) ? decimals : 0)
  };
}

// ---------------------------------------------------------------------------
// Public API — merges txlist + tokentx rows into one NormalizedTx per hash
// ---------------------------------------------------------------------------

/**
 * Merges a page of txlist rows + a page of tokentx rows into NormalizedTx
 * entries, one per distinct tx `hash` (a single BSC tx can carry both a
 * txlist row — the top-level call — AND one or more tokentx rows — the
 * BEP-20 Transfer events it emitted, e.g. a router swap: one txlist row +
 * two tokentx rows for the two legs of the swap). Rows are grouped by hash
 * first so every leg from both feeds lands on the same NormalizedTx.
 */
export function mapBscScanTransactions(
  txlistRows: BscScanTxlistRow[],
  tokentxRows: BscScanTokentxRow[]
): NormalizedTx[] {
  const byHash = new Map<string, { blockNumber: string; timeStamp: string; legs: TxLeg[] }>();

  for (const row of txlistRows) {
    // Only isError !== "1" rows are meaningful ledger events — a failed tx
    // moved no value/tokens regardless of what its `value`/`input` say.
    if (row.isError === '1') continue;
    const leg = buildLegForTxlistRow(row);
    const entry = byHash.get(row.hash) ?? { blockNumber: row.blockNumber, timeStamp: row.timeStamp, legs: [] };
    if (leg) entry.legs.push(leg);
    byHash.set(row.hash, entry);
  }

  for (const row of tokentxRows) {
    const leg = buildLegForTokentxRow(row);
    const entry = byHash.get(row.hash) ?? { blockNumber: row.blockNumber, timeStamp: row.timeStamp, legs: [] };
    entry.legs.push(leg);
    byHash.set(row.hash, entry);
  }

  const out: NormalizedTx[] = [];
  for (const [hash, entry] of byHash) {
    if (entry.legs.length === 0) continue; // e.g. a failed/zero-value/empty-input txlist row with no tokentx counterpart
    out.push({
      txHash: hash,
      blockOrSlot: BigInt(entry.blockNumber),
      ts: new Date(Number(entry.timeStamp) * 1000),
      legs: entry.legs
    });
  }

  return out.sort((a, b) => (a.blockOrSlot < b.blockOrSlot ? -1 : a.blockOrSlot > b.blockOrSlot ? 1 : 0));
}
