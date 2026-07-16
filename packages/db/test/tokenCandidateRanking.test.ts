import { describe, expect, it } from 'vitest';
import {
  MIN_VALID_POSITION_USD,
  RAW_TOKEN_CANDIDATE_LIMIT,
  evaluateTokenCandidate,
  finalizeTokenCandidateRanking,
  reportFromReceipts,
  type TokenCandidateEvaluationInput
} from '../src/operator/tokenCandidateRanking';

const NOW = new Date('2026-07-16T12:00:00.000Z');

function candidate(overrides: Partial<TokenCandidateEvaluationInput> = {}): TokenCandidateEvaluationInput {
  return {
    chain: 'SOLANA', tokenAddress: 'TokenMint1111111111111111111111111111111111',
    walletAddress: 'Wallet1111111111111111111111111111111111111', providerRank: 1,
    providerTags: [], rawRoi: 2, registryCategory: null, walletStatus: 'observation_only',
    walletLabels: [], roles: ['execution_wallet'], candidateValidation: 'locally_verified',
    tokenDecimals: 9, tokenCreatedAt: '2026-07-10T00:00:00.000Z',
    trades: [
      { action: 'BUY', amountUsd: 200, amountToken: 100, ts: '2026-07-10T00:04:00.000Z', marketCapUsd: 120_000, txHash: 'buy' },
      { action: 'SELL', amountUsd: 600, amountToken: 100, ts: '2026-07-11T00:00:00.000Z', marketCapUsd: 500_000, txHash: 'sell' }
    ],
    lastRelevantActivityTs: '2026-07-11T00:00:00.000Z', entityKey: 'entity:one',
    rawAlpha: 92, sampleAdjustedAlpha: 84, alphaConfidence: 0.82, alphaSampleSize: 12,
    evidenceScore: 88, monitoringPriority: 'strong_link', historicalMedianRoi: 1.4,
    winRate: 0.72, oneWinnerDependence: 0.2,
    ...overrides
  };
}

describe('token candidate intelligence ranking', () => {
  it('uses a fifty-wallet raw provider cohort before validation', () => {
    expect(RAW_TOKEN_CANDIDATE_LIMIT).toBe(50);
  });

  it('hard-excludes registry infrastructure before scoring', () => {
    const row = evaluateTokenCandidate(candidate({ registryCategory: 'POOL' }), NOW);
    expect(row).toMatchObject({ walletClassification: 'dex_pool', accepted: false, rejectionReason: 'dex_pool_or_vault' });
    expect(row.classificationSignals).toEqual(['address_registry:POOL']);
  });

  it('requires canonical local swap ownership and never promotes provider-only PnL', () => {
    const row = evaluateTokenCandidate(candidate({ trades: [], candidateValidation: 'provider_only', rawRoi: 9_999 }), NOW);
    expect(row.tradeOwnershipResult).toBe('unverified');
    expect(row.rejectionReason).toBe('trade_ownership_unverified');
    expect(row.accepted).toBe(false);
  });

  it(`enforces the $${MIN_VALID_POSITION_USD} local position floor`, () => {
    const row = evaluateTokenCandidate(candidate({
      trades: [{ action: 'BUY', amountUsd: 99.99, amountToken: 100, ts: '2026-07-10T00:04:00.000Z', marketCapUsd: 120_000, txHash: 'dust' }]
    }), NOW);
    expect(row.rejectionReason).toBe('below_minimum_position_size');
  });

  it('keeps a fully local extreme ROI auditable but caps its score contribution', () => {
    const normal = evaluateTokenCandidate(candidate({ rawRoi: 2 }), NOW);
    const outlier = evaluateTokenCandidate(candidate({ rawRoi: 9_000_000 }), NOW);
    expect(outlier.accepted).toBe(true);
    expect(outlier.validatedRoi).toBe(2);
    expect(outlier.rawRoi).toBe(9_000_000);
    expect(outlier.finalRankingScore).toBe(normal.finalRankingScore);
    expect(outlier.finalRankingScore).toBeLessThanOrEqual(100);
  });

  it('never labels activity from 29 days ago as Active Trader', () => {
    const row = evaluateTokenCandidate(candidate({
      trades: [], lastRelevantActivityTs: '2026-06-17T12:00:00.000Z'
    }), NOW);
    expect(row.status).toBe('Dormant');
  });

  it('requires two independent weak infrastructure signals', () => {
    const one = evaluateTokenCandidate(candidate({ roles: ['execution_wallet'], providerTags: ['router'] }), NOW);
    const two = evaluateTokenCandidate(candidate({ roles: ['service_router'], providerTags: ['router'] }), NOW);
    expect(one.accepted).toBe(true);
    expect(two).toMatchObject({ walletClassification: 'dex_router', accepted: false, rejectionReason: 'router_or_aggregator' });
  });

  it('deduplicates an entity and keeps at most five ranked representatives', () => {
    const rows = Array.from({ length: 7 }, (_, index) => evaluateTokenCandidate(candidate({
      walletAddress: `Wallet${index}11111111111111111111111111111111111`,
      providerRank: index + 1,
      entityKey: index < 2 ? 'entity:shared' : `entity:${index}`,
      sampleAdjustedAlpha: 90 - index
    }), NOW));
    finalizeTokenCandidateRanking(rows);
    const report = reportFromReceipts(rows);
    expect(rows.filter((row) => row.rejectionReason === 'duplicate_entity')).toHaveLength(1);
    expect(report.uniqueEntities).toBe(6);
    expect(report.topWallets).toHaveLength(5);
    expect(new Set(report.topWallets.map((row) => row.entityKey)).size).toBe(5);
  });
});
