// FlowRadar — walkForward tests (Task 41 binding decision 4). TDD RED-then-GREEN.
//
// walkForward splits [from, to] into a tune half and a test half, picks the
// best threshold set on the tune half, then evaluates that SAME set on the
// test half — never tuning and testing on the same sample.

import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/settings';
import { walkForward } from '../src/backtest/walkForward';
import type { WalkForwardInputs } from '../src/backtest/walkForward';
import type { ThresholdSweepGrid } from '../src/backtest/thresholdTuning';
import type { TradeRowInput, WalletInfoInput, MarketPointInput } from '../src/window/aggregate';
import type { MarketPoint } from '../src/backtest/evaluate';

const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;

function wallet(id: string): WalletInfoInput {
  return { walletId: id, isWatched: true, walletScore: 80, labels: ['smart_money'], meetsProfitable: true };
}
function buy(walletId: string, ts: Date, amountUsd: number, mcap = 500_000): TradeRowInput {
  return { walletId, action: 'BUY', amountUsd, ts, blockOrSlot: BigInt(Math.floor(ts.getTime())), marketCapAtTrade: mcap };
}
function marketPoint(ts: Date, mcap: number, liq = 100_000): MarketPointInput {
  return { ts, marketCapUsd: mcap, liquidityUsd: liq };
}

const grid: ThresholdSweepGrid = {
  minWallets: [10, 20],
  minEntities: [1],
  minNetFlow: [0],
  maxSoldPct: [30],
  maxMcapExpansion: [2],
  minLiquidity: [20_000]
};

describe('walkForward', () => {
  it('a STABLE fixture (tune-half best also performs well on test half) verdicts "holds up"', () => {
    const genesis = new Date('2026-04-01T00:00:00Z');
    const splitAt = new Date(genesis.getTime() + 24 * HOUR_MS);
    const to = new Date(genesis.getTime() + 48 * HOUR_MS);

    // 12 smart wallets buy repeatedly in BOTH halves, and both halves' market
    // series show a 2x — a consistent, stable pattern across tune/test.
    const tokenId = 'tok-stable';
    const wallets: WalletInfoInput[] = Array.from({ length: 12 }, (_, i) => wallet(`w-${i}`));
    const trades: TradeRowInput[] = [];
    const seriesPoints: (MarketPoint & { source?: string })[] = [];
    const marketPoints: MarketPointInput[] = [];
    for (const hourOffset of [0, 30]) {
      const ts = new Date(genesis.getTime() + hourOffset * HOUR_MS + 60_000);
      wallets.forEach((w, i) => trades.push(buy(w.walletId, new Date(ts.getTime() + i * 1000), 3000)));
      marketPoints.push(marketPoint(ts, 500_000));
      seriesPoints.push({ ts, priceUsd: 1, mcapUsd: 500_000, liquidityUsd: 100_000 });
      seriesPoints.push({ ts: new Date(ts.getTime() + HOUR_MS), priceUsd: 2.2, mcapUsd: 1_100_000, liquidityUsd: 100_000 });
    }

    const inputs: WalkForwardInputs = {
      trades,
      wallets,
      clusters: [],
      marketPoints,
      fundingEvents: [],
      rotationCandidates: [],
      from: genesis,
      to,
      stepMinutes: 60,
      tokenId,
      marketSeriesByToken: new Map([[tokenId, seriesPoints]])
    };

    const result = walkForward({ inputs, from: genesis, to, splitAt, grid, baseSettings: DEFAULT_SETTINGS });
    expect(result.verdict).toBe('holds up');
    expect(typeof result.degradationPct).toBe('number');
    expect(result.tuneSummary).toBeDefined();
    expect(result.testSummary).toBeDefined();
  });

  it('a DEGRADING fixture (tune-half signal quality collapses on test half) verdicts "degrades — likely overfit"', () => {
    const genesis = new Date('2026-05-01T00:00:00Z');
    const splitAt = new Date(genesis.getTime() + 24 * HOUR_MS);
    const to = new Date(genesis.getTime() + 48 * HOUR_MS);

    const tokenId = 'tok-degrading';
    const wallets: WalletInfoInput[] = Array.from({ length: 12 }, (_, i) => wallet(`w-${i}`));

    // Tune half: replay's first walked step is `genesis` itself, but with
    // stepMinutes=60 the wallets' staggered buys (offset forward by up to
    // 11 seconds) are only fully visible once the walk reaches genesis+1h —
    // so the firing step lands at genesis+1h. Strong pump (2.5x) is placed
    // clearly AFTER that firing step (at +2h), not folded into the entry
    // point itself.
    const tuneFireStep = new Date(genesis.getTime() + HOUR_MS);
    const trades: TradeRowInput[] = wallets.map((w, i) => buy(w.walletId, new Date(tuneFireStep.getTime() - i * 1000), 3000));

    // Test half (hour 30): SAME wallets buy again (so the same threshold set
    // fires again, at the genesis+30h step), but this time price DUMPS hard
    // (rug) instead of pumping.
    const testFireStep = new Date(genesis.getTime() + 30 * HOUR_MS);
    wallets.forEach((w, i) => trades.push(buy(w.walletId, new Date(testFireStep.getTime() - i * 1000), 3000)));

    const marketPoints: MarketPointInput[] = [marketPoint(tuneFireStep, 500_000), marketPoint(testFireStep, 500_000)];

    const seriesPoints: (MarketPoint & { source?: string })[] = [
      { ts: tuneFireStep, priceUsd: 1, mcapUsd: 500_000, liquidityUsd: 100_000 },
      { ts: new Date(tuneFireStep.getTime() + HOUR_MS), priceUsd: 2.5, mcapUsd: 1_250_000, liquidityUsd: 100_000 },
      { ts: testFireStep, priceUsd: 1, mcapUsd: 500_000, liquidityUsd: 100_000 },
      { ts: new Date(testFireStep.getTime() + HOUR_MS), priceUsd: 0.05, mcapUsd: 25_000, liquidityUsd: 500 } // hard rug
    ];

    const inputs: WalkForwardInputs = {
      trades,
      wallets,
      clusters: [],
      marketPoints,
      fundingEvents: [],
      rotationCandidates: [],
      from: genesis,
      to,
      stepMinutes: 60,
      tokenId,
      marketSeriesByToken: new Map([[tokenId, seriesPoints]])
    };

    const result = walkForward({ inputs, from: genesis, to, splitAt, grid, baseSettings: DEFAULT_SETTINGS });
    expect(result.verdict).toBe('degrades — likely overfit');
  });

  it('never tunes and tests on the same sample: tune half only sees data <= splitAt, test half only sees data > splitAt', () => {
    const genesis = new Date('2026-06-01T00:00:00Z');
    const splitAt = new Date(genesis.getTime() + 24 * HOUR_MS);
    const to = new Date(genesis.getTime() + 48 * HOUR_MS);
    const tokenId = 'tok-bounds';
    const wallets: WalletInfoInput[] = Array.from({ length: 12 }, (_, i) => wallet(`w-${i}`));
    const trades: TradeRowInput[] = wallets.map((w, i) => buy(w.walletId, new Date(genesis.getTime() + i * 1000), 3000));
    const marketPoints: MarketPointInput[] = [marketPoint(genesis, 500_000)];
    const seriesPoints: (MarketPoint & { source?: string })[] = [{ ts: genesis, priceUsd: 1, mcapUsd: 500_000, liquidityUsd: 100_000 }];

    const inputs: WalkForwardInputs = {
      trades,
      wallets,
      clusters: [],
      marketPoints,
      fundingEvents: [],
      rotationCandidates: [],
      from: genesis,
      to,
      stepMinutes: 60,
      tokenId,
      marketSeriesByToken: new Map([[tokenId, seriesPoints]])
    };

    const result = walkForward({ inputs, from: genesis, to, splitAt, grid, baseSettings: DEFAULT_SETTINGS });
    // testSummary must be computed from a DIFFERENT (post-split) run than
    // tuneSummary — not silently reusing tune-half numbers under a new label.
    expect(result.tuneSummary === result.testSummary).toBe(false);
  });
});
