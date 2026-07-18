import { describe, expect, it } from 'vitest';
import { parseIntelligenceAlertCallback, renderIntelligenceAlert } from '../src/intelligenceAlertRenderer';

describe('adaptive intelligence Telegram alert', () => {
  it('renders an explainable compact alert with all drill-down actions', () => {
    const rendered = renderIntelligenceAlert({
      alert: { id: 'alert-cuid-123', alertType: 'receiver_bought_token' },
      payload: { token: 'ALPHA', symbol: 'ALP' },
      signal: {
        tokenAddress: '0xabc', chain: 'BASE', lifecycleStage: 'HIGH_CONVICTION', score: 89,
        reasons: ['Two independently inferred entities bought the token.'], independentEntityCount: 2,
        independentCapitalRootCount: 2, coreWalletCount: 3, peripheralWalletCount: 1,
        scoreDecompositionJson: { entityConfluence: { raw: 1, weight: 24, contribution: 24, explanation: '2 entities' }, dimensions: { evidenceScore: 90, riskScore: 26 } },
        historySupportJson: { participants: [] }, outcomeStatus: 'pending', outcomeLabel: null, outcomes: [],
        qualityAssessment: { passed: false, score: 74, coverage: 'partial', reasonCodes: ['liquidity_pass', 'lp_lock_or_burn_unknown'] }
      },
      entities: [{
        label: 'Entity A', identityConfidence: 0.84, currentRelevance: 0.9, historicalAlphaScore: 78,
        historicalAlphaConfidence: 0.7, wakeUpPotential: 88, outcomeCount: 12, memberships: []
      }]
    } as never);

    expect(rendered.text).toContain('HIGH CONVICTION');
    expect(rendered.text).toContain('Independent entities  <b>2</b>');
    expect(rendered.text).toContain('BLOCKED  ·  74/100');
    expect(rendered.text).toContain('INVALIDATION');
    const labels = rendered.keyboard.inline_keyboard.flat().map((button) => button.text);
    expect(labels).toEqual(expect.arrayContaining(['🛡 Evidence', '💡 Why', '💸 Capital Path', '⚠️ Token Risk', '📜 Entity History', '📈 Outcomes']));
    expect(parseIntelligenceAlertCallback('ia|outcomes|alert-cuid-123')).toEqual({ view: 'outcomes', alertId: 'alert-cuid-123' });
  });
});
