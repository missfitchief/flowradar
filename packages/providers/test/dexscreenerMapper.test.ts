// FlowRadar — dexscreenerMapper.ts fixture tests (Task 28).
//
// Fixtures live in test/fixtures/dexscreener/*.json:
//  - multi-pair-token.json: a real live-fetched response (wrapped SOL mint),
//    trimmed to essential fields, INCLUDING a cross-chain pair (chainId
//    "fogo") sharing the same base-token address as the SOLANA pairs (proves
//    the chain filter is load-bearing), a pair with `liquidity: null`, and a
//    pair missing fdv/marketCap/most volume windows (proves null-safety).
//  - no-pairs-token.json: DexScreener's real "no pairs at all" shape,
//    `{ schemaVersion, pairs: null }` (NOT an empty array) — live-verified.

import { describe, expect, it } from 'vitest';
import {
  chainIdForFlowRadarChain,
  filterPairsByChain,
  mapPairToTokenMarket,
  mapRawPairToPairInfo,
  mapTokensResponseToPairInfos,
  mapTokensResponseToTokenMarket,
  pickHighestLiquidityPair
} from '../src/market/dexscreenerMapper';
import type { RawDexScreenerPair, RawDexScreenerTokensResponse } from '../src/market/dexscreenerMapper';
import multiPairFixture from './fixtures/dexscreener/multi-pair-token.json';
import noPairsFixture from './fixtures/dexscreener/no-pairs-token.json';

const typedMultiPair = multiPairFixture as unknown as RawDexScreenerTokensResponse;
const typedNoPairs = noPairsFixture as unknown as RawDexScreenerTokensResponse;

describe('chainIdForFlowRadarChain', () => {
  it('maps SOLANA -> "solana" and BSC -> "bsc"', () => {
    expect(chainIdForFlowRadarChain('SOLANA')).toBe('solana');
    expect(chainIdForFlowRadarChain('BSC')).toBe('bsc');
  });
});

describe('filterPairsByChain', () => {
  it('drops pairs on other chains (the "fogo" cross-chain pair sharing the same address)', () => {
    const solanaPairs = filterPairsByChain(typedMultiPair.pairs, 'SOLANA');
    expect(solanaPairs.every((p) => p.chainId === 'solana')).toBe(true);
    expect(solanaPairs.some((p) => p.chainId === 'fogo')).toBe(false);
    // fixture has 5 solana pairs + 1 fogo pair
    expect(solanaPairs.length).toBe(5);
  });

  it('returns [] for BSC on a fixture with no bsc pairs', () => {
    expect(filterPairsByChain(typedMultiPair.pairs, 'BSC')).toEqual([]);
  });

  it('tolerates pairs: null (treats as empty)', () => {
    expect(filterPairsByChain(typedNoPairs.pairs, 'SOLANA')).toEqual([]);
  });

  it('tolerates pairs: undefined', () => {
    expect(filterPairsByChain(undefined, 'SOLANA')).toEqual([]);
  });
});

describe('pickHighestLiquidityPair', () => {
  it('returns null for an empty list', () => {
    expect(pickHighestLiquidityPair([])).toBeNull();
  });

  it('picks the pair with the highest liquidity.usd', () => {
    const solanaPairs = filterPairsByChain(typedMultiPair.pairs, 'SOLANA');
    const best = pickHighestLiquidityPair(solanaPairs);
    expect(best).not.toBeNull();
    expect(best!.pairAddress).toBe('Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE'); // liquidity.usd 25,468,914.13, the max
  });

  it('treats missing/null liquidity as 0 (sorts last)', () => {
    const pairs: RawDexScreenerPair[] = [
      { pairAddress: 'no-liquidity-field', chainId: 'solana' },
      { pairAddress: 'null-liquidity', chainId: 'solana', liquidity: null },
      { pairAddress: 'has-liquidity', chainId: 'solana', liquidity: { usd: 1 } }
    ];
    expect(pickHighestLiquidityPair(pairs)!.pairAddress).toBe('has-liquidity');
  });

  it('breaks liquidity ties using volume.h24 desc', () => {
    const pairs: RawDexScreenerPair[] = [
      { pairAddress: 'low-vol', chainId: 'solana', liquidity: { usd: 100 }, volume: { h24: 5 } },
      { pairAddress: 'high-vol', chainId: 'solana', liquidity: { usd: 100 }, volume: { h24: 500 } }
    ];
    expect(pickHighestLiquidityPair(pairs)!.pairAddress).toBe('high-vol');
  });
});

describe('mapRawPairToPairInfo', () => {
  it('maps every documented field, parsing priceUsd string -> number', () => {
    const solanaPairs = filterPairsByChain(typedMultiPair.pairs, 'SOLANA');
    const orcaPair = solanaPairs.find((p) => p.pairAddress === 'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE')!;
    const info = mapRawPairToPairInfo(orcaPair);

    expect(info).toEqual({
      pairAddress: 'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE',
      dex: 'orca',
      baseSymbol: 'SOL',
      quoteSymbol: 'USDC',
      liquidityUsd: 25468914.13,
      priceUsd: 80.29
    });
  });

  it('is null-safe for a pair missing liquidity/dex/symbols', () => {
    const info = mapRawPairToPairInfo({});
    expect(info).toEqual({
      pairAddress: '',
      dex: 'unknown',
      baseSymbol: '',
      quoteSymbol: '',
      liquidityUsd: 0,
      priceUsd: 0
    });
  });
});

describe('mapPairToTokenMarket', () => {
  it('maps mcap/fdv/liquidity/volume windows, holderCount always null', () => {
    const solanaPairs = filterPairsByChain(typedMultiPair.pairs, 'SOLANA');
    const raydiumPair = solanaPairs.find((p) => p.pairAddress === '3nMFwZXwY1s1M5s8vYAHqd4wGs4iSxXE4LRoUMMYqEgF')!;
    const market = mapPairToTokenMarket(raydiumPair);

    expect(market.priceUsd).toBe(80.36);
    expect(market.marketCapUsd).toBeNull(); // this fixture pair has no marketCap field
    expect(market.fdvUsd).toBeNull();
    expect(market.liquidityUsd).toBe(1330120.99);
    expect(market.vol5m).toBe(95539.01);
    expect(market.vol1h).toBe(839530.97);
    expect(market.vol6h).toBe(3012151.17);
    expect(market.vol24h).toBe(10001820.07);
    expect(market.holderCount).toBeNull();
    expect(market.pairAddress).toBe('3nMFwZXwY1s1M5s8vYAHqd4wGs4iSxXE4LRoUMMYqEgF');
    expect(market.dex).toBe('raydium');
  });

  it('reads marketCap/fdv when present on the pair', () => {
    const solanaPairs = filterPairsByChain(typedMultiPair.pairs, 'SOLANA');
    const fogoLikeButSolana = solanaPairs.find((p) => p.pairAddress === '5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6');
    // none of the solana-chain fixture pairs carry fdv/marketCap; assert the
    // one fixture pair that DOES (the "fogo" chain one) maps them correctly
    // when read directly (bypassing the chain filter for this assertion).
    const fogoPair = typedMultiPair.pairs!.find((p) => p.chainId === 'fogo')!;
    const market = mapPairToTokenMarket(fogoPair);
    expect(market.marketCapUsd).toBe(100876941);
    expect(market.fdvUsd).toBe(100876941);
    expect(fogoLikeButSolana).toBeDefined();
  });

  it('treats liquidity: null as liquidityUsd: null (not 0) on the TokenMarket shape', () => {
    const solanaPairs = filterPairsByChain(typedMultiPair.pairs, 'SOLANA');
    const nullLiquidityPair = solanaPairs.find((p) => p.pairAddress === 'HTvjzsfX3yU6BUodCjZ5vZkUrAxMDTrBs3CJaq43ashR')!;
    expect(mapPairToTokenMarket(nullLiquidityPair).liquidityUsd).toBeNull();
  });

  it('defaults every missing volume window to 0', () => {
    const solanaPairs = filterPairsByChain(typedMultiPair.pairs, 'SOLANA');
    const sparsePair = solanaPairs.find((p) => p.pairAddress === 'MissingOptionalFieldsPairXXXXXXXXXXXXXXXXXXXXX')!;
    const market = mapPairToTokenMarket(sparsePair);
    expect(market.vol5m).toBe(0);
    expect(market.vol1h).toBe(0);
    expect(market.vol6h).toBe(0);
    expect(market.vol24h).toBe(100);
  });
});

describe('mapTokensResponseToPairInfos (full getTokenPairs path)', () => {
  it('returns every SOLANA-chain pair mapped, excluding the fogo pair', () => {
    const infos = mapTokensResponseToPairInfos(typedMultiPair, 'SOLANA');
    expect(infos.length).toBe(5);
    expect(infos.every((i) => i.dex !== 'valiant')).toBe(true);
  });

  it('returns [] for the no-pairs fixture', () => {
    expect(mapTokensResponseToPairInfos(typedNoPairs, 'SOLANA')).toEqual([]);
  });

  it('returns [] for a null/undefined response', () => {
    expect(mapTokensResponseToPairInfos(null, 'SOLANA')).toEqual([]);
    expect(mapTokensResponseToPairInfos(undefined, 'SOLANA')).toEqual([]);
  });
});

describe('mapTokensResponseToTokenMarket (full getTokenMarket path)', () => {
  it('picks the highest-liquidity SOLANA pair (orca, 25.4M liquidity) and maps it', () => {
    const market = mapTokensResponseToTokenMarket(typedMultiPair, 'SOLANA');
    expect(market).not.toBeNull();
    expect(market!.pairAddress).toBe('Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE');
    expect(market!.priceUsd).toBe(80.29);
    expect(market!.holderCount).toBeNull();
  });

  it('returns null for the no-pairs fixture', () => {
    expect(mapTokensResponseToTokenMarket(typedNoPairs, 'SOLANA')).toBeNull();
  });

  it('returns null when the only pairs are on a different chain', () => {
    expect(mapTokensResponseToTokenMarket(typedMultiPair, 'BSC')).toBeNull();
  });
});
