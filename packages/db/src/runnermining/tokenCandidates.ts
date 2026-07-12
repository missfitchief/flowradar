// FlowRadar — automatic token-candidate feed (working-loop milestone).
//
// Candidate mints are DISCOVERED (never operator-supplied): every token
// bought by (a) a qualified DNA wallet or (b) an enrolled receiver is a
// candidate. Per mint the builder computes the full evidence block —
// qualified/independent entities buying, linked addresses, dormant
// reactivations, funding paths, alt/side-wallet evidence, post-entry
// behavior mix, KOL contamination, current observed mcap — and derives a
// lifecycle STATE using the StealthState vocabulary from MINING evidence
// (stateBasis 'mining_derived'). When the live stealth engine has a
// persisted StealthSnapshot for the token it is recorded SIDE BY SIDE
// (never overridden, never fabricated).
//
// The score is a SHADOW ranking with documented deterministic weights —
// NOT a FlowScore; it never feeds signals, thresholds, or eligibility.
// KOL/copytrader buyers only ever REDUCE the score (contamination).
// Unknowns lower confidence — they never raise state or score.
// Bounded + stable-ordered; per-mint error isolation; idempotent upserts.

import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { toErrorReceipt, ERROR_RECEIPTS_MAX } from '../dormancy/activity';
import type { WalletErrorReceipt } from '../dormancy/activity';
import { entityKeysFor } from './capitalOutflow';

export const TOKEN_CANDIDATE_ENGINE_VERSION = 1;

export type CandidateState =
  | 'WATCHING'
  | 'STEALTH_ACCUMULATION'
  | 'EARLY_INDEPENDENT_CONFIRMATION'
  | 'PUBLIC_KOL_ARRIVAL'
  | 'CROWD_EXPANSION'
  | 'DISTRIBUTION_RISK'
  | 'INVALIDATED';

const KOL_STATUSES = ['public_kol', 'public_promoter', 'copytrader'] as const;
const DISTRIBUTION_CLASSES = ['full_exit', 'fast_dump', 'burst_exit', 'staged_distribution', 'fast_flip'];

const BASE_CAVEATS = [
  'shadow ranking with documented deterministic weights — NOT a FlowScore; never feeds signals, thresholds, or eligibility',
  'candidate discovery is bounded local observation — unobserved buys cannot be excluded, absence is never evidence',
  'observation-only: every wallet referenced stays observation_only; KOL/copytrader presence only ever reduces the score'
];

/** PURE state derivation (exported for unit pinning). Precedence is fixed:
 *  invalidation > distribution risk > KOL arrival > crowd > confirmation >
 *  stealth > watching. Unknown inputs can only produce LOWER states. */
export function deriveCandidateState(input: {
  invalidated: boolean;
  qualifiedWithPostEntry: number;
  distributionBehaviorCount: number;
  kolContamination: number;
  cohortBuyers: number;
  nonCohortBuyers: number;
  independentEntityCount: number;
}): { state: CandidateState; reasonCodes: string[] } {
  const reasons: string[] = [];
  if (input.invalidated) {
    return { state: 'INVALIDATED', reasonCodes: ['token_outcome_invalidated'] };
  }
  if (input.qualifiedWithPostEntry > 0 && input.distributionBehaviorCount * 2 >= input.qualifiedWithPostEntry) {
    reasons.push(`distribution_behavior_${input.distributionBehaviorCount}_of_${input.qualifiedWithPostEntry}`);
    return { state: 'DISTRIBUTION_RISK', reasonCodes: reasons };
  }
  if (input.kolContamination > 0) {
    reasons.push(`kol_or_copytrader_buyers:${input.kolContamination}`);
    return { state: 'PUBLIC_KOL_ARRIVAL', reasonCodes: reasons };
  }
  if (input.cohortBuyers > 0 && input.nonCohortBuyers >= Math.max(20, 5 * input.cohortBuyers)) {
    reasons.push(`non_cohort_buyers_${input.nonCohortBuyers}_vs_cohort_${input.cohortBuyers}`);
    return { state: 'CROWD_EXPANSION', reasonCodes: reasons };
  }
  if (input.independentEntityCount >= 3) {
    reasons.push(`independent_entities:${input.independentEntityCount}`);
    return { state: 'EARLY_INDEPENDENT_CONFIRMATION', reasonCodes: reasons };
  }
  if (input.independentEntityCount >= 2) {
    reasons.push(`independent_entities:${input.independentEntityCount}`);
    return { state: 'STEALTH_ACCUMULATION', reasonCodes: reasons };
  }
  reasons.push('single_entity_observed');
  return { state: 'WATCHING', reasonCodes: reasons };
}

/** PURE score (exported for unit pinning). 0-100, documented weights. */
export function candidateScore(input: {
  independentEntityCount: number;
  dormantReactivations: number;
  fundedPathCount: number;
  receiverDeployments: number;
  durableBehaviorCount: number;
  qualifiedWithPostEntry: number;
  kolContamination: number;
  state: CandidateState;
}): number {
  let score = 0;
  score += Math.min(input.independentEntityCount, 4) * 10; // up to 40
  score += Math.min(input.dormantReactivations, 4) * 5; // up to 20
  score += Math.min(input.fundedPathCount, 2) * 5; // up to 10
  score += Math.min(input.receiverDeployments, 3) * 5; // up to 15
  if (input.qualifiedWithPostEntry > 0) {
    score += Math.round((15 * input.durableBehaviorCount) / input.qualifiedWithPostEntry); // up to 15
  }
  if (input.kolContamination > 0) score -= 30;
  if (input.state === 'DISTRIBUTION_RISK') score -= 40;
  if (input.state === 'INVALIDATED') score = 0;
  return Math.max(0, Math.min(100, score));
}

export interface TokenCandidateBatchReport {
  mintsConsidered: number;
  mintsWritten: number;
  /** Majors skipped by the observed-mcap ceiling (receipted, not hidden). */
  skippedLargeCap: number;
  byState: Record<string, number>;
  errors: number;
  errorReceipts: WalletErrorReceipt[];
}

export async function buildTokenCandidateScores(
  prisma: PrismaClient,
  opts: {
    chain?: 'SOLANA' | 'BSC';
    /** Explicit qualified cohort override (tests/scoped passes); default =
     *  every wallet_dna_profiles wallet. */
    walletAddresses?: string[];
    limit?: number;
    /** Buyer wallets aggregated per mint (bounded). */
    maxBuyersPerMint?: number;
    /** Tokens whose latest OBSERVED mcap is at/above this are majors, not
     *  "new candidates" — skipped with a receipt count. UNKNOWN mcap is NOT
     *  an exclusion (unknown is never treated as large or small). */
    maxMcapUsd?: number;
    now?: Date;
  } = {}
): Promise<TokenCandidateBatchReport> {
  const chain = opts.chain ?? 'SOLANA';
  const limit = opts.limit ?? 200;
  const maxBuyers = Math.min(opts.maxBuyersPerMint ?? 200, 1000);
  const maxMcapUsd = opts.maxMcapUsd ?? 500_000_000;
  const now = opts.now ?? new Date();

  // --- Cohort: qualified DNA wallets + enrolled receivers ------------------
  const dnaWallets = opts.walletAddresses
    ? [...new Set(opts.walletAddresses)].sort()
    : (
        await prisma.walletDnaProfile.findMany({
          where: { chain },
          orderBy: { walletAddress: 'asc' },
          select: { walletAddress: true }
        })
      ).map((w) => w.walletAddress);
  const receivers = await prisma.receiverEnrollment.findMany({
    where: {
      chain,
      ...(opts.walletAddresses
        ? { OR: [{ sourceWallets: { hasSome: dnaWallets } }, { receiverAddress: { in: dnaWallets } }] }
        : {})
    },
    orderBy: { receiverAddress: 'asc' },
    select: { receiverAddress: true, sourceEntityKeys: true, receiverClass: true, deploymentsJson: true }
  });

  const entityOf = await entityKeysFor(prisma, chain, dnaWallets);
  // Receivers collapse into their (first, stable-sorted) source entity —
  // a receiver and its funder must NEVER count as two independent entities.
  const receiverEntity = new Map<string, string>();
  const receiverClassOf = new Map<string, string>();
  for (const r of receivers) {
    receiverEntity.set(r.receiverAddress, [...r.sourceEntityKeys].sort()[0] ?? r.receiverAddress);
    receiverClassOf.set(r.receiverAddress, r.receiverClass);
  }
  const cohortAddresses = [...new Set([...dnaWallets, ...receiverEntity.keys()])].sort();
  if (cohortAddresses.length === 0) {
    return { mintsConsidered: 0, mintsWritten: 0, skippedLargeCap: 0, byState: {}, errors: 0, errorReceipts: [] };
  }
  const entityKeyOf = (addr: string): string =>
    receiverEntity.get(addr) ?? entityOf.get(addr) ?? addr;

  const walletRows = await prisma.wallet.findMany({
    where: { chain, address: { in: cohortAddresses } },
    select: { id: true, address: true, status: true }
  });
  const walletIdOf = new Map(walletRows.map((w) => [w.address, w.id]));
  const addressOfId = new Map(walletRows.map((w) => [w.id, w.address]));
  const cohortIds = walletRows.map((w) => w.id);

  // --- Candidate mints: tokens the cohort BOUGHT (historical runners are
  //     the PAST evidence, never candidates) ---------------------------------
  const runnerMints = new Set(
    (
      await prisma.tokenLifecycle.findMany({
        where: { runnerClass: 'verified_above_10m' },
        select: { mint: true }
      })
    ).map((r) => r.mint)
  );
  const cohortBuys = await prisma.walletTokenTrade.findMany({
    where: { chain, action: 'BUY', walletId: { in: cohortIds } },
    orderBy: [{ ts: 'asc' }, { id: 'asc' }],
    select: { walletId: true, ts: true, tokenId: true, token: { select: { address: true } } }
  });
  const mintTokenId = new Map<string, string>();
  const buyersByMint = new Map<string, Map<string, Date>>(); // mint -> buyer address -> first buy ts
  for (const b of cohortBuys) {
    const mint = b.token.address;
    if (runnerMints.has(mint)) continue;
    mintTokenId.set(mint, b.tokenId);
    const buyer = addressOfId.get(b.walletId);
    if (!buyer) continue;
    let m = buyersByMint.get(mint);
    if (!m) {
      m = new Map();
      buyersByMint.set(mint, m);
    }
    if (!m.has(buyer)) m.set(buyer, b.ts);
  }

  const mints = [...buyersByMint.keys()].sort().slice(0, limit);
  const report: TokenCandidateBatchReport = {
    mintsConsidered: mints.length,
    mintsWritten: 0,
    skippedLargeCap: 0,
    byState: {},
    errors: 0,
    errorReceipts: []
  };

  for (const mint of mints) {
    try {
      const buyers = buyersByMint.get(mint)!;
      const buyerAddresses = [...buyers.keys()].sort().slice(0, maxBuyers);
      const tokenId = mintTokenId.get(mint)!;

      // Majors ceiling: a token already observed at/above maxMcapUsd is not a
      // "new candidate" (skipped + counted). UNKNOWN mcap is never excluded.
      const snapshotEarly = await prisma.tokenMarketSnapshot.findFirst({
        where: { tokenId },
        orderBy: [{ ts: 'desc' }, { id: 'desc' }],
        select: { marketCapUsd: true, ts: true }
      });
      if (snapshotEarly !== null && Number(snapshotEarly.marketCapUsd) >= maxMcapUsd) {
        report.skippedLargeCap += 1;
        // A previously written row for a now-large token is refreshed away
        // (delete) so the feed never shows stale major-cap "candidates".
        await prisma.tokenCandidateScore.deleteMany({ where: { chain, mint } });
        continue;
      }

      // Entity adjustment.
      const entityKeys = new Set(buyerAddresses.map((a) => entityKeyOf(a)));
      const independentEntityCount = entityKeys.size;
      const linkedAddressCount = buyerAddresses.filter(
        (a) => receiverClassOf.get(a) === 'linked_side_wallet'
      ).length;
      const receiverDeployments = buyerAddresses.filter((a) => receiverEntity.has(a)).length;

      // KOL contamination (Wallet.status of buyers).
      const kolContamination = buyerAddresses.filter((a) => {
        const row = walletRows.find((w) => w.address === a);
        return row !== undefined && (KOL_STATUSES as readonly string[]).includes(row.status);
      }).length;

      // Dormancy / funding / alt-wallet / behavior evidence anchored at THIS mint.
      const [dormant, funded, altWallet, postEntry] = await Promise.all([
        prisma.addressDormancyObservation.count({
          where: { chain, anchorKey: mint, walletAddress: { in: buyerAddresses }, overallClass: 'covered_dormant' }
        }),
        prisma.fundingReactivationPath.count({
          where: { chain, anchorKey: mint, walletAddress: { in: buyerAddresses }, status: 'funded' }
        }),
        prisma.entityDormancyObservation.count({
          where: {
            chain,
            anchorKey: mint,
            walletAddress: { in: buyerAddresses },
            entityClass: { in: ['probable_side_wallet_reactivation', 'fresh_funded_by_active_entity'] }
          }
        }),
        prisma.postEntryBehavior.findMany({
          where: { chain, tokenAddress: mint, walletAddress: { in: buyerAddresses } },
          orderBy: { walletAddress: 'asc' },
          select: { primaryClass: true }
        })
      ]);
      const behaviorMix: Record<string, number> = {};
      for (const pe of postEntry) behaviorMix[pe.primaryClass] = (behaviorMix[pe.primaryClass] ?? 0) + 1;
      const distributionBehaviorCount = postEntry.filter((pe) =>
        DISTRIBUTION_CLASSES.includes(pe.primaryClass)
      ).length;
      const durableBehaviorCount = postEntry.filter(
        (pe) => pe.primaryClass === 'durable_hold' || pe.primaryClass === 'still_holding'
      ).length;

      // Crowd: non-cohort distinct buyers of the same token.
      const nonCohort = await prisma.walletTokenTrade.findMany({
        where: { chain, action: 'BUY', tokenId, walletId: { notIn: cohortIds } },
        select: { walletId: true },
        distinct: ['walletId'],
        take: 1000
      });

      // Invalidation from the lifecycle outcome (never inferred).
      const lifecycle = await prisma.tokenLifecycle.findUnique({
        where: { mint },
        select: { outcomeLabels: true }
      });
      const labels = Array.isArray(lifecycle?.outcomeLabels) ? (lifecycle?.outcomeLabels as string[]) : [];
      const invalidated = labels.includes('rug_or_collapse') || labels.includes('failed_launch');

      const { state, reasonCodes: stateReasons } = deriveCandidateState({
        invalidated,
        qualifiedWithPostEntry: postEntry.length,
        distributionBehaviorCount,
        kolContamination,
        cohortBuyers: buyerAddresses.length,
        nonCohortBuyers: nonCohort.length,
        independentEntityCount
      });
      const score = candidateScore({
        independentEntityCount,
        dormantReactivations: dormant,
        fundedPathCount: funded,
        receiverDeployments,
        durableBehaviorCount,
        qualifiedWithPostEntry: postEntry.length,
        kolContamination,
        state
      });

      // Current observed mcap (latest snapshot; NULL-honest).
      const snapshot = snapshotEarly;

      // Side-by-side stealth engine state (never overridden/fabricated).
      const stealth = await prisma.stealthSnapshot.findFirst({
        where: { tokenId },
        orderBy: [{ bucketTs: 'desc' }, { id: 'desc' }],
        select: { state: true, bucketTs: true }
      });

      // Funding paths receipt (bounded).
      const fundingPaths = await prisma.fundingReactivationPath.findMany({
        where: { chain, anchorKey: mint, walletAddress: { in: buyerAddresses }, status: 'funded' },
        orderBy: { walletAddress: 'asc' },
        take: 10,
        select: { walletAddress: true, directFunderAddress: true, fundingToEventDelaySec: true, funderRelationshipTier: true }
      });

      // Confidence: coverage-adjusted — unknowns lower it, never raise it.
      let confidence = 50;
      if (postEntry.length === 0) confidence -= 15;
      if (snapshot === null) confidence -= 15;
      if (dormant + altWallet + funded === 0) confidence -= 10;
      if (independentEntityCount >= 2) confidence += 10;
      confidence = Math.max(5, Math.min(90, confidence));

      const caveats = [...BASE_CAVEATS];
      if (snapshot === null) caveats.push('no locally observed market snapshot — current mcap unknown (never fabricated)');
      if (nonCohort.length >= 1000) caveats.push('non-cohort buyer count capped at 1000');
      if (buyers.size > maxBuyers) caveats.push(`cohort buyers capped at ${maxBuyers}`);

      const data = {
        chain,
        mint,
        currentMcapUsd: snapshot?.marketCapUsd ?? null,
        currentMcapTs: snapshot?.ts ?? null,
        qualifiedEntityCount: entityKeys.size,
        independentEntityCount,
        qualifiedBuyerCount: buyerAddresses.length,
        linkedAddressCount,
        receiverDeployments,
        dormantReactivations: dormant,
        fundedPathCount: funded,
        altWalletEvidenceCount: altWallet,
        nonCohortBuyerCount: nonCohort.length,
        kolContamination,
        behaviorMixJson: behaviorMix as unknown as Prisma.InputJsonValue,
        state,
        stateBasis: 'mining_derived',
        stealthEngineState: stealth?.state ?? null,
        stealthEngineBucketTs: stealth?.bucketTs ?? null,
        score,
        confidence,
        buyersJson: buyerAddresses.slice(0, 50).map((a) => ({
          address: a,
          entityKey: entityKeyOf(a),
          firstBuyTs: buyers.get(a)?.toISOString() ?? null,
          via: receiverEntity.has(a) ? 'enrolled_receiver' : 'qualified_wallet'
        })) as unknown as Prisma.InputJsonValue,
        fundingPathsJson: fundingPaths as unknown as Prisma.InputJsonValue,
        reasonCodes: stateReasons,
        receiptsJson: {
          scoreWeights: 'independent<=40, dormant<=20, funded<=10, receiverDeploy<=15, durableShare<=15, kol-30, distribution-40',
          maxBuyersPerMint: maxBuyers,
          runnerMintsExcluded: true,
          maxMcapUsdCeiling: maxMcapUsd
        } as unknown as Prisma.InputJsonValue,
        caveats,
        engineVersion: TOKEN_CANDIDATE_ENGINE_VERSION,
        computedAt: now
      };
      await prisma.tokenCandidateScore.upsert({
        where: { chain_mint: { chain, mint } },
        create: data,
        update: data
      });
      report.mintsWritten += 1;
      report.byState[state] = (report.byState[state] ?? 0) + 1;
    } catch (err) {
      report.errors += 1;
      if (report.errorReceipts.length < ERROR_RECEIPTS_MAX) {
        report.errorReceipts.push(toErrorReceipt(mint, err));
      }
    }
  }
  return report;
}
