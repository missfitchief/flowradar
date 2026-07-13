// FlowRadar — token identity resolution (live-recovery sprint).
// The ingest stored `symbol`/`name` as a mint prefix (a placeholder), so a
// mint substring must NEVER be shown as a token symbol. This resolves the
// real identity from token_metadata when available, else "Unknown token".
import { isPlaceholderSymbol } from '@flowradar/db';

export interface TokenMeta {
  mint: string;
  name: string | null;
  symbol: string | null;
  logoUri: string | null;
  availability: string;
}

export interface ResolvedIdentity {
  /** Human display: "$SYMBOL", a name, or "Unknown token". */
  display: string;
  symbol: string | null;
  name: string | null;
  logoUri: string | null;
  mint: string;
  isUnknown: boolean;
}

/** Resolve a token's display identity from a token_metadata row. Never falls
 *  back to the ingest placeholder (a mint prefix). Uses a real symbol, or a
 *  real name when only the name resolved, else "Unknown token". */
export function resolveTokenIdentity(mint: string, meta: TokenMeta | null | undefined): ResolvedIdentity {
  if (meta && meta.availability === 'resolved') {
    if (meta.symbol && !isPlaceholderSymbol(mint, meta.symbol, meta.name)) {
      return { display: `$${meta.symbol}`, symbol: meta.symbol, name: meta.name, logoUri: meta.logoUri, mint, isUnknown: false };
    }
    // Name-only resolution (real name, no symbol) — still a real identity.
    if (meta.name && !isPlaceholderSymbol(mint, meta.name, meta.name)) {
      return { display: meta.name, symbol: null, name: meta.name, logoUri: meta.logoUri, mint, isUnknown: false };
    }
  }
  return { display: 'Unknown token', symbol: null, name: null, logoUri: meta?.logoUri ?? null, mint, isUnknown: true };
}

export function shortMint(mint: string): string {
  return mint.length > 12 ? `${mint.slice(0, 5)}…${mint.slice(-4)}` : mint;
}

export function solscanTokenUrl(mint: string): string {
  return `https://solscan.io/token/${mint}`;
}
