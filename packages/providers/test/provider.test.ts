import { describe, expect, it } from 'vitest';
import { createMockWorld } from '../src/mock/world';
import { MockProvider } from '../src/mock/provider';

const GENESIS = new Date('2026-07-05T00:00:00Z');
const SEED = 20260705;

function makeWorld() {
  return createMockWorld({ seed: SEED, genesis: GENESIS });
}

// ---------------------------------------------------------------------------
// WalletActivityProvider — since / cursor / now filtering
// ---------------------------------------------------------------------------

describe('MockProvider.getWalletTransactions', () => {
  it('defaults `now` to genesis + 72h — txs strictly after that bound are invisible', async () => {
    const world = makeWorld();
    const provider = new MockProvider(world);
    const handle = world.meta.scenarios.nova;

    // NOVA buyers are all within genesis+24h..genesis+24h25m, well inside the
    // default now bound (genesis+72h), so they must all be visible.
    const buyer = handle.buyers[0]!;
    const { txs } = await provider.getWalletTransactions('SOLANA', buyer);
    expect(txs.length).toBeGreaterThan(0);
    for (const tx of txs) {
      expect(tx.ts.getTime()).toBeLessThanOrEqual(world.meta.horizon.getTime());
    }
  });

  it('respects a constructor-supplied `now` bound — txs after it are invisible', async () => {
    const world = makeWorld();
    const handle = world.meta.scenarios.nova;
    const buyer = handle.buyers[0]!;
    const allTxs = (world.txsByWallet.get(buyer) ?? []).length;
    expect(allTxs).toBeGreaterThan(0);

    // `now` set to genesis (before NOVA's window at genesis+24h) hides every
    // NOVA-related tx for this wallet.
    const earlyProvider = new MockProvider(world, { now: GENESIS });
    const { txs } = await earlyProvider.getWalletTransactions('SOLANA', buyer);
    expect(txs.length).toBe(0);
  });

  it('`since` filters out txs strictly before the given timestamp', async () => {
    const world = makeWorld();
    const provider = new MockProvider(world);
    const handle = world.meta.scenarios.nova;
    const funder = handle.funderCluster.funder;

    const allTxs = world.txsByWallet.get(funder) ?? [];
    expect(allTxs.length).toBeGreaterThan(1);

    const midpointTs = allTxs[Math.floor(allTxs.length / 2)]!.ts;
    const { txs } = await provider.getWalletTransactions('SOLANA', funder, { since: midpointTs });
    for (const tx of txs) {
      expect(tx.ts.getTime()).toBeGreaterThanOrEqual(midpointTs.getTime());
    }
    expect(txs.length).toBeLessThan(allTxs.length);
    expect(txs.length).toBeGreaterThan(0);
  });

  it('`cursor` (numeric index string) paginates and `limit` caps page size; nextCursor advances correctly', async () => {
    const world = makeWorld();
    const provider = new MockProvider(world);
    const handle = world.meta.scenarios.nova;
    const funder = handle.funderCluster.funder;
    const totalTxs = (world.txsByWallet.get(funder) ?? []).length;
    expect(totalTxs).toBeGreaterThanOrEqual(4);

    const page1 = await provider.getWalletTransactions('SOLANA', funder, { limit: 2 });
    expect(page1.txs.length).toBe(2);
    expect(page1.nextCursor).toBeDefined();

    const page2 = await provider.getWalletTransactions('SOLANA', funder, { limit: 2, cursor: page1.nextCursor });
    expect(page2.txs.length).toBeGreaterThan(0);
    // No overlap between pages.
    const page1Hashes = new Set(page1.txs.map((t) => t.txHash));
    for (const tx of page2.txs) {
      expect(page1Hashes.has(tx.txHash)).toBe(false);
    }

    // Walking pages via nextCursor until exhausted must reconstruct the full
    // (since-filtered, i.e. here unfiltered) tx list exactly, in order.
    const walked: string[] = [];
    let cursor: string | undefined = undefined;
    for (let guard = 0; guard < 100; guard++) {
      const page = await provider.getWalletTransactions('SOLANA', funder, { limit: 2, cursor });
      walked.push(...page.txs.map((t) => t.txHash));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    const expectedOrder = (world.txsByWallet.get(funder) ?? []).map((t) => t.txHash);
    expect(walked).toEqual(expectedOrder);
  });

  it('returns no nextCursor once the last page is reached', async () => {
    const world = makeWorld();
    const provider = new MockProvider(world);
    const handle = world.meta.scenarios.nova;
    const funder = handle.funderCluster.funder;
    const totalTxs = (world.txsByWallet.get(funder) ?? []).length;

    const { nextCursor } = await provider.getWalletTransactions('SOLANA', funder, { limit: totalTxs + 5 });
    expect(nextCursor).toBeUndefined();
  });

  it('returns an empty page for a wallet with no transactions', async () => {
    const world = makeWorld();
    const provider = new MockProvider(world);
    const { txs, nextCursor } = await provider.getWalletTransactions('SOLANA', 'not-a-real-wallet-address');
    expect(txs).toEqual([]);
    expect(nextCursor).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// MarketDataProvider
// ---------------------------------------------------------------------------

describe('MockProvider.getTokenMarket / getTokenPairs', () => {
  it('returns the latest market point at or before `now`', async () => {
    const world = makeWorld();
    const nova = world.tokens.find((t) => t.symbol === 'NOVA')!;
    const cutoff = new Date(world.meta.genesis.getTime() + 10 * 60 * 60 * 1000); // 10h in
    const provider = new MockProvider(world, { now: cutoff });

    const market = await provider.getTokenMarket('SOLANA', nova.address);
    expect(market).not.toBeNull();

    const series = world.marketSeries.get(nova.address)!;
    const expectedPoint = [...series].reverse().find((p) => p.ts.getTime() <= cutoff.getTime())!;
    expect(market!.marketCapUsd).toBe(expectedPoint.market.marketCapUsd);
  });

  it('returns null for an unknown token address', async () => {
    const world = makeWorld();
    const provider = new MockProvider(world);
    const market = await provider.getTokenMarket('SOLANA', 'unknown-token-address');
    expect(market).toBeNull();
  });

  it('getTokenPairs returns a non-empty PairInfo array for a scenario token', async () => {
    const world = makeWorld();
    const nova = world.tokens.find((t) => t.symbol === 'NOVA')!;
    const provider = new MockProvider(world);
    const pairs = await provider.getTokenPairs('SOLANA', nova.address);
    expect(pairs.length).toBeGreaterThan(0);
    expect(pairs[0]).toMatchObject({
      pairAddress: expect.any(String),
      dex: expect.any(String),
      baseSymbol: 'NOVA',
      liquidityUsd: expect.any(Number),
      priceUsd: expect.any(Number)
    });
  });
});

// ---------------------------------------------------------------------------
// TokenMetadataProvider
// ---------------------------------------------------------------------------

describe('MockProvider.getTokenMetadata', () => {
  it('returns metadata matching the mock token for a known address', async () => {
    const world = makeWorld();
    const nova = world.tokens.find((t) => t.symbol === 'NOVA')!;
    const provider = new MockProvider(world);
    const meta = await provider.getTokenMetadata('SOLANA', nova.address);
    expect(meta).toMatchObject({
      address: nova.address,
      chain: 'SOLANA',
      symbol: 'NOVA',
      decimals: nova.decimals
    });
  });

  it('returns null for an unknown token address', async () => {
    const world = makeWorld();
    const provider = new MockProvider(world);
    const meta = await provider.getTokenMetadata('SOLANA', 'unknown-token-address');
    expect(meta).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// RiskProvider
// ---------------------------------------------------------------------------

describe('MockProvider.getTokenRisk', () => {
  it('returns the scripted RUGZ risk report with mint_authority_active + top_holder_60pct', async () => {
    const world = makeWorld();
    const rugz = world.tokens.find((t) => t.symbol === 'RUGZ')!;
    const provider = new MockProvider(world);
    const risk = await provider.getTokenRisk('SOLANA', rugz.address);
    const flagIds = risk.flags.map((f) => f.id);
    expect(flagIds).toContain('mint_authority_active');
    expect(flagIds).toContain('top_holder_60pct');
    expect(risk.penalty).toBeGreaterThanOrEqual(0.5);
  });

  it('returns a clean (empty-flags, zero-penalty) report for a token with no scripted risk', async () => {
    const world = makeWorld();
    const nova = world.tokens.find((t) => t.symbol === 'NOVA')!;
    const provider = new MockProvider(world);
    const risk = await provider.getTokenRisk('SOLANA', nova.address);
    expect(risk.flags).toEqual([]);
    expect(risk.penalty).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// WalletDiscoveryProvider
// ---------------------------------------------------------------------------

describe('MockProvider.getCandidateWallets', () => {
  it('returns the profitable/smart subset of wallets, respecting `limit`', async () => {
    const world = makeWorld();
    const provider = new MockProvider(world);
    const candidates = await provider.getCandidateWallets('SOLANA', { limit: 5 });
    expect(candidates.length).toBeLessThanOrEqual(5);
    expect(candidates.length).toBeGreaterThan(0);
    for (const c of candidates) {
      expect(c.chain).toBe('SOLANA');
      expect(c.walletScore).toBeGreaterThan(0);
    }
  });

  it('defaults to a reasonable page when `limit` is omitted', async () => {
    const world = makeWorld();
    const provider = new MockProvider(world);
    const candidates = await provider.getCandidateWallets('SOLANA');
    expect(candidates.length).toBeGreaterThan(0);
  });
});
