// FlowRadar — DexScreener response -> PairInfo/TokenMarket mapper (Task 28).
//
// Pure function, no I/O. Parses the doc-verified `GET
// /latest/dex/tokens/{tokenAddresses}` response shape (Wave 4 keyless market
// adapter — see dexscreener.ts's file header for the full doc-verification
// trail: this response shape was confirmed against a REAL live call this
// session, not just the docs prose, since the docs site's rate-limit/schema
// page didn't render machine-readably for WebFetch — see dexscreener.ts and
// task-28-report.md for the exact live-fetched example JSON).
//
// Response shape: `{ schemaVersion: string, pairs: RawPair[] | null }` — pairs
// is `null` (not `[]`) when the token has no pairs at all on DexScreener, a
// real observed case (a random/nonexistent address, or a token that only
// trades on a chain other than the one requested), so every entry point here
// treats `null` and `[]` identically.
//
// Field mapping notes (Task 28 binding decision 3):
//   - priceUsd/priceNative arrive as STRINGS in the raw payload (docs example
//     + live-verified: `"priceUsd":"80.29"`) -> parsed to number; a
//     missing/unparseable string maps to `null` rather than `NaN` so no NaN
//     ever leaks into a TokenMarket/PairInfo field.
//   - liquidity.usd/fdv/marketCap/volume.* arrive as numbers already, but are
//     all OPTIONAL per the doc-verified example (a pair can have
//     `"liquidity":null` or omit `fdv`/`marketCap` entirely, observed live for
//     newer/thinner pairs) -> every read is null-safe with `?? null` (money
//     fields) or `?? 0` (volume — TokenMarket's vol5m/1h/6h/24h are
//     non-nullable numbers per @flowradar/core's TokenMarket contract, so an
//     absent volume window means "0 in that window", not "unknown").
//   - Highest-liquidity pair selection (binding decision 2/3): sort by
//     liquidity.usd desc, ties broken by volume.h24 desc. A pair with no
//     liquidity.usd at all sorts as if liquidity were 0 (last), matching the
//     brief's "missing liquidity sorts last / treated as 0" instruction.
//   - Chain filter: only pairs whose raw `chainId` matches the requested
//     FlowRadar `Chain` are considered (see chainIdForFlowRadarChain below) —
//     DexScreener is keyed by mint/contract address globally, and the SAME
//     address string can exist on multiple chains with completely different
//     tokens behind it (live-observed: the wrapped-SOL mint address also
//     resolved a "Wrapped FOGO" pair on chainId "fogo" — see
//     multi-pair-token.json fixture's first entry), so skipping this filter
//     would silently blend an unrelated chain's pair into the result.

export interface RawDexScreenerToken {
  address?: string;
  name?: string;
  symbol?: string;
}

export interface RawDexScreenerTimeframeNumber {
  m5?: number;
  h1?: number;
  h6?: number;
  h24?: number;
}

export interface RawDexScreenerLiquidity {
  usd?: number | null;
  base?: number;
  quote?: number;
}

export interface RawDexScreenerPair {
  chainId?: string;
  dexId?: string;
  pairAddress?: string;
  baseToken?: RawDexScreenerToken;
  quoteToken?: RawDexScreenerToken;
  priceNative?: string;
  priceUsd?: string;
  volume?: RawDexScreenerTimeframeNumber;
  liquidity?: RawDexScreenerLiquidity | null;
  fdv?: number | null;
  marketCap?: number | null;
}

/** The full doc-verified `GET /latest/dex/tokens/{tokenAddresses}` response envelope. */
export interface RawDexScreenerTokensResponse {
  schemaVersion?: string;
  pairs?: RawDexScreenerPair[] | null;
}

import type { Chain, TokenMarket } from '@flowradar/core';
import type { PairInfo } from '../types';

/**
 * Maps our internal Chain enum to DexScreener's lowercase `chainId` string
 * (live-verified this session: SOLANA mints report `"chainId":"solana"`; a
 * BSC-token lookup — e.g. CAKE's contract address — reports
 * `"chainId":"bsc"`).
 */
export function chainIdForFlowRadarChain(chain: Chain): string {
  return chain === 'SOLANA' ? 'solana' : 'bsc';
}

/** Parses a DexScreener numeric-string field (priceUsd/priceNative) to a number, or null when absent/unparseable. */
function parseNumericString(value: string | undefined): number | null {
  if (value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Null-safe liquidity.usd read — missing/null liquidity is treated as 0 for sorting purposes, per binding decision 3. */
function liquidityUsdOrZero(pair: RawDexScreenerPair): number {
  return pair.liquidity?.usd ?? 0;
}

function vol24hOrZero(pair: RawDexScreenerPair): number {
  return pair.volume?.h24 ?? 0;
}

/**
 * Filters raw pairs to only those on `chain`, tolerating a `null` or
 * undefined `pairs` array (DexScreener returns `pairs: null` for an address
 * with zero matches on ANY chain — live-verified).
 */
export function filterPairsByChain(pairs: RawDexScreenerPair[] | null | undefined, chain: Chain): RawDexScreenerPair[] {
  if (!pairs) return [];
  const chainId = chainIdForFlowRadarChain(chain);
  return pairs.filter((p) => p.chainId === chainId);
}

/**
 * Picks the highest-liquidity pair from a (already chain-filtered) list:
 * liquidity.usd desc, ties broken by volume.h24 desc (binding decision 2).
 * Missing liquidity sorts last (treated as 0). Returns null for an empty list.
 */
export function pickHighestLiquidityPair(pairs: RawDexScreenerPair[]): RawDexScreenerPair | null {
  if (pairs.length === 0) return null;
  return [...pairs].sort((a, b) => {
    const liqDiff = liquidityUsdOrZero(b) - liquidityUsdOrZero(a);
    if (liqDiff !== 0) return liqDiff;
    return vol24hOrZero(b) - vol24hOrZero(a);
  })[0]!;
}

/** Maps one raw pair to the shared PairInfo shape (Spec §5 MarketDataProvider.getTokenPairs). */
export function mapRawPairToPairInfo(pair: RawDexScreenerPair): PairInfo {
  return {
    pairAddress: pair.pairAddress ?? '',
    dex: pair.dexId ?? 'unknown',
    baseSymbol: pair.baseToken?.symbol ?? '',
    quoteSymbol: pair.quoteToken?.symbol ?? '',
    liquidityUsd: liquidityUsdOrZero(pair),
    priceUsd: parseNumericString(pair.priceUsd) ?? 0
  };
}

/**
 * Maps the highest-liquidity pair (already selected) to the shared
 * TokenMarket shape. `holderCount` is always `null` — DexScreener's pair
 * payload carries no holder-count field at all (doc-verified absence, not an
 * oversight); see dexscreener.ts's file header / README for the documented
 * gap. marketCapUsd/fdvUsd/liquidityUsd fall back to `null` (not 0) when
 * absent, matching TokenMarket's nullable-money-field contract — only the
 * vol* windows default to 0 (see file header).
 */
export function mapPairToTokenMarket(pair: RawDexScreenerPair): TokenMarket {
  return {
    priceUsd: parseNumericString(pair.priceUsd) ?? 0,
    marketCapUsd: pair.marketCap ?? null,
    fdvUsd: pair.fdv ?? null,
    liquidityUsd: pair.liquidity?.usd ?? null,
    vol5m: pair.volume?.m5 ?? 0,
    vol1h: pair.volume?.h1 ?? 0,
    vol6h: pair.volume?.h6 ?? 0,
    vol24h: pair.volume?.h24 ?? 0,
    holderCount: null,
    pairAddress: pair.pairAddress,
    dex: pair.dexId
  };
}

/** Full getTokenPairs mapping: chain-filter, then map every remaining pair to PairInfo. */
export function mapTokensResponseToPairInfos(response: RawDexScreenerTokensResponse | null | undefined, chain: Chain): PairInfo[] {
  const filtered = filterPairsByChain(response?.pairs, chain);
  return filtered.map(mapRawPairToPairInfo);
}

/** Full getTokenMarket mapping: chain-filter, pick highest-liquidity pair, map to TokenMarket (or null if no pairs). */
export function mapTokensResponseToTokenMarket(
  response: RawDexScreenerTokensResponse | null | undefined,
  chain: Chain
): TokenMarket | null {
  const filtered = filterPairsByChain(response?.pairs, chain);
  const best = pickHighestLiquidityPair(filtered);
  return best ? mapPairToTokenMarket(best) : null;
}
