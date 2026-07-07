// FlowRadar — social: snippet normalization + content hash (spec §3).
//
// PURE, and deliberately free of any `node:` builtin import — this module is
// re-exported through the @flowradar/core barrel, which a client component
// (apps/web/components/graph/GraphCanvas.tsx) imports at runtime, so anything
// exported here must bundle cleanly for the browser as well as the server.
// normalizeSnippet produces the copy-paste comparison key: lowercase,
// urls/emojis/mentions/punctuation stripped, whitespace collapsed, truncated
// to <= 280 chars (schema limit).

const MAX_SNIPPET_LEN = 280;

// URL (http/https/www) — removed wholesale so links never affect the key.
const URL_RE = /\b(?:https?:\/\/|www\.)\S+/gi;
// @mentions / t.me handles — opaque, removed.
const MENTION_RE = /@[a-z0-9_]+/gi;
// Everything that is NOT a-z, 0-9 or whitespace (after lowercasing) — strips
// punctuation, emojis, and every non-ASCII symbol in one pass.
const NON_ALNUM_RE = /[^a-z0-9\s]/g;
const WS_RE = /\s+/g;

/**
 * Normalizes post content into a stable copy-paste key: lowercased, with URLs,
 * @mentions, emojis, and punctuation stripped, whitespace collapsed to single
 * spaces, and truncated to <= 280 chars. Two posts that differ only in
 * links/emojis/case/spacing normalize to the SAME string.
 */
export function normalizeSnippet(content: string): string {
  const normalized = content
    .toLowerCase()
    .replace(URL_RE, ' ')
    .replace(MENTION_RE, ' ')
    .replace(NON_ALNUM_RE, ' ')
    .replace(WS_RE, ' ')
    .trim();
  return normalized.length > MAX_SNIPPET_LEN ? normalized.slice(0, MAX_SNIPPET_LEN) : normalized;
}

/**
 * Deterministic, non-cryptographic grouping hash of a normalized snippet —
 * used only to bucket identical normalized post content together for
 * copy-paste detection (see packages/db/src/social/ingest.ts). It is NOT a
 * security/integrity hash: no collision-resistance guarantees are needed,
 * only "same input -> same output" and a low real-world collision rate for
 * short social-post strings. Implemented as a self-contained, pure-JS
 * cyrb53 (no `node:` builtin import) so @flowradar/core stays safe to bundle
 * into the browser as well as run on the server.
 *
 * Returns a stable base36 string. Same input always yields the same output;
 * different inputs are extremely unlikely to collide (53-bit output space).
 */
export function contentHash(normalized: string): string {
  let h1 = 0xdeadbeef ^ 0;
  let h2 = 0x41c6ce57 ^ 0;
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const combined = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return combined.toString(36);
}
