import { describe, expect, it } from 'vitest';
import { extractMentions } from '../../src/social/extractMentions';

// A real-length Solana base58 mint (44 chars, no 0/O/I/l) used across cases.
const CA = '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr';

describe('extractMentions (SOLANA)', () => {
  it('extracts a bare contract address with confidence 90', () => {
    const out = extractMentions(`aping ${CA} now`, 'SOLANA');
    expect(out).toEqual([
      { mentionType: 'address', tokenAddress: CA, tokenSymbol: null, tokenUrl: null, confidence: 90 }
    ]);
  });

  it('extracts an address embedded in a dexscreener URL as a url mention (conf 85)', () => {
    const out = extractMentions(`chart: https://dexscreener.com/solana/${CA}`, 'SOLANA');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      mentionType: 'url',
      tokenAddress: CA,
      tokenUrl: `https://dexscreener.com/solana/${CA}`,
      confidence: 85
    });
  });

  it('extracts addresses from pump.fun / birdeye / solscan / jup URLs', () => {
    for (const url of [
      `https://pump.fun/${CA}`,
      `https://birdeye.so/token/${CA}`,
      `https://solscan.io/token/${CA}`,
      `https://jup.ag/swap/SOL-${CA}`
    ]) {
      const out = extractMentions(`look ${url}`, 'SOLANA');
      expect(out).toHaveLength(1);
      expect(out[0].mentionType).toBe('url');
      expect(out[0].tokenAddress).toBe(CA);
      expect(out[0].tokenUrl).toBe(url);
    }
  });

  it('extracts a $TICKER cashtag with confidence 40 (symbol uppercased, no $)', () => {
    const out = extractMentions('sending $nova to the moon', 'SOLANA');
    expect(out).toEqual([
      { mentionType: 'ticker', tokenAddress: null, tokenSymbol: 'NOVA', tokenUrl: null, confidence: 40 }
    ]);
  });

  it('returns [] for a no-token post', () => {
    expect(extractMentions('gm frens wagmi', 'SOLANA')).toEqual([]);
  });

  it('mixed post → one address + one distinct ticker (2 rows)', () => {
    const out = extractMentions(`ape ${CA} and also $QUIET`, 'SOLANA');
    const types = out.map((m) => m.mentionType).sort();
    expect(types).toEqual(['address', 'ticker']);
    expect(out.find((m) => m.mentionType === 'address')?.tokenAddress).toBe(CA);
    expect(out.find((m) => m.mentionType === 'ticker')?.tokenSymbol).toBe('QUIET');
  });

  it('collapses an address + its own URL for the SAME token to ONE mention', () => {
    // address prefers the URL form (or bare); either way the resolved
    // tokenAddress is deduped so a post with both CA and its dexscreener URL
    // yields exactly one row for that token.
    const out = extractMentions(`${CA} https://dexscreener.com/solana/${CA}`, 'SOLANA');
    expect(out).toHaveLength(1);
    expect(out[0].tokenAddress).toBe(CA);
  });

  it('does NOT flag a short base58-looking word as an address (false-positive guard)', () => {
    // 31 chars — below the 32-char CA floor.
    expect(extractMentions('gmgmgmgmgmgmgmgmgmgmgmgmgmgmgmg', 'SOLANA')).toEqual([]);
    // ordinary English words are never addresses
    expect(extractMentions('this is a totally normal sentence about tokens', 'SOLANA')).toEqual([]);
  });

  it('does NOT extract anything for a non-SOLANA chain (Solana-only, spec §3/global constraint 8)', () => {
    expect(extractMentions(`bsc post ${CA} $NOVA`, 'BSC')).toEqual([]);
  });

  it('dedupes a repeated cashtag within one post', () => {
    const out = extractMentions('$NOVA $NOVA $NOVA', 'SOLANA');
    expect(out.filter((m) => m.mentionType === 'ticker')).toHaveLength(1);
  });

  it('does NOT flag a pure-alphabetic base58-safe run as an address (prose false-positive guard)', () => {
    // 40 chars, base58-safe alphabet, but no digits — a prose/camelCase run, not a CA.
    const out = extractMentions('gm frens check aBcDeFgHiJkLmNoPqRsTuVwXyZabcdefghijkPQR now', 'SOLANA');
    expect(out.filter((m) => m.mentionType === 'address')).toHaveLength(0);
  });

  it('still extracts a realistic digit-containing bare CA as an address (USDC mint)', () => {
    const usdc = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const out = extractMentions(`swapping into ${usdc} today`, 'SOLANA');
    expect(out).toEqual([
      { mentionType: 'address', tokenAddress: usdc, tokenSymbol: null, tokenUrl: null, confidence: 90 }
    ]);
  });
});
