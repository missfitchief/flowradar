import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  classifyMassEvent,
  type ClassifiedMassEvent,
  type EntityWalletRole,
  type MassTransactionEvent as CoreMassEvent,
  type TrackerAddressContext
} from '@flowradar/core';
import { Prisma, type PrismaClient } from '@prisma/client';

export interface MassTrackerSourceItem {
  event: CoreMassEvent;
  /** Counted in run telemetry; the item is skipped and may be retried upstream. */
  providerError?: string;
}

export interface MassTrackerOptions {
  runId?: string;
  batchSize?: number;
  maxRetries?: number;
  retryBaseMs?: number;
  enrollReceivers?: boolean;
  metadata?: Record<string, unknown>;
}

export interface MassTrackerRunResult {
  runId: string;
  inputEvents: number;
  persistedEvents: number;
  duplicateEvents: number;
  relevantEvents: number;
  receiversEnrolled: number;
  bridgePairsVerified: number;
  batches: number;
  retryAttempts: number;
  providerErrors: number;
  peakHeapBytes: number;
  throughputPerSec: number;
}

export interface MassTrackerSession {
  readonly runId: string;
  ingest(events: readonly CoreMassEvent[]): Promise<void>;
  recordProviderError(): void;
  complete(): Promise<MassTrackerRunResult>;
  fail(error: unknown): Promise<void>;
}

/** One long-lived metrics scope for a worker cycle with many provider pages. */
export async function createMassTrackerSession(
  prisma: PrismaClient,
  options: MassTrackerOptions = {}
): Promise<MassTrackerSession> {
  const runId = options.runId ?? randomUUID();
  const startedAt = new Date();
  const maxRetries = boundedInt(options.maxRetries ?? 3, 0, 10);
  const retryBaseMs = boundedInt(options.retryBaseMs ?? 100, 0, 30_000);
  let inputEvents = 0, persistedEvents = 0, relevantEvents = 0, receiversEnrolled = 0;
  let bridgePairsVerified = 0, batches = 0, retryAttempts = 0, providerErrors = 0;
  let peakHeapBytes = process.memoryUsage().heapUsed;
  let closed = false;
  await prisma.massTrackerRun.create({ data: { id: runId, startedAt, status: 'running', metadataJson: json(options.metadata ?? {}) } });

  const snapshot = (completedAt: Date): MassTrackerRunResult => ({
    runId, inputEvents, persistedEvents, duplicateEvents: inputEvents - persistedEvents,
    relevantEvents, receiversEnrolled, bridgePairsVerified, batches, retryAttempts,
    providerErrors, peakHeapBytes,
    throughputPerSec: inputEvents / Math.max(0.001, (completedAt.getTime() - startedAt.getTime()) / 1000)
  });
  return {
    runId,
    async ingest(events) {
      if (closed) throw new Error('mass tracker session is closed');
      if (events.length === 0) return;
      inputEvents += events.length;
      const result = await processBatchWithRetry(prisma, [...events], options.enrollReceivers !== false, maxRetries, retryBaseMs);
      persistedEvents += result.persisted; relevantEvents += result.relevant;
      receiversEnrolled += result.enrolled; bridgePairsVerified += result.bridges;
      retryAttempts += result.retries; batches++;
      peakHeapBytes = Math.max(peakHeapBytes, process.memoryUsage().heapUsed);
    },
    recordProviderError() { providerErrors++; },
    async complete() {
      if (closed) throw new Error('mass tracker session is closed');
      closed = true;
      const completedAt = new Date();
      const result = snapshot(completedAt);
      await prisma.massTrackerRun.update({ where: { id: runId }, data: {
        completedAt, status: 'completed', inputEvents: result.inputEvents,
        persistedEvents: result.persistedEvents, duplicateEvents: result.duplicateEvents,
        relevantEvents: result.relevantEvents, receiversEnrolled: result.receiversEnrolled,
        bridgePairsVerified: result.bridgePairsVerified, batches: result.batches,
        retryAttempts: result.retryAttempts, providerErrors: result.providerErrors,
        peakHeapBytes: BigInt(result.peakHeapBytes), throughputPerSec: result.throughputPerSec
      } });
      return result;
    },
    async fail(error) {
      if (closed) return;
      closed = true;
      const completedAt = new Date();
      const result = snapshot(completedAt);
      await prisma.massTrackerRun.update({ where: { id: runId }, data: {
        completedAt, status: 'failed', inputEvents: result.inputEvents,
        persistedEvents: result.persistedEvents, duplicateEvents: result.duplicateEvents,
        relevantEvents: result.relevantEvents, receiversEnrolled: result.receiversEnrolled,
        bridgePairsVerified: result.bridgePairsVerified, batches: result.batches,
        retryAttempts: result.retryAttempts, providerErrors: result.providerErrors,
        peakHeapBytes: BigInt(result.peakHeapBytes), throughputPerSec: result.throughputPerSec,
        error: errorMessage(error)
      } });
    }
  };
}

interface ContextPair { from: TrackerAddressContext; to: TrackerAddressContext }

/**
 * Streams a large canonical event source through bounded batches. No batch is
 * retained after commit. DB uniqueness makes replay/resume idempotent.
 */
export async function runMassTransactionTracker(
  prisma: PrismaClient,
  source: AsyncIterable<MassTrackerSourceItem>,
  options: MassTrackerOptions = {}
): Promise<MassTrackerRunResult> {
  const runId = options.runId ?? randomUUID();
  const batchSize = boundedInt(options.batchSize ?? 500, 1, 5_000);
  const maxRetries = boundedInt(options.maxRetries ?? 3, 0, 10);
  const retryBaseMs = boundedInt(options.retryBaseMs ?? 100, 0, 30_000);
  const startedAt = new Date();
  let inputEvents = 0, persistedEvents = 0, relevantEvents = 0, receiversEnrolled = 0;
  let bridgePairsVerified = 0, batches = 0, retryAttempts = 0, providerErrors = 0;
  let peakHeapBytes = process.memoryUsage().heapUsed;

  await prisma.massTrackerRun.create({
    data: { id: runId, startedAt, status: 'running', metadataJson: json(options.metadata ?? {}) }
  });

  let batch: CoreMassEvent[] = [];
  try {
    for await (const item of source) {
      if (item.providerError) { providerErrors++; continue; }
      inputEvents++;
      batch.push(item.event);
      if (batch.length >= batchSize) {
        const result = await processBatchWithRetry(prisma, batch, options.enrollReceivers !== false, maxRetries, retryBaseMs);
        persistedEvents += result.persisted;
        relevantEvents += result.relevant;
        receiversEnrolled += result.enrolled;
        bridgePairsVerified += result.bridges;
        retryAttempts += result.retries;
        batches++;
        batch = [];
        peakHeapBytes = Math.max(peakHeapBytes, process.memoryUsage().heapUsed);
      }
    }
    if (batch.length > 0) {
      const result = await processBatchWithRetry(prisma, batch, options.enrollReceivers !== false, maxRetries, retryBaseMs);
      persistedEvents += result.persisted;
      relevantEvents += result.relevant;
      receiversEnrolled += result.enrolled;
      bridgePairsVerified += result.bridges;
      retryAttempts += result.retries;
      batches++;
      peakHeapBytes = Math.max(peakHeapBytes, process.memoryUsage().heapUsed);
    }
    const completedAt = new Date();
    const elapsedSec = Math.max(0.001, (completedAt.getTime() - startedAt.getTime()) / 1000);
    const throughputPerSec = inputEvents / elapsedSec;
    const duplicateEvents = inputEvents - persistedEvents;
    await prisma.massTrackerRun.update({ where: { id: runId }, data: {
      completedAt, status: 'completed', inputEvents, persistedEvents, duplicateEvents,
      relevantEvents, receiversEnrolled, bridgePairsVerified, batches, retryAttempts,
      providerErrors, peakHeapBytes: BigInt(peakHeapBytes), throughputPerSec
    } });
    return { runId, inputEvents, persistedEvents, duplicateEvents, relevantEvents, receiversEnrolled, bridgePairsVerified, batches, retryAttempts, providerErrors, peakHeapBytes, throughputPerSec };
  } catch (error) {
    await prisma.massTrackerRun.update({ where: { id: runId }, data: {
      completedAt: new Date(), status: 'failed', inputEvents, persistedEvents,
      duplicateEvents: inputEvents - persistedEvents, relevantEvents, receiversEnrolled,
      bridgePairsVerified, batches, retryAttempts, providerErrors,
      peakHeapBytes: BigInt(peakHeapBytes), error: errorMessage(error)
    } });
    throw error;
  }
}

async function processBatchWithRetry(
  prisma: PrismaClient, events: CoreMassEvent[], enroll: boolean, maxRetries: number, retryBaseMs: number
): Promise<{ persisted: number; relevant: number; enrolled: number; bridges: number; retries: number }> {
  let retries = 0;
  for (;;) {
    try {
      const result = await processBatch(prisma, events, enroll);
      return { ...result, retries };
    } catch (error) {
      if (retries >= maxRetries || !isTransient(error)) throw error;
      retries++;
      await delay(retryBaseMs * 2 ** (retries - 1));
    }
  }
}

async function processBatch(prisma: PrismaClient, events: CoreMassEvent[], enroll: boolean): Promise<{ persisted: number; relevant: number; enrolled: number; bridges: number }> {
  const contexts = await resolveContexts(prisma, events);
  const classified = events.map((event) => {
    const pair = contexts.get(event.eventId)!;
    return { event, verdict: classifyMassEvent(event, pair.from, pair.to), pair };
  });
  const inserted = await prisma.massTransactionEvent.createMany({
    data: classified.map(({ event, verdict, pair }) => ({
      eventId: event.eventId, chain: event.chain, txHash: event.txHash,
      eventIndex: event.eventIndex, blockOrSlot: event.blockOrSlot, ts: event.ts,
      kind: event.kind, status: event.status, fromAddress: event.from, toAddress: event.to, actorAddress: event.actor,
      assetAddress: event.asset.address, assetSymbol: event.asset.symbol,
      assetDecimals: event.asset.decimals, amountToken: event.asset.amount,
      amountUsd: event.asset.amountUsd, programOrContract: event.programOrContract,
      provider: event.provider, observedAt: event.observedAt,
      bridgeProtocol: event.bridge?.protocol ?? null,
      officialMessageId: event.bridge?.officialMessageId ?? null,
      bridgeJson: event.bridge ? json(event.bridge) : Prisma.JsonNull,
      relevanceCategory: verdict.category, relevanceScore: verdict.score,
      reasonCodes: verdict.reasonCodes, safeEntityLink: verdict.safeEntityLink,
      enrollmentCandidate: verdict.enrollmentCandidate,
      sourceEntityKey: pair.from.trackedEntityKey,
      sourceRole: pair.from.role,
      metadataJson: json(event.metadata)
    })),
    skipDuplicates: true
  });
  let enrolled = 0;
  if (enroll) {
    for (const item of classified) {
      if (!item.verdict.enrollmentCandidate || !item.verdict.safeEntityLink || !item.pair.from.lineageRootId) continue;
      if (await enrollObservationReceiver(prisma, item.event, item.pair.from.lineageRootId)) enrolled++;
    }
  }
  const bridges = await persistExactBridgePairs(prisma, events);
  return { persisted: inserted.count, relevant: classified.filter((x) => x.verdict.relevant).length, enrolled, bridges };
}

async function resolveContexts(prisma: PrismaClient, events: readonly CoreMassEvent[]): Promise<Map<string, ContextPair>> {
  const keys = new Map<string, { chain: CoreMassEvent['chain']; address: string }>();
  for (const event of events) {
    keys.set(`${event.chain}:${event.from}`, { chain: event.chain, address: event.from });
    keys.set(`${event.chain}:${event.to}`, { chain: event.chain, address: event.to });
  }
  const clauses = [...keys.values()].map((x) => ({ chain: x.chain, address: x.address }));
  const degreeSql = clauses.length === 0 ? Prisma.sql`SELECT NULL::text AS chain, NULL::text AS address, 0::bigint AS degree WHERE false` : Prisma.sql`
    SELECT chain, address, COUNT(DISTINCT counterparty)::bigint AS degree FROM (
      SELECT "sourceChain"::text AS chain, "sourceAddress" AS address, "destinationAddress" AS counterparty
      FROM "money_flow_edges"
      WHERE ("sourceChain", "sourceAddress") IN (${Prisma.join(clauses.map((x) => Prisma.sql`(${x.chain}::"ChainId", ${x.address})`))})
      UNION ALL
      SELECT "destinationChain"::text AS chain, "destinationAddress" AS address, "sourceAddress" AS counterparty
      FROM "money_flow_edges"
      WHERE ("destinationChain", "destinationAddress") IN (${Prisma.join(clauses.map((x) => Prisma.sql`(${x.chain}::"ChainId", ${x.address})`))})
    ) edges GROUP BY chain, address`;
  const [wallets, registry, roles, degreeRows] = await Promise.all([
    prisma.wallet.findMany({ where: { OR: clauses }, select: {
      id: true, chain: true, address: true, status: true, lastActiveAt: true,
      lineageRoot: { select: { id: true } },
      monitoringSubscriptions: { where: { active: true, lineageRootId: { not: null } }, orderBy: { tierPriority: 'asc' }, take: 1, select: { lineageRootId: true } }
    } }),
    prisma.addressRegistry.findMany({ where: { OR: clauses }, select: { chain: true, address: true, category: true } }),
    prisma.walletRoleAssignment.findMany({ where: { OR: clauses.map((x) => ({ chain: x.chain, walletAddress: x.address })) }, orderBy: [{ confidence: 'desc' }, { computedAt: 'desc' }], select: { chain: true, walletAddress: true, role: true, entityKey: true } }),
    prisma.$queryRaw<{ chain: string; address: string; degree: bigint }[]>(degreeSql)
  ]);
  const walletMap = new Map(wallets.map((w) => [`${w.chain}:${w.address}`, w]));
  const registryMap = new Map(registry.map((r) => [`${r.chain}:${r.address}`, r.category]));
  const roleMap = new Map<string, typeof roles[number]>();
  for (const role of roles) if (!roleMap.has(`${role.chain}:${role.walletAddress}`)) roleMap.set(`${role.chain}:${role.walletAddress}`, role);
  const degreeMap = new Map(degreeRows.map((r) => [`${r.chain}:${r.address}`, Number(r.degree)]));
  const contexts = new Map<string, TrackerAddressContext>();
  for (const [key, value] of keys) {
    const wallet = walletMap.get(key);
    const assignment = roleMap.get(key);
    const isRoot = wallet?.lineageRoot != null;
    const subscriptionRootId = wallet?.monitoringSubscriptions[0]?.lineageRootId ?? null;
    const role = isRoot ? 'operator_root' : subscriptionRootId ? 'linked_wallet' : mapRole(assignment?.role);
    const lineageRootId = wallet?.lineageRoot?.id ?? subscriptionRootId;
    contexts.set(key, {
      chain: value.chain, address: value.address,
      infrastructure: (registryMap.get(key) as TrackerAddressContext['infrastructure']) ?? null,
      trackedEntityKey: lineageRootId ? `lineage:${lineageRootId}` : (assignment?.entityKey ?? null),
      lineageRootId,
      role, observationOnly: wallet?.status !== 'signal_eligible', distinctCounterparties: degreeMap.get(key) ?? 0,
      // Event-specific dormancy is filled below; keep lastActiveAt out of the
      // public context so classification remains a pure function.
      dormantDays: null
    });
  }
  const result = new Map<string, ContextPair>();
  for (const event of events) {
    const fromKey = `${event.chain}:${event.from}`;
    const toKey = `${event.chain}:${event.to}`;
    const receiverWallet = walletMap.get(toKey);
    result.set(event.eventId, {
      from: contexts.get(fromKey)!,
      to: {
        ...contexts.get(toKey)!,
        dormantDays: receiverWallet ? Math.max(0, (event.ts.getTime() - receiverWallet.lastActiveAt.getTime()) / 86_400_000) : null
      }
    });
  }
  return result;
}

function mapRole(role: string | undefined): EntityWalletRole {
  if (role === 'execution_wallet') return 'execution_wallet';
  if (role === 'probable_side_wallet' || role === 'funding_wallet' || role === 'profit_collection_wallet') return 'side_wallet';
  if (role === 'probable_linked_wallet' || role === 'bridge_linked_receiver') return 'linked_wallet';
  return 'unknown';
}

async function enrollObservationReceiver(prisma: PrismaClient, event: CoreMassEvent, lineageRootId: string): Promise<boolean> {
  if (!event.to) return false;
  const existing = await prisma.wallet.findUnique({ where: { address_chain: { address: event.to, chain: event.chain } }, select: { id: true } });
  const wallet = existing ?? await prisma.wallet.create({ data: {
    address: event.to, chain: event.chain, status: 'observation_only', firstSeenAt: event.ts,
    lastActiveAt: event.ts, notes: 'mass-tracker:observation-only-receiver'
  }, select: { id: true } });
  const existingSubscription = await prisma.monitoringSubscription.findUnique({ where: { walletId_priority: { walletId: wallet.id, priority: 'fresh_receiver_hot' } }, select: { id: true } });
  if (existingSubscription) return false;
  try {
    await prisma.monitoringSubscription.create({ data: {
      walletId: wallet.id, priority: 'fresh_receiver_hot', active: true, tierPriority: 0,
      reason: `mass_tracker_receiver:${event.eventId}`, lineageRootId,
      hotUntil: new Date(event.ts.getTime() + 24 * 60 * 60_000)
    } });
    return true;
  } catch (error) {
    if (isUnique(error)) return false;
    throw error;
  }
}

async function persistExactBridgePairs(prisma: PrismaClient, batch: readonly CoreMassEvent[]): Promise<number> {
  const exact = batch.filter((e) => e.bridge?.officialMessageId && e.bridge.verifiedBy !== 'heuristic' && e.bridge.protocolCompleted);
  if (exact.length === 0) return 0;
  const ids = [...new Set(exact.map((e) => e.bridge!.officialMessageId!))];
  const rows = await prisma.massTransactionEvent.findMany({
    where: { officialMessageId: { in: ids }, kind: { in: ['bridge_source', 'bridge_destination'] } },
    orderBy: [{ ts: 'asc' }, { eventId: 'asc' }]
  });
  const sources = rows.filter((r) => r.kind === 'bridge_source');
  const creates: Prisma.MassBridgeCorrelationCreateManyInput[] = [];
  for (const source of sources) {
    const dest = rows.find((r) => r.kind === 'bridge_destination' && r.chain !== source.chain && r.officialMessageId === source.officialMessageId && r.bridgeProtocol?.toLowerCase() === source.bridgeProtocol?.toLowerCase());
    if (!dest || !source.officialMessageId) continue;
    creates.push({
      correlationId: `${source.bridgeProtocol?.toLowerCase()}:${source.officialMessageId}`,
      protocol: source.bridgeProtocol ?? 'unknown', officialMessageId: source.officialMessageId,
      sourceEventId: source.eventId, destinationEventId: dest.eventId,
      status: 'verified', confidence: 100,
      reasonCodes: ['same_completed_official_message_id', 'cross_chain_direction_consistent']
    });
  }
  if (creates.length === 0) return 0;
  return (await prisma.massBridgeCorrelation.createMany({ data: creates, skipDuplicates: true })).count;
}

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
function isUnique(error: unknown): boolean { return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'; }
function isTransient(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && ['P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'P2034'].includes(error.code);
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000); }
function boundedInt(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, Math.trunc(value))); }
