import { describe, expect, it } from 'vitest';
import { MIN_QUALIFYING_BUY_USD, evaluateCoreBuyWindow, type CoreBuyCandidate } from '../src/alerts/coreConfluence';

const NOW = new Date('2026-07-14T12:00:00.000Z');

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
      buy('wallet-a', 100, { entityKey: 'entity-a' }),
      buy('wallet-b', 120, { entityKey: 'entity-b' }),
      buy('wallet-c', 99, { entityKey: 'entity-c' })
    ]);
    expect(result).toMatchObject({ qualifies: true, rawWalletCount: 2, entityCount: 2, independentEntityCount: 2, combinedBuyUsd: 220 });
    expect(result.participants.map((participant) => participant.wallet)).not.toContain('wallet-c');
  });

  it('counts five wallets from one entity as one effective confirmation', () => {
    const result = evaluateCoreBuyWindow(Array.from({ length: 5 }, (_, index) => buy(`wallet-${index}`, 100, { entityKey: 'same-entity' })));
    expect(result).toMatchObject({ qualifies: true, triggerType: 'same_entity_cluster_buy', rawWalletCount: 5, entityCount: 1, independentEntityCount: 1, sameEntityWalletCount: 5, effectiveConfirmationCount: 1 });
  });

  it('strengthens three wallets from two independent entities without double-counting one entity', () => {
    const result = evaluateCoreBuyWindow([
      buy('wallet-a', 100, { entityKey: 'entity-a' }), buy('wallet-b', 110, { entityKey: 'entity-a' }),
      buy('wallet-c', 120, { entityKey: 'entity-b' })
    ]);
    expect(result).toMatchObject({ qualifies: true, triggerType: 'multi_entity_confluence', rawWalletCount: 3, entityCount: 2, independentEntityCount: 2, sameEntityWalletCount: 2, effectiveConfirmationCount: 2 });
  });
});
