import { describe, expect, it } from 'vitest';
import {
  MAX_PUSH_EVENT_AGE_MS, MIN_QUALIFYING_BUY_USD, evaluateCoreBuyWindow, evaluateCorePushEligibility,
  validateCorePushPayload, type CoreBuyCandidate, type CorePushContext
} from '../src/alerts/coreConfluence';

const NOW = new Date('2026-07-14T12:00:00.000Z');
const PUSH_CONTEXT: CorePushContext = {
  evaluatedAt: new Date(NOW.getTime() + 30_000), tokenAgeSec: 600,
  liquidityUsd: 75_000, liquidityAvailable: true, holderCount: 420, holdersAvailable: true,
  marketCapUsd: 180_000, tokenQualityPassed: true, tokenQualityScore: 85,
  criticalTokenRisk: false, infrastructureContamination: false
};

function buy(wallet: string, amountUsd: number | null, options: Partial<CoreBuyCandidate> = {}): CoreBuyCandidate {
  return {
    eventId: options.eventId ?? `${wallet}:${amountUsd}:${options.ts?.toISOString() ?? NOW.toISOString()}`,
    wallet, role: options.role ?? 'core', ts: options.ts ?? NOW, amountUsd,
    entityKey: options.entityKey ?? null, clusterKey: options.clusterKey ?? null,
    evidenceScore: options.evidenceScore ?? 80, historicalAlphaScore: options.historicalAlphaScore ?? 80,
    qualityQualified: options.qualityQualified ?? true, ...options
  };
}

describe('Core confluence alert policy', () => {
  it('keeps a solo $99.99 buy silent and below the centralized threshold', () => {
    expect(MIN_QUALIFYING_BUY_USD).toBe(100);
    const result = evaluateCoreBuyWindow([buy('wallet-a', 99.99)]);
    expect(result).toMatchObject({ qualifies: false, rawWalletCount: 0, combinedBuyUsd: 0 });
    expect(result.audits[0]).toMatchObject({ eligibility: 'rejected', rejectionReason: 'below_minimum_buy_threshold' });
  });

  it('keeps a solo $100 buy silent but eligible for future confluence', () => {
    const result = evaluateCoreBuyWindow([buy('wallet-a', 100)]);
    expect(result).toMatchObject({ qualifies: false, rawWalletCount: 1, combinedBuyUsd: 100 });
    expect(result.audits[0]).toMatchObject({ eligibility: 'eligible_for_future_confluence', rejectionReason: 'solo_core_buy_no_confluence' });
  });

  it('does not combine two separate sub-threshold wallets into a signal', () => {
    const result = evaluateCoreBuyWindow([buy('wallet-a', 80), buy('wallet-b', 80)]);
    expect(result).toMatchObject({ qualifies: false, rawWalletCount: 0, entityCount: 0, combinedBuyUsd: 0 });
    expect(result.audits.every((audit) => audit.rejectionReason === 'below_minimum_buy_threshold')).toBe(true);
  });

  it('aggregates 60 + 50 for one wallet as one $110 participant, never two confirmations', () => {
    const result = evaluateCoreBuyWindow([
      buy('wallet-a', 60, { eventId: 'leg-1' }),
      buy('wallet-a', 50, { eventId: 'leg-2', ts: new Date(NOW.getTime() + 60_000) })
    ]);
    expect(result).toMatchObject({ qualifies: false, rawWalletCount: 1, coreWalletCount: 1, effectiveConfirmationCount: 1, combinedBuyUsd: 110 });
    expect(result.participants[0]).toMatchObject({ wallet: 'wallet-a', cumulativeBuyUsd: 110, sourceEventIds: ['leg-1', 'leg-2'] });
  });

  it('allows two qualifying Core wallets to create one cluster alert', () => {
    const result = evaluateCoreBuyWindow([buy('wallet-a', 100), buy('wallet-b', 125)]);
    expect(result).toMatchObject({ qualifies: true, triggerType: 'core_wallet_confluence', rawWalletCount: 2, coreWalletCount: 2, combinedBuyUsd: 225 });
  });

  it('rejects an unknown USD value until enrichment resolves it', () => {
    const result = evaluateCoreBuyWindow([buy('wallet-a', null)]);
    expect(result).toMatchObject({ qualifies: false, rawWalletCount: 0, combinedBuyUsd: 0 });
    expect(result.audits[0]).toMatchObject({ rejectionReason: 'usd_value_unavailable' });
  });

  it('excludes below-threshold buys from wallet/entity counts and combined amount', () => {
    const result = evaluateCoreBuyWindow([
      buy('wallet-a', 100, { entityKey: 'entity-a', entityIdentityConfidence: 0.9 }),
      buy('wallet-b', 120, { entityKey: 'entity-b', entityIdentityConfidence: 0.9 }),
      buy('wallet-c', 99, { entityKey: 'entity-c', entityIdentityConfidence: 0.9 })
    ]);
    expect(result).toMatchObject({ qualifies: true, rawWalletCount: 2, entityCount: 2, independentEntityCount: 2, combinedBuyUsd: 220 });
    expect(result.participants.map((participant) => participant.wallet)).not.toContain('wallet-c');
  });

  it('counts five wallets from one entity as one effective confirmation', () => {
    const result = evaluateCoreBuyWindow(Array.from({ length: 5 }, (_, index) => buy(`wallet-${index}`, 100, {
      entityKey: 'same-entity', entityIdentityConfidence: 0.92
    })));
    expect(result).toMatchObject({ qualifies: true, triggerType: 'core_wallet_confluence', rawWalletCount: 5, entityCount: 1, independentEntityCount: 1, sameEntityWalletCount: 5, effectiveConfirmationCount: 1 });
  });

  it('strengthens three wallets from two independent entities without double-counting one entity', () => {
    const result = evaluateCoreBuyWindow([
      buy('wallet-a', 100, { entityKey: 'entity-a', entityIdentityConfidence: 0.9 }),
      buy('wallet-b', 110, { entityKey: 'entity-a', entityIdentityConfidence: 0.9 }),
      buy('wallet-c', 120, { entityKey: 'entity-b', entityIdentityConfidence: 0.88 })
    ]);
    expect(result).toMatchObject({ qualifies: true, triggerType: 'multi_entity_confluence', rawWalletCount: 3, entityCount: 2, independentEntityCount: 2, sameEntityWalletCount: 2, effectiveConfirmationCount: 2 });
  });

  it('keeps a solo qualifying buy in the inbox receipt but never push-eligible', () => {
    const decision = evaluateCorePushEligibility(evaluateCoreBuyWindow([buy('wallet-a', 250)]), PUSH_CONTEXT);
    expect(decision).toMatchObject({ pushEligible: false, eligibilityResult: 'REJECTED', rejectionReason: 'solo_core_buy_no_confluence' });
  });

  it('pushes a fresh two-wallet confluence with an explainable score', () => {
    const decision = evaluateCorePushEligibility(evaluateCoreBuyWindow([
      buy('wallet-a', 150, { entityKey: 'entity-a', entityIdentityConfidence: 0.9 }),
      buy('wallet-b', 175, { entityKey: 'entity-b', entityIdentityConfidence: 0.9 })
    ], { criticalRisk: false, qualityPassed: true }), PUSH_CONTEXT);
    expect(decision.pushEligible).toBe(true);
    expect(decision.alertScore).toBeGreaterThanOrEqual(70);
    expect(decision.contributions.map((item) => item.feature)).toContain('independent_entity_count');
  });

  it('rejects a backfilled event even when its confluence is otherwise strong', () => {
    const evaluation = evaluateCoreBuyWindow([buy('wallet-a', 150), buy('wallet-b', 175)]);
    const decision = evaluateCorePushEligibility(evaluation, {
      ...PUSH_CONTEXT, evaluatedAt: new Date(NOW.getTime() + MAX_PUSH_EVENT_AGE_MS + 1)
    });
    expect(decision).toMatchObject({ pushEligible: false, rejectionReason: 'stale_event_not_push_eligible' });
  });

  it('rejects stale tokens and fails closed when age or liquidity is unavailable', () => {
    const evaluation = evaluateCoreBuyWindow([buy('wallet-a', 150), buy('wallet-b', 175)]);
    expect(evaluateCorePushEligibility(evaluation, { ...PUSH_CONTEXT, tokenAgeSec: 8 * 24 * 60 * 60 })).toMatchObject({
      pushEligible: false, rejectionReason: 'token_too_old_for_push'
    });
    expect(evaluateCorePushEligibility(evaluation, { ...PUSH_CONTEXT, tokenAgeSec: null })).toMatchObject({
      pushEligible: false, eligibilityResult: 'INBOX_ONLY', rejectionReason: 'token_age_unavailable'
    });
    expect(evaluateCorePushEligibility(evaluation, { ...PUSH_CONTEXT, liquidityUsd: null, liquidityAvailable: false })).toMatchObject({
      pushEligible: false, eligibilityResult: 'INBOX_ONLY', rejectionReason: 'liquidity_unavailable_fail_closed'
    });
  });

  it('revalidates queued payload freshness at dispatch time', () => {
    const payload = {
      policy: { version: 3 }, pushEligible: true, qualifyingWalletCount: 2,
      triggerType: 'multi_entity_confluence',
      windowEnd: new Date(NOW.getTime() - MAX_PUSH_EVENT_AGE_MS - 1).toISOString(),
      tokenLifecycle: 'fresh_launch', liquidityAvailable: true, liquidityUsd: 10_000,
      confidence: 0.8, alertScore: 85
    };
    expect(validateCorePushPayload(payload, NOW)).toBe('stale_event_not_push_eligible');
  });
});
