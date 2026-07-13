// FlowRadar — resolveTokenIdentity: the absolute "never show a mint prefix as a
// symbol OR name" invariant, enforced at the render boundary.
import { describe, expect, it } from 'vitest';
import { resolveTokenIdentity } from '../lib/tokenIdentity';

const MINT = 'ABCxyz1234567890';

describe('resolveTokenIdentity', () => {
  it('shows a real symbol', () => {
    const r = resolveTokenIdentity(MINT, { mint: MINT, symbol: 'SAFE', name: 'Safe Token', logoUri: null, availability: 'resolved' });
    expect(r.display).toBe('$SAFE');
    expect(r.symbol).toBe('SAFE');
    expect(r.isUnknown).toBe(false);
  });

  it('drops a mint-prefix SYMBOL and falls back to the real name', () => {
    const r = resolveTokenIdentity(MINT, { mint: MINT, symbol: 'ABC', name: 'Acme Token', logoUri: null, availability: 'resolved' });
    expect(r.symbol).toBe(null);
    expect(r.display).toBe('Acme Token');
    expect(r.isUnknown).toBe(false);
  });

  it('drops a mint-prefix NAME even when the symbol is safe (no leak in the name field)', () => {
    const r = resolveTokenIdentity(MINT, { mint: MINT, symbol: 'SAFE', name: 'ABC', logoUri: null, availability: 'resolved' });
    expect(r.display).toBe('$SAFE');
    expect(r.symbol).toBe('SAFE');
    expect(r.name).toBe(null); // "ABC" is a mint prefix — must not leak as the name
  });

  it('is Unknown when both symbol and name are mint prefixes', () => {
    const r = resolveTokenIdentity(MINT, { mint: MINT, symbol: 'ABC', name: 'ABCx', logoUri: 'http://logo/x.png', availability: 'resolved' });
    expect(r.isUnknown).toBe(true);
    expect(r.display).toBe('Unknown token');
    expect(r.symbol).toBe(null);
    expect(r.name).toBe(null);
    expect(r.logoUri).toBe('http://logo/x.png'); // logo still available for the avatar
  });

  it('is Unknown when unresolved (retryable/missing/unavailable), never a placeholder', () => {
    for (const availability of ['retryable', 'missing_credential', 'unavailable', 'placeholder_only']) {
      const r = resolveTokenIdentity(MINT, { mint: MINT, symbol: 'ABC', name: 'ABC', logoUri: null, availability });
      expect(r.isUnknown).toBe(true);
      expect(r.display).toBe('Unknown token');
    }
  });

  it('is Unknown when there is no metadata row at all', () => {
    const r = resolveTokenIdentity(MINT, null);
    expect(r.isUnknown).toBe(true);
    expect(r.display).toBe('Unknown token');
  });
});
