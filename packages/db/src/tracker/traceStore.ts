import {
  traceCapitalToTokenBuys,
  type BridgeCorrelation,
  type ClassifiedMassEvent,
  type MassTransactionEvent,
  type RelevanceVerdict
} from '@flowradar/core';
import type { MassTransactionEvent as DbEvent, PrismaClient } from '@prisma/client';

export interface StoredTraceBuildOptions {
  from: Date;
  to: Date;
  maxHops?: number;
  maxEventsPerEntity?: number;
  minLinkScore?: number;
  computedAt?: Date;
  runId?: string;
}

export interface StoredTraceBuildResult {
  entitiesConsidered: number;
  eventsLoaded: number;
  verifiedBridgesLoaded: number;
  tracesBuilt: number;
  tracesPersisted: number;
  truncatedEntities: string[];
}

/**
 * Builds auditable proofs from the canonical store in a bounded breadth-first
 * read. A probable/heuristic bridge is never loaded into the lineage graph.
 */
export async function buildStoredMassTrackerTraces(
  prisma: PrismaClient,
  options: StoredTraceBuildOptions
): Promise<StoredTraceBuildResult> {
  const maxHops = clamp(options.maxHops ?? 5, 1, 10);
  const maxEvents = clamp(options.maxEventsPerEntity ?? 100_000, 100, 1_000_000);
  const minLinkScore = Math.max(0, Math.min(100, options.minLinkScore ?? 60));
  const computedAt = options.computedAt ?? new Date();
  const roots = await prisma.lineageRoot.findMany({
    where: { permanent: true },
    select: {
      id: true,
      wallet: { select: { address: true, chain: true } },
      subscriptions: { where: { active: true }, select: { wallet: { select: { address: true, chain: true } } } }
    },
    orderBy: { id: 'asc' }
  });
  let eventsLoaded = 0, verifiedBridgesLoaded = 0, tracesBuilt = 0, tracesPersisted = 0;
  const truncatedEntities: string[] = [];

  for (const root of roots) {
    const sourceEntityKey = `lineage:${root.id}`;
    const rows = new Map<string, DbEvent>();
    const bridgeRows = new Map<string, BridgeCorrelation>();
    const members = new Map<string, { chain: 'SOLANA' | 'BSC'; address: string; role: 'operator_root' | 'linked_wallet' }>();
    members.set(`${root.wallet.chain}:${root.wallet.address}`, { ...root.wallet, role: 'operator_root' });
    for (const sub of root.subscriptions) {
      const key = `${sub.wallet.chain}:${sub.wallet.address}`;
      if (!members.has(key)) members.set(key, { ...sub.wallet, role: 'linked_wallet' });
    }
    let frontier = [...members.values()].map(({ chain, address }) => ({ chain, address }));
    const visited = new Set(frontier.map((x) => `${x.chain}:${x.address}`));

    for (let depth = 0; depth <= maxHops && frontier.length > 0 && rows.size < maxEvents; depth++) {
      const remaining = maxEvents - rows.size;
      const page = await prisma.massTransactionEvent.findMany({
        where: {
          ts: { gte: options.from, lte: options.to },
          relevanceScore: { gte: minLinkScore },
          OR: frontier.flatMap((x) => [
            { chain: x.chain, actorAddress: x.address },
            { chain: x.chain, fromAddress: x.address }
          ])
        },
        orderBy: [{ ts: 'asc' }, { eventId: 'asc' }],
        take: remaining
      });
      for (const row of page) rows.set(row.eventId, row);

      const correlationRows = page.length === 0 ? [] : await prisma.massBridgeCorrelation.findMany({
        where: { status: 'verified', sourceEventId: { in: page.map((x) => x.eventId) } },
        orderBy: { correlationId: 'asc' }
      });
      const destinationIds = correlationRows.map((x) => x.destinationEventId);
      const destinations = destinationIds.length === 0 ? [] : await prisma.massTransactionEvent.findMany({ where: { eventId: { in: destinationIds } } });
      for (const row of destinations) rows.set(row.eventId, row);
      const destinationMap = new Map(destinations.map((x) => [x.eventId, x]));
      for (const correlation of correlationRows) {
        const source = rows.get(correlation.sourceEventId);
        const destination = destinationMap.get(correlation.destinationEventId);
        if (!source || !destination) continue;
        bridgeRows.set(correlation.correlationId, {
          correlationId: correlation.correlationId,
          protocol: correlation.protocol,
          source: toCoreEvent(source), destination: toCoreEvent(destination),
          confidence: correlation.confidence, status: 'verified', reasonCodes: correlation.reasonCodes
        });
      }

      const next: typeof frontier = [];
      for (const row of [...page, ...destinations]) {
        if (!row.safeEntityLink || row.kind === 'token_buy') continue;
        const key = `${row.chain}:${row.toAddress}`;
        if (!visited.has(key)) { visited.add(key); next.push({ chain: row.chain, address: row.toAddress }); }
      }
      frontier = next;
    }
    if (rows.size >= maxEvents) truncatedEntities.push(sourceEntityKey);
    eventsLoaded += rows.size;
    verifiedBridgesLoaded += bridgeRows.size;
    const classified: ClassifiedMassEvent[] = [...rows.values()].map((row) => ({ event: toCoreEvent(row), verdict: toVerdict(row) }));
    const traces = [...members.values()].flatMap((member) => traceCapitalToTokenBuys({
      sourceEntityKey, sourceWallet: member.address, sourceChain: member.chain,
      sourceRole: member.role, events: classified, bridgeCorrelations: [...bridgeRows.values()],
      config: { maxHops, maxPaths: maxEvents, minLinkScore }
    }));
    tracesBuilt += traces.length;
    if (traces.length > 0) {
      tracesPersisted += (await prisma.massTrackerTrace.createMany({
        data: traces.map((trace) => ({
          traceId: trace.traceId, sourceEntityKey: trace.sourceEntityKey, sourceRole: trace.sourceRole,
          sourceWallet: trace.sourceWallet, terminalWallet: trace.terminalWallet,
          tokenBought: trace.tokenBought, route: trace.route,
          eventIds: trace.hops.map((h) => h.event.eventId),
          bridgeCorrelationIds: trace.bridgeCorrelations.map((b) => b.correlationId),
          fundingToBuyDelaySec: trace.fundingToBuyDelaySec, confidence: trace.confidence,
          reasonCodes: trace.reasonCodes, grantsEligibility: false, computedAt
        })),
        skipDuplicates: true
      })).count;
    }
  }
  if (options.runId) await prisma.massTrackerRun.updateMany({ where: { id: options.runId }, data: { tracesBuilt } });
  return { entitiesConsidered: roots.length, eventsLoaded, verifiedBridgesLoaded, tracesBuilt, tracesPersisted, truncatedEntities };
}

function toCoreEvent(row: DbEvent): MassTransactionEvent {
  const bridge = row.bridgeJson && typeof row.bridgeJson === 'object' && !Array.isArray(row.bridgeJson)
    ? row.bridgeJson as unknown as MassTransactionEvent['bridge'] : null;
  return {
    eventId: row.eventId, chain: row.chain, txHash: row.txHash, eventIndex: row.eventIndex,
    blockOrSlot: row.blockOrSlot, ts: row.ts, kind: row.kind as MassTransactionEvent['kind'],
    status: row.status as MassTransactionEvent['status'], from: row.fromAddress, to: row.toAddress,
    actor: row.actorAddress, asset: { address: row.assetAddress, symbol: row.assetSymbol, decimals: row.assetDecimals, amount: row.amountToken, amountUsd: row.amountUsd == null ? null : Number(row.amountUsd) },
    programOrContract: row.programOrContract, provider: row.provider, observedAt: row.observedAt,
    bridge, metadata: row.metadataJson as Record<string, unknown>
  };
}
function toVerdict(row: DbEvent): RelevanceVerdict {
  return {
    relevant: row.relevanceScore >= 50, category: row.relevanceCategory as RelevanceVerdict['category'],
    score: row.relevanceScore, reasonCodes: row.reasonCodes, safeEntityLink: row.safeEntityLink,
    enrollmentCandidate: row.enrollmentCandidate, grantsTraderRole: false
  };
}
function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, Math.trunc(value))); }
