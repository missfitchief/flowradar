// FlowRadar — helius.ts (WalletActivityProvider) tests (Task 27).
//
// Fetch is stubbed with vi.stubGlobal — no live network calls (this box has
// no HELIUS_API_KEY; Task 27 binding decision 6: "NO live network smoke test
// in CI/tests... tests are fixture-only").

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHeliusActivityProvider, isValidSolanaAddress } from '../src/solana/helius';
import swapFixture from './fixtures/helius/swap.json';

const VALID_ADDRESS = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';

describe('isValidSolanaAddress', () => {
  it('accepts a well-formed base58 32-44 char address', () => {
    expect(isValidSolanaAddress(VALID_ADDRESS)).toBe(true);
  });

  it('rejects addresses containing invalid base58 chars (0, O, I, l)', () => {
    expect(isValidSolanaAddress('0OIl0000000000000000000000000000')).toBe(false);
  });

  it('rejects too-short and too-long strings', () => {
    expect(isValidSolanaAddress('short')).toBe(false);
    expect(isValidSolanaAddress('A'.repeat(50))).toBe(false);
  });

  it('rejects the empty string', () => {
    expect(isValidSolanaAddress('')).toBe(false);
  });
});

describe('createHeliusActivityProvider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns null when HELIUS_API_KEY is missing', () => {
    expect(createHeliusActivityProvider({})).toBeNull();
  });

  it('throws for a malformed address without making a network call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const provider = createHeliusActivityProvider({ HELIUS_API_KEY: 'test-key' });
    await expect(provider!.getWalletTransactions('SOLANA', 'not-a-valid-address')).rejects.toThrow(
      /invalid Solana address/
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('calls the doc-verified endpoint with api-key + limit, and maps the response via heliusMapper', async () => {
    let capturedUrl = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        capturedUrl = url;
        return new Response(JSON.stringify([swapFixture]), { status: 200 });
      })
    );

    const provider = createHeliusActivityProvider({ HELIUS_API_KEY: 'secret-abc-123' });
    const result = await provider!.getWalletTransactions('SOLANA', VALID_ADDRESS);

    expect(capturedUrl).toContain(`/v0/addresses/${VALID_ADDRESS}/transactions`);
    expect(capturedUrl).toContain('api-key=secret-abc-123');
    expect(capturedUrl).toContain('limit=100');
    expect(result.txs.length).toBe(1);
    expect(result.txs[0]!.txHash).toBe(swapFixture.signature);
  });

  it('passes opts.cursor through as the doc-verified `before-signature` param', async () => {
    let capturedUrl = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        capturedUrl = url;
        return new Response(JSON.stringify([]), { status: 200 });
      })
    );

    const provider = createHeliusActivityProvider({ HELIUS_API_KEY: 'secret-abc-123' });
    await provider!.getWalletTransactions('SOLANA', VALID_ADDRESS, { cursor: 'some-prior-signature' });

    expect(capturedUrl).toContain('before-signature=some-prior-signature');
  });

  it('caps opts.limit at 100 (doc-verified max)', async () => {
    let capturedUrl = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        capturedUrl = url;
        return new Response(JSON.stringify([]), { status: 200 });
      })
    );

    const provider = createHeliusActivityProvider({ HELIUS_API_KEY: 'secret-abc-123' });
    await provider!.getWalletTransactions('SOLANA', VALID_ADDRESS, { limit: 500 });

    expect(capturedUrl).toContain('limit=100');
  });

  it('sets nextCursor to the last signature only when a full page was returned', async () => {
    const fullPage = Array.from({ length: 2 }, (_, i) => ({ ...swapFixture, signature: `sig-${i}` }));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(fullPage), { status: 200 }))
    );

    const provider = createHeliusActivityProvider({ HELIUS_API_KEY: 'secret-abc-123' });
    // limit defaults to 100 but the fixture returns only 2 -> not a full page -> no nextCursor.
    const result = await provider!.getWalletTransactions('SOLANA', VALID_ADDRESS);
    expect(result.nextCursor).toBeUndefined();
  });

  it('filters mapped results by opts.since client-side', async () => {
    const older = { ...swapFixture, signature: 'old-sig', timestamp: 1000 };
    const newer = { ...swapFixture, signature: 'new-sig', timestamp: 2_000_000 };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify([older, newer]), { status: 200 }))
    );

    const provider = createHeliusActivityProvider({ HELIUS_API_KEY: 'secret-abc-123' });
    const result = await provider!.getWalletTransactions('SOLANA', VALID_ADDRESS, {
      since: new Date(1_000_000 * 1000)
    });
    expect(result.txs.length).toBe(1);
    expect(result.txs[0]!.txHash).toBe('new-sig');
  });

  it('never leaks the api key into a thrown error message on a non-2xx response', async () => {
    const secretKey = 'super-secret-key-xyz789';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('rate limited', { status: 429, statusText: 'Too Many Requests' }))
    );

    const provider = createHeliusActivityProvider({ HELIUS_API_KEY: secretKey });
    try {
      await provider!.getWalletTransactions('SOLANA', VALID_ADDRESS);
      throw new Error('expected getWalletTransactions to throw');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toContain(secretKey);
      expect(message).toMatch(/429/);
    }
  });
});
