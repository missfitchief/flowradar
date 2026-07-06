// FlowRadar — createDuneClient tests (Task 37, Wave 4.6). Load-bearing
// credit-safety proof: with DUNE_EXECUTE_FRESH unset/false, executeQuery
// hits ONLY the latest-cached-result GET endpoint — the /execute POST is
// NEVER called. Also covers the fractional-rate non-hang proof (the
// createRateLimiter fix, commit a2859ab) and the API-key redaction guarantee.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDuneClient } from '../../../src/candidates/dune/client';

function fakeFetchResponse(body: unknown, ok = true, status = 200, statusText = 'OK'): Response {
  return {
    ok,
    status,
    statusText,
    json: async () => body,
    text: async () => JSON.stringify(body)
  } as unknown as Response;
}

describe('createDuneClient', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it('returns null when DUNE_API_KEY is absent (missing_key)', () => {
    const client = createDuneClient({});
    expect(client).toBeNull();
  });

  it('CREDIT SAFETY: DUNE_EXECUTE_FRESH unset (default false) => executeQuery calls ONLY the latest-cached-result GET endpoint, /execute POST is NEVER called', async () => {
    const calls: { url: string; method: string }[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? 'GET' });
      return fakeFetchResponse({
        execution_id: 'exec_cached_1',
        state: 'QUERY_STATE_COMPLETED',
        result: { rows: [{ wallet_address: 'W1' }], metadata: { row_count: 1 } }
      });
    }) as unknown as typeof fetch;

    const client = createDuneClient({ DUNE_API_KEY: 'secret-key-123' }, { rps: 100 });
    expect(client).not.toBeNull();

    const result = await client!.executeQuery('12345');

    expect(result.usedCached).toBe(true);
    expect(result.rows).toEqual([{ wallet_address: 'W1' }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('/api/v1/query/12345/results');
    expect(calls[0]!.method).toBe('GET');

    // The execute POST path must never be hit.
    expect(calls.some((c) => c.url.includes('/execute'))).toBe(false);
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('CREDIT SAFETY: DUNE_USE_LATEST_RESULT=true explicit (still default) => same cached-only path', async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return fakeFetchResponse({ execution_id: 'e1', state: 'QUERY_STATE_COMPLETED', result: { rows: [] } });
    }) as unknown as typeof fetch;

    const client = createDuneClient(
      { DUNE_API_KEY: 'k', DUNE_USE_LATEST_RESULT: 'true', DUNE_EXECUTE_FRESH: 'false' },
      { rps: 100 }
    );
    await client!.executeQuery('999');

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('/query/999/results');
  });

  it('DUNE_EXECUTE_FRESH=true => calls execute POST, polls status, then fetches execution results', async () => {
    vi.useFakeTimers();
    const calls: { url: string; method: string }[] = [];

    let statusCallCount = 0;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ url, method });

      if (url.includes('/execute')) {
        return fakeFetchResponse({ execution_id: 'exec_fresh_1', state: 'QUERY_STATE_PENDING' });
      }
      if (url.includes('/status')) {
        statusCallCount += 1;
        // First status check: still executing. Second: completed.
        const state = statusCallCount === 1 ? 'QUERY_STATE_EXECUTING' : 'QUERY_STATE_COMPLETED';
        return fakeFetchResponse({
          execution_id: 'exec_fresh_1',
          is_execution_finished: statusCallCount > 1,
          state
        });
      }
      if (url.includes('/execution/exec_fresh_1/results')) {
        return fakeFetchResponse({
          execution_id: 'exec_fresh_1',
          state: 'QUERY_STATE_COMPLETED',
          result: { rows: [{ wallet_address: 'FRESHWALLET' }], metadata: { row_count: 1 } }
        });
      }
      throw new Error(`unexpected URL in test: ${url}`);
    }) as unknown as typeof fetch;

    const client = createDuneClient(
      { DUNE_API_KEY: 'k', DUNE_EXECUTE_FRESH: 'true' },
      { rps: 100 }
    );

    const resultPromise = client!.executeQuery('55', { useLatestCached: false });

    // Drive the poll loop's setTimeout(1000ms) forward.
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1100);
    await vi.advanceTimersByTimeAsync(0);

    const result = await resultPromise;

    expect(result.usedCached).toBe(false);
    expect(result.executionId).toBe('exec_fresh_1');
    expect(result.rows).toEqual([{ wallet_address: 'FRESHWALLET' }]);

    expect(calls.some((c) => c.url.includes('/query/55/execute') && c.method === 'POST')).toBe(true);
    expect(calls.some((c) => c.url.includes('/status'))).toBe(true);
    expect(calls.some((c) => c.url.includes('/execution/exec_fresh_1/results'))).toBe(true);
  });

  it('DUNE_EXECUTE_FRESH=false GLOBALLY overrides a per-call useLatestCached:false request — fresh execution is never attempted without the global flag', async () => {
    const calls: { url: string; method: string }[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method ?? 'GET' });
      return fakeFetchResponse({ execution_id: 'e1', state: 'QUERY_STATE_COMPLETED', result: { rows: [] } });
    }) as unknown as typeof fetch;

    const client = createDuneClient({ DUNE_API_KEY: 'k', DUNE_EXECUTE_FRESH: 'false' }, { rps: 100 });
    await client!.executeQuery('77', { useLatestCached: false });

    expect(calls.every((c) => c.method !== 'POST')).toBe(true);
    expect(calls.some((c) => c.url.includes('/query/77/results'))).toBe(true);
  });

  it('FRACTIONAL-RATE NON-HANG: a sub-1 rps client making 2 calls resolves both without hanging (fake timers)', async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn(async () =>
      fakeFetchResponse({ execution_id: 'e1', state: 'QUERY_STATE_COMPLETED', result: { rows: [] } })
    ) as unknown as typeof fetch;

    // rps=0.5 => one token every 2000ms, capacity floored at 1 (the
    // createRateLimiter fix from commit a2859ab) — this must NOT hang.
    const client = createDuneClient({ DUNE_API_KEY: 'k' }, { rps: 0.5 });

    let firstDone = false;
    let secondDone = false;
    client!.executeQuery('1').then(() => {
      firstDone = true;
    });
    client!.executeQuery('2').then(() => {
      secondDone = true;
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(firstDone).toBe(true); // bucket starts full — first call is immediate
    expect(secondDone).toBe(false); // second must wait for a refill, not hang forever

    await vi.advanceTimersByTimeAsync(2100);
    expect(secondDone).toBe(true);
  });

  it('REDACTION: a non-2xx response never leaks the API key in the thrown error message', async () => {
    globalThis.fetch = vi.fn(async () => fakeFetchResponse({ error: 'nope' }, false, 401, 'Unauthorized')) as unknown as typeof fetch;

    const secretKey = 'sk_super_secret_dune_key_ZZZ999';
    const client = createDuneClient({ DUNE_API_KEY: secretKey }, { rps: 100 });

    await expect(client!.executeQuery('1')).rejects.toThrow();
    try {
      await client!.executeQuery('1');
      throw new Error('expected executeQuery to reject');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toContain(secretKey);
      expect(message).toContain('401');
    }
  });

  it('truncated=true when rowsReturned hits the requested limit', async () => {
    globalThis.fetch = vi.fn(async () =>
      fakeFetchResponse({
        execution_id: 'e1',
        state: 'QUERY_STATE_COMPLETED',
        result: { rows: [{ wallet_address: 'A' }, { wallet_address: 'B' }], metadata: { row_count: 2 } }
      })
    ) as unknown as typeof fetch;

    const client = createDuneClient({ DUNE_API_KEY: 'k' }, { rps: 100 });
    const result = await client!.executeQuery('1', { limit: 2 });

    expect(result.truncated).toBe(true);
    expect(result.rowsReturned).toBe(2);
  });
});
