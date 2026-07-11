// FlowRadar — behavior reconstruction + hold/dump classifier tests (Tasks 3-4).

import { describe, expect, it } from 'vitest';
import { reconstructBehaviorProfile } from '../../src/behavior/reconstruct';
import type { BehaviorInputs, LocalTradeInput } from '../../src/behavior/reconstruct';
import { classifyHoldBehavior, computeHoldMetrics, HOLD_CLASSIFIER_VERSION } from '../../src/behavior/holdClassifier';

const NOW = new Date('2026-07-11T12:00:00Z');

function inputs(over: Partial<BehaviorInputs> = {}): BehaviorInputs {
  return {
    chain: 'SOLANA',
    address: 'W1',
    localTrades: [],
    providerActivity: [],
    providerStats: [],
    fundingEdges: [],
    now: NOW,
    ...over
  };
}

function trade(tokenAddress: string, action: 'BUY' | 'SELL', usd: number, tsOffsetSec: number, mcap: number | null = null): LocalTradeInput {
  return { tokenAddress, action, amountUsd: usd, ts: new Date(NOW.getTime() - tsOffsetSec * 1000), marketCapAtTrade: mcap };
}

describe('reconstructBehaviorProfile', () => {
  it('never fabricates: empty inputs -> unknown fields, insufficient quality', () => {
    const p = reconstructBehaviorProfile(inputs());
    expect(p.dataQuality).toBe('insufficient');
    expect(p.local.tradeCount.value).toBeNull();
    expect(p.local.tradeCount.provenance).toBe('unknown');
    expect(p.provider.pnlUsd.value).toBeNull();
    expect(p.provider.pnlUsd.provenance).toBe('unknown');
    expect(p.funding.inflowCount.provenance).toBe('unknown');
    expect(p.conflicts.length).toBe(0);
  });

  it('keeps provider claims OUT of local fields (provenance separation)', () => {
    const p = reconstructBehaviorProfile(inputs({
      providerStats: [{ source: 'gmgn:wallet stats', pnlUsd: 50000, winRate: 0.9, tradeCount: 400, observedAt: NOW }]
    }));
    expect(p.dataQuality).toBe('provider_only');
    expect(p.provider.pnlUsd.value).toBe(50000);
    expect(p.provider.pnlUsd.provenance).toBe('provider_claimed');
    expect(p.provider.pnlUsd.confidence).toBeLessThanOrEqual(60); // claims never reach local confidence
    expect(p.local.tradeCount.value).toBeNull(); // 400 claimed trades did NOT become local trades
  });

  it('computes token positions: exits, holds, repeat entries, received-not-bought', () => {
    const p = reconstructBehaviorProfile(inputs({
      localTrades: [
        // T1: buy then full exit after 2h
        trade('T1', 'BUY', 1000, 7200 + 3600),
        trade('T1', 'SELL', 1000, 3600),
        // T2: two buys (repeat entry), partial exit 50%
        trade('T2', 'BUY', 500, 86400 * 2),
        trade('T2', 'BUY', 500, 86400),
        trade('T2', 'SELL', 500, 1800),
        // T3: sell with NO buy — received, not bought
        trade('T3', 'SELL', 300, 900)
      ]
    }));
    const byToken = Object.fromEntries(p.local.tokenPositions.map((t) => [t.tokenAddress, t]));
    expect(byToken.T1.exitRatio).toBe(1);
    expect(byToken.T1.holdDurationSec).toBe(7200);
    expect(byToken.T2.repeatedEntry).toBe(true);
    expect(byToken.T2.exitRatio).toBe(0.5);
    expect(byToken.T2.stillHolding).toBe(true);
    expect(byToken.T3.receivedNotBought).toBe(true);
    expect(byToken.T3.exitRatio).toBeNull(); // no buy -> exit ratio undefined, not 0
    expect(p.local.fullExits.value).toBe(1);
    expect(p.local.partialExits.value).toBe(1);
    expect(p.dataQuality).toBe('local_only');
  });

  it('surfaces provider/local conflicts instead of reconciling them', () => {
    const manyLocal = Array.from({ length: 40 }, (_, i) => trade(`TK${i}`, 'BUY', 100, i * 60 + 60));
    const p = reconstructBehaviorProfile(inputs({
      localTrades: manyLocal,
      providerStats: [{ source: 'gmgn:wallet stats', pnlUsd: null, winRate: null, tradeCount: 400, observedAt: NOW }]
    }));
    expect(p.conflicts.some((c) => c.field === 'tradeCount')).toBe(true);
    const c = p.conflicts.find((x) => x.field === 'tradeCount')!;
    expect(c.providerValue).toBe(400);
    expect(c.localValue).toBe(40);
  });
});

describe('classifyHoldBehavior', () => {
  it('empty profile -> insufficient_history, and NOTHING grants eligibility', () => {
    const r = classifyHoldBehavior(reconstructBehaviorProfile(inputs()));
    expect(r.labels[0].label).toBe('insufficient_history');
    expect(r.grantsEligibility).toBe(false);
    expect(r.classifierVersion).toBe(HOLD_CLASSIFIER_VERSION);
  });

  it('fast flipper: majority of first sells within 30m', () => {
    const trades: LocalTradeInput[] = [];
    for (let i = 0; i < 5; i++) {
      trades.push(trade(`F${i}`, 'BUY', 100, 86400 + i * 3600));
      trades.push(trade(`F${i}`, 'SELL', 120, 86400 + i * 3600 - 300)); // sells 5 min after buy
    }
    const r = classifyHoldBehavior(reconstructBehaviorProfile(inputs({ localTrades: trades })), { now: NOW });
    expect(r.labels[0].label).toBe('fast_flipper');
    expect(r.labels[0].componentMetrics.pctFirstSellWithin30m).toBe(1);
    expect(r.labels[0].exampleTokens.length).toBeGreaterThan(0);
    expect(r.labels[0].caveats.length).toBeGreaterThan(0);
  });

  it('durable holder: aged positions still held (holding labeled neutrally, with caveats)', () => {
    const trades: LocalTradeInput[] = [];
    for (let i = 0; i < 4; i++) trades.push(trade(`H${i}`, 'BUY', 100, 86400 * 10 + i)); // bought 10 days ago, never sold
    const profile = reconstructBehaviorProfile(inputs({ localTrades: trades }));
    // medianHoldSec is null (no sells) -> durable requires holds; use metrics directly
    const m = computeHoldMetrics(profile, { now: NOW });
    expect(m.pctHeldAfter24h).toBe(1); // all aged positions held past 24h
    const r = classifyHoldBehavior(profile, { now: NOW });
    // With zero sells on aged positions this is ALSO the stuck shape — either
    // label is acceptable as primary, but no praise-only framing:
    expect(['illiquid_stuck_holder', 'durable_holder', 'promising_low_sample']).toContain(r.labels[0].label);
    expect(r.labels[0].caveats.join(' ')).toMatch(/liquidity|unknown|partial/i);
  });

  it('low sample gates confidence: 2 bought tokens -> promising_low_sample or low-confidence flipper', () => {
    const trades = [
      trade('A', 'BUY', 100, 7200),
      trade('A', 'SELL', 150, 3600),
      trade('B', 'BUY', 100, 7200)
    ];
    const r = classifyHoldBehavior(reconstructBehaviorProfile(inputs({ localTrades: trades })), { now: NOW });
    expect(r.metrics.sampleSize).toBe(2);
    expect(r.labels[0].confidence).toBeLessThanOrEqual(40);
  });

  it('received_not_bought dominates when most positions were never bought', () => {
    const trades = [
      trade('R1', 'SELL', 100, 3600),
      trade('R2', 'SELL', 100, 1800),
      trade('R3', 'BUY', 50, 7200)
    ];
    const r = classifyHoldBehavior(reconstructBehaviorProfile(inputs({ localTrades: trades })), { now: NOW });
    expect(r.labels.some((l) => l.label === 'received_not_bought')).toBe(true);
  });

  it('unknowables stay null with caveats: 2x/5x retention and exit liquidity are never fabricated', () => {
    const trades = [trade('X', 'BUY', 100, 3600)];
    const r = classifyHoldBehavior(reconstructBehaviorProfile(inputs({ localTrades: trades })), { now: NOW });
    expect(r.metrics.retainedAfter2x).toBeNull();
    expect(r.metrics.retainedAfter5x).toBeNull();
    expect(r.metrics.exitLiquidityKnown).toBe(false);
    expect(r.metrics.rugExposurePct).toBeNull(); // no outcome data supplied
  });

  it('rug exposure appears ONLY when outcome data is supplied', () => {
    const trades = [
      trade('RUG1', 'BUY', 100, 86400 * 8), trade('RUG1', 'SELL', 10, 86400 * 7),
      trade('OK1', 'BUY', 100, 86400 * 8), trade('OK1', 'SELL', 150, 86400 * 6),
      trade('OK2', 'BUY', 100, 86400 * 8), trade('OK2', 'SELL', 120, 86400 * 5)
    ];
    const r = classifyHoldBehavior(reconstructBehaviorProfile(inputs({ localTrades: trades })), {
      now: NOW,
      tokenOutcomes: { RUG1: 'rug', OK1: 'runner', OK2: 'flat' }
    });
    expect(r.metrics.rugExposurePct).toBeCloseTo(1 / 3, 5);
  });

  it('dirty data (multiple conflicts) yields rejected_dirty_data', () => {
    const manyLocal: LocalTradeInput[] = [];
    for (let i = 0; i < 20; i++) {
      manyLocal.push(trade(`C${i}`, 'BUY', 1000, 86400 + i * 60));
      manyLocal.push(trade(`C${i}`, 'SELL', 10, 3600 + i * 60)); // local proxy strongly negative
    }
    const profile = reconstructBehaviorProfile(inputs({
      localTrades: manyLocal,
      providerStats: [{ source: 'gmgn:wallet stats', pnlUsd: 999999, winRate: 0.99, tradeCount: 500, observedAt: NOW }]
    }));
    expect(profile.conflicts.length).toBeGreaterThanOrEqual(2); // tradeCount + pnl sign
    const r = classifyHoldBehavior(profile, { now: NOW });
    expect(r.labels.some((l) => l.label === 'rejected_dirty_data')).toBe(true);
  });
});
