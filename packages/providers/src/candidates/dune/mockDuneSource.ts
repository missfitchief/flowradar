// FlowRadar — MockDuneOverlapSource: deterministic multi-token wallet-overlap
// finder derived from the mock world (Task 37, Wave 4.6). Given 2-5 token
// addresses, synthesizes overlap rows shaped exactly like the doc-verified
// DuneOverlapRowSchema (types.ts) so runTokenOverlapSearch's Zod-validate step
// exercises the SAME parse path a real Dune query result would.
//
// Candidate set, per search:
//   - GOOD rows: real mock-world wallets whose txsByWallet contains a BUY
//     swap_leg (token flows TO the wallet — same convention as
//     mockTopTraders.ts's own BUY derivation) on >= 2 of the given token
//     addresses. tokens_overlap_count = the wallet's actual distinct-token
//     overlap count against the requested set (never fabricated above what
//     the wallet's own tx history supports).
//   - POISONED rows: the same "a router/CEX address co-appearing" story as
//     mockSource.ts's getPoisonedAddresses, reused here rather than
//     re-deriving a second poison selection — a SOLANA-only graph-demo
//     cexCounterparty/routerCounterparty address is injected as a
//     multi-token trader (deliberately over-claimed, high tokens_overlap_count,
//     high estimated_pnl_usd) so it passes the "looks profitable" bar on
//     claim alone, but Task 35's validation MUST reject it via the
//     AddressRegistry lookup (not the claim) — see getDunePoisonedAddresses
//     export below, mirrored 1:1 for BSC-only searches (no graph-demo
//     counterparties exist for BSC in the mock world — see mockSource.ts's
//     own getPoisonedAddresses header for that same caveat).
//
// Deterministic: driven purely by (world, chain, tokenAddresses) — no
// Math.random()/Date.now(). Same (world, params) always produces the same
// rows, same ordering (sorted by walletAddress).

import type { Chain } from '@flowradar/core';
import type { MockWorld } from '../../mock/world';
import type { DuneClient, DuneResultSet, ExecuteQueryOpts } from './types';

export interface MockOverlapSearchParams {
  chain: Chain;
  tokenAddresses: string[];
  minTokensOverlap?: number;
}

export interface MockOverlapPoisonedAddresses {
  /** The router/CEX address injected as a poisoned multi-token "overlap trader" (SOLANA only — empty for BSC, same caveat as mockSource.ts's getPoisonedAddresses). */
  routerOrCex: string[];
}

const DEFAULT_MIN_TOKENS_OVERLAP = 2;

/**
 * The poisoned address set MockDuneOverlapSource injects for `chain` —
 * exported so tests can assert these specific addresses are present in a
 * search's rows AND that Task 35's validation pipeline rejects them.
 */
export function getDunePoisonedAddresses(world: MockWorld, chain: Chain): MockOverlapPoisonedAddresses {
  if (chain !== 'SOLANA') return { routerOrCex: [] };
  return { routerOrCex: [world.meta.scenarios.graphDemo.cexCounterparty] };
}

/** One wallet's per-token buy aggregate — internal scratch shape before mapping to DuneOverlapRow. */
interface WalletTokenAggregate {
  walletAddress: string;
  tokensHit: Set<string>;
  totalBuyUsd: number;
  totalSellUsd: number;
  buyCount: number;
  sellCount: number;
  firstBuyTime: Date | null;
  txHashes: string[];
}

export class MockDuneOverlapSource {
  private readonly world: MockWorld;

  constructor(world: MockWorld) {
    this.world = world;
  }

  /**
   * Synthesizes overlap rows for the given token addresses, in the exact
   * DuneOverlapRowSchema shape (snake_case field names) — as if a real Dune
   * saved query had returned them. Returns [] if fewer than 2 or more than 5
   * token addresses are given (mirrors dune-feature-wave46.md's "2-5 token
   * CAs" product framing) rather than throwing — a malformed request is a
   * caller bug, but this mock never crashes a worker/seed pass.
   */
  findOverlap(params: MockOverlapSearchParams): DuneRawOverlapRow[] {
    const { chain, tokenAddresses } = params;
    if (tokenAddresses.length < 2 || tokenAddresses.length > 5) return [];

    const minTokensOverlap = params.minTokensOverlap ?? DEFAULT_MIN_TOKENS_OVERLAP;
    const tokenSet = new Set(tokenAddresses);
    const walletsByAddress = new Map(this.world.wallets.filter((w) => w.chain === chain).map((w) => [w.address, w]));

    const aggregates = new Map<string, WalletTokenAggregate>();

    for (const [walletAddress, txs] of this.world.txsByWallet) {
      const wallet = walletsByAddress.get(walletAddress);
      if (!wallet) continue;

      for (const tx of txs) {
        for (const leg of tx.legs) {
          if (leg.kind !== 'swap_leg') continue;
          const tokenAddress = leg.asset.address;
          if (!tokenAddress || !tokenSet.has(tokenAddress)) continue;

          const isBuy = leg.to === walletAddress;
          const isSell = leg.from === walletAddress;
          if (!isBuy && !isSell) continue;

          let agg = aggregates.get(walletAddress);
          if (!agg) {
            agg = {
              walletAddress,
              tokensHit: new Set(),
              totalBuyUsd: 0,
              totalSellUsd: 0,
              buyCount: 0,
              sellCount: 0,
              firstBuyTime: null,
              txHashes: []
            };
            aggregates.set(walletAddress, agg);
          }

          agg.tokensHit.add(tokenAddress);
          const amountUsd = leg.amountUsd ?? 0;
          if (isBuy) {
            agg.totalBuyUsd += amountUsd;
            agg.buyCount += 1;
            if (!agg.firstBuyTime || tx.ts < agg.firstBuyTime) agg.firstBuyTime = tx.ts;
          } else {
            agg.totalSellUsd += amountUsd;
            agg.sellCount += 1;
          }
          if (agg.txHashes.length < 3) agg.txHashes.push(tx.txHash);
        }
      }
    }

    const goodRows: DuneRawOverlapRow[] = [];
    const sortedAggregates = [...aggregates.values()]
      .filter((a) => a.tokensHit.size >= minTokensOverlap)
      .sort((a, b) => a.walletAddress.localeCompare(b.walletAddress));

    // overlapGroupId: wallets sharing the EXACT same set of overlapping
    // tokens are grouped together (a real "recurring co-trader group" proxy)
    // — deterministic key derived from the sorted token-address membership,
    // never Math.random().
    const groupIdByTokenSetKey = new Map<string, string>();
    let groupCounter = 0;

    for (const agg of sortedAggregates) {
      const tokenSetKey = [...agg.tokensHit].sort().join('|');
      let groupId = groupIdByTokenSetKey.get(tokenSetKey);
      if (!groupId) {
        groupCounter += 1;
        groupId = `dune_mock_group_${groupCounter}`;
        groupIdByTokenSetKey.set(tokenSetKey, groupId);
      }

      const wallet = walletsByAddress.get(agg.walletAddress)!;
      goodRows.push({
        wallet_address: agg.walletAddress,
        chain,
        token_symbol: undefined,
        first_buy_time: agg.firstBuyTime?.toISOString(),
        buy_count: agg.buyCount,
        sell_count: agg.sellCount,
        total_buy_usd: Math.round(agg.totalBuyUsd * 100) / 100,
        total_sell_usd: Math.round(agg.totalSellUsd * 100) / 100,
        estimated_pnl_usd: Math.round((agg.totalSellUsd - agg.totalBuyUsd) * (0.5 + (wallet.walletScore / 100) * 0.5) * 100) / 100,
        entry_market_cap_usd: 500000 + wallet.walletScore * 4000,
        tx_hashes: agg.txHashes,
        tokens_overlap_count: agg.tokensHit.size,
        overlap_group_id: groupId
      });
    }

    // Poisoned entry: the router/CEX address, injected as a plausible
    // "traded every requested token, hugely profitable" overlap trader —
    // over-claimed figures so it clears any pnl/overlap-count floor on the
    // claim alone. Task 35's validation must reject it via AddressRegistry,
    // not the claim (see file header + getDunePoisonedAddresses).
    const poisoned = getDunePoisonedAddresses(this.world, chain);
    for (const address of poisoned.routerOrCex) {
      if (goodRows.some((r) => r.wallet_address === address)) continue; // already a real hit, don't duplicate
      goodRows.push({
        wallet_address: address,
        chain,
        token_symbol: undefined,
        first_buy_time: this.world.meta.genesis.toISOString(),
        buy_count: tokenAddresses.length * 3,
        sell_count: tokenAddresses.length * 2,
        total_buy_usd: 250000,
        total_sell_usd: 410000,
        estimated_pnl_usd: 160000,
        entry_market_cap_usd: 800000,
        tx_hashes: [],
        tokens_overlap_count: tokenAddresses.length,
        overlap_group_id: 'dune_mock_group_poisoned'
      });
    }

    return goodRows;
  }
}

/**
 * Wraps MockDuneOverlapSource into the DuneClient interface, so MOCK_MODE
 * callers (runTokenOverlapSearch/runDuneQuerySync's resolveClient — see
 * apps/worker/src/jobs/duneQuery.ts) can use the exact same shape a real
 * createDuneClient(...) instance would present, never a special-cased mock
 * branch inside the db-layer job bodies themselves.
 *
 * Token addresses are recovered from `opts.params.token_address_1..5` (the
 * SAME query-param naming convention runTokenOverlapSearch's own
 * client.executeQuery(...) call sends — see duneOverlap.ts). A call with
 * fewer than 2 recovered token addresses (e.g. a plain DuneQuerySource
 * refresh with no overlap params at all, from runDuneQuerySync) returns an
 * empty-but-valid cached result rather than throwing — there is nothing
 * overlap-shaped to compute for a generic saved-query refresh in mock mode.
 */
export function createMockDuneClient(world: MockWorld): DuneClient {
  const source = new MockDuneOverlapSource(world);

  return {
    async executeQuery(_queryId: string, opts: ExecuteQueryOpts = {}): Promise<DuneResultSet> {
      const params = opts.params ?? {};
      const chain = (typeof params.chain === 'string' ? params.chain : 'SOLANA') as Chain;
      const tokenAddresses: string[] = [];
      for (let i = 1; i <= 5; i++) {
        const value = params[`token_address_${i}`];
        if (typeof value === 'string' && value.length > 0) tokenAddresses.push(value);
      }

      const rows = tokenAddresses.length >= 2 ? source.findOverlap({ chain, tokenAddresses }) : [];
      const limit = opts.limit ?? rows.length;
      const limitedRows = rows.slice(0, limit);

      return {
        rows: limitedRows as unknown as Record<string, unknown>[],
        executionId: undefined,
        usedCached: true,
        truncated: rows.length > limitedRows.length,
        rowsReturned: limitedRows.length
      };
    }
  };
}

/** Snake_case raw row this mock hands back — same field names as DuneOverlapRowSchema (types.ts), so it round-trips through the real Zod parse step unmodified. */
export interface DuneRawOverlapRow {
  wallet_address: string;
  chain: string;
  token_symbol?: string;
  first_buy_time?: string;
  buy_count: number;
  sell_count: number;
  total_buy_usd: number;
  total_sell_usd: number;
  estimated_pnl_usd: number;
  entry_market_cap_usd: number;
  tx_hashes: string[];
  tokens_overlap_count: number;
  overlap_group_id: string;
}
