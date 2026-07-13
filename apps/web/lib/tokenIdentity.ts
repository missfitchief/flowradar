// FlowRadar — token identity resolution (live-recovery sprint).
// The ingest stored `symbol`/`name` as a mint prefix (a placeholder), so a
// mint substring must NEVER be shown as a token symbol. This resolves the
// real identity from token_metadata when available, else "Unknown token".
//
// SINGLE SOURCE OF TRUTH: the builder (buildTokenMetadata) is the only place
// placeholder-vs-real is decided — it evaluates symbol/name independently and
// trusts a DAS logo as proof a short symbol is a real project, then NULLs out
// any field it judged a placeholder before writing availability='resolved'.
// This UI therefore MUST NOT re-run the prefix heuristic on a resolved row
// (doing so hid logo-backed short symbols like a legit "ABC"). It simply
// trusts the vetted, non-null fields the builder persisted.

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
/** A case-sensitive mint-prefix string (>=3 chars) must NEVER be shown as a
 *  symbol or name — this is the last line of defense at the render boundary, so
 *  the absolute invariant holds even for a stale row persisted under an older
 *  classifier version. Kept local (not imported) to avoid pulling @flowradar/db
 *  across the RSC boundary. */
function isMintPrefix(mint: string, s: string | null): boolean {
  return !!s && s.length >= 3 && mint.startsWith(s);
}

export function resolveTokenIdentity(mint: string, meta: TokenMeta | null | undefined): ResolvedIdentity {
  if (meta && meta.availability === 'resolved') {
    // Sanitize symbol AND name INDEPENDENTLY — a mint prefix in EITHER field is
    // dropped, so a stale pre-vN row can never leak a prefix as a symbol or as
    // a name (e.g. {symbol:"SAFE", name:"ABC"} on mint "ABCxyz" must not show
    // "ABC" as the name).
    const safeSymbol = meta.symbol && !isMintPrefix(mint, meta.symbol) ? meta.symbol : null;
    const safeName = meta.name && !isMintPrefix(mint, meta.name) ? meta.name : null;
    if (safeSymbol) {
      return { display: `$${safeSymbol}`, symbol: safeSymbol, name: safeName, logoUri: meta.logoUri, mint, isUnknown: false };
    }
    // Name-only resolution (real name, no safe symbol) — still a real identity.
    if (safeName) {
      return { display: safeName, symbol: null, name: safeName, logoUri: meta.logoUri, mint, isUnknown: false };
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
