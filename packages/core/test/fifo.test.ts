import { describe, expect, it } from 'vitest';
import { computeFifoPnl } from '../src/pnl/fifo';

describe('computeFifoPnl', () => {
  it('brief fixture: buy10@1 + buy10@2, sell15@3 -> realized 25 exactly', () => {
    // FIFO: sell15 consumes 10 units @$1 lot fully + 5 units @$2 lot partially.
    // realized = proceeds(15*3=45) - cost(10*1 + 5*2 = 20) = 25.
    const trades = [
      { action: 'BUY' as const, amountToken: 10, amountUsd: 10, ts: new Date('2026-07-05T00:00:00Z') },
      { action: 'BUY' as const, amountToken: 10, amountUsd: 20, ts: new Date('2026-07-05T00:01:00Z') },
      { action: 'SELL' as const, amountToken: 15, amountUsd: 45, ts: new Date('2026-07-05T00:02:00Z') }
    ];

    const result = computeFifoPnl(trades, 2.5);

    expect(result.realizedUsd).toBe(25);
  });

  it('brief fixture: unrealized = remaining inventory (5 units) * (currentPrice - 2)', () => {
    // Remaining inventory after the sell: 5 units left from the $2 lot
    // (cost basis $2/unit). unrealizedUsd = 5 * (currentPriceUsd - 2).
    const trades = [
      { action: 'BUY' as const, amountToken: 10, amountUsd: 10, ts: new Date('2026-07-05T00:00:00Z') },
      { action: 'BUY' as const, amountToken: 10, amountUsd: 20, ts: new Date('2026-07-05T00:01:00Z') },
      { action: 'SELL' as const, amountToken: 15, amountUsd: 45, ts: new Date('2026-07-05T00:02:00Z') }
    ];

    const currentPrice = 3;
    const result = computeFifoPnl(trades, currentPrice);

    // remaining 5 units, cost basis $2/unit -> unrealized = 5 * (3 - 2) = 5
    expect(result.unrealizedUsd).toBe(5 * (currentPrice - 2));
    expect(result.unrealizedUsd).toBe(5);
  });

  it('null currentPrice -> unrealizedUsd null and confidence reduced', () => {
    const trades = [
      { action: 'BUY' as const, amountToken: 10, amountUsd: 10, ts: new Date('2026-07-05T00:00:00Z') },
      { action: 'SELL' as const, amountToken: 5, amountUsd: 20, ts: new Date('2026-07-05T00:01:00Z') }
    ];

    const withPrice = computeFifoPnl(trades, 4);
    const withoutPrice = computeFifoPnl(trades, null);

    expect(withoutPrice.unrealizedUsd).toBeNull();
    expect(withoutPrice.confidence).toBeLessThan(withPrice.confidence);
    expect(withoutPrice.confidence).toBe(withPrice.confidence - 15);
  });

  it('sell exceeding inventory: matches what exists, ignores un-backed excess for realized PnL, and drops confidence', () => {
    // Only 10 units bought @$1; a sell of 15 units can only be matched
    // against the 10 units that exist. The excess 5 units are un-backed —
    // ignored for realized PnL purposes (not treated as a phantom loss/gain).
    const overSellTrades = [
      { action: 'BUY' as const, amountToken: 10, amountUsd: 10, ts: new Date('2026-07-05T00:00:00Z') },
      { action: 'SELL' as const, amountToken: 15, amountUsd: 45, ts: new Date('2026-07-05T00:01:00Z') }
    ];
    const exactTrades = [
      { action: 'BUY' as const, amountToken: 10, amountUsd: 10, ts: new Date('2026-07-05T00:00:00Z') },
      { action: 'SELL' as const, amountToken: 10, amountUsd: 30, ts: new Date('2026-07-05T00:01:00Z') }
    ];

    const overSold = computeFifoPnl(overSellTrades, 3);
    const exact = computeFifoPnl(exactTrades, 3);

    // realized should reflect only the backed 10 units: proceeds for those
    // 10 units is 10/15 * 45 = 30, cost 10*1=10 -> realized 20, matching the
    // exact-fixture's realized exactly (same backed lots, same per-unit sell price).
    expect(overSold.realizedUsd).toBe(exact.realizedUsd);
    expect(overSold.realizedUsd).toBe(20);

    // no remaining inventory in either case
    expect(overSold.unrealizedUsd).toBe(0);

    // confidence drops by 20 for the over-sell relative to the clean case
    expect(overSold.confidence).toBe(exact.confidence - 20);
  });

  it('win rate: a SELL whose proceeds exceed FIFO cost of consumed lots counts as a win', () => {
    const trades = [
      // lot 1: buy 10 @ $1/unit (cost $10)
      { action: 'BUY' as const, amountToken: 10, amountUsd: 10, ts: new Date('2026-07-05T00:00:00Z') },
      // winning sell: proceeds $30 for 10 units vs cost $10 -> win
      { action: 'SELL' as const, amountToken: 10, amountUsd: 30, ts: new Date('2026-07-05T00:01:00Z') },
      // lot 2: buy 10 @ $5/unit (cost $50)
      { action: 'BUY' as const, amountToken: 10, amountUsd: 50, ts: new Date('2026-07-05T00:02:00Z') },
      // losing sell: proceeds $20 for 10 units vs cost $50 -> loss
      { action: 'SELL' as const, amountToken: 10, amountUsd: 20, ts: new Date('2026-07-05T00:03:00Z') }
    ];

    const result = computeFifoPnl(trades, 1);

    // 1 win out of 2 sells -> winRate 0.5
    expect(result.winRate).toBe(0.5);
    expect(result.tradeCount).toBe(4);
  });

  it('confidence: fewer than 4 trades applies the -10 penalty; floor is 10', () => {
    const shortTrades = [
      { action: 'BUY' as const, amountToken: 10, amountUsd: 10, ts: new Date('2026-07-05T00:00:00Z') },
      { action: 'SELL' as const, amountToken: 10, amountUsd: 30, ts: new Date('2026-07-05T00:01:00Z') }
    ];
    const longTrades = [
      { action: 'BUY' as const, amountToken: 10, amountUsd: 10, ts: new Date('2026-07-05T00:00:00Z') },
      { action: 'SELL' as const, amountToken: 5, amountUsd: 15, ts: new Date('2026-07-05T00:01:00Z') },
      { action: 'BUY' as const, amountToken: 10, amountUsd: 10, ts: new Date('2026-07-05T00:02:00Z') },
      { action: 'SELL' as const, amountToken: 5, amountUsd: 15, ts: new Date('2026-07-05T00:03:00Z') }
    ];

    const short = computeFifoPnl(shortTrades, 3);
    const long = computeFifoPnl(longTrades, 3);

    // baseline (>=4 trades, no over-sell, price present) starts at 90
    expect(long.confidence).toBe(90);
    // <4 trades -> -10 from baseline
    expect(short.confidence).toBe(80);

    // stacking every penalty (over-sell -20, null price -15, <4 trades -10)
    // from a 90 baseline floors at 10, never goes negative.
    const worst = computeFifoPnl(
      [
        { action: 'BUY' as const, amountToken: 10, amountUsd: 10, ts: new Date('2026-07-05T00:00:00Z') },
        { action: 'SELL' as const, amountToken: 999, amountUsd: 999, ts: new Date('2026-07-05T00:01:00Z') }
      ],
      null
    );
    expect(worst.confidence).toBeGreaterThanOrEqual(10);
  });

  it('no trades -> zero realized, zero tradeCount, winRate defined (0) not NaN', () => {
    const result = computeFifoPnl([], 5);

    expect(result.realizedUsd).toBe(0);
    expect(result.tradeCount).toBe(0);
    expect(result.winRate).toBe(0);
    expect(Number.isNaN(result.winRate)).toBe(false);
  });
});
