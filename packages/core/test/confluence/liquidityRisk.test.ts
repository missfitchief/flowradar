import { describe, expect, it } from 'vitest';
import { computeLiquidityRisk } from '../../src/confluence/liquidityRisk';
import type { LiquidityRiskConfig, LiquidityRiskInput } from '../../src/confluence/types';

// Default-ish config matching DEFAULT_SETTINGS.connectors.externalConfluence.liquidityRisk.
const CFG: LiquidityRiskConfig = {
  absoluteLiquidityBandsUsd: [10000, 50000, 250000],
  ratioFragilityBands: [0.02, 0.05, 0.15]
};

function input(over: Partial<LiquidityRiskInput> = {}): LiquidityRiskInput {
  return { displayedLiquidityUsd: 40000, marketCapUsd: 1_000_000, positionSizeUsd: 1000, ...over };
}

describe('computeLiquidityRisk — formulas (worked example L=40k, MC=1M, S=1k)', () => {
  it('computes every identity exactly for a constant_product pool', () => {
    const r = computeLiquidityRisk(input({ poolType: 'constant_product' }), CFG);
    expect(r.liquidityToMcapRatio).toBeCloseTo(0.04, 10);        // 40000 / 1_000_000
    expect(r.poolFloatFractionEstimate).toBeCloseTo(0.02, 10);   // ratio / 2
    expect(r.overhangMultiple).toBeCloseTo(49, 10);              // 2/0.04 - 1
    expect(r.estimatedOneWaySlippagePct).toBeCloseTo(5, 10);     // 100 * 2 * 1000 / 40000
    expect(r.dumpToHalveUsd).toBeCloseTo(8280, 6);               // 0.207 * 40000
    expect(r.positionSizeMaxFor2PctSlippageUsd).toBeCloseTo(400, 10); // 0.01 * 40000
    expect(r.confidence).toBe('high');
    expect(r.absoluteLiquidityBand).toBe('thin');   // 10000 <= 40000 < 50000
    expect(r.ratioFragilityBand).toBe('fragile');   // 0.02 <= 0.04 < 0.05
  });

  it('scales estimatedOneWaySlippagePct with positionSizeUsd', () => {
    const small = computeLiquidityRisk(input({ positionSizeUsd: 1000 }), CFG);
    const big = computeLiquidityRisk(input({ positionSizeUsd: 4000 }), CFG);
    expect(small.estimatedOneWaySlippagePct).toBeCloseTo(5, 10);   // 100*2*1000/40000
    expect(big.estimatedOneWaySlippagePct).toBeCloseTo(20, 10);    // 100*2*4000/40000
    // positionSizeUsd does NOT affect the size-independent fields
    expect(big.dumpToHalveUsd).toBeCloseTo(8280, 6);
    expect(big.positionSizeMaxFor2PctSlippageUsd).toBeCloseTo(400, 10);
  });

  it('second worked example (L=100k, MC=2M, S=5k) is exact', () => {
    const r = computeLiquidityRisk(
      input({ displayedLiquidityUsd: 100000, marketCapUsd: 2_000_000, positionSizeUsd: 5000, poolType: 'constant_product' }),
      CFG
    );
    expect(r.liquidityToMcapRatio).toBeCloseTo(0.05, 10);
    expect(r.poolFloatFractionEstimate).toBeCloseTo(0.025, 10);
    expect(r.overhangMultiple).toBeCloseTo(39, 10);
    expect(r.estimatedOneWaySlippagePct).toBeCloseTo(10, 10);   // 100*2*5000/100000
    expect(r.dumpToHalveUsd).toBeCloseTo(20700, 6);             // 0.207 * 100000
    expect(r.positionSizeMaxFor2PctSlippageUsd).toBeCloseTo(1000, 10);
    expect(r.absoluteLiquidityBand).toBe('moderate'); // 50000 <= 100000 < 250000
    expect(r.ratioFragilityBand).toBe('moderate');    // 0.05 <= 0.05... actually ratio 0.05 -> boundary, see boundary test
  });
});

describe('computeLiquidityRisk — confidence & CLMM caveat', () => {
  it('poolType unknown => confidence medium with a stated-assumption caveat', () => {
    const r = computeLiquidityRisk(input({ poolType: 'unknown' }), CFG);
    expect(r.confidence).toBe('medium');
    expect(r.caveats.some((c) => /assum/i.test(c))).toBe(true);
    // numbers still present
    expect(r.liquidityToMcapRatio).toBeCloseTo(0.04, 10);
  });

  it('missing poolType (undefined) is treated as unknown => medium', () => {
    const r = computeLiquidityRisk(input(), CFG);
    expect(r.confidence).toBe('medium');
  });

  it('poolType concentrated => confidence low + prominent CLMM caveat, numbers still returned', () => {
    const r = computeLiquidityRisk(input({ poolType: 'concentrated' }), CFG);
    expect(r.confidence).toBe('low');
    expect(r.caveats.some((c) => /concentrated|CLMM/i.test(c))).toBe(true);
    // identities are still surfaced (flagged, not nulled)
    expect(r.liquidityToMcapRatio).toBeCloseTo(0.04, 10);
    expect(r.estimatedOneWaySlippagePct).toBeCloseTo(5, 10);
  });

  it('always appends the multi-pool / stale-data / holder-concentration caveats on a valid compute', () => {
    const r = computeLiquidityRisk(input({ poolType: 'constant_product' }), CFG);
    const joined = r.caveats.join(' | ').toLowerCase();
    expect(joined).toContain('aggregated');
    expect(joined).toContain('stale');
    expect(joined).toContain('holder concentration');
  });
});

describe('computeLiquidityRisk — null guards (MC<=0, L<=0, non-finite)', () => {
  it('marketCapUsd <= 0 => all numeric fields null, confidence low, caveat present, never a reassuring band', () => {
    const r = computeLiquidityRisk(input({ marketCapUsd: 0, poolType: 'constant_product' }), CFG);
    expect(r.liquidityToMcapRatio).toBeNull();
    expect(r.poolFloatFractionEstimate).toBeNull();
    expect(r.overhangMultiple).toBeNull();
    // slippage/dump/posMax depend only on L, but ratio-derived fields are null;
    // with valid L they may still be computed — assert the ratio-derived ones are null:
    expect(r.confidence).toBe('low');
    expect(r.ratioFragilityBand).toBe('unknown');
    expect(r.caveats.some((c) => /market cap|invalid|unavailable/i.test(c))).toBe(true);
  });

  it('displayedLiquidityUsd <= 0 => ratio + all L-derived numeric fields null, band unknown, confidence low', () => {
    const r = computeLiquidityRisk(input({ displayedLiquidityUsd: 0, poolType: 'constant_product' }), CFG);
    expect(r.liquidityToMcapRatio).toBeNull();
    expect(r.poolFloatFractionEstimate).toBeNull();
    expect(r.overhangMultiple).toBeNull();
    expect(r.estimatedOneWaySlippagePct).toBeNull();
    expect(r.dumpToHalveUsd).toBeNull();
    expect(r.positionSizeMaxFor2PctSlippageUsd).toBeNull();
    expect(r.absoluteLiquidityBand).toBe('unknown');
    expect(r.ratioFragilityBand).toBe('unknown');
    expect(r.confidence).toBe('low');
  });

  it('non-finite inputs (NaN / Infinity) are guarded like <=0', () => {
    const rNaN = computeLiquidityRisk(input({ marketCapUsd: NaN }), CFG);
    expect(rNaN.liquidityToMcapRatio).toBeNull();
    expect(rNaN.confidence).toBe('low');
    const rInf = computeLiquidityRisk(input({ displayedLiquidityUsd: Infinity }), CFG);
    expect(rInf.liquidityToMcapRatio).toBeNull();
    expect(rInf.confidence).toBe('low');
  });
});

describe('computeLiquidityRisk — band thresholds at boundaries', () => {
  // absoluteLiquidityBandsUsd [10000, 50000, 250000]; boundary belongs to the HIGHER band.
  it('absolute band boundaries (boundary value => higher band)', () => {
    const band = (L: number) =>
      computeLiquidityRisk(input({ displayedLiquidityUsd: L, marketCapUsd: 100_000_000 }), CFG).absoluteLiquidityBand;
    expect(band(9_999.99)).toBe('micro');
    expect(band(10_000)).toBe('thin');       // == t0 => thin
    expect(band(49_999.99)).toBe('thin');
    expect(band(50_000)).toBe('moderate');    // == t1 => moderate
    expect(band(249_999.99)).toBe('moderate');
    expect(band(250_000)).toBe('deep');       // == t2 => deep
    expect(band(1_000_000)).toBe('deep');
  });

  it('ratio fragility band boundaries (boundary value => higher band)', () => {
    // Fix MC=1_000_000 and vary L so ratio hits exact thresholds.
    const band = (ratio: number) =>
      computeLiquidityRisk(input({ displayedLiquidityUsd: ratio * 1_000_000, marketCapUsd: 1_000_000 }), CFG)
        .ratioFragilityBand;
    expect(band(0.019)).toBe('very_fragile');
    expect(band(0.02)).toBe('fragile');       // == r0 => fragile
    expect(band(0.049)).toBe('fragile');
    expect(band(0.05)).toBe('moderate');       // == r1 => moderate
    expect(band(0.149)).toBe('moderate');
    expect(band(0.15)).toBe('robust');         // == r2 => robust
    expect(band(0.5)).toBe('robust');
  });
});

describe('computeLiquidityRisk — no buy/sell language (shadow-only, describes fragility not action)', () => {
  it('no caveat contains trade-action words', () => {
    const cases: LiquidityRiskInput[] = [
      input({ poolType: 'constant_product' }),
      input({ poolType: 'concentrated' }),
      input({ poolType: 'unknown' }),
      input({ marketCapUsd: 0 }),
      input({ displayedLiquidityUsd: 0 })
    ];
    const forbidden = /\b(buy|sell|long|short|entry|exit|ape|dump it|take profit)\b/i;
    for (const c of cases) {
      for (const cav of computeLiquidityRisk(c, CFG).caveats) {
        expect(forbidden.test(cav)).toBe(false);
      }
    }
  });
});
