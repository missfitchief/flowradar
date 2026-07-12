// FlowRadar — Birdeye-backed CandidateSourceProvider + TokenTopTradersProvider
// (Task 36, Wave 4.5, Spec §5b). Two Birdeye capabilities, doc-verified this
// session (2026-07-06):
//
// -----------------------------------------------------------------------
// DOC VERIFICATION
// -----------------------------------------------------------------------
// Wallet PnL (validator role — `birdeye_wallet_pnl` source name):
//   https://docs.birdeye.so/reference/get-wallet-v2-pnl-summary.md
//   GET https://public-api.birdeye.so/wallet/v2/pnl/summary
//   Headers: X-API-KEY: <BIRDEYE_API_KEY>, x-chain: solana|bsc|..., Accept: application/json
//   Query params: wallet (required), duration ('all'|'90d'|'30d'|'7d'|'24h', default 'all'),
//     position_scope ('duration_only'|'cumulative', default 'duration_only')
//   Response: { success, data: { summary: {
//     unique_tokens,
//     counts: { total_buy, total_sell, total_trade, total_win, total_loss, win_rate },
//     cashflow_usd: { total_invested, total_sold, current_value },
//     pnl: { realized_profit_usd, realized_profit_percent, unrealized_usd, total_usd, avg_profit_per_trade_usd }
//   } } }
//   NOTE: this endpoint takes a SPECIFIC wallet address as input (a PnL
//   lookup, not a leaderboard) — it cannot itself enumerate candidate
//   addresses. It is wired here as a CandidateSourceProvider ONLY in the
//   sense the task's binding decision requires every ExternalWalletSource row
//   to resolve to a CandidateSourceProvider; since Birdeye publishes no
//   discoverable wallet-PnL leaderboard endpoint (only single-wallet lookup),
//   `birdeye_wallet_pnl`'s fetchCandidates has no address list to iterate and
//   returns [] by design (documented below) rather than guessing at an
//   unverified leaderboard shape. Its real value is as an evidence provider
//   for Task 35's validation pipeline (a future task's job, not this one) —
//   this file exposes `getBirdeyeWalletPnl` for that future wiring.
//
// Token top-traders (source role — `birdeye_top_traders` source name):
//   https://docs.birdeye.so/reference/get-defi-v2-tokens-top_traders.md
//   GET https://public-api.birdeye.so/defi/v2/tokens/top_traders
//   Headers: X-API-KEY, x-chain, Accept: application/json
//   Query params: address (required, token contract), time_frame (required,
//     e.g. '24h'), sort_by (required, 'volume'|'trade'|'total_pnl'|
//     'unrealized_pnl'|'realized_pnl'|'volume_usd'), sort_type ('asc'|'desc'),
//     limit (1-10, default 10), offset (0-10000, default 0)
//   Response: { success, data: { items: [{
//     tokenAddress, owner, tags, type, volume, trade, tradeBuy, tradeSell,
//     volumeBuy, volumeSell, volumeUsd, volumeBuyUsd, volumeSellUsd,
//     totalPnl, unrealizedPnl, realizedPnl
//   }] } }
//   This DOES enumerate candidate addresses (top traders FOR a given token),
//   so `birdeye_top_traders`'s fetchCandidates needs a token address to query
//   against — CandidateSourceProvider.fetchCandidates(chain, opts) has no
//   token-address parameter (that capability already exists as a SEPARATE
//   interface, TokenTopTradersProvider.getTopTraders(chain, tokenAddress,
//   opts), Task 35). So this file implements BOTH interfaces:
//     - BirdeyeTokenTopTraders implements TokenTopTradersProvider (the real,
//       docs-verified per-token capability — used by tokenTopTraderBackfill).
//     - createBirdeyeCandidateSource (CandidateSourceProvider,
//       name='birdeye_top_traders') is the ExternalWalletSource-row-facing
//       adapter; since it has no token address to scan on its own (no
//       "trending tokens" doc-verified endpoint was fetched this session),
//       its fetchCandidates also returns [] — it exists so the source row
//       resolves to a real (non-null, non-stub) adapter object whose actual
//       candidate production happens via tokenTopTraderBackfill calling
//       getTopTraders directly with a specific token address, exactly the
//       same "candidates arrive via a job with the right context, not via a
//       context-free interface method" situation as `birdeye_wallet_pnl`
//       above.
//
// Missing BIRDEYE_API_KEY => both factories return null (missing_key,
// registry falls back to stub-empty) — never a crash.

import type { Chain } from '@flowradar/core';
import type {
  CandidateSourceProvider,
  ExternalCandidate,
  FetchCandidatesOpts,
  GetTopTradersOpts,
  TokenTopTrader,
  TokenTopTradersProvider
} from './types';
import { createRateLimiter } from '../rateLimiter';
import type { RateLimiter } from '../rateLimiter';

export interface BirdeyeCandidatesEnv {
  BIRDEYE_API_KEY?: string;
}

const BIRDEYE_API_BASE = 'https://public-api.birdeye.so';
const WALLET_PNL_SUMMARY_PATH = '/wallet/v2/pnl/summary';
const TOKEN_TOP_TRADERS_PATH = '/defi/v2/tokens/top_traders';
// No doc-published rate limit figure was fetched this session for these two
// specific endpoints (Birdeye's plan-tier rate-limit page was out of scope);
// same conservative-default-with-a-note approach as solanaTracker.ts.
const DEFAULT_RPS = 2;
const MAX_TOP_TRADERS_LIMIT = 10; // doc-verified hard cap (1-10) for top_traders

function chainHeader(chain: Chain): string {
  return chain === 'BSC' ? 'bsc' : 'solana';
}

/** Doc-verified `/wallet/v2/pnl/summary` response shape (fields this adapter reads). */
export interface BirdeyeWalletPnlSummary {
  uniqueTokens: number;
  totalTrades: number;
  winRate: number; // 0-1 fraction (doc's win_rate is already 0-1 per Birdeye's own convention for this field)
  realizedProfitUsd: number;
  totalPnlUsd: number;
}

interface BirdeyeWalletPnlResponse {
  success: boolean;
  data?: {
    summary?: {
      unique_tokens?: number;
      counts?: { total_trade?: number; win_rate?: number };
      pnl?: { realized_profit_usd?: number; total_usd?: number };
    };
  };
}

/** Maps a doc-verified wallet-PnL-summary response body to the adapter's own summary shape — exported for fixture testing. */
export function mapBirdeyeWalletPnlSummary(json: BirdeyeWalletPnlResponse): BirdeyeWalletPnlSummary | null {
  const summary = json.data?.summary;
  if (!summary) return null;
  return {
    uniqueTokens: summary.unique_tokens ?? 0,
    totalTrades: summary.counts?.total_trade ?? 0,
    winRate: summary.counts?.win_rate ?? 0,
    realizedProfitUsd: summary.pnl?.realized_profit_usd ?? 0,
    totalPnlUsd: summary.pnl?.total_usd ?? 0
  };
}

/** Doc-verified `/defi/v2/tokens/top_traders` response shape (fields this adapter reads). */
interface BirdeyeTopTraderItem {
  owner: string;
  tags?: string[];
  trade?: number;
  tradeBuy?: number;
  tradeSell?: number;
  volumeBuyUsd?: number;
  volumeSellUsd?: number;
  totalPnl?: number;
  unrealizedPnl?: number;
  realizedPnl?: number;
}

interface BirdeyeTopTradersResponse {
  success: boolean;
  data?: { items?: BirdeyeTopTraderItem[] };
}

/** Maps one doc-verified top_traders item to a TokenTopTrader — exported for fixture testing. */
export function mapBirdeyeTopTrader(item: BirdeyeTopTraderItem, chain: Chain): TokenTopTrader {
  return {
    walletAddress: item.owner,
    chain,
    pnlUsd: item.realizedPnl ?? item.totalPnl,
    tradeCount: item.trade,
    // Provider-CLAIMED detail (additive; claims stay claims — never local truth).
    realizedPnlUsd: item.realizedPnl ?? null,
    unrealizedPnlUsd: item.unrealizedPnl ?? null,
    totalPnlUsd: item.totalPnl ?? null,
    volumeBuyUsd: item.volumeBuyUsd ?? null,
    volumeSellUsd: item.volumeSellUsd ?? null,
    tradeBuy: item.tradeBuy ?? null,
    tradeSell: item.tradeSell ?? null,
    tags: item.tags ?? [],
    raw: item
  };
}

/**
 * Gets a single wallet's Birdeye PnL summary (evidence-provider role for the
 * validation pipeline, not a leaderboard). Returns null on any non-2xx
 * response body it cannot map, never throws for a well-formed "not found"
 * style response — callers treat null as "no Birdeye evidence available".
 */
export async function getBirdeyeWalletPnl(
  env: BirdeyeCandidatesEnv,
  chain: Chain,
  walletAddress: string
): Promise<BirdeyeWalletPnlSummary | null> {
  const apiKey = env.BIRDEYE_API_KEY;
  if (!apiKey) return null;

  const url = new URL(WALLET_PNL_SUMMARY_PATH, BIRDEYE_API_BASE);
  url.searchParams.set('wallet', walletAddress);
  url.searchParams.set('duration', 'all');

  const response = await fetch(url.toString(), {
    headers: { 'X-API-KEY': apiKey, 'x-chain': chainHeader(chain), Accept: 'application/json' }
  });
  if (!response.ok) return null;

  const json = (await response.json()) as BirdeyeWalletPnlResponse;
  if (!json.success) return null;
  return mapBirdeyeWalletPnlSummary(json);
}

/**
 * Constructs a Birdeye TokenTopTradersProvider (docs-verified, real network
 * call), or `null` when BIRDEYE_API_KEY is absent.
 */
export function createBirdeyeTokenTopTraders(env: BirdeyeCandidatesEnv): TokenTopTradersProvider | null {
  const apiKey = env.BIRDEYE_API_KEY;
  if (!apiKey) return null;

  const limiter: RateLimiter = createRateLimiter({ rps: DEFAULT_RPS });

  return {
    async getTopTraders(chain: Chain, tokenAddress: string, opts: GetTopTradersOpts = {}): Promise<TokenTopTrader[]> {
      await limiter.acquire();

      const limit = Math.max(1, Math.min(opts.limit ?? MAX_TOP_TRADERS_LIMIT, MAX_TOP_TRADERS_LIMIT));
      const url = new URL(TOKEN_TOP_TRADERS_PATH, BIRDEYE_API_BASE);
      url.searchParams.set('address', tokenAddress);
      // Doc-verified caps: time_frame maxes at 24h — a PRESENT-window view
      // (callers analyzing historical tokens must treat results as
      // current-window evidence, never a historical leaderboard).
      url.searchParams.set('time_frame', opts.timeFrame ?? '24h');
      url.searchParams.set('sort_by', opts.sortBy ?? 'volume');
      url.searchParams.set('sort_type', 'desc');
      url.searchParams.set('limit', String(limit));

      const response = await fetch(url.toString(), {
        headers: { 'X-API-KEY': apiKey, 'x-chain': chainHeader(chain), Accept: 'application/json' }
      });
      if (!response.ok) {
        const bodyText = await response.text().catch(() => '<no response body>');
        throw new Error(
          `Birdeye top_traders fetch failed for token ${tokenAddress} (${response.status} ${response.statusText}): ${bodyText}`
        );
      }

      const json = (await response.json()) as BirdeyeTopTradersResponse;
      if (!json.success) return [];
      const items = json.data?.items ?? [];
      return items.slice(0, limit).map((item) => mapBirdeyeTopTrader(item, chain));
    }
  };
}

/**
 * Constructs the `birdeye_wallet_pnl` CandidateSourceProvider row-facing
 * adapter, or `null` when BIRDEYE_API_KEY is absent. fetchCandidates always
 * returns [] (see file header: this Birdeye endpoint is a single-wallet
 * lookup, not a leaderboard, so it has no address list of its own to
 * enumerate) — its real evidence-provider capability is `getBirdeyeWalletPnl`
 * above, called with a specific address by the validation pipeline.
 */
export function createBirdeyeWalletPnlCandidateSource(env: BirdeyeCandidatesEnv): CandidateSourceProvider | null {
  const apiKey = env.BIRDEYE_API_KEY;
  if (!apiKey) return null;

  return {
    name: 'birdeye_wallet_pnl',
    chains: ['SOLANA', 'BSC'],
    async fetchCandidates(_chain: Chain, _opts: FetchCandidatesOpts = {}): Promise<ExternalCandidate[]> {
      return [];
    }
  };
}

/**
 * Constructs the `birdeye_top_traders` CandidateSourceProvider row-facing
 * adapter, or `null` when BIRDEYE_API_KEY is absent. fetchCandidates always
 * returns [] (see file header: no doc-verified "which tokens to scan"
 * endpoint was found this session) — real candidate production for this
 * source happens via tokenTopTraderBackfill calling
 * createBirdeyeTokenTopTraders(...).getTopTraders(chain, tokenAddress, opts)
 * directly against a specific token the backfill job already picked.
 */
export function createBirdeyeTopTradersCandidateSource(env: BirdeyeCandidatesEnv): CandidateSourceProvider | null {
  const apiKey = env.BIRDEYE_API_KEY;
  if (!apiKey) return null;

  return {
    name: 'birdeye_top_traders',
    chains: ['SOLANA', 'BSC'],
    async fetchCandidates(_chain: Chain, _opts: FetchCandidatesOpts = {}): Promise<ExternalCandidate[]> {
      return [];
    }
  };
}
