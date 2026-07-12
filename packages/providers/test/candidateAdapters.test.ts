// FlowRadar — Task 36 connector adapter tests: mapper fixture tests for the
// docs-verified adapters (Solana Tracker, Birdeye wallet-PnL + top-traders),
// missing-key graceful behavior for every key-gated factory, and the
// always-[] contract for the three typed stubs (Cielo, KOLScan, GMGN).
// getCandidateSourceStatuses is also exercised here (mock vs live vs
// missing_key vs stub per source).

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  mapSolanaTrackerTrader,
  createSolanaTrackerCandidateSource
} from '../src/candidates/solanaTracker';
import {
  mapBirdeyeWalletPnlSummary,
  mapBirdeyeTopTrader,
  createBirdeyeWalletPnlCandidateSource,
  createBirdeyeTopTradersCandidateSource,
  createBirdeyeTokenTopTraders
} from '../src/candidates/birdeyeCandidates';
import { createCieloCandidateSource } from '../src/candidates/cielo';
import { createKolscanCandidateSource } from '../src/candidates/kolscanStub';
import { createGmgnCandidateSource } from '../src/candidates/gmgnStub';
import { getCandidateSourceStatuses } from '../src/candidates/sourceStatus';

import solanaTrackerFixture from './fixtures/candidates/solanaTracker-leaderboard.json';
import birdeyeWalletPnlFixture from './fixtures/candidates/birdeye-wallet-pnl-summary.json';
import birdeyeTopTradersFixture from './fixtures/candidates/birdeye-top-traders.json';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Solana Tracker mapper
// ---------------------------------------------------------------------------

describe('mapSolanaTrackerTrader', () => {
  it('maps a fully-populated fixture row to an ExternalCandidate', () => {
    const row = solanaTrackerFixture.traders[0];
    const candidate = mapSolanaTrackerTrader(row as any, 1);

    expect(candidate.walletAddress).toBe('So1anaTrackerTop1WalletAddressXXXXXXXXXXXXX');
    expect(candidate.chain).toBe('SOLANA');
    expect(candidate.sourceRank).toBe(1);
    expect(candidate.claimedPnlUsd).toBe(84500.25); // ending.pnl.realized preferred over period.realized
    expect(candidate.claimedWinRate).toBeCloseTo(0.725, 5); // 72.5 -> 0.725
    expect(candidate.claimedTradeCount).toBe(118);
    expect(candidate.claimedRoi).toBe(3.4);
  });

  it('falls back to period.realized when ending.pnl.realized is absent', () => {
    const row = solanaTrackerFixture.traders[1];
    const candidate = mapSolanaTrackerTrader(row as any, 2);
    expect(candidate.claimedPnlUsd).toBe(15200); // ending.pnl.realized present here too
    expect(candidate.claimedWinRate).toBeCloseTo(0.55, 5);
    expect(candidate.claimedTradeCount).toBe(38);
    expect(candidate.claimedRoi).toBe(1.1);
  });

  it('omits claimed fields that are null/absent in the source row rather than coercing to 0', () => {
    const row = solanaTrackerFixture.traders[2];
    const candidate = mapSolanaTrackerTrader(row as any, 3);
    expect(candidate.claimedPnlUsd).toBeUndefined();
    expect(candidate.claimedWinRate).toBeUndefined();
    expect(candidate.claimedTradeCount).toBeUndefined();
    expect(candidate.claimedRoi).toBeUndefined();
  });
});

describe('createSolanaTrackerCandidateSource', () => {
  it('returns null when SOLANA_TRACKER_API_KEY is absent', () => {
    delete process.env.SOLANA_TRACKER_API_KEY;
    expect(createSolanaTrackerCandidateSource({})).toBeNull();
  });

  it('name/chains match the seeded ExternalWalletSource row', () => {
    const source = createSolanaTrackerCandidateSource({ SOLANA_TRACKER_API_KEY: 'test-key' });
    expect(source).not.toBeNull();
    expect(source!.name).toBe('solana_tracker_pnl');
    expect(source!.chains).toEqual(['SOLANA']);
  });

  it('returns [] for a non-SOLANA chain without making a network call', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const source = createSolanaTrackerCandidateSource({ SOLANA_TRACKER_API_KEY: 'test-key' })!;
    const result = await source.fetchCandidates('BSC');
    expect(result).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fetchCandidates maps the doc-shaped fixture response end to end', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => solanaTrackerFixture
    });
    vi.stubGlobal('fetch', fetchMock);

    const source = createSolanaTrackerCandidateSource({ SOLANA_TRACKER_API_KEY: 'test-key' })!;
    const result = await source.fetchCandidates('SOLANA', { limit: 10 });

    expect(result).toHaveLength(3);
    expect(result[0].walletAddress).toBe('So1anaTrackerTop1WalletAddressXXXXXXXXXXXXX');
    expect(result[0].sourceRank).toBe(1);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('data.solanatracker.io/v2/pnl/leaderboard/top');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('test-key');
  });

  it('throws (never silently swallows) on a non-ok HTTP response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 401, statusText: 'Unauthorized', text: async () => 'bad key' })
    );
    const source = createSolanaTrackerCandidateSource({ SOLANA_TRACKER_API_KEY: 'bad-key' })!;
    await expect(source.fetchCandidates('SOLANA')).rejects.toThrow(/SolanaTracker leaderboard fetch failed/);
  });
});

// ---------------------------------------------------------------------------
// Birdeye mappers
// ---------------------------------------------------------------------------

describe('mapBirdeyeWalletPnlSummary', () => {
  it('maps the doc-shaped wallet-pnl-summary fixture', () => {
    const summary = mapBirdeyeWalletPnlSummary(birdeyeWalletPnlFixture as any);
    expect(summary).not.toBeNull();
    expect(summary!.uniqueTokens).toBe(14);
    expect(summary!.totalTrades).toBe(58);
    expect(summary!.winRate).toBe(0.69);
    expect(summary!.realizedProfitUsd).toBe(19000);
    expect(summary!.totalPnlUsd).toBe(19500);
  });

  it('returns null when data.summary is absent', () => {
    expect(mapBirdeyeWalletPnlSummary({ success: true } as any)).toBeNull();
  });
});

describe('mapBirdeyeTopTrader', () => {
  it('maps each doc-shaped top_traders item to a TokenTopTrader', () => {
    const items = birdeyeTopTradersFixture.data.items;
    const mapped = items.map((item) => mapBirdeyeTopTrader(item as any, 'SOLANA'));

    expect(mapped).toHaveLength(2);
    // Original mapping semantics preserved…
    expect(mapped[0]).toMatchObject({
      walletAddress: 'BirdeyeTopTrader1WalletXXXXXXXXXXXXXXXXXXXX',
      chain: 'SOLANA',
      pnlUsd: 17000,
      tradeCount: 45
    });
    // …plus the additive provider-CLAIMED detail for the top-PnL discovery
    // pipeline (claims stay claims — never local truth) and the verbatim raw
    // item as receipt.
    expect(mapped[0].realizedPnlUsd).toBe(17000);
    expect(mapped[0].totalPnlUsd).toBe(18000);
    expect(mapped[0].tradeBuy).toBe(22);
    expect(mapped[0].tradeSell).toBe(23);
    expect(mapped[0].raw).toEqual(items[0]);
    // Second item's realizedPnl is 0 (falsy but defined) — must NOT fall back to totalPnl.
    expect(mapped[1].pnlUsd).toBe(0);
    expect(mapped[1].realizedPnlUsd).toBe(0);
  });
});

describe('Birdeye candidate-source factories', () => {
  it('createBirdeyeWalletPnlCandidateSource returns null without BIRDEYE_API_KEY', () => {
    expect(createBirdeyeWalletPnlCandidateSource({})).toBeNull();
  });

  it('createBirdeyeTopTradersCandidateSource returns null without BIRDEYE_API_KEY', () => {
    expect(createBirdeyeTopTradersCandidateSource({})).toBeNull();
  });

  it('both resolve to a provider with the right name/chains when keyed, and fetchCandidates() is [] (no leaderboard endpoint exists)', async () => {
    const walletPnl = createBirdeyeWalletPnlCandidateSource({ BIRDEYE_API_KEY: 'k' })!;
    const topTraders = createBirdeyeTopTradersCandidateSource({ BIRDEYE_API_KEY: 'k' })!;

    expect(walletPnl.name).toBe('birdeye_wallet_pnl');
    expect(topTraders.name).toBe('birdeye_top_traders');
    expect(await walletPnl.fetchCandidates('SOLANA')).toEqual([]);
    expect(await topTraders.fetchCandidates('SOLANA')).toEqual([]);
  });

  it('createBirdeyeTokenTopTraders returns null without a key, and maps a live fixture call end to end when keyed', async () => {
    expect(createBirdeyeTokenTopTraders({})).toBeNull();

    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => birdeyeTopTradersFixture });
    vi.stubGlobal('fetch', fetchMock);

    const provider = createBirdeyeTokenTopTraders({ BIRDEYE_API_KEY: 'k' })!;
    const traders = await provider.getTopTraders('SOLANA', 'TokenMintAddressAAAAAAAAAAAAAAAAAAAAAAAAAAA', { limit: 5 });

    expect(traders).toHaveLength(2);
    expect(traders[0].walletAddress).toBe('BirdeyeTopTrader1WalletXXXXXXXXXXXXXXXXXXXX');

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('public-api.birdeye.so/defi/v2/tokens/top_traders');
    const headers = init.headers as Record<string, string>;
    expect(headers['X-API-KEY']).toBe('k');
    expect(headers['x-chain']).toBe('solana');
  });
});

// ---------------------------------------------------------------------------
// Typed stubs: Cielo, KOLScan, GMGN — always [], never a network call
// ---------------------------------------------------------------------------

describe('typed stub sources (no verified public API)', () => {
  it('createCieloCandidateSource always returns a working provider that resolves to [] with no fetch call', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const withKey = createCieloCandidateSource({ CIELO_API_KEY: 'present' });
    const withoutKey = createCieloCandidateSource({});

    expect(withKey.name).toBe('cielo');
    expect(await withKey.fetchCandidates('SOLANA')).toEqual([]);
    expect(await withoutKey.fetchCandidates('BSC')).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('createKolscanCandidateSource always returns [] and respects KOLSCAN_API_BASE as a no-op config value only', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const source = createKolscanCandidateSource({ KOLSCAN_API_KEY: 'k', KOLSCAN_API_BASE: 'https://operator-supplied.example' });
    expect(source.name).toBe('kolscan');
    expect(source.chains).toEqual(['SOLANA']);
    expect(await source.fetchCandidates('SOLANA')).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('createGmgnCandidateSource always returns [] and respects GMGN_API_BASE as a no-op config value only', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const source = createGmgnCandidateSource({ GMGN_API_KEY: 'k', GMGN_API_BASE: 'https://operator-supplied.example' });
    expect(source.name).toBe('gmgn_smart_money');
    expect(await source.fetchCandidates('SOLANA')).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// getCandidateSourceStatuses
// ---------------------------------------------------------------------------

describe('getCandidateSourceStatuses', () => {
  it('mock mode: every source reports mode "mock"', () => {
    process.env.MOCK_MODE = 'true';
    const statuses = getCandidateSourceStatuses();
    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses.every((s) => s.mode === 'mock')).toBe(true);

    const names = new Set(statuses.map((s) => s.sourceName));
    expect(names).toEqual(
      new Set(['solana_tracker_pnl', 'birdeye_wallet_pnl', 'birdeye_top_traders', 'kolscan', 'gmgn_smart_money', 'cielo', 'dune'])
    );
  });

  it('live mode: docs-verified sources report live/missing_key by key presence; stubs always report stub', () => {
    process.env.MOCK_MODE = 'false';
    delete process.env.SOLANA_TRACKER_API_KEY;
    process.env.BIRDEYE_API_KEY = 'present';
    delete process.env.KOLSCAN_API_KEY;
    delete process.env.GMGN_API_KEY;
    delete process.env.CIELO_API_KEY;
    delete process.env.DUNE_API_KEY;

    const statuses = getCandidateSourceStatuses();

    const solanaTracker = statuses.filter((s) => s.sourceName === 'solana_tracker_pnl');
    expect(solanaTracker.every((s) => s.mode === 'missing_key')).toBe(true);

    const birdeyeWalletPnl = statuses.filter((s) => s.sourceName === 'birdeye_wallet_pnl');
    expect(birdeyeWalletPnl.every((s) => s.mode === 'live')).toBe(true);

    const birdeyeTopTraders = statuses.filter((s) => s.sourceName === 'birdeye_top_traders');
    expect(birdeyeTopTraders.every((s) => s.mode === 'live')).toBe(true);

    const dune = statuses.filter((s) => s.sourceName === 'dune');
    expect(dune.every((s) => s.mode === 'missing_key')).toBe(true);

    for (const stubName of ['kolscan', 'gmgn_smart_money', 'cielo']) {
      const rows = statuses.filter((s) => s.sourceName === stubName);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((s) => s.mode === 'stub')).toBe(true);
    }
  });

  it('live mode + DUNE_API_KEY present: dune reports live', () => {
    process.env.MOCK_MODE = 'false';
    process.env.DUNE_API_KEY = 'present';
    const statuses = getCandidateSourceStatuses();
    const dune = statuses.filter((s) => s.sourceName === 'dune');
    expect(dune.every((s) => s.mode === 'live')).toBe(true);
  });

  it('live mode + key present for a stub source still reports stub (a key alone does not make an unverified endpoint live)', () => {
    process.env.MOCK_MODE = 'false';
    process.env.CIELO_API_KEY = 'present-but-irrelevant';
    const statuses = getCandidateSourceStatuses();
    const cielo = statuses.filter((s) => s.sourceName === 'cielo');
    expect(cielo.every((s) => s.mode === 'stub')).toBe(true);
  });
});
