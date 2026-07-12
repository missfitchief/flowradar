// FlowRadar — no-lookahead historical signal replay (product-rescue sprint).
//
// For each golden-cohort token (runner AND matched control), walks the
// token's PRICED cohort-wallet buys in chronological order and evaluates the
// candidate state/score AT each buyer-join timestamp T using ONLY evidence
// available at or before T:
//   - buyers observed at <= T (priced trades only);
//   - dormancy / funding observations whose anchor event is <= T (they are
//     strictly-pre-event by construction upstream);
//   - non-cohort crowd = priced non-cohort buys <= T;
//   - post-entry behavior is EXCLUDED (it is post-T by definition) — recorded
//     as a caveat, so DISTRIBUTION_RISK never fires in replay v1;
//   - entity linkage and KOL status are CURRENT-state mappings (no
//     historical wallet-status snapshots exist) — receipted as an
//     approximation, never hidden.
//
// The FIRST T reaching an accumulation state (STEALTH_ACCUMULATION or
// stronger) with a positive score is persisted as the signal event; if no T
// qualifies, the best evaluation point is persisted as no_signal with the
// exact reasons. The LATER OUTCOME (mcap windows, max, drawdown) is computed
// from the no-lookahead price series (candle-END points + local snapshots)
// and stored SEPARATELY — it never feeds the at-event fields.
// Classification: runner+signal=true_positive, runner+none=miss,
// control+signal=false_positive, control+none=true_negative.

import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { deriveCandidateState, candidateScore } from './tokenCandidates';
import type { CandidateState } from './tokenCandidates';
import { entityKeysFor } from './capitalOutflow';
import { enrichmentSeriesPoints } from './enrich';
import { toErrorReceipt, ERROR_RECEIPTS_MAX } from '../dormancy/activity';
import type { WalletErrorReceipt } from '../dormancy/activity';

export const REPLAY_ENGINE_VERSION = 1;

const KOL_STATUSES = ['public_kol', 'public_promoter', 'copytrader'] as const;
const SIGNAL_STATES: CandidateState[] = ['STEALTH_ACCUMULATION', 'EARLY_INDEPENDENT_CONFIRMATION'];

const BASE_CAVEATS = [
  'as-of-T qualification: a wallet joins the qualified walk only from max(first buy, earliest OTHER-mint evidence timestamp); wallets whose only evidence is the replayed token (or whose other-mint evidence is untimestamped) are excluded from qualification but still counted as crowd; externally-seeded cohort wallets without discovery rows are treated as always-qualified',
  'entity linkage and KOL status are current-state mappings (no historical wallet-status snapshots exist) — an approximation, receipted',
  'post-entry behavior is post-T by definition and is EXCLUDED from at-event evidence (distribution risk cannot fire in replay v1)',
  'price series granularity is bounded by 1D candles plus local snapshots — short windows are null where not covered, never interpolated'
];

interface SeriesPoint {
  tsMs: number;
  mcapUsd: number;
}

export interface ReplayBatchReport {
  tokensConsidered: number;
  tokensReplayed: number;
  signals: number;
  noSignals: number;
  byClassification: Record<string, number>;
  errors: number;
  errorReceipts: WalletErrorReceipt[];
}

/** Last observation at/before tsMs, but only if it is FRESH ENOUGH
 *  (maxAgeMs) — a months-old candle is not "the market cap at signal". */
function mcapAtOrBefore(series: SeriesPoint[], tsMs: number, maxAgeMs: number): number | null {
  let best: SeriesPoint | null = null;
  for (const p of series) {
    if (p.tsMs <= tsMs) best = p;
    else break;
  }
  if (best === null || tsMs - best.tsMs > maxAgeMs) return null;
  return best.mcapUsd;
}

/** First observation inside [target, target + tolerance] — an observation far
 *  past the window must NOT masquerade as that window's value (null instead,
 *  never fabricated). */
function firstInWindow(series: SeriesPoint[], targetMs: number, toleranceMs: number): number | null {
  for (const p of series) {
    if (p.tsMs >= targetMs) {
      return p.tsMs <= targetMs + toleranceMs ? p.mcapUsd : null;
    }
  }
  return null;
}

/** TRUE maximum drawdown after the signal: worst peak-to-trough decline over
 *  the later series (running-peak scan seeded at the signal baseline). */
function maxDrawdownPctAfter(later: SeriesPoint[], baseline: number | null): number | null {
  if (later.length === 0) return null;
  let peak = baseline !== null && baseline > 0 ? baseline : later[0].mcapUsd;
  let worst = 0;
  for (const p of later) {
    if (p.mcapUsd > peak) peak = p.mcapUsd;
    else if (peak > 0) worst = Math.min(worst, (p.mcapUsd - peak) / peak);
  }
  return worst * 100;
}

export async function runNoLookaheadReplay(
  prisma: PrismaClient,
  opts: { chain?: 'SOLANA' | 'BSC'; limit?: number; now?: Date } = {}
): Promise<ReplayBatchReport> {
  const chain = opts.chain ?? 'SOLANA';
  const limit = opts.limit ?? 60;
  const now = opts.now ?? new Date();

  const members = await prisma.goldenCohortMember.findMany({
    where: { chain, kind: { in: ['token', 'control_token'] } },
    orderBy: [{ kind: 'asc' }, { rank: 'asc' }],
    take: limit,
    select: { kind: true, key: true }
  });
  // Buyer universe: golden-cohort wallets UNION every wallet with LOCAL
  // top-PnL evidence (the qualified discovery universe) — maximizes honest
  // replay coverage without ever touching provider-only wallets.
  //
  // ANTI-CIRCULARITY (binding): a wallet discovered BECAUSE of token X must
  // not count as "qualified" when replaying X itself — that would leak the
  // outcome into the signal. Per replayed mint, only wallets with local
  // evidence on at least one OTHER mint stay in that mint's buyer universe.
  // Residual approximation (qualification is full-history, not a historical
  // snapshot) is receipted on every event.
  const [goldenWallets, discoveryRows] = await Promise.all([
    prisma.goldenCohortMember.findMany({
      where: { chain, kind: 'wallet' },
      orderBy: { rank: 'asc' },
      select: { key: true }
    }),
    prisma.tokenTopPnlCandidate.findMany({
      where: { chain, validation: { notIn: ['provider_only', 'invalid'] } },
      orderBy: [{ walletAddress: 'asc' }, { mint: 'asc' }],
      take: 20_000,
      select: { walletAddress: true, mint: true, localFirstBuyTs: true, localFirstSellTs: true }
    })
  ]);
  // Per-wallet evidence rows WITH their earliest local timestamp — the basis
  // for AS-OF-T qualification (a wallet is qualified at T only once its
  // evidence on some OTHER mint had already occurred at <= T).
  const evidenceOf = new Map<string, { mint: string; tsMs: number | null }[]>();
  for (const r of discoveryRows) {
    const list = evidenceOf.get(r.walletAddress) ?? [];
    const candidates = [r.localFirstBuyTs?.getTime(), r.localFirstSellTs?.getTime()].filter(
      (x): x is number => x !== undefined && x !== null
    );
    list.push({ mint: r.mint, tsMs: candidates.length > 0 ? Math.min(...candidates) : null });
    evidenceOf.set(r.walletAddress, list);
  }
  const cohortWallets = [
    ...new Set([...goldenWallets.map((w) => w.key), ...evidenceOf.keys()])
  ].sort();

  const walletRows = await prisma.wallet.findMany({
    where: { chain, address: { in: cohortWallets } },
    select: { id: true, address: true, status: true }
  });
  const addressOfId = new Map(walletRows.map((w) => [w.id, w.address]));
  const kolSet = new Set(
    walletRows.filter((w) => (KOL_STATUSES as readonly string[]).includes(w.status)).map((w) => w.address)
  );
  const entityOf = await entityKeysFor(prisma, chain, cohortWallets);
  const cohortIds = walletRows.map((w) => w.id);

  const report: ReplayBatchReport = {
    tokensConsidered: members.length,
    tokensReplayed: 0,
    signals: 0,
    noSignals: 0,
    byClassification: {},
    errors: 0,
    errorReceipts: []
  };

  for (const member of members) {
    const mint = member.key;
    const cohortKind = member.kind === 'token' ? 'runner' : 'control';
    try {
      // AS-OF-T QUALIFICATION + ANTI-CIRCULARITY: a wallet is qualified for
      // this mint only from the moment its earliest evidence on some OTHER
      // mint occurred (qualifiedFromMs). Wallets whose only evidence is this
      // very mint — or whose other-mint evidence carries no timestamp — are
      // excluded (their qualification cannot be honestly placed before T).
      // Wallets with no discovery rows at all (externally seeded cohort
      // members) are treated as always-qualified — receipted below.
      const qualifiedFromMs = new Map<string, number>();
      for (const w of cohortWallets) {
        const ev = evidenceOf.get(w);
        if (!ev) {
          qualifiedFromMs.set(w, 0);
          continue;
        }
        const others = ev.filter((e) => e.mint !== mint && e.tsMs !== null).map((e) => e.tsMs as number);
        if (others.length > 0) qualifiedFromMs.set(w, Math.min(...others));
      }
      const eligibleWallets = cohortWallets.filter((w) => qualifiedFromMs.has(w));
      const eligibleIds = walletRows.filter((w) => eligibleWallets.includes(w.address)).map((w) => w.id);
      // Cohort wallets NOT eligible for this mint remain OBSERVABLE buyers —
      // their priced buys count as crowd evidence, never silently vanish.
      const excludedIds = walletRows
        .filter((w) => !qualifiedFromMs.has(w.address))
        .map((w) => w.id);
      const token = await prisma.token.findUnique({
        where: { chain_address: { chain, address: mint } },
        select: { id: true }
      });
      if (!token) {
        report.tokensReplayed += 1;
        continue;
      }

      // --- No-lookahead price series: candle-END points + local snapshots ---
      const enrichment = await prisma.tokenEnrichment.findUnique({
        where: { mint },
        select: { candlesJson: true, supplyJson: true }
      });
      const series: SeriesPoint[] = [];
      if (enrichment) {
        for (const p of enrichmentSeriesPoints(enrichment)) {
          if (p.marketCapUsd !== null && p.marketCapUsd > 0) {
            series.push({ tsMs: p.ts.getTime(), mcapUsd: p.marketCapUsd });
          }
        }
      }
      // REAL provider observations only — synthetic seed continuations must
      // never enter the outcome series (fabricated prices are not proof).
      const snapshots = await prisma.tokenMarketSnapshot.findMany({
        where: { tokenId: token.id, source: { not: { contains: 'synthetic' } } },
        orderBy: [{ ts: 'asc' }, { id: 'asc' }],
        take: 50_000,
        select: { ts: true, marketCapUsd: true }
      });
      for (const s of snapshots) {
        const m = Number(s.marketCapUsd);
        if (m > 0) series.push({ tsMs: s.ts.getTime(), mcapUsd: m });
      }
      series.sort((a, b) => a.tsMs - b.tsMs);

      // --- Chronological priced buys: cohort + non-cohort cursors -----------
      const cohortBuys = await prisma.walletTokenTrade.findMany({
        where: { tokenId: token.id, chain, action: 'BUY', walletId: { in: eligibleIds }, amountUsd: { gt: 0 } },
        orderBy: [{ ts: 'asc' }, { id: 'asc' }],
        take: 5000,
        select: { walletId: true, ts: true, amountUsd: true }
      });
      // Crowd = non-cohort buyers PLUS cohort wallets excluded for THIS mint
      // (observable buys are evidence of buying pressure either way).
      const [nonCohortOnly, excludedCohortBuys] = await Promise.all([
        prisma.walletTokenTrade.findMany({
          where: { tokenId: token.id, chain, action: 'BUY', walletId: { notIn: cohortIds }, amountUsd: { gt: 0 } },
          orderBy: [{ ts: 'asc' }, { id: 'asc' }],
          take: 20_000,
          select: { walletId: true, ts: true }
        }),
        excludedIds.length > 0
          ? prisma.walletTokenTrade.findMany({
              where: { tokenId: token.id, chain, action: 'BUY', walletId: { in: excludedIds }, amountUsd: { gt: 0 } },
              orderBy: [{ ts: 'asc' }, { id: 'asc' }],
              take: 5000,
              select: { walletId: true, ts: true }
            })
          : Promise.resolve([] as { walletId: string; ts: Date }[])
      ]);
      const nonCohortBuys = [...nonCohortOnly, ...excludedCohortBuys].sort(
        (a, b) => a.ts.getTime() - b.ts.getTime()
      );

      // Pre-fetch anchored evidence for this mint (filtered by <= T later).
      const [dormantObs, fundedPaths] = await Promise.all([
        prisma.addressDormancyObservation.findMany({
          where: { chain, anchorKey: mint, walletAddress: { in: eligibleWallets }, overallClass: 'covered_dormant' },
          select: { walletAddress: true, eventTs: true }
        }),
        prisma.fundingReactivationPath.findMany({
          where: { chain, anchorKey: mint, walletAddress: { in: eligibleWallets }, status: 'funded' },
          select: { walletAddress: true, eventTs: true }
        })
      ]);

      // --- Walk buyer-join events ------------------------------------------
      // A buyer JOINS the qualified walk at max(first buy, qualification
      // moment) — a buy made before the wallet's other-mint evidence existed
      // cannot be counted as qualified accumulation at that earlier time.
      const seenBuyers = new Set<string>();
      const buyerJoinEvents: { ts: Date; buyer: string }[] = [];
      for (const b of cohortBuys) {
        const buyer = addressOfId.get(b.walletId);
        if (!buyer || seenBuyers.has(buyer)) continue;
        seenBuyers.add(buyer);
        const qualMs = qualifiedFromMs.get(buyer) ?? 0;
        buyerJoinEvents.push({ ts: b.ts.getTime() >= qualMs ? b.ts : new Date(qualMs), buyer });
      }
      buyerJoinEvents.sort((a, b) => a.ts.getTime() - b.ts.getTime());

      interface EvalPoint {
        ts: Date;
        state: CandidateState;
        score: number;
        entities: number;
        buyers: number;
        dormant: number;
        funded: number;
        kol: number;
        crowd: number;
        buyersList: string[];
        reasons: string[];
      }
      let signal: EvalPoint | null = null;
      let best: EvalPoint | null = null;

      const buyersSoFar: string[] = [];
      let nonCohortIdx = 0;
      const nonCohortSeen = new Set<string>();
      for (const ev of buyerJoinEvents) {
        buyersSoFar.push(ev.buyer);
        const tMs = ev.ts.getTime();
        while (nonCohortIdx < nonCohortBuys.length && nonCohortBuys[nonCohortIdx].ts.getTime() <= tMs) {
          nonCohortSeen.add(nonCohortBuys[nonCohortIdx].walletId);
          nonCohortIdx += 1;
        }
        const clean = buyersSoFar.filter((a) => !kolSet.has(a));
        const kol = buyersSoFar.length - clean.length;
        const entities = new Set(clean.map((a) => entityOf.get(a) ?? a)).size;
        const dormant = dormantObs.filter(
          (o) => clean.includes(o.walletAddress) && o.eventTs.getTime() <= tMs
        ).length;
        const funded = fundedPaths.filter(
          (o) => clean.includes(o.walletAddress) && o.eventTs.getTime() <= tMs
        ).length;
        const { state, reasonCodes } = deriveCandidateState({
          invalidated: false, // the outcome is UNKNOWN at T — never applied
          qualifiedWithPostEntry: 0, // post-entry evidence is post-T (caveat)
          distributionBehaviorCount: 0,
          kolContamination: kol,
          cohortBuyers: clean.length,
          nonCohortBuyers: nonCohortSeen.size,
          independentEntityCount: entities
        });
        const score = candidateScore({
          independentEntityCount: entities,
          dormantReactivations: dormant,
          fundedPathCount: funded,
          receiverDeployments: 0, // receiver enrollment postdates these events
          durableBehaviorCount: 0,
          qualifiedWithPostEntry: 0,
          kolContamination: kol,
          state
        });
        const snapshotEval = {
          ts: ev.ts,
          state,
          score,
          entities,
          buyers: buyersSoFar.length,
          dormant,
          funded,
          kol,
          crowd: nonCohortSeen.size,
          buyersList: [...buyersSoFar].slice(0, 25),
          reasons: reasonCodes
        };
        if (signal === null && score > 0 && SIGNAL_STATES.includes(state)) {
          signal = snapshotEval;
        }
        if (
          best === null ||
          snapshotEval.score > best.score ||
          (snapshotEval.score === best.score && snapshotEval.entities > best.entities)
        ) {
          best = snapshotEval;
        }
      }

      let chosen = signal ?? best;
      let unpricedOnly = false;
      if (!chosen) {
        // No PRICED cohort buys. If UNPRICED cohort buys exist, the token was
        // still evaluated — and under the honesty rules a signal is
        // IMPOSSIBLE from unpriced evidence, so it is an honest no_signal
        // (never skipped, never priced by fabrication).
        const unpricedFirst = await prisma.walletTokenTrade.findFirst({
          where: { tokenId: token.id, chain, action: 'BUY', walletId: { in: eligibleIds }, amountUsd: { lte: 0 } },
          orderBy: [{ ts: 'asc' }, { id: 'asc' }],
          select: { ts: true }
        });
        if (!unpricedFirst) {
          report.tokensReplayed += 1; // no cohort exposure at all — nothing to replay
          continue;
        }
        unpricedOnly = true;
        chosen = {
          ts: unpricedFirst.ts,
          state: 'WATCHING',
          score: 0,
          entities: 0,
          buyers: 0,
          dormant: 0,
          funded: 0,
          kol: 0,
          crowd: 0,
          buyersList: [],
          reasons: ['unpriced_only_coverage_signal_impossible']
        };
      }
      const eventKind = signal !== null ? 'signal' : 'no_signal';
      const tMs = chosen.ts.getTime();

      // --- Outcome (recorded separately; never feeds at-event fields) -------
      // At-signal mcap must be a FRESH prior observation (<= 48h, the same
      // staleness bound the valuation backfill uses); each later window
      // accepts only an observation within ONE window-length past its target
      // — otherwise the field stays null (uncovered, never fabricated).
      const mcapAtSignal = mcapAtOrBefore(series, tMs, 48 * 3_600_000);
      const later = series.filter((p) => p.tsMs > tMs);
      const maxLater = later.length > 0 ? Math.max(...later.map((p) => p.mcapUsd)) : null;
      const drawdown = maxDrawdownPctAfter(later, mcapAtSignal);
      const windows = {
        h1: firstInWindow(series, tMs + 3_600_000, 3_600_000),
        h6: firstInWindow(series, tMs + 6 * 3_600_000, 6 * 3_600_000),
        h24: firstInWindow(series, tMs + 24 * 3_600_000, 24 * 3_600_000),
        d3: firstInWindow(series, tMs + 3 * 86_400_000, 3 * 86_400_000),
        d7: firstInWindow(series, tMs + 7 * 86_400_000, 7 * 86_400_000)
      };

      const classification =
        cohortKind === 'runner'
          ? eventKind === 'signal'
            ? 'true_positive'
            : 'miss'
          : eventKind === 'signal'
            ? 'false_positive'
            : 'true_negative';

      const caveats = [...BASE_CAVEATS];
      if (series.length === 0) caveats.push('no usable price series — outcome fields are null, never fabricated');
      if (unpricedOnly) {
        caveats.push(
          'cohort exposure exists but every buy is unpriced — a signal is impossible under the unknown-never-evidence rule; this row records honest evaluation coverage, not absence of interest'
        );
      }

      const data = {
        chain,
        mint,
        cohortKind,
        eventTs: chosen.ts,
        eventKind,
        scoreAtEvent: chosen.score,
        stateAtEvent: chosen.state,
        independentEntitiesAtEvent: chosen.entities,
        buyersAtEvent: chosen.buyers,
        dormantReactivationsAtEvent: chosen.dormant,
        fundedPathsAtEvent: chosen.funded,
        kolContaminationAtEvent: chosen.kol,
        evidenceAsOfJson: {
          buyers: chosen.buyersList,
          crowdBuyersAtEvent: chosen.crowd,
          stateReasons: chosen.reasons,
          evaluationPoints: buyerJoinEvents.length
        } as unknown as Prisma.InputJsonValue,
        mcapAtSignalUsd: mcapAtSignal,
        mcapH1Usd: windows.h1,
        mcapH6Usd: windows.h6,
        mcapH24Usd: windows.h24,
        mcapD3Usd: windows.d3,
        mcapD7Usd: windows.d7,
        maxLaterMcapUsd: maxLater,
        maxDrawdownPct: drawdown,
        classification,
        outcomeJson: {
          seriesPoints: series.length,
          laterPoints: later.length,
          runnerClassBasis: cohortKind === 'runner' ? 'verified_above_10m' : 'matched_control'
        } as unknown as Prisma.InputJsonValue,
        reasonCodes: chosen.reasons,
        caveats,
        engineVersion: REPLAY_ENGINE_VERSION,
        computedAt: now
      };
      // One row per (mint, eventKind); a signal replaces any previous
      // no_signal row for the mint (and vice versa) so the feed stays honest.
      await prisma.replaySignalEvent.deleteMany({
        where: { chain, mint, eventKind: eventKind === 'signal' ? 'no_signal' : 'signal' }
      });
      await prisma.replaySignalEvent.upsert({
        where: { chain_mint_eventKind: { chain, mint, eventKind } },
        create: data,
        update: data
      });
      if (eventKind === 'signal') report.signals += 1;
      else report.noSignals += 1;
      report.byClassification[classification] = (report.byClassification[classification] ?? 0) + 1;
      report.tokensReplayed += 1;
    } catch (err) {
      report.errors += 1;
      if (report.errorReceipts.length < ERROR_RECEIPTS_MAX) {
        report.errorReceipts.push(toErrorReceipt(mint, err));
      }
    }
  }
  return report;
}
