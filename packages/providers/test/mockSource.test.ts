// FlowRadar — MockCandidateSource determinism + poisoned-entry tests (Task 34,
// Wave 4.5, Spec §5b). Task 35's validation pipeline is expected to reject
// every poisoned address exported by getPoisonedAddresses(world) — this file
// only proves the mock source itself is deterministic and that the poisoned
// set is present with plausible (over-claimed) figures, not rejected here.

import { describe, expect, it } from 'vitest';
import { createMockWorld } from '../src/mock/world';
import { MockCandidateSource, getPoisonedAddresses } from '../src/candidates/mockSource';

const GENESIS = new Date('2026-07-05T00:00:00Z');
const SEED = 20260705;

function makeWorld(seed = SEED) {
  return createMockWorld({ seed, genesis: GENESIS });
}

describe('MockCandidateSource', () => {
  it('name is "mock" and chains covers SOLANA + BSC', () => {
    const world = makeWorld();
    const source = new MockCandidateSource(world);
    expect(source.name).toBe('mock');
    expect(source.chains).toContain('SOLANA');
    expect(source.chains).toContain('BSC');
  });

  it('determinism: same world (seed, genesis) produces bit-identical candidate lists across two independent source instances', async () => {
    const worldA = makeWorld();
    const worldB = makeWorld();
    const sourceA = new MockCandidateSource(worldA);
    const sourceB = new MockCandidateSource(worldB);

    const candidatesA = await sourceA.fetchCandidates('SOLANA');
    const candidatesB = await sourceB.fetchCandidates('SOLANA');

    expect(candidatesA).toEqual(candidatesB);
    expect(candidatesA.length).toBeGreaterThan(0);
  });

  it('determinism: a different seed changes the candidate set', async () => {
    const worldA = makeWorld(SEED);
    const worldC = makeWorld(SEED + 1);
    const sourceA = new MockCandidateSource(worldA);
    const sourceC = new MockCandidateSource(worldC);

    const candidatesA = await sourceA.fetchCandidates('SOLANA');
    const candidatesC = await sourceC.fetchCandidates('SOLANA');

    expect(candidatesA).not.toEqual(candidatesC);
  });

  it('returns roughly a top-30 leaderboard of good candidates for SOLANA, ranked by sourceRank ascending', async () => {
    const world = makeWorld();
    const source = new MockCandidateSource(world);
    const candidates = await source.fetchCandidates('SOLANA');

    // top ~30 "good" candidates + a handful of poisoned entries layered in.
    expect(candidates.length).toBeGreaterThanOrEqual(30);
    expect(candidates.length).toBeLessThan(45);

    const ranks = candidates.map((c) => c.sourceRank).filter((r): r is number => r !== undefined);
    expect(ranks.length).toBe(candidates.length);
    const sorted = [...ranks].sort((a, b) => a - b);
    expect(ranks).toEqual(sorted);
  });

  it('respects opts.limit', async () => {
    const world = makeWorld();
    const source = new MockCandidateSource(world);
    const candidates = await source.fetchCandidates('SOLANA', { limit: 5 });
    expect(candidates.length).toBeLessThanOrEqual(5);
  });

  it('every candidate has a chain matching the requested chain and a non-empty walletAddress', async () => {
    const world = makeWorld();
    const source = new MockCandidateSource(world);
    const candidates = await source.fetchCandidates('SOLANA');
    for (const c of candidates) {
      expect(c.chain).toBe('SOLANA');
      expect(c.walletAddress.length).toBeGreaterThan(0);
    }
  });

  it('BSC also returns a non-empty candidate set', async () => {
    const world = makeWorld();
    const source = new MockCandidateSource(world);
    const candidates = await source.fetchCandidates('BSC');
    expect(candidates.length).toBeGreaterThan(0);
    for (const c of candidates) {
      expect(c.chain).toBe('BSC');
    }
  });
});

describe('MockCandidateSource poisoned entries (must later fail Task 35 validation)', () => {
  it('getPoisonedAddresses(world) returns exactly 2 router/CEX + 2 possible_bot + 1 below-threshold address (5 total) for SOLANA', () => {
    const world = makeWorld();
    const poisoned = getPoisonedAddresses(world, 'SOLANA');

    expect(poisoned.routerOrCex).toHaveLength(2);
    expect(poisoned.possibleBot).toHaveLength(2);
    expect(poisoned.belowThreshold).toHaveLength(1);
  });

  it('every poisoned address appears in fetchCandidates output with plausible (over-claimed) figures', async () => {
    const world = makeWorld();
    const source = new MockCandidateSource(world);
    const candidates = await source.fetchCandidates('SOLANA');
    const byAddress = new Map(candidates.map((c) => [c.walletAddress, c]));

    const poisoned = getPoisonedAddresses(world, 'SOLANA');
    const allPoisoned = [...poisoned.routerOrCex, ...poisoned.possibleBot, ...poisoned.belowThreshold];

    for (const address of allPoisoned) {
      const candidate = byAddress.get(address);
      expect(candidate, `expected poisoned address ${address} to appear in fetchCandidates output`).toBeDefined();
    }

    // router/CEX + possible_bot poisoned entries carry OVER-claimed figures
    // (a scammy source over-claims) — well above the profitableWallet
    // thresholds (pnl30d>=4000, trades>=8, winRate>=0.35) so it is
    // VALIDATION (registry/label reject), not the claim itself, that must
    // catch these in Task 35.
    for (const address of [...poisoned.routerOrCex, ...poisoned.possibleBot]) {
      const candidate = byAddress.get(address)!;
      expect(candidate.claimedPnlUsd ?? 0).toBeGreaterThanOrEqual(4000);
      expect(candidate.claimedTradeCount ?? 0).toBeGreaterThanOrEqual(8);
      expect(candidate.claimedWinRate ?? 0).toBeGreaterThanOrEqual(0.35);
    }

    // the below-threshold poisoned entry is explicitly BELOW the pnl bar
    // (claimedPnl < 4000) — this one is designed to fail on the claim itself.
    for (const address of poisoned.belowThreshold) {
      const candidate = byAddress.get(address)!;
      expect(candidate.claimedPnlUsd ?? 0).toBeLessThan(4000);
    }
  });

  it('router/CEX poisoned addresses are drawn from the mock world\'s registry-tagged counterparties (graph-demo cex/router)', () => {
    const world = makeWorld();
    const poisoned = getPoisonedAddresses(world, 'SOLANA');
    const registryTagged = new Set([
      world.meta.scenarios.graphDemo.cexCounterparty,
      world.meta.scenarios.graphDemo.routerCounterparty
    ]);
    for (const address of poisoned.routerOrCex) {
      expect(registryTagged.has(address)).toBe(true);
    }
  });

  it('possible_bot poisoned addresses are actually labeled possible_bot in the mock world', () => {
    const world = makeWorld();
    const poisoned = getPoisonedAddresses(world, 'SOLANA');
    const walletsByAddress = new Map(world.wallets.map((w) => [w.address, w]));
    for (const address of poisoned.possibleBot) {
      const wallet = walletsByAddress.get(address);
      expect(wallet).toBeDefined();
      expect(wallet!.labels).toContain('possible_bot');
    }
  });

  it('poisoned addresses are deterministic across two independently-built worlds with the same seed', () => {
    const worldA = makeWorld();
    const worldB = makeWorld();
    expect(getPoisonedAddresses(worldA, 'SOLANA')).toEqual(getPoisonedAddresses(worldB, 'SOLANA'));
  });
});
