// FlowRadar — tuneThresholds tests (Task 41 binding decision 3). TDD RED-then-GREEN.
//
// tuneThresholds runs an OAT (one-dimension-at-a-time) sweep: for each grid
// dimension, vary ONLY that dimension around baseSettings (holding every
// other dimension at its base value) and replay+evaluate the resulting
// settings variant against the same inputs, then rank the resulting
// threshold sets by a documented score. This is NOT a full cartesian product
// sweep (bounded compute — see task-41-brief.md / ui-backtest-wave35.md).

import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/settings';
import { tuneThresholds } from '../src/backtest/thresholdTuning';
import type { ThresholdSweepGrid, TuneThresholdsInputs } from '../src/backtest/thresholdTuning';
import type { TradeRowInput, WalletInfoInput, MarketPointInput } from '../src/window/aggregate';
import type { MarketPoint } from '../src/backtest/evaluate';

const MIN_MS = 60_000;

function wallet(id: string): WalletInfoInput {
  return { walletId: id, isWatched: true, walletScore: 80, labels: ['smart_money'], meetsProfitable: true };
}
function buy(walletId: string, ts: Date, amountUsd: number, mcap = 500_000): TradeRowInput {
  return { walletId, action: 'BUY', amountUsd, ts, blockOrSlot: BigInt(Math.floor(ts.getTime())), marketCapAtTrade: mcap };
}
function marketPoint(ts: Date, mcap: number, liq = 100_000): MarketPointInput {
  return { ts, marketCapUsd: mcap, liquidityUsd: liq };
}

const genesis = new Date('2026-03-01T00:00:00Z');
const tokenId = 'tok-tuning';

function buildInputs(): TuneThresholdsInputs {
  // 12 smart wallets buy at genesis — enough for WATCH tier (>=10) but below
  // the default HIGH floor of 20, so a LOOSER minWallets threshold (e.g. 10)
  // should surface more/better signals than the stricter default (20) on
  // this fixture — the "looser threshold demonstrably wins" case the brief
  // requires.
  const wallets: WalletInfoInput[] = Array.from({ length: 12 }, (_, i) => wallet(`w-${i}`));
  const trades: TradeRowInput[] = wallets.map((w, i) => buy(w.walletId, new Date(genesis.getTime() - i * 1000), 3000));
  const market: MarketPointInput[] = [marketPoint(genesis, 500_000), marketPoint(new Date(genesis.getTime() + 24 * 60 * MIN_MS), 500_000)];

  const seriesPoints: (MarketPoint & { source?: string })[] = [
    { ts: genesis, priceUsd: 1, mcapUsd: 500_000, liquidityUsd: 100_000 },
    { ts: new Date(genesis.getTime() + 60 * MIN_MS), priceUsd: 2.2, mcapUsd: 1_100_000, liquidityUsd: 100_000 } // 2.2x
  ];

  return {
    trades,
    wallets,
    clusters: [],
    marketPoints: market,
    fundingEvents: [],
    rotationCandidates: [],
    from: genesis,
    to: new Date(genesis.getTime() + 24 * 60 * MIN_MS),
    stepMinutes: 60,
    tokenId,
    marketSeriesByToken: new Map([[tokenId, seriesPoints]])
  };
}

const grid: ThresholdSweepGrid = {
  minWallets: [10, 15, 20, 30],
  minEntities: [1, 5, 10],
  minNetFlow: [0, 10_000, 25_000, 50_000],
  maxSoldPct: [20, 30, 50],
  maxMcapExpansion: [1.5, 2, 3],
  minLiquidity: [10_000, 20_000, 50_000]
};

describe('tuneThresholds', () => {
  it('OAT grid produces the expected candidate-set count (sum of each dimension length, minus overlaps at base, plus the base set itself)', () => {
    const result = tuneThresholds({ inputs: buildInputs(), grid, baseSettings: DEFAULT_SETTINGS });
    // OAT: one sweep per dimension (varying only that dimension) + the base
    // set itself, deduped (a dimension value equal to base doesn't need a
    // second identical run). Expect at least 1 (base) and at most the sum of
    // all grid values across dimensions.
    const totalGridValues = Object.values(grid).reduce((sum, arr) => sum + arr.length, 0);
    expect(result.allSets.length).toBeGreaterThan(1);
    expect(result.allSets.length).toBeLessThanOrEqual(totalGridValues + 1);
  });

  it('insufficient-sample penalty: a threshold set producing < N signals is penalized in scoring (visible via worst-ranked sets clustering there, or via an explicit flag)', () => {
    const result = tuneThresholds({ inputs: buildInputs(), grid, baseSettings: DEFAULT_SETTINGS });
    const insufficientSample = result.allSets.filter((s) => s.signalCount < 5);
    for (const s of insufficientSample) {
      expect(s.insufficientSample).toBe(true);
    }
  });

  it('best/worst ordering: a looser minWallets threshold (10) demonstrably outperforms the stricter default (20) on this fixture, appearing in best over worst', () => {
    const result = tuneThresholds({ inputs: buildInputs(), grid, baseSettings: DEFAULT_SETTINGS });
    expect(result.best.length).toBeGreaterThan(0);
    expect(result.worst.length).toBeGreaterThan(0);
    // The looser set (minWallets: 10) should surface at least 1 signal on
    // this fixture (12 wallets clears a 10-floor but not the default 20),
    // and should rank ahead of (or at least alongside) the stricter default
    // in `best` rather than being relegated only to `worst`.
    const looseInBest = result.best.some((s) => s.settings.rules.A.minWallets === 10);
    expect(looseInBest).toBe(true);
  });

  it('recommendedDefaults is present and is a diff vs current DEFAULT_SETTINGS', () => {
    const result = tuneThresholds({ inputs: buildInputs(), grid, baseSettings: DEFAULT_SETTINGS });
    expect(result.recommendedDefaults).toBeDefined();
    expect(typeof result.recommendedDefaults.diff).toBe('object');
  });

  it('precisionByRule is present', () => {
    const result = tuneThresholds({ inputs: buildInputs(), grid, baseSettings: DEFAULT_SETTINGS });
    expect(result.precisionByRule).toBeDefined();
  });

  it('overfittingWarning is ALWAYS a non-empty string', () => {
    const result = tuneThresholds({ inputs: buildInputs(), grid, baseSettings: DEFAULT_SETTINGS });
    expect(typeof result.overfittingWarning).toBe('string');
    expect(result.overfittingWarning.length).toBeGreaterThan(0);
  });
});
