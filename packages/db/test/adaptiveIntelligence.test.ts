import { describe, expect, it } from 'vitest';
import {
  calibrateHistoricalAlpha,
  computeEntityDecay,
  deterministicOutcomeLabel,
  projectEntityMembership,
  scoreAdaptiveActivation
} from '../src/intelligence/adaptive';

describe('adaptive intelligence safety boundaries', () => {
  it('never confirms identity from one signal and fails closed for infrastructure', () => {
    const single = projectEntityMembership({
      role: 'execution_wallet', evidenceScore: 99, confidence: 0.99,
      independentSignalCount: 1, evidenceTypes: ['timing_correlation']
    });
    expect(single.status).toBe('possible');
    expect(single.scope).toBe('peripheral');

    const router = projectEntityMembership({
      role: 'execution_wallet', evidenceScore: 99, confidence: 0.99,
      independentSignalCount: 4, evidenceTypes: ['direct_funding', 'repeated_behavior', 'execution_pattern'],
      registryCategory: 'router:do_not_expand'
    });
    expect(router).toMatchObject({ status: 'rejected', scope: 'infrastructure', identityConfidence: 0 });
  });

  it('counts wallets from one entity as one independent confirmation and downweights peripheral wallets', () => {
    const base = {
      clusterKey: 'cluster-a', capitalRootKey: 'capital-a', historicalAlphaScore: 80,
      evidenceScore: 90, identityConfidence: 0.9, evidenceFreshness: 1,
      dormantAwakened: true, fundingExecution: true
    };
    const sameEntity = scoreAdaptiveActivation([
      { ...base, profileId: 'p1', entityId: 'e1', scope: 'core' },
      { ...base, profileId: 'p2', entityId: 'e1', scope: 'core' }
    ]);
    expect(sameEntity.independentEntityCount).toBe(1);
    expect(sameEntity.independentCapitalRootCount).toBe(1);
    expect(sameEntity.lifecycleStage).not.toBe('OBSERVATION');

    const independent = scoreAdaptiveActivation([
      { ...base, profileId: 'p1', entityId: 'e1', scope: 'core' },
      { ...base, profileId: 'p2', entityId: 'e2', clusterKey: 'cluster-b', capitalRootKey: 'capital-b', scope: 'core' }
    ]);
    expect(independent.independentEntityCount).toBe(2);
    expect(independent.independentCapitalRootCount).toBe(2);
    expect(independent.score).toBeGreaterThan(sameEntity.score);
    expect(sameEntity.decomposition.entityConfluence.raw).toBeLessThan(independent.decomposition.entityConfluence.raw);

    const peripheral = scoreAdaptiveActivation([
      { ...base, profileId: 'p1', entityId: 'e1', scope: 'peripheral' },
      { ...base, profileId: 'p2', entityId: 'e2', clusterKey: 'cluster-b', capitalRootKey: 'capital-b', scope: 'peripheral' }
    ]);
    expect(peripheral.coreWalletCount).toBe(0);
    expect(peripheral.score).toBeLessThan(independent.score);

    const opportunity = scoreAdaptiveActivation([
      { ...base, profileId: 'p1', entityId: 'e1', scope: 'core', historicalAlphaScore: 100, evidenceScore: 100, identityConfidence: 1 },
      { ...base, profileId: 'p2', entityId: 'e2', clusterKey: 'cluster-b', capitalRootKey: 'capital-b', scope: 'core', historicalAlphaScore: 100, evidenceScore: 100, identityConfidence: 1 }
    ]);
    expect(opportunity.lifecycleStage).toBe('OPPORTUNITY');
  });

  it('decays current relevance separately without erasing alpha or wake-up potential', () => {
    const now = new Date('2035-01-01T00:00:00Z');
    const result = computeEntityDecay({
      identityConfidence: 0.9, currentRelevance: 0.9, historicalAlphaScore: 88,
      wakeUpPotential: 92, lastEvidenceAt: new Date('2034-01-01T00:00:00Z'),
      lastCoreActivityAt: new Date('2034-01-01T00:00:00Z'), now
    });
    expect(result.currentRelevance).toBeLessThan(result.identityConfidence);
    expect(result.historicalAlphaScore).toBe(88);
    expect(result.wakeUpPotential).toBe(92);
    expect(result.reasonCodes).toContain('alpha_and_wakeup_not_decayed');
  });

  it('uses robust/sample-size-aware alpha rather than one extreme winner', () => {
    const oneWinner = calibrateHistoricalAlpha([{ returnPct: 2_000, rugPull: false }]);
    const consistent = calibrateHistoricalAlpha(Array.from({ length: 24 }, () => ({ returnPct: 85, drawdownPct: -20, entryPercentile: 0.15, capitalUsd: 25_000 })));
    expect(oneWinner.sampleConfidence).toBeLessThan(0.1);
    expect(oneWinner.rawScore).toBeGreaterThan(oneWinner.score);
    expect(oneWinner.score).toBeLessThan(consistent.score);
    expect(consistent.intervalHigh - consistent.intervalLow).toBeLessThan(oneWinner.intervalHigh - oneWinner.intervalLow);
  });

  it('applies deterministic failure/rug/insufficient labels', () => {
    expect(deterministicOutcomeLabel({ maxReturnPct: null, realizedReturnPct: null, maxDrawdownPct: null, rugPullDetected: false, tradingHalted: false, liquidityRetentionPct: null, coverage: 'insufficient' })).toBe('insufficient_data');
    expect(deterministicOutcomeLabel({ maxReturnPct: 500, realizedReturnPct: 300, maxDrawdownPct: -10, rugPullDetected: false, tradingHalted: false, liquidityRetentionPct: 100, coverage: 'partial' })).toBe('insufficient_data');
    expect(deterministicOutcomeLabel({ maxReturnPct: 40, realizedReturnPct: -95, maxDrawdownPct: -98, rugPullDetected: true, tradingHalted: false, liquidityRetentionPct: 5, coverage: 'full' })).toBe('rug_pull');
    expect(deterministicOutcomeLabel({ maxReturnPct: 350, realizedReturnPct: 210, maxDrawdownPct: -30, rugPullDetected: false, tradingHalted: false, liquidityRetentionPct: 70, coverage: 'full' })).toBe('exceptional');
  });
});
