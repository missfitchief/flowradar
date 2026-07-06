// FlowRadar — rotation.ts: buildRotationInputs + runProfitRotation (Task 23
// binding decision 2).
//
// buildRotationInputs assembles @flowradar/core's matchRotations() input rows
// straight from raw DB tables (mirrors packages/db/src/fundingEvents.ts's own
// "raw MoneyFlowEdge rows -> pure-core input shape" pattern):
//   ProfitExit  — every WalletTokenTrade SELL row, walletId+tokenId scoped,
//                 with realizedProfitUsd = the CUMULATIVE FIFO-realized PnL
//                 for that wallet+token as of (and including) that SELL,
//                 computed via @flowradar/core's computeFifoPnl over every
//                 BUY/SELL trade for that wallet+token with ts <= the SELL's
//                 own ts (a wallet can "exit profitably" more than once for
//                 the same token — each qualifying SELL is its own
//                 ProfitExit instant; matchRotations' own per-exit loop
//                 naturally dedupes to whichever produces a valid candidate
//                 chain).
//   TransferRec — MoneyFlowEdge rows join address -> Wallet.id:
//                 `transfer` actionType rows (both sides tracked) are direct
//                 same-chain transfers (bridged=false); `bridge_deposit` rows
//                 (source tracked) paired with `bridge_withdrawal` rows
//                 (destination tracked) represent a cross-chain bridge hop.
//                 Each deposit is paired to AT MOST ONE withdrawal via
//                 `pairBridgeLegs` below — same-protocol, amount within 10%,
//                 time gap <= 2h, picking the closest amount-ratio match
//                 first (greedy bipartite matching, mirrors clustering.ts's
//                 own bridgeAmountTimeMatch tolerance constants). This
//                 pairing is NOT optional/best-effort: two independent bridge
//                 hops sharing a protocol name (e.g. two different users both
//                 using "Wormhole" close together in time) MUST resolve to
//                 their own correct destination wallet, not whichever
//                 same-protocol withdrawal happens to be found first — a
//                 naive "first same-protocol match" (the pre-fix behavior)
//                 silently cross-wires unrelated hops' toWalletId/chainTo.
//                 The paired deposit becomes the "transfer" leg (source
//                 wallet's side, with toWalletId/chainTo corrected to the
//                 paired withdrawal's destination) and the withdrawal becomes
//                 the "receipt" leg (dest wallet's side). Direct `transfer`
//                 rows are fed into BOTH transfers AND receipts (a direct
//                 transfer IS its own receipt — same row, matchRotations' own
//                 receipt search finds it via the ts>=transfer.ts +
//                 amount-ratio-100% match).
//   DestBuy     — every WalletTokenTrade BUY row (walletId+tokenId+usd+ts+
//                 mcapAtBuy=marketCapAtTrade).
//
// runProfitRotation assembles inputs for the full lookback window, matches,
// then persists a ProfitRotationSignal row per candidate — deduped on
// (sourceWalletId, destWalletId, destTokenId) within the same lookback window
// (a rotation that's already been recorded for this wallet pair + dest token
// recently shouldn't spawn a duplicate row every tick, mirroring signals.ts's
// own "dedupe within a window" convention). currentDestPerfPct is derived
// from the dest token's latest TokenMarketSnapshot vs the candidate's
// destTokenMcapAtBuy (mirrors flowScore.ts's own mcapExpansionFromAvgEntry
// growth-ratio shape: currentMcap/mcapAtBuy - 1, as a percentage).
//
// The matched candidates are also returned (not just persisted) so
// signals.ts's runSignalDetectionPass can feed them straight into
// evaluateAllRules as RuleExtras.rotationCandidates without re-querying or
// re-parsing ProfitRotationSignal rows back into RotationCandidate shape.

import type { PrismaClient } from '@prisma/client';
import { computeFifoPnl, matchRotations } from '@flowradar/core';
import type { DestBuy, MatchedRotationCandidate, ProfitExit, Settings, TransferRec } from '@flowradar/core';

const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;

// Bridge-leg matching tolerances — mirrors clustering.ts's own
// bridgeAmountTimeMatch constants (BRIDGE_MATCH_WINDOW_MS /
// BRIDGE_AMOUNT_TOLERANCE) exactly, so a pair that clustering.ts considers a
// same-actor bridge hop is the SAME pair this module considers a candidate
// bridge leg for rotation matching.
const BRIDGE_MATCH_WINDOW_MS = 2 * 60 * 60_000; // 2h
const BRIDGE_AMOUNT_TOLERANCE = 0.1; // within 10%

export interface RotationInputs {
  exits: ProfitExit[];
  transfers: TransferRec[];
  receipts: TransferRec[];
  destBuys: DestBuy[];
}

interface BridgeEdgeRow {
  sourceAddress: string;
  destinationAddress: string;
  sourceChain: string;
  destinationChain: string;
  amountUsd: number;
  ts: Date;
  bridgeProtocol: string | null;
  actionType: string;
}

/**
 * One-to-one greedy bipartite matching of bridge_deposit rows to
 * bridge_withdrawal rows: same bridgeProtocol, ts gap <= 2h, amount ratio
 * within 10% — identical tolerances to clustering.ts's own
 * bridgeAmountTimeMatch derivation. Each deposit is paired to AT MOST ONE
 * withdrawal (picking the CLOSEST amount-ratio match among all qualifying
 * candidates, greedily, best-pairs-first) and vice versa — two independent
 * same-protocol bridge hops happening close together in time must not
 * silently cross-wire to each other's destination wallet (a naive "first
 * same-protocol match" does exactly that when >1 hop of the same protocol is
 * in flight at once).
 */
function pairBridgeLegs(
  deposits: BridgeEdgeRow[],
  withdrawals: BridgeEdgeRow[]
): { deposit: BridgeEdgeRow; withdrawal: BridgeEdgeRow }[] {
  interface Candidate {
    depositIdx: number;
    withdrawalIdx: number;
    ratio: number;
  }
  const candidates: Candidate[] = [];

  for (let di = 0; di < deposits.length; di++) {
    const dep = deposits[di]!;
    if (dep.amountUsd <= 0) continue;
    for (let wi = 0; wi < withdrawals.length; wi++) {
      const wd = withdrawals[wi]!;
      if (wd.amountUsd <= 0) continue;
      if ((dep.bridgeProtocol ?? null) !== (wd.bridgeProtocol ?? null)) continue;
      const timeDiff = Math.abs(wd.ts.getTime() - dep.ts.getTime());
      if (timeDiff > BRIDGE_MATCH_WINDOW_MS) continue;
      const ratio = Math.min(dep.amountUsd, wd.amountUsd) / Math.max(dep.amountUsd, wd.amountUsd);
      if (ratio < 1 - BRIDGE_AMOUNT_TOLERANCE) continue;
      candidates.push({ depositIdx: di, withdrawalIdx: wi, ratio });
    }
  }

  // Greedy: best (highest-ratio, i.e. closest amount match) pairs first, each
  // deposit/withdrawal consumed at most once.
  candidates.sort((a, b) => b.ratio - a.ratio);

  const usedDeposits = new Set<number>();
  const usedWithdrawals = new Set<number>();
  const pairs: { deposit: BridgeEdgeRow; withdrawal: BridgeEdgeRow }[] = [];

  for (const c of candidates) {
    if (usedDeposits.has(c.depositIdx) || usedWithdrawals.has(c.withdrawalIdx)) continue;
    usedDeposits.add(c.depositIdx);
    usedWithdrawals.add(c.withdrawalIdx);
    pairs.push({ deposit: deposits[c.depositIdx]!, withdrawal: withdrawals[c.withdrawalIdx]! });
  }

  return pairs;
}

/**
 * Assembles matchRotations() input rows from raw DB tables for the window
 * [windowFrom, now]. Trade rows themselves are read with NO lower bound
 * (FIFO PnL needs full history to be accurate — same "full scan, small
 * mock-scale dataset" tradeoff fetchAggregateInputs.ts's own header
 * documents), but ProfitExit/DestBuy rows this function EMITS are restricted
 * to SELL/BUY trades with ts in [windowFrom, now] (a rotation whose exit or
 * dest-buy happened before the lookback window isn't relevant to the current
 * pass).
 */
export async function buildRotationInputs(prisma: PrismaClient, windowFrom: Date, now: Date): Promise<RotationInputs> {
  // -- ProfitExit: every SELL in-window, walletId+tokenId scoped, with
  // cumulative FIFO realized PnL as of that SELL. --------------------------
  const sellsInWindow = await prisma.walletTokenTrade.findMany({
    where: { action: 'SELL', ts: { gte: windowFrom, lte: now } },
    select: { walletId: true, tokenId: true, ts: true },
    orderBy: { ts: 'asc' }
  });

  const walletTokenPairs = new Set(sellsInWindow.map((s) => `${s.walletId}:${s.tokenId}`));

  // Full BUY/SELL trade history per (walletId, tokenId) pair that has >=1
  // in-window SELL — FIFO needs the complete history up to `now`, not just
  // the window slice.
  const walletIds = [...new Set(sellsInWindow.map((s) => s.walletId))];
  const tokenIds = [...new Set(sellsInWindow.map((s) => s.tokenId))];
  const allTradesForPairs = walletTokenPairs.size > 0
    ? await prisma.walletTokenTrade.findMany({
        where: {
          walletId: { in: walletIds },
          tokenId: { in: tokenIds },
          action: { in: ['BUY', 'SELL'] },
          ts: { lte: now }
        },
        select: { walletId: true, tokenId: true, action: true, amountToken: true, amountUsd: true, ts: true },
        orderBy: { ts: 'asc' }
      })
    : [];

  const tradesByPair = new Map<string, { action: 'BUY' | 'SELL'; amountToken: number; amountUsd: number; ts: Date }[]>();
  for (const t of allTradesForPairs) {
    const key = `${t.walletId}:${t.tokenId}`;
    if (!walletTokenPairs.has(key)) continue;
    const list = tradesByPair.get(key) ?? [];
    list.push({ action: t.action as 'BUY' | 'SELL', amountToken: Number(t.amountToken), amountUsd: Number(t.amountUsd), ts: t.ts });
    tradesByPair.set(key, list);
  }

  const exits: ProfitExit[] = [];
  for (const sell of sellsInWindow) {
    const key = `${sell.walletId}:${sell.tokenId}`;
    const allTrades = tradesByPair.get(key) ?? [];
    const tradesUpToExit = allTrades.filter((t) => t.ts.getTime() <= sell.ts.getTime());
    const { realizedUsd } = computeFifoPnl(tradesUpToExit, null);
    exits.push({
      walletId: sell.walletId,
      tokenId: sell.tokenId,
      realizedProfitUsd: realizedUsd,
      exitTs: sell.ts
    });
  }

  // -- TransferRec (transfers + receipts): MoneyFlowEdge rows joined
  // address -> Wallet.id. ----------------------------------------------------
  const edges = await prisma.moneyFlowEdge.findMany({
    where: {
      ts: { gte: windowFrom, lte: now },
      actionType: { in: ['transfer', 'bridge_deposit', 'bridge_withdrawal'] }
    },
    select: {
      sourceAddress: true,
      destinationAddress: true,
      sourceChain: true,
      destinationChain: true,
      amountUsd: true,
      ts: true,
      actionType: true,
      bridgeProtocol: true
    }
  });

  const allAddresses = [...new Set(edges.flatMap((e) => [e.sourceAddress, e.destinationAddress]))];
  const walletRows =
    allAddresses.length > 0
      ? await prisma.wallet.findMany({
          where: { address: { in: allAddresses } },
          select: { id: true, address: true, chain: true }
        })
      : [];
  const walletIdByAddressChain = new Map(walletRows.map((w) => [`${w.address}:${w.chain}`, w.id]));

  const normalizedEdges: BridgeEdgeRow[] = edges.map((e) => ({
    sourceAddress: e.sourceAddress,
    destinationAddress: e.destinationAddress,
    sourceChain: e.sourceChain,
    destinationChain: e.destinationChain,
    amountUsd: Number(e.amountUsd),
    ts: e.ts,
    bridgeProtocol: e.bridgeProtocol,
    actionType: e.actionType
  }));

  const directTransfers = normalizedEdges.filter((e) => e.actionType === 'transfer');
  const bridgeDeposits = normalizedEdges.filter((e) => e.actionType === 'bridge_deposit');
  const bridgeWithdrawals = normalizedEdges.filter((e) => e.actionType === 'bridge_withdrawal');

  const transfers: TransferRec[] = [];
  const receipts: TransferRec[] = [];

  for (const edge of directTransfers) {
    const fromWalletId = walletIdByAddressChain.get(`${edge.sourceAddress}:${edge.sourceChain}`);
    const toWalletId = walletIdByAddressChain.get(`${edge.destinationAddress}:${edge.destinationChain}`);
    if (!fromWalletId || !toWalletId) continue; // one side isn't a known Wallet row

    const rec: TransferRec = {
      fromWalletId,
      toWalletId,
      amountUsd: Number(edge.amountUsd),
      ts: edge.ts,
      bridged: false,
      chainFrom: edge.sourceChain,
      chainTo: edge.destinationChain
    };
    // A direct transfer is its own receipt (same row) — fed into both arrays
    // so matchRotations' receipt search (ts >= transfer.ts, same wallet
    // pair) finds a 100%-value-match receipt for the non-bridged case.
    transfers.push(rec);
    receipts.push(rec);
  }

  // Pair each bridge_deposit with AT MOST ONE bridge_withdrawal (greedy
  // best-amount-ratio-match, see pairBridgeLegs below) BEFORE building any
  // TransferRec/receipt rows from them — this is what prevents two
  // independent same-protocol bridge hops from cross-wiring each other's
  // destination wallet (see this file's header).
  const bridgePairs = pairBridgeLegs(bridgeDeposits, bridgeWithdrawals);

  for (const { deposit: dep, withdrawal: wd } of bridgePairs) {
    const fromWalletId = walletIdByAddressChain.get(`${dep.sourceAddress}:${dep.sourceChain}`);
    const toWalletId = walletIdByAddressChain.get(`${wd.destinationAddress}:${wd.destinationChain}`);
    if (!fromWalletId || !toWalletId) continue; // bridge program address itself is never a known Wallet row

    transfers.push({
      fromWalletId,
      toWalletId,
      amountUsd: Number(dep.amountUsd),
      ts: dep.ts,
      bridged: true,
      bridgeProtocol: dep.bridgeProtocol ?? undefined,
      chainFrom: dep.sourceChain,
      chainTo: wd.destinationChain
    });
    receipts.push({
      fromWalletId,
      toWalletId,
      amountUsd: Number(wd.amountUsd),
      ts: wd.ts,
      bridged: true,
      bridgeProtocol: wd.bridgeProtocol ?? undefined,
      chainFrom: dep.sourceChain,
      chainTo: wd.destinationChain
    });
  }

  // -- DestBuy: every BUY trade in-window. -----------------------------------
  const buysInWindow = await prisma.walletTokenTrade.findMany({
    where: { action: 'BUY', ts: { gte: windowFrom, lte: now } },
    select: { walletId: true, tokenId: true, amountUsd: true, ts: true, marketCapAtTrade: true }
  });
  const destBuys: DestBuy[] = buysInWindow.map((b) => ({
    walletId: b.walletId,
    tokenId: b.tokenId,
    usd: Number(b.amountUsd),
    ts: b.ts,
    mcapAtBuy: b.marketCapAtTrade !== null ? Number(b.marketCapAtTrade) : null
  }));

  return { exits, transfers, receipts, destBuys };
}

export interface ProfitRotationLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface ProfitRotationResult {
  candidatesMatched: number;
  signalsCreated: number;
  signalsDeduped: number;
}

/**
 * Runs one full profit-rotation pass: builds matchRotations() inputs for the
 * trailing `lookbackHours` window (default 48h — long enough to comfortably
 * cover the mock ALPHA->BETA scenario's ~7h exit-to-buy chain plus
 * F.maxTransferDelayHours=24's own worst case), matches, persists a
 * ProfitRotationSignal row per NEW candidate (deduped on
 * sourceWalletId+destWalletId+destTokenId within the last 24h), and returns
 * the matched candidates themselves for the caller (signals.ts) to feed
 * straight into evaluateAllRules.
 */
export async function runProfitRotation(
  prisma: PrismaClient,
  settings: Settings,
  now: Date = new Date(),
  log?: ProfitRotationLogger
): Promise<{ result: ProfitRotationResult; candidates: MatchedRotationCandidate[] }> {
  const lookbackMs = 48 * 60 * 60 * 1000;
  const windowFrom = new Date(now.getTime() - lookbackMs);

  const inputs = await buildRotationInputs(prisma, windowFrom, now);
  const candidates = matchRotations({ ...inputs, settings });

  let signalsCreated = 0;
  let signalsDeduped = 0;

  for (const candidate of candidates) {
    const dedupeWindowStart = new Date(now.getTime() - DEDUPE_WINDOW_MS);
    const existing = await prisma.profitRotationSignal.findFirst({
      where: {
        sourceWalletId: candidate.sourceWalletId,
        destWalletId: candidate.destWalletId,
        destTokenId: candidate.destTokenId,
        detectedAt: { gte: dedupeWindowStart }
      },
      select: { id: true }
    });
    if (existing) {
      signalsDeduped += 1;
      continue;
    }

    const currentDestPerfPct = await computeCurrentDestPerfPct(prisma, candidate.destTokenId, candidate.destTokenMcapAtBuy);

    const confidence = confidenceForCandidate(candidate);

    await prisma.profitRotationSignal.create({
      data: {
        sourceWalletId: candidate.sourceWalletId,
        destWalletId: candidate.destWalletId,
        sourceTokenId: candidate.sourceTokenId,
        destTokenId: candidate.destTokenId,
        realizedProfitUsd: candidate.realizedProfitUsd,
        transferredValueUsd: candidate.transferredValueUsd,
        chainPath: candidate.chainPath as ('SOLANA' | 'BSC')[],
        timeGapMin: candidate.timeGapMin,
        confidence,
        detectedAt: now,
        destTokenMcapAtBuy: candidate.destTokenMcapAtBuy ?? 0,
        currentDestPerfPct
      }
    });
    signalsCreated += 1;
  }

  const result: ProfitRotationResult = {
    candidatesMatched: candidates.length,
    signalsCreated,
    signalsDeduped
  };
  log?.info('profitRotation pass complete', { ...result });

  return { result, candidates };
}

/**
 * currentDestPerfPct = (latest mcap / destTokenMcapAtBuy - 1) * 100 — mirrors
 * flowScore.ts's own mcapExpansionFromAvgEntry growth-ratio shape (see
 * packages/core/src/types.ts's doc comment on that field). 0 when no market
 * snapshot exists yet or destTokenMcapAtBuy is null/0 (nothing to compare
 * against).
 */
async function computeCurrentDestPerfPct(
  prisma: PrismaClient,
  destTokenId: string,
  destTokenMcapAtBuy: number | null
): Promise<number> {
  if (destTokenMcapAtBuy === null || destTokenMcapAtBuy <= 0) return 0;
  const latestSnapshot = await prisma.tokenMarketSnapshot.findFirst({
    where: { tokenId: destTokenId },
    orderBy: { ts: 'desc' },
    select: { marketCapUsd: true }
  });
  if (!latestSnapshot) return 0;
  const currentMcap = Number(latestSnapshot.marketCapUsd);
  return (currentMcap / destTokenMcapAtBuy - 1) * 100;
}

/**
 * Link confidence for a matched rotation candidate — reuses
 * @flowradar/core's calculateWalletLinkConfidence weight table (Module 7:
 * "exact destination present -> high; amount/time/protocol only -> medium;
 * CEX interruption -> low"). A matched RotationCandidate, by construction,
 * always has an EXACT destination (destWalletId is a known, resolved
 * wallet — matchRotations never emits a candidate without one), so this
 * always scores at least directTransfer-equivalent evidence; bridged
 * candidates additionally get bridgeAmountTimeMatch credit.
 */
function confidenceForCandidate(candidate: MatchedRotationCandidate): number {
  let score = 35; // directTransfer-equivalent: exact destination wallet resolved
  if (candidate.bridged) score += 30; // bridgeAmountTimeMatch
  if (candidate.receivedValueUsd > 0 && candidate.transferredValueUsd > 0) {
    const ratio = Math.min(candidate.receivedValueUsd, candidate.transferredValueUsd) / Math.max(candidate.receivedValueUsd, candidate.transferredValueUsd);
    if (ratio >= 0.9) score += 15; // amountSimilarityAbove90
  }
  return Math.max(0, Math.min(100, score));
}
