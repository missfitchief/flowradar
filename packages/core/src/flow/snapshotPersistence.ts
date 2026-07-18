// FlowRadar — token-flow snapshot persistence decision (pure; sprint Task 0,
// TokenFlowSnapshot storage bound).
//
// MEASURED problem (2026-07-11, Segment B): full-success scoring writes ~639
// snapshot rows/min (~920k/day) and 98.8% of consecutive rows per token are
// BYTE-IDENTICAL on every compared field — the per-cycle write loop simply
// re-persists unchanged state.
//
// Fix = the smallest safe bound: suppress a new row ONLY when it is EXACTLY
// identical (every compared field, including signalStatus) to the token's
// latest persisted row AND the latest row is younger than the routine cadence.
// Everything else persists:
//   - first snapshot for a token            -> persist ('first')
//   - ANY compared field differs            -> persist ('changed') — this is
//     deliberately exact-match, not threshold-based, so no semantic drift:
//     a 0.01 score move persists. State transitions are a subset of this.
//   - unchanged but cadence elapsed         -> persist ('routine_heartbeat')
//     so freshness consumers still see a bounded-age row per token.
//   - unchanged within cadence              -> suppress ('suppressed_unchanged')
//
// signalStatus participates in the comparison: signalDetection UPDATES the
// latest row in place (packages/db/src/signals.ts), so a signal-revised row
// ('hot' etc.) never equals the scoring pass's 'watching' write — the next
// scoring row persists exactly as it does today. No signal or transition can
// be lost by suppression, because suppression requires byte-equality with
// what is already stored.

export interface FlowSnapshotComparable {
  ts: Date;
  windowMinutes: number;
  flowScore: number;
  smartWalletCount: number;
  humanLikeCount: number;
  possibleBotCount: number;
  uniqueEntityCount: number;
  /** USD/mcap fields persist as Decimal(20,4) — callers MUST pass them through
   *  quantizeToColumnScale so a float like 0.30000000000000004 compares equal
   *  to its own 0.3000 round-trip (Codex Important: raw-float comparison would
   *  silently defeat suppression on every cycle). */
  trackedBuyVolumeUsd: number;
  trackedSellVolumeUsd: number;
  netFlowUsd: number;
  buySellRatio: number;
  avgEntryMcap: number;
  currentMcap: number;
  mcapExpansionFromAvgEntry: number;
  liquidityChange: number;
  signalStatus: string;
  /** Canonical fingerprint of the persisted componentBreakdown JSON (score
   *  components + rolling accumulation metrics). Included because latest-row
   *  consumers (the Signal Feed) read this JSON — a change here MUST persist
   *  even when every scalar above is unchanged (e.g. smartWalletCount30m moves
   *  while the 24h counts don't). */
  componentsFingerprint: string;
}

/** Quantizes a float to the Decimal(20,4) column scale (4 dp, half-up like
 *  Postgres) so compare-before-write sees exactly what a round-trip stores. */
export function quantizeToColumnScale(x: number): number {
  return Math.round(x * 10_000) / 10_000;
}

/** Deterministic JSON stringify (recursively sorted keys) — object key order
 *  from a DB driver is not stable, so fingerprints must not depend on it. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(',')}}`;
}

export interface SnapshotPersistenceConfig {
  /** Max age (seconds) of an identical latest row before a heartbeat row is
   *  persisted anyway. Default 900 (15 min). */
  routineHeartbeatSec: number;
}

export const DEFAULT_SNAPSHOT_PERSISTENCE: SnapshotPersistenceConfig = { routineHeartbeatSec: 900 };

export type SnapshotPersistReason = 'first' | 'changed' | 'routine_heartbeat' | 'suppressed_unchanged';

export interface SnapshotPersistDecision {
  persist: boolean;
  reason: SnapshotPersistReason;
}

const COMPARED_FIELDS: (keyof Omit<FlowSnapshotComparable, 'ts'>)[] = [
  'windowMinutes',
  'flowScore',
  'smartWalletCount',
  'humanLikeCount',
  'possibleBotCount',
  'uniqueEntityCount',
  'trackedBuyVolumeUsd',
  'trackedSellVolumeUsd',
  'netFlowUsd',
  'buySellRatio',
  'avgEntryMcap',
  'currentMcap',
  'mcapExpansionFromAvgEntry',
  'liquidityChange',
  'signalStatus',
  'componentsFingerprint'
];

/** Exact equality over every compared field — NO thresholds, so suppression
 *  can never hide a real change however small. */
export function flowSnapshotsIdentical(prev: FlowSnapshotComparable, next: FlowSnapshotComparable): boolean {
  return COMPARED_FIELDS.every((f) => prev[f] === next[f]);
}

export function shouldPersistFlowSnapshot(
  prev: FlowSnapshotComparable | null,
  next: FlowSnapshotComparable,
  cfg: SnapshotPersistenceConfig = DEFAULT_SNAPSHOT_PERSISTENCE
): SnapshotPersistDecision {
  if (prev === null) return { persist: true, reason: 'first' };
  if (!flowSnapshotsIdentical(prev, next)) return { persist: true, reason: 'changed' };
  const ageSec = (next.ts.getTime() - prev.ts.getTime()) / 1000;
  if (ageSec >= cfg.routineHeartbeatSec) return { persist: true, reason: 'routine_heartbeat' };
  return { persist: false, reason: 'suppressed_unchanged' };
}

/** Persistence metrics a scoring pass reports — attempted/inserted must add up
 *  with suppressions so nothing is ever silently dropped. */
export interface SnapshotPersistenceMetrics {
  attempted: number;
  inserted: number;
  suppressedUnchanged: number;
  changedPersisted: number;
  routineHeartbeats: number;
  firstSnapshots: number;
  /** Persist decided yes but the DB insert threw — so the honest invariant is
   *  attempted == inserted + suppressedUnchanged + insertFailed. */
  insertFailed: number;
}

export function emptySnapshotPersistenceMetrics(): SnapshotPersistenceMetrics {
  return { attempted: 0, inserted: 0, suppressedUnchanged: 0, changedPersisted: 0, routineHeartbeats: 0, firstSnapshots: 0, insertFailed: 0 };
}
