import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/client';
import { ADAPTIVE_THRESHOLDS, ADAPTIVE_WEIGHTS } from '../src/intelligence/adaptive';
import { loadProductionAdaptiveModel, promoteIntelligenceWeightProposal } from '../src/intelligence/modelVersions';

const VERSIONS = [901, 902];
const KEY = 'ADAPTIVE_MODEL_PROMOTION_TEST';

async function cleanup() {
  await prisma.intelligenceWeightProposal.deleteMany({ where: { proposalKey: { startsWith: KEY } } });
  await prisma.intelligenceModelVersion.deleteMany({ where: { version: { in: VERSIONS } } });
}

beforeEach(cleanup);
afterAll(async () => { await cleanup(); await prisma.$disconnect(); });

describe('adaptive model promotion', () => {
  it('keeps a validated candidate shadow-only until an identified operator explicitly promotes it', async () => {
    await prisma.intelligenceModelVersion.create({ data: {
      version: 901, status: 'active', weightsJson: ADAPTIVE_WEIGHTS, thresholdsJson: ADAPTIVE_THRESHOLDS,
      trainingWindowJson: {}, validationWindowJson: {}, holdoutWindowJson: {}, metricsJson: {}, source: KEY
    }});
    const proposal = await prisma.intelligenceWeightProposal.create({ data: {
      proposalKey: `${KEY}:safe`, baseModelVersion: 901, candidateModelVersion: 902,
      status: 'validated_shadow_requires_approval', proposedWeightsJson: { ...ADAPTIVE_WEIGHTS, freshness: 7, entityConfluence: 23 },
      reasons: ['freshness_positive_outcome_association'], trainingMetricsJson: {}, validationMetricsJson: {}, holdoutMetricsJson: {},
      precisionDelta: 0.02, falsePositiveDelta: -0.01, sampleSize: ADAPTIVE_THRESHOLDS.minimumFeedbackSample, evaluatedAt: new Date()
    }});
    expect((await loadProductionAdaptiveModel(prisma)).version).toBe(901);
    const promoted = await promoteIntelligenceWeightProposal(prisma, proposal.id, 'test-operator');
    expect(promoted).toMatchObject({ version: 902, status: 'active', approvedBy: 'test-operator' });
    expect((await loadProductionAdaptiveModel(prisma)).version).toBe(902);
    expect((await prisma.intelligenceWeightProposal.findUniqueOrThrow({ where: { id: proposal.id } })).status).toBe('promoted');
  });
});
