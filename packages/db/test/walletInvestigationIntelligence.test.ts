import { describe, expect, it } from 'vitest';
import type { InvestigationMember } from '../src/investigation/types';
import { scoreMember } from '../src/investigation/intelligence';

const ADDRESS = `0x${'22'.repeat(20)}`;

function member(role = 'execution_wallet'): InvestigationMember {
  return {
    chain: 'BASE', address: ADDRESS, role, parentChain: 'BASE', parentAddress: `0x${'11'.repeat(20)}`, entityKey: 'entity:test',
    relationshipConfidence: 0.95, evidenceTier: 'exact_direct_transfer', firstLinkedAt: '2024-01-01T00:00:00.000Z',
    lastLinkedAt: '2025-01-01T00:00:00.000Z', observationOnly: true
  };
}

function context(overrides: Record<string, unknown> = {}) {
  return {
    relationships: [], roleReasonCodes: [], dna: null, stats: null, tokenIntelligence: [], topPnl: [], dormancyDays: null,
    dormancyClasses: [], repeatRunner: null, dormantRunner: null, deployments: [], paths: [], ...overrides
  };
}

function directRelationship(transferCount = 1) {
  return {
    relatedChain: 'BASE', relatedWallet: ADDRESS, route: 'direct_transfer', role: 'execution_wallet', transferCount,
    relationshipConfidence: 0.95, safeEntityLink: true, transferReceiptIds: Array.from({ length: transferCount }, (_, index) => `receipt-${index}`),
    bridgeCorrelationIds: [], supportingEvidence: {}, contradictingEvidence: {}
  };
}

describe('wallet investigation intelligence scoring', () => {
  it('never promotes a wallet from one relationship signal', () => {
    const result = scoreMember(member(), context({ relationships: [directRelationship()] }) as never, '2026-01-01T00:00:00.000Z');

    expect(result.independentSignalCount).toBe(1);
    expect(result.evidenceScore).toBeLessThanOrEqual(49);
    expect(result.clusterConclusion).toBe('unconfirmed');
    expect(['S', 'A']).not.toContain(result.tier);
  });

  it('combines independent funding, execution, history and dormancy signals without penalizing silence', () => {
    const deployments = [
      { tokenAddress: 'token-1', fundingToBuyDelaySec: 600 },
      { tokenAddress: 'token-2', fundingToBuyDelaySec: 1_200 }
    ];
    const dna = {
      coverage: 'full', confidence: 0.9, tokensEntered: 12, runnersEntered: 5, completedPositions: 10, winRate: 0.8,
      evUsd: 5_000, oneWinnerDependence: 0.3, avgReturn: 2.5, medianReturn: 1.8, realizedPnlUsd: 250_000,
      repeatRunnerCount: 4, medianEntryMcapUsd: 150_000
    };
    const active = scoreMember(member(), context({ relationships: [directRelationship(4)], deployments, dna, dormancyDays: 0 }) as never, '2026-01-01T00:00:00.000Z');
    const dormant = scoreMember(member(), context({ relationships: [directRelationship(4)], deployments, dna, dormancyDays: 365 }) as never, '2026-01-01T00:00:00.000Z');

    expect(dormant.independentSignalCount).toBeGreaterThanOrEqual(4);
    expect(['S', 'A']).toContain(dormant.tier);
    expect(dormant.historicalAlphaScore).toBeGreaterThan(50);
    expect(dormant.wakeUpPotential).toBeGreaterThanOrEqual(active.wakeUpPotential);
    expect(dormant.whyImportant.join(' ')).toMatch(/not a penalty/i);
  });

  it('excludes service/router/CEX infrastructure from entity and tracking tiers', () => {
    const result = scoreMember(member('service_router_node'), context({ relationships: [directRelationship(10)] }) as never, '2026-01-01T00:00:00.000Z');

    expect(result).toMatchObject({ tier: 'C', trackingPriority: 'exclude', clusterConclusion: 'infrastructure', evidenceScore: 0 });
  });
});
