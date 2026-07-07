// FlowRadar — social: pure token-mention extractor (spec §3).
//
// PURE. Solana-only (global constraint 8): returns [] for any non-SOLANA chain.
// Detects, in priority order, so an address + its own token URL collapse to
// ONE mention for the same token:
//   1. Token URLs (dexscreener/birdeye/pump.fun/solscan/jup) → embedded address
//   2. Bare contract addresses (base58, 32–44 chars)
//   3. $TICKER cashtags (2–10 uppercase alnum)
// Dedup within a post by resolved tokenAddress (url/address) and by symbol
// (ticker). Confidence: address 90, url 85, ticker 40.

import type { Chain } from '../types';
import type { ExtractedMention } from './types';

// Solana base58 alphabet excludes 0 O I l. A mint is 32–44 chars.
const BASE58 = '[1-9A-HJ-NP-Za-km-z]';
const ADDRESS_CORE = `${BASE58}{32,44}`;
const ADDRESS_RE = new RegExp(ADDRESS_CORE, 'g');

// Token URLs whose path embeds a Solana address. Ordered patterns; each
// capture group 1 is the address. `\S*` after the host lets a trailing
// SOL- prefix (jup swap route) or path segment precede the address.
const URL_PATTERNS: RegExp[] = [
  new RegExp(`https?://(?:www\\.)?dexscreener\\.com/solana/(${ADDRESS_CORE})`, 'gi'),
  new RegExp(`https?://(?:www\\.)?birdeye\\.so/token/(${ADDRESS_CORE})`, 'gi'),
  new RegExp(`https?://(?:www\\.)?solscan\\.io/token/(${ADDRESS_CORE})`, 'gi'),
  new RegExp(`https?://(?:www\\.)?pump\\.fun/(?:coin/)?(${ADDRESS_CORE})`, 'gi'),
  new RegExp(`https?://(?:www\\.)?jup\\.ag/\\S*?(${ADDRESS_CORE})`, 'gi')
];

// $TICKER: 2–10 uppercase alnum, must start with a letter so `$100` is not a
// ticker. Case-insensitive match, uppercased on capture.
const CASHTAG_RE = /\$([A-Za-z][A-Za-z0-9]{1,9})\b/g;

export function extractMentions(content: string, chain: Chain): ExtractedMention[] {
  if (chain !== 'SOLANA') return [];

  const byAddress = new Map<string, ExtractedMention>();
  const bySymbol = new Map<string, ExtractedMention>();

  // -- 1. Token URLs first (so the URL form wins the address for a token) ---
  for (const re of URL_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const addr = m[1]!;
      const url = m[0]!;
      if (!byAddress.has(addr)) {
        byAddress.set(addr, {
          mentionType: 'url',
          tokenAddress: addr,
          tokenSymbol: null,
          tokenUrl: url,
          confidence: 85
        });
      }
    }
  }

  // -- 2. Bare contract addresses (skip any already captured via a URL) ----
  // Strip URLs before scanning for bare addresses so a URL's embedded address
  // isn't re-matched as a second, bare mention.
  const contentSansUrls = content.replace(/\bhttps?:\/\/\S+/gi, ' ');
  ADDRESS_RE.lastIndex = 0;
  let am: RegExpExecArray | null;
  while ((am = ADDRESS_RE.exec(contentSansUrls)) !== null) {
    const addr = am[0]!;
    // Real mint addresses (base58 of a 32-byte pubkey) almost always contain
    // a digit; pure-alphabetic runs are usually prose/camelCase, not a CA.
    if (!/[1-9]/.test(addr)) continue;
    if (!byAddress.has(addr)) {
      byAddress.set(addr, {
        mentionType: 'address',
        tokenAddress: addr,
        tokenSymbol: null,
        tokenUrl: null,
        confidence: 90
      });
    }
  }

  // -- 3. Cashtags (deduped by uppercased symbol) --------------------------
  CASHTAG_RE.lastIndex = 0;
  let cm: RegExpExecArray | null;
  while ((cm = CASHTAG_RE.exec(content)) !== null) {
    const symbol = cm[1]!.toUpperCase();
    if (!bySymbol.has(symbol)) {
      bySymbol.set(symbol, {
        mentionType: 'ticker',
        tokenAddress: null,
        tokenSymbol: symbol,
        tokenUrl: null,
        confidence: 40
      });
    }
  }

  return [...byAddress.values(), ...bySymbol.values()];
}
