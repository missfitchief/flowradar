// FlowRadar — runBridgeFlow: matches bridge_deposit <-> bridge_withdrawal
// MoneyFlowEdge pairs and annotates each pair's confidence/metadata (Task 23
// binding decision 4).
//
// A bridge hop is ingested (see packages/db/src/ingest.ts's header) as TWO
// separate same-chain MoneyFlowEdge rows — a bridge_deposit on the source
// chain and a bridge_withdrawal on the destination chain — joined only by
// asset+amount+time+protocol proximity, never a single cross-chain row. This
// pass is what actually performs that join and PERSISTS the result back onto
// both edge rows' `confidence`/`metadata` columns (raw ingest always writes
// confidence=100 per-leg — see ingest.ts's upsertMoneyFlowEdge — which is
// correct for "this leg itself happened" but says nothing about whether it
// was successfully matched to its other half; this pass is the one place
// that downgrades/confirms that cross-leg linkage):
//
//   - asset match (same `asset` symbol on both legs) + amount within
//     [95%, 105%] of each other + time gap < 60 minutes + same
//     bridgeProtocol -> CONFIRMED pair: both legs' confidence set to 95,
//     metadata.bridgeMatch = { matchedEdgeId, confirmed: true }.
//   - a deposit/withdrawal that could not be matched to any same-protocol
//     counterpart within the window at all (its "path" is interrupted by an
//     intermediate CEX/MIXER hop per the AddressRegistry, or simply has no
//     counterpart in this pass's lookback window) -> LOW confidence (35),
//     metadata.bridgeMatch = { confirmed: false, reason }.
//
// Matching is one-to-one (greedy, best-amount-ratio-first) — mirrors
// packages/db/src/rotation.ts's own pairBridgeLegs exactly (same tolerance
// philosophy, though this pass's window is 60 minutes per the Task 23 brief's
// "bridgeFlow" binding decision, tighter than rotation.ts's 2h/10% pairing,
// which serves a different purpose — rotation matching tolerates a wider
// window because RotationCandidate's own receipt search re-validates against
// F.minValueMatchPct/F.maxValueMatchPct; this pass's job is specifically
// "did the bridge itself complete cleanly", a stricter, protocol-level
// question).

import type { PrismaClient } from '@prisma/client';

const BRIDGE_MATCH_WINDOW_MS = 60 * 60_000; // 60 minutes, per Task 23 binding decision 4
const MIN_AMOUNT_MATCH_PCT = 95;
const MAX_AMOUNT_MATCH_PCT = 105;
// Exported so callers displaying paired/unmatched rows (e.g. apps/web/app/flow/page.tsx)
// use the same canonical confidence values this pass persists to the DB, instead of
// re-deriving their own (raw per-leg ingest confidence is always 100 and says nothing
// about cross-leg match status — see this file's header).
export const CONFIRMED_CONFIDENCE = 95;
export const LOW_CONFIDENCE = 35;

export interface BridgeFlowLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface BridgeFlowResult {
  depositsConsidered: number;
  withdrawalsConsidered: number;
  pairsConfirmed: number;
  legsLowConfidence: number;
}

export interface BridgeLeg {
  id: string;
  sourceAddress: string;
  destinationAddress: string;
  asset: string;
  amountUsd: number;
  ts: Date;
  bridgeProtocol: string | null;
}

export interface PairedBridgeFlow {
  deposit: BridgeLeg;
  withdrawal: BridgeLeg;
}

export interface UnmatchedLeg {
  leg: BridgeLeg;
  direction: 'deposit' | 'withdrawal';
}

export interface PairBridgeLegRowsResult {
  matched: PairedBridgeFlow[];
  unmatched: UnmatchedLeg[];
}

/**
 * PURE pairing core shared by runBridgeFlow (DB-mutating job pass) and the
 * Money Flow page's read-only bridge table (apps/web/app/flow/page.tsx) —
 * no prisma/I-O here, just the one-to-one greedy bipartite match: asset+
 * protocol match, amount ratio in [95%,105%], time gap <60min,
 * closest-amount-ratio-first. Callers that need CONFIRMED/LOW confidence
 * values or CEX/MIXER-interruption reasons apply those on top of this
 * function's matched/unmatched split (see CONFIRMED_CONFIDENCE/LOW_CONFIDENCE
 * below and runBridgeFlow's registry lookup).
 */
export function pairBridgeLegRows(deposits: BridgeLeg[], withdrawals: BridgeLeg[]): PairBridgeLegRowsResult {
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
      if (dep.asset !== wd.asset) continue;
      if ((dep.bridgeProtocol ?? null) !== (wd.bridgeProtocol ?? null)) continue;
      const timeDiff = Math.abs(wd.ts.getTime() - dep.ts.getTime());
      if (timeDiff > BRIDGE_MATCH_WINDOW_MS) continue;
      const matchPct = (Math.min(dep.amountUsd, wd.amountUsd) / Math.max(dep.amountUsd, wd.amountUsd)) * 100;
      if (matchPct < MIN_AMOUNT_MATCH_PCT || matchPct > MAX_AMOUNT_MATCH_PCT) continue;
      candidates.push({ depositIdx: di, withdrawalIdx: wi, ratio: matchPct });
    }
  }
  candidates.sort((a, b) => b.ratio - a.ratio);

  const usedDeposits = new Set<number>();
  const usedWithdrawals = new Set<number>();
  const matched: PairedBridgeFlow[] = [];
  for (const c of candidates) {
    if (usedDeposits.has(c.depositIdx) || usedWithdrawals.has(c.withdrawalIdx)) continue;
    usedDeposits.add(c.depositIdx);
    usedWithdrawals.add(c.withdrawalIdx);
    matched.push({ deposit: deposits[c.depositIdx]!, withdrawal: withdrawals[c.withdrawalIdx]! });
  }

  const unmatched: UnmatchedLeg[] = [];
  for (let di = 0; di < deposits.length; di++) {
    if (usedDeposits.has(di)) continue;
    unmatched.push({ leg: deposits[di]!, direction: 'deposit' });
  }
  for (let wi = 0; wi < withdrawals.length; wi++) {
    if (usedWithdrawals.has(wi)) continue;
    unmatched.push({ leg: withdrawals[wi]!, direction: 'withdrawal' });
  }

  return { matched, unmatched };
}

/**
 * Runs one full bridge-flow matching pass over the trailing `lookbackHours`
 * window (default 24h): fetches every bridge_deposit/bridge_withdrawal
 * MoneyFlowEdge row in-window, pairs them one-to-one via pairBridgeLegRows
 * (asset+protocol match, amount ratio in [95%,105%], time gap <60min,
 * closest-ratio-first greedy), and updates confidence/metadata on every leg
 * touched (confirmed pairs get high confidence; any leg with no qualifying
 * counterpart in-window gets low confidence and a `reason`, further
 * downgraded to a CEX/MIXER-interruption reason when either side of the
 * unmatched leg is a registry-known CEX/MIXER address).
 */
export async function runBridgeFlow(
  prisma: PrismaClient,
  now: Date = new Date(),
  lookbackHours = 24,
  log?: BridgeFlowLogger
): Promise<BridgeFlowResult> {
  const windowFrom = new Date(now.getTime() - lookbackHours * 60 * 60_000);

  const edges = await prisma.moneyFlowEdge.findMany({
    where: {
      ts: { gte: windowFrom, lte: now },
      actionType: { in: ['bridge_deposit', 'bridge_withdrawal'] }
    },
    select: {
      id: true,
      sourceAddress: true,
      destinationAddress: true,
      asset: true,
      amountUsd: true,
      ts: true,
      actionType: true,
      bridgeProtocol: true
    }
  });

  const deposits: BridgeLeg[] = edges
    .filter((e) => e.actionType === 'bridge_deposit')
    .map((e) => ({
      id: e.id,
      sourceAddress: e.sourceAddress,
      destinationAddress: e.destinationAddress,
      asset: e.asset,
      amountUsd: Number(e.amountUsd),
      ts: e.ts,
      bridgeProtocol: e.bridgeProtocol
    }));
  const withdrawals: BridgeLeg[] = edges
    .filter((e) => e.actionType === 'bridge_withdrawal')
    .map((e) => ({
      id: e.id,
      sourceAddress: e.sourceAddress,
      destinationAddress: e.destinationAddress,
      asset: e.asset,
      amountUsd: Number(e.amountUsd),
      ts: e.ts,
      bridgeProtocol: e.bridgeProtocol
    }));

  const registryAddresses = new Set(
    (await prisma.addressRegistry.findMany({ where: { category: { in: ['CEX', 'MIXER'] } }, select: { address: true } })).map(
      (r) => r.address
    )
  );

  const { matched: confirmedPairs, unmatched: unmatchedLegs } = pairBridgeLegRows(deposits, withdrawals);

  let pairsConfirmed = 0;
  let legsLowConfidence = 0;

  for (const { deposit, withdrawal } of confirmedPairs) {
    await prisma.moneyFlowEdge.update({
      where: { id: deposit.id },
      data: {
        confidence: CONFIRMED_CONFIDENCE,
        metadata: { bridgeMatch: { matchedEdgeId: withdrawal.id, confirmed: true } }
      }
    });
    await prisma.moneyFlowEdge.update({
      where: { id: withdrawal.id },
      data: {
        confidence: CONFIRMED_CONFIDENCE,
        metadata: { bridgeMatch: { matchedEdgeId: deposit.id, confirmed: true } }
      }
    });
    pairsConfirmed += 1;
  }

  for (const { leg, direction } of unmatchedLegs) {
    const interrupted = registryAddresses.has(leg.sourceAddress) || registryAddresses.has(leg.destinationAddress);
    const reasonNoMatch = direction === 'deposit' ? 'no_matching_withdrawal_in_window' : 'no_matching_deposit_in_window';
    await prisma.moneyFlowEdge.update({
      where: { id: leg.id },
      data: {
        confidence: LOW_CONFIDENCE,
        metadata: {
          bridgeMatch: {
            confirmed: false,
            reason: interrupted ? 'cex_or_mixer_interruption' : reasonNoMatch
          }
        }
      }
    });
    legsLowConfidence += 1;
  }

  const result: BridgeFlowResult = {
    depositsConsidered: deposits.length,
    withdrawalsConsidered: withdrawals.length,
    pairsConfirmed,
    legsLowConfidence
  };
  log?.info('bridgeFlow pass complete', { ...result });
  return result;
}
