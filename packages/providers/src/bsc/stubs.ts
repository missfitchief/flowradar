// FlowRadar — typed provider stubs: Birdeye / Moralis / Bitquery (Task 29,
// Wave 4 BSC scaffold, binding decision 4).
//
// These three adapters exist ONLY as typed placeholders: each factory below
// returns a fully-shaped capability-interface implementation (so a future
// task can wire one into registry.ts with zero interface changes), but every
// method resolves to an empty/null result and makes NO network call. This
// mirrors solana/risk.ts's getMintAuthorityFlags stub pattern (typed +
// documented + zero I/O) rather than throwing or returning `null` from the
// factory itself, since — unlike createHeliusActivityProvider/
// createBscScanActivityProvider's "null means no key, use mock fallback"
// contract — these are never resolved by getProvider() at all yet (registry.ts
// still throws for capabilities with no real live adapter; see registry.ts's
// getProviderStatuses, which reports these three as separate 'stub' rows
// independent of whatever the primary walletActivity/risk adapter for BSC
// reports).
//
// Why these three specifically: Birdeye (Solana+BSC market data / token
// metadata, keyed), Moralis (multi-chain wallet activity + NFT/token APIs,
// keyed), and Bitquery (GraphQL multi-chain indexer, keyed) are the three
// named in the Task 29 brief as future BSC provider swap-in candidates
// beyond BscScan/GoPlus. None of their endpoints were doc-verified this
// session (out of scope for Task 29 — DexScreener already covers BSC market
// data keylessly per Task 28, so there is no immediate need to wire Birdeye
// for marketData; these stubs exist purely so getProviderStatuses() surfaces
// them on the Settings page and the swap-in point is typed and documented).
//
// TODO(provider): Birdeye — https://docs.birdeye.so/reference/get-defi-price
// (and the wider Birdeye API reference) — not doc-verified this session.
// Env var: BIRDEYE_API_KEY (already reserved in .env.example).
//
// TODO(provider): Moralis — https://docs.moralis.io/web3-data-api/evm/reference
// (wallet history / token transfers endpoints) — not doc-verified this
// session. Env var: MORALIS_API_KEY (already reserved in .env.example).
//
// TODO(provider): Bitquery — https://docs.bitquery.io/docs/intro/ (GraphQL
// schema for EVM transfers/DEX trades) — not doc-verified this session. Env
// var: BITQUERY_API_KEY (already reserved in .env.example).

import type { Chain, RiskReport, TokenMarket, WalletCandidate } from '@flowradar/core';
import type {
  GetCandidateWalletsOpts,
  GetWalletTransactionsOpts,
  GetWalletTransactionsResult,
  MarketDataProvider,
  PairInfo,
  RiskProvider,
  TokenMeta,
  TokenMetadataProvider,
  WalletActivityProvider,
  WalletDiscoveryProvider
} from '../types';

export interface BirdeyeEnv {
  BIRDEYE_API_KEY?: string;
}

export interface MoralisEnv {
  MORALIS_API_KEY?: string;
}

export interface BitqueryEnv {
  BITQUERY_API_KEY?: string;
}

/**
 * Birdeye stub: typed MarketDataProvider + TokenMetadataProvider placeholder.
 * TODO(provider): https://docs.birdeye.so/reference/get-defi-price — wire a
 * real implementation once doc-verified. Always resolves empty/null, no
 * network I/O, regardless of whether BIRDEYE_API_KEY is set (the key is
 * accepted here only for future-signature-compatibility; DexScreener already
 * serves marketData live+keyless for both chains per Task 28, so this stub
 * is not currently load-bearing for any worker path).
 */
export function createBirdeyeStub(
  _env: BirdeyeEnv = {}
): MarketDataProvider & TokenMetadataProvider & { providerName: string } {
  return {
    // providerName added for consistency with the Moralis/Bitquery stubs and
    // WalletActivityProvider.providerName convention — even though
    // MarketDataProvider/TokenMetadataProvider don't declare it, exposing it on
    // the concrete stub lets callers/tests identify this backend uniformly.
    providerName: 'Birdeye (stub)',
    async getTokenMarket(_chain: Chain, _address: string): Promise<TokenMarket | null> {
      return null;
    },
    async getTokenPairs(_chain: Chain, _address: string): Promise<PairInfo[]> {
      return [];
    },
    async getTokenMetadata(_chain: Chain, _address: string): Promise<TokenMeta | null> {
      return null;
    }
  };
}

/**
 * Moralis stub: typed WalletActivityProvider placeholder.
 * TODO(provider): https://docs.moralis.io/web3-data-api/evm/reference — wire
 * a real implementation once doc-verified (candidate for a second BSC
 * walletActivity source, e.g. as a BscScan fallback/supplement). Always
 * resolves an empty page, no network I/O.
 */
export function createMoralisStub(_env: MoralisEnv = {}): WalletActivityProvider {
  return {
    providerName: 'Moralis (stub)',
    async getWalletTransactions(
      _chain: Chain,
      _address: string,
      _opts?: GetWalletTransactionsOpts
    ): Promise<GetWalletTransactionsResult> {
      return { txs: [] };
    }
  };
}

/**
 * Bitquery stub: typed WalletActivityProvider + WalletDiscoveryProvider +
 * RiskProvider placeholder (Bitquery's GraphQL schema spans all of these
 * surfaces). TODO(provider): https://docs.bitquery.io/docs/intro/ — wire a
 * real implementation once doc-verified. Always resolves empty/zero-penalty
 * results, no network I/O.
 */
export function createBitqueryStub(
  _env: BitqueryEnv = {}
): WalletActivityProvider & WalletDiscoveryProvider & RiskProvider {
  return {
    providerName: 'Bitquery (stub)',
    async getWalletTransactions(
      _chain: Chain,
      _address: string,
      _opts?: GetWalletTransactionsOpts
    ): Promise<GetWalletTransactionsResult> {
      return { txs: [] };
    },
    async getCandidateWallets(_chain: Chain, _opts?: GetCandidateWalletsOpts): Promise<WalletCandidate[]> {
      return [];
    },
    async getTokenRisk(_chain: Chain, _address: string): Promise<RiskReport> {
      return { flags: [], penalty: 0 };
    }
  };
}
