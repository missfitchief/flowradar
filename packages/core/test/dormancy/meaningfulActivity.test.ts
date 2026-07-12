// FlowRadar — meaningful-activity classifier tests (dormancy Task 6, pure).
//
// The classifier is the gatekeeper for all dormancy math: these tests pin the
// honesty branches — unknown valuation is NEVER dust/meaningful, service and
// self-transfers never count, thresholds are configurable, every decision is
// versioned and receipted.

import { describe, expect, it } from 'vitest';
import {
  classifyActivityEvent,
  classifyActivityEvents,
  DEFAULT_MEANINGFUL_ACTIVITY_CONFIG,
  MEANINGFUL_ACTIVITY_RULES_VERSION
} from '../../src/dormancy/meaningfulActivity';
import type { ActivityEvent } from '../../src/dormancy/meaningfulActivity';

const TS = new Date('2026-07-01T00:00:00Z');

function ev(over: Partial<ActivityEvent> = {}): ActivityEvent {
  return { kind: 'trade', role: 'BUY', usd: 100, ts: TS, txHash: 'tx1', tokenAddress: 'MintA', ...over };
}

describe('classifyActivityEvent', () => {
  it('classifies a known-value trade above the dust threshold as meaningful_trade', () => {
    const d = classifyActivityEvent(ev());
    expect(d.classification).toBe('meaningful_trade');
    expect(d.meaningful).toBe(true);
    expect(d.reasonCodes).toContain('value_above_dust_threshold');
    expect(d.ruleVersion).toBe(MEANINGFUL_ACTIVITY_RULES_VERSION);
    expect(d.receipt.txHash).toBe('tx1');
    expect(d.receipt.dustMaxUsd).toBe(DEFAULT_MEANINGFUL_ACTIVITY_CONFIG.dustMaxUsd);
  });

  it('classifies a known-value transfer above the threshold as meaningful_transfer', () => {
    const d = classifyActivityEvent(ev({ kind: 'transfer', role: 'in', usd: 50, counterpartyAddress: 'CpA' }));
    expect(d.classification).toBe('meaningful_transfer');
    expect(d.meaningful).toBe(true);
  });

  it('dust boundary matches lineage semantics: <= dustMaxUsd is dust, above is meaningful', () => {
    expect(classifyActivityEvent(ev({ usd: 1 })).classification).toBe('dust');
    expect(classifyActivityEvent(ev({ usd: 0 })).classification).toBe('dust');
    expect(classifyActivityEvent(ev({ usd: 1.01 })).classification).toBe('meaningful_trade');
  });

  it('dust threshold is configurable', () => {
    expect(classifyActivityEvent(ev({ usd: 4 }), { dustMaxUsd: 5 }).classification).toBe('dust');
    expect(classifyActivityEvent(ev({ usd: 6 }), { dustMaxUsd: 5 }).classification).toBe('meaningful_trade');
  });

  it('inbound dust transfers carry the possible-spam reason code', () => {
    const d = classifyActivityEvent(ev({ kind: 'transfer', role: 'in', usd: 0.1, counterpartyAddress: 'CpA' }));
    expect(d.classification).toBe('dust');
    expect(d.reasonCodes).toContain('inbound_dust_possible_spam');
    const out = classifyActivityEvent(ev({ kind: 'transfer', role: 'out', usd: 0.1, counterpartyAddress: 'CpA' }));
    expect(out.reasonCodes).not.toContain('inbound_dust_possible_spam');
  });

  it('missing valuation is unknown_value — NEVER dust, NEVER meaningful, low confidence', () => {
    const d = classifyActivityEvent(ev({ kind: 'transfer', role: 'in', usd: null, counterpartyAddress: 'CpA' }));
    expect(d.classification).toBe('unknown_value');
    expect(d.meaningful).toBe(false);
    expect(d.reasonCodes).toContain('valuation_unavailable');
    expect(d.confidence).toBeLessThanOrEqual(30);
  });

  it('service counterparties classify as service_interaction regardless of value', () => {
    for (const usd of [0.5, 50_000, null]) {
      const d = classifyActivityEvent(
        ev({
          kind: 'transfer',
          role: 'out',
          usd,
          counterpartyAddress: 'CexHot',
          counterpartyIsService: true,
          counterpartyServiceBasis: 'address_registry:CEX'
        })
      );
      expect(d.classification).toBe('service_interaction');
      expect(d.meaningful).toBe(false);
      expect(d.receipt.counterpartyServiceBasis).toBe('address_registry:CEX');
    }
  });

  it('self-transfers are non_economic even at high value', () => {
    const d = classifyActivityEvent(ev({ kind: 'transfer', role: 'in', usd: 100_000, selfTransfer: true }));
    expect(d.classification).toBe('non_economic');
    expect(d.meaningful).toBe(false);
  });

  it('a transfer whose counterparty cannot be named is unknown_counterparty — never meaningful, whatever its value', () => {
    for (const usd of [5, 50_000, null]) {
      const d = classifyActivityEvent(ev({ kind: 'transfer', role: 'in', usd, counterpartyKnown: false }));
      expect(d.classification).toBe('unknown_counterparty');
      expect(d.meaningful).toBe(false);
      expect(d.reasonCodes).toContain('counterparty_unavailable');
    }
  });

  it('malformed rows are artifacts (missing tx hash, invalid ts, negative or non-finite value)', () => {
    expect(classifyActivityEvent(ev({ txHash: '' })).classification).toBe('artifact');
    expect(classifyActivityEvent(ev({ ts: new Date(NaN) })).classification).toBe('artifact');
    expect(classifyActivityEvent(ev({ usd: -5 })).classification).toBe('artifact');
    expect(classifyActivityEvent(ev({ usd: Number.NaN })).classification).toBe('artifact');
    const d = classifyActivityEvent(ev({ txHash: '', usd: -5 }));
    expect(d.reasonCodes).toEqual(expect.arrayContaining(['missing_tx_hash', 'negative_value']));
  });

  it('a weak valuation confidence weakens value-based decisions (floor 30)', () => {
    const weak = classifyActivityEvent(ev({ kind: 'transfer', role: 'in', usd: 500, valuationConfidence: 40 }));
    expect(weak.classification).toBe('meaningful_transfer');
    expect(weak.confidence).toBe(40);
    const floor = classifyActivityEvent(ev({ usd: 500, valuationConfidence: 5 }));
    expect(floor.confidence).toBe(30);
    const strong = classifyActivityEvent(ev({ usd: 500, valuationConfidence: 99 }));
    expect(strong.confidence).toBe(90);
  });

  it('batch wrapper tallies classes and meaningful count', () => {
    const summary = classifyActivityEvents([
      ev(),
      ev({ usd: 0.5, txHash: 'tx2' }),
      ev({ kind: 'transfer', role: 'in', usd: null, txHash: 'tx3' })
    ]);
    expect(summary.byClass).toEqual({ meaningful_trade: 1, dust: 1, unknown_value: 1 });
    expect(summary.meaningfulCount).toBe(1);
    expect(summary.decisions).toHaveLength(3);
  });
});
