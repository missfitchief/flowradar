// FlowRadar — bscscan.ts (WalletActivityProvider) tests (Task 29).
//
// Fetch is stubbed with vi.stubGlobal — no live network calls (BscScan needs
// a real Etherscan-V2-compatible key, so this suite is fixture-only, mirroring
// helius.test.ts's "no live network smoke test" contract for key-gated
// adapters).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBscScanActivityProvider, isValidBscAddress, normalizeBscAddress } from '../src/bsc/bscscan';
import txlistFixture from './fixtures/bscscan/txlist-page.json';
import tokentxFixture from './fixtures/bscscan/tokentx-page.json';
import emptyFixture from './fixtures/bscscan/empty-page.json';

const VALID_ADDRESS = '0x9f3a2bcd11ee44ff33aa55bb66cc77dd88ee99f0';
const VALID_ADDRESS_MIXED_CASE = '0x9F3A2BCD11EE44FF33AA55BB66CC77DD88EE99F0';

describe('isValidBscAddress', () => {
  it('accepts a well-formed 0x + 40 hex char address', () => {
    expect(isValidBscAddress(VALID_ADDRESS)).toBe(true);
  });

  it('accepts mixed-case hex (EIP-55 checksum not enforced, per binding decision)', () => {
    expect(isValidBscAddress(VALID_ADDRESS_MIXED_CASE)).toBe(true);
  });

  it('rejects a missing 0x prefix', () => {
    expect(isValidBscAddress(VALID_ADDRESS.slice(2))).toBe(false);
  });

  it('rejects too-short and too-long hex', () => {
    expect(isValidBscAddress('0x1234')).toBe(false);
    expect(isValidBscAddress(`${VALID_ADDRESS}ff`)).toBe(false);
  });

  it('rejects non-hex characters', () => {
    expect(isValidBscAddress('0x' + 'z'.repeat(40))).toBe(false);
  });

  it('rejects the empty string', () => {
    expect(isValidBscAddress('')).toBe(false);
  });
});

describe('normalizeBscAddress', () => {
  it('lowercases the address', () => {
    expect(normalizeBscAddress(VALID_ADDRESS_MIXED_CASE)).toBe(VALID_ADDRESS);
  });
});

describe('createBscScanActivityProvider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns null when BSCSCAN_API_KEY is missing', () => {
    expect(createBscScanActivityProvider({})).toBeNull();
  });

  it('throws for a malformed address without making a network call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const provider = createBscScanActivityProvider({ BSCSCAN_API_KEY: 'test-key' });
    await expect(provider!.getWalletTransactions('BSC', 'not-a-valid-address')).rejects.toThrow(
      /invalid BSC address/
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('calls the V2 unified endpoint with chainid=56, apikey, and merges txlist+tokentx via the mapper', async () => {
    const capturedUrls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        capturedUrls.push(url);
        if (url.includes('action=txlist')) {
          return new Response(JSON.stringify(txlistFixture), { status: 200 });
        }
        if (url.includes('action=tokentx')) {
          return new Response(JSON.stringify(tokentxFixture), { status: 200 });
        }
        throw new Error(`unexpected url ${url}`);
      })
    );

    const provider = createBscScanActivityProvider({ BSCSCAN_API_KEY: 'secret-abc-123' });
    const result = await provider!.getWalletTransactions('BSC', VALID_ADDRESS);

    expect(capturedUrls.length).toBe(2);
    for (const url of capturedUrls) {
      expect(url).toContain('https://api.etherscan.io/v2/api');
      expect(url).toContain('chainid=56');
      expect(url).toContain('module=account');
      expect(url).toContain('apikey=secret-abc-123');
    }
    expect(result.txs.length).toBeGreaterThan(0);
  });

  it('passes opts.cursor through as the startblock param', async () => {
    const capturedUrls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        capturedUrls.push(url);
        return new Response(JSON.stringify(emptyFixture), { status: 200 });
      })
    );

    const provider = createBscScanActivityProvider({ BSCSCAN_API_KEY: 'secret-abc-123' });
    await provider!.getWalletTransactions('BSC', VALID_ADDRESS, { cursor: '41200050' });

    for (const url of capturedUrls) {
      expect(url).toContain('startblock=41200050');
    }
  });

  it('caps opts.limit at the doc-verified 1000 max offset', async () => {
    const capturedUrls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        capturedUrls.push(url);
        return new Response(JSON.stringify(emptyFixture), { status: 200 });
      })
    );

    const provider = createBscScanActivityProvider({ BSCSCAN_API_KEY: 'secret-abc-123' });
    await provider!.getWalletTransactions('BSC', VALID_ADDRESS, { limit: 5000 });

    for (const url of capturedUrls) {
      expect(url).toContain('offset=1000');
    }
  });

  it('returns an empty page (not an error) for the documented "No transactions found" case', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(emptyFixture), { status: 200 }))
    );

    const provider = createBscScanActivityProvider({ BSCSCAN_API_KEY: 'secret-abc-123' });
    const result = await provider!.getWalletTransactions('BSC', VALID_ADDRESS);
    expect(result.txs).toEqual([]);
    expect(result.nextCursor).toBeUndefined();
  });

  it('filters mapped results by opts.since client-side', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('action=txlist')) return new Response(JSON.stringify(txlistFixture), { status: 200 });
        return new Response(JSON.stringify(emptyFixture), { status: 200 });
      })
    );

    const provider = createBscScanActivityProvider({ BSCSCAN_API_KEY: 'secret-abc-123' });
    // txlist fixture rows are all timestamped 1751500000/1751500500/1751501000;
    // filtering to strictly after the first should drop it.
    const result = await provider!.getWalletTransactions('BSC', VALID_ADDRESS, {
      since: new Date(1751500001 * 1000)
    });
    expect(result.txs.every((tx) => tx.ts.getTime() >= 1751500001 * 1000)).toBe(true);
  });

  it('never leaks the api key into a thrown error message on a non-2xx response', async () => {
    const secretKey = 'super-secret-key-xyz789';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('rate limited', { status: 429, statusText: 'Too Many Requests' }))
    );

    const provider = createBscScanActivityProvider({ BSCSCAN_API_KEY: secretKey });
    try {
      await provider!.getWalletTransactions('BSC', VALID_ADDRESS);
      throw new Error('expected getWalletTransactions to throw');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toContain(secretKey);
      expect(message).toMatch(/429/);
    }
  });

  it('never leaks the api key into a thrown error message on a documented API error (e.g. "Free API access is not supported")', async () => {
    const secretKey = 'super-secret-key-plan-err';
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              status: '0',
              message: 'NOTOK',
              result: 'Free API access is not supported for this chain. Please upgrade your api plan for full chain coverage.'
            }),
            { status: 200 }
          )
      )
    );

    const provider = createBscScanActivityProvider({ BSCSCAN_API_KEY: secretKey });
    try {
      await provider!.getWalletTransactions('BSC', VALID_ADDRESS);
      throw new Error('expected getWalletTransactions to throw');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toContain(secretKey);
      expect(message).toMatch(/NOTOK|Free API access/);
    }
  });

  it('sets nextCursor to (max block + 1) only when a page was full', async () => {
    const fullTxlist = {
      status: '1',
      message: 'OK',
      result: Array.from({ length: 2 }, (_, i) => ({ ...(txlistFixture.result as any)[0], hash: `0xfull${i}`, blockNumber: String(41200100 + i) }))
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('action=txlist')) return new Response(JSON.stringify(fullTxlist), { status: 200 });
        return new Response(JSON.stringify(emptyFixture), { status: 200 });
      })
    );

    const provider = createBscScanActivityProvider({ BSCSCAN_API_KEY: 'secret-abc-123' });
    // limit 2 matches fullTxlist's row count -> "full page" -> nextCursor set.
    const result = await provider!.getWalletTransactions('BSC', VALID_ADDRESS, { limit: 2 });
    expect(result.nextCursor).toBe('41200102');
  });
});
