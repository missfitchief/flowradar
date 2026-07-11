// FlowRadar — runner-mining shared types + config (Task 2).
// See docs/RUNNER_MINING_DESIGN.md. entry.ts (entry-time features) and
// outcome.ts (evaluation-only labels) both depend on THIS file and never on
// each other — the import direction is the no-lookahead wall, enforced by a
// static guard test (runnerMiningLeakGuard).

export interface TokenSeriesPoint {
  ts: Date;
  priceUsd: number | null;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
}

export interface RunnerMiningConfig {
  /** Runner multiples measured from the BASELINE (first valid mcap observation). */
  runnerMultiples: { x2: number; x5: number; x10: number; x50: number };
  /** Absolute mcap milestones (USD). */
  mcapMilestones: { m1: number; m10: number; m100: number };
  /** ATH-mcap bands for the figure-class labels [min, max). */
  sevenFigureBand: { min: number; max: number };
  eightFigureBand: { min: number; max: number };
  /** Peak-to-trough decline (percent) at/above which the token is a rug/collapse. */
  rugCollapsePct: number;
  /** Liquidity floor (USD): below it a market is not really tradeable. */
  liquidityFloorUsd: number;
  /** Minimum valid-mcap points a series needs before any judgment. Must be >= 1. */
  minSeriesPoints: number;
  /** Max age of the nearest-prior snapshot still usable at entry (seconds). Finite, >= 0. */
  maxEntrySnapshotAgeSec: number;
  /** The research focus ceiling (spec: $20k, configurable). */
  lowMcapFocusCeilingUsd: number;
}

export const DEFAULT_RUNNER_MINING_CONFIG: RunnerMiningConfig = {
  runnerMultiples: { x2: 2, x5: 5, x10: 10, x50: 50 },
  mcapMilestones: { m1: 1_000_000, m10: 10_000_000, m100: 100_000_000 },
  sevenFigureBand: { min: 1_000_000, max: 10_000_000 },
  eightFigureBand: { min: 10_000_000, max: 100_000_000 },
  rugCollapsePct: 90,
  liquidityFloorUsd: 1_000,
  minSeriesPoints: 3,
  maxEntrySnapshotAgeSec: 3_600,
  lowMcapFocusCeilingUsd: 20_000
};
Object.freeze(DEFAULT_RUNNER_MINING_CONFIG.runnerMultiples);
Object.freeze(DEFAULT_RUNNER_MINING_CONFIG.mcapMilestones);
Object.freeze(DEFAULT_RUNNER_MINING_CONFIG.sevenFigureBand);
Object.freeze(DEFAULT_RUNNER_MINING_CONFIG.eightFigureBand);
Object.freeze(DEFAULT_RUNNER_MINING_CONFIG);

/**
 * FAIL-CLOSED config validation (Codex: unvalidated caller configs could
 * crash on empty series, or NaN/Infinity ages could silently accept
 * arbitrarily stale snapshots). Both engines call this first.
 */
export function validateRunnerMiningConfig(cfg: RunnerMiningConfig): void {
  const finitePos = (v: number, name: string) => {
    if (!Number.isFinite(v) || v <= 0) throw new RangeError(`runner-mining config ${name} must be a finite positive number, got ${v}`);
  };
  finitePos(cfg.runnerMultiples.x2, 'runnerMultiples.x2');
  finitePos(cfg.runnerMultiples.x5, 'runnerMultiples.x5');
  finitePos(cfg.runnerMultiples.x10, 'runnerMultiples.x10');
  finitePos(cfg.runnerMultiples.x50, 'runnerMultiples.x50');
  finitePos(cfg.mcapMilestones.m1, 'mcapMilestones.m1');
  finitePos(cfg.mcapMilestones.m10, 'mcapMilestones.m10');
  finitePos(cfg.mcapMilestones.m100, 'mcapMilestones.m100');
  finitePos(cfg.sevenFigureBand.min, 'sevenFigureBand.min');
  finitePos(cfg.sevenFigureBand.max, 'sevenFigureBand.max');
  finitePos(cfg.eightFigureBand.min, 'eightFigureBand.min');
  finitePos(cfg.eightFigureBand.max, 'eightFigureBand.max');
  finitePos(cfg.rugCollapsePct, 'rugCollapsePct');
  finitePos(cfg.liquidityFloorUsd, 'liquidityFloorUsd');
  finitePos(cfg.lowMcapFocusCeilingUsd, 'lowMcapFocusCeilingUsd');
  if (!Number.isInteger(cfg.minSeriesPoints) || cfg.minSeriesPoints < 1) {
    throw new RangeError(`runner-mining config minSeriesPoints must be an integer >= 1, got ${cfg.minSeriesPoints}`);
  }
  if (!Number.isFinite(cfg.maxEntrySnapshotAgeSec) || cfg.maxEntrySnapshotAgeSec < 0) {
    throw new RangeError(`runner-mining config maxEntrySnapshotAgeSec must be finite and >= 0, got ${cfg.maxEntrySnapshotAgeSec}`);
  }
}
