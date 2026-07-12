// FlowRadar — top-PnL discovery pipeline (runner-mining scope correction).
//
// For EVERY verified $10M+ runner (token_lifecycles.runnerClass =
// 'verified_above_10m'), discovers top-PnL wallet candidates from TWO
// sources and validates every provider claim against the local view:
//
//   1. local_reconstruction — bounded per-mint aggregation of
//      wallet_token_trades (priced legs only; unpriced NEVER fabricated as
//      $0), ranked by realized proxy (soldUsd - boughtUsd).
//   2. birdeye_top_traders — createBirdeyeTokenTopTraders (probe-verified,
//      ~1rps plan ceiling, hard 10-item cap, 24h window ONLY — a
//      PRESENT-window view, never a historical leaderboard; recorded on
//      every row). Budgeted + RESUMABLE via top_pnl_fetch_states.
//
// LOCAL VALIDATION (binding): every candidate gets one of locally_verified /
// partially_verified / provider_only / conflicting / incomplete / invalid —
// PnL is never fabricated on an incomplete basis; provider-claimed PnL is
// DISCOVERY EVIDENCE ONLY (never votes, never eligibility, never local
// truth). Idempotent (chain, mint, wallet, source) upserts; bounded +
// stable-ordered; per-mint error isolation + receipts. SHADOW-ONLY writes.

import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';
import type { TokenTopTrader, TokenTopTradersProvider } from '@flowradar/providers';

export const TOP_PNL_ENGINE_VERSION = 1;

export type TopPnlValidation =
  | 'locally_verified'
  | 'partially_verified'
  | 'provider_only'
  | 'conflicting'
  | 'incomplete'
  | 'invalid';

interface LocalTokenView {
  buyCount: number;
  sellCount: number;
  boughtUsd: number | null; // priced sums; null when NO priced legs exist
  soldUsd: number | null;
  realizedProxyUsd: number | null; // only when BOTH sides priced-known
  firstBuyTs: Date | null;
  firstSellTs: Date | null;
  lastSellTs: Date | null;
  unpricedTrades: number;
  truncated: boolean;
}

const BASE_CAVEATS = [
  'provider-claimed figures are discovery evidence only — never votes, eligibility, or local truth',
  'local view is bounded polling coverage — absence of local trades is not proof of non-participation',
  'observation-only: every discovered wallet stays observation_only'
];

const PROVIDER_WINDOW_CAVEAT =
  'birdeye top_traders covers a max 24h PRESENT window — for historical runners this is current-day activity, never the historical leaderboard';

/**
 * PURE validation rule (exported for unit pinning): compares a provider claim
 * against the local view of the same (mint, wallet).
 */
export function validateProviderClaim(input: {
  claimedRealizedPnlUsd: number | null;
  localRealizedProxyUsd: number | null;
  hasLocalTrades: boolean;
  localUnpriced: boolean;
  localTruncated: boolean;
  malformed: boolean;
  /** False when the provider's window cannot honestly be compared against
   *  the local (all-history) view — e.g. Birdeye's 24h present window vs a
   *  historical position. Magnitude/sign comparison is then SKIPPED: the
   *  claim can never be locally verified NOR labeled conflicting from an
   *  incomparable window. Defaults to true (comparable). */
  windowsComparable?: boolean;
}): { validation: TopPnlValidation; confidence: number; reasonCodes: string[] } {
  if (input.malformed) {
    return { validation: 'invalid', confidence: 5, reasonCodes: ['malformed_provider_item'] };
  }
  if (!input.hasLocalTrades) {
    return { validation: 'provider_only', confidence: 25, reasonCodes: ['no_local_trades_for_wallet_mint'] };
  }
  if (input.localTruncated || input.localUnpriced || input.localRealizedProxyUsd === null) {
    return {
      validation: 'incomplete',
      confidence: 30,
      reasonCodes: [
        input.localTruncated ? 'local_view_truncated' : 'local_valuation_incomplete'
      ]
    };
  }
  if (input.windowsComparable === false) {
    return {
      validation: 'partially_verified',
      confidence: 40,
      reasonCodes: ['provider_window_not_comparable_to_local_history']
    };
  }
  if (input.claimedRealizedPnlUsd === null) {
    // Local view is fine but the provider made no realized-PnL claim to check.
    return { validation: 'partially_verified', confidence: 45, reasonCodes: ['no_provider_realized_claim'] };
  }
  const a = input.claimedRealizedPnlUsd;
  const b = input.localRealizedProxyUsd;
  const sameSign = Math.sign(a) === Math.sign(b) || (Math.abs(a) <= 1 && Math.abs(b) <= 1);
  if (!sameSign) {
    return { validation: 'conflicting', confidence: 20, reasonCodes: ['claimed_pnl_sign_conflicts_with_local_proxy'] };
  }
  const rel = Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1);
  if (rel <= 0.5) {
    return { validation: 'locally_verified', confidence: 70, reasonCodes: ['claim_within_tolerance_of_local_proxy'] };
  }
  return {
    validation: 'partially_verified',
    confidence: 45,
    reasonCodes: ['claim_sign_matches_local_proxy_magnitude_differs']
  };
}

export interface TopPnlBatchReport {
  mintsConsidered: number;
  mintsProcessed: number;
  errors: number;
  errorReceipts: { mint: string; message: string }[];
  localRowsWritten: number;
  providerRowsWritten: number;
  byValidation: Record<string, number>;
  provider: {
    enabled: boolean;
    requestBudget: number;
    requestsUsed: number;
    mintsFetched: number;
    mintsSkippedResume: number;
    mintsEmpty: number;
    mintsErrored: number;
    /** Provider items skipped because they carry no usable wallet address —
     *  isolated per ITEM (the mint's remaining items still process). */
    malformedItemsSkipped: number;
    budgetExhausted: boolean;
  };
}

async function localViews(
  prisma: PrismaClient,
  chain: 'SOLANA' | 'BSC',
  tokenId: string,
  maxTradesPerMint: number
): Promise<{ byWallet: Map<string, LocalTokenView>; truncated: boolean }> {
  const rows = await prisma.walletTokenTrade.findMany({
    where: { tokenId, chain, action: { in: ['BUY', 'SELL'] } },
    orderBy: [{ ts: 'asc' }, { id: 'asc' }],
    take: maxTradesPerMint + 1,
    select: {
      action: true,
      amountUsd: true,
      ts: true,
      wallet: { select: { address: true } }
    }
  });
  const truncated = rows.length > maxTradesPerMint;
  const byWallet = new Map<string, LocalTokenView>();
  for (const t of rows.slice(0, maxTradesPerMint)) {
    const w = t.wallet.address;
    let v = byWallet.get(w);
    if (!v) {
      v = {
        buyCount: 0,
        sellCount: 0,
        boughtUsd: null,
        soldUsd: null,
        realizedProxyUsd: null,
        firstBuyTs: null,
        firstSellTs: null,
        lastSellTs: null,
        unpricedTrades: 0,
        truncated
      };
      byWallet.set(w, v);
    }
    const usd = Number(t.amountUsd);
    const priced = usd > 0;
    if (!priced) v.unpricedTrades += 1;
    if (t.action === 'BUY') {
      v.buyCount += 1;
      if (priced) v.boughtUsd = (v.boughtUsd ?? 0) + usd;
      if (v.firstBuyTs === null) v.firstBuyTs = t.ts;
    } else {
      v.sellCount += 1;
      if (priced) v.soldUsd = (v.soldUsd ?? 0) + usd;
      if (v.firstSellTs === null) v.firstSellTs = t.ts;
      v.lastSellTs = t.ts;
    }
  }
  for (const v of byWallet.values()) {
    // Realized proxy ONLY when every leg on both sides was priced AND at
    // least one sell exists — a buy-only (still-holding) position has NO
    // realized outcome, and treating it as (0 - cost) would fabricate a
    // realized loss from open inventory.
    if (v.unpricedTrades === 0 && v.boughtUsd !== null && v.buyCount > 0 && v.sellCount > 0) {
      v.realizedProxyUsd = (v.soldUsd ?? 0) - v.boughtUsd;
    }
  }
  return { byWallet, truncated };
}

export async function buildTokenTopPnlCandidates(
  prisma: PrismaClient,
  opts: {
    chain?: 'SOLANA' | 'BSC';
    /** Bound on runner mints processed this pass (stable mint order). */
    limit?: number;
    /** Explicit mint override (tests). */
    mints?: string[];
    /** Local candidates kept per mint (rank by realized proxy). */
    perMintLocalCap?: number;
    /** Provider items requested per mint (hard provider cap 10). */
    perMintProviderCap?: number;
    /** Bounded per-mint trade aggregation. */
    maxTradesPerMint?: number;
    /** Provider adapter (null = local-only pass). */
    provider?: TokenTopTradersProvider | null;
    /** Max provider REQUESTS this pass (resume state persists across runs). */
    requestBudget?: number;
    /** Re-fetch mints whose fetch state is provider_error (default true). */
    retryErrored?: boolean;
    now?: Date;
  } = {}
): Promise<TopPnlBatchReport> {
  const chain = opts.chain ?? 'SOLANA';
  const limit = opts.limit ?? 500;
  const perMintLocalCap = opts.perMintLocalCap ?? 10;
  const perMintProviderCap = Math.min(opts.perMintProviderCap ?? 10, 10);
  const maxTradesPerMint = opts.maxTradesPerMint ?? 5000;
  const provider = opts.provider ?? null;
  const requestBudget = opts.requestBudget ?? 400;
  const retryErrored = opts.retryErrored !== false;
  const now = opts.now ?? new Date();

  const lifecycles = await prisma.tokenLifecycle.findMany({
    where: {
      runnerClass: 'verified_above_10m',
      ...(opts.mints ? { mint: { in: opts.mints } } : {})
    },
    orderBy: { mint: 'asc' },
    take: limit,
    select: { mint: true, coverage: true }
  });

  const report: TopPnlBatchReport = {
    mintsConsidered: lifecycles.length,
    mintsProcessed: 0,
    errors: 0,
    errorReceipts: [],
    localRowsWritten: 0,
    providerRowsWritten: 0,
    byValidation: {},
    provider: {
      enabled: provider !== null,
      requestBudget,
      requestsUsed: 0,
      mintsFetched: 0,
      mintsSkippedResume: 0,
      mintsEmpty: 0,
      mintsErrored: 0,
      malformedItemsSkipped: 0,
      budgetExhausted: false
    }
  };

  for (const lc of lifecycles) {
    try {
      const token = await prisma.token.findUnique({
        where: { chain_address: { chain, address: lc.mint } },
        select: { id: true }
      });
      const { byWallet, truncated: mintTradesTruncated } = token
        ? await localViews(prisma, chain, token.id, maxTradesPerMint)
        : { byWallet: new Map<string, LocalTokenView>(), truncated: false };
      const partialLifecycle = lc.coverage !== 'covered';

      const upsertRow = async (
        walletAddress: string,
        source: 'local_reconstruction' | 'birdeye_top_traders',
        providerRank: number | null,
        item: TokenTopTrader | null,
        v: LocalTokenView | null
      ) => {
        const caveats = [...BASE_CAVEATS];
        const reasons: string[] = [];
        let validation: TopPnlValidation;
        let confidence: number;
        let coverage: 'local_full' | 'local_partial' | 'none';
        const localTruncated = (v?.truncated ?? false) || mintTradesTruncated || partialLifecycle;
        if (v) coverage = localTruncated ? 'local_partial' : 'local_full';
        else coverage = 'none';

        if (source === 'local_reconstruction') {
          // Local rows carry no external claim: they are the bounded local
          // view itself. Verified when fully priced+covered; else incomplete.
          if (v && v.realizedProxyUsd !== null && !localTruncated) {
            validation = 'locally_verified';
            confidence = 75;
            reasons.push('fully_priced_local_position');
          } else {
            validation = 'incomplete';
            confidence = 35;
            if (v && v.unpricedTrades > 0) reasons.push('unpriced_local_trades');
            else if (v && v.sellCount === 0 && v.buyCount > 0) reasons.push('position_open_no_local_sells');
            else reasons.push('bounded_local_view');
            caveats.push('local valuation/coverage incomplete — realized proxy withheld rather than fabricated');
          }
        } else {
          const malformed =
            item === null ||
            typeof item.walletAddress !== 'string' ||
            item.walletAddress.length === 0 ||
            [item.realizedPnlUsd, item.unrealizedPnlUsd, item.totalPnlUsd, item.volumeBuyUsd, item.volumeSellUsd].some(
              (n) => n !== null && n !== undefined && !Number.isFinite(n)
            );
          const verdict = validateProviderClaim({
            claimedRealizedPnlUsd: item?.realizedPnlUsd ?? null,
            localRealizedProxyUsd: v?.realizedProxyUsd ?? null,
            hasLocalTrades: v !== null,
            localUnpriced: (v?.unpricedTrades ?? 0) > 0,
            localTruncated,
            malformed,
            // Birdeye top_traders is a 24h PRESENT window — never honestly
            // comparable against the all-history local view.
            windowsComparable: false
          });
          validation = verdict.validation;
          confidence = verdict.confidence;
          reasons.push(...verdict.reasonCodes);
          caveats.push(PROVIDER_WINDOW_CAVEAT);
        }

        // Claimed ROI only when both realized PnL and cost basis are supplied.
        const claimedRoi =
          item &&
          item.realizedPnlUsd != null &&
          item.volumeBuyUsd != null &&
          item.volumeBuyUsd > 0
            ? item.realizedPnlUsd / item.volumeBuyUsd
            : null;

        const data = {
          chain,
          mint: lc.mint,
          walletAddress,
          source,
          providerRank,
          claimedRealizedPnlUsd: item?.realizedPnlUsd ?? null,
          claimedUnrealizedPnlUsd: item?.unrealizedPnlUsd ?? null,
          claimedTotalPnlUsd: item?.totalPnlUsd ?? null,
          claimedBoughtUsd: item?.volumeBuyUsd ?? null,
          claimedSoldUsd: item?.volumeSellUsd ?? null,
          claimedRemainingUsd: null,
          claimedRoi,
          claimedTradeCount: item?.tradeCount ?? null,
          providerTags: item?.tags ?? [],
          providerTimeFrame: item ? '24h' : null,
          providerJson: item ? (item.raw as Prisma.InputJsonValue) ?? Prisma.JsonNull : Prisma.JsonNull,
          localBuyCount: v?.buyCount ?? 0,
          localSellCount: v?.sellCount ?? 0,
          localBoughtUsd: v?.boughtUsd ?? null,
          localSoldUsd: v?.soldUsd ?? null,
          localRealizedProxyUsd: v?.realizedProxyUsd ?? null,
          localFirstBuyTs: v?.firstBuyTs ?? null,
          localFirstSellTs: v?.firstSellTs ?? null,
          localLastSellTs: v?.lastSellTs ?? null,
          localUnpricedTrades: v?.unpricedTrades ?? 0,
          validation,
          coverage,
          confidence,
          reasonCodes: reasons,
          receiptsJson: {
            mintCoverage: lc.coverage,
            mintTradesTruncated,
            providerWindow: item ? '24h_present_window' : null
          } as unknown as Prisma.InputJsonValue,
          caveats,
          engineVersion: TOP_PNL_ENGINE_VERSION
        };
        await prisma.tokenTopPnlCandidate.upsert({
          where: {
            chain_mint_walletAddress_source: { chain, mint: lc.mint, walletAddress, source }
          },
          create: data,
          update: data
        });
        report.byValidation[validation] = (report.byValidation[validation] ?? 0) + 1;
        if (source === 'local_reconstruction') report.localRowsWritten += 1;
        else report.providerRowsWritten += 1;
      };

      // --- local reconstruction rows (deterministic rank) -------------------
      const ranked = [...byWallet.entries()]
        .sort((a, b) => {
          const pa = a[1].realizedProxyUsd;
          const pb = b[1].realizedProxyUsd;
          if (pa !== null && pb !== null && pb !== pa) return pb - pa;
          if (pa !== null && pb === null) return -1;
          if (pa === null && pb !== null) return 1;
          return (
            (b[1].soldUsd ?? 0) - (a[1].soldUsd ?? 0) ||
            b[1].sellCount - a[1].sellCount ||
            (a[0] < b[0] ? -1 : 1)
          );
        })
        .slice(0, perMintLocalCap);
      for (let i = 0; i < ranked.length; i++) {
        await upsertRow(ranked[i][0], 'local_reconstruction', i + 1, null, ranked[i][1]);
      }

      // --- provider rows (budgeted + resumable) -----------------------------
      if (provider) {
        const state = await prisma.topPnlFetchState.findUnique({
          where: { mint_provider: { mint: lc.mint, provider: 'birdeye_top_traders' } }
        });
        const done =
          state && (state.status === 'fetched' || state.status === 'empty' || (!retryErrored && state.status === 'provider_error'));
        if (done) {
          report.provider.mintsSkippedResume += 1;
        } else if (report.provider.requestsUsed >= requestBudget) {
          report.provider.budgetExhausted = true;
        } else {
          report.provider.requestsUsed += 1;
          try {
            const items = await provider.getTopTraders(chain, lc.mint, {
              limit: perMintProviderCap,
              sortBy: 'realized_pnl',
              timeFrame: '24h'
            });
            for (let i = 0; i < items.length; i++) {
              const item = items[i];
              // Per-ITEM isolation: an item with no usable wallet address has
              // no upsert key — skip it (counted) instead of aborting the
              // mint's remaining items.
              if (typeof item.walletAddress !== 'string' || item.walletAddress.length === 0) {
                report.provider.malformedItemsSkipped += 1;
                continue;
              }
              const v = byWallet.get(item.walletAddress) ?? null;
              await upsertRow(item.walletAddress, 'birdeye_top_traders', i + 1, item, v);
            }
            await prisma.topPnlFetchState.upsert({
              where: { mint_provider: { mint: lc.mint, provider: 'birdeye_top_traders' } },
              create: {
                mint: lc.mint,
                provider: 'birdeye_top_traders',
                status: items.length > 0 ? 'fetched' : 'empty',
                itemCount: items.length,
                fetchedAt: now
              },
              update: {
                status: items.length > 0 ? 'fetched' : 'empty',
                itemCount: items.length,
                lastError: null,
                fetchedAt: now
              }
            });
            report.provider.mintsFetched += 1;
            if (items.length === 0) report.provider.mintsEmpty += 1;
          } catch (err) {
            const message = err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300);
            await prisma.topPnlFetchState.upsert({
              where: { mint_provider: { mint: lc.mint, provider: 'birdeye_top_traders' } },
              create: {
                mint: lc.mint,
                provider: 'birdeye_top_traders',
                status: 'provider_error',
                itemCount: 0,
                retryCount: 1,
                lastError: message
              },
              update: {
                status: 'provider_error',
                lastError: message,
                retryCount: { increment: 1 }
              }
            });
            report.provider.mintsErrored += 1;
          }
        }
      }
      report.mintsProcessed += 1;
    } catch (err) {
      report.errors += 1;
      if (report.errorReceipts.length < 25) {
        report.errorReceipts.push({
          mint: lc.mint,
          message: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300)
        });
      }
    }
  }
  return report;
}
