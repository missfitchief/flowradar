import { Prisma, type ChainId, type PrismaClient } from '@prisma/client';
import { isRateLimitError } from '@flowradar/providers';

type Client = PrismaClient | Prisma.TransactionClient;

export interface ProviderHealthInput {
  provider: string;
  chain?: ChainId;
  capability: string;
  scope?: string;
  outcome: 'success' | 'error' | 'rate_limited' | 'timeout' | 'missing_key';
  latencyMs: number;
  retryCount?: number;
  error?: unknown;
}

export async function recordProviderHealth(prisma: Client, input: ProviderHealthInput) {
  const message = input.error == null ? null : input.error instanceof Error ? input.error.message : String(input.error);
  return prisma.providerHealthEvent.create({
    data: {
      provider: input.provider,
      chain: input.chain,
      capability: input.capability,
      scope: input.scope,
      outcome: input.outcome,
      latencyMs: Math.max(0, Math.round(input.latencyMs)),
      rateLimited: input.outcome === 'rate_limited' || isRateLimitError(input.error),
      timedOut: input.outcome === 'timeout' || /timeout|timed out|abort/i.test(message ?? ''),
      retryCount: Math.max(0, Math.round(input.retryCount ?? 0)),
      error: message?.slice(0, 1_000) ?? null
    }
  });
}

export interface CursorAdvanceInput {
  provider: string;
  chain: ChainId;
  scope: string;
  nextCursor: string | null;
  eventCount?: number;
  syncedAt?: Date;
}

/**
 * Advances an ISO timestamp cursor and records the transition. An equal
 * cursor is a successful replay; an older or malformed cursor is rejected.
 * The conditional update protects against a concurrent writer that advanced
 * after our read.
 */
export async function advanceTimestampCursor(prisma: PrismaClient, input: CursorAdvanceInput) {
  const syncedAt = input.syncedAt ?? new Date();
  return prisma.$transaction(async (tx) => {
    const key = { provider_chain_scope: { provider: input.provider, chain: input.chain, scope: input.scope } };
    const current = await tx.providerSyncState.findUnique({ where: key });
    const previous = current?.cursor ?? null;
    let decision = 'unchanged';
    let accepted = input.nextCursor;

    const previousMs = previous == null ? null : Date.parse(previous);
    const nextMs = input.nextCursor == null ? null : Date.parse(input.nextCursor);
    if (input.nextCursor != null && !Number.isFinite(nextMs)) {
      decision = 'rejected_invalid';
      accepted = previous;
    } else if (previous != null && !Number.isFinite(previousMs)) {
      decision = 'rejected_existing_invalid';
      accepted = previous;
    } else if (previousMs != null && nextMs != null && nextMs < previousMs) {
      decision = 'rejected_regression';
      accepted = previous;
    } else if (nextMs != null && (previousMs == null || nextMs > previousMs)) {
      decision = 'advanced';
    }

    if (!current) {
      await tx.providerSyncState.create({
        data: {
          provider: input.provider,
          chain: input.chain,
          scope: input.scope,
          cursor: accepted,
          lastSyncAt: syncedAt,
          lastError: decision.startsWith('rejected') ? decision : null,
          failCount: decision.startsWith('rejected') ? 1 : 0
        }
      });
    } else if (!decision.startsWith('rejected')) {
      const changed = await tx.providerSyncState.updateMany({
        where: { id: current.id, cursor: previous },
        data: { cursor: accepted, lastSyncAt: syncedAt, lastError: null, failCount: 0 }
      });
      if (changed.count === 0) {
        decision = 'rejected_concurrent_advance';
        accepted = previous;
      }
    } else {
      await tx.providerSyncState.update({
        where: { id: current.id },
        data: { lastError: decision, failCount: { increment: 1 } }
      });
    }

    await tx.providerCursorCheckpoint.create({
      data: {
        provider: input.provider,
        chain: input.chain,
        scope: input.scope,
        previousCursor: previous,
        nextCursor: accepted,
        decision,
        eventCount: Math.max(0, input.eventCount ?? 0)
      }
    });
    return { decision, previousCursor: previous, cursor: accepted };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function recordCursorFailure(
  prisma: Client,
  input: Pick<CursorAdvanceInput, 'provider' | 'chain' | 'scope'> & { error: unknown }
) {
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  const row = await prisma.providerSyncState.upsert({
    where: { provider_chain_scope: { provider: input.provider, chain: input.chain, scope: input.scope } },
    create: {
      provider: input.provider, chain: input.chain, scope: input.scope,
      lastError: message.slice(0, 1_000), failCount: 1
    },
    update: { lastError: message.slice(0, 1_000), failCount: { increment: 1 } }
  });
  await prisma.providerCursorCheckpoint.create({
    data: {
      provider: input.provider, chain: input.chain, scope: input.scope,
      previousCursor: row.cursor, nextCursor: row.cursor,
      decision: 'failure_no_advance', eventCount: 0
    }
  });
  return row;
}

export interface HeartbeatInput {
  component: string;
  status: 'starting' | 'healthy' | 'degraded' | 'stopping' | 'failed';
  pid?: number;
  startedAt: Date;
  success?: boolean;
  error?: unknown;
  metadata?: Record<string, unknown>;
}

export async function recordRuntimeHeartbeat(prisma: Client, input: HeartbeatInput) {
  const now = new Date();
  const message = input.error == null ? null : input.error instanceof Error ? input.error.message : String(input.error);
  return prisma.runtimeHeartbeat.upsert({
    where: { component: input.component },
    create: {
      component: input.component,
      status: input.status,
      pid: input.pid ?? process.pid,
      startedAt: input.startedAt,
      heartbeatAt: now,
      lastSuccessAt: input.success ? now : null,
      lastError: message?.slice(0, 1_000) ?? null,
      metadataJson: (input.metadata ?? {}) as Prisma.InputJsonValue
    },
    update: {
      status: input.status,
      pid: input.pid ?? process.pid,
      startedAt: input.startedAt,
      heartbeatAt: now,
      ...(input.success ? { lastSuccessAt: now, lastError: null } : message ? { lastError: message.slice(0, 1_000) } : {}),
      metadataJson: (input.metadata ?? {}) as Prisma.InputJsonValue
    }
  });
}

export interface IntegrityCheck {
  name: string;
  severity: 'error' | 'warning';
  count: number;
  detail: string;
}

export async function runProductionIntegrity(prisma: PrismaClient) {
  const startedAt = new Date();
  const run = await prisma.productionIntegrityRun.create({
    data: { startedAt, status: 'running', checksJson: [] }
  });
  try {
    const [coreWithoutSubscription, signalMissingEntity, signalMissingEvent, sentWithoutReceipt, staleClaims, invalidTimestampCursors] = await Promise.all([
      prisma.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(*)::bigint AS count
        FROM "operator_watches" ow
        WHERE ow."active" = true AND ow."targetType" = 'core_wallet'
          AND NOT EXISTS (
            SELECT 1 FROM "wallets" w
            JOIN "monitoring_subscriptions" ms ON ms."walletId" = w."id" AND ms."active" = true
            WHERE lower(w."address") = lower(ow."targetKey")
          )`,
      prisma.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(*)::bigint AS count
        FROM "intelligence_signals" s, unnest(s."entityIds") eid
        WHERE NOT EXISTS (SELECT 1 FROM "intelligence_entities" e WHERE e."id" = eid)`,
      prisma.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(*)::bigint AS count
        FROM "intelligence_signals" s, unnest(s."sourceEventIds") event_id
        WHERE NOT EXISTS (SELECT 1 FROM "mass_transaction_events" e WHERE e."eventId" = event_id)`,
      prisma.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(*)::bigint AS count FROM "operator_watch_alerts"
        WHERE "status" = 'sent'
          AND ("payloadJson" #>> '{deliveryReceipt,telegramMessageId}') IS NULL`,
      prisma.monitoringSubscription.count({ where: { claimedAt: { lt: new Date(Date.now() - 30 * 60_000) } } }),
      prisma.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(*)::bigint AS count FROM "provider_sync_states"
        WHERE "cursor" IS NOT NULL
          AND "provider" IN ('core_monitoring', 'helius', 'bscscan', 'mock')
          AND "cursor" !~ '^\\d{4}-\\d{2}-\\d{2}T'`
    ]);

    const checks: IntegrityCheck[] = [
      { name: 'core_wallet_monitoring_subscription', severity: 'error', count: Number(coreWithoutSubscription[0]?.count ?? 0n), detail: 'Active Core wallets without an active monitoring subscription.' },
      { name: 'signal_entity_references', severity: 'error', count: Number(signalMissingEntity[0]?.count ?? 0n), detail: 'Signal entity IDs with no persistent entity.' },
      { name: 'signal_event_references', severity: 'warning', count: Number(signalMissingEvent[0]?.count ?? 0n), detail: 'Signal source event IDs absent from the canonical mass-event store.' },
      { name: 'telegram_delivery_receipts', severity: 'error', count: Number(sentWithoutReceipt[0]?.count ?? 0n), detail: 'Alerts marked sent without a Telegram message receipt.' },
      { name: 'stale_monitoring_claims', severity: 'warning', count: staleClaims, detail: 'Monitoring claims older than the recovery window.' },
      { name: 'provider_cursor_format', severity: 'error', count: Number(invalidTimestampCursors[0]?.count ?? 0n), detail: 'Known timestamp providers with malformed cursors.' }
    ];
    const errorCount = checks.filter((check) => check.severity === 'error').reduce((sum, check) => sum + check.count, 0);
    const warningCount = checks.filter((check) => check.severity === 'warning').reduce((sum, check) => sum + check.count, 0);
    const status = errorCount > 0 ? 'failed' : warningCount > 0 ? 'degraded' : 'passed';
    await prisma.productionIntegrityRun.update({
      where: { id: run.id },
      data: { completedAt: new Date(), status, errorCount, warningCount, checksJson: checks as unknown as Prisma.InputJsonValue }
    });
    return { id: run.id, startedAt, status, errorCount, warningCount, checks };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.productionIntegrityRun.update({
      where: { id: run.id },
      data: { completedAt: new Date(), status: 'failed', errorCount: 1, checksJson: [{ name: 'integrity_runtime', severity: 'error', count: 1, detail: message }] }
    }).catch(() => undefined);
    throw error;
  }
}

export async function getProductionHealth(prisma: PrismaClient) {
  const now = Date.now();
  const dayAgo = new Date(now - 24 * 60 * 60_000);
  const [coreWalletRows, dormantWallets, observationWallets, providerSubscriptions, pendingJobs, queuedInvestigations, massLatency, massDuration, alertsGenerated,
    suppressedAlerts, rejectedAlerts, inboxAlerts, heartbeats, providerGroups, providers, latestIntegrity,
    cursorRegressions, activityEvents, signals, entities] = await Promise.all([
    prisma.operatorWatch.groupBy({ by: ['targetKey'], where: { targetType: 'core_wallet', active: true } }),
    prisma.intelligenceEntity.count({ where: { dormantSince: { not: null }, status: 'active' } }),
    prisma.wallet.count({ where: { status: 'observation_only' } }),
    prisma.monitoringSubscription.count({ where: { active: true } }),
    prisma.monitoringSubscription.count({ where: { active: true, OR: [{ nextPollAt: null }, { nextPollAt: { lte: new Date() } }] } }),
    prisma.walletInvestigation.count({ where: { status: { in: ['queued', 'running'] } } }),
    prisma.massTrackerRun.aggregate({ where: { startedAt: { gte: dayAgo }, completedAt: { not: null } }, _avg: { throughputPerSec: true }, _max: { peakHeapBytes: true }, _sum: { retryAttempts: true, providerErrors: true } }),
    prisma.$queryRaw<{ average_ms: number | null }[]>`
      SELECT AVG(EXTRACT(EPOCH FROM ("completedAt" - "startedAt")) * 1000)::float AS average_ms
      FROM "mass_tracker_runs" WHERE "completedAt" IS NOT NULL AND "startedAt" >= ${dayAgo}`,
    prisma.operatorWatchAlert.count({ where: { createdAt: { gte: dayAgo } } }),
    prisma.operatorWatchAlert.count({ where: { status: 'suppressed', createdAt: { gte: dayAgo } } }),
    prisma.operatorWatchAlert.count({ where: { status: { in: ['rejected', 'failed'] }, createdAt: { gte: dayAgo } } }),
    prisma.operatorWatchAlert.count({ where: { status: { in: ['pending', 'retryable', 'update_pending'] } } }),
    prisma.runtimeHeartbeat.findMany({ orderBy: { component: 'asc' } }),
    prisma.providerHealthEvent.groupBy({ by: ['provider'], where: { occurredAt: { gte: dayAgo } }, _count: { _all: true }, _avg: { latencyMs: true }, _sum: { retryCount: true } }),
    prisma.providerHealthEvent.findMany({ where: { occurredAt: { gte: dayAgo } }, orderBy: { occurredAt: 'desc' }, take: 10_000 }),
    prisma.productionIntegrityRun.findFirst({ orderBy: { startedAt: 'desc' } }),
    prisma.providerCursorCheckpoint.count({ where: { decision: { startsWith: 'rejected' }, createdAt: { gte: dayAgo } } }),
    prisma.massTransactionEvent.count(),
    prisma.intelligenceSignal.count(),
    prisma.intelligenceEntity.count()
  ]);
  const providerHealth = providerGroups.map((group) => {
    const rows = providers.filter((row) => row.provider === group.provider);
    const successes = rows.filter((row) => row.outcome === 'success').length;
    const last = rows[0];
    return {
      provider: group.provider,
      status: !last ? 'unknown' : last.outcome === 'success' ? 'healthy' : successes / Math.max(1, rows.length) >= 0.9 ? 'degraded' : 'failed',
      latencyMs: Math.round(group._avg.latencyMs ?? 0),
      successRate: rows.length ? successes / rows.length : 0,
      retryCount: group._sum.retryCount ?? 0,
      rateLimited: rows.filter((row) => row.rateLimited).length,
      timedOut: rows.filter((row) => row.timedOut).length,
      lastSuccessAt: rows.find((row) => row.outcome === 'success')?.occurredAt ?? null,
      lastError: rows.find((row) => row.error)?.error ?? null
    };
  });
  const coreWallets = coreWalletRows.length;
  return {
    generatedAt: new Date(),
    counts: { coreWallets, dormantWallets, observationWallets, providerSubscriptions, pendingJobs, queuedInvestigations, queueSize: pendingJobs + queuedInvestigations + inboxAlerts, alertsGenerated, suppressedAlerts, rejectedAlerts, inboxAlerts, activityEvents, signals, entities },
    processing: {
      averageLatencyMs: massDuration[0]?.average_ms ?? 0,
      throughputPerSec: massLatency._avg.throughputPerSec ?? 0,
      peakHeapBytes: massLatency._max.peakHeapBytes ?? 0n,
      retryAttempts: massLatency._sum.retryAttempts ?? 0,
      providerErrors: massLatency._sum.providerErrors ?? 0
    },
    runtimes: heartbeats.map((row) => {
      const metadata = row.metadataJson && typeof row.metadataJson === 'object' && !Array.isArray(row.metadataJson)
        ? row.metadataJson as Record<string, unknown> : {};
      const expectedIntervalMs = Number(metadata.expectedIntervalMs);
      const staleAfterMs = Number.isFinite(expectedIntervalMs) && expectedIntervalMs > 0
        ? Math.max(2 * 60_000, expectedIntervalMs * 2.5) : 2 * 60_000;
      return { ...row, stale: now - row.heartbeatAt.getTime() > staleAfterMs };
    }),
    providers: providerHealth,
    cursors: { rejectedRegressions24h: cursorRegressions },
    latestIntegrity
  };
}

export async function pruneOperationalTelemetry(prisma: PrismaClient, before = new Date(Date.now() - 30 * 86_400_000)) {
  const [health, checkpoints, integrity] = await prisma.$transaction([
    prisma.providerHealthEvent.deleteMany({ where: { occurredAt: { lt: before } } }),
    prisma.providerCursorCheckpoint.deleteMany({ where: { createdAt: { lt: before } } }),
    prisma.productionIntegrityRun.deleteMany({ where: { startedAt: { lt: new Date(before.getTime() - 60 * 86_400_000) } } })
  ]);
  return { health: health.count, checkpoints: checkpoints.count, integrity: integrity.count };
}
