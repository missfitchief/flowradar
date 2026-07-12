// FlowRadar — repeat-runner + dormant-runner candidate builders (dormancy
// Tasks 11-12 DB).
//
// Entity adjustment FIRST: starting from the cohort, the probable/strong
// (confidence >= 50, relationship-contract bands) relationship COMPONENT is
// closed over linked wallets (bounded BFS, NOT limited to the input batch) —
// linked wallets NEVER count as independent repeats, and the canonical
// entityKey (lexicographically smallest member of the closed component) is
// stable across batch compositions. Stale rows keyed by non-canonical member
// addresses are removed after each upsert. Grouping truncation is SURFACED
// and blocks candidate status (never silently splits entities).
//
// Task 11 ranks entity exposure to VERIFIED runners vs controls/others with
// one-winner dependence exposed; negative evidence (receipts engine run ONCE
// per entity over member trades + member-to-member transfers + token
// outcomes) EXCLUDES, never down-weights; an incomplete exclusion scan or a
// truncated runner/control universe can never mint a candidate. Small-N
// honesty: insufficient_evidence rows are the expected common case.
//
// Task 12 joins the entities' RUNNER entries with their T7/T8 dormancy
// observations and classifies the repeat pattern via the PURE core rule —
// never a pattern from one event.
//
// Bounded + stable-ordered; idempotent (chain, entityKey) upserts; per-entity
// error receipts. OBSERVATION-ONLY, SHADOW-ONLY writes.

import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';
import {
  classifyRepeatRunnerCandidate,
  classifyDormantRunnerPattern,
  deriveBehaviorReceipts,
  REPEAT_CANDIDATE_ENGINE_VERSION
} from '@flowradar/core';
import type {
  DormantRunnerEvent,
  ReceiptTradeInput,
  ReceiptTransferInput,
  TokenPositionSummary
} from '@flowradar/core';
import { toErrorReceipt, ERROR_RECEIPTS_MAX } from './../dormancy/activity';
import type { WalletErrorReceipt } from './../dormancy/activity';

const NEGATIVE_CLASSES = new Set([
  'bot_or_arbitrage',
  'market_maker_or_service',
  'launch_team_linked_destructive_exit',
  'high_rug_exposure'
]);

/** Hard cap on the runner/control universe reads (stable-ordered, surfaced). */
const UNIVERSE_CAP = 10_000;

interface EntityGroup {
  entityKey: string;
  members: string[];
  entityAdjusted: boolean;
  /**
   * False when this component's closure hit a bound. Truncated components
   * DEGRADE to deterministic singletons (one group per cohort wallet) —
   * entity identity must never depend on which batch discovered it.
   */
  groupingComplete: boolean;
}

export interface EntityGroupingResult {
  groups: EntityGroup[];
  allComplete: boolean;
}

/** Bounded BFS closure of ONE wallet's probable/strong component. */
async function closeComponent(
  prisma: PrismaClient,
  chain: 'SOLANA' | 'BSC',
  seed: string,
  maxMembers: number,
  maxRelRows: number,
  maxHops: number
): Promise<{ members: Set<string>; truncated: boolean }> {
  const members = new Set<string>([seed]);
  let truncated = false;
  let frontier = [seed];
  for (let hop = 0; hop < maxHops && frontier.length > 0; hop++) {
    const wallets = await prisma.wallet.findMany({
      where: { chain, address: { in: frontier } },
      select: { id: true }
    });
    const ids = wallets.map((w) => w.id);
    if (ids.length === 0) {
      frontier = [];
      break;
    }
    const rels = await prisma.walletRelationship.findMany({
      where: {
        confidence: { gte: 50 },
        OR: [{ walletAId: { in: ids } }, { walletBId: { in: ids } }]
      },
      orderBy: [{ confidence: 'desc' }, { id: 'asc' }],
      take: maxRelRows + 1,
      select: {
        walletA: { select: { address: true, chain: true } },
        walletB: { select: { address: true, chain: true } }
      }
    });
    if (rels.length > maxRelRows) truncated = true;
    const next = new Set<string>();
    for (const r of rels.slice(0, maxRelRows)) {
      if (r.walletA.chain !== chain || r.walletB.chain !== chain) continue; // never cross-chain
      for (const side of [r.walletA.address, r.walletB.address]) {
        if (members.has(side)) continue;
        if (members.size >= maxMembers) {
          truncated = true;
          continue;
        }
        members.add(side);
        next.add(side);
      }
    }
    frontier = [...next].sort();
  }
  // Hop limit reached with an unexplored frontier == incomplete closure.
  if (frontier.length > 0) truncated = true;
  return { members, truncated };
}

/**
 * Groups cohort wallets into entities by closing each wallet's
 * probable/strong (confidence >= 50) relationship COMPONENT — bounded BFS
 * over wallet_relationships, NOT limited to the input batch, so canonical
 * entity keys are stable across batch compositions:
 *   - complete component  -> ONE group keyed by its smallest member;
 *   - truncated component -> deterministic SINGLETON per cohort wallet
 *     (groupingComplete=false) — a partial closure must never invent a
 *     batch-dependent merged identity.
 */
export async function groupCohortEntities(
  prisma: PrismaClient,
  chain: 'SOLANA' | 'BSC',
  walletAddresses: string[],
  opts: { maxClosureWallets?: number; maxRelationshipRows?: number; maxHops?: number } = {}
): Promise<EntityGroupingResult> {
  const maxMembers = opts.maxClosureWallets ?? 100;
  const maxRelRows = opts.maxRelationshipRows ?? 2000;
  const maxHops = opts.maxHops ?? 3;
  const cohort = [...new Set(walletAddresses)].sort();
  const cohortSet = new Set(cohort);

  const groups: EntityGroup[] = [];
  const assigned = new Set<string>();
  for (const wallet of cohort) {
    if (assigned.has(wallet)) continue;
    const comp = await closeComponent(prisma, chain, wallet, maxMembers, maxRelRows, maxHops);
    if (comp.truncated) {
      groups.push({ entityKey: wallet, members: [wallet], entityAdjusted: false, groupingComplete: false });
      assigned.add(wallet);
    } else {
      const sorted = [...comp.members].sort();
      groups.push({
        entityKey: sorted[0],
        members: sorted,
        entityAdjusted: sorted.length > 1,
        groupingComplete: true
      });
      for (const m of sorted) if (cohortSet.has(m)) assigned.add(m);
    }
  }
  groups.sort((a, b) => (a.entityKey < b.entityKey ? -1 : 1));
  return { groups, allComplete: groups.every((g) => g.groupingComplete) };
}

export interface RepeatCandidateBatchReport {
  entitiesConsidered: number;
  entitiesWritten: number;
  errors: number;
  errorReceipts: WalletErrorReceipt[];
  byStatus: Record<string, number>;
  entityAdjustedCount: number;
  groupingComplete: boolean;
  universeComplete: boolean;
}

interface EntityExposure {
  runnersEntered: number;
  distinctRunnerMints: Set<string>;
  runnerEntriesByMint: Map<string, number>;
  controlMints: Set<string>;
  otherMints: Set<string>;
  /** (wallet, runnerMint, entryTs) runner-entry events for Task 12. */
  runnerEvents: { wallet: string; mint: string; entryTs: string }[];
  viewTruncated: boolean;
}

async function collectEntityExposure(
  prisma: PrismaClient,
  chain: 'SOLANA' | 'BSC',
  members: string[],
  runnerMints: Set<string>,
  controlMints: Set<string>,
  maxEntriesPerWallet: number
): Promise<EntityExposure> {
  const exposure: EntityExposure = {
    runnersEntered: 0,
    distinctRunnerMints: new Set(),
    runnerEntriesByMint: new Map(),
    controlMints: new Set(),
    otherMints: new Set(),
    runnerEvents: [],
    viewTruncated: false
  };
  const profiles = await prisma.walletBehaviorProfile.findMany({
    where: { chain, walletAddress: { in: members } },
    orderBy: { walletAddress: 'asc' },
    select: { walletAddress: true, profileJson: true }
  });
  for (const p of profiles) {
    const profile = p.profileJson as unknown as {
      localViewTruncated?: boolean;
      local?: { tokenPositions?: TokenPositionSummary[] };
    };
    if (profile.localViewTruncated === true) exposure.viewTruncated = true;
    const positions = (profile.local?.tokenPositions ?? []).filter((tp) => tp.firstBuyTs !== null);
    positions.sort((a, b) => ((a.firstBuyTs as string) < (b.firstBuyTs as string) ? -1 : 1));
    if (positions.length > maxEntriesPerWallet) exposure.viewTruncated = true;
    for (const pos of positions.slice(0, maxEntriesPerWallet)) {
      if (runnerMints.has(pos.tokenAddress)) {
        exposure.runnersEntered += 1;
        exposure.distinctRunnerMints.add(pos.tokenAddress);
        exposure.runnerEntriesByMint.set(
          pos.tokenAddress,
          (exposure.runnerEntriesByMint.get(pos.tokenAddress) ?? 0) + 1
        );
        exposure.runnerEvents.push({
          wallet: p.walletAddress,
          mint: pos.tokenAddress,
          entryTs: pos.firstBuyTs as string
        });
      } else if (controlMints.has(pos.tokenAddress)) {
        exposure.controlMints.add(pos.tokenAddress);
      } else {
        exposure.otherMints.add(pos.tokenAddress);
      }
    }
  }
  return exposure;
}

/**
 * Negative/quality evidence for ONE entity: the receipts engine runs ONCE
 * over ALL members' trades (per-member capped, surfaced) + member-to-member
 * transfers + token outcomes from token_lifecycles — so cross-wallet classes
 * (launch_team_linked_destructive_exit) and outcome-gated classes
 * (high_rug_exposure) are REACHABLE, not dead code.
 */
async function collectEntityEvidence(
  prisma: PrismaClient,
  chain: 'SOLANA' | 'BSC',
  members: string[],
  maxTradesPerMember: number,
  maxMemberTransfers: number,
  now: Date
): Promise<{ negative: string[]; quality: string[]; scanComplete: boolean; receiptsSample: unknown[] }> {
  const negative = new Set<string>();
  const quality = new Set<string>();
  const receiptsSample: unknown[] = [];
  let truncated = false;

  const allTrades: ReceiptTradeInput[] = [];
  for (const member of members) {
    const wallet = await prisma.wallet.findUnique({
      where: { address_chain: { address: member, chain } },
      select: { id: true }
    });
    if (!wallet) continue;
    const tradeRows = await prisma.walletTokenTrade.findMany({
      where: { walletId: wallet.id, chain, action: { in: ['BUY', 'SELL'] } },
      orderBy: [{ ts: 'desc' }, { id: 'desc' }],
      take: maxTradesPerMember + 1,
      select: {
        action: true,
        amountUsd: true,
        ts: true,
        blockOrSlot: true,
        txHash: true,
        marketCapAtTrade: true,
        token: { select: { address: true } }
      }
    });
    if (tradeRows.length > maxTradesPerMember) truncated = true;
    for (const t of tradeRows.slice(0, maxTradesPerMember)) {
      allTrades.push({
        walletAddress: member,
        tokenAddress: t.token.address,
        action: t.action as 'BUY' | 'SELL',
        amountUsd: Number(t.amountUsd),
        ts: t.ts,
        blockOrSlot: t.blockOrSlot,
        txHash: t.txHash,
        marketCapAtTrade: t.marketCapAtTrade === null ? null : Number(t.marketCapAtTrade)
      });
    }
  }
  if (allTrades.length === 0) {
    return { negative: [], quality: [], scanComplete: !truncated, receiptsSample: [] };
  }

  // Member-to-member transfers (funding links for launch-team receipts).
  // Self-transfers are excluded IN-QUERY (column-to-column predicate needs
  // raw SQL) so they can never crowd the cap and hide a real funding edge.
  const transferRows =
    members.length < 2
      ? []
      : await prisma.$queryRaw<
          { sourceAddress: string; destinationAddress: string; valuedUsd: unknown; ts: Date; txHash: string }[]
        >`
    SELECT "sourceAddress", "destinationAddress", "valuedUsd", "ts", "txHash"
    FROM money_flow_edges
    WHERE "sourceAddress" IN (${Prisma.join(members)})
      AND "destinationAddress" IN (${Prisma.join(members)})
      AND "sourceChain" = ${chain}::"ChainId"
      AND "destinationChain" = ${chain}::"ChainId"
      AND "sourceAddress" <> "destinationAddress"
    ORDER BY "ts" DESC, "id" DESC
    LIMIT ${maxMemberTransfers + 1}`;
  if (transferRows.length > maxMemberTransfers) truncated = true;
  const transfers: ReceiptTransferInput[] = transferRows
    .slice(0, maxMemberTransfers)
    .map((e) => ({
      sourceAddress: e.sourceAddress,
      destinationAddress: e.destinationAddress,
      usd: e.valuedUsd === null ? null : Number(e.valuedUsd),
      ts: e.ts,
      txHash: e.txHash
    }));

  // Token outcomes from token_lifecycles (never inferred).
  const mints = [...new Set(allTrades.map((t) => t.tokenAddress))];
  const tokenOutcomes: Record<string, 'runner' | 'rug' | 'dead' | 'flat'> = {};
  for (let i = 0; i < mints.length; i += 500) {
    const rows = await prisma.tokenLifecycle.findMany({
      where: { mint: { in: mints.slice(i, i + 500) } },
      select: { mint: true, runnerClass: true, outcomeLabels: true }
    });
    for (const r of rows) {
      const labels = Array.isArray(r.outcomeLabels) ? (r.outcomeLabels as string[]) : [];
      if (labels.includes('rug_or_collapse')) tokenOutcomes[r.mint] = 'rug';
      else if (labels.includes('failed_launch') || labels.includes('illiquid_untradeable')) tokenOutcomes[r.mint] = 'dead';
      else if (r.runnerClass === 'verified_above_10m') tokenOutcomes[r.mint] = 'runner';
      else if (r.runnerClass === 'verified_below_10m') tokenOutcomes[r.mint] = 'flat';
      // insufficient/conflicting/unclassified: OMITTED — unknown is never an outcome.
    }
  }

  const result = deriveBehaviorReceipts({ trades: allTrades, transfers, tokenOutcomes, now });
  if (result.inputTruncation.tradesTruncated > 0 || result.inputTruncation.transfersTruncated > 0) {
    truncated = true;
  }
  const memberSet = new Set(members);
  for (const r of result.receipts) {
    if (!r.wallets.some((w) => memberSet.has(w))) continue;
    if (NEGATIVE_CLASSES.has(r.classification)) {
      negative.add(r.classification);
      if (receiptsSample.length < 10) {
        receiptsSample.push({
          classification: r.classification,
          wallets: r.wallets.filter((w) => memberSet.has(w)).slice(0, 5),
          confidence: r.confidence,
          evidenceTxs: r.evidenceTxs.slice(0, 5)
        });
      }
    } else if (
      r.classification === 'independent_sharp_trader' ||
      r.classification === 'repeat_low_mcap_early_buyer'
    ) {
      quality.add(r.classification);
    }
  }
  return {
    negative: [...negative].sort(),
    quality: [...quality].sort(),
    scanComplete: !truncated,
    receiptsSample
  };
}

/**
 * Removes stale candidate rows superseded by the current entity: any row
 * whose member set OVERLAPS this entity's members but whose key is not the
 * canonical key belongs to an obsolete grouping (components are disjoint —
 * overlapping member sets can never both be current).
 */
async function purgeStaleEntityRows(
  prisma: PrismaClient,
  table: 'repeat' | 'dormant',
  chain: 'SOLANA' | 'BSC',
  entity: EntityGroup
): Promise<void> {
  const where = {
    chain,
    entityKey: { not: entity.entityKey },
    memberWallets: { hasSome: entity.members }
  };
  if (table === 'repeat') {
    await prisma.repeatRunnerCandidate.deleteMany({ where });
  } else {
    await prisma.dormantRunnerCandidate.deleteMany({ where });
  }
}

async function readRunnerUniverse(prisma: PrismaClient): Promise<{ mints: Set<string>; complete: boolean }> {
  const rows = await prisma.tokenLifecycle.findMany({
    where: { runnerClass: 'verified_above_10m' },
    orderBy: { mint: 'asc' },
    take: UNIVERSE_CAP + 1,
    select: { mint: true }
  });
  return { mints: new Set(rows.slice(0, UNIVERSE_CAP).map((r) => r.mint)), complete: rows.length <= UNIVERSE_CAP };
}

async function readControlUniverse(prisma: PrismaClient): Promise<{ mints: Set<string>; complete: boolean }> {
  const rows = await prisma.cohortMatch.findMany({
    where: { controlMint: { not: null } },
    orderBy: { runnerMint: 'asc' },
    take: UNIVERSE_CAP + 1,
    select: { controlMint: true }
  });
  return {
    mints: new Set(rows.slice(0, UNIVERSE_CAP).map((r) => r.controlMint as string)),
    complete: rows.length <= UNIVERSE_CAP
  };
}

export async function buildRepeatRunnerCandidates(
  prisma: PrismaClient,
  opts: {
    chain?: 'SOLANA' | 'BSC';
    walletAddresses?: string[];
    limit?: number;
    maxEntriesPerWallet?: number;
    maxTrades?: number;
    maxMemberTransfers?: number;
    now?: Date;
  } = {}
): Promise<RepeatCandidateBatchReport> {
  const chain = opts.chain ?? 'SOLANA';
  const limit = opts.limit ?? 100;
  const maxEntries = opts.maxEntriesPerWallet ?? 500;
  const maxTrades = opts.maxTrades ?? 5000;
  const maxMemberTransfers = opts.maxMemberTransfers ?? 2000;
  const now = opts.now ?? new Date();

  const cohort = opts.walletAddresses
    ? opts.walletAddresses.slice(0, limit)
    : (
        await prisma.walletBehaviorProfile.findMany({
          where: { chain },
          orderBy: { walletAddress: 'asc' },
          take: limit,
          select: { walletAddress: true }
        })
      ).map((p) => p.walletAddress);

  const [runnerUniverse, controlUniverse] = await Promise.all([
    readRunnerUniverse(prisma),
    readControlUniverse(prisma)
  ]);
  const universeComplete = runnerUniverse.complete && controlUniverse.complete;

  const grouping = await groupCohortEntities(prisma, chain, cohort);
  const report: RepeatCandidateBatchReport = {
    entitiesConsidered: grouping.groups.length,
    entitiesWritten: 0,
    errors: 0,
    errorReceipts: [],
    byStatus: {},
    entityAdjustedCount: grouping.groups.filter((e) => e.entityAdjusted).length,
    groupingComplete: grouping.allComplete,
    universeComplete
  };

  for (const entity of grouping.groups) {
    try {
      const exposure = await collectEntityExposure(
        prisma, chain, entity.members, runnerUniverse.mints, controlUniverse.mints, maxEntries
      );
      const evidence = await collectEntityEvidence(
        prisma, chain, entity.members, maxTrades, maxMemberTransfers, now
      );
      const topMintEntries = Math.max(0, ...exposure.runnerEntriesByMint.values());
      const oneWinnerDependence =
        exposure.runnersEntered > 0 ? topMintEntries / exposure.runnersEntered : null;

      let decision = classifyRepeatRunnerCandidate({
        distinctRunnersEntered: exposure.distinctRunnerMints.size,
        runnersEntered: exposure.runnersEntered,
        controlsEntered: exposure.controlMints.size,
        otherTokensEntered: exposure.otherMints.size,
        oneWinnerDependence,
        negativeEvidence: evidence.negative,
        qualityFlags: evidence.quality,
        viewTruncated: exposure.viewTruncated,
        exclusionScanComplete: evidence.scanComplete,
        universeComplete
      });
      // A truncated component closure can never mint a candidate: the
      // degraded singleton could hide linked-wallet duplication.
      if (!entity.groupingComplete && decision.status === 'candidate') {
        decision = {
          ...decision,
          status: 'insufficient_evidence',
          score: null,
          scoreBasis: [],
          reasonCodes: [...decision.reasonCodes, 'entity_grouping_incomplete'],
          caveats: [...decision.caveats, 'component closure was truncated — linked-wallet duplication cannot be excluded; no candidate can be minted']
        };
      }

      const data = {
        chain,
        entityKey: entity.entityKey,
        memberWallets: entity.members,
        entityAdjusted: entity.entityAdjusted,
        status: decision.status,
        runnersEntered: exposure.runnersEntered,
        distinctRunnersEntered: exposure.distinctRunnerMints.size,
        controlsEntered: exposure.controlMints.size,
        otherTokensEntered: exposure.otherMints.size,
        oneWinnerDependence,
        behaviorQualityJson: { qualityFlags: evidence.quality } as unknown as Prisma.InputJsonValue,
        negativeEvidenceJson: {
          classes: evidence.negative,
          sample: evidence.receiptsSample
        } as unknown as Prisma.InputJsonValue,
        score: decision.score,
        scoreBasis: decision.scoreBasis,
        reasonCodes: decision.reasonCodes,
        receiptsJson: {
          runnerEntriesByMint: Object.fromEntries(exposure.runnerEntriesByMint),
          viewTruncated: exposure.viewTruncated,
          exclusionScanComplete: evidence.scanComplete,
          groupingComplete: entity.groupingComplete,
          universeComplete,
          runnerUniverse: runnerUniverse.mints.size,
          controlUniverse: controlUniverse.mints.size
        } as unknown as Prisma.InputJsonValue,
        caveats: decision.caveats,
        engineVersion: decision.engineVersion,
        computedAt: now
      };
      await prisma.repeatRunnerCandidate.upsert({
        where: { chain_entityKey: { chain, entityKey: entity.entityKey } },
        create: data,
        update: data
      });
      await purgeStaleEntityRows(prisma, 'repeat', chain, entity);
      report.entitiesWritten += 1;
      report.byStatus[decision.status] = (report.byStatus[decision.status] ?? 0) + 1;
    } catch (err) {
      report.errors += 1;
      if (report.errorReceipts.length < ERROR_RECEIPTS_MAX) {
        report.errorReceipts.push(toErrorReceipt(entity.entityKey, err));
      }
    }
  }
  return report;
}

// ---------------------------------------------------------------------------
// Task 12 — dormant-runner candidates
// ---------------------------------------------------------------------------

export interface DormantRunnerBatchReport {
  entitiesConsidered: number;
  entitiesWritten: number;
  errors: number;
  errorReceipts: WalletErrorReceipt[];
  byPattern: Record<string, number>;
  groupingComplete: boolean;
  universeComplete: boolean;
}

export async function buildDormantRunnerCandidates(
  prisma: PrismaClient,
  opts: {
    chain?: 'SOLANA' | 'BSC';
    walletAddresses?: string[];
    limit?: number;
    maxEntriesPerWallet?: number;
    /** Bound on dormancy-joined runner events per entity. */
    maxEventsPerEntity?: number;
    now?: Date;
  } = {}
): Promise<DormantRunnerBatchReport> {
  const chain = opts.chain ?? 'SOLANA';
  const limit = opts.limit ?? 100;
  const maxEntries = opts.maxEntriesPerWallet ?? 500;
  const maxEvents = opts.maxEventsPerEntity ?? 200;
  const now = opts.now ?? new Date();

  const cohort = opts.walletAddresses
    ? opts.walletAddresses.slice(0, limit)
    : (
        await prisma.walletBehaviorProfile.findMany({
          where: { chain },
          orderBy: { walletAddress: 'asc' },
          take: limit,
          select: { walletAddress: true }
        })
      ).map((p) => p.walletAddress);

  const runnerUniverse = await readRunnerUniverse(prisma);
  const grouping = await groupCohortEntities(prisma, chain, cohort);
  const report: DormantRunnerBatchReport = {
    entitiesConsidered: grouping.groups.length,
    entitiesWritten: 0,
    errors: 0,
    errorReceipts: [],
    byPattern: {},
    groupingComplete: grouping.allComplete,
    universeComplete: runnerUniverse.complete
  };

  for (const entity of grouping.groups) {
    try {
      const exposure = await collectEntityExposure(
        prisma, chain, entity.members, runnerUniverse.mints, new Set(), maxEntries
      );
      const runnerEvents = exposure.runnerEvents.slice(0, maxEvents);
      const eventsCapped = exposure.runnerEvents.length > maxEvents;

      // Join each runner entry with its T7/T8 dormancy observations.
      const events: DormantRunnerEvent[] = [];
      const eventsJson: unknown[] = [];
      for (const ev of runnerEvents) {
        const [addrObs, entObs] = await Promise.all([
          prisma.addressDormancyObservation.findUnique({
            where: {
              chain_walletAddress_eventKind_anchorKey: {
                chain, walletAddress: ev.wallet, eventKind: 'token_entry', anchorKey: ev.mint
              }
            },
            select: { overallClass: true }
          }),
          prisma.entityDormancyObservation.findUnique({
            where: {
              chain_walletAddress_eventKind_anchorKey: {
                chain, walletAddress: ev.wallet, eventKind: 'token_entry', anchorKey: ev.mint
              }
            },
            select: { entityClass: true }
          })
        ]);
        const addressClass = addrObs?.overallClass ?? 'unknown';
        const entityClass = entObs?.entityClass ?? 'insufficient_evidence';
        events.push({ addressClass, entityClass, runnerMint: ev.mint });
        if (eventsJson.length < 100) {
          eventsJson.push({
            wallet: ev.wallet,
            token: ev.mint,
            eventTs: ev.entryTs,
            addressClass,
            entityClass
          });
        }
      }

      let decision = classifyDormantRunnerPattern(events);
      const caveats = [...decision.caveats];
      if (eventsCapped) caveats.push('runner-event list capped — pattern derived from the bounded subset');
      // A truncated runner universe or truncated component closure can never
      // mint a repeat pattern (exposure/independence would be unreliable).
      if ((!runnerUniverse.complete || !entity.groupingComplete) && decision.pattern !== 'insufficient_evidence') {
        decision = {
          ...decision,
          pattern: 'insufficient_evidence',
          confidence: 20,
          reasonCodes: [
            ...decision.reasonCodes,
            !runnerUniverse.complete ? 'universe_read_incomplete' : 'entity_grouping_incomplete'
          ]
        };
        caveats.push('universe/grouping read was incomplete — no pattern can be honestly claimed');
      }

      const data = {
        chain,
        entityKey: entity.entityKey,
        memberWallets: entity.members,
        pattern: decision.pattern,
        dormantEntryEvents: decision.dormantEntryEvents,
        sideWalletActivationEvents: decision.sideWalletActivationEvents,
        freshFundingEvents: decision.freshFundingEvents,
        distinctRunnerTokens: decision.distinctRunnerTokens,
        eventsJson: eventsJson as unknown as Prisma.InputJsonValue,
        confidence: decision.confidence,
        reasonCodes: decision.reasonCodes,
        receiptsJson: {
          runnerEventsConsidered: events.length,
          eventsCapped,
          entityAdjusted: entity.entityAdjusted,
          groupingComplete: entity.groupingComplete,
          universeComplete: runnerUniverse.complete,
          runnerUniverse: runnerUniverse.mints.size
        } as unknown as Prisma.InputJsonValue,
        caveats,
        engineVersion: REPEAT_CANDIDATE_ENGINE_VERSION,
        computedAt: now
      };
      await prisma.dormantRunnerCandidate.upsert({
        where: { chain_entityKey: { chain, entityKey: entity.entityKey } },
        create: data,
        update: data
      });
      await purgeStaleEntityRows(prisma, 'dormant', chain, entity);
      report.entitiesWritten += 1;
      report.byPattern[decision.pattern] = (report.byPattern[decision.pattern] ?? 0) + 1;
    } catch (err) {
      report.errors += 1;
      if (report.errorReceipts.length < ERROR_RECEIPTS_MAX) {
        report.errorReceipts.push(toErrorReceipt(entity.entityKey, err));
      }
    }
  }
  return report;
}
