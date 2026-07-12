// FlowRadar — address-dormancy observation builder (dormancy Task 7 DB).
//
// For each persisted WalletBehaviorProfile in the cohort, emits ONE
// address_dormancy_observations row per qualifying token entry (a
// tokenPosition with a locally observed first BUY), assessed by the PURE
// @flowradar/core dormancy engine at that entry's timestamp.
//
// Honesty/safety rules:
//   - MEANINGFUL events only feed the windows AND the coverage anchor: dust/
//     spam/service/self/unknown-value/unknown-counterparty rows can neither
//     RESET dormancy nor ESTABLISH it (a spam-only history proves nothing —
//     such wallets stay 'unknown'). The earliest RAW observation is kept as
//     a receipt only.
//   - The dormancy context is derived from ONE in-memory classification pass
//     over the raw rows (classifyWalletActivity persist:false) — stale or
//     orphaned classification rows and count-races can never inject or hide
//     events. Persisted Task 6 rows remain the audit trail (written by the
//     Task 6 pass, or ensured here once when absent).
//   - Truncated fetches flag meaningfulEventsComplete=false, which the pure
//     engine degrades to 'apparently_dormant_incomplete_history' — a bounded
//     pass can never mint a covered-dormant claim.
//   - Freshness evidence = earliest MEANINGFUL inbound funding only.
//   - Idempotent: (chain, wallet, eventKind, anchorKey) unique upserts.
//   - Bounded + one wallet's error never fails the batch.
//   - SHADOW-ONLY: writes address_dormancy_observations (and, when ensuring
//     Task 6 coverage, wallet_activity_classifications) — nothing else.

import type { PrismaClient, Prisma } from '@prisma/client';
import { assessAddressDormancy, MEANINGFUL_ACTIVITY_RULES_VERSION } from '@flowradar/core';
import type { DormancyConfig, DormancyResult } from '@flowradar/core';
import { classifyWalletActivity, toErrorReceipt, ERROR_RECEIPTS_MAX } from './activity';
import type { WalletErrorReceipt } from './activity';

export interface AddressDormancyBatchReport {
  walletsConsidered: number;
  walletsProcessed: number;
  errors: number;
  /** First ERROR_RECEIPTS_MAX per-wallet failures (receipted, never silent). */
  errorReceipts: WalletErrorReceipt[];
  entriesConsidered: number;
  entriesSkippedByCap: number;
  observationsWritten: number;
  byOverallClass: Record<string, number>;
  /** Wallets whose classification pass hit a fetch bound (honesty-degraded). */
  walletsIncompleteClassification: number;
}

interface TokenPositionLite {
  tokenAddress: string;
  firstBuyTs: string | null;
}

/** Wallet-level context reused across that wallet's entries. */
export interface WalletDormancyContext {
  /** Earliest MEANINGFUL observed event — the coverage anchor. */
  coverageStart: Date | null;
  /** Earliest MEANINGFUL inbound funding — the freshness evidence. */
  firstInboundFundingTs: Date | null;
  meaningfulEvents: { ts: Date }[];
  meaningfulEventsComplete: boolean;
  /** Earliest raw observation of ANY class (receipt only, never an anchor). */
  earliestObservedTs: Date | null;
  /** Raw class tallies from the classification pass (receipt). */
  byClass: Record<string, number>;
}

/**
 * Builds the dormancy inputs for one wallet from a single in-memory
 * classification pass over its raw local rows. Exported for the Task 8
 * builder, which needs the same view of LINKED wallets.
 *
 * When the wallet has raw activity but zero persisted Task 6 rows and
 * ensureClassifications is not disabled, the pass also persists the audit
 * rows (idempotent upserts).
 */
export async function loadWalletDormancyContext(
  prisma: PrismaClient,
  target: { chain: 'SOLANA' | 'BSC'; address: string },
  opts: { ensureClassifications?: boolean; maxTrades?: number; maxEdges?: number } = {}
): Promise<WalletDormancyContext> {
  const { chain, address } = target;
  // Ensure the persisted audit rows exist AND are current-ruleVersion: rows
  // written under an older rule set are stale (the v1->v2 contract change
  // reclassified trade-table transfer rows and 0-for-unpriced amounts) and
  // are re-persisted here. The dormancy context itself is always derived
  // in-memory from the raw rows, so stale/orphaned DB rows can never leak in.
  const [existing, current] = await Promise.all([
    prisma.walletActivityClassification.count({ where: { chain, walletAddress: address } }),
    prisma.walletActivityClassification.count({
      where: { chain, walletAddress: address, ruleVersion: MEANINGFUL_ACTIVITY_RULES_VERSION }
    })
  ]);
  const persist = opts.ensureClassifications !== false && (existing === 0 || current < existing);
  // A persisting pass also purges stale audit rows it did not re-persist
  // (older rule versions, orphaned source keys) — see classifyWalletActivity.
  const r = await classifyWalletActivity(prisma, target, {
    maxTrades: opts.maxTrades,
    maxEdges: opts.maxEdges,
    persist
  });
  return {
    coverageStart: r.meaningfulEventTs[0] ?? null,
    firstInboundFundingTs: r.earliestMeaningfulInboundTs,
    meaningfulEvents: r.meaningfulEventTs.map((ts) => ({ ts })),
    meaningfulEventsComplete: !r.tradesTruncated && !r.transfersTruncated,
    earliestObservedTs: r.earliestObservedTs,
    byClass: r.byClass
  };
}

/** Assess one anchor for a wallet whose context is already loaded (pure call). */
export function assessFromContext(
  ctx: WalletDormancyContext,
  eventTs: Date,
  config?: Partial<DormancyConfig>
): DormancyResult {
  return assessAddressDormancy({
    eventTs,
    meaningfulEvents: ctx.meaningfulEvents,
    coverageStart: ctx.coverageStart,
    firstInboundFundingTs: ctx.firstInboundFundingTs,
    meaningfulEventsComplete: ctx.meaningfulEventsComplete,
    config
  });
}

export async function buildAddressDormancyObservations(
  prisma: PrismaClient,
  opts: {
    chain?: 'SOLANA' | 'BSC';
    /** Explicit cohort override; default = wallet_behavior_profiles wallets. */
    walletAddresses?: string[];
    limit?: number;
    /** Cap on token entries per wallet (deterministic: earliest first). */
    maxEntriesPerWallet?: number;
    maxTrades?: number;
    maxEdges?: number;
    ensureClassifications?: boolean;
    config?: Partial<DormancyConfig>;
  } = {}
): Promise<AddressDormancyBatchReport> {
  const chain = opts.chain ?? 'SOLANA';
  const limit = opts.limit ?? 100;
  const maxEntries = opts.maxEntriesPerWallet ?? 200;

  const profiles = await prisma.walletBehaviorProfile.findMany({
    where: {
      chain,
      ...(opts.walletAddresses ? { walletAddress: { in: opts.walletAddresses } } : {})
    },
    orderBy: { walletAddress: 'asc' },
    take: limit,
    select: { walletAddress: true, profileJson: true }
  });

  const report: AddressDormancyBatchReport = {
    walletsConsidered: profiles.length,
    walletsProcessed: 0,
    errors: 0,
    errorReceipts: [],
    entriesConsidered: 0,
    entriesSkippedByCap: 0,
    observationsWritten: 0,
    byOverallClass: {},
    walletsIncompleteClassification: 0
  };

  for (const p of profiles) {
    try {
      const profile = p.profileJson as unknown as { local?: { tokenPositions?: TokenPositionLite[] } };
      const positions = (profile.local?.tokenPositions ?? []).filter((tp) => tp.firstBuyTs !== null);
      // Deterministic: earliest entries first; cap is reported, never silent.
      positions.sort((a, b) => ((a.firstBuyTs as string) < (b.firstBuyTs as string) ? -1 : 1));
      const kept = positions.slice(0, maxEntries);
      report.entriesSkippedByCap += positions.length - kept.length;
      if (kept.length === 0) {
        report.walletsProcessed += 1;
        continue;
      }

      const ctx = await loadWalletDormancyContext(
        prisma,
        { chain, address: p.walletAddress },
        {
          ensureClassifications: opts.ensureClassifications,
          maxTrades: opts.maxTrades,
          maxEdges: opts.maxEdges
        }
      );
      if (!ctx.meaningfulEventsComplete) report.walletsIncompleteClassification += 1;

      for (const pos of kept) {
        const eventTs = new Date(pos.firstBuyTs as string);
        if (Number.isNaN(eventTs.getTime())) continue;
        report.entriesConsidered += 1;
        const result = assessFromContext(ctx, eventTs, opts.config);
        const data = {
          chain,
          walletAddress: p.walletAddress,
          eventKind: 'token_entry',
          anchorKey: pos.tokenAddress,
          eventTs,
          overallClass: result.overallClass,
          maxCoveredDormantDays: result.maxCoveredDormantDays,
          coverageStartTs: ctx.coverageStart,
          meaningfulEventCount: result.receipts.preEventMeaningfulCount,
          windowsJson: result.windows as unknown as Prisma.InputJsonValue,
          receiptsJson: {
            ...result.receipts,
            coverageBasis: 'earliest_meaningful_event',
            earliestObservedTs: ctx.earliestObservedTs ? ctx.earliestObservedTs.toISOString() : null,
            classificationByClass: ctx.byClass
          } as unknown as Prisma.InputJsonValue,
          caveats: result.caveats,
          engineVersion: result.engineVersion
        };
        await prisma.addressDormancyObservation.upsert({
          where: {
            chain_walletAddress_eventKind_anchorKey: {
              chain,
              walletAddress: p.walletAddress,
              eventKind: 'token_entry',
              anchorKey: pos.tokenAddress
            }
          },
          create: data,
          update: data
        });
        report.observationsWritten += 1;
        report.byOverallClass[result.overallClass] = (report.byOverallClass[result.overallClass] ?? 0) + 1;
      }
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
