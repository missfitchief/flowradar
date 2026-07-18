import { Prisma, type PrismaClient } from '@prisma/client';
import {
  ADAPTIVE_MODEL_VERSION,
  ADAPTIVE_THRESHOLDS,
  ADAPTIVE_WEIGHTS,
  type AdaptiveWeights
} from './adaptive';

export interface ProductionAdaptiveModel {
  version: number;
  weights: AdaptiveWeights;
  thresholds: typeof ADAPTIVE_THRESHOLDS;
  source: string;
  persisted: boolean;
}

/** Reads the explicitly promoted model. A missing/invalid row fails closed to
 * the reviewed code defaults; it never promotes a shadow proposal. */
export async function loadProductionAdaptiveModel(prisma: PrismaClient): Promise<ProductionAdaptiveModel> {
  const row = await prisma.intelligenceModelVersion.findFirst({
    where: { status: 'active' },
    orderBy: [{ version: 'desc' }, { createdAt: 'desc' }]
  });
  const weights = row ? parseWeights(row.weightsJson) : null;
  return row && weights
    ? { version: row.version, weights, thresholds: ADAPTIVE_THRESHOLDS, source: row.source, persisted: true }
    : { version: ADAPTIVE_MODEL_VERSION, weights: { ...ADAPTIVE_WEIGHTS }, thresholds: ADAPTIVE_THRESHOLDS, source: 'reviewed_code_default', persisted: false };
}

export async function persistCandidateModelVersion(
  prisma: PrismaClient,
  input: {
    version: number;
    baseVersion: number;
    weights: AdaptiveWeights;
    trainingMetrics: unknown;
    validationMetrics: unknown;
    holdoutMetrics: unknown;
    source: string;
  }
) {
  return prisma.intelligenceModelVersion.upsert({
    where: { version: input.version },
    create: {
      version: input.version,
      status: 'candidate_shadow',
      weightsJson: json(input.weights),
      thresholdsJson: json(ADAPTIVE_THRESHOLDS),
      trainingWindowJson: json({ baseModelVersion: input.baseVersion, metrics: input.trainingMetrics }),
      validationWindowJson: json({ metrics: input.validationMetrics }),
      holdoutWindowJson: json({ metrics: input.holdoutMetrics }),
      metricsJson: json({ promotionRequired: true, automaticPromotion: false }),
      source: input.source
    },
    update: {
      status: 'candidate_shadow',
      weightsJson: json(input.weights),
      thresholdsJson: json(ADAPTIVE_THRESHOLDS),
      trainingWindowJson: json({ baseModelVersion: input.baseVersion, metrics: input.trainingMetrics }),
      validationWindowJson: json({ metrics: input.validationMetrics }),
      holdoutWindowJson: json({ metrics: input.holdoutMetrics }),
      metricsJson: json({ promotionRequired: true, automaticPromotion: false }),
      source: input.source,
      approvedAt: null,
      approvedBy: null,
      activatedAt: null,
      supersededAt: null
    }
  });
}

/** Explicit operator-only promotion. Holdout precision must not regress,
 * false positives must not increase, and the minimum real sample is enforced. */
export async function promoteIntelligenceWeightProposal(
  prisma: PrismaClient,
  proposalId: string,
  approvedBy: string,
  now = new Date()
) {
  const operator = approvedBy.trim();
  if (!operator) throw new Error('weight_promotion_requires_operator_identity');
  const proposal = await prisma.intelligenceWeightProposal.findUnique({ where: { id: proposalId } });
  if (!proposal || proposal.status !== 'validated_shadow_requires_approval') throw new Error('weight_proposal_not_promotable');
  if (proposal.sampleSize < ADAPTIVE_THRESHOLDS.minimumFeedbackSample) throw new Error('weight_proposal_sample_too_small');
  if (proposal.precisionDelta === null || proposal.precisionDelta < 0) throw new Error('weight_proposal_precision_regression');
  if (proposal.falsePositiveDelta === null || proposal.falsePositiveDelta > 0) throw new Error('weight_proposal_false_positive_regression');
  const weights = parseWeights(proposal.proposedWeightsJson);
  if (!weights) throw new Error('weight_proposal_invalid_weights');
  const active = await prisma.intelligenceModelVersion.findFirst({ where: { status: 'active' }, orderBy: { version: 'desc' } });
  if (active && active.version !== proposal.baseModelVersion) throw new Error('weight_proposal_base_model_is_stale');

  await prisma.$transaction(async (tx) => {
    if (!active) {
      await tx.intelligenceModelVersion.upsert({
        where: { version: proposal.baseModelVersion },
        create: {
          version: proposal.baseModelVersion,
          status: 'superseded',
          weightsJson: json(ADAPTIVE_WEIGHTS),
          thresholdsJson: json(ADAPTIVE_THRESHOLDS),
          trainingWindowJson: json({}), validationWindowJson: json({}), holdoutWindowJson: json({}),
          metricsJson: json({ source: 'reviewed_code_default' }),
          source: 'reviewed_code_default',
          supersededAt: now
        },
        update: { status: 'superseded', supersededAt: now }
      });
    } else {
      await tx.intelligenceModelVersion.update({ where: { id: active.id }, data: { status: 'superseded', supersededAt: now } });
    }
    await tx.intelligenceModelVersion.upsert({
      where: { version: proposal.candidateModelVersion },
      create: {
        version: proposal.candidateModelVersion,
        status: 'active',
        weightsJson: json(weights), thresholdsJson: json(ADAPTIVE_THRESHOLDS),
        trainingWindowJson: json(proposal.trainingMetricsJson),
        validationWindowJson: json(proposal.validationMetricsJson),
        holdoutWindowJson: json(proposal.holdoutMetricsJson),
        metricsJson: json({ precisionDelta: proposal.precisionDelta, falsePositiveDelta: proposal.falsePositiveDelta, sampleSize: proposal.sampleSize }),
        source: `weight_proposal:${proposal.id}`,
        approvedAt: now, approvedBy: operator, activatedAt: now
      },
      update: {
        status: 'active', weightsJson: json(weights), thresholdsJson: json(ADAPTIVE_THRESHOLDS),
        trainingWindowJson: json(proposal.trainingMetricsJson),
        validationWindowJson: json(proposal.validationMetricsJson),
        holdoutWindowJson: json(proposal.holdoutMetricsJson),
        metricsJson: json({ precisionDelta: proposal.precisionDelta, falsePositiveDelta: proposal.falsePositiveDelta, sampleSize: proposal.sampleSize }),
        source: `weight_proposal:${proposal.id}`,
        approvedAt: now, approvedBy: operator, activatedAt: now, supersededAt: null
      }
    });
    await tx.intelligenceWeightProposal.update({
      where: { id: proposal.id },
      data: { status: 'promoted', approvedAt: now, approvedBy: operator }
    });
  });
  return prisma.intelligenceModelVersion.findUniqueOrThrow({ where: { version: proposal.candidateModelVersion } });
}

function parseWeights(value: Prisma.JsonValue): AdaptiveWeights | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result = {} as AdaptiveWeights;
  for (const key of Object.keys(ADAPTIVE_WEIGHTS) as Array<keyof AdaptiveWeights>) {
    const number = Number((value as Record<string, unknown>)[key]);
    if (!Number.isFinite(number) || number < 0 || number > 100) return null;
    result[key] = number;
  }
  return result;
}

function json(value: unknown): Prisma.InputJsonValue { return value as Prisma.InputJsonValue; }
