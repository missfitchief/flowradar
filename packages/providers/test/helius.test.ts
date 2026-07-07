// FlowRadar — helius.ts (WalletActivityProvider) tests (Task 27).
//
// Fetch is stubbed with vi.stubGlobal — no live network calls (this box has
// no HELIUS_API_KEY; Task 27 binding decision 6: "NO live network smoke test
// in CI/tests... tests are fixture-only").

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHeliusActivityProvider, isRateLimitError, isValidSolanaAddress } from '../src/solana/helius';
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

  it('never leaks the api key into a thrown error message on a persistent 429 (and classifies it rate_limited)', async () => {
    const secretKey = 'super-secret-key-xyz789';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('rate limited', { status: 429, statusText: 'Too Many Requests' }))
    );

    // Injected no-op sleep keeps the retry path instant; maxRetries:1 => 2 attempts.
    const provider = createHeliusActivityProvider({ HELIUS_API_KEY: secretKey }, { sleep: async () => {}, maxRetries: 1 });
    try {
      await provider!.getWalletTransactions('SOLANA', VALID_ADDRESS);
      throw new Error('expected getWalletTransactions to throw');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toContain(secretKey);
      expect(message).toMatch(/429/);
      expect(isRateLimitError(err)).toBe(true);
    }
  });

  // --- rate-limit hardening (2026-07-07) ---

  it('retries a 429 (backoff via injected sleep) and succeeds on a subsequent 200 — a throttle does not fail the wallet', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('rate limited', { status: 429, statusText: 'Too Many Requests' }))
      .mockResolvedValueOnce(new Response(JSON.stringify([swapFixture]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const sleep = vi.fn(async () => {});
    const provider = createHeliusActivityProvider({ HELIUS_API_KEY: 'k' }, { sleep, maxRetries: 3 });
    const result = await provider!.getWalletTransactions('SOLANA', VALID_ADDRESS);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(result.txs.length).toBe(1);
  });

  it('throws a typed HeliusRateLimitError after exhausting 429 retries (attempts = maxRetries + 1)', async () => {
    const fetchMock = vi.fn(async () => new Response('rate limited', { status: 429, statusText: 'Too Many Requests' }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = createHeliusActivityProvider({ HELIUS_API_KEY: 'k' }, { sleep: async () => {}, maxRetries: 2 });
    let caught: unknown;
    try {
      await provider!.getWalletTransactions('SOLANA', VALID_ADDRESS);
    } catch (err) {
      caught = err;
    }
    expect(isRateLimitError(caught)).toBe(true);
    expect((caught as Error).message).toMatch(/429/);
    expect(fetchMock).toHaveBeenCalledTimes(3); // maxRetries:2 -> 3 attempts
  });

  it('honors a numeric Retry-After header for the backoff wait', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('slow down', { status: 429, statusText: 'Too Many Requests', headers: { 'retry-after': '2' } })
      )
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const sleep = vi.fn(async () => {});
    const provider = createHeliusActivityProvider({ HELIUS_API_KEY: 'k' }, { sleep, maxRetries: 3, baseBackoffMs: 500 });
    await provider!.getWalletTransactions('SOLANA', VALID_ADDRESS);

    expect(sleep).toHaveBeenCalledWith(2000); // 2s from Retry-After, not the 500ms base
  });

  it('bounds an oversized Retry-After by maxBackoffMs (a broken 429 cannot stall the cycle for hours)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('go away', { status: 429, statusText: 'Too Many Requests', headers: { 'retry-after': '86400' } })
      )
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const sleep = vi.fn(async () => {});
    const provider = createHeliusActivityProvider({ HELIUS_API_KEY: 'k' }, { sleep, maxRetries: 3, maxBackoffMs: 8000 });
    await provider!.getWalletTransactions('SOLANA', VALID_ADDRESS);

    expect(sleep).toHaveBeenCalledWith(8000); // capped at maxBackoffMs, not 86_400_000
  });

  it('a non-429 error (500) is NOT classified as rate_limited and is not retried', async () => {
    const fetchMock = vi.fn(async () => new Response('boom', { status: 500, statusText: 'Internal Server Error' }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = createHeliusActivityProvider({ HELIUS_API_KEY: 'k' }, { sleep: async () => {}, maxRetries: 3 });
    let caught: unknown;
    try {
      await provider!.getWalletTransactions('SOLANA', VALID_ADDRESS);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(isRateLimitError(caught)).toBe(false);
    expect((caught as Error).message).toMatch(/500/);
    expect(fetchMock).toHaveBeenCalledTimes(1); // 5xx is not retried by the 429 path
  });

  it('rate-limits (sequences) calls at the configured HELIUS_RPS instead of bursting them', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify([]), { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);

      // rps=1 -> token-bucket capacity 1: first call fires immediately, the
      // second must wait ~1s for a refill (proves calls aren't bursted).
      const provider = createHeliusActivityProvider({ HELIUS_API_KEY: 'k', HELIUS_RPS: '1' });
      const p1 = provider!.getWalletTransactions('SOLANA', VALID_ADDRESS);
      const p2 = provider!.getWalletTransactions('SOLANA', VALID_ADDRESS);

      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(1); // second is throttled, still waiting

      await vi.advanceTimersByTimeAsync(1000);
      await Promise.all([p1, p2]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
