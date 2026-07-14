import { createHash, randomUUID } from 'node:crypto';
import { Prisma, type ChainId, type IntelligenceSignalLevel, type PrismaClient } from '@prisma/client';
import { normalizeAddress } from '../discovery/unified';
import {
  ADAPTIVE_MODEL_VERSION, ADAPTIVE_RULE_VERSION, ADAPTIVE_THRESHOLDS,
  scoreAdaptiveActivation
} from './adaptive';
import { syncIntelligenceEntities } from './entities';
import { assessTokenQuality } from './tokenQuality';

export const INTELLIGENCE_LIFECYCLE_ENGINE_VERSION = 2;
const CHAINS: ChainId[] = ['SOLANA', 'ETHEREUM', 'BASE', 'ARBITRUM', 'BSC'];
const DORMANT_MS = 30 * 86_400_000;
const ACTIVATION_WINDOW_MS = 24 * 60 * 60_000;

export interface IntelligenceLifecycleReport {
  runId: string;
  sinceObservedAt: string;
  profilesTracked: number;
  eventsProcessed: number;
  intelligenceEventsCreated: number;
  dormantAwakenings: number;
  tokenGroupsConsidered: number;
  signalsCreated: number;
  buyCandidatesCreated: number;
  singleWalletGroupsRejected: number;
  honestEmpty: boolean;
  durationMs: number;
  throughputEventsPerSec: number;
  heapUsedBytes: number;
  heapDeltaBytes: number;
  retryCount: number;
}

type Profile = Prisma.WalletIntelligenceProfileGetPayload<{ include: { cluster: true; wallet: true } }>;
type MassEvent = Awaited<ReturnType<PrismaClient['massTransactionEvent']['findMany']>>[number];

/**
 * Consumes newly observed mass-tracker events for permanent intelligence
 * profiles, appends activity/dormancy receipts, then creates signals only from
 * structural cluster/entity activation involving at least two profiles.
 */
export async function runIntelligenceLifecycle(
  prisma: PrismaClient,
  options: { since?: Date; now?: Date; maxProfiles?: number; maxEvents?: number } = {}
): Promise<IntelligenceLifecycleReport> {
  const now = options.now ?? new Date();
  const startedMs = Date.now();
  const startHeap = process.memoryUsage().heapUsed;
  const previous = options.since ? null : await prisma.intelligenceLifecycleRun.findFirst({
    where: { status: { in: ['completed', 'empty'] } }, orderBy: { completedAt: 'desc' }
  });
  const since = options.since ?? previous?.completedAt ?? new Date(now.getTime() - 24 * 60 * 60_000);
  const maxProfiles = clampInt(options.maxProfiles ?? 50_000, 1, 250_000);
  const maxEvents = clampInt(options.maxEvents ?? 100_000, 1, 500_000);
  const runId = randomUUID();
  await prisma.intelligenceLifecycleRun.create({
    data: { id: runId, startedAt: now, sinceObservedAt: since, status: 'running', metadataJson: json({ maxProfiles, maxEvents }) }
  });
  const report: IntelligenceLifecycleReport = {
    runId,
    sinceObservedAt: since.toISOString(),
    profilesTracked: 0,
    eventsProcessed: 0,
    intelligenceEventsCreated: 0,
    dormantAwakenings: 0,
    tokenGroupsConsidered: 0,
    signalsCreated: 0,
    buyCandidatesCreated: 0,
    singleWalletGroupsRejected: 0,
    honestEmpty: false,
    durationMs: 0,
    throughputEventsPerSec: 0,
    heapUsedBytes: startHeap,
    heapDeltaBytes: 0,
    retryCount: 0
  };

  try {
    const profiles = await prisma.walletIntelligenceProfile.findMany({
      where: { cluster: { status: 'active' } },
      include: { cluster: true, wallet: true },
      orderBy: [{ monitoringPriority: 'asc' }, { lastObservedAt: 'asc' }, { id: 'asc' }],
      take: maxProfiles
    });
    report.profilesTracked = profiles.length;
    await syncIntelligenceEntities(prisma, { profileIds: profiles.map((profile) => profile.id), now, cause: `lifecycle:${runId}` });
    const memberships = await prisma.intelligenceEntityMembership.findMany({
      where: { profileId: { in: profiles.map((profile) => profile.id) }, status: { not: 'rejected' }, scope: { not: 'infrastructure' }, entity: { status: 'active' } },
      include: { entity: true },
      orderBy: [{ identityConfidence: 'desc' }, { id: 'asc' }]
    });
    const membershipByProfile = new Map(memberships.map((membership) => [membership.profileId, membership]));
    const profileByRef = new Map(profiles.map((profile) => [refKey(profile.chain, profile.address), profile]));
    const events = await loadEvents(prisma, profiles, since, now, maxEvents);
    report.eventsProcessed = events.length;

    const eventRows: Prisma.WalletIntelligenceEventCreateManyInput[] = [];
    const dormantByEvent = new Set<string>();
    const latestActivityByProfile = new Map<string, Date>();
    for (const event of events) {
      const involved = involvedProfiles(event, profileByRef);
      for (const profile of involved) {
        const perspectiveType = activityType(event, profile, profileByRef);
        eventRows.push(activityRow(profile, event, perspectiveType));
        if (event.kind === 'token_buy' && event.relevanceCategory === 'token_deployment') {
          eventRows.push(activityRow(profile, event, 'token_deployment'));
        }
        if (isClusterInteraction(event, profileByRef)) {
          eventRows.push(activityRow(profile, event, 'cluster_interaction'));
        }
        const priorActivity = latestActivityByProfile.get(profile.id) ?? profile.lastActivityAt;
        if (isMeaningful(event) && priorActivity && event.ts > priorActivity && event.ts.getTime() - priorActivity.getTime() >= DORMANT_MS) {
          eventRows.push(activityRow(profile, event, 'Dormant Wallet Awakened', {
            dormantSince: priorActivity.toISOString(),
            dormantDays: Math.floor((event.ts.getTime() - priorActivity.getTime()) / 86_400_000),
            label: 'Dormant Wallet Awakened'
          }));
          dormantByEvent.add(`${event.eventId}:${profile.id}`);
        }
        if (isMeaningful(event) && (!priorActivity || event.ts > priorActivity)) latestActivityByProfile.set(profile.id, event.ts);
      }
    }
    if (eventRows.length) {
      const created = await prisma.walletIntelligenceEvent.createMany({ data: eventRows, skipDuplicates: true });
      report.intelligenceEventsCreated = created.count;
      report.dormantAwakenings = eventRows.filter((row) => row.eventType === 'Dormant Wallet Awakened').length;
    }
    for (const [profileId, lastActivityAt] of latestActivityByProfile) {
      const profile = profiles.find((row) => row.id === profileId)!;
      await prisma.$transaction([
        prisma.walletIntelligenceProfile.update({
          where: { id: profileId },
          data: { lastActivityAt, lastObservedAt: now }
        }),
        prisma.wallet.update({
          where: { id: profile.walletId },
          data: { lastActiveAt: lastActivityAt }
        })
      ]);
      profile.lastActivityAt = lastActivityAt;
    }

    const newBuyGroups = groupBy(events.filter((event) => event.kind === 'token_buy' && event.assetAddress), (event) => `${event.chain}:${event.assetAddress}`);
    report.tokenGroupsConsidered = newBuyGroups.size;
    for (const [tokenKey, newBuys] of newBuyGroups) {
      const [chain, tokenAddress] = splitRef(tokenKey);
      const activationStart = new Date(Math.min(...newBuys.map((event) => event.ts.getTime())) - ACTIVATION_WINDOW_MS);
      const activationEnd = new Date(Math.max(...newBuys.map((event) => event.ts.getTime())));
      const recentBuys = await loadRecentBuys(prisma, chain, tokenAddress, profiles, activationStart, activationEnd);
      const buyerProfiles = uniqueBy(
        recentBuys.map((event) => profileByRef.get(refKey(chain, event.actorAddress ?? event.fromAddress))).filter(nonNull),
        (profile) => profile.id
      );
      if (buyerProfiles.length < 2) {
        // A possible funding->execution sequence may still qualify with one
        // buyer, but only if the funder is another tracked profile.
        const funding = await fundingSequences(prisma, chain, recentBuys, profileByRef);
        if (!funding.length) {
          report.singleWalletGroupsRejected += 1;
          continue;
        }
      }
      const funding = await fundingSequences(prisma, chain, recentBuys, profileByRef);
      const fundingProfiles = uniqueBy(funding.map((row) => row.funder).filter(nonNull), (profile) => profile.id);
      const participants = uniqueBy([...buyerProfiles, ...fundingProfiles], (profile) => profile.id);
      if (participants.length < 2) {
        report.singleWalletGroupsRejected += 1;
        continue;
      }

      const buyersByCluster = groupBy(buyerProfiles, (profile) => profile.cluster.clusterKey);
      const sameCluster = [...buyersByCluster.values()].some((rows) => rows.length >= 2);
      const independentClusters = new Set(buyerProfiles.map((profile) => profile.cluster.clusterKey)).size;
      const executionSequences = funding.filter((row) => row.funder && row.funder.id !== row.buyer.id);
      const dormantBuyers = buyerProfiles.filter((profile) =>
        membershipByProfile.get(profile.id)?.scope === 'core'
        && recentBuys.some((buy) => dormantByEvent.has(`${buy.eventId}:${profile.id}`))
      );
      const dormantFunded = dormantBuyers.filter((profile) => funding.some((row) => row.buyer.id === profile.id && row.funder));
      const patterns = [
        sameCluster ? 'same_cluster_multi_wallet_buy' : null,
        independentClusters >= 2 ? 'independent_alpha_cluster_confluence' : null,
        executionSequences.length ? 'funding_to_execution_buy' : null,
        dormantFunded.length ? 'dormant_cluster_activation' : null
      ].filter(nonNull);
      if (!patterns.length) continue;

      const highAlphaWallets = participants.filter((profile) => profile.historicalAlphaScore >= 60);
      const adaptive = scoreAdaptiveActivation(participants.map((profile) => {
        const membership = membershipByProfile.get(profile.id);
        const buyerFunding = funding.find((row) => row.buyer.id === profile.id && row.funder);
        const funderMembership = buyerFunding?.funder ? membershipByProfile.get(buyerFunding.funder.id) : null;
        return {
          profileId: profile.id,
          entityId: membership?.entityId ?? null,
          clusterKey: profile.cluster.clusterKey,
          capitalRootKey: funderMembership?.entityId ?? buyerFunding?.funder?.cluster.clusterKey ?? membership?.entityId ?? profile.cluster.clusterKey,
          scope: membership?.scope === 'core' ? 'core' : 'peripheral',
          historicalAlphaScore: membership?.entity.historicalAlphaScore ?? profile.historicalAlphaScore,
          evidenceScore: profile.evidenceScore,
          identityConfidence: membership?.identityConfidence ?? profile.confidence,
          // The activation transaction is fresh by definition. Historical
          // membership freshness remains represented inside evidenceQuality.
          evidenceFreshness: 1,
          dormantAwakened: dormantBuyers.some((row) => row.id === profile.id),
          fundingExecution: executionSequences.some((row) => row.buyer.id === profile.id || row.funder?.id === profile.id)
        };
      }));
      if (adaptive.lifecycleStage === 'OBSERVATION') continue;
      const score = adaptive.score;
      const level: IntelligenceSignalLevel = adaptive.lifecycleStage === 'WATCH' ? 'WATCH'
        : adaptive.lifecycleStage === 'STRONG_WATCH' ? 'STRONG_WATCH' : 'HIGH_CONVICTION';
      const allEvents = uniqueBy([...recentBuys, ...funding.map((row) => row.event)], (event) => event.eventId);
      const sourceEventIds = allEvents.map((event) => event.eventId).sort();
      const dedupeKey = hash(`intelligence-signal|${chain}|${tokenAddress}|${patterns.sort().join(',')}|${sourceEventIds.join(',')}|v${INTELLIGENCE_LIFECYCLE_ENGINE_VERSION}`);
      if (await prisma.intelligenceSignal.findUnique({ where: { dedupeKey }, select: { id: true } })) continue;

      const quality = await assessTokenQuality(prisma, { chain, tokenAddress, sourceEventIds, assessedAt: activationEnd });
      const reasons = signalReasons({ sameCluster, independentClusters, executionSequences, dormantFunded, highAlphaWallets, buyerProfiles });
      const clusterKeys = unique(participants.map((profile) => profile.cluster.clusterKey)).sort();
      const entityKeys = unique(participants.map((profile) => profile.entityKey).filter(nonNull)).sort();
      const entityIds = unique(participants.map((profile) => membershipByProfile.get(profile.id)?.entityId).filter(nonNull)).sort();
      const walletAddresses = unique(participants.map((profile) => profile.address)).sort();
      const explanation = `${adaptive.lifecycleStage.replaceAll('_', ' ')}: ${reasons.join(' ')} ${adaptive.independentEntityCount} independent entity confirmation(s), ${adaptive.independentCapitalRootCount} capital root(s), ${adaptive.coreWalletCount} core wallet(s). Token quality ${quality.passed ? `passed (${Math.round(quality.score)}/100)` : `did not pass (${Math.round(quality.score)}/100)`}.`;
      const signal = await prisma.intelligenceSignal.create({
        data: {
          dedupeKey,
          chain,
          tokenAddress,
          signalType: patterns.join('+'),
          level,
          lifecycleStage: adaptive.lifecycleStage,
          score,
          activatedAt: activationEnd,
          clusterKeys,
          entityKeys,
          entityIds,
          walletAddresses,
          sourceEventIds,
          reasons,
          evidenceJson: json({
            patterns,
            buys: recentBuys.map(eventReceipt),
            funding: funding.map((row) => ({ event: eventReceipt(row.event), funderProfileId: row.funder?.id ?? null, buyerProfileId: row.buyer.id })),
            dormantProfileIds: dormantFunded.map((profile) => profile.id),
            independentClusters,
            independentEntities: adaptive.independentEntityCount,
            independentCapitalRoots: adaptive.independentCapitalRootCount,
            singleWalletActivityRejected: false
          }),
          historySupportJson: json({
            participants: participants.map((profile) => ({
              profileId: profile.id,
              address: profile.address,
              clusterKey: profile.cluster.clusterKey,
              role: profile.role,
              evidenceScore: profile.evidenceScore,
              historicalAlphaScore: profile.historicalAlphaScore,
              wakeUpPotential: profile.wakeUpPotential,
              confidence: profile.confidence,
              observationCount: profile.observationCount
            })),
            highAlphaWalletCount: highAlphaWallets.length,
            signalTimeCutoff: activationEnd.toISOString(),
            noLookahead: true
          }),
          scoreDecompositionJson: json(adaptive.decomposition),
          entryMarketJson: json({
            capturedAt: activationEnd.toISOString(), assessedAt: quality.assessedAt.toISOString(),
            liquidityUsd: decimal(quality.liquidityUsd), marketCapUsd: decimal(quality.marketCapUsd),
            holderCount: quality.holderCount, qualityScore: quality.score, coverage: quality.coverage,
            noLookahead: quality.assessedAt <= activationEnd
          }),
          rejectionReceiptJson: quality.passed ? Prisma.JsonNull : json({
            rejectedAt: activationEnd.toISOString(), reasonCodes: quality.reasonCodes,
            coverage: quality.coverage, qualityScore: quality.score, checks: quality.checksJson
          }),
          explanation,
          qualityAssessmentId: quality.id,
          independentEntityCount: adaptive.independentEntityCount,
          independentCapitalRootCount: adaptive.independentCapitalRootCount,
          coreWalletCount: adaptive.coreWalletCount,
          peripheralWalletCount: adaptive.peripheralWalletCount,
          outcomeStatus: 'pending',
          ruleVersion: ADAPTIVE_RULE_VERSION,
          modelVersion: ADAPTIVE_MODEL_VERSION,
          engineVersion: INTELLIGENCE_LIFECYCLE_ENGINE_VERSION
        }
      });
      report.signalsCreated += 1;
      if (entityIds.length) {
        await prisma.intelligenceEntity.updateMany({ where: { id: { in: entityIds } }, data: { signalCount: { increment: 1 }, lastActivityAt: activationEnd } });
        const coreEntityIds = unique(participants.filter((profile) => membershipByProfile.get(profile.id)?.scope === 'core').map((profile) => membershipByProfile.get(profile.id)?.entityId).filter(nonNull));
        if (coreEntityIds.length) await prisma.intelligenceEntity.updateMany({ where: { id: { in: coreEntityIds } }, data: { lastCoreActivityAt: activationEnd, dormantSince: null } });
      }

      // Compatibility bridge for the existing operator watch/Telegram alert
      // dispatcher. Only valid cluster intelligence reaches this table now.
      const historical = await prisma.historicalTokenUniverse.findUnique({ where: { chain_tokenAddress: { chain, tokenAddress } }, select: { id: true } });
      await prisma.trackedTokenActivationAlert.upsert({
        where: { dedupeKey: `intel:${dedupeKey}` },
        create: {
          dedupeKey: `intel:${dedupeKey}`,
          chain,
          tokenAddress,
          alertType: `cluster_intelligence_${level.toLowerCase()}`,
          activatedAt: activationEnd,
          trackedWallets: walletAddresses,
          entityKeys: unique([...entityKeys, ...clusterKeys]),
          trackedWalletCount: walletAddresses.length,
          independentEntityCount: adaptive.independentEntityCount,
          sourceEventIds,
          confidence: score / 100,
          historicalToken: Boolean(historical),
          evidenceJson: json({
            intelligenceSignalId: signal.id, lifecycleStage: adaptive.lifecycleStage, explanation, reasons,
            qualityAssessmentId: quality.id, scoreDecomposition: adaptive.decomposition,
            entityIds, coreWalletCount: adaptive.coreWalletCount, independentCapitalRootCount: adaptive.independentCapitalRootCount
          }),
          caveats: ['cluster activation required; no single-wallet buy can create this alert', 'research-only; no automatic trade execution'],
          status: 'active',
          engineVersion: INTELLIGENCE_LIFECYCLE_ENGINE_VERSION,
          computedAt: now
        },
        update: { status: 'active', computedAt: now }
      });

      if (score >= ADAPTIVE_THRESHOLDS.buyCandidateSignal && level !== 'WATCH' && quality.passed && quality.score >= ADAPTIVE_THRESHOLDS.buyCandidateQuality) {
        const confidence = Math.min(score / 100, quality.score / 100, average(participants.map((profile) => profile.confidence)));
        await prisma.intelligenceBuyCandidate.create({
          data: {
            dedupeKey: hash(`buy-candidate|${signal.id}|${quality.id}`),
            signalId: signal.id,
            qualityAssessmentId: quality.id,
            chain,
            tokenAddress,
            confidence,
            reasonCodes: ['entity_intelligence_pass', 'independent_confirmation_pass', 'token_quality_pass', `signal_stage_${adaptive.lifecycleStage.toLowerCase()}`],
            evidenceJson: json({ signalId: signal.id, signalScore: score, lifecycleStage: adaptive.lifecycleStage, qualityAssessmentId: quality.id, qualityScore: quality.score, scoreDecomposition: adaptive.decomposition, noAutomaticExecution: true })
          }
        });
        report.buyCandidatesCreated += 1;
      }
    }

    report.honestEmpty = report.eventsProcessed === 0 && report.signalsCreated === 0;
    report.durationMs = Math.max(1, Date.now() - startedMs);
    report.heapUsedBytes = process.memoryUsage().heapUsed;
    report.heapDeltaBytes = report.heapUsedBytes - startHeap;
    report.throughputEventsPerSec = Number((report.eventsProcessed / (report.durationMs / 1_000)).toFixed(2));
    await prisma.intelligenceLifecycleRun.update({
      where: { id: runId },
      data: {
        completedAt: new Date(),
        status: report.honestEmpty ? 'empty' : 'completed',
        profilesTracked: report.profilesTracked,
        eventsProcessed: report.eventsProcessed,
        dormantAwakenings: report.dormantAwakenings,
        signalsCreated: report.signalsCreated,
        buyCandidatesCreated: report.buyCandidatesCreated,
        metadataJson: json({
          intelligenceEventsCreated: report.intelligenceEventsCreated,
          tokenGroupsConsidered: report.tokenGroupsConsidered,
          singleWalletGroupsRejected: report.singleWalletGroupsRejected,
          durationMs: report.durationMs,
          throughputEventsPerSec: report.throughputEventsPerSec,
          heapUsedBytes: report.heapUsedBytes,
          heapDeltaBytes: report.heapDeltaBytes,
          retryCount: report.retryCount,
          retryScope: 'database_only_pass_no_provider_retries'
        })
      }
    });
    return report;
  } catch (error) {
    await prisma.intelligenceLifecycleRun.update({
      where: { id: runId },
      data: {
        completedAt: new Date(), status: 'failed', errorCount: 1,
        metadataJson: json({ error: error instanceof Error ? error.message : String(error) })
      }
    });
    throw error;
  }
}

async function loadEvents(prisma: PrismaClient, profiles: Profile[], since: Date, now: Date, take: number) {
  const rows = new Map<string, MassEvent>();
  for (const chain of CHAINS) {
    const addresses = unique(profiles.filter((profile) => profile.chain === chain).map((profile) => profile.address));
    for (const part of chunks(addresses, 2_000)) {
      const remaining = take - rows.size;
      if (remaining <= 0) break;
      const found = await prisma.massTransactionEvent.findMany({
        where: {
          chain,
          status: { not: 'failed' },
          observedAt: { gt: since, lte: now },
          OR: [{ fromAddress: { in: part } }, { toAddress: { in: part } }, { actorAddress: { in: part } }]
        },
        orderBy: [{ observedAt: 'asc' }, { eventId: 'asc' }],
        take: remaining
      });
      for (const event of found) rows.set(event.eventId, event);
    }
  }
  return [...rows.values()].sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime() || a.eventId.localeCompare(b.eventId)).slice(0, take);
}

async function loadRecentBuys(prisma: PrismaClient, chain: ChainId, tokenAddress: string, profiles: Profile[], from: Date, to: Date) {
  const addresses = profiles.filter((profile) => profile.chain === chain).map((profile) => profile.address);
  const rows = new Map<string, MassEvent>();
  for (const part of chunks(unique(addresses), 2_000)) {
    const found = await prisma.massTransactionEvent.findMany({
      where: {
        chain, kind: 'token_buy', assetAddress: tokenAddress, status: { not: 'failed' }, ts: { gte: from, lte: to },
        OR: [{ actorAddress: { in: part } }, { fromAddress: { in: part } }]
      },
      orderBy: [{ ts: 'asc' }, { eventId: 'asc' }], take: 100_000
    });
    for (const event of found) rows.set(event.eventId, event);
  }
  return [...rows.values()].sort((a, b) => a.ts.getTime() - b.ts.getTime() || a.eventId.localeCompare(b.eventId));
}

async function fundingSequences(prisma: PrismaClient, chain: ChainId, buys: MassEvent[], profileByRef: Map<string, Profile>) {
  const buyers = unique(buys.map((buy) => normalizeAddress(chain, buy.actorAddress ?? buy.fromAddress)));
  if (!buyers.length) return [];
  const firstBuy = new Date(Math.min(...buys.map((buy) => buy.ts.getTime())));
  const lastBuy = new Date(Math.max(...buys.map((buy) => buy.ts.getTime())));
  const fundingEvents = await prisma.massTransactionEvent.findMany({
    where: {
      chain,
      toAddress: { in: buyers },
      ts: { gte: new Date(firstBuy.getTime() - ACTIVATION_WINDOW_MS), lt: lastBuy },
      status: { not: 'failed' },
      relevanceCategory: { in: ['capital_transfer', 'gas_funding'] }
    },
    orderBy: [{ ts: 'desc' }, { eventId: 'desc' }], take: 100_000
  });
  const result: Array<{ event: MassEvent; funder: Profile | null; buyer: Profile; buy: MassEvent }> = [];
  for (const buy of buys) {
    const buyerAddress = normalizeAddress(chain, buy.actorAddress ?? buy.fromAddress);
    const buyer = profileByRef.get(refKey(chain, buyerAddress));
    if (!buyer) continue;
    const funding = fundingEvents.find((event) => normalizeAddress(chain, event.toAddress) === buyerAddress && event.ts < buy.ts && buy.ts.getTime() - event.ts.getTime() <= ACTIVATION_WINDOW_MS);
    if (!funding) continue;
    result.push({ event: funding, funder: profileByRef.get(refKey(chain, funding.fromAddress)) ?? null, buyer, buy });
  }
  return uniqueBy(result, (row) => `${row.event.eventId}:${row.buyer.id}`);
}

function activityRow(profile: Profile, event: MassEvent, eventType: string, extra: Record<string, unknown> = {}): Prisma.WalletIntelligenceEventCreateManyInput {
  const actor = normalizeAddress(event.chain, event.actorAddress ?? event.fromAddress);
  const wallet = normalizeAddress(profile.chain, profile.address);
  const counterparty = wallet === normalizeAddress(event.chain, event.fromAddress) ? event.toAddress : event.fromAddress;
  return {
    eventKey: hash(`wallet-event|${event.eventId}|${profile.id}|${eventType}`),
    profileId: profile.id,
    clusterKey: profile.cluster.clusterKey,
    chain: event.chain,
    walletAddress: profile.address,
    eventType,
    sourceEventId: event.eventId,
    txHash: event.txHash,
    counterpartyAddress: counterparty,
    tokenAddress: event.assetAddress,
    amountUsd: event.amountUsd,
    occurredAt: event.ts,
    evidenceJson: json({
      kind: event.kind,
      relevanceCategory: event.relevanceCategory,
      relevanceScore: event.relevanceScore,
      reasonCodes: event.reasonCodes,
      actor,
      safeEntityLink: event.safeEntityLink,
      bridgeProtocol: event.bridgeProtocol,
      officialMessageId: event.officialMessageId,
      ...extra
    })
  };
}

function activityType(event: MassEvent, profile: Profile, profileByRef: Map<string, Profile>) {
  if (event.kind === 'token_buy') return 'token_buy';
  if (event.kind === 'token_sell') return 'token_sell';
  if (event.kind === 'bridge_source') return 'bridge_source';
  if (event.kind === 'bridge_destination') return 'bridge_destination';
  if (event.kind === 'lp_add') return 'lp_add';
  if (event.kind === 'lp_remove') return 'lp_remove';
  if (event.kind === 'contract_interaction') return 'execution_behavior';
  if (event.relevanceCategory === 'capital_transfer' || event.relevanceCategory === 'gas_funding') {
    return normalizeAddress(event.chain, event.toAddress) === normalizeAddress(profile.chain, profile.address) ? 'funding_received' : 'funding_sent';
  }
  return event.kind;
}

function isClusterInteraction(event: MassEvent, profileByRef: Map<string, Profile>) {
  const source = profileByRef.get(refKey(event.chain, event.fromAddress));
  const destination = profileByRef.get(refKey(event.chain, event.toAddress));
  return Boolean(source && destination && source.id !== destination.id && source.clusterId === destination.clusterId);
}

function involvedProfiles(event: MassEvent, profileByRef: Map<string, Profile>) {
  return uniqueBy(
    [event.fromAddress, event.toAddress, event.actorAddress].filter(nonNull).map((address) => profileByRef.get(refKey(event.chain, address))).filter(nonNull),
    (profile) => profile.id
  );
}
function isMeaningful(event: MassEvent) { return !['failed', 'self_transfer', 'infrastructure_noise', 'contract_noise', 'dust', 'unrelated'].includes(event.relevanceCategory); }

function clusterSignalScore(input: {
  sameCluster: boolean;
  independentClusters: number;
  executionSequences: number;
  dormantFunded: number;
  highAlphaWallets: number;
  participants: Profile[];
}) {
  let score = 0;
  if (input.sameCluster) score += 45;
  if (input.independentClusters >= 2) score += Math.min(55, 48 + (input.independentClusters - 2) * 4);
  if (input.executionSequences) score += Math.min(50, 42 + (input.executionSequences - 1) * 4);
  if (input.dormantFunded) score += Math.min(25, 18 + (input.dormantFunded - 1) * 4);
  if (input.highAlphaWallets >= 2) score += Math.min(18, 12 + (input.highAlphaWallets - 2) * 3);
  score += average(input.participants.map((profile) => profile.evidenceScore)) * 0.12;
  score += average(input.participants.map((profile) => profile.historicalAlphaScore)) * 0.12;
  score += average(input.participants.map((profile) => profile.confidence)) * 8;
  return Math.round(Math.min(100, score));
}

export function intelligenceSignalLevelForScore(score: number): IntelligenceSignalLevel {
  if (score >= 85) return 'HIGH_CONVICTION';
  if (score >= 70) return 'STRONG_WATCH';
  return 'WATCH';
}

function signalReasons(input: {
  sameCluster: boolean;
  independentClusters: number;
  executionSequences: Array<{ event: MassEvent; funder: Profile | null; buyer: Profile; buy: MassEvent }>;
  dormantFunded: Profile[];
  highAlphaWallets: Profile[];
  buyerProfiles: Profile[];
}) {
  return [
    input.sameCluster ? `${input.buyerProfiles.length} wallets from the same persistent cluster bought the token.` : null,
    input.independentClusters >= 2 ? `${input.independentClusters} independent intelligence clusters reacted in the same activation window.` : null,
    input.executionSequences.length ? `${input.executionSequences.length} tracked funding→execution→buy sequence(s) were receipt-linked.` : null,
    input.dormantFunded.length ? `${input.dormantFunded.length} dormant wallet(s) awakened after tracked funding and bought.` : null,
    input.highAlphaWallets.length >= 2 ? `${input.highAlphaWallets.length} historically strong wallets participated together.` : null
  ].filter(nonNull);
}

function eventReceipt(event: MassEvent) {
  return { eventId: event.eventId, txHash: event.txHash, ts: event.ts.toISOString(), kind: event.kind, from: event.fromAddress, to: event.toAddress, actor: event.actorAddress, amountUsd: decimal(event.amountUsd) };
}
function refKey(chain: ChainId, address: string) { return `${chain}:${normalizeAddress(chain, address)}`; }
function splitRef(value: string): [ChainId, string] { const index = value.indexOf(':'); return [value.slice(0, index) as ChainId, value.slice(index + 1)]; }
function groupBy<T>(rows: T[], key: (row: T) => string) { const result = new Map<string, T[]>(); for (const row of rows) result.set(key(row), [...(result.get(key(row)) ?? []), row]); return result; }
function unique<T>(values: T[]) { return [...new Set(values)]; }
function uniqueBy<T>(values: T[], key: (value: T) => string) { return [...new Map(values.map((value) => [key(value), value])).values()]; }
function chunks<T>(rows: T[], size: number) { const result: T[][] = []; for (let index = 0; index < rows.length; index += size) result.push(rows.slice(index, index + size)); return result; }
function clampInt(value: number, min: number, max: number) { return Math.max(min, Math.min(max, Math.trunc(value))); }
function average(values: number[]) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }
function decimal(value: unknown) { if (value === null || value === undefined) return null; const number = Number(value); return Number.isFinite(number) ? number : null; }
function hash(value: string) { return createHash('sha256').update(value).digest('hex'); }
function nonNull<T>(value: T | null | undefined): value is T { return value !== null && value !== undefined; }
function json(value: unknown): Prisma.InputJsonValue { return value as Prisma.InputJsonValue; }
