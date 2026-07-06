// FlowRadar — DexScreener live MarketDataProvider (Task 28, Wave 4).
//
// Placed in a neutral `market/` path (not `solana/`) despite the task brief's
// suggested `solana/dexscreener.ts` location: DexScreener is a multi-chain
// aggregator and this ONE adapter serves BOTH SOLANA and BSC market-data
// lookups (registry.ts wires it for both chains — see registry.ts's
// liveAdapterNameFor already returning 'DexScreener' for the 'marketData'
// capability regardless of chain). Filing it under `solana/` would misstate
// its scope the moment BSC wiring lands, so `market/` was chosen instead;
// noted here per the task's "choose and note" instruction.
//
// -----------------------------------------------------------------------
// DOC VERIFICATION (fetched this session)
// -----------------------------------------------------------------------
// Primary reference: https://docs.dexscreener.com/api/reference (endpoint
// index) lists `GET /latest/dex/tokens/{tokenAddresses}` among the documented
// paths. The docs site renders per-endpoint rate-limit badges and full
// request/response schemas via client-side JS from an OpenAPI spec that
// WebFetch's markdown conversion could NOT surface for this specific
// endpoint (repeated fetches of the reference index, the `.md` variant, the
// `llms-full.txt` export, and the `?ask=` query interface all confirmed the
// endpoint EXISTS but returned "rate limit not specified in the provided
// content" for it — they DID reliably confirm "60 requests per minute" for a
// different endpoint group: token-profiles/community-takeovers/ads/metas).
//
// Given that gap, this adapter's shape was independently confirmed against a
// REAL live call this session (2026-07-06):
//   GET https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112
//   -> 200 OK, `{"schemaVersion":"1.0.0","pairs":[ ... ]}` — 24 pairs, mixing
//   `chainId:"solana"` pairs with ONE `chainId:"fogo"` pair sharing the exact
//   same base-token address (proves the per-chain filter in
//   dexscreenerMapper.ts is load-bearing, not defensive-only).
//   GET https://api.dexscreener.com/latest/dex/tokens/0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82
//   (PancakeSwap CAKE on BSC) -> 200 OK, `chainId:"bsc"` pairs confirmed.
//   A nonexistent/unmatched address -> `{"schemaVersion":"1.0.0","pairs":null}`
//   (null, not []) — handled explicitly (see dexscreenerMapper.ts).
//
// TODO(provider): the exact published rate limit for this endpoint could not
// be verified verbatim from docs text this session (see gap above). This
// adapter uses 300 requests/minute as its limiter configuration — the
// figure widely documented for DexScreener's pairs/tokens/search endpoint
// family in community references and consistent with the endpoint's public,
// keyless, high-QPS design — but flags it here as NOT independently
// doc-confirmed-verbatim, per the "unclear -> stub+TODO+URL" rule. Re-verify
// against https://docs.dexscreener.com/api/reference before relying on this
// number for capacity planning; if a 429 is observed in practice, lower it.
//
// No API key exists for this endpoint (fully public/keyless) — this is the
// one adapter that always resolves 'live', never 'missing_key'.

import type { Chain, TokenMarket } from '@flowradar/core';
import type { MarketDataProvider, PairInfo } from '../types';
import { createRateLimiter } from '../rateLimiter';
import type { RateLimiter } from '../rateLimiter';
import { mapTokensResponseToPairInfos, mapTokensResponseToTokenMarket } from './dexscreenerMapper';
import type { RawDexScreenerTokensResponse } from './dexscreenerMapper';

const DEXSCREENER_API_BASE = 'https://api.dexscreener.com';
// See file header TODO(provider): not independently doc-confirmed verbatim
// this session; widely-documented figure for this endpoint family, used as a
// conservative default pending re-verification.
const DEXSCREENER_RPM = 300;
const DEXSCREENER_RPS = DEXSCREENER_RPM / 60;

async function fetchTokenPairs(limiter: RateLimiter, address: string): Promise<RawDexScreenerTokensResponse> {
  await limiter.acquire();

  const url = `${DEXSCREENER_API_BASE}/latest/dex/tokens/${encodeURIComponent(address)}`;
  const response = await fetch(url);

  if (response.status === 429) {
    throw new Error(
      `DexScreener getTokenPairs rate-limited (429) for address ${address}. Back off and retry — see dexscreener.ts's rate-limit TODO.`
    );
  }

  if (!response.ok) {
    // No API key on this adapter, so nothing to redact — but still avoid
    // echoing the full response body verbatim beyond a bounded snippet, to
    // match the "don't leak internal detail" spirit of the sibling live
    // adapters (helius.ts/risk.ts) even though there's no secret here.
    const bodyText = await response.text().catch(() => '<no response body>');
    const snippet = bodyText.slice(0, 300);
    throw new Error(`DexScreener getTokenPairs failed for address ${address} (${response.status} ${response.statusText}): ${snippet}`);
  }

  return (await response.json()) as RawDexScreenerTokensResponse;
}

/**
 * Env placeholder kept for signature symmetry with the other
 * `create*Provider(env)` factories in this package (helius.ts/risk.ts) —
 * DexScreener's token-pairs endpoint takes no API key, so nothing is
 * currently read off it. Reserved for a future optional paid tier
 * (DexScreener does offer higher-throughput paid plans) without another
 * signature change.
 */
export interface DexScreenerEnv {
  [key: string]: string | undefined;
}

/**
 * Constructs the DexScreener-backed MarketDataProvider. Unlike every other
 * live adapter in this package, this NEVER returns null — DexScreener's
 * token-pairs lookup is fully keyless, so it is always constructible
 * (registry.ts wires it unconditionally for both chains in live mode; see
 * registry.ts's Task 28 update).
 */
export function createDexScreenerProvider(_env: DexScreenerEnv = {}): MarketDataProvider {
  const limiter = createRateLimiter({ rps: DEXSCREENER_RPS });

  return {
    async getTokenMarket(chain: Chain, address: string): Promise<TokenMarket | null> {
      const response = await fetchTokenPairs(limiter, address);
      return mapTokensResponseToTokenMarket(response, chain);
    },

    async getTokenPairs(chain: Chain, address: string): Promise<PairInfo[]> {
      const response = await fetchTokenPairs(limiter, address);
      return mapTokensResponseToPairInfos(response, chain);
    }
  };
}
