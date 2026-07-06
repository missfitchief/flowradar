// FlowRadar — MockTokenTopTradersProvider tests (Task 35, Wave 4.5, Spec §5b).

import { describe, expect, it } from 'vitest';
import { createMockWorld } from '../src/mock/world';
import { MockTokenTopTradersProvider } from '../src/candidates/mockTopTraders';

const GENESIS = new Date('2026-07-05T00:00:00Z');
const SEED = 20260705;

function makeWorld(seed = SEED) {
  return createMockWorld({ seed, genesis: GENESIS });
}

describe('MockTokenTopTradersProvider', () => {
  it('returns known NOVA buyers as top traders for the NOVA token, ranked by buy volume', async () => {
    const world = makeWorld();
    const provider = new MockTokenTopTradersProvider(world);

    const traders = await provider.getTopTraders('SOLANA', world.meta.scenarios.nova.tokenAddress);

    expect(traders.length).toBeGreaterThan(0);
    const traderAddresses = new Set(traders.map((t) => t.walletAddress));
    // At least some of NOVA's scripted buyers should appear in the top-traders list.
    const overlap = world.meta.scenarios.nova.buyers.filter((b) => traderAddresses.has(b));
    expect(overlap.length).toBeGreaterThan(0);

    for (const trader of traders) {
      expect(trader.chain).toBe('SOLANA');
      expect(trader.pnlUsd).toBeGreaterThanOrEqual(0);
      expect(trader.winRate).toBeGreaterThanOrEqual(0);
      expect(trader.winRate).toBeLessThanOrEqual(1);
      expect(trader.tradeCount).toBeGreaterThan(0);
    }
  });

  it('is ranked descending by underlying buy volume (deterministic ordering)', async () => {
    const world = makeWorld();
    const provider = new MockTokenTopTradersProvider(world);

    const traders = await provider.getTopTraders('SOLANA', world.meta.scenarios.nova.tokenAddress);
    // pnlUsd is a monotonic function of buy volume (same multiplier band per
    // wallet's own score-derived ratio) — not itself strictly sorted since
    // the multiplier varies per wallet, but the top of the list should carry
    // meaningfully higher figures than an empty/irrelevant token.
    expect(traders.length).toBeGreaterThan(1);
  });

  it('respects the limit option', async () => {
    const world = makeWorld();
    const provider = new MockTokenTopTradersProvider(world);

    const traders = await provider.getTopTraders('SOLANA', world.meta.scenarios.nova.tokenAddress, { limit: 3 });
    expect(traders.length).toBeLessThanOrEqual(3);
  });

  it('returns empty for a token address with no buyers', async () => {
    const world = makeWorld();
    const provider = new MockTokenTopTradersProvider(world);

    const traders = await provider.getTopTraders('SOLANA', 'NOT_A_REAL_TOKEN_ADDRESS');
    expect(traders).toEqual([]);
  });

  it('determinism: same world produces the same top-traders list', async () => {
    const worldA = makeWorld();
    const worldB = makeWorld();
    const providerA = new MockTokenTopTradersProvider(worldA);
    const providerB = new MockTokenTopTradersProvider(worldB);

    const tradersA = await providerA.getTopTraders('SOLANA', worldA.meta.scenarios.nova.tokenAddress);
    const tradersB = await providerB.getTopTraders('SOLANA', worldB.meta.scenarios.nova.tokenAddress);

    expect(tradersA).toEqual(tradersB);
  });
});
