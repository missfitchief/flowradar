// FlowRadar — confluence: shared pure types (design doc "Module B — LiquidityRisk").
//
// packages/core is PURE (zero I/O, zod is the only runtime dep, NO node: builtins —
// this file must stay client-bundle-safe). These types are the contract every
// later confluence task (providers, worker/ingest, db queries, web ConfluencePanel)
// imports from @flowradar/core.
//
// Shadow-only: NOTHING here feeds FlowScore, the signal engine, or wallet scoring.

/** Pool structure hint for the CPMM identities. `concentrated` (CLMM) breaks
 *  the simple L≈2·Q / ratio→float mapping, so it downgrades confidence and adds
 *  a prominent caveat rather than trusting the numbers. */
export type PoolType = 'constant_product' | 'concentrated' | 'unknown';

/** Inputs to computeLiquidityRisk. L = displayed pool liquidity (USD), MC = market
 *  cap (USD), S = the operator-configured position size used for the slippage
 *  estimate. All are FlowRadar-internal market values — no provider key involved. */
export interface LiquidityRiskInput {
  displayedLiquidityUsd: number;
  marketCapUsd: number;
  positionSizeUsd: number;
  poolType?: PoolType;
}

/** Display-only band thresholds (Settings-configurable). Each is three ASCENDING
 *  numbers; a value on a threshold belongs to the HIGHER band. NOT a FlowScore input. */
export interface LiquidityRiskConfig {
  absoluteLiquidityBandsUsd: [number, number, number];
  ratioFragilityBands: [number, number, number];
}

export type AbsoluteLiquidityBand = 'micro' | 'thin' | 'moderate' | 'deep' | 'unknown';
export type RatioFragilityBand = 'very_fragile' | 'fragile' | 'moderate' | 'robust' | 'unknown';
export type ConfidenceLevel = 'high' | 'medium' | 'low';

/** Result of computeLiquidityRisk. Numeric fields are null when the market data
 *  is missing/invalid (MC<=0 or L<=0 or non-finite) — absence is NEVER rendered as
 *  a reassuring band. `caveats` always describes fragility, never a buy/sell action. */
export interface LiquidityRiskResult {
  liquidityToMcapRatio: number | null;
  poolFloatFractionEstimate: number | null;
  overhangMultiple: number | null;
  estimatedOneWaySlippagePct: number | null;
  dumpToHalveUsd: number | null;
  positionSizeMaxFor2PctSlippageUsd: number | null;
  absoluteLiquidityBand: AbsoluteLiquidityBand;
  ratioFragilityBand: RatioFragilityBand;
  caveats: string[];
  confidence: ConfidenceLevel;
}
