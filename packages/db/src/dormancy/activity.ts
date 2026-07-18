// FlowRadar — meaningful-activity classification DB builder (dormancy Task 6).
//
// Feeds one wallet's LOCAL activity rows — WalletTokenTrade rows + chain-
// scoped money_flow_edges (both directions, wallet perspective) — through the
// PURE @flowradar/core classifier and persists one row per (source row,
// wallet perspective) into wallet_activity_classifications.
//
// Honesty/safety rules:
//   - Valuation is HONEST: edge valuedUsd NULL stays unknown; trade rows use
//     amountUsd but the legacy 0-for-unpriced convention (ingest writes
//     `leg.amountUsd ?? 0`) means a non-positive amount is treated as
//     UNKNOWN, never as $0 dust.
//   - Trade rows are NOT all trades: TRANSFER_IN/TRANSFER_OUT rows carry no
//     counterparty, so they classify 'unknown_counterparty' (never
//     meaningful — the other side could be a service or the wallet itself);
//     LP_ADD/LP_REMOVE are pool interactions => service_interaction.
//   - Service counterparties are decided from AddressRegistry (looked up on
//     the counterparty's OWN side-chain) plus a bounded fan-out degree probe
//     via core isServiceNode — never by symbol text or provider labels.
//   - Idempotent: (sourceTable, sourceId, walletAddress, chain) unique
//     upserts — reruns update in place, row counts never grow.
//   - Bounded: newest-first fetch caps; truncation is REPORTED (and makes
//     downstream dormancy honesty-degrade, see Task 7 builder).
//   - One wallet's error never fails the batch pass.
//   - SHADOW-ONLY: writes wallet_activity_classifications and nothing else.

import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';
import {
  classifyActivityEvent,
  isServiceNode,
  DEFAULT_SETTINGS
} from '@flowradar/core';
import type { ActivityEvent, MeaningfulActivityConfig } from '@flowradar/core';

export interface ClassifyWalletActivityOptions {
  /** Cap on local trades fetched (newest first). Default 5000. */
  maxTrades?: number;
  /** Cap on money-flow edges fetched (newest first). Default 2000. */
  maxEdges?: number;
  /**
   * Persist classification rows (default true). false = derive the report
   * (incl. the meaningful-event series for Task 7/8 context) WITHOUT writes —
   * same pure decisions, no DB mutation.
   */
  persist?: boolean;
  config?: Partial<MeaningfulActivityConfig>;
}

export interface WalletActivityClassificationReport {
  chain: 'SOLANA' | 'BSC';
  walletAddress: string;
  tradesSeen: number;
  transfersSeen: number;
  rowsWritten: number;
  /**
   * Stale audit rows purged after a persisting pass: rows this pass did NOT
   * re-persist (older rule versions, orphans of removed/re-windowed source
   * keys). 0 on non-persisting passes.
   */
  stalePurged: number;
  byClass: Record<string, number>;
  meaningfulCount: number;
  /** The newest-first fetch cap was hit — older events were NOT classified. */
  tradesTruncated: boolean;
  transfersTruncated: boolean;
  /** MEANINGFUL event timestamps (ascending) — Task 7/8 dormancy input. */
  meaningfulEventTs: Date[];
  /** Earliest MEANINGFUL inbound transfer (fresh-funding evidence), if any. */
  earliestMeaningfulInboundTs: Date | null;
  /** Earliest fetched raw event of any class (observation receipt only —
   *  non-meaningful rows never anchor dormancy coverage). */
  earliestObservedTs: Date | null;
}

const REGISTRY_CHUNK = 500;

/**
 * Service detection for a set of counterparties on ONE chain: exact
 * AddressRegistry lookups + a bounded fan-out degree probe (one grouped
 * count(distinct) query per direction and chunk), combined via core
 * isServiceNode. Degree = out-degree + in-degree (an upper bound on distinct
 * counterparties) — conservative TOWARD service exclusion, never toward
 * treating a hub's flows as meaningful.
 */
export async function lookupServiceCounterparties(
  prisma: PrismaClient,
  chain: 'SOLANA' | 'BSC',
  addresses: string[]
): Promise<Map<string, string>> {
  const flags = new Map<string, string>(); // address -> service basis
  if (addresses.length === 0) return flags;
  const categories = new Map<string, string>();
  const degrees = new Map<string, number>();
  for (let i = 0; i < addresses.length; i += REGISTRY_CHUNK) {
    const chunk = addresses.slice(i, i + REGISTRY_CHUNK);
    const rows = await prisma.addressRegistry.findMany({
      where: { chain, address: { in: chunk } },
      select: { address: true, category: true }
    });
    for (const r of rows) categories.set(r.address, r.category);
    const outDeg = await prisma.$queryRaw<{ address: string; degree: bigint }[]>`
      SELECT "sourceAddress" AS address, COUNT(DISTINCT "destinationAddress") AS degree
      FROM money_flow_edges
      WHERE "sourceAddress" IN (${Prisma.join(chunk)}) AND "sourceChain" = ${chain}::"ChainId"
      GROUP BY 1`;
    const inDeg = await prisma.$queryRaw<{ address: string; degree: bigint }[]>`
      SELECT "destinationAddress" AS address, COUNT(DISTINCT "sourceAddress") AS degree
      FROM money_flow_edges
      WHERE "destinationAddress" IN (${Prisma.join(chunk)}) AND "destinationChain" = ${chain}::"ChainId"
      GROUP BY 1`;
    for (const d of [...outDeg, ...inDeg]) {
      degrees.set(d.address, (degrees.get(d.address) ?? 0) + Number(d.degree));
    }
  }
  for (const a of addresses) {
    const category = categories.get(a) ?? null;
    const degree = degrees.get(a) ?? 0;
    if (isServiceNode({ registryCategory: category as never, distinctCounterparties: degree }, DEFAULT_SETTINGS.lineage)) {
      flags.set(a, category !== null ? `address_registry:${category}` : `fanout_degree:${degree}`);
    }
  }
  return flags;
}

export async function classifyWalletActivity(
  prisma: PrismaClient,
  target: { chain: 'SOLANA' | 'BSC'; address: string },
  opts: ClassifyWalletActivityOptions = {}
): Promise<WalletActivityClassificationReport> {
  const maxTrades = opts.maxTrades ?? 5000;
  const maxEdges = opts.maxEdges ?? 2000;
  const persist = opts.persist !== false;
  // Watermark for the stale-audit purge: every row upserted by THIS pass gets
  // updatedAt >= passStart (same-process clock), so anything older afterwards
  // was NOT re-persisted — an orphan of a removed source key, a re-windowed
  // cap boundary, or an older rule version.
  const passStart = new Date();

  const report: WalletActivityClassificationReport = {
    chain: target.chain,
    walletAddress: target.address,
    tradesSeen: 0,
    transfersSeen: 0,
    rowsWritten: 0,
    stalePurged: 0,
    byClass: {},
    meaningfulCount: 0,
    tradesTruncated: false,
    transfersTruncated: false,
    meaningfulEventTs: [],
    earliestMeaningfulInboundTs: null,
    earliestObservedTs: null
  };

  // --- local trades (only exist when the wallet was locally materialized) --
  const wallet = await prisma.wallet.findUnique({
    where: { address_chain: { address: target.address, chain: target.chain } },
    select: { id: true }
  });
  type TradeRow = {
    id: string;
    action: string;
    amountUsd: Prisma.Decimal;
    ts: Date;
    txHash: string;
    token: { address: string };
  };
  let trades: TradeRow[] = [];
  if (wallet) {
    trades = await prisma.walletTokenTrade.findMany({
      where: { walletId: wallet.id, chain: target.chain },
      // Stable order under the cap: ts ties broken by id.
      orderBy: [{ ts: 'desc' }, { id: 'desc' }],
      take: maxTrades,
      select: { id: true, action: true, amountUsd: true, ts: true, txHash: true, token: { select: { address: true } } }
    });
  }
  report.tradesSeen = trades.length;
  report.tradesTruncated = trades.length >= maxTrades;

  // --- chain-scoped money-flow edges, both directions ----------------------
  const edges = await prisma.moneyFlowEdge.findMany({
    where: {
      OR: [
        { sourceAddress: target.address, sourceChain: target.chain },
        { destinationAddress: target.address, destinationChain: target.chain }
      ]
    },
    // Stable order under the cap: ts ties broken by id.
    orderBy: [{ ts: 'desc' }, { id: 'desc' }],
    take: maxEdges,
    select: {
      id: true,
      sourceAddress: true,
      destinationAddress: true,
      sourceChain: true,
      destinationChain: true,
      valuedUsd: true,
      valuationConfidence: true,
      ts: true,
      txHash: true,
      assetMint: true
    }
  });
  report.transfersSeen = edges.length;
  report.transfersTruncated = edges.length >= maxEdges;

  // Counterparty service flags, looked up on the counterparty's OWN side
  // chain (a cross-chain edge's far side may be registered on the far chain).
  const byCpChain = new Map<'SOLANA' | 'BSC', Set<string>>();
  for (const e of edges) {
    const inbound = e.destinationAddress === target.address && e.destinationChain === target.chain;
    const cp = inbound ? e.sourceAddress : e.destinationAddress;
    const cpChain = (inbound ? e.sourceChain : e.destinationChain) as 'SOLANA' | 'BSC';
    if (cp === target.address) continue;
    const set = byCpChain.get(cpChain) ?? new Set<string>();
    set.add(cp);
    byCpChain.set(cpChain, set);
  }
  const serviceFlags = new Map<string, string>(); // `${chain}|${address}` -> basis
  for (const [cpChain, set] of byCpChain) {
    const flags = await lookupServiceCounterparties(prisma, cpChain, [...set]);
    for (const [a, basis] of flags) serviceFlags.set(`${cpChain}|${a}`, basis);
  }

  // --- classify + (optionally) upsert ---------------------------------------
  const observe = (ts: Date) => {
    if (report.earliestObservedTs === null || ts.getTime() < report.earliestObservedTs.getTime()) {
      report.earliestObservedTs = ts;
    }
  };
  const persistOne = async (
    sourceTable: string,
    sourceId: string,
    event: ActivityEvent,
    rawUsd: Prisma.Decimal | null
  ) => {
    const decision = classifyActivityEvent(event, opts.config);
    observe(event.ts);
    if (decision.meaningful) {
      report.meaningfulEventTs.push(event.ts);
      if (
        event.kind === 'transfer' &&
        event.role === 'in' &&
        (report.earliestMeaningfulInboundTs === null ||
          event.ts.getTime() < report.earliestMeaningfulInboundTs.getTime())
      ) {
        report.earliestMeaningfulInboundTs = event.ts;
      }
      report.meaningfulCount += 1;
    }
    report.byClass[decision.classification] = (report.byClass[decision.classification] ?? 0) + 1;
    if (!persist) return;
    const data = {
      chain: target.chain,
      walletAddress: target.address,
      sourceTable,
      sourceId,
      eventKind: event.kind,
      eventRole: event.role,
      txHash: event.txHash,
      tokenAddress: event.tokenAddress ?? null,
      counterpartyAddress: event.counterpartyAddress ?? null,
      eventTs: event.ts,
      // The ORIGINAL Decimal is persisted (no float round-trip); the pure
      // decision uses the number form only for threshold logic.
      usd: rawUsd,
      classification: decision.classification,
      meaningful: decision.meaningful,
      reasonCodes: decision.reasonCodes,
      confidence: decision.confidence,
      ruleVersion: decision.ruleVersion,
      receiptsJson: decision.receipt as unknown as Prisma.InputJsonValue
    };
    await prisma.walletActivityClassification.upsert({
      where: {
        sourceTable_sourceId_walletAddress_chain: {
          sourceTable,
          sourceId,
          walletAddress: target.address,
          chain: target.chain
        }
      },
      create: data,
      update: data
    });
    report.rowsWritten += 1;
  };

  for (const t of trades) {
    // Legacy 0-for-unpriced (ingest writes `leg.amountUsd ?? 0`): a
    // non-positive amount is UNKNOWN value, never $0 dust.
    const usdNum = Number(t.amountUsd);
    const usd = usdNum > 0 ? usdNum : null;
    const rawUsd = usd === null ? null : t.amountUsd;
    if (t.action === 'BUY' || t.action === 'SELL') {
      await persistOne(
        'wallet_token_trades',
        t.id,
        { kind: 'trade', role: t.action, usd, ts: t.ts, txHash: t.txHash, tokenAddress: t.token.address },
        rawUsd
      );
    } else if (t.action === 'LP_ADD' || t.action === 'LP_REMOVE') {
      // Pool interaction — service by construction (the pool is the far side).
      await persistOne(
        'wallet_token_trades',
        t.id,
        {
          kind: 'transfer',
          role: t.action === 'LP_ADD' ? 'out' : 'in',
          usd,
          ts: t.ts,
          txHash: t.txHash,
          tokenAddress: t.token.address,
          counterpartyIsService: true,
          counterpartyServiceBasis: `trade_action:${t.action}`
        },
        rawUsd
      );
    } else {
      // TRANSFER_IN / TRANSFER_OUT trade rows carry NO counterparty — the
      // other side could be a service or the wallet itself, so they can
      // never classify meaningful ('unknown_counterparty').
      await persistOne(
        'wallet_token_trades',
        t.id,
        {
          kind: 'transfer',
          role: t.action === 'TRANSFER_IN' ? 'in' : 'out',
          usd,
          ts: t.ts,
          txHash: t.txHash,
          tokenAddress: t.token.address,
          counterpartyKnown: false
        },
        rawUsd
      );
    }
  }

  for (const e of edges) {
    const inbound = e.destinationAddress === target.address && e.destinationChain === target.chain;
    const counterparty = inbound ? e.sourceAddress : e.destinationAddress;
    const cpChain = (inbound ? e.sourceChain : e.destinationChain) as 'SOLANA' | 'BSC';
    const selfTransfer = e.sourceAddress === e.destinationAddress;
    const serviceBasis = selfTransfer ? null : serviceFlags.get(`${cpChain}|${counterparty}`) ?? null;
    await persistOne(
      'money_flow_edges',
      e.id,
      {
        kind: 'transfer',
        role: inbound ? 'in' : 'out',
        usd: e.valuedUsd === null ? null : Number(e.valuedUsd),
        valuationConfidence: e.valuationConfidence,
        ts: e.ts,
        txHash: e.txHash,
        tokenAddress: e.assetMint ?? null,
        counterpartyAddress: selfTransfer ? null : counterparty,
        counterpartyIsService: serviceBasis !== null,
        counterpartyServiceBasis: serviceBasis,
        selfTransfer
      },
      e.valuedUsd
    );
  }

  if (persist) {
    // Purge stale audit rows this pass did not re-persist (bounded to this
    // wallet+chain; every current row was just upserted with a newer
    // updatedAt). Keeps the audit trail exactly = the current bounded window
    // and makes rule-version refreshes converge instead of re-running forever.
    const purged = await prisma.walletActivityClassification.deleteMany({
      where: { chain: target.chain, walletAddress: target.address, updatedAt: { lt: passStart } }
    });
    report.stalePurged = purged.count;
  }

  report.meaningfulEventTs.sort((a, b) => a.getTime() - b.getTime());
  return report;
}

/** Per-wallet failure receipt (bounded) — errors are counted AND attributable. */
export interface WalletErrorReceipt {
  walletAddress: string;
  message: string;
}

export const ERROR_RECEIPTS_MAX = 25;

export function toErrorReceipt(walletAddress: string, err: unknown): WalletErrorReceipt {
  const message =
    err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300);
  return { walletAddress, message };
}

export interface ActivityClassificationBatchReport {
  walletsConsidered: number;
  walletsProcessed: number;
  errors: number;
  /** First ERROR_RECEIPTS_MAX per-wallet failures (receipted, never silent). */
  errorReceipts: WalletErrorReceipt[];
  rowsWritten: number;
  /** Stale audit rows purged across the batch (see classifyWalletActivity). */
  stalePurged: number;
  byClass: Record<string, number>;
  meaningfulCount: number;
  walletsWithTruncation: number;
}

/**
 * Bounded classification pass over the persisted behavior-profile cohort
 * (wallet_behavior_profiles), deterministic order. One wallet's error never
 * fails the batch.
 */
export async function runActivityClassification(
  prisma: PrismaClient,
  opts: {
    chain?: 'SOLANA' | 'BSC';
    /** Explicit cohort override; default = wallet_behavior_profiles wallets. */
    walletAddresses?: string[];
    limit?: number;
    maxTrades?: number;
    maxEdges?: number;
    config?: Partial<MeaningfulActivityConfig>;
  } = {}
): Promise<ActivityClassificationBatchReport> {
  const chain = opts.chain ?? 'SOLANA';
  const limit = opts.limit ?? 100;
  let addresses: string[];
  if (opts.walletAddresses) {
    addresses = opts.walletAddresses.slice(0, limit);
  } else {
    const profiles = await prisma.walletBehaviorProfile.findMany({
      where: { chain },
      orderBy: { walletAddress: 'asc' },
      take: limit,
      select: { walletAddress: true }
    });
    addresses = profiles.map((p) => p.walletAddress);
  }

  const batch: ActivityClassificationBatchReport = {
    walletsConsidered: addresses.length,
    walletsProcessed: 0,
    errors: 0,
    errorReceipts: [],
    rowsWritten: 0,
    stalePurged: 0,
    byClass: {},
    meaningfulCount: 0,
    walletsWithTruncation: 0
  };
  for (const address of addresses) {
    try {
      const r = await classifyWalletActivity(prisma, { chain, address }, opts);
      batch.walletsProcessed += 1;
      batch.rowsWritten += r.rowsWritten;
      batch.stalePurged += r.stalePurged;
      batch.meaningfulCount += r.meaningfulCount;
      for (const [k, v] of Object.entries(r.byClass)) batch.byClass[k] = (batch.byClass[k] ?? 0) + v;
      if (r.tradesTruncated || r.transfersTruncated) batch.walletsWithTruncation += 1;
    } catch (err) {
      batch.errors += 1;
      if (batch.errorReceipts.length < ERROR_RECEIPTS_MAX) {
        batch.errorReceipts.push(toErrorReceipt(address, err));
      }
    }
  }
  return batch;
}
