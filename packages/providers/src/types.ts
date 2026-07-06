// FlowRadar — provider capability interfaces (Spec §5 "Provider layer").
//
// packages/providers depends ONLY on @flowradar/core (see package.json).
// Each interface below is a "capability"; `getProvider(chain, capability)`
// (registry.ts) resolves an implementation per chain from env. In MOCK_MODE
// every capability resolves to MockProvider, backed by a deterministic
// mock/world.ts "mock world". Live adapters (Wave 4) implement these same
// interfaces against real APIs (Helius, DexScreener, BscScan, GoPlus, ...).
//
// Adapters' entire job is mapping raw provider payloads into the shared
// NormalizedTx/TokenMarket/RiskReport shapes from @flowradar/core — everything
// downstream of this layer is provider-agnostic.

import type { Chain, NormalizedTx, RiskReport, TokenMarket, WalletCandidate } from '@flowradar/core';

// ---------------------------------------------------------------------------
// Wallet activity
// ---------------------------------------------------------------------------

export interface GetWalletTransactionsOpts {
  /** Only return txs at or after this timestamp. */
  since?: Date;
  /** Opaque pagination cursor returned by a previous call's `nextCursor`. */
  cursor?: string;
  /** Maximum number of txs to return in this page. */
  limit?: number;
}

export interface GetWalletTransactionsResult {
  txs: NormalizedTx[];
  /** Present when more results exist beyond this page. */
  nextCursor?: string;
}

export interface WalletActivityProvider {
  /**
   * Stable, human-readable identity of the concrete implementation (e.g.
   * "MockProvider", "Helius") — lets callers (and tests) distinguish which
   * backend a resolved provider instance is actually wired to without relying
   * on `instanceof` across capability interfaces. Optional so existing
   * implementers aren't broken; providers registered via getProvider should
   * set it.
   */
  providerName?: string;
  getWalletTransactions(
    chain: Chain,
    address: string,
    opts?: GetWalletTransactionsOpts
  ): Promise<GetWalletTransactionsResult>;
}

// ---------------------------------------------------------------------------
// Market data
// ---------------------------------------------------------------------------

/** One DEX trading pair for a token (Spec §5 `MarketDataProvider.getTokenPairs`). */
export interface PairInfo {
  pairAddress: string;
  dex: string;
  baseSymbol: string;
  quoteSymbol: string;
  liquidityUsd: number;
  priceUsd: number;
}

export interface MarketDataProvider {
  getTokenMarket(chain: Chain, address: string): Promise<TokenMarket | null>;
  getTokenPairs(chain: Chain, address: string): Promise<PairInfo[]>;
}

// ---------------------------------------------------------------------------
// Token metadata
// ---------------------------------------------------------------------------

export interface TokenMeta {
  address: string;
  chain: Chain;
  symbol: string;
  name: string;
  decimals: number;
  createdAt?: Date;
  website?: string;
  twitter?: string;
  telegram?: string;
}

export interface TokenMetadataProvider {
  getTokenMetadata(chain: Chain, address: string): Promise<TokenMeta | null>;
}

// ---------------------------------------------------------------------------
// Risk
// ---------------------------------------------------------------------------

export interface RiskProvider {
  /** See WalletActivityProvider.providerName. */
  providerName?: string;
  getTokenRisk(chain: Chain, address: string): Promise<RiskReport>;
}

// ---------------------------------------------------------------------------
// Wallet discovery (optional capability — Spec §5 comment "// optional capability")
// ---------------------------------------------------------------------------

export interface GetCandidateWalletsOpts {
  limit?: number;
}

export interface WalletDiscoveryProvider {
  getCandidateWallets(chain: Chain, opts?: GetCandidateWalletsOpts): Promise<WalletCandidate[]>;
}

// ---------------------------------------------------------------------------
// Capability registry keys
// ---------------------------------------------------------------------------

/** Every named capability a provider can be resolved for via `getProvider`. */
export type ProviderCapability =
  | 'walletActivity'
  | 'marketData'
  | 'tokenMetadata'
  | 'risk'
  | 'walletDiscovery';

/** Union of every capability interface, keyed the same as ProviderCapability. */
export interface ProviderCapabilityMap {
  walletActivity: WalletActivityProvider;
  marketData: MarketDataProvider;
  tokenMetadata: TokenMetadataProvider;
  risk: RiskProvider;
  walletDiscovery: WalletDiscoveryProvider;
}
