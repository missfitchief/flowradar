// FlowRadar — behavior-reconstruction DB driver (directive Task 3 + Task 4
// persistence).
//
// Fetches one wallet's LOCAL truth (WalletTokenTrade rows, money-flow edges)
// and PROVIDER claims (GmgnObservation activity, ObservationProviderSnapshot
// stats), feeds the PURE @flowradar/core reconstruction + hold/dump
// classifier, and upserts one WalletBehaviorProfile row per (chain, wallet).
//
// SHADOW-ONLY: writes only wallet_behavior_profiles. Never touches wallet
// status, WalletStats, scores, signals, or subscriptions. Provider claims
// enter the profile ONLY under provider_claimed provenance (the pure engine
// enforces the separation; this driver just routes rows).

import type { PrismaClient, Prisma } from '@prisma/client';
import {
  reconstructBehaviorProfile,
  classifyHoldBehavior
} from '@flowradar/core';
import type {
  BehaviorInputs,
  BehaviorProfile,
  HoldClassifierResult,
  LocalTradeInput,
  ProviderActivityInput,
  ProviderStatsInput,
  FundingEdgeInput
} from '@flowradar/core';

export interface ReconstructOptions {
  now?: Date;
  /** Cap on local trades fetched per wallet (most recent first). */
  maxTrades?: number;
  /** Cap on funding edges fetched per wallet (largest USD first). */
  maxEdges?: number;
}

export interface ReconstructionOutcome {
  profile: BehaviorProfile;
  classification: HoldClassifierResult;
}

export async function reconstructWalletBehavior(
  prisma: PrismaClient,
  target: { chain: 'SOLANA' | 'BSC'; address: string },
  opts: ReconstructOptions = {}
): Promise<ReconstructionOutcome> {
  const now = opts.now ?? new Date();
  const maxTrades = opts.maxTrades ?? 5000;
  const maxEdges = opts.maxEdges ?? 1000;

  // LOCAL truth — only exists when the wallet was locally materialized.
  const wallet = await prisma.wallet.findUnique({
    where: { address_chain: { address: target.address, chain: target.chain } },
    select: { id: true }
  });

  let localTrades: LocalTradeInput[] = [];
  let localTradesTruncated = false;
  if (wallet) {
    const trades = await prisma.walletTokenTrade.findMany({
      where: { walletId: wallet.id },
      orderBy: { ts: 'desc' },
      take: maxTrades,
      select: { action: true, amountUsd: true, ts: true, marketCapAtTrade: true, token: { select: { address: true } } }
    });
    // Newest-first truncation is a KNOWN bias (an old buy can fall out while
    // its recent sell stays — Codex Important-4): flagged on the profile so
    // consumers see it, and never presented as a complete view.
    localTradesTruncated = trades.length >= maxTrades;
    localTrades = trades.map((t) => ({
      tokenAddress: t.token.address,
      action: t.action as 'BUY' | 'SELL',
      amountUsd: Number(t.amountUsd),
      ts: t.ts,
      marketCapAtTrade: t.marketCapAtTrade === null ? null : Number(t.marketCapAtTrade)
    }));
  }

  // Chain-scoped edges (Codex Important-6: a BSC edge sharing the textual
  // address must never enter a SOLANA profile), valued via the HONEST
  // valuation column — valuedUsd nullable; unknown stays null, never 0.
  const edges = await prisma.moneyFlowEdge.findMany({
    where: {
      OR: [
        { sourceAddress: target.address, sourceChain: target.chain },
        { destinationAddress: target.address, destinationChain: target.chain }
      ]
    },
    orderBy: { amountUsd: 'desc' },
    take: maxEdges,
    select: { sourceAddress: true, destinationAddress: true, valuedUsd: true, ts: true }
  });
  const fundingEdges: FundingEdgeInput[] = edges.map((e) => ({
    direction: e.destinationAddress === target.address ? ('in' as const) : ('out' as const),
    usd: e.valuedUsd === null ? null : Number(e.valuedUsd),
    counterpartyAddress: e.destinationAddress === target.address ? e.sourceAddress : e.destinationAddress,
    ts: e.ts
  }));

  // PROVIDER claims — GMGN activity + claimed stats (never verified). Bounded.
  const observations = await prisma.gmgnObservation.findMany({
    where: { walletAddress: target.address, chain: target.chain },
    orderBy: { retrievedAt: 'desc' },
    take: 10_000,
    select: { side: true, amountUsd: true, activityTs: true, tokenAddress: true, sourceCommand: true }
  });
  const providerActivity: ProviderActivityInput[] = observations.map((o) => ({
    side: (o.side ?? null) as 'buy' | 'sell' | 'transfer' | null,
    amountUsd: o.amountUsd === null ? null : Number(o.amountUsd),
    activityTs: o.activityTs,
    tokenAddress: o.tokenAddress,
    sourceCommand: o.sourceCommand
  }));

  let providerStats: ProviderStatsInput[] = [];
  if (wallet) {
    const snaps = await prisma.observationProviderSnapshot.findMany({
      where: { walletId: wallet.id },
      select: { source: true, pnlUsd: true, winRate: true, tradeCount: true, observedAt: true }
    });
    providerStats = snaps.map((s) => ({
      source: s.source,
      pnlUsd: s.pnlUsd === null ? null : Number(s.pnlUsd),
      winRate: s.winRate,
      tradeCount: s.tradeCount,
      observedAt: s.observedAt
    }));
  }

  const inputs: BehaviorInputs = {
    chain: target.chain,
    address: target.address,
    localTrades,
    providerActivity,
    providerStats,
    fundingEdges,
    localViewTruncated: localTradesTruncated,
    now
  };
  const profile = reconstructBehaviorProfile(inputs);
  const classification = classifyHoldBehavior(profile, { now });

  const data = {
    engineVersion: profile.engineVersion,
    dataQuality: profile.dataQuality,
    computedAt: now,
    profileJson: profile as unknown as Prisma.InputJsonValue,
    classifierJson: classification as unknown as Prisma.InputJsonValue
  };
  await prisma.walletBehaviorProfile.upsert({
    where: { chain_walletAddress: { chain: target.chain, walletAddress: target.address } },
    create: { chain: target.chain, walletAddress: target.address, ...data },
    update: data
  });

  return { profile, classification };
}

export interface BehaviorPassReport {
  candidatesConsidered: number;
  profilesWritten: number;
  byDataQuality: Record<string, number>;
  byPrimaryLabel: Record<string, number>;
  errors: number;
}

/**
 * Bounded reconstruction pass over the candidate buffer: the most recently
 * seen distinct (chain, wallet) candidates, up to `limit`. One wallet's error
 * never fails the pass.
 */
export async function runBehaviorReconstruction(
  prisma: PrismaClient,
  opts: { limit?: number; now?: Date } = {}
): Promise<BehaviorPassReport> {
  const limit = opts.limit ?? 200;
  // DISTINCT selection at the query layer (Codex Important-5: a wallet with
  // many provenance rows must not eat the whole take window).
  const grouped = await prisma.candidateWallet.groupBy({
    by: ['walletAddress', 'chain'],
    _max: { lastSeenAt: true },
    orderBy: { _max: { lastSeenAt: 'desc' } },
    take: limit
  });
  const targets = grouped.map((g) => ({ chain: g.chain as 'SOLANA' | 'BSC', address: g.walletAddress }));

  const report: BehaviorPassReport = {
    candidatesConsidered: targets.length,
    profilesWritten: 0,
    byDataQuality: {},
    byPrimaryLabel: {},
    errors: 0
  };
  for (const t of targets) {
    try {
      const { profile, classification } = await reconstructWalletBehavior(prisma, t, { now: opts.now });
      report.profilesWritten += 1;
      report.byDataQuality[profile.dataQuality] = (report.byDataQuality[profile.dataQuality] ?? 0) + 1;
      const primary = classification.labels[0]?.label ?? 'none';
      report.byPrimaryLabel[primary] = (report.byPrimaryLabel[primary] ?? 0) + 1;
    } catch {
      report.errors += 1;
    }
  }
  return report;
}
