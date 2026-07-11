// FlowRadar — snapshot persistence decision tests (sprint Task 0).

import { describe, expect, it } from 'vitest';
import {
  shouldPersistFlowSnapshot,
  flowSnapshotsIdentical,
  DEFAULT_SNAPSHOT_PERSISTENCE
} from '../../src/flow/snapshotPersistence';
import type { FlowSnapshotComparable } from '../../src/flow/snapshotPersistence';

const T0 = new Date('2026-07-11T12:00:00Z');

function snap(over: Partial<FlowSnapshotComparable> = {}): FlowSnapshotComparable {
  return {
    ts: T0,
    windowMinutes: 1440,
    flowScore: 42.5,
    smartWalletCount: 3,
    humanLikeCount: 2,
    possibleBotCount: 0,
    uniqueEntityCount: 3,
    trackedBuyVolumeUsd: 5000,
    trackedSellVolumeUsd: 1000,
    netFlowUsd: 4000,
    buySellRatio: 5,
    avgEntryMcap: 100000,
    currentMcap: 200000,
    mcapExpansionFromAvgEntry: 1,
    liquidityChange: 0,
    signalStatus: 'watching',
    componentsFingerprint: '{"a":1}',
    ...over
  };
}

describe('shouldPersistFlowSnapshot', () => {
  it('first snapshot always persists', () => {
    expect(shouldPersistFlowSnapshot(null, snap())).toEqual({ persist: true, reason: 'first' });
  });

  it('ANY field change persists — exact match, no thresholds (0.01 score move counts)', () => {
    const prev = snap();
    expect(shouldPersistFlowSnapshot(prev, snap({ ts: new Date(T0.getTime() + 60_000), flowScore: 42.51 })).persist).toBe(true);
    expect(shouldPersistFlowSnapshot(prev, snap({ ts: new Date(T0.getTime() + 60_000), smartWalletCount: 4 })).persist).toBe(true);
    expect(shouldPersistFlowSnapshot(prev, snap({ ts: new Date(T0.getTime() + 60_000), netFlowUsd: 4000.01 })).persist).toBe(true);
  });

  it('a state transition ALWAYS persists (signalStatus participates in comparison)', () => {
    const prev = snap({ signalStatus: 'hot' }); // e.g. revised in place by signal detection
    const d = shouldPersistFlowSnapshot(prev, snap({ ts: new Date(T0.getTime() + 60_000), signalStatus: 'watching' }));
    expect(d).toEqual({ persist: true, reason: 'changed' });
  });

  it('an unchanged snapshot within the cadence is suppressed', () => {
    const prev = snap();
    const d = shouldPersistFlowSnapshot(prev, snap({ ts: new Date(T0.getTime() + 60_000) }));
    expect(d).toEqual({ persist: false, reason: 'suppressed_unchanged' });
  });

  it('an unchanged snapshot past the cadence persists as a routine heartbeat', () => {
    const prev = snap();
    const d = shouldPersistFlowSnapshot(prev, snap({ ts: new Date(T0.getTime() + (DEFAULT_SNAPSHOT_PERSISTENCE.routineHeartbeatSec + 1) * 1000) }));
    expect(d).toEqual({ persist: true, reason: 'routine_heartbeat' });
  });

  it('cadence boundary is inclusive (age == routineHeartbeatSec persists)', () => {
    const prev = snap();
    const d = shouldPersistFlowSnapshot(prev, snap({ ts: new Date(T0.getTime() + DEFAULT_SNAPSHOT_PERSISTENCE.routineHeartbeatSec * 1000) }));
    expect(d.persist).toBe(true);
  });

  it('decision is deterministic — same inputs, same output (replay safety)', () => {
    const prev = snap();
    const next = snap({ ts: new Date(T0.getTime() + 60_000) });
    const a = shouldPersistFlowSnapshot(prev, next);
    const b = shouldPersistFlowSnapshot(prev, next);
    expect(a).toEqual(b);
  });

  it('flowSnapshotsIdentical ignores ts (time alone is not a change)', () => {
    expect(flowSnapshotsIdentical(snap(), snap({ ts: new Date(T0.getTime() + 999_000) }))).toBe(true);
  });

  it('a componentBreakdown change persists even when every scalar is unchanged', () => {
    const prev = snap();
    const d = shouldPersistFlowSnapshot(prev, snap({ ts: new Date(T0.getTime() + 60_000), componentsFingerprint: '{"a":2}' }));
    expect(d).toEqual({ persist: true, reason: 'changed' });
  });

  it('quantizeToColumnScale makes a float equal to its own Decimal(20,4) round-trip', async () => {
    const { quantizeToColumnScale, stableStringify } = await import('../../src/flow/snapshotPersistence');
    expect(quantizeToColumnScale(0.1 + 0.2)).toBe(quantizeToColumnScale(0.3)); // 0.30000000000000004 vs 0.3
    expect(quantizeToColumnScale(4000.00009)).toBe(4000.0001);
    // stable stringify is key-order independent (DB drivers do not guarantee order)
    expect(stableStringify({ b: 1, a: { d: 2, c: [3, 1] } })).toBe(stableStringify({ a: { c: [3, 1], d: 2 }, b: 1 }));
  });
});
