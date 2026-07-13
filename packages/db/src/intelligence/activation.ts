import { createHash, randomUUID } from 'node:crypto';
import { Prisma, type ChainId, type PrismaClient } from '@prisma/client';

export const TRACKED_ACTIVATION_ENGINE_VERSION = 1;
const TRACKED_ROLES = [
  'operator_root', 'root_main', 'execution_wallet', 'high_pnl_wallet', 'dormant_funded_receiver',
  'fresh_funded_receiver', 'probable_side_wallet', 'probable_linked_wallet', 'bridge_linked_receiver',
  'profit_collection_wallet', 'funding_wallet'
];

export interface TrackedActivationReport {
  runId: string;
  sinceTs: string;
  trackedWallets: number;
  newBuyEvents: number;
  tokensConsidered: number;
  eligibleTokens: number;
  alertsCreated: number;
  historicalWithoutNewActivitySkipped: number;
  byType: Record<string, number>;
  honestEmpty: boolean;
  examples: Array<{ chain: ChainId; tokenAddress: string; alertType: string; walletCount: number; entityCount: number }>;
}

export async function scanTrackedTokenActivations(
  prisma: PrismaClient,
  options: { since?: Date; now?: Date; maxTrackedWallets?: number; maxBuyEvents?: number } = {}
): Promise<TrackedActivationReport> {
  const now = options.now ?? new Date();
  const runId = randomUUID();
  const previous = options.since ? null : await prisma.trackedActivationScanRun.findFirst({ where: { status: { in: ['completed', 'empty'] } }, orderBy: { completedAt: 'desc' } });
  const since = options.since ?? previous?.completedAt ?? new Date(now.getTime() - 24 * 60 * 60_000);
  const maxTracked = Math.max(1, Math.min(options.maxTrackedWallets ?? 50_000, 250_000));
  const maxBuyEvents = Math.max(1, Math.min(options.maxBuyEvents ?? 100_000, 500_000));
  await prisma.trackedActivationScanRun.create({
    data: { id: runId, startedAt: now, status: 'running', sinceTs: since, metadataJson: json({ maxTracked, maxBuyEvents }) }
  });

  const report: TrackedActivationReport = {
    runId, sinceTs: since.toISOString(), trackedWallets: 0, newBuyEvents: 0, tokensConsidered: 0,
    eligibleTokens: 0, alertsCreated: 0, historicalWithoutNewActivitySkipped: 0, byType: {}, honestEmpty: false, examples: []
  };
  try {
    const [subscriptions, roles] = await Promise.all([
      prisma.monitoringSubscription.findMany({
        where: { active: true }, include: { wallet: { select: { chain: true, address: true } } },
        orderBy: [{ tierPriority: 'asc' }, { updatedAt: 'desc' }], take: maxTracked
      }),
      prisma.walletRoleAssignment.findMany({
        where: { role: { in: TRACKED_ROLES } }, orderBy: [{ confidence: 'desc' }, { computedAt: 'desc' }], take: maxTracked,
        select: { chain: true, walletAddress: true, role: true, entityKey: true }
      })
    ]);
    const tracked = new Map<string, { chain: ChainId; address: string; role: string; entityKey: string | null }>();
    for (const row of subscriptions) tracked.set(`${row.wallet.chain}:${row.wallet.address}`, { chain: row.wallet.chain, address: row.wallet.address, role: row.priority, entityKey: null });
    for (const row of roles) tracked.set(`${row.chain}:${row.walletAddress}`, { chain: row.chain, address: row.walletAddress, role: row.role, entityKey: row.entityKey });
    const trackedRows = [...tracked.values()].slice(0, maxTracked);
    report.trackedWallets = trackedRows.length;
    const unifiedRows = [] as Array<{ chain: ChainId; address: string; entity: { entityKey: string } }>;
    for (const chain of ['SOLANA', 'ETHEREUM', 'BASE', 'ARBITRUM', 'BSC'] as ChainId[]) {
      const addresses = trackedRows.filter((row) => row.chain === chain).map((row) => row.address).sort();
      for (const addressChunk of chunks(addresses, 5_000)) {
        unifiedRows.push(...await prisma.unifiedEntityAddress.findMany({
          where: { chain, address: { in: addressChunk } },
          select: { chain: true, address: true, entity: { select: { entityKey: true } } }
        }));
      }
    }
    const entityOf = new Map(unifiedRows.map((row) => [`${row.chain}:${row.address}`, row.entity.entityKey]));

    const buys = [] as Awaited<ReturnType<typeof loadChainBuys>>;
    for (const chain of ['SOLANA', 'ETHEREUM', 'BASE', 'ARBITRUM', 'BSC'] as ChainId[]) {
      const addresses = trackedRows.filter((row) => row.chain === chain).map((row) => row.address);
      if (!addresses.length) continue;
      buys.push(...await loadChainBuys(prisma, chain, addresses, since, now, Math.max(1, maxBuyEvents - buys.length)));
      if (buys.length >= maxBuyEvents) break;
    }
    report.newBuyEvents = buys.length;
    const groups = new Map<string, typeof buys>();
    for (const event of buys) {
      if (!event.assetAddress) continue;
      const key = `${event.chain}:${event.assetAddress}`;
      const bucket = groups.get(key) ?? [];
      bucket.push(event);
      groups.set(key, bucket);
    }
    report.tokensConsidered = groups.size;
    const historicalCount = await prisma.historicalTokenUniverse.count();
    const historicalWithActivity = new Set<string>();

    for (const [groupKey, events] of groups) {
      const colon = groupKey.indexOf(':');
      const chain = groupKey.slice(0, colon) as ChainId;
      const tokenAddress = groupKey.slice(colon + 1);
      const ordered = [...events].sort((a, b) => a.ts.getTime() - b.ts.getTime() || a.eventId.localeCompare(b.eventId));
      const first = ordered[0];
      const last = ordered[ordered.length - 1];
      const historical = await prisma.historicalTokenUniverse.findUnique({ where: { chain_tokenAddress: { chain, tokenAddress } } });
      if (historical) historicalWithActivity.add(groupKey);
      const [token, previousBuy, lifecycle] = await Promise.all([
        prisma.token.findUnique({
          where: { chain_address: { chain, address: tokenAddress } },
          select: {
            id: true, firstSeenAt: true, tokenCreatedAt: true,
            flowSnapshots: {
              where: { ts: { lt: first.ts } }, orderBy: { ts: 'desc' }, take: 1,
              select: { ts: true, signalStatus: true }
            }
          }
        }),
        prisma.massTransactionEvent.findFirst({
          where: { chain, kind: 'token_buy', assetAddress: tokenAddress, ts: { lt: first.ts } },
          orderBy: [{ ts: 'desc' }, { eventId: 'desc' }]
        }),
        chain === 'SOLANA'
          ? prisma.tokenLifecycle.findUnique({ where: { mint: tokenAddress }, select: { firstObservedAt: true, lastObservedAt: true, outcomeLabels: true } })
          : null
      ]);
      const birth = token?.tokenCreatedAt ?? token?.firstSeenAt ?? lifecycle?.firstObservedAt ?? null;
      const ageMs = birth ? first.ts.getTime() - birth.getTime() : null;
      const newToken = ageMs !== null && ageMs >= -86_400_000 && ageMs <= 30 * 86_400_000;
      const deadSnapshot = token?.flowSnapshots[0];
      const knownDead = deadSnapshot?.signalStatus === 'dead' || lifecycleHasDeadOutcome(lifecycle?.outcomeLabels);
      const lastKnownActivity = latestDate(previousBuy?.ts ?? null, lifecycle?.lastObservedAt ?? null, deadSnapshot?.ts ?? null);
      const reactivated = knownDead && lastKnownActivity !== null && first.ts.getTime() - lastKnownActivity.getTime() >= 30 * 86_400_000;
      if (!newToken && !reactivated) {
        await prisma.trackedTokenActivationAlert.updateMany({
          where: { chain, tokenAddress, status: 'active', sourceEventIds: { hasSome: ordered.map((event) => event.eventId) } },
          data: { status: 'invalidated' }
        });
        continue;
      }

      const walletEvents = new Map<string, typeof ordered>();
      for (const event of ordered) {
        const wallet = event.actorAddress ?? event.fromAddress;
        if (!tracked.has(`${chain}:${wallet}`)) continue;
        const bucket = walletEvents.get(wallet) ?? [];
        bucket.push(event);
        walletEvents.set(wallet, bucket);
      }
      const wallets = [...walletEvents.keys()].sort();
      const entities = new Map<string, string[]>();
      for (const wallet of wallets) {
        const entityKey = entityOf.get(`${chain}:${wallet}`) ?? tracked.get(`${chain}:${wallet}`)?.entityKey ?? `wallet:${chain}:${wallet}`;
        const bucket = entities.get(entityKey) ?? [];
        bucket.push(wallet);
        entities.set(entityKey, bucket);
      }
      const sameCluster = [...entities.entries()].find(([, members]) => members.length >= 2) ?? null;
      const independentEntities = entities.size;
      const dormantFundingEvidence = await loadDormantFundingEvidence(prisma, chain, walletEvents);
      const traces = await prisma.massTrackerTrace.findMany({
        where: { tokenBought: tokenAddress, terminalWallet: { in: wallets }, computedAt: { gte: since } },
        orderBy: { computedAt: 'asc' }, take: 1_000
      });

      const criteria: Array<{ type: string; confidence: number; evidence: unknown }> = [];
      if (sameCluster) criteria.push({ type: 'same_cluster_multi_wallet_buy', confidence: 0.85, evidence: { entityKey: sameCluster[0], wallets: sameCluster[1] } });
      if (independentEntities >= 2) criteria.push({ type: 'independent_entity_confluence', confidence: 0.9, evidence: { entityKeys: [...entities.keys()] } });
      if (dormantFundingEvidence.length) criteria.push({ type: 'dormant_funded_wallet_buy', confidence: 0.9, evidence: dormantFundingEvidence });
      if (traces.length) criteria.push({ type: 'tracked_entity_receiver_buy', confidence: 0.9, evidence: traces.map((trace) => ({ traceId: trace.traceId, sourceEntityKey: trace.sourceEntityKey, terminalWallet: trace.terminalWallet, route: trace.route, eventIds: trace.eventIds })) });
      if (!criteria.length) continue;
      report.eligibleTokens += 1;
      for (const criterion of criteria) {
        const sourceEventIds = [...new Set(ordered.map((event) => event.eventId))].sort();
        const dedupeKey = activationKey(chain, tokenAddress, criterion.type, sourceEventIds);
        const data = {
          dedupeKey, chain, tokenAddress, alertType: criterion.type, activatedAt: last.ts,
          trackedWallets: wallets, entityKeys: [...entities.keys()].sort(), trackedWalletCount: wallets.length,
          independentEntityCount: independentEntities, sourceEventIds, confidence: criterion.confidence,
          historicalToken: Boolean(historical),
          evidenceJson: json({
            criterion: criterion.evidence, newToken, reactivated, birthTs: birth?.toISOString() ?? null,
            previousBuyTs: previousBuy?.ts.toISOString() ?? null, knownDead,
            deadEvidenceTs: lastKnownActivity?.toISOString() ?? null
          }),
          caveats: ['history chooses monitored wallets; only new transaction events choose the alerted token', 'observation_only evidence; no trade execution or eligibility change'],
          status: 'active', engineVersion: TRACKED_ACTIVATION_ENGINE_VERSION, computedAt: now
        };
        const result = await prisma.trackedTokenActivationAlert.upsert({
          where: { dedupeKey }, create: data, update: data
        });
        void result;
        report.alertsCreated += 1;
        report.byType[criterion.type] = (report.byType[criterion.type] ?? 0) + 1;
        if (report.examples.length < 10) report.examples.push({ chain, tokenAddress, alertType: criterion.type, walletCount: wallets.length, entityCount: independentEntities });
      }
    }
    report.historicalWithoutNewActivitySkipped = Math.max(0, historicalCount - historicalWithActivity.size);
    report.honestEmpty = report.alertsCreated === 0;
    await prisma.trackedActivationScanRun.update({
      where: { id: runId },
      data: {
        completedAt: new Date(), status: report.honestEmpty ? 'empty' : 'completed', trackedWallets: report.trackedWallets,
        newBuyEvents: report.newBuyEvents, tokensConsidered: report.tokensConsidered, alertsCreated: report.alertsCreated,
        historicalWithoutActivitySkipped: report.historicalWithoutNewActivitySkipped,
        metadataJson: json({ eligibleTokens: report.eligibleTokens, byType: report.byType, examples: report.examples })
      }
    });
    return report;
  } catch (error) {
    await prisma.trackedActivationScanRun.update({
      where: { id: runId },
      data: { completedAt: new Date(), status: 'failed', errorCount: 1, metadataJson: json({ error: error instanceof Error ? error.message : String(error) }) }
    });
    throw error;
  }
}

async function loadChainBuys(prisma: PrismaClient, chain: ChainId, addresses: string[], since: Date, now: Date, take: number) {
  const addressChunks = chunks([...new Set(addresses)].sort(), 5_000);
  const rows = [] as Awaited<ReturnType<PrismaClient['massTransactionEvent']['findMany']>>;
  for (let index = 0; index < addressChunks.length; index += 1) {
    const remaining = take - rows.length;
    if (remaining <= 0) break;
    const remainingChunks = addressChunks.length - index;
    const chunkTake = Math.max(1, Math.ceil(remaining / remainingChunks));
    rows.push(...await prisma.massTransactionEvent.findMany({
      where: {
        // observedAt is the ingestion watermark. Using transaction ts here
        // would permanently miss a late-arriving receipt after the prior scan.
        chain, kind: 'token_buy', status: { not: 'failed' }, assetAddress: { not: null }, observedAt: { gt: since, lte: now },
        OR: [{ actorAddress: { in: addressChunks[index] } }, { fromAddress: { in: addressChunks[index] } }]
      },
      orderBy: [{ ts: 'asc' }, { eventId: 'asc' }], take: chunkTake
    }));
  }
  return rows.sort((a, b) => a.ts.getTime() - b.ts.getTime() || a.eventId.localeCompare(b.eventId)).slice(0, take);
}
async function loadDormantFundingEvidence(
  prisma: PrismaClient,
  chain: ChainId,
  walletEvents: Map<string, Awaited<ReturnType<typeof loadChainBuys>>>
) {
  const wallets = [...walletEvents.keys()];
  if (!wallets.length) return [];
  const firstBuyByWallet = new Map(wallets.map((wallet) => [wallet, walletEvents.get(wallet)![0]]));
  const earliestWindow = new Date(Math.min(...[...firstBuyByWallet.values()].map((buy) => buy.ts.getTime())) - 7 * 86_400_000);
  const latestBuy = new Date(Math.max(...[...firstBuyByWallet.values()].map((buy) => buy.ts.getTime())));
  const fundingRows = await prisma.massTransactionEvent.findMany({
    where: {
      chain, toAddress: { in: wallets }, ts: { gte: earliestWindow, lt: latestBuy },
      relevanceCategory: { in: ['capital_transfer', 'gas_funding'] }, sourceEntityKey: { not: null }
    },
    orderBy: [{ ts: 'desc' }, { eventId: 'desc' }], take: 100_000
  });
  const fundingByWallet = new Map<string, typeof fundingRows[number]>();
  for (const funding of fundingRows) {
    const buy = firstBuyByWallet.get(funding.toAddress);
    if (!buy || funding.ts >= buy.ts || buy.ts.getTime() - funding.ts.getTime() > 7 * 86_400_000 || fundingByWallet.has(funding.toAddress)) continue;
    fundingByWallet.set(funding.toAddress, funding);
  }
  if (!fundingByWallet.size) return [];
  const latestFunding = new Date(Math.max(...[...fundingByWallet.values()].map((event) => event.ts.getTime())));
  const fundedWallets = [...fundingByWallet.keys()];
  const priorRows = await prisma.massTransactionEvent.findMany({
    where: {
      chain, ts: { lt: latestFunding },
      OR: [{ fromAddress: { in: fundedWallets } }, { toAddress: { in: fundedWallets } }, { actorAddress: { in: fundedWallets } }]
    },
    orderBy: [{ ts: 'desc' }, { eventId: 'desc' }], take: 100_000
  });
  const activityByWallet = new Map<string, typeof priorRows>();
  const fundedSet = new Set(fundedWallets);
  for (const event of priorRows) {
    for (const address of new Set([event.fromAddress, event.toAddress, event.actorAddress].filter((value): value is string => Boolean(value)))) {
      if (!fundedSet.has(address)) continue;
      const bucket = activityByWallet.get(address) ?? [];
      bucket.push(event);
      activityByWallet.set(address, bucket);
    }
  }
  const evidence: Array<{ wallet: string; fundingEventId: string; buyEventId: string; priorActivityTs: string | null }> = [];
  for (const [wallet, funding] of fundingByWallet) {
    const prior = (activityByWallet.get(wallet) ?? []).find((event) => event.ts < funding.ts);
    if (prior && funding.ts.getTime() - prior.ts.getTime() < 7 * 86_400_000) continue;
    evidence.push({ wallet, fundingEventId: funding.eventId, buyEventId: firstBuyByWallet.get(wallet)!.eventId, priorActivityTs: prior?.ts.toISOString() ?? null });
  }
  return evidence;
}
function activationKey(chain: ChainId, token: string, type: string, eventIds: string[]) {
  return createHash('sha256').update(`${chain}|${token}|${type}|${eventIds.join(',')}`).digest('hex');
}
function lifecycleHasDeadOutcome(value: Prisma.JsonValue | null | undefined) {
  if (!Array.isArray(value)) return false;
  return value.some((item) => typeof item === 'string' && ['rug_or_collapse', 'failed_launch', 'illiquid_untradeable'].includes(item));
}
function latestDate(...dates: Array<Date | null>) {
  return dates.reduce<Date | null>((latest, date) => !date ? latest : !latest || date > latest ? date : latest, null);
}
function chunks<T>(rows: T[], size: number) {
  const result: T[][] = [];
  for (let index = 0; index < rows.length; index += size) result.push(rows.slice(index, index + size));
  return result;
}
function json(value: unknown): Prisma.InputJsonValue { return value as Prisma.InputJsonValue; }
