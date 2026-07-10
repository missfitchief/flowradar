// FlowRadar — pure transfer valuation (Wave A, Capital Lineage). The honest
// value model: unavailable is NEVER zero, a genuine zero stays zero, current
// price never masquerades as historical, and no future snapshot is used.

import { describe, expect, it } from 'vitest';
import { computeValuation, type ValuationInput } from '../src/lineage/valuation';

const T = new Date('2026-07-10T12:00:00Z');

function input(over: Partial<ValuationInput>): ValuationInput {
  return {
    assetKind: 'native_sol',
    amountToken: 1,
    transferTs: T,
    maxSnapshotAgeSec: 3600,
    ...over
  };
}

describe('computeValuation', () => {
  it('UNAVAILABLE is not zero: no price source => valuedUsd null, status unavailable', () => {
    const v = computeValuation(input({ assetKind: 'spl', priorSnapshot: null, currentPrice: null }));
    expect(v.status).toBe('unavailable');
    expect(v.valuedUsd).toBeNull();
    expect(v.priceUsd).toBeNull();
  });

  it('REAL ZERO stays zero: a zero-amount transfer with a real price is valuedUsd 0, not unavailable', () => {
    const v = computeValuation(input({ amountToken: 0, priorSnapshot: { priceUsd: 150, ts: new Date(T.getTime() - 60_000) } }));
    expect(v.valuedUsd).toBe(0);
    expect(v.status).toBe('nearest_prior_snapshot');
  });

  it('PRIOR SOL price produces correct USD value', () => {
    const v = computeValuation(input({ amountToken: 2, priorSnapshot: { priceUsd: 150, ts: new Date(T.getTime() - 300_000) } }));
    expect(v.valuedUsd).toBeCloseTo(300, 6);
    expect(v.status).toBe('nearest_prior_snapshot');
    expect(v.priceTimestamp).toEqual(new Date(T.getTime() - 300_000));
    expect(v.ageSeconds).toBe(300);
  });

  it('NO LOOKAHEAD: a future snapshot is never used', () => {
    const v = computeValuation(
      input({ amountToken: 1, priorSnapshot: null, futureSnapshot: { priceUsd: 999, ts: new Date(T.getTime() + 60_000) }, currentPrice: null })
    );
    expect(v.status).toBe('unavailable');
    expect(v.valuedUsd).toBeNull();
  });

  it('STALE snapshot rejected: prior snapshot older than maxSnapshotAge is not used', () => {
    const v = computeValuation(
      input({ amountToken: 1, maxSnapshotAgeSec: 3600, priorSnapshot: { priceUsd: 150, ts: new Date(T.getTime() - 7200_000) }, currentPrice: null })
    );
    expect(v.status).toBe('unavailable');
  });

  it('CURRENT fallback clearly labeled estimate with lower confidence, never "exact"', () => {
    const v = computeValuation(input({ amountToken: 1, priorSnapshot: null, currentPrice: { priceUsd: 160, ts: new Date(T.getTime() + 5000) } }));
    expect(v.status).toBe('current_price_estimate');
    expect(v.valuedUsd).toBeCloseTo(160, 6);
    expect(v.confidence).toBeLessThan(60);
    expect(v.reason).toMatch(/current|estimate/i);
  });

  it('VERIFIED stablecoin nominal path: $1 per unit with stablecoin_nominal status + depeg caveat', () => {
    const v = computeValuation(input({ assetKind: 'stablecoin', amountToken: 500 }));
    expect(v.status).toBe('stablecoin_nominal');
    expect(v.valuedUsd).toBe(500);
    expect(v.confidence).toBeLessThan(100);
    expect(v.reason).toMatch(/depeg|nominal/i);
  });

  it('SPL prior snapshot path values from the token snapshot', () => {
    const v = computeValuation(input({ assetKind: 'spl', amountToken: 1000, priorSnapshot: { priceUsd: 0.05, ts: new Date(T.getTime() - 120_000) } }));
    expect(v.valuedUsd).toBeCloseTo(50, 6);
    expect(v.status).toBe('nearest_prior_snapshot');
  });

  it('MISSING SPL price remains unavailable (never fabricated)', () => {
    const v = computeValuation(input({ assetKind: 'spl', amountToken: 1000, priorSnapshot: null, currentPrice: null }));
    expect(v.status).toBe('unavailable');
    expect(v.valuedUsd).toBeNull();
  });

  it('SERVICE/internal movement is not_applicable (never valued as direct funding)', () => {
    const v = computeValuation(input({ assetKind: 'service' }));
    expect(v.status).toBe('not_applicable');
    expect(v.valuedUsd).toBeNull();
  });

  it('exact_provider_historical when an exact historical price is supplied', () => {
    const v = computeValuation(
      input({ amountToken: 3, historicalExact: { priceUsd: 140, ts: new Date(T.getTime() - 1000) } })
    );
    expect(v.status).toBe('exact_provider_historical');
    expect(v.valuedUsd).toBeCloseTo(420, 6);
    expect(v.confidence).toBeGreaterThanOrEqual(90);
  });

  it('PROVIDER VALUE: a positive provider USD is exact_provider_historical', () => {
    const v = computeValuation(input({ assetKind: 'native_sol', amountToken: 2, providerValueUsd: 320 }));
    expect(v.status).toBe('exact_provider_historical');
    expect(v.valuedUsd).toBe(320);
    expect(v.priceUsd).toBeCloseTo(160, 6);
    expect(v.source).toMatch(/provider/i);
  });

  it('PROVIDER ZERO is ignored (unpriced != real zero): falls through to unavailable', () => {
    const v = computeValuation(input({ assetKind: 'native_sol', amountToken: 1, providerValueUsd: 0, priorSnapshot: null, currentPrice: null }));
    expect(v.status).toBe('unavailable');
    expect(v.valuedUsd).toBeNull();
  });

  it('precedence: exact historical beats prior snapshot beats current estimate', () => {
    const v = computeValuation(
      input({
        amountToken: 1,
        historicalExact: { priceUsd: 140, ts: new Date(T.getTime() - 1000) },
        priorSnapshot: { priceUsd: 150, ts: new Date(T.getTime() - 60_000) },
        currentPrice: { priceUsd: 160, ts: T }
      })
    );
    expect(v.status).toBe('exact_provider_historical');
    expect(v.priceUsd).toBe(140);
  });
});
