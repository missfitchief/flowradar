// FlowRadar — Capital Lineage (Wave A): pure honest transfer valuation.
//
// The HONEST value model (operator directive): an unknown price is NEVER
// numeric zero, a genuine zero stays a genuine zero, a current-price estimate
// never masquerades as an exact historical price, and a FUTURE snapshot is
// never used to value a past transfer. Pure: price sources are resolved in the
// DB layer and passed in as plain data; this function only decides which
// source wins and produces the valuation record.

export type ValuationStatus =
  | 'exact_provider_historical'
  | 'nearest_prior_snapshot'
  | 'stablecoin_nominal'
  | 'current_price_estimate'
  | 'unavailable'
  | 'not_applicable';

/** How the transfer's asset is classified — decided by REGISTRY, not symbol. */
export type AssetKind = 'native_sol' | 'stablecoin' | 'spl' | 'service' | 'unknown';

export interface PricePoint {
  priceUsd: number;
  ts: Date;
}

export interface ValuationInput {
  assetKind: AssetKind;
  /** Raw token amount (always preserved regardless of valuation). */
  amountToken: number;
  transferTs: Date;
  /** Max age of a "nearest prior snapshot" to still be usable, seconds. */
  maxSnapshotAgeSec: number;
  /**
   * A USD value the PROVIDER already computed for this transfer at ingest. A
   * POSITIVE value is an exact_provider_historical valuation (authoritative
   * for this transfer); a value of 0 means the provider did NOT price it
   * (e.g. Helius native SOL) and is IGNORED — never treated as a real zero,
   * so our own sources are tried and it degrades to unavailable if none.
   */
  providerValueUsd?: number | null;
  /** Exact historical price at/just before transfer (highest precedence). */
  historicalExact?: PricePoint | null;
  /** Nearest LOCAL market snapshot at or before the transfer. */
  priorSnapshot?: PricePoint | null;
  /** A snapshot AFTER the transfer — accepted only to prove it is REJECTED. */
  futureSnapshot?: PricePoint | null;
  /** Current provider price — last-resort estimate, clearly labeled. */
  currentPrice?: PricePoint | null;
}

export interface ValuationResult {
  valuedUsd: number | null;
  priceUsd: number | null;
  priceTimestamp: Date | null;
  status: ValuationStatus;
  source: string | null;
  confidence: number; // 0-100
  ageSeconds: number | null;
  reason: string | null;
}

const STABLECOIN_NOMINAL_USD = 1;

// Verified canonical Solana mints (classification is by ADDRESS, not symbol
// text — hard rule A3). A token merely NAMED USDC/USDT does not qualify.
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const VERIFIED_SOLANA_STABLE_MINTS = new Set<string>([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC (Solana mint)
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB' // USDT (Solana mint)
]);

/**
 * Classifies a transfer's asset for valuation, by mint ADDRESS (never symbol
 * text). Native SOL = wSOL mint or a null mint with symbol SOL. A verified
 * stablecoin mint => stablecoin. Any other mint => spl. `isServiceLeg` (from
 * the caller's action-type/registry knowledge) forces `service`.
 */
export function classifyAsset(params: { symbol: string; assetMint: string | null; isServiceLeg?: boolean }): AssetKind {
  if (params.isServiceLeg) return 'service';
  if (params.assetMint === null) {
    return params.symbol === 'SOL' ? 'native_sol' : 'unknown';
  }
  if (params.assetMint === WSOL_MINT) return 'native_sol';
  if (VERIFIED_SOLANA_STABLE_MINTS.has(params.assetMint)) return 'stablecoin';
  return 'spl';
}

function ageSec(transferTs: Date, priceTs: Date): number {
  return Math.round(Math.abs(transferTs.getTime() - priceTs.getTime()) / 1000);
}

/** A usable price is finite and strictly positive (Codex round: a zero/NaN/inf price must not create a false genuine $0). */
function usablePrice(p: PricePoint | null | undefined): p is PricePoint {
  return p != null && Number.isFinite(p.priceUsd) && p.priceUsd > 0;
}

export function computeValuation(inp: ValuationInput): ValuationResult {
  // Service / internal / bridge legs are never valued as direct wallet funding.
  if (inp.assetKind === 'service') {
    return { valuedUsd: null, priceUsd: null, priceTimestamp: null, status: 'not_applicable', source: null, confidence: 0, ageSeconds: null, reason: 'service/internal movement — not direct wallet funding' };
  }

  // A positive provider-supplied USD value is an exact historical valuation
  // (the provider priced it at the transfer). Precedes stablecoin nominal so a
  // provider-valued USDC transfer is exact, not nominal. A 0/non-finite value
  // is "unpriced" and ignored.
  if (inp.providerValueUsd != null && Number.isFinite(inp.providerValueUsd) && inp.providerValueUsd > 0) {
    return {
      valuedUsd: inp.providerValueUsd,
      priceUsd: inp.amountToken !== 0 ? inp.providerValueUsd / inp.amountToken : null,
      priceTimestamp: inp.transferTs,
      status: 'exact_provider_historical',
      source: 'provider_ingest_valuation',
      confidence: 90,
      ageSeconds: 0,
      reason: 'provider-supplied USD value at ingest'
    };
  }

  // Verified stablecoin (registry-confirmed mint): nominal $1 with an explicit
  // possible-depeg caveat and sub-100 confidence.
  if (inp.assetKind === 'stablecoin') {
    return {
      valuedUsd: inp.amountToken * STABLECOIN_NOMINAL_USD,
      priceUsd: STABLECOIN_NOMINAL_USD,
      priceTimestamp: inp.transferTs,
      status: 'stablecoin_nominal',
      source: 'stablecoin_registry',
      confidence: 90,
      ageSeconds: 0,
      reason: 'verified stablecoin mint valued at nominal $1 (possible depeg not accounted for)'
    };
  }

  // Precedence for native SOL and SPL: exact historical > nearest prior
  // snapshot (within max age) > current-price estimate > unavailable.
  // historicalExact must be at/before the transfer (no lookahead) and usable.
  if (usablePrice(inp.historicalExact) && inp.historicalExact.ts.getTime() <= inp.transferTs.getTime()) {
    return {
      valuedUsd: inp.amountToken * inp.historicalExact.priceUsd,
      priceUsd: inp.historicalExact.priceUsd,
      priceTimestamp: inp.historicalExact.ts,
      status: 'exact_provider_historical',
      source: 'provider_historical',
      confidence: 95,
      ageSeconds: ageSec(inp.transferTs, inp.historicalExact.ts),
      reason: 'exact historical price at/just before transfer'
    };
  }

  if (usablePrice(inp.priorSnapshot) && inp.priorSnapshot.ts.getTime() <= inp.transferTs.getTime()) {
    const age = ageSec(inp.transferTs, inp.priorSnapshot.ts);
    if (age <= inp.maxSnapshotAgeSec) {
      return {
        valuedUsd: inp.amountToken * inp.priorSnapshot.priceUsd,
        priceUsd: inp.priorSnapshot.priceUsd,
        priceTimestamp: inp.priorSnapshot.ts,
        status: 'nearest_prior_snapshot',
        source: inp.assetKind === 'native_sol' ? 'wsol_prior_snapshot' : 'spl_prior_snapshot',
        confidence: 75,
        ageSeconds: age,
        reason: `nearest prior local snapshot within ${inp.maxSnapshotAgeSec}s`
      };
    }
    // Stale prior snapshot: fall through to current estimate / unavailable.
  }

  if (usablePrice(inp.currentPrice)) {
    return {
      valuedUsd: inp.amountToken * inp.currentPrice.priceUsd,
      priceUsd: inp.currentPrice.priceUsd,
      priceTimestamp: inp.currentPrice.ts,
      status: 'current_price_estimate',
      source: 'provider_current',
      confidence: 40,
      ageSeconds: ageSec(inp.transferTs, inp.currentPrice.ts),
      reason: 'no historical source — CURRENT price estimate only (not exact; may differ from value at transfer time)'
    };
  }

  return { valuedUsd: null, priceUsd: null, priceTimestamp: null, status: 'unavailable', source: null, confidence: 0, ageSeconds: null, reason: 'no historical, prior-snapshot, or current price source available' };
}
