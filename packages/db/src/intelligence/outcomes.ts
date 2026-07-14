import { createHash, randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import {
  ADAPTIVE_MODEL_VERSION, ADAPTIVE_RULE_VERSION, ADAPTIVE_THRESHOLDS, ADAPTIVE_WEIGHTS,
  OUTCOME_EVALUATOR_VERSION, calibrateHistoricalAlpha, deterministicOutcomeLabel
} from './adaptive';

export const INTELLIGENCE_OUTCOME_HORIZONS = [
  ['5m', 5], ['15m', 15], ['1h', 60], ['6h', 360], ['24h', 1_440],
  ['3d', 4_320], ['7d', 10_080], ['30d', 43_200]
] as const;

export interface OutcomePassReport {
  signalsScanned: number;
  horizonsUpserted: number;
  completeHorizons: number;
  insufficientHorizons: number;
  labelsUpdated: number;
  entitiesRecalibrated: number;
  durationMs: number;
  throughputHorizonsPerSec: number;
  heapUsedBytes: number;
}

/** Evaluates every due horizon strictly inside [signal time, horizon target].
 * Missing points are persisted as insufficient rather than silently imputed. */
export async function runIntelligenceOutcomePass(
  prisma: PrismaClient,
  options: { now?: Date; signalIds?: string[]; take?: number } = {}
): Promise<OutcomePassReport> {
  const now = options.now ?? new Date();
  const startedMs = Date.now();
  const signals = await prisma.intelligenceSignal.findMany({
    where: { status: 'active', ...(options.signalIds?.length ? { id: { in: options.signalIds } } : {}) },
    orderBy: [{ activatedAt: 'asc' }, { id: 'asc' }],
    take: Math.max(1, Math.min(options.take ?? 10_000, 100_000))
  });
  const report: OutcomePassReport = { signalsScanned: signals.length, horizonsUpserted: 0, completeHorizons: 0, insufficientHorizons: 0, labelsUpdated: 0, entitiesRecalibrated: 0, durationMs: 0, throughputHorizonsPerSec: 0, heapUsedBytes: process.memoryUsage().heapUsed };
  const touchedEntities = new Set<string>();
  for (const signal of signals) {
    const token = await prisma.token.findUnique({ where: { chain_address: { chain: signal.chain, address: signal.tokenAddress } }, select: { id: true } });
    const entry = token ? await prisma.tokenMarketSnapshot.findFirst({ where: { tokenId: token.id, ts: { lte: signal.activatedAt } }, orderBy: [{ ts: 'desc' }, { id: 'desc' }] }) : null;
    const outcomes = [];
    for (const [horizon, minutes] of INTELLIGENCE_OUTCOME_HORIZONS) {
      const targetAt = new Date(signal.activatedAt.getTime() + minutes * 60_000);
      const until = new Date(Math.min(targetAt.getTime(), now.getTime()));
      const snapshots = token ? await prisma.tokenMarketSnapshot.findMany({
        where: { tokenId: token.id, ts: { gt: signal.activatedAt, lte: until } },
        orderBy: [{ ts: 'asc' }, { id: 'asc' }]
      }) : [];
      const complete = now >= targetAt;
      const coverage = !entry || snapshots.length === 0 ? 'insufficient' : snapshots.length >= 2 ? 'full' : 'partial';
      const evaluated = evaluateHorizon(entry, snapshots, signal.activatedAt, targetAt, complete, coverage);
      const lpRemove = await prisma.massTransactionEvent.findFirst({
        where: { chain: signal.chain, assetAddress: signal.tokenAddress, kind: 'lp_remove', ts: { gte: signal.activatedAt, lte: until }, status: { not: 'failed' } },
        orderBy: [{ ts: 'asc' }, { eventId: 'asc' }], select: { eventId: true, txHash: true, ts: true, amountUsd: true }
      });
      const rugPullDetected = Boolean(complete && coverage !== 'insufficient' && ((evaluated.realizedReturnPct ?? 0) <= -90 || (evaluated.liquidityRetentionPct ?? 100) <= 10 || lpRemove));
      const row = await prisma.intelligenceSignalOutcome.upsert({
        where: { signalId_horizon: { signalId: signal.id, horizon } },
        create: {
          signalId: signal.id, horizon, targetAt, evaluatedAt: now,
          status: complete ? 'complete' : 'pending', coverage,
          entryPriceUsd: entry?.priceUsd ?? null, referencePriceUsd: snapshots.at(-1)?.priceUsd ?? null,
          entryMarketCapUsd: entry?.marketCapUsd ?? null, referenceMarketCapUsd: snapshots.at(-1)?.marketCapUsd ?? null,
          realizedReturnPct: evaluated.realizedReturnPct, maxReturnPct: evaluated.maxReturnPct,
          maxDrawdownPct: evaluated.maxDrawdownPct, timeToPeakMinutes: evaluated.timeToPeakMinutes,
          liquidityRetentionPct: evaluated.liquidityRetentionPct,
          volumeContinuation: evaluated.volumeContinuation, holderContinuation: evaluated.holderContinuation,
          rugPullDetected, tradingHalted: evaluated.tradingHalted, lpRemoved: Boolean(lpRemove),
          survivalStatus: rugPullDetected ? 'failed' : complete && coverage !== 'insufficient' ? 'survived' : 'unknown',
          earlyLateLabel: evaluated.earlyLateLabel, sourceSnapshotIds: [entry?.id, ...snapshots.map((row) => row.id)].filter(nonNull),
          receiptJson: json({
            noLookahead: true, window: { from: signal.activatedAt.toISOString(), to: targetAt.toISOString(), evaluatedUntil: until.toISOString() },
            entrySnapshotTs: entry?.ts.toISOString() ?? null, snapshotCount: snapshots.length,
            snapshotRange: snapshots.length ? [snapshots[0]!.ts.toISOString(), snapshots.at(-1)!.ts.toISOString()] : [],
            lpRemoval: lpRemove ? { eventId: lpRemove.eventId, txHash: lpRemove.txHash, ts: lpRemove.ts.toISOString(), amountUsd: decimal(lpRemove.amountUsd) } : null,
            providerSources: unique([entry?.source, ...snapshots.map((row) => row.source)].filter(nonNull)),
            evaluatorVersion: OUTCOME_EVALUATOR_VERSION
          }),
          evaluatorVersion: OUTCOME_EVALUATOR_VERSION
        },
        update: {
          targetAt, evaluatedAt: now, status: complete ? 'complete' : 'pending', coverage,
          entryPriceUsd: entry?.priceUsd ?? null, referencePriceUsd: snapshots.at(-1)?.priceUsd ?? null,
          entryMarketCapUsd: entry?.marketCapUsd ?? null, referenceMarketCapUsd: snapshots.at(-1)?.marketCapUsd ?? null,
          realizedReturnPct: evaluated.realizedReturnPct, maxReturnPct: evaluated.maxReturnPct,
          maxDrawdownPct: evaluated.maxDrawdownPct, timeToPeakMinutes: evaluated.timeToPeakMinutes,
          liquidityRetentionPct: evaluated.liquidityRetentionPct,
          volumeContinuation: evaluated.volumeContinuation, holderContinuation: evaluated.holderContinuation,
          rugPullDetected, tradingHalted: evaluated.tradingHalted, lpRemoved: Boolean(lpRemove),
          survivalStatus: rugPullDetected ? 'failed' : complete && coverage !== 'insufficient' ? 'survived' : 'unknown',
          earlyLateLabel: evaluated.earlyLateLabel, sourceSnapshotIds: [entry?.id, ...snapshots.map((row) => row.id)].filter(nonNull),
          receiptJson: json({
            noLookahead: true, window: { from: signal.activatedAt.toISOString(), to: targetAt.toISOString(), evaluatedUntil: until.toISOString() },
            entrySnapshotTs: entry?.ts.toISOString() ?? null, snapshotCount: snapshots.length,
            snapshotRange: snapshots.length ? [snapshots[0]!.ts.toISOString(), snapshots.at(-1)!.ts.toISOString()] : [],
            lpRemoval: lpRemove ? { eventId: lpRemove.eventId, txHash: lpRemove.txHash, ts: lpRemove.ts.toISOString(), amountUsd: decimal(lpRemove.amountUsd) } : null,
            providerSources: unique([entry?.source, ...snapshots.map((row) => row.source)].filter(nonNull)),
            evaluatorVersion: OUTCOME_EVALUATOR_VERSION
          }), evaluatorVersion: OUTCOME_EVALUATOR_VERSION
        }
      });
      outcomes.push(row);
      report.horizonsUpserted += 1;
      if (complete) report.completeHorizons += 1;
      if (coverage === 'insufficient') report.insufficientHorizons += 1;
    }
    const basis = [...outcomes].filter((row) => row.status === 'complete').sort((a, b) => b.targetAt.getTime() - a.targetAt.getTime())[0]
      ?? outcomes.find((row) => row.coverage !== 'insufficient') ?? outcomes[0];
    if (basis) {
      const label = deterministicOutcomeLabel({
        maxReturnPct: basis.maxReturnPct, realizedReturnPct: basis.realizedReturnPct,
        maxDrawdownPct: basis.maxDrawdownPct, rugPullDetected: basis.rugPullDetected,
        tradingHalted: basis.tradingHalted, liquidityRetentionPct: basis.liquidityRetentionPct,
        coverage: basis.coverage
      });
      await prisma.intelligenceSignalOutcomeLabel.upsert({
        where: { signalId: signal.id },
        create: {
          signalId: signal.id, label, basisHorizon: basis.horizon,
          rationale: outcomeRationale(label, basis), metricsJson: json(outcomeMetrics(basis)),
          labelVersion: OUTCOME_EVALUATOR_VERSION, computedAt: now
        },
        update: {
          label, basisHorizon: basis.horizon, rationale: outcomeRationale(label, basis),
          metricsJson: json(outcomeMetrics(basis)), labelVersion: OUTCOME_EVALUATOR_VERSION, computedAt: now
        }
      });
      await prisma.intelligenceSignal.update({ where: { id: signal.id }, data: { outcomeStatus: label === 'insufficient_data' ? 'insufficient' : 'evaluated' } });
      report.labelsUpdated += 1;
      signal.entityIds.forEach((id) => touchedEntities.add(id));
    }
  }
  for (const entityId of touchedEntities) {
    if (await recalibrateEntityAlpha(prisma, entityId, now)) report.entitiesRecalibrated += 1;
  }
  report.durationMs = Math.max(1, Date.now() - startedMs);
  report.throughputHorizonsPerSec = Number((report.horizonsUpserted / (report.durationMs / 1_000)).toFixed(2));
  report.heapUsedBytes = process.memoryUsage().heapUsed;
  return report;
}

function evaluateHorizon(
  entry: { priceUsd: unknown; marketCapUsd: unknown; liquidityUsd: unknown; vol24h: unknown; holderCount: number; ts: Date } | null,
  snapshots: Array<{ priceUsd: unknown; marketCapUsd: unknown; liquidityUsd: unknown; vol24h: unknown; holderCount: number; ts: Date }>,
  activatedAt: Date,
  targetAt: Date,
  complete: boolean,
  coverage: string
) {
  if (!entry || !snapshots.length) return {
    realizedReturnPct: null, maxReturnPct: null, maxDrawdownPct: null, timeToPeakMinutes: null,
    liquidityRetentionPct: null, volumeContinuation: 'unknown', holderContinuation: 'unknown',
    tradingHalted: false, earlyLateLabel: 'unknown'
  };
  const entryBasis = positive(decimal(entry.priceUsd)) ?? positive(decimal(entry.marketCapUsd));
  const values = snapshots.map((row) => positive(decimal(row.priceUsd)) ?? positive(decimal(row.marketCapUsd))).filter(finiteNumber);
  if (!entryBasis || !values.length) return {
    realizedReturnPct: null, maxReturnPct: null, maxDrawdownPct: null, timeToPeakMinutes: null,
    liquidityRetentionPct: ratioPct(decimal(snapshots.at(-1)!.liquidityUsd), decimal(entry.liquidityUsd)),
    volumeContinuation: 'unknown', holderContinuation: holderLabel(entry.holderCount, snapshots.at(-1)!.holderCount),
    tradingHalted: false, earlyLateLabel: 'unknown'
  };
  const returns = values.map((value) => (value / entryBasis - 1) * 100);
  const maxReturnPct = Math.max(...returns);
  const peakIndex = returns.indexOf(maxReturnPct);
  const maxDrawdownPct = Math.min(...returns);
  const last = snapshots.at(-1)!;
  const liquidityRetentionPct = ratioPct(decimal(last.liquidityUsd), decimal(entry.liquidityUsd));
  const entryVolume = decimal(entry.vol24h);
  const lastVolume = decimal(last.vol24h);
  const tradingHalted = Boolean(complete && coverage === 'full' && lastVolume === 0 && decimal(last.liquidityUsd) === 0);
  const firstPositive = returns.findIndex((value) => value >= 25);
  const windowMinutes = (targetAt.getTime() - activatedAt.getTime()) / 60_000;
  const firstPositiveMinutes = firstPositive >= 0 ? (snapshots[firstPositive]!.ts.getTime() - activatedAt.getTime()) / 60_000 : null;
  return {
    realizedReturnPct: round(returns.at(-1)!, 3), maxReturnPct: round(maxReturnPct, 3), maxDrawdownPct: round(maxDrawdownPct, 3),
    timeToPeakMinutes: Math.max(0, Math.round((snapshots[peakIndex]!.ts.getTime() - activatedAt.getTime()) / 60_000)),
    liquidityRetentionPct, volumeContinuation: volumeLabel(entryVolume, lastVolume),
    holderContinuation: holderLabel(entry.holderCount, last.holderCount), tradingHalted,
    earlyLateLabel: firstPositiveMinutes === null ? 'not_confirmed' : firstPositiveMinutes <= windowMinutes * 0.25 ? 'early' : 'late'
  };
}

async function recalibrateEntityAlpha(prisma: PrismaClient, entityId: string, now: Date) {
  const entity = await prisma.intelligenceEntity.findUnique({ where: { id: entityId } });
  if (!entity) return false;
  const signals = await prisma.intelligenceSignal.findMany({
    where: { entityIds: { has: entityId } },
    include: { outcomes: { where: { status: 'complete' }, orderBy: { targetAt: 'desc' }, take: 1 }, outcomeLabel: true },
    orderBy: { activatedAt: 'asc' }
  });
  const calibrated = calibrateHistoricalAlpha(signals.flatMap((signal) => signal.outcomes.map((outcome) => ({
    returnPct: outcome.realizedReturnPct, peakReturnPct: outcome.maxReturnPct, drawdownPct: outcome.maxDrawdownPct,
    realized: true, rugPull: outcome.rugPullDetected, capitalUsd: marketValue(signal.entryMarketJson, 'liquidityUsd')
  }))));
  if (!calibrated.sampleSize) return false;
  const nextVersion = entity.currentVersion + 1;
  await prisma.$transaction([
    prisma.intelligenceEntity.update({ where: { id: entity.id }, data: {
      historicalAlphaScore: calibrated.score, historicalAlphaConfidence: calibrated.sampleConfidence,
      outcomeCount: calibrated.sampleSize, currentVersion: nextVersion,
      provenanceJson: json({ ...(asRecord(entity.provenanceJson)), alphaCalibration: calibrated, alphaUpdatedAt: now.toISOString() })
    }}),
    prisma.intelligenceEntityVersion.create({ data: {
      entityId: entity.id, version: nextVersion, cause: 'outcome_recalibration',
      identityConfidence: entity.identityConfidence, currentRelevance: entity.currentRelevance,
      historicalAlphaScore: calibrated.score, historicalAlphaConfidence: calibrated.sampleConfidence,
      wakeUpPotential: entity.wakeUpPotential, evidenceFreshness: entity.evidenceFreshness,
      coreWalletRefs: [], peripheralWalletRefs: [], evidenceJson: json({ calibrated, signalIds: signals.map((row) => row.id) }),
      provenanceJson: json({ noLookahead: true, evaluatedAt: now.toISOString() }), ruleVersion: ADAPTIVE_RULE_VERSION, observedAt: now
    }})
  ]);
  return true;
}

export interface AdaptivePerformanceMetrics {
  signals: number;
  evaluated: number;
  insufficient: number;
  wins: number;
  failures: number;
  precision: number | null;
  falsePositiveRate: number | null;
  averageReturnPct: number | null;
  medianReturnPct: number | null;
  maxDrawdownPct: number | null;
  byStage: Record<string, { signals: number; evaluated: number; wins: number; precision: number | null }>;
  byScoreBucket: Record<string, { signals: number; evaluated: number; wins: number; precision: number | null }>;
  labelCounts: Record<string, number>;
}

export async function loadAdaptivePerformanceMetrics(prisma: PrismaClient): Promise<AdaptivePerformanceMetrics & { funnel: Record<string, number>; entityHealth: Record<string, number>; feedback: Record<string, unknown>; analysisSlices: Record<string, unknown> }> {
  const [signals, entities, memberships, events, candidates, proposals] = await Promise.all([
    prisma.intelligenceSignal.findMany({ where: { status: 'active' }, include: { outcomeLabel: true, outcomes: { where: { status: 'complete' }, orderBy: { targetAt: 'desc' }, take: 1 } }, orderBy: { activatedAt: 'asc' } }),
    prisma.intelligenceEntity.findMany(), prisma.intelligenceEntityMembership.findMany(),
    prisma.walletIntelligenceEvent.count(), prisma.intelligenceBuyCandidate.count(),
    prisma.intelligenceWeightProposal.findMany({ orderBy: { createdAt: 'desc' }, take: 5 })
  ]);
  const metrics = performanceMetrics(signals.map(toMetricRow));
  return {
    ...metrics,
    funnel: {
      observations: events, watch: signals.filter((row) => row.lifecycleStage === 'WATCH').length,
      strongWatch: signals.filter((row) => row.lifecycleStage === 'STRONG_WATCH').length,
      highConviction: signals.filter((row) => row.lifecycleStage === 'HIGH_CONVICTION').length,
      exceptional: signals.filter((row) => row.lifecycleStage === 'EXCEPTIONAL').length,
      buyCandidates: candidates
    },
    entityHealth: {
      active: entities.filter((row) => row.status === 'active').length,
      dormant: entities.filter((row) => row.dormantSince).length,
      coreMemberships: memberships.filter((row) => row.scope === 'core' && row.status !== 'rejected').length,
      peripheralMemberships: memberships.filter((row) => row.scope === 'peripheral' && row.status !== 'rejected').length,
      infrastructureRejected: memberships.filter((row) => row.scope === 'infrastructure' || row.status === 'rejected').length,
      staleMemberships: memberships.filter((row) => row.status === 'stale').length
    },
    feedback: {
      productionModelVersion: ADAPTIVE_MODEL_VERSION,
      automaticWeightChanges: false,
      recentProposals: proposals.map((row) => ({ id: row.id, status: row.status, sampleSize: row.sampleSize, precisionDelta: row.precisionDelta, falsePositiveDelta: row.falsePositiveDelta }))
    },
    analysisSlices: {
      byPattern: Object.fromEntries([...groupBy(signals, (row) => row.signalType)].map(([pattern, rows]) => [pattern, performanceMetrics(rows.map(toMetricRow))])),
      dormantAwakening: performanceMetrics(signals.filter((row) => row.signalType.includes('dormant')).map(toMetricRow)),
      crossChain: performanceMetrics(signals.filter((row) => /bridge|cross.?chain/i.test(row.signalType)).map(toMetricRow)),
      earlyConfirmations: signals.filter((row) => row.outcomes[0]?.earlyLateLabel === 'early').length,
      lateConfirmations: signals.filter((row) => row.outcomes[0]?.earlyLateLabel === 'late').length
    }
  };
}

export async function runAdaptiveReplay(prisma: PrismaClient, now = new Date()) {
  const runId = randomUUID();
  await prisma.intelligenceReplayRun.create({ data: {
    id: runId, status: 'running', modelVersion: ADAPTIVE_MODEL_VERSION, ruleVersion: ADAPTIVE_RULE_VERSION,
    metricsJson: json({}), dataQualityJson: json({}), startedAt: now
  }});
  try {
    const signals = await prisma.intelligenceSignal.findMany({ where: { status: 'active' }, include: { outcomeLabel: true, outcomes: { where: { status: 'complete' }, orderBy: { targetAt: 'desc' }, take: 1 } }, orderBy: [{ activatedAt: 'asc' }, { id: 'asc' }] });
    const evaluated = signals.filter((signal) => signal.outcomeLabel && signal.outcomeLabel.label !== 'insufficient_data');
    const split = chronologicalSplit(evaluated);
    const noLookaheadViolations = signals.reduce((sum, signal) => sum + signal.outcomes.filter((outcome) => {
      const receipt = asRecord(outcome.receiptJson);
      const entryTs = typeof receipt.entrySnapshotTs === 'string' ? new Date(receipt.entrySnapshotTs) : null;
      const window = asRecord(receipt.window);
      const evaluatedUntil = typeof window.evaluatedUntil === 'string' ? new Date(window.evaluatedUntil) : null;
      return (entryTs !== null && entryTs > signal.activatedAt) || (evaluatedUntil !== null && evaluatedUntil > outcome.targetAt);
    }).length, 0);
    const metrics = {
      training: performanceMetrics(toMetricRows(split.training)),
      validation: performanceMetrics(toMetricRows(split.validation)),
      holdout: performanceMetrics(toMetricRows(split.holdout)),
      all: performanceMetrics(toMetricRows(evaluated)),
      thresholds: ADAPTIVE_THRESHOLDS,
      weights: ADAPTIVE_WEIGHTS
    };
    const windows = splitWindows(split);
    await prisma.intelligenceReplayRun.update({ where: { id: runId }, data: {
      status: 'completed', ...windows, signalsConsidered: signals.length, signalsEvaluated: evaluated.length,
      noLookaheadViolations, metricsJson: json(metrics),
      dataQualityJson: json({
        insufficientLabels: signals.filter((row) => row.outcomeLabel?.label === 'insufficient_data').length,
        unlabeledSignals: signals.filter((row) => !row.outcomeLabel).length,
        source: 'persisted_intelligence_signal_receipts_and_market_snapshots', syntheticAccepted: false
      }), completedAt: new Date()
    }});
    const proposal = await proposeWeightAdjustment(prisma, evaluated, metrics, now);
    return { runId, signalsConsidered: signals.length, signalsEvaluated: evaluated.length, noLookaheadViolations, metrics, proposal };
  } catch (error) {
    await prisma.intelligenceReplayRun.update({ where: { id: runId }, data: {
      status: 'failed', completedAt: new Date(), dataQualityJson: json({ error: error instanceof Error ? error.message : String(error) })
    }});
    throw error;
  }
}

type FeedbackSignal = {
  id: string;
  activatedAt: Date;
  scoreDecompositionJson: Prisma.JsonValue;
  outcomeLabel: { label: string } | null;
  score: number;
  lifecycleStage: string;
  outcomes: Array<{ realizedReturnPct: number | null; maxDrawdownPct: number | null }>;
};

async function proposeWeightAdjustment(prisma: PrismaClient, signals: FeedbackSignal[], metrics: Record<string, unknown>, now: Date) {
  if (signals.length < ADAPTIVE_THRESHOLDS.minimumFeedbackSample) return { status: 'insufficient_sample', sampleSize: signals.length, minimum: ADAPTIVE_THRESHOLDS.minimumFeedbackSample };
  const rows = signals;
  const winners = rows.filter((row) => outcomeWin(row.outcomeLabel?.label));
  const failures = rows.filter((row) => outcomeFailure(row.outcomeLabel?.label));
  const candidate: Record<keyof typeof ADAPTIVE_WEIGHTS, number> = { ...ADAPTIVE_WEIGHTS };
  const reasons: string[] = [];
  for (const key of Object.keys(candidate) as Array<keyof typeof candidate>) {
    const winnerMean = average(winners.map((row) => decompositionRaw(row.scoreDecompositionJson, key)));
    const failureMean = average(failures.map((row) => decompositionRaw(row.scoreDecompositionJson, key)));
    if (winnerMean - failureMean >= 0.15) { candidate[key] += 1; reasons.push(`${key}_positive_outcome_association`); }
    if (failureMean - winnerMean >= 0.15 && candidate[key] > 2) { candidate[key] -= 1; reasons.push(`${key}_negative_outcome_association`); }
  }
  const split = chronologicalSplit(rows);
  const baseHoldout = performanceMetrics(toMetricRows(split.holdout));
  const candidateHoldout = evaluateCandidate(split.holdout, candidate);
  const precisionDelta = nullableDelta(candidateHoldout.precision, baseHoldout.precision);
  const falsePositiveDelta = nullableDelta(candidateHoldout.falsePositiveRate, baseHoldout.falsePositiveRate);
  const safe = precisionDelta !== null && precisionDelta >= 0 && (falsePositiveDelta ?? 1) <= 0;
  const proposalKey = hash(`weight-proposal|v${ADAPTIVE_MODEL_VERSION}|${JSON.stringify(candidate)}|${signals.map((row) => row.id).join(',')}`);
  const proposal = await prisma.intelligenceWeightProposal.upsert({ where: { proposalKey }, create: {
    proposalKey, baseModelVersion: ADAPTIVE_MODEL_VERSION, candidateModelVersion: ADAPTIVE_MODEL_VERSION + 1,
    status: safe ? 'validated_shadow_requires_approval' : 'rejected_holdout_regression',
    proposedWeightsJson: json(candidate), reasons: reasons.length ? reasons : ['no_component_separation'],
    trainingMetricsJson: json((metrics as { training?: unknown }).training ?? {}),
    validationMetricsJson: json((metrics as { validation?: unknown }).validation ?? {}),
    holdoutMetricsJson: json({ baseline: baseHoldout, candidate: candidateHoldout }),
    precisionDelta, falsePositiveDelta, sampleSize: signals.length, evaluatedAt: now
  }, update: {} });
  return { id: proposal.id, status: proposal.status, sampleSize: proposal.sampleSize, precisionDelta, falsePositiveDelta, productionWeightsChanged: false };
}

interface MetricRow {
  stage: string;
  score: number;
  label: string | null;
  returnPct: number | null;
  maxDrawdownPct: number | null;
}

function performanceMetrics(rows: MetricRow[]): AdaptivePerformanceMetrics {
  const evaluated = rows.filter((row) => row.label && row.label !== 'insufficient_data');
  const wins = evaluated.filter((row) => outcomeWin(row.label)).length;
  const failures = evaluated.filter((row) => outcomeFailure(row.label)).length;
  const returns = evaluated.map((row) => row.returnPct).filter(finiteNumber);
  const drawdowns = evaluated.map((row) => row.maxDrawdownPct).filter(finiteNumber);
  return {
    signals: rows.length, evaluated: evaluated.length, insufficient: rows.length - evaluated.length,
    wins, failures, precision: ratio(wins, evaluated.length), falsePositiveRate: ratio(failures, evaluated.length),
    averageReturnPct: returns.length ? round(average(returns), 2) : null,
    medianReturnPct: returns.length ? round(percentile([...returns].sort((a, b) => a - b), 0.5), 2) : null,
    maxDrawdownPct: drawdowns.length ? round(Math.min(...drawdowns), 2) : null,
    byStage: groupedPerformance(rows, (row) => row.stage),
    byScoreBucket: groupedPerformance(rows, (row) => scoreBucket(row.score)),
    labelCounts: countBy(rows.filter((row) => row.label).map((row) => row.label!))
  };
}

function groupedPerformance(rows: MetricRow[], key: (row: MetricRow) => string) {
  return Object.fromEntries([...groupBy(rows, key)].map(([name, group]) => {
    const evaluated = group.filter((row) => row.label && row.label !== 'insufficient_data');
    const wins = evaluated.filter((row) => outcomeWin(row.label)).length;
    return [name, { signals: group.length, evaluated: evaluated.length, wins, precision: ratio(wins, evaluated.length) }];
  }));
}
function evaluateCandidate(rows: Array<{ scoreDecompositionJson: Prisma.JsonValue; outcomeLabel: { label: string } | null; outcomes: Array<{ realizedReturnPct: number | null; maxDrawdownPct: number | null }> }>, weights: Record<string, number>) {
  const rescored = rows.map((row) => ({
    stage: 'candidate', score: Object.entries(weights).reduce((sum, [key, weight]) => sum + decompositionRaw(row.scoreDecompositionJson, key) * weight, 0),
    label: row.outcomeLabel?.label ?? null,
    returnPct: row.outcomes[0]?.realizedReturnPct ?? null,
    maxDrawdownPct: row.outcomes[0]?.maxDrawdownPct ?? null
  })).filter((row) => row.score >= ADAPTIVE_THRESHOLDS.watch);
  return performanceMetrics(rescored);
}
function chronologicalSplit<T extends { activatedAt?: Date }>(rows: T[]) { const a = Math.floor(rows.length * 0.6); const b = Math.floor(rows.length * 0.8); return { training: rows.slice(0, a), validation: rows.slice(a, b), holdout: rows.slice(b) }; }
function splitWindows(split: ReturnType<typeof chronologicalSplit<Awaited<ReturnType<PrismaClient['intelligenceSignal']['findMany']>>[number]>>) {
  const window = (rows: Array<{ activatedAt: Date }>) => ({ from: rows[0]?.activatedAt ?? null, to: rows.at(-1)?.activatedAt ?? null });
  const training = window(split.training); const validation = window(split.validation); const holdout = window(split.holdout);
  return { trainingFrom: training.from, trainingTo: training.to, validationFrom: validation.from, validationTo: validation.to, holdoutFrom: holdout.from, holdoutTo: holdout.to };
}
function toMetricRow(row: { lifecycleStage: string; score: number; outcomeLabel: { label: string } | null; outcomes: Array<{ realizedReturnPct: number | null; maxDrawdownPct: number | null }> }): MetricRow { return { stage: row.lifecycleStage, score: row.score, label: row.outcomeLabel?.label ?? null, returnPct: row.outcomes[0]?.realizedReturnPct ?? null, maxDrawdownPct: row.outcomes[0]?.maxDrawdownPct ?? null }; }
function toMetricRows(rows: Array<{ lifecycleStage: string; score: number; outcomeLabel: { label: string } | null; outcomes: Array<{ realizedReturnPct: number | null; maxDrawdownPct: number | null }> }>) { return rows.map(toMetricRow); }
function outcomeWin(label: string | null | undefined) { return label === 'exceptional' || label === 'strong' || label === 'moderate'; }
function outcomeFailure(label: string | null | undefined) { return label === 'failed' || label === 'severe_failure' || label === 'rug_pull' || label === 'invalidated'; }
function outcomeRationale(label: string, row: { maxReturnPct: number | null; realizedReturnPct: number | null; maxDrawdownPct: number | null; liquidityRetentionPct: number | null; rugPullDetected: boolean; tradingHalted: boolean }) { return [`deterministic_label_${label}`, `max_return_${row.maxReturnPct ?? 'unknown'}`, `realized_return_${row.realizedReturnPct ?? 'unknown'}`, `max_drawdown_${row.maxDrawdownPct ?? 'unknown'}`, `liquidity_retention_${row.liquidityRetentionPct ?? 'unknown'}`, ...(row.rugPullDetected ? ['rug_pull_detected'] : []), ...(row.tradingHalted ? ['trading_halted'] : [])]; }
function outcomeMetrics(row: { maxReturnPct: number | null; realizedReturnPct: number | null; maxDrawdownPct: number | null; timeToPeakMinutes: number | null; liquidityRetentionPct: number | null; volumeContinuation: string; holderContinuation: string; survivalStatus: string; earlyLateLabel: string }) { return { maxReturnPct: row.maxReturnPct, realizedReturnPct: row.realizedReturnPct, maxDrawdownPct: row.maxDrawdownPct, timeToPeakMinutes: row.timeToPeakMinutes, liquidityRetentionPct: row.liquidityRetentionPct, volumeContinuation: row.volumeContinuation, holderContinuation: row.holderContinuation, survivalStatus: row.survivalStatus, earlyLateLabel: row.earlyLateLabel }; }
function decompositionRaw(value: Prisma.JsonValue, key: string) { const row = asRecord(value); const component = asRecord(row[key]); return typeof component.raw === 'number' ? component.raw : 0; }
function marketValue(value: Prisma.JsonValue, key: string) { const row = asRecord(value); return typeof row[key] === 'number' ? row[key] as number : null; }
function scoreBucket(score: number) { if (score >= 94) return '94-100'; if (score >= 85) return '85-93'; if (score >= 70) return '70-84'; if (score >= 50) return '50-69'; return '0-49'; }
function volumeLabel(entry: number | null, current: number | null) { if (entry === null || current === null) return 'unknown'; const ratio = entry > 0 ? current / entry : null; return ratio === null ? 'unknown' : ratio >= 1 ? 'expanding' : ratio >= 0.4 ? 'continuing' : 'fading'; }
function holderLabel(entry: number, current: number) { if (!entry || !current) return 'unknown'; const ratio = current / entry; return ratio >= 1.05 ? 'expanding' : ratio >= 0.85 ? 'stable' : 'contracting'; }
function ratioPct(current: number | null, entry: number | null) { return current !== null && entry !== null && entry > 0 ? round(current / entry * 100, 3) : null; }
function positive(value: number | null) { return value !== null && value > 0 ? value : null; }
function decimal(value: unknown) { if (value === null || value === undefined) return null; const number = Number(value); return Number.isFinite(number) ? number : null; }
function finiteNumber(value: number | null | undefined): value is number { return typeof value === 'number' && Number.isFinite(value); }
function nullableDelta(next: number | null, previous: number | null) { return next === null || previous === null ? null : round(next - previous, 6); }
function ratio(numerator: number, denominator: number) { return denominator ? round(numerator / denominator, 6) : null; }
function average(values: number[]) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }
function percentile(sorted: number[], q: number) { const index = (sorted.length - 1) * q; const lo = Math.floor(index); const hi = Math.ceil(index); return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (index - lo); }
function countBy(values: string[]) { const result: Record<string, number> = {}; for (const value of values) result[value] = (result[value] ?? 0) + 1; return result; }
function groupBy<T>(values: T[], key: (value: T) => string) { const result = new Map<string, T[]>(); for (const value of values) result.set(key(value), [...(result.get(key(value)) ?? []), value]); return result; }
function unique<T>(values: T[]) { return [...new Set(values)]; }
function nonNull<T>(value: T | null | undefined): value is T { return value !== null && value !== undefined; }
function asRecord(value: Prisma.JsonValue | unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function round(value: number, digits = 4) { const scale = 10 ** digits; return Math.round(value * scale) / scale; }
function hash(value: string) { return createHash('sha256').update(value).digest('hex'); }
function json(value: unknown): Prisma.InputJsonValue { return value as Prisma.InputJsonValue; }
