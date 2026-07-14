import { createHash } from 'node:crypto';
import type { MassTransactionEvent } from '@prisma/client';
import { prisma, runIntelligenceOutcomePass } from '@flowradar/db';

const horizons = [5, 15, 60, 360, 1_440, 4_320, 10_080, 43_200] as const;
const requestedEventId = process.env.ADAPTIVE_REPLAY_EVENT_ID?.trim();
const now = new Date();

try {
  const events = await prisma.massTransactionEvent.findMany({
    where: {
      kind: 'token_buy', status: { not: 'failed' }, assetAddress: { not: null },
      ...(requestedEventId ? { eventId: requestedEventId } : {})
    },
    orderBy: [{ ts: 'desc' }, { eventId: 'asc' }],
    take: requestedEventId ? 1 : 2_000
  });

  let selected: Awaited<ReturnType<typeof selectReplaySource>> = null;
  for (const event of events) {
    selected = await selectReplaySource(event);
    if (selected) break;
  }
  if (!selected) throw new Error('No real persisted buy has a non-synthetic, horizon-complete market snapshot window');

  const { event, entry, snapshots, fullHorizonMinutes } = selected;
  const dedupeKey = createHash('sha256').update(`controlled-real-outcome-replay|${event.eventId}|v1`).digest('hex');
  const signal = await prisma.intelligenceSignal.upsert({
    where: { dedupeKey },
    create: {
      dedupeKey, chain: event.chain, tokenAddress: event.assetAddress!, signalType: 'controlled_real_data_outcome_replay',
      level: 'WATCH', lifecycleStage: 'OBSERVATION', score: 0, status: 'controlled_replay', activatedAt: event.ts,
      clusterKeys: [], entityKeys: [], entityIds: [], walletAddresses: [], sourceEventIds: [event.eventId],
      reasons: ['Controlled outcome-evaluator replay over a real persisted buy and non-synthetic market snapshots.'],
      evidenceJson: {
        controlledReplay: true, excludedFromProductionSignals: true, excludedFromPerformanceMetrics: true,
        sourceEvent: { eventId: event.eventId, txHash: event.txHash, ts: event.ts.toISOString(), provider: event.provider },
        entityKnowledgeAsOfEvent: 'not_available; entity signal generation is intentionally not claimed'
      },
      historySupportJson: { controlledReplay: true, noEntityConfluenceClaim: true },
      scoreDecompositionJson: { verification: { raw: 0, weight: 0, contribution: 0, explanation: 'Outcome evaluator transport only.' } },
      entryMarketJson: {
        controlledReplay: true, snapshotId: entry.id, capturedAt: event.ts.toISOString(), entrySnapshotTs: entry.ts.toISOString(),
        source: entry.source, nonSynthetic: true, noLookahead: entry.ts <= event.ts
      },
      rejectionReceiptJson: { controlledReplay: true, reason: 'not_eligible_for_signal_or_buy_candidate' },
      explanation: 'CONTROLLED REAL-DATA OUTCOME REPLAY — not a production signal or recommendation.',
      independentEntityCount: 0, independentCapitalRootCount: 0, coreWalletCount: 0, peripheralWalletCount: 0,
      outcomeStatus: 'pending', ruleVersion: 1, modelVersion: 1, engineVersion: 2
    },
    update: {
      activatedAt: event.ts,
      entryMarketJson: {
        controlledReplay: true, snapshotId: entry.id, capturedAt: event.ts.toISOString(), entrySnapshotTs: entry.ts.toISOString(),
        source: entry.source, nonSynthetic: true, noLookahead: entry.ts <= event.ts
      }
    }
  });

  const pass = await runIntelligenceOutcomePass(prisma, { now, signalIds: [signal.id] });
  const [outcomes, label] = await Promise.all([
    prisma.intelligenceSignalOutcome.findMany({ where: { signalId: signal.id }, orderBy: { targetAt: 'asc' } }),
    prisma.intelligenceSignalOutcomeLabel.findUnique({ where: { signalId: signal.id } })
  ]);
  console.log(JSON.stringify({
    status: 'controlled_real_data_replay_completed', analyticsExcluded: signal.status === 'controlled_replay',
    signalId: signal.id, sourceEventId: event.eventId, chain: event.chain, tokenAddress: event.assetAddress,
    eventTs: event.ts.toISOString(), entrySnapshotId: entry.id, entrySnapshotTs: entry.ts.toISOString(),
    persistedSnapshotCount: snapshots.length, fullHorizonMinutes, pass,
    label: label ? { value: label.label, basisHorizon: label.basisHorizon, receiptId: label.id } : null,
    outcomes: outcomes.map((row) => ({ id: row.id, horizon: row.horizon, status: row.status, coverage: row.coverage, realizedReturnPct: row.realizedReturnPct, maxDrawdownPct: row.maxDrawdownPct, sourceSnapshotCount: row.sourceSnapshotIds.length }))
  }, null, 2));
} finally {
  await prisma.$disconnect();
}

async function selectReplaySource(event: MassTransactionEvent) {
  if (!event.assetAddress) return null;
  const token = await prisma.token.findUnique({ where: { chain_address: { chain: event.chain, address: event.assetAddress } } });
  if (!token) return null;
  const entry = await prisma.tokenMarketSnapshot.findFirst({
    where: { tokenId: token.id, ts: { lte: event.ts }, source: { not: { contains: 'synthetic' } } },
    orderBy: [{ ts: 'desc' }, { id: 'desc' }]
  });
  if (!entry) return null;
  const snapshots = await prisma.tokenMarketSnapshot.findMany({
    where: { tokenId: token.id, ts: { gt: event.ts, lte: now }, source: { not: { contains: 'synthetic' } } },
    orderBy: [{ ts: 'asc' }, { id: 'asc' }]
  });
  const fullHorizonMinutes = horizons.findLast((minutes) => {
    const target = new Date(event.ts.getTime() + minutes * 60_000);
    if (now < target) return false;
    const inWindow = snapshots.filter((row) => row.ts <= target);
    const toleranceMinutes = Math.max(2, Math.min(60, minutes * 0.1));
    return inWindow.length >= 2 && target.getTime() - inWindow.at(-1)!.ts.getTime() <= toleranceMinutes * 60_000;
  });
  return fullHorizonMinutes ? { event, entry, snapshots, fullHorizonMinutes } : null;
}
