// FlowRadar — runEntityClustering: derives wallet-pair LinkEvidence from raw
// MoneyFlowEdge/WalletTokenTrade/AddressRegistry signals, scores each pair
// via @flowradar/core's calculateWalletLinkConfidence, clusters wallets via
// clusterWallets at settings.entityConfidenceThreshold, and persists the
// result (Task 22 binding decision 5).
//
// Ordering (documented per binding decision 6): this pass must run AFTER the
// signal/scoring passes that produced the WalletTokenTrade rows it reads,
// and the flow-SCORING pass must be RE-RUN AFTER this clustering pass so
// aggregateWindow (via fetchAggregateInputs' EntityClusterWallet read) picks
// up the freshly-written entityClusterId memberships when it recomputes
// uniqueEntityCount. Concretely: signals -> clustering -> RE-SCORE. Both
// apps/worker/src/jobs/entityClustering.ts and packages/db/src/seed.ts are
// responsible for triggering that re-score themselves (this file only does
// the clustering + stamping, not a scoring re-run — keeping this module's
// own responsibility narrow and testable in isolation).
//
// Determinism: every run WIPES all EntityCluster/EntityClusterWallet rows
// first (deleteMany, FK-safe child-then-parent order) and un-stamps every
// WalletTokenTrade.entityClusterId, then recomputes from scratch. This is
// simpler and more predictable than incremental upsert-merge logic, and
// matches seed.ts's own "wipe-first, deterministic, rerunnable" convention
// used everywhere else in this codebase.
//
// Evidence derivation per pair (documented which of the 14 LinkEvidence
// fields are actually computed vs stubbed false):
//   directTransfer              — COMPUTED: >=1 MoneyFlowEdge transfer row
//                                  directly between the two tracked wallets
//                                  (either direction).
//   repeatedDirectTransfers      — COMPUTED: >=2 such transfer rows.
//   sameFundingSource            — COMPUTED: both wallets' EARLIEST incoming
//                                  transfer (any actionType) came from the
//                                  SAME sourceAddress.
//   sameGasFunder                — STUBBED false (no gas-fee-payer signal
//                                  exists in this schema/mock world; would
//                                  need a distinct "gas payer" column this
//                                  task's ingest pipeline doesn't produce).
//   bridgeAmountTimeMatch        — COMPUTED: a bridge_deposit row from wallet
//                                  A and a bridge_withdrawal row from wallet
//                                  B whose amountUsd is within 10% and whose
//                                  ts gap is <= 2h (a same-actor bridge hop).
//   amountSimilarityAbove90      — COMPUTED: the two wallets' transfer
//                                  amounts (direct or funding) are within
//                                  90% of each other (min/max >= 0.9).
//   destBuysNewTokenWithin60m    — COMPUTED: reuses the fundingEvents-style
//                                  signal — the funded wallet's first BUY of
//                                  ANY token lands within 60 minutes of the
//                                  qualifying incoming transfer.
//   freshWalletActivated         — COMPUTED: the funded wallet's first-ever
//                                  trade (any token) is AFTER the transfer
//                                  that funded it (same freshness test as
//                                  buildFundingEvents).
//   sameTokenRotation            — STUBBED false (profit-rotation matching
//                                  is Task 23's RotationCandidate builder;
//                                  out of this task's scope).
//   repeatedCrossLaunchPattern   — STUBBED false (needs multi-token
//                                  cross-launch history correlation, out of
//                                  this task's scope).
//   cexOrMixerInterruption       — COMPUTED: the path between the two
//                                  wallets passes through an AddressRegistry
//                                  row categorized CEX or MIXER (i.e. one
//                                  wallet sent to / received from a
//                                  known CEX/MIXER address as an intermediate
//                                  hop rather than a direct wallet-to-wallet
//                                  transfer).
//   routerOnlyInteraction        — COMPUTED: the ONLY MoneyFlowEdge activity
//                                  connecting the two wallets is via an
//                                  AddressRegistry ROUTER address (no direct
//                                  transfer between them at all).
//   weakAmountMatch              — COMPUTED: transfer amounts exist but their
//                                  ratio is below the amountSimilarityAbove90
//                                  bar (< 90% match) — a weak, non-committal
//                                  amount correlation.
//   dustOnlyInteraction          — COMPUTED: every MoneyFlowEdge row directly
//                                  linking the two wallets is < $10 USD.
//
// packages/db is the ONLY layer with I/O — all scoring/clustering math is
// delegated to @flowradar/core (calculateWalletLinkConfidence, clusterWallets).

import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { calculateWalletLinkConfidence, clusterWallets } from '@flowradar/core';
import type { Chain, LinkEvidence, Settings } from '@flowradar/core';

/** True for a Prisma FK-violation error (P2003) — see runEntityClustering's per-member insert catch. */
function isForeignKeyViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003';
}

const BRIDGE_MATCH_WINDOW_MS = 2 * 60 * 60_000; // 2h
const BRIDGE_AMOUNT_TOLERANCE = 0.1; // within 10%
const AMOUNT_SIMILARITY_THRESHOLD = 0.9; // within 90%
const FRESH_BUY_WINDOW_MS = 60 * 60_000; // 60 minutes
const DUST_USD_THRESHOLD = 10;

export interface EntityClusteringLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface EntityClusteringResult {
  candidatePairs: number;
  clustersCreated: number;
  largestClusterSize: number;
  walletsClustered: number;
  tradesStamped: number;
}

interface TransferRow {
  sourceAddress: string;
  destinationAddress: string;
  amountUsd: number;
  ts: Date;
  actionType: string;
}

interface PairEvidenceAcc {
  directTransferCount: number;
  directTransferAmounts: number[];
  bridgeDepositsA: { amountUsd: number; ts: Date }[];
  bridgeWithdrawalsB: { amountUsd: number; ts: Date }[];
  bridgeDepositsB: { amountUsd: number; ts: Date }[];
  bridgeWithdrawalsA: { amountUsd: number; ts: Date }[];
  viaCexOrMixer: boolean;
  viaRouterOnly: boolean; // provisional — finalized after direct-transfer count known
  hasAnyDirectRoute: boolean;
}

function pairKeyOf(x: string, y: string): [string, string] {
  return x < y ? [x, y] : [y, x];
}

/**
 * Fetches every KNOWN Wallet row (the candidate universe clustering
 * considers). Deliberately NOT restricted to wallets with >=1 trade: a
 * cluster's pivotal member is often a pure FUNDER wallet that bankrolls
 * other wallets' buys but never itself trades the token being evaluated
 * (e.g. the mock world's `nova-funder` — see packages/providers/src/mock/
 * scenarios.ts's buildNova) — excluding trade-less wallets here would make
 * such a funder permanently unreachable by union-find, even though it's
 * exactly the wallet the "single-funder cluster" pattern needs to surface.
 * Trade-dependent signals (freshWalletActivated, destBuysNewTokenWithin60m)
 * are still correctly derived per-wallet further down (a wallet with no
 * trades at all simply can't satisfy destBuysNewTokenWithin60m).
 */
async function fetchTrackedWallets(prisma: PrismaClient): Promise<
  Map<string, { id: string; address: string; chain: Chain }>
> {
  const rows = await prisma.wallet.findMany({
    select: { id: true, address: true, chain: true }
  });
  const byId = new Map<string, { id: string; address: string; chain: Chain }>();
  for (const row of rows) {
    byId.set(row.id, { id: row.id, address: row.address, chain: row.chain as Chain });
  }
  return byId;
}

async function fetchRegistryCategories(prisma: PrismaClient): Promise<Map<string, string>> {
  const rows = await prisma.addressRegistry.findMany({ select: { address: true, category: true } });
  const byAddress = new Map<string, string>();
  for (const row of rows) {
    byAddress.set(row.address, row.category);
  }
  return byAddress;
}

/**
 * Builds candidate wallet pairs + LinkEvidence from DB signals. Both sides of
 * every candidate pair must be a KNOWN Wallet row (see fetchTrackedWallets
 * above for why trade-less funder wallets are deliberately included in that
 * universe rather than excluded).
 */
async function deriveCandidateLinks(
  prisma: PrismaClient,
  trackedWallets: Map<string, { id: string; address: string; chain: Chain }>
): Promise<{ a: string; b: string; confidence: number; evidence: LinkEvidence }[]> {
  const addressToWalletId = new Map<string, string>();
  for (const w of trackedWallets.values()) {
    addressToWalletId.set(w.address, w.id);
  }
  const trackedAddresses = [...addressToWalletId.keys()];
  if (trackedAddresses.length === 0) return [];

  const registryByAddress = await fetchRegistryCategories(prisma);

  // Every MoneyFlowEdge row touching >=1 tracked address on either side —
  // this covers direct wallet-to-wallet transfers, funding transfers, and
  // bridge/CEX/router hops alike.
  const edges = await prisma.moneyFlowEdge.findMany({
    where: {
      OR: [{ sourceAddress: { in: trackedAddresses } }, { destinationAddress: { in: trackedAddresses } }]
    },
    select: {
      sourceAddress: true,
      destinationAddress: true,
      amountUsd: true,
      ts: true,
      actionType: true
    }
  });

  const rows: TransferRow[] = edges.map((e) => ({
    sourceAddress: e.sourceAddress,
    destinationAddress: e.destinationAddress,
    amountUsd: Number(e.amountUsd),
    ts: e.ts,
    actionType: e.actionType
  }));

  // -- Direct wallet<->wallet transfers (both sides tracked) --------------
  const pairAcc = new Map<string, PairEvidenceAcc>();
  function getAcc(key: string): PairEvidenceAcc {
    let acc = pairAcc.get(key);
    if (!acc) {
      acc = {
        directTransferCount: 0,
        directTransferAmounts: [],
        bridgeDepositsA: [],
        bridgeWithdrawalsB: [],
        bridgeDepositsB: [],
        bridgeWithdrawalsA: [],
        viaCexOrMixer: false,
        viaRouterOnly: false,
        hasAnyDirectRoute: false
      };
      pairAcc.set(key, acc);
    }
    return acc;
  }

  for (const row of rows) {
    const srcTracked = addressToWalletId.has(row.sourceAddress);
    const destTracked = addressToWalletId.has(row.destinationAddress);

    if (srcTracked && destTracked && row.sourceAddress !== row.destinationAddress) {
      const walletA = addressToWalletId.get(row.sourceAddress)!;
      const walletB = addressToWalletId.get(row.destinationAddress)!;
      const [x, y] = pairKeyOf(walletA, walletB);
      const key = `${x} ${y}`;
      const acc = getAcc(key);
      acc.hasAnyDirectRoute = true;

      if (row.actionType === 'transfer') {
        acc.directTransferCount += 1;
        acc.directTransferAmounts.push(row.amountUsd);
      }
      continue;
    }

    // One-side-tracked rows: routed through a registry-known intermediary
    // (CEX/MIXER/ROUTER) — relevant to pairs where BOTH tracked wallets
    // separately touch the SAME intermediary address (handled via the
    // byIntermediary pass below), so nothing to do here per-row beyond
    // collecting bridge legs (handled next).
  }

  // -- Bridge amount/time matching: bridge_deposit from A + bridge_withdrawal
  // "from" B (i.e. B is the source of a bridge_withdrawal row, representing
  // funds arriving to B on the other chain) within a tight amount+time
  // window -> same-actor bridge hop. --------------------------------------
  const bridgeDeposits = rows.filter((r) => r.actionType === 'bridge_deposit' && addressToWalletId.has(r.sourceAddress));
  const bridgeWithdrawals = rows.filter(
    (r) => r.actionType === 'bridge_withdrawal' && addressToWalletId.has(r.destinationAddress)
  );

  for (const dep of bridgeDeposits) {
    const walletA = addressToWalletId.get(dep.sourceAddress)!;
    for (const wd of bridgeWithdrawals) {
      const walletB = addressToWalletId.get(wd.destinationAddress)!;
      if (walletA === walletB) continue;
      const timeDiff = Math.abs(wd.ts.getTime() - dep.ts.getTime());
      if (timeDiff > BRIDGE_MATCH_WINDOW_MS) continue;
      if (dep.amountUsd <= 0 || wd.amountUsd <= 0) continue;
      const ratio = Math.min(dep.amountUsd, wd.amountUsd) / Math.max(dep.amountUsd, wd.amountUsd);
      if (ratio < 1 - BRIDGE_AMOUNT_TOLERANCE) continue;

      const [x, y] = pairKeyOf(walletA, walletB);
      const key = `${x} ${y}`;
      const acc = getAcc(key);
      acc.bridgeDepositsA.push({ amountUsd: dep.amountUsd, ts: dep.ts });
      acc.bridgeWithdrawalsB.push({ amountUsd: wd.amountUsd, ts: wd.ts });
    }
  }

  // -- CEX/MIXER interruption + router-only interaction: for every pair of
  // tracked wallets that BOTH touch the same registry-known CEX/MIXER/ROUTER
  // address (one wallet -> intermediary, intermediary -> other wallet, or
  // both -> intermediary), flag the pair. -----------------------------------
  const byIntermediary = new Map<string, { walletId: string; category: string }[]>();
  for (const row of rows) {
    for (const [addr, otherAddr] of [
      [row.sourceAddress, row.destinationAddress],
      [row.destinationAddress, row.sourceAddress]
    ] as const) {
      const category = registryByAddress.get(addr);
      if (!category) continue;
      if (category !== 'CEX' && category !== 'MIXER' && category !== 'ROUTER') continue;
      const otherWalletId = addressToWalletId.get(otherAddr);
      if (!otherWalletId) continue;
      const list = byIntermediary.get(addr) ?? [];
      list.push({ walletId: otherWalletId, category });
      byIntermediary.set(addr, list);
    }
  }
  for (const touches of byIntermediary.values()) {
    const uniqueWallets = [...new Set(touches.map((t) => t.walletId))];
    if (uniqueWallets.length < 2) continue;
    const category = touches[0]!.category;
    for (let i = 0; i < uniqueWallets.length; i++) {
      for (let j = i + 1; j < uniqueWallets.length; j++) {
        const [x, y] = pairKeyOf(uniqueWallets[i]!, uniqueWallets[j]!);
        const key = `${x} ${y}`;
        const acc = getAcc(key);
        if (category === 'CEX' || category === 'MIXER') {
          acc.viaCexOrMixer = true;
        } else if (category === 'ROUTER') {
          acc.viaRouterOnly = true;
        }
      }
    }
  }

  // -- sameFundingSource / freshWalletActivated / destBuysNewTokenWithin60m:
  // for every tracked wallet, find its EARLIEST incoming transfer (any
  // actionType) and its first-ever trade timestamp. Two wallets funded by
  // the SAME source address share sameFundingSource; freshWalletActivated
  // and destBuysNewTokenWithin60m are evaluated per-wallet then applied to
  // every pair that wallet participates in via sameFundingSource OR direct
  // transfer (the funding wallet <-> funded wallet pair itself).
  const earliestIncomingByWallet = new Map<string, { sourceAddress: string; ts: Date; amountUsd: number }>();
  for (const row of rows) {
    const destWalletId = addressToWalletId.get(row.destinationAddress);
    if (!destWalletId) continue;
    const existing = earliestIncomingByWallet.get(destWalletId);
    if (!existing || row.ts.getTime() < existing.ts.getTime()) {
      earliestIncomingByWallet.set(destWalletId, {
        sourceAddress: row.sourceAddress,
        ts: row.ts,
        amountUsd: row.amountUsd
      });
    }
  }

  const trackedWalletIds = [...trackedWallets.keys()];
  const firstTradeRows = await prisma.walletTokenTrade.findMany({
    where: { walletId: { in: trackedWalletIds } },
    orderBy: { ts: 'asc' },
    select: { walletId: true, ts: true }
  });
  const firstTradeTsByWallet = new Map<string, Date>();
  for (const row of firstTradeRows) {
    if (!firstTradeTsByWallet.has(row.walletId)) firstTradeTsByWallet.set(row.walletId, row.ts);
  }

  // Group wallets by their earliest-incoming-transfer source address —
  // wallets sharing a source (that source ALSO being a tracked wallet, so
  // the pair itself is representable) form sameFundingSource pairs, and
  // freshWalletActivated/destBuysNewTokenWithin60m apply to the
  // (funder, funded) pair specifically.
  const walletsBySourceAddress = new Map<string, string[]>();
  for (const [walletId, incoming] of earliestIncomingByWallet.entries()) {
    const list = walletsBySourceAddress.get(incoming.sourceAddress) ?? [];
    list.push(walletId);
    walletsBySourceAddress.set(incoming.sourceAddress, list);
  }

  const freshFlagByWallet = new Map<string, boolean>();
  const destBuyWithin60mByWallet = new Map<string, boolean>();
  for (const [walletId, incoming] of earliestIncomingByWallet.entries()) {
    const firstTradeTs = firstTradeTsByWallet.get(walletId);
    const fresh = firstTradeTs === undefined || firstTradeTs.getTime() > incoming.ts.getTime();
    freshFlagByWallet.set(walletId, fresh);
    const boughtWithin60m =
      firstTradeTs !== undefined && firstTradeTs.getTime() - incoming.ts.getTime() <= FRESH_BUY_WINDOW_MS && firstTradeTs.getTime() >= incoming.ts.getTime();
    destBuyWithin60mByWallet.set(walletId, boughtWithin60m);
  }

  const sameFundingPairs = new Set<string>();
  for (const [sourceAddress, walletIds] of walletsBySourceAddress.entries()) {
    if (walletIds.length < 2) continue;
    for (let i = 0; i < walletIds.length; i++) {
      for (let j = i + 1; j < walletIds.length; j++) {
        const [x, y] = pairKeyOf(walletIds[i]!, walletIds[j]!);
        sameFundingPairs.add(`${x} ${y}`);
      }
    }
    // If the shared source address is ITSELF a tracked wallet, also pair
    // funder<->each funded wallet (direct funding relationship).
    const funderWalletId = addressToWalletId.get(sourceAddress);
    if (funderWalletId) {
      for (const funded of walletIds) {
        if (funded === funderWalletId) continue;
        const [x, y] = pairKeyOf(funderWalletId, funded);
        const key = `${x} ${y}`;
        const acc = getAcc(key);
        acc.hasAnyDirectRoute = true; // funder->funded is itself a direct transfer relationship
      }
    }
  }

  // -- Build final links -----------------------------------------------------
  const links: { a: string; b: string; confidence: number; evidence: LinkEvidence }[] = [];

  const allPairKeys = new Set<string>([...pairAcc.keys(), ...sameFundingPairs]);

  for (const key of allPairKeys) {
    const [a, b] = key.split(' ') as [string, string];
    const acc = pairAcc.get(key);

    const directTransferCount = acc?.directTransferCount ?? 0;
    const directTransferAmounts = acc?.directTransferAmounts ?? [];

    const bridgeMatch =
      (acc?.bridgeDepositsA.length ?? 0) > 0 && (acc?.bridgeWithdrawalsB.length ?? 0) > 0;

    const sameFundingSource = sameFundingPairs.has(key);

    // freshWalletActivated / destBuysNewTokenWithin60m: true if EITHER
    // member of the pair exhibits the signal (the pair represents a
    // funder<->funded relationship where one side is the fresh/funded one).
    const freshWalletActivated = (freshFlagByWallet.get(a) ?? false) || (freshFlagByWallet.get(b) ?? false);
    const destBuysNewTokenWithin60m =
      (destBuyWithin60mByWallet.get(a) ?? false) || (destBuyWithin60mByWallet.get(b) ?? false);

    // Amount similarity: compare direct-transfer amounts pairwise (max vs
    // min) if >=2 amounts exist, else compare against bridge-matched
    // amounts if present.
    let amountRatio: number | null = null;
    if (directTransferAmounts.length >= 2) {
      const min = Math.min(...directTransferAmounts);
      const max = Math.max(...directTransferAmounts);
      amountRatio = max > 0 ? min / max : null;
    } else if (bridgeMatch) {
      const depAmt = acc!.bridgeDepositsA[0]!.amountUsd;
      const wdAmt = acc!.bridgeWithdrawalsB[0]!.amountUsd;
      amountRatio = Math.max(depAmt, wdAmt) > 0 ? Math.min(depAmt, wdAmt) / Math.max(depAmt, wdAmt) : null;
    }

    const amountSimilarityAbove90 = amountRatio !== null && amountRatio >= AMOUNT_SIMILARITY_THRESHOLD;
    const weakAmountMatch = amountRatio !== null && amountRatio < AMOUNT_SIMILARITY_THRESHOLD;

    const allDirectAmountsAreDust =
      directTransferAmounts.length > 0 && directTransferAmounts.every((amt) => amt < DUST_USD_THRESHOLD);

    // routerOnlyInteraction: flagged as router-only ONLY when there is no
    // direct wallet-to-wallet transfer between the pair at all (the only
    // interaction is via the router intermediary).
    const routerOnlyInteraction = (acc?.viaRouterOnly ?? false) && directTransferCount === 0;

    const evidence: LinkEvidence = {
      directTransfer: directTransferCount >= 1,
      repeatedDirectTransfers: directTransferCount >= 2,
      sameFundingSource,
      sameGasFunder: false, // not cheaply derivable from this schema — see file header
      bridgeAmountTimeMatch: bridgeMatch,
      amountSimilarityAbove90,
      destBuysNewTokenWithin60m,
      freshWalletActivated,
      sameTokenRotation: false, // Task 23 scope — see file header
      repeatedCrossLaunchPattern: false, // Task 23 scope — see file header
      cexOrMixerInterruption: acc?.viaCexOrMixer ?? false,
      routerOnlyInteraction,
      weakAmountMatch,
      dustOnlyInteraction: allDirectAmountsAreDust
    };

    const confidence = calculateWalletLinkConfidence(evidence);
    links.push({ a, b, confidence, evidence });
  }

  return links;
}

/**
 * Runs one full entity-clustering pass: derives candidate wallet-pair
 * LinkEvidence from DB signals, scores each pair, clusters wallets at
 * settings.entityConfidenceThreshold, wipes prior clusters, persists new
 * EntityCluster/EntityClusterWallet rows, and stamps entityClusterId onto
 * every clustered wallet's WalletTokenTrade rows.
 *
 * IMPORTANT (see file header "Ordering"): callers must re-run the
 * flow-scoring pass AFTER this function returns so uniqueEntityCount reflects
 * the newly-written cluster memberships. This function does NOT re-score
 * itself.
 */
export async function runEntityClustering(
  prisma: PrismaClient,
  settings: Settings,
  log?: EntityClusteringLogger
): Promise<EntityClusteringResult> {
  const trackedWallets = await fetchTrackedWallets(prisma);
  const links = await deriveCandidateLinks(prisma, trackedWallets);

  const { clusters: rawClusters } = clusterWallets({ links, threshold: settings.entityConfidenceThreshold });

  // Wipe prior clusters first (determinism — see file header).
  await prisma.walletTokenTrade.updateMany({
    where: { entityClusterId: { not: null } },
    data: { entityClusterId: null }
  });
  await prisma.entityClusterWallet.deleteMany();
  await prisma.entityCluster.deleteMany();

  // Re-verify every member wallet id still exists right before the write
  // phase: `trackedWallets` was read at the START of this pass, and this
  // function makes several `await`-separated DB round trips between then and
  // the EntityClusterWallet inserts below (each with its own FK to Wallet).
  // In single-process production use (worker tick / seed script) no other
  // actor deletes Wallet rows mid-pass, so this is a no-op filter; it exists
  // so a wallet that genuinely vanished between read and write (e.g. a
  // concurrent process) degrades to "drop that member" instead of throwing
  // and abandoning the whole pass.
  const stillExistingIds = new Set(
    (await prisma.wallet.findMany({ select: { id: true } })).map((w) => w.id)
  );
  const clusters = rawClusters
    .map((cluster) => ({ ...cluster, members: cluster.members.filter((id) => stillExistingIds.has(id)) }))
    .filter((cluster) => cluster.members.length >= 2);

  let walletsClustered = 0;
  let largestClusterSize = 0;
  let tradesStamped = 0;

  for (const cluster of clusters) {
    largestClusterSize = Math.max(largestClusterSize, cluster.members.length);

    const memberChains = new Set<Chain>();
    for (const walletId of cluster.members) {
      const w = trackedWallets.get(walletId);
      if (w) memberChains.add(w.chain);
    }

    const statsRows = await prisma.walletStats.findMany({
      where: { walletId: { in: cluster.members } },
      orderBy: { computedAt: 'desc' },
      select: { walletId: true, pnlUsd: true }
    });
    const latestPnlByWallet = new Map<string, number>();
    for (const row of statsRows) {
      if (!latestPnlByWallet.has(row.walletId)) latestPnlByWallet.set(row.walletId, Number(row.pnlUsd));
    }
    const total30dPnlUsd = [...latestPnlByWallet.values()].reduce((sum, v) => sum + v, 0);

    // mainFundingSource: most common earliest-incoming source address among
    // member wallets (re-derived cheaply here from evidence rather than
    // threading extra state through clusterWallets' generic output shape).
    const fundingSourceCounts = new Map<string, number>();
    const memberAddresses = cluster.members
      .map((id) => trackedWallets.get(id)?.address)
      .filter((a): a is string => a !== undefined);
    if (memberAddresses.length > 0) {
      const incomingRows = await prisma.moneyFlowEdge.findMany({
        where: { destinationAddress: { in: memberAddresses } },
        orderBy: { ts: 'asc' },
        select: { destinationAddress: true, sourceAddress: true, ts: true }
      });
      const earliestSourceByAddress = new Map<string, string>();
      for (const row of incomingRows) {
        if (!earliestSourceByAddress.has(row.destinationAddress)) {
          earliestSourceByAddress.set(row.destinationAddress, row.sourceAddress);
        }
      }
      for (const source of earliestSourceByAddress.values()) {
        fundingSourceCounts.set(source, (fundingSourceCounts.get(source) ?? 0) + 1);
      }
    }
    let mainFundingSource: string | undefined;
    let mainFundingSourceCount = 0;
    for (const [source, count] of fundingSourceCounts.entries()) {
      if (count > mainFundingSourceCount) {
        mainFundingSource = source;
        mainFundingSourceCount = count;
      }
    }

    const createdCluster = await prisma.entityCluster.create({
      data: {
        confidence: cluster.confidence,
        walletCount: cluster.members.length,
        total30dPnlUsd,
        chains: [...memberChains],
        evidence: cluster.evidenceByPair as unknown as object,
        ...(mainFundingSource ? { mainFundingSource } : {})
      }
    });

    for (const walletId of cluster.members) {
      // Per-member linkConfidence: reuse the pair-level max touching this
      // member if available, else fall back to the cluster's own mean
      // confidence (a member could in principle appear in evidenceByPair
      // under either orientation — searched both).
      let memberEvidence: LinkEvidence | undefined;
      let memberConfidence = cluster.confidence;
      for (const [pairKey, evidence] of Object.entries(cluster.evidenceByPair)) {
        const [x, y] = pairKey.split(':');
        if (x === walletId || y === walletId) {
          memberEvidence = evidence;
          break;
        }
      }
      const evidenceForRow = memberEvidence ?? ({} as LinkEvidence);

      try {
        await prisma.entityClusterWallet.create({
          data: {
            clusterId: createdCluster.id,
            walletId,
            linkConfidence: memberConfidence,
            evidence: evidenceForRow as unknown as object
          }
        });
        walletsClustered += 1;
      } catch (error) {
        // P2003 = FK violation (walletId no longer exists). This can only
        // happen if another actor deleted the Wallet row between this
        // pass's initial read and this write — never true in single-process
        // production use (worker tick / seed script), but a real
        // possibility when multiple test files race against the same
        // shared LITE-mode Postgres instance. Skip this member rather than
        // aborting the whole clustering pass.
        if (isForeignKeyViolation(error)) {
          log?.error('entityClustering: skipped a member whose Wallet row vanished mid-pass', { walletId });
          continue;
        }
        throw error;
      }
    }

    const stampResult = await prisma.walletTokenTrade.updateMany({
      where: { walletId: { in: cluster.members } },
      data: { entityClusterId: createdCluster.id }
    });
    tradesStamped += stampResult.count;
  }

  const result: EntityClusteringResult = {
    candidatePairs: links.length,
    clustersCreated: clusters.length,
    largestClusterSize,
    walletsClustered,
    tradesStamped
  };
  log?.info('entityClustering pass complete', { ...result });
  return result;
}
