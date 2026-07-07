import { describe, expect, it } from 'vitest';
import { normalizeSnippet, contentHash } from '../../src/social/normalize';

describe('normalizeSnippet', () => {
  it('lowercases, strips urls/emojis/mentions/punctuation and collapses whitespace', () => {
    const raw = 'BUY $NOVA NOW!!! 🚀🚀 https://pump.fun/abc @caller_bot  going   PARABOLIC';
    const out = normalizeSnippet(raw);
    expect(out).toBe('buy nova now going parabolic');
    expect(out).not.toContain('http');
    expect(out).not.toContain('@');
    expect(out).not.toMatch(/[🚀!]/u);
  });

  it('two posts that differ only in urls/emojis/case/spacing normalize identically (copy-paste key)', () => {
    const a = 'Ape $NOVA 🔥 https://dexscreener.com/solana/So11111111111111111111111111111111111111112';
    const b = 'ape   $nova https://birdeye.so/token/So11111111111111111111111111111111111111112 🔥🔥🔥';
    expect(normalizeSnippet(a)).toBe(normalizeSnippet(b));
  });

  it('truncates the normalized snippet to <= 280 chars', () => {
    const raw = 'gm '.repeat(200); // 600 chars pre-normalize
    expect(normalizeSnippet(raw).length).toBeLessThanOrEqual(280);
  });

  it('empty / whitespace-only content normalizes to empty string', () => {
    expect(normalizeSnippet('')).toBe('');
    expect(normalizeSnippet('   \n\t  ')).toBe('');
    expect(normalizeSnippet('🚀🚀🚀')).toBe('');
  });
});

describe('contentHash', () => {
  it('is deterministic and stable for identical normalized input', () => {
    const n = normalizeSnippet('Ape $NOVA now 🔥');
    expect(contentHash(n)).toBe(contentHash(n));
  });

  it('is a stable, non-empty deterministic string (non-cryptographic grouping hash)', () => {
    const h = contentHash('buy nova now');
    expect(typeof h).toBe('string');
    expect(h.length).toBeGreaterThan(0);
    expect(contentHash('buy nova now')).toBe(h);
  });

  it('differs for different normalized content', () => {
    expect(contentHash('buy nova now')).not.toBe(contentHash('buy quiet now'));
  });

  it('copy-paste posts (same normalized snippet) share one hash', () => {
    const a = normalizeSnippet('Ape $NOVA 🔥 https://pump.fun/x');
    const b = normalizeSnippet('ape $nova https://birdeye.so/token/y 🔥🔥');
    expect(contentHash(a)).toBe(contentHash(b));
  });
});
