// FlowRadar — pairBridgeLegRows tests (Task 24 review fix: extracted PURE
// pairing core shared by packages/db/src/bridgeFlow.ts's runBridgeFlow job
// pass and apps/web/app/flow/page.tsx's Money Flow bridge table). No prisma,
// no DB — plain in-memory BridgeLeg rows in, matched/unmatched split out.
//
// Tolerance mirrored here matches bridgeFlow.ts's own constants: same
// asset+bridgeProtocol, amount ratio in [95%,105%], time gap <60 minutes,
// closest-amount-ratio-first greedy one-to-one matching.

import { describe, expect, it } from 'vitest';
import { pairBridgeLegRows } from '../src/bridgeFlow';
import type { BridgeLeg } from '../src/bridgeFlow';

const MIN_MS = 60_000;

function leg(overrides: Partial<BridgeLeg> & { id: string }): BridgeLeg {
  return {
    sourceAddress: 'src-default',
    destinationAddress: 'dst-default',
    asset: 'USDC',
    amountUsd: 1000,
    ts: new Date('2026-01-01T00:00:00.000Z'),
    bridgeProtocol: 'Wormhole',
    ...overrides
  };
}

describe('pairBridgeLegRows', () => {
  it('pairs a deposit+withdrawal within tolerance (amount ratio, time, asset, protocol all match)', () => {
    const dep = leg({ id: 'dep-1', amountUsd: 1000, ts: new Date('2026-01-01T00:00:00.000Z') });
    const wd = leg({ id: 'wd-1', amountUsd: 970, ts: new Date('2026-01-01T00:25:00.000Z') });

    const result = pairBridgeLegRows([dep], [wd]);

    expect(result.matched).toHaveLength(1);
    expect(result.matched[0]).toEqual({ deposit: dep, withdrawal: wd });
    expect(result.unmatched).toHaveLength(0);
  });

  it('leaves a deposit unmatched when no withdrawal exists in-window', () => {
    const dep = leg({ id: 'dep-1' });

    const result = pairBridgeLegRows([dep], []);

    expect(result.matched).toHaveLength(0);
    expect(result.unmatched).toEqual([{ leg: dep, direction: 'deposit' }]);
  });

  it('leaves a withdrawal unmatched when no deposit exists in-window', () => {
    const wd = leg({ id: 'wd-1' });

    const result = pairBridgeLegRows([], [wd]);

    expect(result.matched).toHaveLength(0);
    expect(result.unmatched).toEqual([{ leg: wd, direction: 'withdrawal' }]);
  });

  it('rejects a pair outside the amount-ratio tolerance (94% < 95% floor)', () => {
    const dep = leg({ id: 'dep-1', amountUsd: 1000 });
    const wd = leg({ id: 'wd-1', amountUsd: 940, ts: new Date('2026-01-01T00:10:00.000Z') });

    const result = pairBridgeLegRows([dep], [wd]);

    expect(result.matched).toHaveLength(0);
    expect(result.unmatched).toHaveLength(2);
  });

  it('rejects a pair outside the 60-minute time window', () => {
    const dep = leg({ id: 'dep-1', ts: new Date('2026-01-01T00:00:00.000Z') });
    const wd = leg({ id: 'wd-1', ts: new Date('2026-01-01T01:01:00.000Z') }); // 61 min gap

    const result = pairBridgeLegRows([dep], [wd]);

    expect(result.matched).toHaveLength(0);
    expect(result.unmatched).toHaveLength(2);
  });

  it('does not pair across different bridgeProtocol values', () => {
    const dep = leg({ id: 'dep-1', bridgeProtocol: 'Wormhole' });
    const wd = leg({ id: 'wd-1', bridgeProtocol: 'LayerZero', ts: new Date('2026-01-01T00:10:00.000Z') });

    const result = pairBridgeLegRows([dep], [wd]);

    expect(result.matched).toHaveLength(0);
    expect(result.unmatched).toHaveLength(2);
  });

  it('does not pair across different assets', () => {
    const dep = leg({ id: 'dep-1', asset: 'USDC' });
    const wd = leg({ id: 'wd-1', asset: 'USDT', ts: new Date('2026-01-01T00:10:00.000Z') });

    const result = pairBridgeLegRows([dep], [wd]);

    expect(result.matched).toHaveLength(0);
    expect(result.unmatched).toHaveLength(2);
  });

  it('greedy closest-ratio-first: two candidate withdrawals for one deposit picks the closer amount match', () => {
    const dep = leg({ id: 'dep-1', amountUsd: 1000, ts: new Date('2026-01-01T00:00:00.000Z') });
    const wdFar = leg({ id: 'wd-far', amountUsd: 950, ts: new Date('2026-01-01T00:05:00.000Z') }); // ratio 95%
    const wdClose = leg({ id: 'wd-close', amountUsd: 990, ts: new Date('2026-01-01T00:05:00.000Z') }); // ratio 99%

    const result = pairBridgeLegRows([dep], [wdFar, wdClose]);

    expect(result.matched).toHaveLength(1);
    expect(result.matched[0]!.withdrawal.id).toBe('wd-close');
    expect(result.unmatched).toEqual([{ leg: wdFar, direction: 'withdrawal' }]);
  });

  it('one-to-one: a withdrawal already consumed by a better match cannot be reused', () => {
    const depA = leg({ id: 'dep-A', amountUsd: 1000, ts: new Date('2026-01-01T00:00:00.000Z') });
    const depB = leg({ id: 'dep-B', amountUsd: 1000, ts: new Date('2026-01-01T00:01:00.000Z') });
    const wd = leg({ id: 'wd-1', amountUsd: 1000, ts: new Date('2026-01-01T00:02:00.000Z') });

    const result = pairBridgeLegRows([depA, depB], [wd]);

    expect(result.matched).toHaveLength(1);
    // Both deposits tie on ratio (100%); exactly one wins the single withdrawal, the other is unmatched.
    const unmatchedIds = result.unmatched.map((u) => u.leg.id);
    expect(unmatchedIds).toHaveLength(1);
    expect(['dep-A', 'dep-B']).toContain(unmatchedIds[0]);
  });

  it('ignores non-positive amounts on either side', () => {
    const dep = leg({ id: 'dep-1', amountUsd: 0 });
    const wd = leg({ id: 'wd-1', amountUsd: 1000, ts: new Date('2026-01-01T00:05:00.000Z') });

    const result = pairBridgeLegRows([dep], [wd]);

    expect(result.matched).toHaveLength(0);
    expect(result.unmatched).toHaveLength(2);
  });

  it('empty input -> empty matched/unmatched', () => {
    const result = pairBridgeLegRows([], []);
    expect(result.matched).toHaveLength(0);
    expect(result.unmatched).toHaveLength(0);
  });

  it('exact 60-minute gap is still within window (boundary, <= not <)', () => {
    const dep = leg({ id: 'dep-1', ts: new Date('2026-01-01T00:00:00.000Z') });
    const wd = leg({ id: 'wd-1', ts: new Date(new Date('2026-01-01T00:00:00.000Z').getTime() + 60 * MIN_MS) });

    const result = pairBridgeLegRows([dep], [wd]);

    expect(result.matched).toHaveLength(1);
  });
});
