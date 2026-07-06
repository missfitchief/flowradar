// FlowRadar — matchRotations: pure profit-rotation candidate builder (Task 23
// binding decision 1).
//
// Normative source: Task 23 brief binding decisions 1-2 + Task 14's ruleF.ts
// header note ("F.maxTransferDelayHours ... is a builder-side invariant ...
// Rule F therefore does not re-validate maxTransferDelayHours itself"). This
// module IS that builder: every window/threshold check RotationCandidate's
// consumer (rules/ruleF.ts) skips is enforced HERE, before a candidate is
// ever constructed, so ruleF's "trust the candidate's existence as evidence"
// contract is actually true.
//
// packages/core is PURE (zero I/O) — matchRotations takes plain in-memory
// row arrays (already fetched by packages/db/src/rotation.ts's
// buildRotationInputs) and returns RotationCandidate[]; it does no DB access
// and reads no clock (every timestamp comes from the input rows themselves).
//
// Matching algorithm (per candidate ProfitExit):
//   1. realizedProfitUsd >= settings.rules.F.minRealizedProfitUsd — cheap
//      pre-filter before doing any join work for this exit at all.
//   2. Find transfers FROM exit.walletId whose ts falls within
//      [exit.exitTs, exit.exitTs + F.maxTransferDelayHours hours] — THIS is
//      the delay window ruleF's own header says it does NOT re-check; it is
//      the single thing this builder exists to enforce that nothing else in
//      the pipeline does.
//   3. For each such transfer, find a matching receipt: same (fromWalletId,
//      toWalletId) pair (the direct-transfer case is its own receipt; the
//      bridged case is a distinct bridge_withdrawal row on the other chain,
//      passed in as its own TransferRec with amountUsd = the value actually
//      received) whose ts is >= the transfer's ts (a receipt cannot precede
//      the transfer that produced it) and whose amountUsd is within
//      [F.minValueMatchPct, F.maxValueMatchPct]% of the transfer's amountUsd.
//      Picks the EARLIEST qualifying receipt (the first plausible arrival).
//   4. For that receipt's toWalletId, find a DestBuy within
//      [receiptTs, receiptTs + F.maxBuyDelayMin minutes] whose mcapAtBuy is
//      non-null and <= F.maxMcap (null mcap is a hard reject, mirroring
//      ruleF's own "unknown mcap -> do not fire" contract — this builder
//      applies the identical rule at construction time rather than emitting
//      a candidate ruleF would silently never match anyway). Picks the
//      EARLIEST qualifying buy.
//   5. bridged = transfer.chainFrom !== transfer.chainTo (mirrors
//      ingest.ts's own same-chain-per-edge invariant: a genuine bridge hop is
//      represented as two same-chain MoneyFlowEdge rows joined by this
//      matcher, not a single cross-chain row). chainPath is
//      [chainFrom, chainTo] when bridged, else [chainFrom] alone (a direct
//      same-chain transfer has no distinct hop to name).
//
// Determinism: output is sorted by (transferTs, sourceWalletId, destWalletId,
// destTokenId) ascending — a stable, content-derived key independent of
// input array order (both the matcher's own internal iteration and its
// caller's fetch order are otherwise unspecified).

import type { RotationCandidate } from '../types';
import type { Settings } from '../settings';

/**
 * RotationCandidate plus a derived timeGapMin (exit -> dest-buy elapsed
 * minutes) — not part of the core RotationCandidate contract (rules/ruleF.ts
 * doesn't read it), but useful output for packages/db/src/rotation.ts's
 * ProfitRotationSignal persistence (which DOES carry a timeGapMin column).
 * Structurally a superset of RotationCandidate, so still assignable wherever
 * RuleExtras.rotationCandidates is expected.
 */
export interface MatchedRotationCandidate extends RotationCandidate {
  timeGapMin: number;
}

export interface ProfitExit {
  walletId: string;
  tokenId: string;
  realizedProfitUsd: number;
  exitTs: Date;
}

export interface TransferRec {
  fromWalletId: string;
  toWalletId: string;
  amountUsd: number;
  ts: Date;
  bridged: boolean;
  bridgeProtocol?: string;
  chainFrom: string;
  chainTo: string;
}

export interface DestBuy {
  walletId: string;
  tokenId: string;
  usd: number;
  ts: Date;
  mcapAtBuy: number | null;
}

export interface MatchRotationsInput {
  exits: ProfitExit[];
  transfers: TransferRec[];
  receipts: TransferRec[];
  destBuys: DestBuy[];
  settings: Settings;
}

const MS_PER_HOUR = 60 * 60_000;
const MS_PER_MIN = 60_000;

/**
 * Finds the earliest receipt matching `transfer`: same wallet pair, ts >=
 * transfer.ts, value-match% within [minPct, maxPct]. Returns null if none
 * qualifies.
 */
function findEarliestMatchingReceipt(
  transfer: TransferRec,
  receipts: TransferRec[],
  minValueMatchPct: number,
  maxValueMatchPct: number
): TransferRec | null {
  let best: TransferRec | null = null;
  for (const receipt of receipts) {
    if (receipt.fromWalletId !== transfer.fromWalletId) continue;
    if (receipt.toWalletId !== transfer.toWalletId) continue;
    if (receipt.ts.getTime() < transfer.ts.getTime()) continue;
    if (transfer.amountUsd <= 0) continue;

    const valueMatchPct = (receipt.amountUsd / transfer.amountUsd) * 100;
    if (valueMatchPct < minValueMatchPct || valueMatchPct > maxValueMatchPct) continue;

    if (best === null || receipt.ts.getTime() < best.ts.getTime()) {
      best = receipt;
    }
  }
  return best;
}

/**
 * Finds the earliest DestBuy by `walletId` within
 * [receiptTs, receiptTs + maxBuyDelayMin], with non-null mcapAtBuy <= maxMcap.
 * Returns null if none qualifies.
 */
function findEarliestQualifyingDestBuy(
  walletId: string,
  receiptTs: Date,
  destBuys: DestBuy[],
  maxBuyDelayMin: number,
  maxMcap: number
): DestBuy | null {
  let best: DestBuy | null = null;
  for (const buy of destBuys) {
    if (buy.walletId !== walletId) continue;
    if (buy.mcapAtBuy === null) continue; // null mcap -> hard reject, mirrors ruleF
    if (buy.mcapAtBuy > maxMcap) continue;

    const delayMs = buy.ts.getTime() - receiptTs.getTime();
    if (delayMs < 0) continue; // a buy cannot precede the receipt that funded it
    if (delayMs > maxBuyDelayMin * MS_PER_MIN) continue;

    if (best === null || buy.ts.getTime() < best.ts.getTime()) {
      best = buy;
    }
  }
  return best;
}

export function matchRotations(input: MatchRotationsInput): MatchedRotationCandidate[] {
  const { exits, transfers, receipts, destBuys, settings } = input;
  const { F } = settings.rules;

  const candidates: MatchedRotationCandidate[] = [];

  for (const exit of exits) {
    if (exit.realizedProfitUsd < F.minRealizedProfitUsd) continue;

    const maxTransferTs = exit.exitTs.getTime() + F.maxTransferDelayHours * MS_PER_HOUR;

    for (const transfer of transfers) {
      if (transfer.fromWalletId !== exit.walletId) continue;
      if (transfer.ts.getTime() < exit.exitTs.getTime()) continue;
      if (transfer.ts.getTime() > maxTransferTs) continue; // enforced HERE — ruleF does not re-check this

      const receipt = findEarliestMatchingReceipt(transfer, receipts, F.minValueMatchPct, F.maxValueMatchPct);
      if (receipt === null) continue;

      const destBuy = findEarliestQualifyingDestBuy(
        receipt.toWalletId,
        receipt.ts,
        destBuys,
        F.maxBuyDelayMin,
        F.maxMcap
      );
      if (destBuy === null) continue;

      const bridged = transfer.chainFrom !== transfer.chainTo;
      const chainPath = bridged ? [transfer.chainFrom, transfer.chainTo] : [transfer.chainFrom];
      const timeGapMin = (destBuy.ts.getTime() - exit.exitTs.getTime()) / MS_PER_MIN;

      candidates.push({
        sourceWalletId: exit.walletId,
        destWalletId: receipt.toWalletId,
        sourceTokenId: exit.tokenId,
        destTokenId: destBuy.tokenId,
        realizedProfitUsd: exit.realizedProfitUsd,
        transferredValueUsd: transfer.amountUsd,
        receivedValueUsd: receipt.amountUsd,
        transferTs: transfer.ts,
        receiptTs: receipt.ts,
        destBuyTs: destBuy.ts,
        destBuyUsd: destBuy.usd,
        destTokenMcapAtBuy: destBuy.mcapAtBuy,
        bridged,
        chainPath,
        timeGapMin
      });
    }
  }

  // Deterministic ordering, independent of input array order.
  candidates.sort((a, b) => {
    if (a.transferTs.getTime() !== b.transferTs.getTime()) return a.transferTs.getTime() - b.transferTs.getTime();
    if (a.sourceWalletId !== b.sourceWalletId) return a.sourceWalletId < b.sourceWalletId ? -1 : 1;
    if (a.destWalletId !== b.destWalletId) return a.destWalletId < b.destWalletId ? -1 : 1;
    if (a.destTokenId !== b.destTokenId) return a.destTokenId < b.destTokenId ? -1 : 1;
    return 0;
  });

  return candidates;
}
