// FlowRadar — stealth accumulation DB driver + persistence (Priority 2).
//
// Wires the APPROVED pure engine (@flowradar/core computeStealth) to real
// rows, SHADOW-ONLY end to end:
//   fetchStealthInputs — bounded per-token cohort aggregation over the last
//     24h of trades: wallet statuses map to the engine's cohorts
//     (signal_eligible → eligible; observation_only → observation;
//     public_kol/public_promoter → publicKol; copytrader → crowd;
//     bot_or_service/excluded → dropped entirely — operational noise never
//     enters any cohort). Fresh buyers = first-EVER buy of the token inside
//     the window; distinct clusters = EntityCluster memberships with every
//     unclustered wallet counting as its own entity.
//   runStealthPass — computeStealth per token, then persist ONE
//     StealthSnapshot per (token, bucket): re-running inside the same bucket
//     UPSERTS (replay-idempotent, never duplicates). Snapshots carry the full
//     metrics object, evidence components (per-window cohort flows,
//     fresh-funded-receiver buyer count, confluence conflict notes), a
//     plain-English explanation, and invalidation reasons.
//
// HARD BOUNDARIES: reads trades/wallets/clusters/subscriptions; writes ONLY
// stealth_snapshots. No FlowScore, no thresholds, no eligibility, no
// Wallet/WalletStats writes. All queries bounded by tokenLimit + the 24h
// window + the involved-wallet set.

import type { Prisma, PrismaClient } from '@prisma/client';
import {
  computeStealth,
  DEFAULT_STEALTH_CONFIG,
  STEALTH_WINDOWS,
  type CohortFlow,
  type StealthInput,
  type StealthResult,
  type StealthWindow,
  type StealthWindowInput
} from '@flowradar/core';

const WINDOW_MINUTES: Record<StealthWindow, number> = { '5m': 5, '15m': 15, '30m': 30, '1h': 60, '4h': 240, '24h': 1440 };
const DAY_MS = 24 * 3600 * 1000;

type Cohort = 'eligible' | 'observation' | 'publicKol' | 'crowd';

function cohortOf(status: string): Cohort | null {
  switch (status) {
    case 'signal_eligible': return 'eligible';
    case 'observation_only': return 'observation';
    case 'public_kol':
    case 'public_promoter': return 'publicKol';
    case 'copytrader': return 'crowd';
    default: return null; // bot_or_service / excluded: dropped from every cohort
  }
}

const zeroFlow = (): CohortFlow => ({ distinctBuyers: 0, distinctSellers: 0, buyUsd: 0, sellUsd: 0, freshBuyers: 0, distinctClusters: 0 });

export interface StealthEvidence {
  /** Per-window cohort flows the engine input was built from (verbatim). */
  windows: StealthWindowInput[];
  /** Distinct buyers (any cohort, 24h) holding an ACTIVE fresh_receiver_hot subscription. */
  freshFundedReceiverBuyers: number;
  /** Latest external-confluence conflict notes for the token, when any exist. */
  conflictNotes: string[];
  /** Which windows actually contained trades. */
  windowsWithActivity: StealthWindow[];
}

export interface StealthTokenInput {
  tokenId: string;
  chain: 'SOLANA' | 'BSC';
  /** Per-window cohort flows — exactly the engine's StealthInput.windows. */
  windows: StealthWindowInput[];
  evidence: StealthEvidence;
}

export interface FetchStealthInputsOptions {
  now?: Date;
  /** Max tokens per pass (most recent trade activity first). */
  tokenLimit?: number;
}

export async function fetchStealthInputs(
  prisma: PrismaClient,
  opts: FetchStealthInputsOptions = {}
): Promise<StealthTokenInput[]> {
  const now = opts.now ?? new Date();
  const tokenLimit = Math.max(1, Math.min(opts.tokenLimit ?? 50, 500));
  const since = new Date(now.getTime() - DAY_MS);

  // Bounded token selection: tokens with trade activity in the last 24h,
  // most recent first.
  const active = await prisma.walletTokenTrade.groupBy({
    by: ['tokenId'],
    where: { ts: { gte: since, lte: now }, action: { in: ['BUY', 'SELL'] } },
    _max: { ts: true },
    orderBy: { _max: { ts: 'desc' } },
    take: tokenLimit
  });
  if (active.length === 0) return [];
  const tokenIds = active.map((t) => t.tokenId);
  const tokens = await prisma.token.findMany({ where: { id: { in: tokenIds } }, select: { id: true, chain: true } });
  const chainOf = new Map(tokens.map((t) => [t.id, t.chain]));

  // One bounded trade fetch for all selected tokens.
  const trades = await prisma.walletTokenTrade.findMany({
    where: { tokenId: { in: tokenIds }, ts: { gte: since, lte: now }, action: { in: ['BUY', 'SELL'] } },
    select: { tokenId: true, walletId: true, action: true, amountUsd: true, ts: true }
  });
  const walletIds = [...new Set(trades.map((t) => t.walletId))];

  const wallets = await prisma.wallet.findMany({ where: { id: { in: walletIds } }, select: { id: true, status: true } });
  const statusOf = new Map(wallets.map((w) => [w.id, w.status]));

  const clusterRows = await prisma.entityClusterWallet.findMany({
    where: { walletId: { in: walletIds } },
    select: { walletId: true, clusterId: true }
  });
  const clusterOf = new Map(clusterRows.map((c) => [c.walletId, c.clusterId]));

  // First-EVER buy per (wallet, token) among the involved wallets — needed
  // for the freshBuyers definition ("first-ever buy falls in this window").
  const firstBuys = await prisma.walletTokenTrade.groupBy({
    by: ['tokenId', 'walletId'],
    where: { tokenId: { in: tokenIds }, walletId: { in: walletIds }, action: 'BUY' },
    _min: { ts: true }
  });
  const firstBuyTs = new Map(firstBuys.map((f) => [`${f.tokenId}:${f.walletId}`, f._min.ts!.getTime()]));

  // Active fresh_receiver_hot wallets among the involved buyers.
  const hotSubs = await prisma.monitoringSubscription.findMany({
    where: { walletId: { in: walletIds }, priority: 'fresh_receiver_hot', active: true },
    select: { walletId: true }
  });
  const hotWallets = new Set(hotSubs.map((s) => s.walletId));

  // External-confluence health notes per token (shadow evidence, optional):
  // any recent NON-ok snapshot is surfaced as a caveat — absence/unavailable
  // is never treated as safe (existing confluence honesty rule).
  const confluence = await prisma.tokenConfluenceSnapshot.findMany({
    where: { tokenId: { in: tokenIds }, status: { not: 'ok' } },
    orderBy: { observedAt: 'desc' },
    take: 3 * tokenIds.length,
    select: { tokenId: true, snapshotType: true, status: true }
  });

  const results: StealthTokenInput[] = [];
  for (const tokenId of tokenIds) {
    const tokenTrades = trades.filter((t) => t.tokenId === tokenId);
    const windows: StealthWindowInput[] = [];
    const windowsWithActivity: StealthWindow[] = [];

    for (const win of STEALTH_WINDOWS) {
      const from = now.getTime() - WINDOW_MINUTES[win] * 60_000;
      const inWindow = tokenTrades.filter((t) => t.ts.getTime() > from && t.ts.getTime() <= now.getTime());
      if (inWindow.length > 0) windowsWithActivity.push(win);
      const flows: Record<Cohort, CohortFlow> = { eligible: zeroFlow(), observation: zeroFlow(), publicKol: zeroFlow(), crowd: zeroFlow() };
      const buyers: Record<Cohort, Set<string>> = { eligible: new Set(), observation: new Set(), publicKol: new Set(), crowd: new Set() };
      const sellers: Record<Cohort, Set<string>> = { eligible: new Set(), observation: new Set(), publicKol: new Set(), crowd: new Set() };
      const fresh: Record<Cohort, Set<string>> = { eligible: new Set(), observation: new Set(), publicKol: new Set(), crowd: new Set() };
      const clusters: Record<Cohort, Set<string>> = { eligible: new Set(), observation: new Set(), publicKol: new Set(), crowd: new Set() };

      for (const t of inWindow) {
        const cohort = cohortOf(statusOf.get(t.walletId) ?? '');
        if (!cohort) continue; // bot/excluded/unknown: never enters a cohort
        const usd = Number(t.amountUsd);
        if (t.action === 'BUY') {
          buyers[cohort].add(t.walletId);
          flows[cohort].buyUsd += Number.isFinite(usd) ? usd : 0;
          clusters[cohort].add(clusterOf.get(t.walletId) ?? `solo:${t.walletId}`);
          const first = firstBuyTs.get(`${tokenId}:${t.walletId}`);
          if (first !== undefined && first > from && first <= now.getTime()) fresh[cohort].add(t.walletId);
        } else {
          sellers[cohort].add(t.walletId);
          flows[cohort].sellUsd += Number.isFinite(usd) ? usd : 0;
        }
      }
      for (const c of ['eligible', 'observation', 'publicKol', 'crowd'] as Cohort[]) {
        flows[c].distinctBuyers = buyers[c].size;
        flows[c].distinctSellers = sellers[c].size;
        flows[c].freshBuyers = fresh[c].size;
        flows[c].distinctClusters = clusters[c].size;
      }
      windows.push({ window: win, eligible: flows.eligible, observation: flows.observation, publicKol: flows.publicKol, crowd: flows.crowd });
    }

    const buyers24h = new Set(tokenTrades.filter((t) => t.action === 'BUY').map((t) => t.walletId));
    const freshFundedReceiverBuyers = [...buyers24h].filter((w) => hotWallets.has(w)).length;
    const conflictNotes = confluence
      .filter((c) => c.tokenId === tokenId)
      .map((c) => `${c.snapshotType}: ${c.status}`);

    const chain = (chainOf.get(tokenId) ?? 'SOLANA') as 'SOLANA' | 'BSC';
    results.push({
      tokenId,
      chain,
      windows,
      evidence: { windows, freshFundedReceiverBuyers, conflictNotes, windowsWithActivity }
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Plain-English explanation + invalidation reasons
// ---------------------------------------------------------------------------

const STATE_PROSE: Record<StealthResult['state'], string> = {
  WATCHING: 'No qualifying accumulation yet — the token is being watched, nothing more.',
  STEALTH_ACCUMULATION: 'Multiple signal-eligible wallets are quietly accumulating with net inflow and no public or crowd participation.',
  EARLY_INDEPENDENT_CONFIRMATION: 'The quiet accumulation now spans several INDEPENDENT entities — separate clusters are buying without public attention.',
  PUBLIC_KOL_ARRIVAL: 'Public KOL/promoter wallets have started buying — the stealth window has closed; this is a LATE-stage signal, not an early one.',
  CROWD_EXPANSION: 'Copytrader/crowd breadth is surging — typically follows public arrival and often precedes distribution.',
  DISTRIBUTION_RISK: 'The early cohort is selling heavily into the market — accumulation credit is at risk.',
  INVALIDATED: 'The early cohort has flipped to net distribution — the accumulation thesis is invalidated.'
};

function buildExplanation(r: StealthResult, ev: StealthEvidence): string {
  const m = r.metrics;
  const parts = [
    STATE_PROSE[r.state],
    `In the last 24h: ${m.eligibleBuyers24h} signal-eligible buyer(s) across ${m.independentEligibleClusters24h} independent cluster(s), ` +
    `net eligible flow $${Math.round(m.eligibleNetUsd24h)}, ${m.publicKolBuyers24h} public-KOL buyer(s), ${m.crowdBuyers24h} crowd buyer(s), ` +
    `${m.observationBuyers24h} observation-only buyer(s).`
  ];
  if (ev.freshFundedReceiverBuyers > 0) parts.push(`${ev.freshFundedReceiverBuyers} fresh root-funded receiver(s) also bought.`);
  if (ev.conflictNotes.length > 0) parts.push(`External conflicts: ${ev.conflictNotes.join('; ')}.`);
  if (r.reasons.length > 0) parts.push(`Engine reasoning: ${r.reasons.join(' | ')}`);
  parts.push(`Shadow score ${r.stealthScore}/100 — shadow-only, never a trade signal.`);
  return parts.join(' ');
}

function buildInvalidationReasons(r: StealthResult): string[] {
  const m = r.metrics;
  const reasons: string[] = [];
  if (r.state === 'DISTRIBUTION_RISK' || r.state === 'INVALIDATED') {
    reasons.push(`Early-cohort selling: $${Math.round(m.eligibleSellUsd24h)} sold vs $${Math.round(m.eligibleBuyUsd24h)} bought in 24h (sell/buy ratio ${Number.isFinite(m.eligibleSellToBuyRatio24h) ? m.eligibleSellToBuyRatio24h.toFixed(2) : 'n/a'}).`);
    if (m.eligibleNetUsd24h <= 0) reasons.push('Net eligible flow is non-positive — distribution, not accumulation.');
  }
  if (r.state === 'PUBLIC_KOL_ARRIVAL' || r.state === 'CROWD_EXPANSION') {
    reasons.push(`Public attention arrived: ${m.publicKolBuyers24h} KOL buyer(s), ${m.crowdBuyers24h} crowd buyer(s) — early-entry advantage is gone; treat as late-stage/distribution context.`);
  }
  return reasons;
}

// ---------------------------------------------------------------------------
// runStealthPass
// ---------------------------------------------------------------------------

export interface StealthPassResult {
  tokensEvaluated: number;
  snapshotsWritten: number;
  byState: Record<string, number>;
  errors: number;
}

export interface RunStealthPassOptions extends FetchStealthInputsOptions {
  /** Snapshot bucket size, seconds (default 300 = one row per token per 5m). */
  bucketSec?: number;
}

export async function runStealthPass(prisma: PrismaClient, opts: RunStealthPassOptions = {}): Promise<StealthPassResult> {
  const now = opts.now ?? new Date();
  const bucketSec = Math.max(60, opts.bucketSec ?? 300);
  const bucketTs = new Date(Math.floor(now.getTime() / (bucketSec * 1000)) * bucketSec * 1000);

  const inputs = await fetchStealthInputs(prisma, { now, tokenLimit: opts.tokenLimit });
  const result: StealthPassResult = { tokensEvaluated: 0, snapshotsWritten: 0, byState: {}, errors: 0 };

  for (const { tokenId, chain, windows, evidence } of inputs) {
    try {
      const r = computeStealth({ tokenId, chain, now, windows } satisfies StealthInput, DEFAULT_STEALTH_CONFIG);
      result.tokensEvaluated += 1;
      result.byState[r.state] = (result.byState[r.state] ?? 0) + 1;

      // previousState = latest snapshot from an EARLIER bucket.
      const prev = await prisma.stealthSnapshot.findFirst({
        where: { tokenId, bucketTs: { lt: bucketTs } },
        orderBy: { bucketTs: 'desc' },
        select: { state: true }
      });

      await prisma.stealthSnapshot.upsert({
        where: { tokenId_bucketTs: { tokenId, bucketTs } },
        create: {
          tokenId,
          chain,
          state: r.state,
          previousState: prev?.state ?? null,
          stateChanged: prev !== null && prev.state !== r.state,
          stealthScore: r.stealthScore,
          metrics: r.metrics as unknown as Prisma.InputJsonValue,
          evidence: evidence as unknown as Prisma.InputJsonValue,
          explanation: buildExplanation(r, evidence),
          invalidationReasons: buildInvalidationReasons(r) as unknown as Prisma.InputJsonValue,
          bucketTs,
          computedAt: now
        },
        update: {
          state: r.state,
          previousState: prev?.state ?? null,
          stateChanged: prev !== null && prev.state !== r.state,
          stealthScore: r.stealthScore,
          metrics: r.metrics as unknown as Prisma.InputJsonValue,
          evidence: evidence as unknown as Prisma.InputJsonValue,
          explanation: buildExplanation(r, evidence),
          invalidationReasons: buildInvalidationReasons(r) as unknown as Prisma.InputJsonValue,
          computedAt: now
        }
      });
      result.snapshotsWritten += 1;
    } catch (err) {
      // Per-token isolation: one token's failure never aborts the pass.
      result.errors += 1;
      void err;
    }
  }
  return result;
}
