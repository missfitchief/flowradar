// FlowRadar — post-entry behavior builder (dormancy Task 10 DB).
//
// For each persisted WalletBehaviorProfile token entry, classifies what the
// wallet did AFTER the entry via the PURE @flowradar/core post-entry
// classifier: existing TokenPositionSummary facts + receipts-engine burst
// evidence + token-scoped outbound transfers labeled by destination evidence
// (probable/strong relationship => linked; registry/degree => service;
// otherwise unknown — a transfer is NEVER a sale).
//
// Bounded + stable-ordered; idempotent (chain, wallet, token) upserts;
// per-wallet error receipts. SHADOW-ONLY writes to post_entry_behaviors.

import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { classifyPostEntryBehavior, deriveBehaviorReceipts } from '@flowradar/core';
import type { PostEntryConfig, ReceiptTradeInput, TokenPositionSummary } from '@flowradar/core';
import { lookupServiceCounterparties, toErrorReceipt, ERROR_RECEIPTS_MAX } from './../dormancy/activity';
import type { WalletErrorReceipt } from './../dormancy/activity';
import { relationshipTierOfConfidence } from './../dormancy/entityDormancy';

export interface PostEntryBatchReport {
  walletsConsidered: number;
  walletsProcessed: number;
  errors: number;
  errorReceipts: WalletErrorReceipt[];
  entriesConsidered: number;
  rowsWritten: number;
  byPrimaryClass: Record<string, number>;
  walletsWithTruncation: number;
}

export async function buildPostEntryBehaviors(
  prisma: PrismaClient,
  opts: {
    chain?: 'SOLANA' | 'BSC';
    walletAddresses?: string[];
    limit?: number;
    /** Cap on token entries per wallet (earliest first, reported). */
    maxEntriesPerWallet?: number;
    /** Cap on PER-TOKEN trades fed to the receipts engine / first-sell scan. */
    maxTradesPerToken?: number;
    /** Cap on outbound token transfers examined per (wallet, token). */
    maxTransfersPerToken?: number;
    config?: Partial<PostEntryConfig>;
    now?: Date;
  } = {}
): Promise<PostEntryBatchReport> {
  const chain = opts.chain ?? 'SOLANA';
  const limit = opts.limit ?? 100;
  const maxEntries = opts.maxEntriesPerWallet ?? 200;
  const maxTradesPerToken = opts.maxTradesPerToken ?? 1000;
  const maxTransfersPerToken = opts.maxTransfersPerToken ?? 50;
  const now = opts.now ?? new Date();

  const profiles = await prisma.walletBehaviorProfile.findMany({
    where: {
      chain,
      ...(opts.walletAddresses ? { walletAddress: { in: opts.walletAddresses } } : {})
    },
    orderBy: { walletAddress: 'asc' },
    take: limit,
    select: { walletAddress: true, profileJson: true }
  });

  const report: PostEntryBatchReport = {
    walletsConsidered: profiles.length,
    walletsProcessed: 0,
    errors: 0,
    errorReceipts: [],
    entriesConsidered: 0,
    rowsWritten: 0,
    byPrimaryClass: {},
    walletsWithTruncation: 0
  };

  for (const p of profiles) {
    try {
      const profile = p.profileJson as unknown as {
        localViewTruncated?: boolean;
        local?: { tokenPositions?: TokenPositionSummary[] };
      };
      const positions = (profile.local?.tokenPositions ?? []).filter((tp) => tp.firstBuyTs !== null);
      positions.sort((a, b) => ((a.firstBuyTs as string) < (b.firstBuyTs as string) ? -1 : 1));
      const kept = positions.slice(0, maxEntries);
      if (kept.length === 0) {
        report.walletsProcessed += 1;
        continue;
      }

      const wallet = await prisma.wallet.findUnique({
        where: { address_chain: { address: p.walletAddress, chain } },
        select: { id: true }
      });

      // Token-id resolution for the kept positions (one query).
      const tokenRows = await prisma.token.findMany({
        where: { chain, address: { in: kept.map((tp) => tp.tokenAddress) } },
        select: { id: true, address: true }
      });
      const tokenIdByAddress = new Map(tokenRows.map((t) => [t.address, t.id]));

      const profileTruncated = profile.localViewTruncated === true;
      let anyTokenTruncated = false;

      // PER-TOKEN, ENTRY-FORWARD trade window (Codex Batch-B rounds 1-2): a
      // wallet-wide cap could let unrelated-token volume displace evidence,
      // and a query without the entry anchor would let PRE-entry sells (from
      // previously received inventory) contaminate exit metrics — both are
      // filtered IN-QUERY before the cap.
      interface EntryForwardFacts {
        trades: ReceiptTradeInput[];
        buyCount: number;
        sellCount: number;
        buyUsd: number;
        sellUsd: number;
        firstSellTs: Date | null;
        lastSellTs: Date | null;
        timeToFirstSellSec: number | null;
        exitRatio: number | null;
        stillHolding: boolean;
        fullExitSec: number | null;
        truncated: boolean;
      }
      const entryForwardFacts = async (tokenAddress: string, entryTs: Date): Promise<EntryForwardFacts> => {
        const empty: EntryForwardFacts = {
          trades: [],
          buyCount: 0,
          sellCount: 0,
          buyUsd: 0,
          sellUsd: 0,
          firstSellTs: null,
          lastSellTs: null,
          timeToFirstSellSec: null,
          exitRatio: null,
          stillHolding: true,
          fullExitSec: null,
          truncated: false
        };
        const tokenId = tokenIdByAddress.get(tokenAddress);
        if (!wallet || !tokenId) return empty;
        const rows = await prisma.walletTokenTrade.findMany({
          where: {
            walletId: wallet.id,
            tokenId,
            chain,
            action: { in: ['BUY', 'SELL'] },
            ts: { gte: entryTs }
          },
          orderBy: [{ ts: 'asc' }, { id: 'asc' }],
          take: maxTradesPerToken + 1,
          select: {
            action: true,
            amountUsd: true,
            ts: true,
            blockOrSlot: true,
            txHash: true,
            marketCapAtTrade: true
          }
        });
        const truncated = rows.length > maxTradesPerToken;
        const capped = rows.slice(0, maxTradesPerToken);
        const facts: EntryForwardFacts = { ...empty, truncated };
        // Legacy 0-for-unpriced: non-positive amounts contribute NOTHING to
        // USD sums (never fabricated as $0) — value-based metrics stay null
        // when the entry cost is unknown.
        let cumulativeSellUsd = 0;
        for (const t of capped) {
          const usd = Number(t.amountUsd);
          if (t.action === 'BUY') {
            facts.buyCount += 1;
            if (usd > 0) facts.buyUsd += usd;
          } else {
            facts.sellCount += 1;
            if (usd > 0) facts.sellUsd += usd;
            if (facts.firstSellTs === null) {
              facts.firstSellTs = t.ts;
              facts.timeToFirstSellSec = Math.round((t.ts.getTime() - entryTs.getTime()) / 1000);
            }
            facts.lastSellTs = t.ts;
            if (facts.buyUsd > 0 && facts.fullExitSec === null) {
              cumulativeSellUsd += usd > 0 ? usd : 0;
              if (cumulativeSellUsd >= 0.95 * facts.buyUsd) {
                facts.fullExitSec = Math.round((t.ts.getTime() - entryTs.getTime()) / 1000);
              }
            }
          }
        }
        facts.stillHolding = facts.sellCount === 0;
        facts.exitRatio = facts.buyUsd > 0 ? facts.sellUsd / facts.buyUsd : null;
        facts.trades = capped.map((t) => ({
          walletAddress: p.walletAddress,
          tokenAddress,
          action: t.action as 'BUY' | 'SELL',
          amountUsd: Number(t.amountUsd),
          ts: t.ts,
          blockOrSlot: t.blockOrSlot,
          txHash: t.txHash,
          marketCapAtTrade: t.marketCapAtTrade === null ? null : Number(t.marketCapAtTrade)
        }));
        return facts;
      };

      // Destination-label caches (per wallet).
      const serviceCache = new Map<string, string | null>();
      const linkedCache = new Map<string, boolean>();
      const labelDestination = async (dest: string): Promise<'linked' | 'service' | 'unknown'> => {
        if (!serviceCache.has(dest)) {
          const flags = await lookupServiceCounterparties(prisma, chain, [dest]);
          serviceCache.set(dest, flags.get(dest) ?? null);
        }
        if (serviceCache.get(dest) !== null) return 'service';
        if (!linkedCache.has(dest)) {
          let linked = false;
          if (wallet) {
            const destWallet = await prisma.wallet.findUnique({
              where: { address_chain: { address: dest, chain } },
              select: { id: true }
            });
            if (destWallet) {
              const rel = await prisma.walletRelationship.findFirst({
                where: {
                  OR: [
                    { walletAId: wallet.id, walletBId: destWallet.id },
                    { walletAId: destWallet.id, walletBId: wallet.id }
                  ]
                },
                orderBy: [{ confidence: 'desc' }, { id: 'asc' }],
                select: { confidence: true }
              });
              linked = rel !== null && relationshipTierOfConfidence(rel.confidence) !== 'possible';
            }
          }
          linkedCache.set(dest, linked);
        }
        return linkedCache.get(dest) ? 'linked' : 'unknown';
      };

      for (const pos of kept) {
        const entryTs = new Date(pos.firstBuyTs as string);
        if (Number.isNaN(entryTs.getTime())) continue;
        report.entriesConsidered += 1;

        // Entry-forward facts + receipts-engine burst evidence over THIS
        // token's post-entry trades only (immune to unrelated-token
        // displacement AND to pre-entry received-inventory sales).
        const tt = await entryForwardFacts(pos.tokenAddress, entryTs);
        if (tt.truncated) anyTokenTruncated = true;
        let burstExitReceipt = false;
        let receiptsTruncation: unknown = null;
        if (tt.trades.length > 0) {
          const receiptsResult = deriveBehaviorReceipts({ trades: tt.trades, transfers: [], now });
          receiptsTruncation = receiptsResult.inputTruncation;
          burstExitReceipt = receiptsResult.receipts.some(
            (r) =>
              r.classification === 'single_burst_exit' &&
              r.wallets.includes(p.walletAddress) &&
              r.exampleTokens.includes(pos.tokenAddress)
          );
        }

        // Token-scoped outbound transfers at/after entry (bounded, stable).
        // Self-transfers are excluded IN-QUERY so they can never crowd the cap.
        const outbound = await prisma.moneyFlowEdge.findMany({
          where: {
            sourceAddress: p.walletAddress,
            sourceChain: chain,
            destinationAddress: { not: p.walletAddress },
            assetMint: pos.tokenAddress,
            ts: { gte: entryTs }
          },
          orderBy: [{ ts: 'asc' }, { id: 'asc' }],
          take: maxTransfersPerToken + 1,
          select: { destinationAddress: true }
        });
        const transfersTruncated = outbound.length > maxTransfersPerToken;
        let toLinked = 0;
        let toService = 0;
        let toUnknown = 0;
        for (const e of outbound.slice(0, maxTransfersPerToken)) {
          const label = await labelDestination(e.destinationAddress);
          if (label === 'linked') toLinked += 1;
          else if (label === 'service') toService += 1;
          else toUnknown += 1;
        }

        const localViewTruncated = profileTruncated || tt.truncated;
        // ENTRY-FORWARD metrics only (derived above from ts >= entry trades) —
        // token-wide profile aggregates could carry pre-entry sells from
        // previously received inventory and are used ONLY for the entry
        // anchor itself.
        const decision = classifyPostEntryBehavior(
          {
            position: {
              buyCount: tt.buyCount,
              sellCount: tt.sellCount,
              buyUsd: tt.buyUsd,
              sellUsd: tt.sellUsd,
              firstBuyTs: pos.firstBuyTs,
              lastSellTs: tt.lastSellTs ? tt.lastSellTs.toISOString() : null,
              timeToFirstSellSec: tt.timeToFirstSellSec,
              exitRatio: tt.exitRatio,
              stillHolding: tt.stillHolding,
              fullExitSec: tt.fullExitSec
            },
            firstSellTs: tt.firstSellTs ? tt.firstSellTs.toISOString() : null,
            outboundTransfers: {
              total: toLinked + toService + toUnknown,
              toLinked,
              toService,
              toUnknown
            },
            burstExitReceipt,
            localViewTruncated: localViewTruncated || transfersTruncated,
            now
          },
          opts.config
        );

        const data = {
          chain,
          walletAddress: p.walletAddress,
          tokenAddress: pos.tokenAddress,
          entryTs,
          primaryClass: decision.primaryClass,
          labels: decision.labels,
          buyCount: tt.buyCount,
          sellCount: tt.sellCount,
          exitRatio: tt.exitRatio,
          timeToFirstSellSec: tt.timeToFirstSellSec,
          fullExitSec: tt.fullExitSec,
          outboundTokenTransfers: toLinked + toService + toUnknown,
          outboundToLinked: toLinked,
          outboundToService: toService,
          outboundUnknown: toUnknown,
          confidence: decision.confidence,
          dataComplete: !localViewTruncated && !transfersTruncated,
          reasonCodes: decision.reasonCodes,
          receiptsJson: {
            burstExitReceipt,
            transfersTruncated,
            tokenTradesTruncated: tt.truncated,
            receiptsInputTruncation: receiptsTruncation
          } as unknown as Prisma.InputJsonValue,
          caveats: decision.caveats,
          engineVersion: decision.engineVersion
        };
        await prisma.postEntryBehavior.upsert({
          where: {
            chain_walletAddress_tokenAddress: {
              chain,
              walletAddress: p.walletAddress,
              tokenAddress: pos.tokenAddress
            }
          },
          create: data,
          update: data
        });
        report.rowsWritten += 1;
        report.byPrimaryClass[decision.primaryClass] =
          (report.byPrimaryClass[decision.primaryClass] ?? 0) + 1;
      }
      if (profileTruncated || anyTokenTruncated) report.walletsWithTruncation += 1;
      report.walletsProcessed += 1;
    } catch (err) {
      report.errors += 1;
      if (report.errorReceipts.length < ERROR_RECEIPTS_MAX) {
        report.errorReceipts.push(toErrorReceipt(p.walletAddress, err));
      }
    }
  }
  return report;
}
