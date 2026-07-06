// FlowRadar — runCandidateValidation: the Wave 4.5 validation + promotion
// pass (Task 35, Spec §5b). Consumes Task 34's CandidateWallet rows (produced
// by runExternalWalletSourceSync) and is the ONLY writer of
// CandidateWallet.validationStatus past its initial 'pending' insert.
//
// Per candidate: assemble evidence, call @flowradar/core's evaluateCandidate
// (the ONE place the promote/reject/insufficient verdict is decided — this
// module never re-implements that logic), then apply the verdict:
//
//   - 'promote' => upsert a tracked Wallet row (isWatched=true, notes
//     'promoted from <source>'), insert a WalletStats row (source 'computed'
//     when the evidence came from local computeFifoPnl, 'provider' when it
//     came from a provider wallet-PnL capability), set
//     CandidateWallet.validationStatus='promoted' + promotedWalletId +
//     validationConfidence.
//   - 'reject' => validationStatus='rejected' + rejectionReason (the
//     evaluateCandidate reason string verbatim — already human-readable and
//     names the specific failing category, e.g. "excluded service address
//     (CEX)" or "below thresholds (pnl30d (...))").
//   - 'insufficient' => stays 'pending'. lastSeenAt is bumped and a small
//     validationAttempts counter is tracked in metadataJson (NOT a
//     max-attempts cutoff — a candidate with no local trade history today may
//     legitimately gain some the next time a wallet's activity is ingested,
//     so it is deliberately left eligible for re-validation forever; the
//     counter exists purely for observability/debugging, documented here
//     rather than enforced as a hard stop).
//
// Evidence assembly, per candidate:
//   - registryCategory: AddressRegistry lookup by (chain, walletAddress).
//   - labels: WalletClassification rows of an EXISTING Wallet at that address,
//     if one already exists (a candidate can share an address with an
//     already-known/ingested wallet — see seed.ts's ingestAllWallets, which
//     creates Wallet rows for every mock-world wallet with activity,
//     independent of whether that address is also a CandidateWallet). No
//     existing Wallet => empty labels (not an error).
//   - computedPnl: (a) provider wallet-PnL capability if the caller's
//     resolver returns one (no live implementation exists yet — this is a
//     forward-compatible hook), ELSE (b) local computeFifoPnl over that
//     address's own WalletTokenTrade rows (via the existing Wallet, if any),
//     ELSE (c) undefined => evaluateCandidate's evidence gate returns
//     'insufficient'.
//
// Per-candidate try/catch: one candidate throwing (a malformed row, a
// provider timeout) is caught, logged, and never aborts the batch — mirrors
// every other job body in this codebase (see externalWalletSource.ts's
// per-source try/catch).

import type { Prisma, PrismaClient } from '@prisma/client';
import { computeFifoPnl, evaluateCandidate } from '@flowradar/core';
import type { CandidateEvidence, Chain, ComputedPnlEvidence, RegistryCategory, Settings } from '@flowradar/core';

export interface CandidateValidationLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/** One provider-sourced wallet-PnL reading — shape a future WalletPnlProvider capability would return. */
export interface ProviderWalletPnl {
  pnl30d: number;
  realizedPnlUsd: number;
  winRate: number;
  tradeCount: number;
  avgTradeSizeUsd: number;
  /** 0-100 confidence the provider itself reports. */
  confidence: number;
}

/**
 * Resolves a provider wallet-PnL reading for (chain, walletAddress), if a
 * live/mock provider capability for it exists. Returns null/undefined, or
 * throws, to mean "no provider evidence available" — both are treated the
 * same as "fall back to local computeFifoPnl" (see runCandidateValidation's
 * per-candidate evidence assembly).
 */
export type WalletPnlProviderResolver = (
  chain: Chain,
  walletAddress: string
) => Promise<ProviderWalletPnl | null | undefined>;

export interface CandidateValidationResult {
  candidatesConsidered: number;
  promoted: number;
  rejected: number;
  stayedPending: number;
  errors: number;
  rejectionReasonCounts: Record<string, number>;
}

const MAX_BATCH_DEFAULT = 100;

export async function runCandidateValidation(
  prisma: PrismaClient,
  settings: Settings,
  resolveProviderPnl?: WalletPnlProviderResolver,
  log?: CandidateValidationLogger
): Promise<CandidateValidationResult> {
  const batchSize = settings.connectors.validationBatchSize > 0 ? settings.connectors.validationBatchSize : MAX_BATCH_DEFAULT;

  const pendingCandidates = await prisma.candidateWallet.findMany({
    where: { validationStatus: 'pending' },
    take: batchSize,
    orderBy: { firstSeenAt: 'asc' }
  });

  let promoted = 0;
  let rejected = 0;
  let stayedPending = 0;
  let errors = 0;
  const rejectionReasonCounts: Record<string, number> = {};

  if (pendingCandidates.length === 0) {
    const summary: CandidateValidationResult = {
      candidatesConsidered: 0,
      promoted: 0,
      rejected: 0,
      stayedPending: 0,
      errors: 0,
      rejectionReasonCounts
    };
    log?.info('candidateValidation cycle complete (no pending candidates)', { ...summary });
    return summary;
  }

  // Mark the whole batch 'validating' up front (Task 35 binding decision 2's
  // pending -> validating -> {promoted|rejected|pending} lifecycle) so a
  // concurrent validation pass (worker + a manual seed run) never double-picks
  // the same row.
  await prisma.candidateWallet.updateMany({
    where: { id: { in: pendingCandidates.map((c) => c.id) } },
    data: { validationStatus: 'validating' }
  });

  for (const candidate of pendingCandidates) {
    try {
      const evidence = await assembleEvidence(prisma, candidate.chain as Chain, candidate.walletAddress, resolveProviderPnl);

      const result = evaluateCandidate({
        candidate: {
          claimedPnlUsd: candidate.claimedPnlUsd !== null ? Number(candidate.claimedPnlUsd) : undefined,
          claimedWinRate: candidate.claimedWinRate ?? undefined,
          claimedTradeCount: candidate.claimedTradeCount ?? undefined,
          claimedRoi: candidate.claimedRoi ?? undefined
        },
        evidence: evidence.evidence,
        settings
      });

      if (result.verdict === 'promote') {
        const walletId = await promoteCandidate(prisma, candidate, evidence.evidenceSource);
        await prisma.candidateWallet.update({
          where: { id: candidate.id },
          data: {
            validationStatus: 'promoted',
            promotedWalletId: walletId,
            validationConfidence: result.confidence,
            rejectionReason: null
          }
        });
        promoted += 1;
      } else if (result.verdict === 'reject') {
        await prisma.candidateWallet.update({
          where: { id: candidate.id },
          data: {
            validationStatus: 'rejected',
            rejectionReason: result.reason,
            validationConfidence: result.confidence
          }
        });
        rejected += 1;
        const reasonCategory = categorizeRejectionReason(result.reason);
        rejectionReasonCounts[reasonCategory] = (rejectionReasonCounts[reasonCategory] ?? 0) + 1;
      } else {
        // 'insufficient' — stays pending, bump lastSeenAt + attempt counter
        // (observability only, no max-attempts cutoff — see file header).
        const priorMeta = (candidate.metadataJson as Record<string, unknown> | null) ?? {};
        const priorAttempts = typeof priorMeta.validationAttempts === 'number' ? priorMeta.validationAttempts : 0;
        await prisma.candidateWallet.update({
          where: { id: candidate.id },
          data: {
            validationStatus: 'pending',
            lastSeenAt: new Date(),
            metadataJson: {
              ...priorMeta,
              validationAttempts: priorAttempts + 1,
              lastInsufficientReason: result.reason
            } as Prisma.InputJsonValue
          }
        });
        stayedPending += 1;
      }
    } catch (err) {
      errors += 1;
      const message = err instanceof Error ? err.message : String(err);
      // Reset to 'pending' so a transient failure doesn't strand the
      // candidate in 'validating' forever (never picked up again by the
      // `validationStatus: 'pending'` query above).
      await prisma.candidateWallet
        .update({ where: { id: candidate.id }, data: { validationStatus: 'pending' } })
        .catch(() => undefined);
      log?.error('candidateValidation: failed to validate candidate', {
        candidateId: candidate.id,
        walletAddress: candidate.walletAddress,
        error: message
      });
    }
  }

  const summary: CandidateValidationResult = {
    candidatesConsidered: pendingCandidates.length,
    promoted,
    rejected,
    stayedPending,
    errors,
    rejectionReasonCounts
  };
  log?.info('candidateValidation cycle complete', { ...summary });
  return summary;
}

function categorizeRejectionReason(reason: string): string {
  if (reason.startsWith('excluded service address')) return 'registry_service';
  if (reason.startsWith('bot/sniper-dominant')) return 'bot_or_sniper';
  if (reason.startsWith('below thresholds')) return 'below_thresholds';
  return 'other';
}

interface EvidenceAssembly {
  evidence: CandidateEvidence;
  /** 'provider' when computedPnl came from resolveProviderPnl; 'computed' when it came from local FIFO; undefined when there is no computedPnl at all. */
  evidenceSource?: 'provider' | 'computed';
}

async function assembleEvidence(
  prisma: PrismaClient,
  chain: Chain,
  walletAddress: string,
  resolveProviderPnl?: WalletPnlProviderResolver
): Promise<EvidenceAssembly> {
  const registryRow = await prisma.addressRegistry.findUnique({
    where: { chain_address: { chain, address: walletAddress } },
    select: { category: true }
  });
  const registryCategory = (registryRow?.category as RegistryCategory | undefined) ?? null;

  const existingWallet = await prisma.wallet.findUnique({
    where: { address_chain: { address: walletAddress, chain } },
    select: { id: true }
  });

  let labels: string[] = [];
  if (existingWallet) {
    const classificationRows = await prisma.walletClassification.findMany({
      where: { walletId: existingWallet.id },
      select: { label: true }
    });
    labels = classificationRows.map((r) => r.label);
  }

  // (a) provider wallet-PnL capability, if resolvable.
  let computedPnl: ComputedPnlEvidence | undefined;
  let evidenceSource: 'provider' | 'computed' | undefined;

  try {
    const providerPnl = await resolveProviderPnl?.(chain, walletAddress);
    if (providerPnl) {
      computedPnl = { ...providerPnl };
      evidenceSource = 'provider';
    }
  } catch {
    // Provider evidence unavailable — fall through to local computation.
  }

  // (b) local computeFifoPnl over this address's own WalletTokenTrade rows,
  // if it has any AND a provider reading wasn't already found.
  if (!computedPnl && existingWallet) {
    computedPnl = await computeLocalPnlEvidence(prisma, existingWallet.id);
    if (computedPnl) evidenceSource = 'computed';
  }

  return {
    evidence: { computedPnl, registryCategory, labels },
    evidenceSource
  };
}

/**
 * Local computeFifoPnl evidence for one wallet, aggregated across every
 * token it has traded — same aggregation shape as walletStatsRefresh.ts's
 * refreshOneWallet (pnl30d = realized + unrealized, trade-weighted winRate
 * across the combined sell ledger, MIN confidence across tokens), reused
 * here rather than re-deriving a different aggregation convention. Returns
 * undefined when the wallet has zero BUY/SELL trades (nothing to compute).
 */
async function computeLocalPnlEvidence(prisma: PrismaClient, walletId: string): Promise<ComputedPnlEvidence | undefined> {
  const tradeRows = await prisma.walletTokenTrade.findMany({
    where: { walletId, action: { in: ['BUY', 'SELL'] } },
    orderBy: { ts: 'asc' },
    select: { tokenId: true, action: true, amountToken: true, amountUsd: true, priceUsd: true, ts: true }
  });

  if (tradeRows.length === 0) return undefined;

  const tokenIds = [...new Set(tradeRows.map((t) => t.tokenId))];
  const snapshotRows = await prisma.tokenMarketSnapshot.findMany({
    where: { tokenId: { in: tokenIds } },
    orderBy: { ts: 'desc' },
    select: { tokenId: true, priceUsd: true }
  });
  const latestPriceByToken = new Map<string, number>();
  for (const row of snapshotRows) {
    if (!latestPriceByToken.has(row.tokenId)) {
      latestPriceByToken.set(row.tokenId, Number(row.priceUsd));
    }
  }

  const tradesByToken = new Map<string, typeof tradeRows>();
  for (const row of tradeRows) {
    const list = tradesByToken.get(row.tokenId) ?? [];
    list.push(row);
    tradesByToken.set(row.tokenId, list);
  }

  let realizedPnlUsd = 0;
  let unrealizedPnlUsd = 0;
  let tradeCount = 0;
  let totalAmountUsd = 0;
  let totalSells = 0;
  let winRateWeightedSum = 0;
  const confidences: number[] = [];

  for (const [tokenId, rows] of tradesByToken) {
    const fifoRows = rows.map((r) => ({
      action: r.action as 'BUY' | 'SELL',
      amountToken: Number(r.amountToken),
      amountUsd: Number(r.amountUsd),
      ts: r.ts
    }));
    const lastTradePrice = rows.length > 0 ? Number(rows[rows.length - 1]!.priceUsd) : null;
    const currentPriceUsd = latestPriceByToken.get(tokenId) ?? lastTradePrice ?? null;

    const result = computeFifoPnl(fifoRows, currentPriceUsd);
    const sellCount = fifoRows.filter((r) => r.action === 'SELL').length;

    realizedPnlUsd += result.realizedUsd;
    unrealizedPnlUsd += result.unrealizedUsd ?? 0;
    tradeCount += result.tradeCount;
    totalAmountUsd += rows.reduce((sum, r) => sum + Number(r.amountUsd), 0);
    totalSells += sellCount;
    winRateWeightedSum += result.winRate * sellCount;
    confidences.push(result.confidence);
  }

  const pnl30d = realizedPnlUsd + unrealizedPnlUsd;
  const winRate = totalSells > 0 ? winRateWeightedSum / totalSells : 0;
  const avgTradeSizeUsd = tradeCount > 0 ? totalAmountUsd / tradeCount : 0;
  const confidence = confidences.length > 0 ? Math.min(...confidences) : 10;

  return { pnl30d, realizedPnlUsd, winRate, tradeCount, avgTradeSizeUsd, confidence };
}

/**
 * Promotes a candidate to a real, tracked Wallet: upsert (isWatched=true,
 * notes 'promoted from <source>'), insert a fresh WalletStats row sourced
 * from whichever evidence path produced the passing computedPnl. Returns the
 * Wallet id for CandidateWallet.promotedWalletId.
 *
 * Anti-clobber guard (same contract as walletStatsRefresh.ts's own "never
 * overwrite a CSV-authoritative wallet's latest stats row" rule — see that
 * file's header): if this address ALREADY has a Wallet row whose latest
 * WalletStats row is source='csv' (a human operator vetted those figures),
 * promotion still flips isWatched=true (the candidate genuinely cleared
 * validation and belongs in the tracked set), but SKIPS inserting a new
 * WalletStats row — the CSV row remains the latest/authoritative figure for
 * that wallet. Without this guard, promoting a candidate whose address
 * happens to coincide with an existing CSV-imported wallet would silently
 * demote that wallet's Layer-1-authoritative CSV stats to no-longer-latest.
 */
async function promoteCandidate(
  prisma: PrismaClient,
  candidate: { walletAddress: string; chain: Chain; source: string },
  evidenceSource?: 'provider' | 'computed'
): Promise<string> {
  const now = new Date();

  const wallet = await prisma.wallet.upsert({
    where: { address_chain: { address: candidate.walletAddress, chain: candidate.chain } },
    create: {
      address: candidate.walletAddress,
      chain: candidate.chain,
      firstSeenAt: now,
      lastActiveAt: now,
      isWatched: true,
      notes: `promoted from ${candidate.source}`
    },
    update: {
      isWatched: true,
      notes: `promoted from ${candidate.source}`
    },
    select: { id: true }
  });

  const latestStats = await prisma.walletStats.findFirst({
    where: { walletId: wallet.id },
    orderBy: { computedAt: 'desc' },
    select: { source: true }
  });
  if (latestStats?.source === 'csv') {
    return wallet.id; // CSV is Layer-1 authoritative — never write a new stats row over it
  }

  // Re-derive the same evidence used for the verdict so the persisted
  // WalletStats row matches what was actually evaluated (rather than
  // re-querying computeFifoPnl a second time with different inputs — cheap
  // enough at this scale, and keeps promoteCandidate a pure "given a verdict,
  // persist it" step without threading the full ComputedPnlEvidence object
  // through an extra parameter).
  const computedPnl = await computeLocalPnlEvidence(prisma, wallet.id);

  await prisma.walletStats.create({
    data: {
      walletId: wallet.id,
      window: '30d',
      pnlUsd: computedPnl?.pnl30d ?? 0,
      realizedPnlUsd: computedPnl?.realizedPnlUsd ?? 0,
      unrealizedPnlUsd: computedPnl ? computedPnl.pnl30d - computedPnl.realizedPnlUsd : 0,
      winRate: computedPnl?.winRate ?? 0,
      tradeCount: computedPnl?.tradeCount ?? 0,
      avgTradeSizeUsd: computedPnl?.avgTradeSizeUsd ?? 0,
      walletScore: 0,
      scoreComponents: { source: 'candidate_promotion', evidenceSource: evidenceSource ?? 'computed', note: 'promoted via Task 35 candidate validation pipeline' },
      pnlConfidence: computedPnl?.confidence ?? 20,
      source: evidenceSource === 'provider' ? 'provider' : 'computed',
      computedAt: now
    }
  });

  return wallet.id;
}
