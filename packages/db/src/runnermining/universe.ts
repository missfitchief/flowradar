// FlowRadar — runner-mining universe/cohort/entry builders (Runner Mining
// Tasks 1-4 DB layer). SHADOW-ONLY analytics over locally persisted data:
// tokens, token_market_snapshots (mcap series), and wallet_token_trades
// (marketCapAtTrade = per-trade historical mcap observations). No provider
// calls here — provider enrichment (Birdeye OHLCV) is a separate, budgeted
// future step whose absence is recorded honestly as partial coverage.
//
// Discipline:
//   - deterministic + idempotent (mint-keyed upserts; reruns change nothing);
//   - bounded + resumable (mint-ordered cursor, batch caps);
//   - unknown stays unknown (coverage classes; below-$10M needs launch
//     anchoring — see @flowradar/core classifyRunner);
//   - one error never fails the batch;
//   - NO lookahead: outcomes derive from ts-ordered historical observations
//     only, and control matching consumes PRE-outcome features only.

import type { PrismaClient, Prisma } from '@prisma/client';
import {
  classifyUniverseCoverage,
  classifyRunner,
  computeTokenOutcome,
  computeEntryContext,
  matchControls,
  earlyEntryBand,
  DEFAULT_RUNNER_MINING_CONFIG
} from '@flowradar/core';
import type { MatchFeatures, TokenSeriesPoint } from '@flowradar/core';

/** The known quarantined pollution class (docs/STALE_BSC_FIXTURE.md). */
const QUARANTINED_ADDRESSES = new Set(['0x1234567890abcdef1234567890abcdef12345678']);

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Launch anchoring: first observation within this window of the token's
 *  locally-known firstSeenAt counts as launch-anchored. */
const LAUNCH_ANCHOR_TOLERANCE_MS = 3_600_000;

export interface UniverseBuildReport {
  scanned: number;
  created: number;
  updated: number;
  byCoverage: Record<string, number>;
  nextCursor: string | null;
  errors: number;
}

/** Loads a token's historical mcap observation series from BOTH local sources,
 *  ts-ordered, with per-source counts for provenance + conflict detection. */
async function loadSeries(prisma: PrismaClient, tokenId: string): Promise<{
  points: TokenSeriesPoint[];
  bySource: { marketSnapshots: number; tradeObservations: number };
  truncated: boolean;
  maxSourceDisagreement: number | null;
}> {
  const snaps = await prisma.tokenMarketSnapshot.findMany({
    where: { tokenId },
    orderBy: { ts: 'asc' },
    take: 10_000,
    select: { ts: true, marketCapUsd: true, priceUsd: true, liquidityUsd: true }
  });
  const trades = await prisma.walletTokenTrade.findMany({
    where: { tokenId, marketCapAtTrade: { gt: 0 } },
    orderBy: { ts: 'asc' },
    take: 10_000,
    select: { ts: true, marketCapAtTrade: true, priceUsd: true }
  });

  // LOOKAHEAD GUARD (Codex Critical-1): trade rows' marketCapAtTrade can be
  // BACKDATED from a future snapshot by ingest's nearest-AFTER fallback, so
  // trade observations are EXCLUDED from the outcome/ATH series. Snapshots
  // only; trades remain provenance + entry-band inputs (low confidence).
  const points: (TokenSeriesPoint & { source: 'snapshot' | 'trade' })[] = snaps
    .map((s) => ({
      ts: s.ts,
      marketCapUsd: s.marketCapUsd === null ? null : Number(s.marketCapUsd),
      priceUsd: s.priceUsd === null ? null : Number(s.priceUsd),
      liquidityUsd: s.liquidityUsd === null ? null : Number(s.liquidityUsd),
      source: 'snapshot' as const
    }))
    .sort((a, b) => a.ts.getTime() - b.ts.getTime());
  const tradeObs = trades.map((t) => ({ ts: t.ts, marketCapUsd: Number(t.marketCapAtTrade) }));

  // Cross-source disagreement at overlapping timestamps (within 5 min):
  // max ratio between snapshot-mcap and trade-mcap pairs.
  let maxDisagreement: number | null = null;
  const snapPts = points.filter((p) => p.marketCapUsd !== null && p.marketCapUsd > 0);
  const tradePts = tradeObs.filter((p) => p.marketCapUsd > 0);
  if (snapPts.length > 0 && tradePts.length > 0) {
    for (const tp of tradePts.slice(0, 500)) {
      let nearest: typeof snapPts[number] | null = null;
      let bestGap = Infinity;
      for (const sp of snapPts) {
        const gap = Math.abs(sp.ts.getTime() - tp.ts.getTime());
        if (gap < bestGap) { bestGap = gap; nearest = sp; }
      }
      if (nearest && bestGap <= 300_000) {
        const ratio = Math.max(tp.marketCapUsd! / nearest.marketCapUsd!, nearest.marketCapUsd! / tp.marketCapUsd!);
        if (maxDisagreement === null || ratio > maxDisagreement) maxDisagreement = ratio;
      }
    }
  }

  return {
    points: points.map(({ source: _s, ...p }) => p),
    bySource: { marketSnapshots: snaps.length, tradeObservations: trades.length },
    truncated: snaps.length >= 10_000 || trades.length >= 10_000, // Codex Critical-3
    maxSourceDisagreement: maxDisagreement
  };
}

/**
 * Task 1 — build/refresh the canonical universe. Bounded batch, mint-ordered
 * cursor resume, idempotent (mint-unique upsert with deterministic content).
 */
export async function buildTokenUniverse(
  prisma: PrismaClient,
  opts: { batchSize?: number; cursor?: string | null; now?: Date; mintPrefix?: string } = {}
): Promise<UniverseBuildReport> {
  const batchSize = opts.batchSize ?? 500;
  const now = opts.now ?? new Date();
  const tokens = await prisma.token.findMany({
    // SOLANA only (hard rule 21; also removes the cross-chain shared-address
    // lifecycle collision — Codex Important-3). Cursor stays address-ordered
    // and is complete within the single chain.
    where: { chain: 'SOLANA', ...(opts.cursor ? { address: { gt: opts.cursor } } : {}), ...(opts.mintPrefix ? { address: { startsWith: opts.mintPrefix, ...(opts.cursor ? { gt: opts.cursor } : {}) } } : {}) },
    orderBy: { address: 'asc' },
    take: batchSize,
    select: { id: true, address: true, chain: true, firstSeenAt: true }
  });

  const report: UniverseBuildReport = { scanned: tokens.length, created: 0, updated: 0, byCoverage: {}, nextCursor: null, errors: 0 };

  for (const token of tokens) {
    try {
      const { points, bySource, truncated } = await loadSeries(prisma, token.id);
      const validPoints = points.filter((p) => p.marketCapUsd !== null && p.marketCapUsd > 0);
      const early24hPoints = validPoints.length > 0
        ? validPoints.filter((pt) => pt.ts.getTime() - validPoints[0].ts.getTime() <= 86_400_000).length
        : 0;
      const rawCoverage = classifyUniverseCoverage({
        validMint: BASE58_RE.test(token.address),
        chain: token.chain as 'SOLANA' | 'BSC',
        quarantined: QUARANTINED_ADDRESSES.has(token.address),
        seriesPointCount: validPoints.length,
        minSeriesPoints: DEFAULT_RUNNER_MINING_CONFIG.minSeriesPoints
      });
      // A take-cap-truncated series can hide the peak: never call it covered
      // (Codex Critical-3) — degrade so below-$10M verdicts become impossible.
      const coverage = truncated && rawCoverage === 'covered' ? 'partially_covered' : rawCoverage;
      const data = {
        tokenId: token.id,
        sourcesJson: {
          local: { ...bySource, early24hPoints, truncated },
          providerEnrichment: 'none_yet — Birdeye OHLCV is a budgeted future step; absence recorded, not fabricated'
        } as Prisma.InputJsonValue,
        coverage,
        seriesPointCount: validPoints.length,
        firstObservedAt: validPoints[0]?.ts ?? null,
        lastObservedAt: validPoints[validPoints.length - 1]?.ts ?? null
      };
      const existing = await prisma.tokenLifecycle.findUnique({ where: { mint: token.address }, select: { id: true } });
      if (existing) {
        await prisma.tokenLifecycle.update({ where: { mint: token.address }, data });
        report.updated += 1;
      } else {
        await prisma.tokenLifecycle.create({ data: { mint: token.address, enteredUniverseAt: now, ...data } });
        report.created += 1;
      }
      report.byCoverage[coverage] = (report.byCoverage[coverage] ?? 0) + 1;
    } catch {
      report.errors += 1;
    }
  }
  report.nextCursor = tokens.length === batchSize ? tokens[tokens.length - 1].address : null;
  return report;
}

export interface CohortClassifyReport {
  considered: number;
  byClass: Record<string, number>;
  errors: number;
  nextCursor: string | null;
}

/** Task 2 — classify covered/partial lifecycles against the fixed $10M ATH bar. */
export async function classifyRunnerCohort(
  prisma: PrismaClient,
  opts: { batchSize?: number; cursor?: string | null; now?: Date; mintPrefix?: string } = {}
): Promise<CohortClassifyReport> {
  const batchSize = opts.batchSize ?? 500;
  const now = opts.now ?? new Date();
  const lifecycles = await prisma.tokenLifecycle.findMany({
    where: {
      coverage: { in: ['covered', 'partially_covered', 'unavailable'] },
      ...(opts.cursor ? { mint: { gt: opts.cursor } } : {}),
      ...(opts.mintPrefix ? { mint: { startsWith: opts.mintPrefix, ...(opts.cursor ? { gt: opts.cursor } : {}) } } : {})
    },
    orderBy: { mint: 'asc' },
    take: batchSize,
    select: { mint: true, tokenId: true, coverage: true }
  });

  const report: CohortClassifyReport = { considered: lifecycles.length, byClass: {}, errors: 0, nextCursor: null };

  for (const lc of lifecycles) {
    try {
      const token = lc.tokenId
        ? await prisma.token.findUnique({ where: { id: lc.tokenId }, select: { id: true, firstSeenAt: true, tokenCreatedAt: true } })
        : null;
      const { points, bySource, truncated, maxSourceDisagreement } = token
        ? await loadSeries(prisma, token.id)
        : { points: [], bySource: { marketSnapshots: 0, tradeObservations: 0 }, truncated: false, maxSourceDisagreement: null };
      const validPoints = points.filter((p) => p.marketCapUsd !== null && p.marketCapUsd > 0);
      // Anchoring (Codex re-review): PROVEN launch only — tokenCreatedAt (the
      // on-chain creation time when known) must exist, and the first
      // observation must land AT or AFTER it within the tolerance. Local
      // discovery time (firstSeenAt) is NOT launch proof and can never enable
      // a verified_below_10m verdict; tokens without tokenCreatedAt stay
      // insufficient_history however low their observed window peaked.
      const launchTs = token?.tokenCreatedAt ?? null;
      const anchorDelta =
        launchTs !== null && validPoints.length > 0 ? validPoints[0].ts.getTime() - launchTs.getTime() : null;
      const anchoredAtLaunch = anchorDelta !== null && anchorDelta >= 0 && anchorDelta <= LAUNCH_ANCHOR_TOLERANCE_MS;

      const outcome = computeTokenOutcome(points, DEFAULT_RUNNER_MINING_CONFIG, { anchoredAtLaunch });
      const effectiveCoverage = truncated && lc.coverage === 'covered' ? 'partially_covered' : lc.coverage;
      const cls = classifyRunner({
        outcome,
        coverage: effectiveCoverage as never,
        anchoredAtLaunch,
        sourceCount: (bySource.marketSnapshots > 0 ? 1 : 0) + (bySource.tradeObservations > 0 ? 1 : 0),
        maxSourceDisagreement
      });

      await prisma.tokenLifecycle.update({
        where: { mint: lc.mint },
        data: {
          runnerClass: cls.runnerClass,
          athMcapUsd: outcome.athMcapUsd,
          athTs: outcome.athTs,
          baselineMcapUsd: outcome.baselineMcapUsd,
          outcomeLabels: outcome.labels as unknown as Prisma.InputJsonValue,
          confidence: cls.confidence,
          evidenceJson: {
            reasons: cls.reasons,
            anchoredAtLaunch,
            anchorDeltaMs: anchorDelta,
            seriesTruncated: truncated,
            bySource,
            maxSourceDisagreement,
            validPointCount: validPoints.length,
            observationSpan: validPoints.length > 0
              ? { from: validPoints[0].ts.toISOString(), to: validPoints[validPoints.length - 1].ts.toISOString() }
              : null,
            outcomeDataQuality: outcome.dataQuality ?? null,
            engine: 'computeTokenOutcome + classifyRunner v1'
          } as Prisma.InputJsonValue,
          classifiedAt: now
        }
      });
      report.byClass[cls.runnerClass] = (report.byClass[cls.runnerClass] ?? 0) + 1;
    } catch {
      report.errors += 1;
    }
  }
  report.nextCursor = lifecycles.length === batchSize ? lifecycles[lifecycles.length - 1].mint : null;
  return report;
}

export interface ControlMatchReport {
  runners: number;
  matchedTier1: number;
  matchedTier2: number;
  noValidControl: number;
}

/** Task 3 — deterministic matched controls from PRE-outcome features. The
 *  control pool = every classified NON-runner lifecycle with a usable baseline
 *  (verified_below_10m first; insufficient_history admitted at tier2 with the
 *  bias recorded — their unknown outcome is a documented limitation, never
 *  silently treated as non-runner truth). */
export async function buildControlMatches(prisma: PrismaClient, opts: { mintPrefix?: string } = {}): Promise<ControlMatchReport> {
  // PRE-outcome features only (Codex Critical-4): early activity = points in
  // the FIRST 24h of the series (persisted at universe build), never the
  // full-history point count (which encodes survival/later surveillance).
  const toFeatures = (r: { mint: string; firstObservedAt: Date | null; baselineMcapUsd: Prisma.Decimal | null; sourcesJson: unknown; runnerClass: string | null }): MatchFeatures | null => {
    if (r.firstObservedAt === null) return null;
    const early = (r.sourcesJson as { local?: { early24hPoints?: number } } | null)?.local?.early24hPoints;
    if (typeof early !== 'number') return null; // pre-outcome feature unavailable -> not matchable
    return {
      mint: r.mint,
      launchTsMs: r.firstObservedAt.getTime(),
      baselineMcapUsd: r.baselineMcapUsd === null ? null : Number(r.baselineMcapUsd),
      earlyPointCount: early,
      // Codex Important-2: unknown-outcome controls are never tier1.
      tier2Only: r.runnerClass === 'insufficient_history'
    };
  };

  // Bounded (Codex Important-6) + stale-match reconciliation: drop matches
  // whose runner is no longer verified before rebuilding.
  await prisma.cohortMatch.deleteMany({
    where: { ...(opts.mintPrefix ? { runnerMint: { startsWith: opts.mintPrefix } } : {}) }
  });
  const MATCH_CAP = 5_000;
  const runnersRaw = await prisma.tokenLifecycle.findMany({
    where: { runnerClass: 'verified_above_10m', ...(opts.mintPrefix ? { mint: { startsWith: opts.mintPrefix } } : {}) },
    orderBy: { mint: 'asc' },
    take: MATCH_CAP,
    select: { mint: true, firstObservedAt: true, baselineMcapUsd: true, sourcesJson: true, runnerClass: true }
  });
  const poolRaw = await prisma.tokenLifecycle.findMany({
    where: { runnerClass: { in: ['verified_below_10m', 'insufficient_history'] }, ...(opts.mintPrefix ? { mint: { startsWith: opts.mintPrefix } } : {}) },
    orderBy: { mint: 'asc' },
    take: MATCH_CAP * 4,
    select: { mint: true, firstObservedAt: true, baselineMcapUsd: true, sourcesJson: true, runnerClass: true }
  });

  const runners = runnersRaw.map(toFeatures).filter((f): f is MatchFeatures => f !== null);
  const pool = poolRaw.map(toFeatures).filter((f): f is MatchFeatures => f !== null);
  const matches = matchControls(runners, pool);

  const report: ControlMatchReport = { runners: matches.length, matchedTier1: 0, matchedTier2: 0, noValidControl: 0 };
  for (const m of matches) {
    if (m.status === 'matched_tier1') report.matchedTier1 += 1;
    else if (m.status === 'matched_tier2') report.matchedTier2 += 1;
    else report.noValidControl += 1;
    const runnerFeatures = runners.find((r) => r.mint === m.runnerMint) ?? null;
    const data = {
      controlMint: m.controlMint,
      status: m.status,
      tier: m.tier,
      distance: m.distance,
      featuresJson: {
        runner: runnerFeatures,
        control: m.controlMint ? pool.find((c) => c.mint === m.controlMint) ?? null : null,
        controlClassCaveat: m.controlMint && pool.find((c) => c.mint === m.controlMint)?.tier2Only
          ? 'control outcome UNKNOWN (insufficient_history) — survivorship caveat, tier2-capped'
          : null,
        note: 'pre-outcome features only: launch anchor ts, baseline mcap, first-24h observation count; venue/holder features unavailable locally (bias recorded)'
      } as Prisma.InputJsonValue,
      excludedJson: m.excluded as unknown as Prisma.InputJsonValue,
      confidence: m.confidence,
      reason: m.reason
    };
    await prisma.cohortMatch.upsert({
      where: { runnerMint: m.runnerMint },
      create: { runnerMint: m.runnerMint, ...data },
      update: data
    });
  }
  return report;
}

export interface EarlyBuyerReport {
  mintsProcessed: number;
  entriesPersisted: number;
  byBand: Record<string, number>;
  unknownMcapSkipped: number;
}

/** Task 4 — early-buyer entries below the research bands for runner + control
 *  mints, tx-anchored, chronological rank, confidence honestly LOW/medium
 *  (local bounded polling cannot prove completeness before an observed trade). */
export async function extractEarlyBuyers(
  prisma: PrismaClient,
  opts: { maxMints?: number } = {}
): Promise<EarlyBuyerReport> {
  const maxMints = opts.maxMints ?? 200;
  const matches = await prisma.cohortMatch.findMany({
    where: { status: { in: ['matched_tier1', 'matched_tier2'] } },
    take: maxMints,
    orderBy: { runnerMint: 'asc' },
    select: { runnerMint: true, controlMint: true }
  });
  const targets: { mint: string; cohort: 'runner' | 'control' }[] = [];
  for (const m of matches) {
    targets.push({ mint: m.runnerMint, cohort: 'runner' });
    if (m.controlMint) targets.push({ mint: m.controlMint, cohort: 'control' });
  }

  const report: EarlyBuyerReport = { mintsProcessed: 0, entriesPersisted: 0, byBand: {}, unknownMcapSkipped: 0 };

  for (const target of targets.slice(0, maxMints)) {
    const token = await prisma.token.findFirst({ where: { address: target.mint, chain: 'SOLANA' }, select: { id: true } });
    if (!token) continue;
    report.mintsProcessed += 1;
    // NO-LOOKAHEAD entry valuation (Codex): marketCapAtTrade may be backdated
    // from a FUTURE snapshot by ingest's fallback, so bands come from
    // computeEntryContext over STRICTLY-PRIOR snapshot observations only;
    // trades without a usable prior snapshot stay unknown (no band).
    const { points } = await loadSeries(prisma, token.id);
    const buys = await prisma.walletTokenTrade.findMany({
      where: { tokenId: token.id, action: 'BUY' },
      orderBy: [{ ts: 'asc' }, { id: 'asc' }],
      take: 5_000,
      select: { ts: true, txHash: true, blockOrSlot: true, marketCapAtTrade: true, wallet: { select: { address: true } } }
    });
    let rank = 0;
    const rankedWallets = new Set<string>();
    for (const b of buys) {
      // Rank = distinct-BUYER chronological rank (Codex Important-5): a wallet's
      // add-on buys reuse its first-buy rank.
      if (!rankedWallets.has(b.wallet.address)) {
        rankedWallets.add(b.wallet.address);
        rank += 1;
      }
      const entryCtx = computeEntryContext(b.ts, points, DEFAULT_RUNNER_MINING_CONFIG);
      const mcap = entryCtx.entryMarketCapUsd;
      const band = earlyEntryBand(mcap);
      if (band === null) {
        if (mcap === null) report.unknownMcapSkipped += 1; // unknown mcap is NOT a band
        continue;
      }
      try {
        await prisma.earlyBuyerEntry.create({
          data: {
            mint: target.mint,
            cohort: target.cohort,
            walletAddress: b.wallet.address,
            txHash: b.txHash,
            blockOrSlot: b.blockOrSlot,
            ts: b.ts,
            entryMcapUsd: mcap,
            band,
            buyerRank: rank,
            // Local bounded polling cannot prove no earlier unobserved buys.
            confidence: 'low',
            sourceJson: {
              source: 'local_snapshot_prior_valuation',
              valuationStatus: entryCtx.valuationStatus,
              valuationAgeSeconds: entryCtx.valuationAgeSeconds,
              note: 'entry mcap = nearest STRICTLY-PRIOR snapshot (no-lookahead); pre-trade coverage completeness unproven (bounded polling)'
            } as Prisma.InputJsonValue
          }
        });
        report.entriesPersisted += 1;
        report.byBand[band] = (report.byBand[band] ?? 0) + 1;
      } catch (err) {
        if (!(typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002')) throw err; // idempotent on rerun
      }
    }
  }
  return report;
}
