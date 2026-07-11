// FlowRadar — candidate-buffer builder (GMGN behavior plan Task 3 / directive
// Task 2).
//
// Aggregates candidate wallets from every provenance stream into the EXISTING
// CandidateWallet table (unique per walletAddress+chain+source — one row per
// source keeps ALL provenance; dedupe "by chain + wallet" is the grouping
// across those rows):
//
//   - GmgnObservation rows (smartmoney / token traders / trenches / trending /
//     kol feeds) — each distinct (wallet, chain, gmgn:<command>) becomes one
//     provenance row with the latest provider-claimed stats and the resolved
//     source category (public KOL/promoter/bot SEPARATED from trader
//     categories via categorizeCandidateSource).
//   - Lineage receivers — active fresh_receiver_hot MonitoringSubscriptions
//     become 'lineage:receiver' provenance rows (category lineage_receiver).
//   - External sources (birdeye_*, solana_tracker_pnl) already flow into
//     CandidateWallet via runExternalWalletSourceSync — this builder does NOT
//     duplicate them; it only annotates coverage in its report.
//   - Runner-mining outputs land here later under 'runner_mining:*' (Task 9) —
//     the category taxonomy already supports them.
//
// HARD RULES (directive Task 2):
//   - The buffer NEVER touches wallet status, WalletStats, or Helius polling.
//     Buffer size does not imply subscriptions; every candidate stays
//     observation-material only. This module writes ONLY candidate_wallets
//     rows (validationStatus stays 'pending' — promotion is Task 10's gate).
//   - Provider stats stay provider_claimed (claimed* columns — never
//     WalletStats).
//   - Chain-specific identity: (walletAddress, chain) — the same address on
//     SOLANA and BSC is two candidates.
//   - Bounded: maxBufferSize caps the DISTINCT (wallet, chain) population;
//     overflow candidates are dropped deterministically (fewest distinct
//     sources first, then least-recently-seen) and REPORTED, never silent.

import type { PrismaClient, Prisma } from '@prisma/client';
import { categorizeCandidateSource, isPublicFigureCategory } from '@flowradar/core';
import type { CandidateSourceCategory } from '@flowradar/core';

export interface CandidateBufferOptions {
  /** Cap on DISTINCT (wallet, chain) candidates the buffer may hold (default 5000). */
  maxBufferSize?: number;
  now?: Date;
}

export interface CandidateBufferReport {
  /** Distinct (wallet, chain) candidates in the buffer after this run. */
  distinctCandidates: number;
  /** Total provenance rows (one per wallet+chain+source). */
  provenanceRows: number;
  provenanceCreated: number;
  provenanceUpdated: number;
  /** New candidates NOT admitted because the buffer is at maxBufferSize — reported, never silent. */
  droppedOverCap: number;
  byCategory: Record<string, number>;
  publicFigures: number;
  /** Candidates that also exist in the current observation universe (wallets table). */
  inObservationUniverse: number;
}

interface SourceRow {
  walletAddress: string;
  chain: 'SOLANA' | 'BSC';
  source: string;
  category: CandidateSourceCategory;
  firstSeenAt: Date;
  lastSeenAt: Date;
  claimedPnlUsd: number | null;
  claimedWinRate: number | null;
  claimedTradeCount: number | null;
  sourceRank: number | null;
  metadata: Record<string, unknown>;
}

function tagsOf(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object') return [];
  const m = raw as Record<string, unknown>;
  const out = [m.tag, m.wallet_tag_v2, ...(Array.isArray(m.tags) ? m.tags : [])].filter((t) => t != null);
  return out.map((t) => String(t).toLowerCase().trim());
}

/** Derives provenance rows from GmgnObservation: one per (wallet, chain, command),
 *  carrying the LATEST claimed stats and OR-ed public-figure flags. */
async function gmgnSourceRows(prisma: PrismaClient): Promise<SourceRow[]> {
  const observations = await prisma.gmgnObservation.findMany({
    select: {
      walletAddress: true,
      chain: true,
      sourceCommand: true,
      isKolTagged: true,
      isPromoterTagged: true,
      rawClassification: true,
      providerPnlUsd: true,
      providerWinRate: true,
      providerTradeCount: true,
      activityTs: true,
      retrievedAt: true
    },
    orderBy: { retrievedAt: 'asc' }
  });

  const byKey = new Map<string, SourceRow & { kol: boolean; promoter: boolean; tags: Set<string> }>();
  for (const o of observations) {
    const source = `gmgn:${o.sourceCommand}`;
    const key = `${o.chain}|${o.walletAddress}|${source}`;
    const seenAt = o.activityTs ?? o.retrievedAt;
    let row = byKey.get(key);
    if (!row) {
      row = {
        walletAddress: o.walletAddress,
        chain: o.chain as 'SOLANA' | 'BSC',
        source,
        category: 'unclassified',
        firstSeenAt: seenAt,
        lastSeenAt: seenAt,
        claimedPnlUsd: null,
        claimedWinRate: null,
        claimedTradeCount: null,
        sourceRank: null,
        metadata: {},
        kol: false,
        promoter: false,
        tags: new Set<string>()
      };
      byKey.set(key, row);
    }
    if (seenAt < row.firstSeenAt) row.firstSeenAt = seenAt;
    if (seenAt > row.lastSeenAt) row.lastSeenAt = seenAt;
    row.kol = row.kol || o.isKolTagged;
    row.promoter = row.promoter || o.isPromoterTagged;
    for (const t of tagsOf(o.rawClassification)) row.tags.add(t);
    // Latest-wins claimed stats (rows are retrievedAt-ascending).
    if (o.providerPnlUsd != null) row.claimedPnlUsd = Number(o.providerPnlUsd);
    if (o.providerWinRate != null) row.claimedWinRate = o.providerWinRate;
    if (o.providerTradeCount != null) row.claimedTradeCount = o.providerTradeCount;
  }

  return [...byKey.values()].map((r) => {
    const category = categorizeCandidateSource({
      source: r.source,
      isKolTagged: r.kol,
      isPromoterTagged: r.promoter,
      rawTags: [...r.tags]
    });
    return { ...r, category, metadata: { category, kolTagged: r.kol, promoterTagged: r.promoter } };
  });
}

/** Active fresh_receiver_hot lineage receivers as provenance rows. */
async function lineageReceiverRows(prisma: PrismaClient, now: Date): Promise<SourceRow[]> {
  const subs = await prisma.monitoringSubscription.findMany({
    where: { priority: 'fresh_receiver_hot', active: true },
    select: { createdAt: true, updatedAt: true, wallet: { select: { address: true, chain: true } } }
  });
  return subs.map((s) => ({
    walletAddress: s.wallet.address,
    chain: s.wallet.chain as 'SOLANA' | 'BSC',
    source: 'lineage:receiver',
    category: 'lineage_receiver' as const,
    firstSeenAt: s.createdAt,
    lastSeenAt: s.updatedAt ?? now,
    claimedPnlUsd: null,
    claimedWinRate: null,
    claimedTradeCount: null,
    sourceRank: null,
    metadata: { category: 'lineage_receiver' }
  }));
}

/**
 * Builds/refreshes the candidate buffer. Idempotent: re-running with the same
 * inputs updates lastSeenAt/claimed stats monotonically and creates nothing
 * new. Never mutates wallets, WalletStats, subscriptions, or validation state.
 */
export async function buildCandidateBuffer(
  prisma: PrismaClient,
  opts: CandidateBufferOptions = {}
): Promise<CandidateBufferReport> {
  const now = opts.now ?? new Date();
  const maxBufferSize = opts.maxBufferSize ?? 5000;

  const incoming = [...(await gmgnSourceRows(prisma)), ...(await lineageReceiverRows(prisma, now))];

  // Current buffer population (distinct wallet+chain across ALL sources,
  // including externally-synced birdeye/solana-tracker rows).
  const existing = await prisma.candidateWallet.findMany({
    select: { walletAddress: true, chain: true, source: true }
  });
  const existingPairs = new Set(existing.map((e) => `${e.chain}|${e.walletAddress}`));

  // Deterministic admission for NEW (wallet, chain) pairs when at/over cap:
  // candidates confirmed by MORE distinct sources win; ties broken by most
  // recent lastSeenAt, then address (stable).
  const newPairs = new Map<string, SourceRow[]>();
  for (const row of incoming) {
    const pair = `${row.chain}|${row.walletAddress}`;
    if (existingPairs.has(pair)) continue;
    const list = newPairs.get(pair) ?? [];
    list.push(row);
    newPairs.set(pair, list);
  }
  const capacity = Math.max(0, maxBufferSize - existingPairs.size);
  const rankedNewPairs = [...newPairs.entries()].sort((a, b) => {
    const srcDiff = b[1].length - a[1].length;
    if (srcDiff !== 0) return srcDiff;
    const lastA = Math.max(...a[1].map((r) => r.lastSeenAt.getTime()));
    const lastB = Math.max(...b[1].map((r) => r.lastSeenAt.getTime()));
    if (lastB !== lastA) return lastB - lastA;
    return a[0] < b[0] ? -1 : 1;
  });
  const admittedPairs = new Set(rankedNewPairs.slice(0, capacity).map(([pair]) => pair));
  const droppedOverCap = rankedNewPairs.length - admittedPairs.size;

  let provenanceCreated = 0;
  let provenanceUpdated = 0;

  for (const row of incoming) {
    const pair = `${row.chain}|${row.walletAddress}`;
    if (!existingPairs.has(pair) && !admittedPairs.has(pair)) continue; // over cap — reported below

    const data = {
      claimedPnlUsd: row.claimedPnlUsd,
      claimedWinRate: row.claimedWinRate,
      claimedTradeCount: row.claimedTradeCount,
      sourceRank: row.sourceRank,
      lastSeenAt: row.lastSeenAt,
      metadataJson: row.metadata as Prisma.InputJsonValue
    };
    try {
      await prisma.candidateWallet.create({
        data: {
          walletAddress: row.walletAddress,
          chain: row.chain,
          source: row.source,
          firstSeenAt: row.firstSeenAt,
          ...data
        }
      });
      provenanceCreated += 1;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // Existing provenance row: advance lastSeenAt/stats MONOTONICALLY —
      // an older replay never regresses a newer sighting.
      const advanced = await prisma.candidateWallet.updateMany({
        where: { walletAddress: row.walletAddress, chain: row.chain, source: row.source, lastSeenAt: { lt: row.lastSeenAt } },
        data
      });
      if (advanced.count > 0) provenanceUpdated += 1;
    }
  }

  // Report over the WHOLE buffer (all sources, external ones included).
  const allRows = await prisma.candidateWallet.findMany({
    select: { walletAddress: true, chain: true, source: true, metadataJson: true }
  });
  const byCategory: Record<string, number> = {};
  let publicFigures = 0;
  const distinct = new Set<string>();
  for (const r of allRows) {
    distinct.add(`${r.chain}|${r.walletAddress}`);
    const meta = (r.metadataJson ?? {}) as Record<string, unknown>;
    const category =
      typeof meta.category === 'string'
        ? (meta.category as CandidateSourceCategory)
        : categorizeCandidateSource({ source: r.source });
    byCategory[category] = (byCategory[category] ?? 0) + 1;
    if (isPublicFigureCategory(category)) publicFigures += 1;
  }

  // Observation-universe overlap (existing wallets rows) — reported, not stored
  // as a source (the universe is not a provenance stream).
  const pairs = [...distinct].map((p) => {
    const [chain, walletAddress] = p.split('|');
    return { chain: chain as 'SOLANA' | 'BSC', address: walletAddress };
  });
  let inObservationUniverse = 0;
  const CHUNK = 500;
  for (let i = 0; i < pairs.length; i += CHUNK) {
    const chunk = pairs.slice(i, i + CHUNK);
    inObservationUniverse += await prisma.wallet.count({
      where: { OR: chunk.map((c) => ({ address: c.address, chain: c.chain })) }
    });
  }

  return {
    distinctCandidates: distinct.size,
    provenanceRows: allRows.length,
    provenanceCreated,
    provenanceUpdated,
    droppedOverCap,
    byCategory,
    publicFigures,
    inObservationUniverse
  };
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';
}
