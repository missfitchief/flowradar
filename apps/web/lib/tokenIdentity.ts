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

/** Resolve a token's display identity. `meta` is a token_metadata row (or
 *  null); `ingestSymbol` is the placeholder from the tokens table. */
export function resolveTokenIdentity(mint: string, meta: TokenMeta | null | undefined, ingestSymbol?: string | null): ResolvedIdentity {
  if (meta && meta.availability === 'resolved' && meta.symbol && !isPlaceholderSymbol(mint, meta.symbol, meta.name)) {
    return { display: `$${meta.symbol}`, symbol: meta.symbol, name: meta.name, logoUri: meta.logoUri, mint, isUnknown: false };
  }
  // Never fall back to the ingest placeholder — it is a mint prefix.
  return { display: 'Unknown token', symbol: null, name: null, logoUri: meta?.logoUri ?? null, mint, isUnknown: true };
}

export function shortMint(mint: string): string {
  return mint.length > 12 ? `${mint.slice(0, 5)}…${mint.slice(-4)}` : mint;
}

export function solscanTokenUrl(mint: string): string {
  return `https://solscan.io/token/${mint}`;
}
