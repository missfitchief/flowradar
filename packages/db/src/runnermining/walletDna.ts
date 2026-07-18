// FlowRadar — Wallet DNA builder (runner-mining scope correction).
//
// One OBSERVATION-ONLY row per discovered wallet, aggregating:
//   - COMPLETE cross-token local history (winners AND losers/rugs/dead) via
//     the existing behavior-reconstruction engine (persists
//     wallet_behavior_profiles — reused, never rebuilt);
//   - WR / EV over COMPLETED positions only: explicit denominators, open
//     positions never count as wins or losses, unpriced positions are
//     excluded from W/L and counted separately, winRate is NULL (never 0)
//     when no position ever completed;
//   - one-winner dependence EXPOSED (top winner's share of positive proxy);
//   - outcome mix from token_lifecycles (never inferred);
//   - dormancy / funding / post-entry summaries joined from the T7-T10
//     shadow tables; negative evidence from the T11 entity rows;
//   - discovery receipts (which mints/sources surfaced the wallet).
//
// Provider-claimed PnL NEVER enters DNA metrics (discovery evidence only).
// Coverage-adjusted confidence; status is the constant 'observation_only'.
// Idempotent (chain, wallet) upserts; bounded; per-wallet error receipts.
// SHADOW-ONLY: never read by FlowScore/signals/eligibility.

import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';
import type { TokenPositionSummary } from '@flowradar/core';
import { reconstructWalletBehavior } from '../behavior/reconstruct';
import { toErrorReceipt, ERROR_RECEIPTS_MAX } from '../dormancy/activity';
import type { WalletErrorReceipt } from '../dormancy/activity';

export const WALLET_DNA_ENGINE_VERSION = 1;

const BASE_CAVEATS = [
  'observation-only: DNA rows grant no votes, no eligibility, no promotion; wallets stay observation_only',
  'W/L accounting is a USD proxy (proceeds vs cost) over locally observed trades — open and unpriced positions never count as wins or losses',
  'coverage is bounded local polling — absence of history is recorded as reduced coverage, never as safety or failure'
];

export interface WalletDnaBatchReport {
  walletsConsidered: number;
  walletsWritten: number;
  errors: number;
  errorReceipts: WalletErrorReceipt[];
  byCoverage: Record<string, number>;
  reconstructed: number;
}

export async function buildWalletDnaProfiles(
  prisma: PrismaClient,
  opts: {
    chain?: 'SOLANA' | 'BSC';
    /** Explicit cohort; default = distinct wallets in token_top_pnl_candidates. */
    walletAddresses?: string[];
    limit?: number;
    /** Reconstruct missing behavior profiles (default true). */
    reconstructMissing?: boolean;
    /** Force behavior re-reconstruction even when a profile exists — needed
     *  after a valuation backfill changed the underlying trades. */
    forceReconstruct?: boolean;
    maxTrades?: number;
    now?: Date;
  } = {}
): Promise<WalletDnaBatchReport> {
  const chain = opts.chain ?? 'SOLANA';
  const limit = opts.limit ?? 300;
  const reconstructMissing = opts.reconstructMissing !== false;
  const forceReconstruct = opts.forceReconstruct === true;
  const now = opts.now ?? new Date();

  let wallets: string[];
  if (opts.walletAddresses) {
    wallets = [...new Set(opts.walletAddresses)].sort().slice(0, limit);
  } else {
    const rows = await prisma.tokenTopPnlCandidate.findMany({
      where: { chain },
      orderBy: [{ walletAddress: 'asc' }],
      select: { walletAddress: true },
      distinct: ['walletAddress'],
      take: limit
    });
    wallets = rows.map((r) => r.walletAddress);
  }

  // Runner mints + outcome map (bounded, stable) for the outcome mix.
  const lifecycles = await prisma.tokenLifecycle.findMany({
    where: { runnerClass: { not: null } },
    orderBy: { mint: 'asc' },
    take: 20_000,
    select: { mint: true, runnerClass: true, outcomeLabels: true }
  });
  const outcomeOf = new Map<string, string>();
  const runnerMints = new Set<string>();
  for (const lc of lifecycles) {
    if (lc.runnerClass === 'verified_above_10m') runnerMints.add(lc.mint);
    const labels = Array.isArray(lc.outcomeLabels) ? (lc.outcomeLabels as string[]) : [];
    if (labels.includes('rug_or_collapse')) outcomeOf.set(lc.mint, 'rug');
    else if (labels.includes('failed_launch') || labels.includes('illiquid_untradeable')) outcomeOf.set(lc.mint, 'dead');
    else if (lc.runnerClass === 'verified_above_10m') outcomeOf.set(lc.mint, 'runner');
    else if (lc.runnerClass === 'verified_below_10m') outcomeOf.set(lc.mint, 'flat');
  }

  const report: WalletDnaBatchReport = {
    walletsConsidered: wallets.length,
    walletsWritten: 0,
    errors: 0,
    errorReceipts: [],
    byCoverage: {},
    reconstructed: 0
  };

  for (const walletAddress of wallets) {
    try {
      // 1. Behavior profile (existing engine; reconstruct when missing).
      let profileRow = forceReconstruct
        ? null
        : await prisma.walletBehaviorProfile.findUnique({
            where: { chain_walletAddress: { chain, walletAddress } },
            select: { profileJson: true }
          });
      if (!profileRow && (reconstructMissing || forceReconstruct)) {
        await reconstructWalletBehavior(prisma, { chain, address: walletAddress }, {
          now,
          maxTrades: opts.maxTrades
        });
        report.reconstructed += 1;
        profileRow = await prisma.walletBehaviorProfile.findUnique({
          where: { chain_walletAddress: { chain, walletAddress } },
          select: { profileJson: true }
        });
      }
      const profile = (profileRow?.profileJson ?? null) as unknown as {
        localViewTruncated?: boolean;
        local?: { tokenPositions?: TokenPositionSummary[] };
      } | null;
      const positions = (profile?.local?.tokenPositions ?? []).filter((tp) => tp.firstBuyTs !== null);
      const truncated = profile?.localViewTruncated === true;

      // Trade-level honesty check: position aggregates hide MIXED
      // priced/unpriced legs (buyUsd > 0 can coexist with unknown-value
      // legs, silently corrupting cost basis). Any token with at least one
      // unpriced BUY/SELL leg is excluded from W/L and counted as unpriced.
      const walletRow = await prisma.wallet.findUnique({
        where: { address_chain: { address: walletAddress, chain } },
        select: { id: true }
      });
      const tokensWithUnpricedLegs = new Set<string>(
        walletRow
          ? (
              await prisma.walletTokenTrade.findMany({
                where: { walletId: walletRow.id, chain, action: { in: ['BUY', 'SELL'] }, amountUsd: 0 },
                select: { token: { select: { address: true } } },
                distinct: ['tokenId'],
                take: 5000
              })
            ).map((t) => t.token.address)
          : []
      );

      // 2. Completed-position W/L + EV (explicit denominators; USD proxy).
      let completed = 0;
      let open = 0;
      let unpriced = 0;
      let winCount = 0;
      let lossCount = 0;
      let evSum = 0;
      const positiveProxies: number[] = [];
      const returns: number[] = [];
      const entryMcaps: number[] = [];
      const completedRunnerWins = new Set<string>();
      const runnerMintsEntered = new Set<string>();
      let deadRugEntered = 0;
      let runnersEntered = 0;
      const outcomeMix: Record<string, number> = {};
      for (const pos of positions) {
        if (runnerMints.has(pos.tokenAddress)) {
          runnersEntered += 1;
          runnerMintsEntered.add(pos.tokenAddress);
        }
        const outcome = outcomeOf.get(pos.tokenAddress) ?? 'unknown';
        outcomeMix[outcome] = (outcomeMix[outcome] ?? 0) + 1;
        if (outcome === 'rug' || outcome === 'dead') deadRugEntered += 1;
        if (pos.entryMcap !== null && Number.isFinite(pos.entryMcap) && pos.entryMcap > 0) {
          entryMcaps.push(pos.entryMcap);
        }
        const priced = pos.buyUsd > 0 && !tokensWithUnpricedLegs.has(pos.tokenAddress);
        if (!priced) {
          unpriced += 1; // fully-unpriced OR mixed-leg position: never W/L
          continue;
        }
        const fullyExited = pos.exitRatio !== null && pos.exitRatio >= 0.95 && pos.fullExitSec !== null;
        if (!fullyExited) {
          open += 1; // still-holding or partially exited: NEVER a win or loss
          continue;
        }
        completed += 1;
        const proxy = pos.sellUsd - pos.buyUsd;
        evSum += proxy;
        returns.push(proxy / pos.buyUsd);
        if (proxy > 0) {
          winCount += 1;
          positiveProxies.push(proxy);
          if (runnerMints.has(pos.tokenAddress)) completedRunnerWins.add(pos.tokenAddress);
        } else if (proxy < 0) {
          lossCount += 1;
        }
        // proxy === 0: completed but neither win nor loss (tie, receipted via counts).
      }
      const winRate = completed > 0 ? winCount / completed : null;
      const ev = completed > 0 ? evSum / completed : null;
      const positiveTotal = positiveProxies.reduce((a, b) => a + b, 0);
      const oneWinnerDependence =
        positiveProxies.length > 0 && positiveTotal > 0 ? Math.max(...positiveProxies) / positiveTotal : null;
      const median = (v: number[]): number | null => {
        if (v.length === 0) return null;
        const s = [...v].sort((a, b) => a - b);
        return s.length % 2 === 1 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
      };
      const avgReturn = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : null;
      const medianReturn = median(returns);
      const totalRealizedPnlUsd = completed > 0 ? evSum : null;
      // Repeat-runner: DISTINCT verified runner mints with a completed
      // positive position; rate over distinct runner mints entered.
      const repeatRunnerCount = completedRunnerWins.size;
      const repeatRunnerRate = runnerMintsEntered.size > 0 ? repeatRunnerCount / runnerMintsEntered.size : null;
      const medianEntryMcapUsd = median(entryMcaps);
      const deadRugExposureRate = positions.length > 0 ? deadRugEntered / positions.length : null;

      // 3. Shadow-table summaries (bounded groupBys).
      const [dormancy, entity, funding, postEntry, repeatRows, discovery] = await Promise.all([
        prisma.addressDormancyObservation.groupBy({
          by: ['overallClass'],
          where: { chain, walletAddress },
          _count: { _all: true }
        }),
        prisma.entityDormancyObservation.groupBy({
          by: ['entityClass'],
          where: { chain, walletAddress },
          _count: { _all: true }
        }),
        prisma.fundingReactivationPath.groupBy({
          by: ['status'],
          where: { chain, walletAddress },
          _count: { _all: true }
        }),
        prisma.postEntryBehavior.groupBy({
          by: ['primaryClass'],
          where: { chain, walletAddress },
          _count: { _all: true }
        }),
        prisma.repeatRunnerCandidate.findMany({
          where: { chain, memberWallets: { has: walletAddress } },
          orderBy: { entityKey: 'asc' },
          take: 3,
          select: { entityKey: true, status: true, negativeEvidenceJson: true }
        }),
        prisma.tokenTopPnlCandidate.findMany({
          where: { chain, walletAddress },
          orderBy: [{ mint: 'asc' }, { source: 'asc' }],
          take: 50,
          select: { mint: true, source: true, validation: true, providerRank: true }
        })
      ]);

      // 4. Coverage-adjusted confidence.
      let coverage: 'full' | 'partial' | 'minimal';
      if (positions.length === 0) coverage = 'minimal';
      else if (truncated || unpriced > 0) coverage = 'partial';
      else coverage = 'full';
      const confidence = coverage === 'full' ? 70 : coverage === 'partial' ? 45 : 20;
      const caveats = [...BASE_CAVEATS];
      if (coverage === 'minimal') {
        caveats.push('no locally observed entries — DNA metrics are empty by honesty, not evidence of inactivity');
      }
      if (unpriced > 0) {
        caveats.push(`${unpriced} position(s) unpriced — excluded from W/L and EV rather than fabricated`);
      }

      const data = {
        chain,
        walletAddress,
        status: 'observation_only',
        tokensEntered: positions.length,
        runnersEntered,
        completedPositions: completed,
        openPositions: open,
        unpricedPositions: unpriced,
        winCount,
        lossCount,
        winRate,
        evUsdPerCompletedPosition: ev,
        oneWinnerDependence,
        avgReturn,
        medianReturn,
        totalRealizedPnlUsd,
        repeatRunnerCount,
        repeatRunnerRate,
        medianEntryMcapUsd,
        fastDumpRate: (() => {
          const total = postEntry.reduce((a, g) => a + g._count._all, 0);
          if (total === 0) return null;
          const fast = postEntry
            .filter((g) => ['fast_flip', 'fast_dump', 'burst_exit'].includes(g.primaryClass))
            .reduce((a, g) => a + g._count._all, 0);
          return fast / total;
        })(),
        deadRugExposureRate,
        outcomeMixJson: outcomeMix as unknown as Prisma.InputJsonValue,
        dormancySummaryJson: {
          address: Object.fromEntries(dormancy.map((g) => [g.overallClass, g._count._all])),
          entity: Object.fromEntries(entity.map((g) => [g.entityClass, g._count._all]))
        } as unknown as Prisma.InputJsonValue,
        fundingSummaryJson: Object.fromEntries(
          funding.map((g) => [g.status, g._count._all])
        ) as unknown as Prisma.InputJsonValue,
        postEntryMixJson: Object.fromEntries(
          postEntry.map((g) => [g.primaryClass, g._count._all])
        ) as unknown as Prisma.InputJsonValue,
        negativeEvidenceJson: repeatRows.map((r) => ({
          entityKey: r.entityKey,
          status: r.status,
          classes: (r.negativeEvidenceJson as { classes?: string[] } | null)?.classes ?? []
        })) as unknown as Prisma.InputJsonValue,
        discoveryJson: discovery as unknown as Prisma.InputJsonValue,
        coverage,
        confidence,
        reasonCodes: [
          completed > 0 ? 'completed_positions_present' : 'no_completed_positions',
          ...(truncated ? ['local_view_truncated'] : [])
        ],
        receiptsJson: {
          winLossDenominator: completed,
          tieCompletedPositions: completed - winCount - lossCount,
          positionsConsidered: positions.length,
          localViewTruncated: truncated
        } as unknown as Prisma.InputJsonValue,
        caveats,
        engineVersion: WALLET_DNA_ENGINE_VERSION,
        computedAt: now
      };
      await prisma.walletDnaProfile.upsert({
        where: { chain_walletAddress: { chain, walletAddress } },
        create: data,
        update: data
      });
      report.walletsWritten += 1;
      report.byCoverage[coverage] = (report.byCoverage[coverage] ?? 0) + 1;
    } catch (err) {
      report.errors += 1;
      if (report.errorReceipts.length < ERROR_RECEIPTS_MAX) {
        report.errorReceipts.push(toErrorReceipt(walletAddress, err));
      }
    }
  }
  return report;
}
