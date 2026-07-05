// FlowRadar — MockProvider: implements every provider capability (Spec §5)
// against a deterministic MockWorld (mock/world.ts). This is the default
// provider in MOCK_MODE (see ../registry.ts) and exercises the exact same
// ingest -> normalize -> store -> score -> signal -> alert pipeline that live
// adapters will (Wave 4) — only the data source differs.

import type { Chain, RiskReport, TokenMarket, WalletCandidate, WalletLabel } from '@flowradar/core';
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
import type { MockWorld } from './world';

export interface MockProviderOptions {
  /**
   * Upper time bound for all provider reads — txs/market points after `now`
   * are invisible, simulating "the world only knows what has happened up to
   * the current moment". Defaults to `world.meta.horizon` (genesis + 72h),
   * i.e. the entire scripted world is visible by default.
   */
  now?: Date;
}

const SMART_LABELS: WalletLabel[] = ['smart_money', 'whale', 'human_like'];

/**
 * Implements WalletActivityProvider + MarketDataProvider + TokenMetadataProvider
 * + RiskProvider + WalletDiscoveryProvider against one MockWorld instance.
 */
export class MockProvider
  implements WalletActivityProvider, MarketDataProvider, TokenMetadataProvider, RiskProvider, WalletDiscoveryProvider
{
  private readonly world: MockWorld;
  private readonly now: Date;

  constructor(world: MockWorld, options: MockProviderOptions = {}) {
    this.world = world;
    this.now = options.now ?? world.meta.horizon;
  }

  // -------------------------------------------------------------------------
  // WalletActivityProvider
  // -------------------------------------------------------------------------

  async getWalletTransactions(
    _chain: Chain,
    address: string,
    opts: GetWalletTransactionsOpts = {}
  ): Promise<GetWalletTransactionsResult> {
    const allTxs = this.world.txsByWallet.get(address) ?? [];

    // Visibility bound: never surface a tx after `now`.
    const visible = allTxs.filter((tx) => tx.ts.getTime() <= this.now.getTime());

    // `since`: drop txs strictly before the given timestamp.
    const sinceFiltered = opts.since ? visible.filter((tx) => tx.ts.getTime() >= opts.since!.getTime()) : visible;

    // `cursor`: opaque numeric index into `sinceFiltered` (stable because
    // sinceFiltered is deterministically ordered — txsByWallet entries are
    // pre-sorted by ts ascending in createMockWorld, and filtering preserves
    // relative order).
    const startIndex = opts.cursor ? parseCursor(opts.cursor) : 0;
    const limit = opts.limit ?? 100;

    const page = sinceFiltered.slice(startIndex, startIndex + limit);
    const endIndex = startIndex + page.length;
    const nextCursor = endIndex < sinceFiltered.length ? String(endIndex) : undefined;

    return { txs: page, nextCursor };
  }

  // -------------------------------------------------------------------------
  // MarketDataProvider
  // -------------------------------------------------------------------------

  async getTokenMarket(_chain: Chain, address: string): Promise<TokenMarket | null> {
    const series = this.world.marketSeries.get(address);
    if (!series || series.length === 0) return null;

    // Latest point at or before `now`. If `now` is before every point, there
    // is no market data yet for this token.
    let latest: TokenMarket | null = null;
    for (const point of series) {
      if (point.ts.getTime() > this.now.getTime()) break;
      latest = point.market;
    }
    return latest;
  }

  async getTokenPairs(_chain: Chain, address: string): Promise<PairInfo[]> {
    const token = this.world.tokens.find((t) => t.address === address);
    const market = await this.getTokenMarket(_chain, address);
    if (!token || !market) return [];

    const quoteSymbol = token.chain === 'SOLANA' ? 'SOL' : 'WBNB';
    const pair: PairInfo = {
      pairAddress: `${address}-pair`,
      dex: market.dex ?? (token.chain === 'SOLANA' ? 'Raydium' : 'PancakeSwap'),
      baseSymbol: token.symbol,
      quoteSymbol,
      liquidityUsd: market.liquidityUsd ?? 0,
      priceUsd: market.priceUsd
    };
    return [pair];
  }

  // -------------------------------------------------------------------------
  // TokenMetadataProvider
  // -------------------------------------------------------------------------

  async getTokenMetadata(_chain: Chain, address: string): Promise<TokenMeta | null> {
    const token = this.world.tokens.find((t) => t.address === address);
    if (!token) return null;
    return {
      address: token.address,
      chain: token.chain,
      symbol: token.symbol,
      name: token.name,
      decimals: token.decimals,
      createdAt: token.createdAt
    };
  }

  // -------------------------------------------------------------------------
  // RiskProvider
  // -------------------------------------------------------------------------

  async getTokenRisk(_chain: Chain, address: string): Promise<RiskReport> {
    return this.world.riskByToken.get(address) ?? { flags: [], penalty: 0 };
  }

  // -------------------------------------------------------------------------
  // WalletDiscoveryProvider
  // -------------------------------------------------------------------------

  async getCandidateWallets(chain: Chain, opts: GetCandidateWalletsOpts = {}): Promise<WalletCandidate[]> {
    const limit = opts.limit ?? 40;
    const candidates: WalletCandidate[] = this.world.wallets
      .filter((w) => w.chain === chain && w.labels.some((l) => SMART_LABELS.includes(l)))
      .sort((a, b) => b.walletScore - a.walletScore)
      .slice(0, limit)
      .map((w) => ({
        walletId: w.id,
        chain: w.chain,
        address: w.address,
        labels: w.labels,
        walletScore: w.walletScore
      }));
    return candidates;
  }
}

function parseCursor(cursor: string): number {
  const parsed = Number.parseInt(cursor, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}
