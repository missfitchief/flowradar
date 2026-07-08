// FlowRadar — confluence: pure LiquidityRisk computation (design doc "Module B").
//
// PURE, sync, deterministic — no DB, no network, no provider key. Constant-product
// AMM (CPMM) identities computed from displayed liquidity + market cap. HIGH
// confidence only for a single fresh CPMM pool; CONCENTRATED (CLMM) pools break the
// ratio→float / slippage mapping, so they are surfaced with confidence 'low' + a
// prominent caveat rather than trusted. Absence of data => null numeric fields +
// confidence 'low' + 'unknown' bands (NEVER a reassuring band). Bands are shadow-only
// display heuristics; NOTHING here participates in FlowScore. No buy/sell language.

import type {
  AbsoluteLiquidityBand,
  LiquidityRiskConfig,
  LiquidityRiskInput,
  LiquidityRiskResult,
  RatioFragilityBand
} from './types';

function isValidPositive(n: number): boolean {
  return Number.isFinite(n) && n > 0;
}

// Boundary value belongs to the HIGHER band (thresholds are lower-inclusive of the
// upper band): L < t0 => first band; L >= t2 => top band.
function absoluteBand(
  liquidityUsd: number,
  [t0, t1, t2]: [number, number, number]
): AbsoluteLiquidityBand {
  if (!isValidPositive(liquidityUsd)) return 'unknown';
  if (liquidityUsd < t0) return 'micro';
  if (liquidityUsd < t1) return 'thin';
  if (liquidityUsd < t2) return 'moderate';
  return 'deep';
}

function ratioBand(
  ratio: number | null,
  [r0, r1, r2]: [number, number, number]
): RatioFragilityBand {
  if (ratio === null || !Number.isFinite(ratio)) return 'unknown';
  if (ratio < r0) return 'very_fragile';
  if (ratio < r1) return 'fragile';
  if (ratio < r2) return 'moderate';
  return 'robust';
}

export function computeLiquidityRisk(
  input: LiquidityRiskInput,
  cfg: LiquidityRiskConfig
): LiquidityRiskResult {
  const { displayedLiquidityUsd: L, marketCapUsd: MC, positionSizeUsd: S, poolType } = input;

  const caveats: string[] = [];
  const lOk = isValidPositive(L);
  const mcOk = isValidPositive(MC);
  const isConcentrated = poolType === 'concentrated';

  // --- Ratio-derived (need BOTH L and MC valid) ---
  const ratio = lOk && mcOk ? L / MC : null;
  const poolFloatFractionEstimate = ratio === null ? null : ratio / 2;
  const overhangMultiple = ratio === null ? null : 2 / ratio - 1;

  // --- L-derived (need L valid; S must be finite & >= 0 for slippage) ---
  const estimatedOneWaySlippagePct =
    lOk && Number.isFinite(S) && S >= 0 ? (100 * 2 * S) / L : null;
  const dumpToHalveUsd = lOk ? 0.207 * L : null;
  const positionSizeMaxFor2PctSlippageUsd = lOk ? 0.01 * L : null;

  const absoluteLiquidityBand = absoluteBand(L, cfg.absoluteLiquidityBandsUsd);
  const ratioFragilityBand = ratioBand(ratio, cfg.ratioFragilityBands);

  // --- Confidence + caveats ---
  let confidence: LiquidityRiskResult['confidence'];
  if (!lOk || !mcOk) {
    // Missing/invalid market data: never a reassuring read.
    confidence = 'low';
    if (!mcOk) caveats.push('Market cap is missing or invalid; the L/MC ratio and float/overhang estimates are unavailable.');
    if (!lOk) caveats.push('Displayed liquidity is missing or invalid; slippage and depth estimates are unavailable.');
  } else if (isConcentrated) {
    // CLMM: numbers still shown but flagged as unreliable.
    confidence = 'low';
    caveats.push(
      'Concentrated-liquidity (CLMM) pool: the constant-product identities (ratio→float, slippage, dump-to-halve) are UNRELIABLE here — treat these numbers as indicative only.'
    );
  } else if (poolType === 'constant_product') {
    confidence = 'high';
  } else {
    // 'unknown' or undefined — apply CPMM identities under a stated assumption.
    confidence = 'medium';
    caveats.push('Pool type is unknown; figures assume a single constant-product (CPMM) pool.');
  }

  // Always-on caveats for any computed (non-guarded) result.
  if (lOk && mcOk) {
    caveats.push('Displayed liquidity may be aggregated across multiple pools, which can distort these figures.');
    caveats.push('Market data may be stale.');
    caveats.push('Holder concentration and LP lock/burn status can dominate this L/MC ratio.');
  }

  return {
    liquidityToMcapRatio: ratio,
    poolFloatFractionEstimate,
    overhangMultiple,
    estimatedOneWaySlippagePct,
    dumpToHalveUsd,
    positionSizeMaxFor2PctSlippageUsd,
    absoluteLiquidityBand,
    ratioFragilityBand,
    caveats,
    confidence
  };
}
