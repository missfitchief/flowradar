// FlowRadar — runLocalOverlapSearch: the 'local' Multi-Token Wallet Overlap
// Finder data source (Task 38, Wave 4.6, dune-feature-wave46.md's Overlap
// Finder UI section + task-38-brief.md binding decision 3). Computes overlap
// directly from this app's own WalletTokenTrade ledger — no Dune credits, no
// external API — and persists into the SAME TokenOverlapSearch/
// TokenOverlapWalletResult/TokenOverlapGroupResult tables Task 37's
// runTokenOverlapSearch writes, so both sources render through one UI
// (OverlapResultsTable/OverlapGroupsTable/CoverageBanner) without a
// source-specific table shape.
//
// TRUST BOUNDARY: local-DB overlap hits are already-tracked Wallet rows by
// construction — this data comes entirely from WalletTokenTrade, which only
// exists for a wallet already known to this app (walletId is a required FK).
// There is no new, unvetted address a local search could surface, so unlike
// Task 37's Dune path there is nothing to route through the CandidateWallet
// pending gate: runLocalOverlapSearch never creates CandidateWallet rows
// (candidatesUpserted is always 0). This is the "Local DB — direct
// on-chain-derived" framing CoverageBanner shows (task-38-brief.md binding
// decision 6/7) — no trust-boundary language, because there is no new trust
// being extended.

import type { Prisma, PrismaClient } from '@prisma/client';
import type { Chain } from '@flowradar/core';

export interface LocalOverlapSearchInput {
  chain: Chain;
  /** Token CONTRACT ADDRESSES (Token.address), 2-5 of them — resolved to Token rows internally via (chain, address). */
  tokenAddresses: string[];
  minTradeUsd?: number;
  /** Minimum distinct-token overlap to count as a hit. Defaults to tokenAddresses.length ("traded ALL"). */
  minTokensOverlap?: number;
  maxResults?: number;
}

export interface LocalOverlapSearchResult {
  searchId: string;
  status: 'done' | 'failed';
  rowsReturned: number;
  walletResultsCreated: number;
  groupResultsCreated: number;
  /** True only when the maxResults cap actually dropped qualifying rows. */
  truncated: boolean;
  error?: string;
}

const DEFAULT_MAX_RESULTS = 500;

/**
 * Runs ONE local-DB overlap search: finds wallets whose WalletTokenTrade BUY
 * rows (amountUsd >= minTradeUsd) touch >= minTokensOverlap of the given
 * tokens, aggregates per-wallet buy/sell/pnl/first-buy-time figures, groups
 * wallets sharing the EXACT same overlapping-token set into a
 * TokenOverlapGroupResult (same "recurring co-trader group" concept
 * MockDuneOverlapSource uses), and persists everything onto a
 * TokenOverlapSearch row with usedCachedResult=null (n/a for a local
 * source — there is no cache/fresh distinction to report) and
 * truncated=true only when the cap was actually hit.
 *
 * Never creates CandidateWallet rows (see file header) — every hit is
 * already a tracked Wallet row by construction (WalletTokenTrade.walletId is
 * a required FK), so there is nothing to promote.
 */
export async function runLocalOverlapSearch(
  prisma: PrismaClient,
  input: LocalOverlapSearchInput
): Promise<LocalOverlapSearchResult> {
  const maxResults = input.maxResults ?? DEFAULT_MAX_RESULTS;
  const minTokensOverlap = input.minTokensOverlap ?? input.tokenAddresses.length;
  const minTradeUsd = input.minTradeUsd ?? 0;

  const params = {
    min_trade_usd: minTradeUsd,
    min_tokens_overlap: minTokensOverlap,
    max_results: maxResults
  };

  const search = await prisma.tokenOverlapSearch.create({
    data: {
      chain: input.chain,
      tokenAddresses: input.tokenAddresses,
      params: params as Prisma.InputJsonValue,
      status: 'running',
      startedAt: new Date()
    }
  });

  try {
    const tokens = await prisma.token.findMany({
      where: { chain: input.chain, address: { in: input.tokenAddresses } },
      select: { id: true, address: true }
    });
    const tokenIds = tokens.map((t) => t.id);

    if (tokenIds.length === 0) {
      await prisma.tokenOverlapSearch.update({
        where: { id: search.id },
        data: { status: 'done', rowsReturned: 0, usedCachedResult: null, truncated: false, finishedAt: new Date() }
      });
      return { searchId: search.id, status: 'done', rowsReturned: 0, walletResultsCreated: 0, groupResultsCreated: 0, truncated: false };
    }

    const trades = await prisma.walletTokenTrade.findMany({
      where: {
        chain: input.chain,
        tokenId: { in: tokenIds },
        action: { in: ['BUY', 'SELL'] }
      },
      select: {
        walletId: true,
        tokenId: true,
        action: true,
        amountUsd: true,
        ts: true,
        marketCapAtTrade: true,
        txHash: true,
        wallet: { select: { address: true } }
      }
    });

    interface Agg {
      walletAddress: string;
      tokensHit: Set<string>;
      totalBuyUsd: number;
      totalSellUsd: number;
      buyCount: number;
      sellCount: number;
      firstBuyTime: Date | null;
      entryMarketCapUsd: number | null;
      txHashes: string[];
    }
    const aggByWallet = new Map<string, Agg>();

    for (const trade of trades) {
      const amountUsd = Number(trade.amountUsd);
      if (trade.action === 'BUY' && amountUsd < minTradeUsd) continue;

      let agg = aggByWallet.get(trade.walletId);
      if (!agg) {
        agg = {
          walletAddress: trade.wallet.address,
          tokensHit: new Set(),
          totalBuyUsd: 0,
          totalSellUsd: 0,
          buyCount: 0,
          sellCount: 0,
          firstBuyTime: null,
          entryMarketCapUsd: null,
          txHashes: []
        };
        aggByWallet.set(trade.walletId, agg);
      }

      if (trade.action === 'BUY') {
        // Overlap counts a token only when the wallet has a QUALIFYING BUY of
        // it (amountUsd >= minTradeUsd) — matches the "traded all N tokens"
        // framing (task-38-brief.md + the UI's "bought-all-early" language).
        // A SELL-only touch on a token (no qualifying BUY) must NOT count
        // toward tokensHit/tokensOverlapCount, even though it still
        // contributes to totalSellUsd/sellCount/pnl below.
        agg.tokensHit.add(trade.tokenId);
        agg.totalBuyUsd += amountUsd;
        agg.buyCount += 1;
        if (!agg.firstBuyTime || trade.ts < agg.firstBuyTime) {
          agg.firstBuyTime = trade.ts;
          agg.entryMarketCapUsd = Number(trade.marketCapAtTrade);
        }
      } else {
        agg.totalSellUsd += amountUsd;
        agg.sellCount += 1;
      }
      if (agg.txHashes.length < 3) agg.txHashes.push(trade.txHash);
    }

    const qualifying = [...aggByWallet.values()]
      .filter((a) => a.tokensHit.size >= minTokensOverlap)
      .sort((a, b) => {
        const pnlA = a.totalSellUsd - a.totalBuyUsd;
        const pnlB = b.totalSellUsd - b.totalBuyUsd;
        return pnlB - pnlA;
      });

    const truncated = qualifying.length > maxResults;
    const limited = qualifying.slice(0, maxResults);

    // Group wallets sharing the EXACT same overlapping-token set (same
    // "recurring co-trader group" derivation as MockDuneOverlapSource).
    const groupIdByTokenSetKey = new Map<string, string>();
    let groupCounter = 0;
    const groupAccumulator = new Map<string, { walletAddresses: Set<string>; sharedTokenCounts: number[] }>();

    let walletResultsCreated = 0;
    for (const agg of limited) {
      const tokenSetKey = [...agg.tokensHit].sort().join('|');
      let groupId = groupIdByTokenSetKey.get(tokenSetKey);
      if (!groupId) {
        groupCounter += 1;
        groupId = `local_group_${groupCounter}`;
        groupIdByTokenSetKey.set(tokenSetKey, groupId);
      }

      await prisma.tokenOverlapWalletResult.create({
        data: {
          searchId: search.id,
          walletAddress: agg.walletAddress,
          chain: input.chain,
          tokensOverlapCount: agg.tokensHit.size,
          totalBuyUsd: agg.totalBuyUsd,
          totalSellUsd: agg.totalSellUsd,
          estimatedPnlUsd: agg.totalSellUsd - agg.totalBuyUsd,
          firstBuyTime: agg.firstBuyTime,
          buyCount: agg.buyCount,
          sellCount: agg.sellCount,
          entryMarketCapUsd: agg.entryMarketCapUsd,
          overlapGroupId: groupId,
          txHashesSample: agg.txHashes
        }
      });
      walletResultsCreated += 1;

      const group = groupAccumulator.get(groupId) ?? { walletAddresses: new Set(), sharedTokenCounts: [] };
      group.walletAddresses.add(agg.walletAddress);
      group.sharedTokenCounts.push(agg.tokensHit.size);
      groupAccumulator.set(groupId, group);
    }

    let groupResultsCreated = 0;
    for (const [overlapGroupId, group] of groupAccumulator) {
      if (group.walletAddresses.size < 2) continue;
      await prisma.tokenOverlapGroupResult.create({
        data: {
          searchId: search.id,
          overlapGroupId,
          walletCount: group.walletAddresses.size,
          walletAddresses: [...group.walletAddresses].sort(),
          sharedTokenCount: Math.min(...group.sharedTokenCounts)
        }
      });
      groupResultsCreated += 1;
    }

    await prisma.tokenOverlapSearch.update({
      where: { id: search.id },
      data: {
        status: 'done',
        rowsReturned: limited.length,
        usedCachedResult: null,
        truncated,
        finishedAt: new Date()
      }
    });

    return {
      searchId: search.id,
      status: 'done',
      rowsReturned: limited.length,
      walletResultsCreated,
      groupResultsCreated,
      truncated
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.tokenOverlapSearch
      .update({ where: { id: search.id }, data: { status: 'failed', error: message, finishedAt: new Date() } })
      .catch(() => undefined);
    return {
      searchId: search.id,
      status: 'failed',
      rowsReturned: 0,
      walletResultsCreated: 0,
      groupResultsCreated: 0,
      truncated: false,
      error: message
    };
  }
}
