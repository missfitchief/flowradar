// FlowRadar — MockDuneOverlapSource tests (Task 37, Wave 4.6). Determinism
// (same world + params => same rows, same order) + poisoned entry presence
// (the router/CEX address is injected as a plausible-but-must-be-rejected
// overlap trader).

import { describe, expect, it } from 'vitest';
import { createMockWorld } from '../../../src/mock/world';
import type { MockWorld } from '../../../src/mock/world';
import { getDunePoisonedAddresses, MockDuneOverlapSource } from '../../../src/candidates/dune/mockDuneSource';

const GENESIS = new Date('2026-07-01T00:00:00Z');

function buildWorld(): MockWorld {
  return createMockWorld({ genesis: GENESIS });
}

/** Finds a real pair of token addresses in `world` with at least `minSharedBuyers` wallets that bought BOTH — same buy-leg convention MockDuneOverlapSource itself uses, so the test exercises real overlap data rather than a contrived fixture. */
function findOverlappingTokenPair(world: MockWorld, chain: 'SOLANA' | 'BSC', minSharedBuyers: number): { tokenA: string; tokenB: string; sharedBuyerCount: number } {
  const walletsByAddress = new Map(world.wallets.filter((w) => w.chain === chain).map((w) => [w.address, w]));
  const buyersByToken = new Map<string, Set<string>>();

  for (const [walletAddress, txs] of world.txsByWallet) {
    if (!walletsByAddress.has(walletAddress)) continue;
    for (const tx of txs) {
      for (const leg of tx.legs) {
        if (leg.kind !== 'swap_leg' || leg.to !== walletAddress || !leg.asset.address) continue;
        const set = buyersByToken.get(leg.asset.address) ?? new Set<string>();
        set.add(walletAddress);
        buyersByToken.set(leg.asset.address, set);
      }
    }
  }

  const tokens = [...buyersByToken.keys()];
  for (let i = 0; i < tokens.length; i++) {
    for (let j = i + 1; j < tokens.length; j++) {
      const a = buyersByToken.get(tokens[i]!)!;
      const b = buyersByToken.get(tokens[j]!)!;
      const shared = [...a].filter((w) => b.has(w));
      if (shared.length >= minSharedBuyers) {
        return { tokenA: tokens[i]!, tokenB: tokens[j]!, sharedBuyerCount: shared.length };
      }
    }
  }
  throw new Error(`no overlapping token pair found with >= ${minSharedBuyers} shared buyers — test fixture assumption invalid`);
}

describe('MockDuneOverlapSource', () => {
  it('finds real overlap rows for a genuinely overlapping token pair (>= 2 tokens hit)', () => {
    const world = buildWorld();
    const { tokenA, tokenB, sharedBuyerCount } = findOverlappingTokenPair(world, 'SOLANA', 5);

    const source = new MockDuneOverlapSource(world);
    const rows = source.findOverlap({ chain: 'SOLANA', tokenAddresses: [tokenA, tokenB] });

    // Every non-poisoned row must have tokens_overlap_count >= 2 (both requested tokens).
    const poisoned = getDunePoisonedAddresses(world, 'SOLANA');
    const goodRows = rows.filter((r) => !poisoned.routerOrCex.includes(r.wallet_address));
    expect(goodRows.length).toBeGreaterThanOrEqual(sharedBuyerCount);
    for (const row of goodRows) {
      expect(row.tokens_overlap_count).toBeGreaterThanOrEqual(2);
      expect(row.wallet_address).toBeTruthy();
      // A wallet's overlap can be established via buys OR sells on both
      // tokens — at least one of buy_count/sell_count must be positive.
      expect(row.buy_count + row.sell_count).toBeGreaterThan(0);
    }
  });

  it('DETERMINISM: same world + same params => identical rows, identical order, across repeated calls', () => {
    const world = buildWorld();
    const { tokenA, tokenB } = findOverlappingTokenPair(world, 'SOLANA', 5);

    const source1 = new MockDuneOverlapSource(world);
    const source2 = new MockDuneOverlapSource(world);

    const rows1 = source1.findOverlap({ chain: 'SOLANA', tokenAddresses: [tokenA, tokenB] });
    const rows2 = source2.findOverlap({ chain: 'SOLANA', tokenAddresses: [tokenA, tokenB] });

    expect(rows1).toEqual(rows2);
    expect(rows1.map((r) => r.wallet_address)).toEqual(rows2.map((r) => r.wallet_address));
  });

  it('DETERMINISM: two freshly-built worlds with the same (seed, genesis) produce identical overlap rows', () => {
    const worldA = buildWorld();
    const worldB = buildWorld();
    const { tokenA, tokenB } = findOverlappingTokenPair(worldA, 'SOLANA', 5);

    const rowsA = new MockDuneOverlapSource(worldA).findOverlap({ chain: 'SOLANA', tokenAddresses: [tokenA, tokenB] });
    const rowsB = new MockDuneOverlapSource(worldB).findOverlap({ chain: 'SOLANA', tokenAddresses: [tokenA, tokenB] });

    expect(rowsA).toEqual(rowsB);
  });

  it('POISONED: the router/CEX address is present in the overlap result for a SOLANA search, over-claimed and passing on claim alone', () => {
    const world = buildWorld();
    const { tokenA, tokenB } = findOverlappingTokenPair(world, 'SOLANA', 5);
    const poisoned = getDunePoisonedAddresses(world, 'SOLANA');
    expect(poisoned.routerOrCex.length).toBeGreaterThan(0);

    const source = new MockDuneOverlapSource(world);
    const rows = source.findOverlap({ chain: 'SOLANA', tokenAddresses: [tokenA, tokenB] });

    const poisonedRow = rows.find((r) => poisoned.routerOrCex.includes(r.wallet_address));
    expect(poisonedRow).toBeDefined();
    expect(poisonedRow!.tokens_overlap_count).toBe(2);
    expect(poisonedRow!.estimated_pnl_usd).toBeGreaterThan(0); // looks profitable on the claim alone
  });

  it('returns [] for fewer than 2 or more than 5 token addresses (product framing: 2-5 CAs)', () => {
    const world = buildWorld();
    const source = new MockDuneOverlapSource(world);

    expect(source.findOverlap({ chain: 'SOLANA', tokenAddresses: ['ONLY_ONE'] })).toEqual([]);
    expect(
      source.findOverlap({ chain: 'SOLANA', tokenAddresses: ['A', 'B', 'C', 'D', 'E', 'F'] })
    ).toEqual([]);
  });

  it('BSC search: poisoned routerOrCex is empty (no graph-demo counterparties on BSC), never throws', () => {
    const world = buildWorld();
    const poisoned = getDunePoisonedAddresses(world, 'BSC');
    expect(poisoned.routerOrCex).toEqual([]);

    const source = new MockDuneOverlapSource(world);
    const bscTokens = world.tokens.filter((t) => t.chain === 'BSC').map((t) => t.address);
    if (bscTokens.length >= 2) {
      expect(() => source.findOverlap({ chain: 'BSC', tokenAddresses: bscTokens.slice(0, 2) })).not.toThrow();
    }
  });

  it('rows returned are shaped exactly like DuneOverlapRowSchema (round-trips through the real Zod parse)', async () => {
    const { parseOverlapRows } = await import('../../../src/candidates/dune/types');
    const world = buildWorld();
    const { tokenA, tokenB } = findOverlappingTokenPair(world, 'SOLANA', 5);

    const source = new MockDuneOverlapSource(world);
    const rows = source.findOverlap({ chain: 'SOLANA', tokenAddresses: [tokenA, tokenB] });

    const parsed = parseOverlapRows(rows);
    expect(parsed.droppedCount).toBe(0);
    expect(parsed.rows.length).toBe(rows.length);
  });
});
