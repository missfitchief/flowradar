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

  // --- Cohort: QUALIFIED wallets + enrolled receivers ----------------------
  // Qualified = wallets with LOCAL top-PnL evidence (validation never
  // provider_only/invalid). Provider claims are discovery evidence only —
  // they NEVER grant qualified standing; Wallet DNA rows alone don't either.
  const dnaWallets = opts.walletAddresses
    ? [...new Set(opts.walletAddresses)].sort()
    : (
        await prisma.tokenTopPnlCandidate.findMany({
          where: { chain, validation: { notIn: ['provider_only', 'invalid'] } },
          orderBy: { walletAddress: 'asc' },
          select: { walletAddress: true },
          distinct: ['walletAddress']
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
    select: { receiverAddress: true, sourceEntityKeys: true, receiverClass: true, firstReceiptTs: true }
  });

  const entityOf = await entityKeysFor(prisma, chain, dnaWallets);
  // ENTITY ADJUSTMENT via union-find: a receiver is linked to EVERY source
  // entity that funded it (not an arbitrary first one) — a receiver funded
  // by A and B collapses {receiver, A, B} into ONE component, so the
  // receiver plus any of its funders can never count as independent.
  const dsu = new Map<string, string>();
  const find = (k: string): string => {
    let r = k;
    while (dsu.get(r) !== undefined && dsu.get(r) !== r) r = dsu.get(r)!;
    dsu.set(k, r);
    return r;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) dsu.set(ra < rb ? rb : ra, ra < rb ? ra : rb); // smaller key wins — deterministic
  };
  const ensure = (k: string) => {
    if (!dsu.has(k)) dsu.set(k, k);
  };
  const receiverFirstReceipt = new Map<string, Date>();
  const receiverClassOf = new Map<string, string>();
  for (const w of dnaWallets) ensure(entityOf.get(w) ?? w);
  for (const r of receivers) {
    ensure(r.receiverAddress);
    receiverFirstReceipt.set(r.receiverAddress, r.firstReceiptTs);
    receiverClassOf.set(r.receiverAddress, r.receiverClass);
    for (const src of r.sourceEntityKeys) {
      ensure(src);
      union(r.receiverAddress, src);
    }
  }
  const cohortAddresses = [...new Set([...dnaWallets, ...receiverFirstReceipt.keys()])].sort();
  if (cohortAddresses.length === 0) {
    return { mintsConsidered: 0, mintsWritten: 0, skippedLargeCap: 0, byState: {}, errors: 0, errorReceipts: [] };
  }
  const entityKeyOf = (addr: string): string => {
    const base = receiverFirstReceipt.has(addr) ? addr : (entityOf.get(addr) ?? addr);
    ensure(base);
    return find(base);
  };

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
  // A buy EVENT is on-chain fact; only its USD value may be unknown
  // (amountUsd stores 0 for unpriced). Unpriced buys may DISCOVER a
  // candidate but can never mint accumulation states: buyers whose evidence
  // on a mint is entirely unpriced are tracked separately and the state
  // machine only sees PRICED-evidence buyers.
  const cohortBuys = await prisma.walletTokenTrade.findMany({
    where: { chain, action: 'BUY', walletId: { in: cohortIds } },
    orderBy: [{ ts: 'asc' }, { id: 'asc' }],
    select: { walletId: true, ts: true, amountUsd: true, tokenId: true, token: { select: { address: true } } }
  });
  const mintTokenId = new Map<string, string>();
  // mint -> buyer address -> { first buy ts, any priced buy seen }
  const buyersByMint = new Map<string, Map<string, { firstBuyTs: Date; priced: boolean }>>();
  let preReceiptBuysSkipped = 0;
  let unpricedCohortBuys = 0;
  for (const b of cohortBuys) {
    const mint = b.token.address;
    if (runnerMints.has(mint)) continue;
    const buyer = addressOfId.get(b.walletId);
    if (!buyer) continue;
    // A receiver's PRE-receipt buys are its own history — they were never
    // funded by the qualified entity and must not surface candidates.
    const receiptTs = receiverFirstReceipt.get(buyer);
    if (receiptTs !== undefined && b.ts.getTime() <= receiptTs.getTime()) {
      preReceiptBuysSkipped += 1;
      continue;
    }
    const priced = Number(b.amountUsd) > 0;
    if (!priced) unpricedCohortBuys += 1;
    mintTokenId.set(mint, b.tokenId);
    let m = buyersByMint.get(mint);
    if (!m) {
      m = new Map();
      buyersByMint.set(mint, m);
    }
    const cur = m.get(buyer);
    if (!cur) m.set(buyer, { firstBuyTs: b.ts, priced });
    else if (priced && !cur.priced) cur.priced = true;
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

      // KOL/copytrader partition FIRST: KOL-status buyers feed ONLY the
      // contamination counter and its penalty — they are excluded from every
      // positive metric (entities, dormancy, funding, deployments, behavior)
      // so KOL presence can never raise the ranking.
      const kolBuyers = buyerAddresses.filter((a) => {
        const row = walletRows.find((w) => w.address === a);
        return row !== undefined && (KOL_STATUSES as readonly string[]).includes(row.status);
      });
      const kolContamination = kolBuyers.length;
      const cleanBuyers = buyerAddresses.filter((a) => !kolBuyers.includes(a));
      if (cleanBuyers.length === 0) {
        // Discovered ONLY through KOL-status cohort members: no qualified
        // evidence exists — never a candidate (stale rows refreshed away).
        await prisma.tokenCandidateScore.deleteMany({ where: { chain, mint } });
        continue;
      }
      // Unknown-value honesty: only buyers with at least one PRICED buy feed
      // the state machine and positive metrics; unpriced-only buyers are
      // reported (and keep the candidate visible) but cap it at WATCHING.
      const pricedBuyers = cleanBuyers.filter((a) => buyers.get(a)?.priced === true);
      const unpricedOnlyBuyers = cleanBuyers.length - pricedBuyers.length;

      // Entity adjustment (union-find components over PRICED clean buyers).
      const entityKeys = new Set(pricedBuyers.map((a) => entityKeyOf(a)));
      const independentEntityCount = entityKeys.size;
      const linkedAddressCount = cleanBuyers.filter(
        (a) => receiverClassOf.get(a) === 'linked_side_wallet'
      ).length;
      // PRICED receivers only — an unpriced-only post-receipt buy is never
      // score evidence (consistent with every other positive metric).
      const receiverDeployments = pricedBuyers.filter((a) => receiverFirstReceipt.has(a)).length;

      // Dormancy / funding / alt-wallet / behavior evidence anchored at THIS
      // mint — CLEAN buyers only (KOL evidence never boosts).
      // Score-positive evidence (dormancy/funding/alt-wallet) is restricted
      // to PRICED buyers — unknown-value evidence never raises the ranking.
      // Post-entry behavior spans ALL clean buyers: negative evidence
      // (distribution) must never be discarded because a buy was unpriced.
      const [dormant, funded, altWallet, postEntry] = await Promise.all([
        prisma.addressDormancyObservation.count({
          where: { chain, anchorKey: mint, walletAddress: { in: pricedBuyers }, overallClass: 'covered_dormant' }
        }),
        prisma.fundingReactivationPath.count({
          where: { chain, anchorKey: mint, walletAddress: { in: pricedBuyers }, status: 'funded' }
        }),
        prisma.entityDormancyObservation.count({
          where: {
            chain,
            anchorKey: mint,
            walletAddress: { in: pricedBuyers },
            entityClass: { in: ['probable_side_wallet_reactivation', 'fresh_funded_by_active_entity'] }
          }
        }),
        prisma.postEntryBehavior.findMany({
          where: { chain, tokenAddress: mint, walletAddress: { in: cleanBuyers } },
          orderBy: { walletAddress: 'asc' },
          select: { primaryClass: true, walletAddress: true }
        })
      ]);
      const behaviorMix: Record<string, number> = {};
      for (const pe of postEntry) behaviorMix[pe.primaryClass] = (behaviorMix[pe.primaryClass] ?? 0) + 1;
      const distributionBehaviorCount = postEntry.filter((pe) =>
        DISTRIBUTION_CLASSES.includes(pe.primaryClass)
      ).length;
      // Durable behavior is POSITIVE evidence — priced buyers only (the
      // distribution/negative counts above intentionally span all clean
      // buyers so bad behavior is never discarded for being unpriced).
      const pricedSet = new Set(pricedBuyers);
      const durableBehaviorCount = postEntry.filter(
        (pe) =>
          (pe.primaryClass === 'durable_hold' || pe.primaryClass === 'still_holding') &&
          pricedSet.has(pe.walletAddress)
      ).length;

      // Crowd: non-cohort distinct buyers of the same token.
      // PRICED non-cohort buys only — unknown-value trades never evidence
      // crowd expansion either.
      const nonCohort = await prisma.walletTokenTrade.findMany({
        where: { chain, action: 'BUY', tokenId, walletId: { notIn: cohortIds }, amountUsd: { gt: 0 } },
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
        cohortBuyers: pricedBuyers.length,
        nonCohortBuyers: nonCohort.length,
        independentEntityCount
      });
      if (unpricedOnlyBuyers > 0) {
        stateReasons.push(`unpriced_only_buyers_excluded_from_state:${unpricedOnlyBuyers}`);
      }
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
        where: { chain, anchorKey: mint, walletAddress: { in: cleanBuyers }, status: 'funded' },
        orderBy: { walletAddress: 'asc' },
        take: 10,
        select: { walletAddress: true, directFunderAddress: true, fundingToEventDelaySec: true, funderRelationshipTier: true }
      });

      // Confidence: coverage-adjusted — unknowns lower it, never raise it.
      let confidence = 50;
      if (postEntry.length === 0) confidence -= 15;
      if (snapshot === null) confidence -= 15;
      if (dormant + altWallet + funded === 0) confidence -= 10;
      if (unpricedOnlyBuyers > 0) confidence -= 10; // unknown value lowers, never raises
      if (independentEntityCount >= 2) confidence += 10;
      confidence = Math.max(5, Math.min(90, confidence));

      const caveats = [...BASE_CAVEATS];
      if (snapshot === null) caveats.push('no locally observed market snapshot — current mcap unknown (never fabricated)');
      if (unpricedOnlyBuyers > 0) {
        caveats.push(
          `${unpricedOnlyBuyers} buyer(s) have only unpriced buys on this mint — excluded from states/score, never treated as accumulation`
        );
      }
      if (nonCohort.length >= 1000) caveats.push('non-cohort buyer count capped at 1000');
      if (buyers.size > maxBuyers) caveats.push(`cohort buyers capped at ${maxBuyers}`);

      const data = {
        chain,
        mint,
        currentMcapUsd: snapshot?.marketCapUsd ?? null,
        currentMcapTs: snapshot?.ts ?? null,
        qualifiedEntityCount: entityKeys.size,
        independentEntityCount,
        qualifiedBuyerCount: cleanBuyers.length,
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
          firstBuyTs: buyers.get(a)?.firstBuyTs.toISOString() ?? null,
          pricedEvidence: buyers.get(a)?.priced === true,
          via: kolBuyers.includes(a)
            ? 'kol_or_copytrader'
            : receiverFirstReceipt.has(a)
              ? 'enrolled_receiver'
              : 'qualified_wallet'
        })) as unknown as Prisma.InputJsonValue,
        fundingPathsJson: fundingPaths as unknown as Prisma.InputJsonValue,
        reasonCodes: stateReasons,
        receiptsJson: {
          scoreWeights: 'independent<=40, dormant<=20, funded<=10, receiverDeploy<=15, durableShare<=15, kol-30, distribution-40',
          positiveMetricsFromCleanBuyersOnly: true,
          entityAdjustment: 'union_find_over_all_receiver_source_entities',
          stateEvidenceFromPricedBuyersOnly: true,
          unpricedOnlyBuyersThisMint: unpricedOnlyBuyers,
          unpricedCohortBuysTotal: unpricedCohortBuys,
          receiverPreReceiptBuysSkipped: preReceiptBuysSkipped,
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
