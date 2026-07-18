// FlowRadar — monitoringScheduler job (Wave C).
//
// Drives the queue-based monitoring scheduler. The poller's real work is to
// REOPEN the polled wallet's lineage expansion node(s) to pending, so the
// lineageExpansion job re-scans that wallet's transactions at its tier cadence
// (the scheduler decides WHICH wallets and WHEN under a request budget; the
// expansion job does the provider fetching). This is the honest integration —
// NOT a no-op. Never mutates wallet eligibility.

import { advanceTimestampCursor, createMassTrackerSession, expandWalletCapitalGraph, recordCursorFailure, recordProviderHealth, runMonitoringScheduler, type MonitoringPollContext, type MonitoringPollFn } from '@flowradar/db';
import { createLiveWalletCapitalScanner } from '@flowradar/providers';
import type { ChainId } from '@prisma/client';
import { MIN_QUALIFYING_BUY_USD, type MassTransactionEvent } from '@flowradar/core';
import type { JobContext } from '../context';

// Bounded per tick — the scheduler's tier cadences keep most wallets not-due.
const REQUEST_BUDGET = 40;
const CORE_SYNC_PROVIDER = 'core_monitoring';
const CORE_INITIAL_LOOKBACK_MS = 24 * 60 * 60_000;
const CORE_CURSOR_OVERLAP_MS = 5 * 60_000;
const CORE_MAX_PAGES = 10;
const activeCoreGraphExpansions = new Set<string>();

export function coreMonitoringSince(cursor: string | null | undefined, now = new Date()) {
  if (cursor) {
    const parsed = new Date(cursor);
    if (!Number.isNaN(parsed.getTime())) return new Date(parsed.getTime() - CORE_CURSOR_OVERLAP_MS);
  }
  return new Date(now.getTime() - CORE_INITIAL_LOOKBACK_MS);
}

export function coreAlertDecision(event: Pick<MassTransactionEvent, 'kind' | 'status'> & { asset: { address: string | null; amountUsd: number | null } }) {
  if (event.status === 'failed') return { eligible: false, alertType: null, rejectionReason: 'failed_transaction' } as const;
  if (event.kind === 'token_buy') {
    if (!event.asset.address) return { eligible: false, alertType: null, rejectionReason: 'token_buy_missing_asset' } as const;
    if (event.asset.amountUsd === null || !Number.isFinite(event.asset.amountUsd)) {
      return { eligible: false, alertType: null, rejectionReason: 'usd_value_unavailable' } as const;
    }
    return event.asset.amountUsd < MIN_QUALIFYING_BUY_USD
      ? { eligible: false, alertType: null, rejectionReason: 'below_minimum_buy_threshold' } as const
      : { eligible: false, alertType: null, rejectionReason: 'solo_core_buy_no_confluence' } as const;
  }
  if (event.kind === 'native_transfer' || event.kind === 'token_transfer') {
    return { eligible: false, alertType: null, rejectionReason: 'silent_transfer_policy' } as const;
  }
  if (event.kind === 'token_sell') return { eligible: false, alertType: null, rejectionReason: 'sell_is_silent' } as const;
  return { eligible: false, alertType: null, rejectionReason: `unsupported_activity:${event.kind}` } as const;
}

export async function run(ctx: JobContext): Promise<void> {
  const { prisma, log } = ctx;
  const liveScanner = process.env.MOCK_MODE === 'false' ? createLiveWalletCapitalScanner(process.env) : null;
  const due: MonitoringPollContext[] = [];

  const poll: MonitoringPollFn = async (item) => {
    const { walletAddress, walletChain } = item;
    try {
      due.push(item);
      // Reopen this wallet's completed/skipped expansion nodes so the next
      // lineageExpansion pass re-scans it. Idempotent; enrollment dedupes.
      // Provider FETCHING happens in lineageExpansion (its own per-node error
      // isolation + the node stays pending for retry). We surface provider
      // health back to the scheduler's backoff by reporting ok=false when the
      // wallet's LAST expansion ended in an error stop reason — so a
      // persistently-failing wallet is polled less often.
      const errored = await prisma.lineageExpansionNode.findFirst({
        where: { walletAddress, chain: walletChain, stopReason: { startsWith: 'error' } },
        select: { id: true }
      });
      await prisma.lineageExpansionNode.updateMany({
        where: { walletAddress, chain: walletChain, status: { in: ['done', 'skipped'] } },
        data: { status: 'pending' }
      });
      return { ok: errored === null };
    } catch {
      return { ok: false };
    }
  };

  const result = await runMonitoringScheduler(prisma, { requestBudget: REQUEST_BUDGET, poll });
  let livePolled = 0;
  let liveEvents = 0;
  let liveErrors = 0;
  if (liveScanner) {
    const [coreWatches, lineageRoots, webhookStates] = await Promise.all([
      prisma.operatorWatch.findMany({ where: { targetType: 'core_wallet', active: true }, select: { targetKey: true } }),
      prisma.lineageRoot.findMany({
        where: { id: { in: due.map((item) => item.lineageRootId).filter((value): value is string => Boolean(value)) } },
        select: { id: true, wallet: { select: { address: true } } }
      }),
      prisma.alchemyWebhookSubscriptionState.findMany({ where: { status: 'synced' }, select: { chain: true } })
    ]);
    const webhookChains = new Set(webhookStates.map((state) => state.chain));
    const coreTargets = new Set(coreWatches.map((watch) => watch.targetKey));
    const rootTarget = new Map(lineageRoots.map((root) => [root.id, root.wallet.address]));
    const rawCoreDue = due.filter((item) => !webhookChains.has(item.walletChain) && (
      coreTargets.has(item.walletAddress) || Boolean(item.lineageRootId && coreTargets.has(rootTarget.get(item.lineageRootId) ?? ''))
    ));
    // A wallet can have several tier subscriptions under the same Core root.
    // One provider request is enough; event ids and DB constraints are still
    // the final replay guard, but de-duplicating here avoids needless calls.
    const coreDue = [...new Map(rawCoreDue.map((item) => [`${item.walletChain}:${item.walletAddress}`, item])).values()];
    const outcomes = await mapConcurrent(coreDue, 3, async (item) => {
      const scanStartedAt = new Date();
      try {
        // Scheduler.lastPolledAt used to advance even though the Solana poll
        // only reopened a lineage node. It is therefore not an ingest cursor.
        // Keep a dedicated, provider-backed cursor that advances only after a
        // successful live scan, with overlap for finality/provider lag.
        const syncState = await prisma.providerSyncState.findUnique({
          where: { provider_chain_scope: { provider: CORE_SYNC_PROVIDER, chain: item.walletChain, scope: item.walletAddress } }
        });
        const since = coreMonitoringSince(syncState?.cursor, scanStartedAt);
        const scan = await liveScanner.scanAddress(item.walletChain, item.walletAddress, {
          root: item.tier === 'root_permanent', maxPages: CORE_MAX_PAGES, since
        });
        await recordProviderHealth(prisma, {
          provider: scan.provider, chain: item.walletChain, capability: 'core_monitoring', scope: item.walletAddress,
          outcome: 'success', latencyMs: Date.now() - scanStartedAt.getTime()
        });
        log?.info('core alert pipeline', {
          stage: 'provider_event_seen', chain: item.walletChain, wallet: item.walletAddress,
          provider: scan.provider, since: since.toISOString(), events: scan.events.length,
          pagesFetched: scan.pagesFetched, complete: scan.complete, warnings: scan.warnings.join('; ') || null
        });
        const classifiedEvents = scan.events.map((event) => {
          const decision = coreAlertDecision(event);
          return {
            ...event,
            metadata: {
              ...event.metadata,
              coreWalletMonitoringPoll: true,
              coreMonitoringRoot: item.lineageRootId ?? null,
              coreAlertEligible: decision.eligible,
              coreAlertType: decision.alertType,
              coreAlertRejectionReason: decision.rejectionReason,
              corePipelineObservedAt: scanStartedAt.toISOString()
            }
          };
        });
        const kindCounts = classifiedEvents.reduce<Record<string, number>>((counts, event) => {
          counts[event.kind] = (counts[event.kind] ?? 0) + 1;
          return counts;
        }, {});
        const rejectionCounts = classifiedEvents.reduce<Record<string, number>>((counts, event) => {
          const decision = coreAlertDecision(event);
          const key = decision.eligible ? `eligible:${decision.alertType}` : `rejected:${decision.rejectionReason}`;
          counts[key] = (counts[key] ?? 0) + 1;
          return counts;
        }, {});
        log?.info('core alert pipeline', {
          stage: 'normalized', chain: item.walletChain, wallet: item.walletAddress,
          events: classifiedEvents.length, kinds: JSON.stringify(kindCounts), eligibility: JSON.stringify(rejectionCounts)
        });
        if (!classifiedEvents.length) {
          await persistCoreCursor(prisma, item.walletChain, item.walletAddress, scanStartedAt, null, 0);
          return { ok: true, events: 0 };
        }
        const tracker = await createMassTrackerSession(prisma, {
          enrollReceivers: true,
          metadata: { workflow: 'core_wallet_monitoring', chain: item.walletChain, wallet: item.walletAddress, tier: item.tier, since: since.toISOString() }
        });
        let metrics;
        try {
          await tracker.ingest(classifiedEvents);
          metrics = await tracker.complete();
        } catch (error) {
          await tracker.fail(error);
          throw error;
        }
        const persisted = await prisma.massTransactionEvent.findMany({
          where: { eventId: { in: classifiedEvents.map((event) => event.eventId) } },
          select: { eventId: true, kind: true, txHash: true }
        });
        log?.info('core alert pipeline', {
          stage: 'persisted', chain: item.walletChain, wallet: item.walletAddress,
          normalized: classifiedEvents.length, persistedNow: metrics.persistedEvents,
          presentAfterCommit: persisted.length, duplicates: classifiedEvents.length - metrics.persistedEvents,
          buyTxHashes: persisted.filter((event) => event.kind === 'token_buy').map((event) => event.txHash).join(',') || null,
          massTrackerRunId: metrics.runId
        });
        // The provider cursor belongs to ingest, not graph enrichment. Advancing
        // it only after a potentially expensive graph pass replayed the same
        // provider window and could starve future Core polling for minutes.
        await persistCoreCursor(prisma, item.walletChain, item.walletAddress, scanStartedAt, null, classifiedEvents.length);
        if (metrics.persistedEvents > 0) queueCoreGraphExpansion(prisma, item, log);
        return { ok: true, events: metrics.persistedEvents };
      } catch (error) {
        await persistCoreCursor(prisma, item.walletChain, item.walletAddress, null, error, 0).catch(() => undefined);
        await recordProviderHealth(prisma, {
          provider: CORE_SYNC_PROVIDER, chain: item.walletChain, capability: 'core_monitoring', scope: item.walletAddress,
          outcome: /rate limit|429/i.test(error instanceof Error ? error.message : String(error)) ? 'rate_limited' : /timeout|timed out|abort/i.test(error instanceof Error ? error.message : String(error)) ? 'timeout' : /not configured|missing/i.test(error instanceof Error ? error.message : String(error)) ? 'missing_key' : 'error',
          latencyMs: Date.now() - scanStartedAt.getTime(), error
        }).catch(() => undefined);
        log?.error('core monitoring poll failed', {
          chain: item.walletChain, wallet: item.walletAddress,
          error: error instanceof Error ? error.message : String(error)
        });
        return { ok: false, events: 0 };
      }
    });
    livePolled = outcomes.length;
    liveEvents = outcomes.reduce((sum, outcome) => sum + outcome.events, 0);
    liveErrors = outcomes.filter((outcome) => !outcome.ok).length;
  }
  log?.info('monitoringScheduler pass complete', { ...result, livePolled, liveEvents, liveErrors, byTier: JSON.stringify(result.byTier) });
}

function queueCoreGraphExpansion(
  prisma: JobContext['prisma'],
  item: { walletChain: ChainId; walletAddress: string; tier: string },
  log?: JobContext['log']
) {
  const key = `${item.walletChain}:${item.walletAddress}`;
  if (activeCoreGraphExpansions.has(key)) return;
  activeCoreGraphExpansions.add(key);
  void expandWalletCapitalGraph(prisma, {
    chain: item.walletChain, walletAddress: item.walletAddress, maxDepth: 4,
    maxNodes: item.tier === 'root_permanent' ? 100 : 30, maxEventsPerNode: 500
  }).then((result) => {
    log?.info('core graph expansion complete', {
      chain: item.walletChain, wallet: item.walletAddress,
      relationshipsPersisted: result.relationshipsPersisted
    });
  }).catch((error) => {
    log?.error('core graph expansion failed', {
      chain: item.walletChain, wallet: item.walletAddress,
      error: error instanceof Error ? error.message : String(error)
    });
  }).finally(() => activeCoreGraphExpansions.delete(key));
}

async function persistCoreCursor(
  prisma: JobContext['prisma'], chain: ChainId, address: string, scanStartedAt: Date | null, error: unknown, eventCount = 0
) {
  const message = error instanceof Error ? error.message : error == null ? null : String(error);
  if (message) {
    await recordCursorFailure(prisma, { provider: CORE_SYNC_PROVIDER, chain, scope: address, error: message });
    return;
  }
  await advanceTimestampCursor(prisma, {
    provider: CORE_SYNC_PROVIDER, chain, scope: address,
    nextCursor: scanStartedAt?.toISOString() ?? null, syncedAt: scanStartedAt ?? new Date(), eventCount
  });
}

async function mapConcurrent<T, R>(values: readonly T[], concurrency: number, fn: (value: T) => Promise<R>) {
  const results = new Array<R>(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), values.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= values.length) return;
      results[index] = await fn(values[index]);
    }
  });
  await Promise.all(workers);
  return results;
}
