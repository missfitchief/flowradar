// FlowRadar — social: snippet normalization + content hash (spec §3).
//
// PURE. node:crypto is a Node builtin (no new runtime dep; matches spec's
// "hash(normalizedSnippet) via Node crypto"). normalizeSnippet produces the
// copy-paste comparison key: lowercase, urls/emojis/mentions/punctuation
// stripped, whitespace collapsed, truncated to <= 280 chars (schema limit).

import { createHash } from 'node:crypto';

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

/** sha256 hex digest of a normalized snippet — the copy-paste grouping key. */
export function contentHash(normalized: string): string {
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}
