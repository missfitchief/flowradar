// FlowRadar — goplus.ts fixture tests (Task 29).
//
// Fixtures: clean-token.json + not-found.json are LIVE-FETCHED verbatim
// responses (see their `_docSource` fields — real GET calls against
// api.gopluslabs.io this session). honeypot-token.json is SYNTHESIZED from
// the same live-verified schema with every danger/warn flag toggled on (see
// its `_docSource` for why a real live honeypot example wasn't sourced).

import { describe, expect, it, vi, afterEach } from 'vitest';
import { buildGoPlusRiskReport, createGoPlusRiskProvider, topHolderShare } from '../src/bsc/goplus';
import type { GoPlusTokenSecurityEntry } from '../src/bsc/goplus';
import cleanTokenFixture from './fixtures/goplus/clean-token.json';
import honeypotTokenFixture from './fixtures/goplus/honeypot-token.json';
import notFoundFixture from './fixtures/goplus/not-found.json';
import rateLimitedFixture from './fixtures/goplus/rate-limited.json';

const CLEAN_ADDRESS = '0x55d398326f99059ff775485246999027b3197955';
const HONEYPOT_ADDRESS = '0x1234500000000000000000000000000000dead1';

function entryFor(fixture: typeof cleanTokenFixture, address: string): GoPlusTokenSecurityEntry {
  return (fixture.result as Record<string, GoPlusTokenSecurityEntry>)[address]!;
}

describe('topHolderShare', () => {
  it('derives the max holders[].percent share from the live-fetched clean-token fixture', () => {
    const entry = entryFor(cleanTokenFixture, CLEAN_ADDRESS);
    const share = topHolderShare(entry);
    expect(share).toBeCloseTo(0.053330467022984795, 10);
  });

  it('returns 0 when holders is absent/empty', () => {
    expect(topHolderShare({})).toBe(0);
    expect(topHolderShare({ holders: [] })).toBe(0);
  });
});

describe('buildGoPlusRiskReport — clean token (live-fetched fixture)', () => {
  const entry = entryFor(cleanTokenFixture, CLEAN_ADDRESS);
  const report = buildGoPlusRiskReport(entry);

  it('produces no honeypot/tax/cannot_sell_all flags (all "0" in the live fixture)', () => {
    expect(report.flags.some((f) => f.id === 'honeypot')).toBe(false);
    expect(report.flags.some((f) => f.id === 'high_buy_tax')).toBe(false);
    expect(report.flags.some((f) => f.id === 'high_sell_tax')).toBe(false);
    expect(report.flags.some((f) => f.id === 'cannot_sell_all')).toBe(false);
  });

  it('flags mintable (warn) — the live fixture has is_mintable="1"', () => {
    const flag = report.flags.find((f) => f.id === 'mintable');
    expect(flag).toBeDefined();
    expect(flag!.severity).toBe('warn');
  });

  it('does not flag not_open_source (is_open_source="1" in the live fixture)', () => {
    expect(report.flags.some((f) => f.id === 'not_open_source')).toBe(false);
  });

  it('top holder share (~5.3%) is below the 30% warn threshold -> no concentration flag', () => {
    expect(report.flags.some((f) => f.id === 'top_holder_concentration')).toBe(false);
  });

  it('penalty equals only the mintable penalty (0.15)', () => {
    expect(report.penalty).toBeCloseTo(0.15, 5);
  });
});

describe('buildGoPlusRiskReport — honeypot token (synthesized, every flag on)', () => {
  const entry = entryFor(honeypotTokenFixture, HONEYPOT_ADDRESS);
  const report = buildGoPlusRiskReport(entry);

  it('flags honeypot as danger', () => {
    const flag = report.flags.find((f) => f.id === 'honeypot');
    expect(flag).toBeDefined();
    expect(flag!.severity).toBe('danger');
  });

  it('flags cannot_sell_all as danger', () => {
    const flag = report.flags.find((f) => f.id === 'cannot_sell_all');
    expect(flag).toBeDefined();
    expect(flag!.severity).toBe('danger');
  });

  it('flags high buy/sell tax as danger (>= 50%)', () => {
    // buy_tax "0.12" -> warn-range (12% > 10%, < 50%); sell_tax "0.99" -> danger.
    const buyFlag = report.flags.find((f) => f.id === 'high_buy_tax');
    expect(buyFlag).toBeDefined();
    expect(buyFlag!.severity).toBe('warn');

    const sellFlag = report.flags.find((f) => f.id === 'high_sell_tax');
    expect(sellFlag).toBeDefined();
    expect(sellFlag!.severity).toBe('danger');
  });

  it('flags not_open_source as warn (is_open_source="0")', () => {
    const flag = report.flags.find((f) => f.id === 'not_open_source');
    expect(flag).toBeDefined();
    expect(flag!.severity).toBe('warn');
  });

  it('flags mintable as warn', () => {
    expect(report.flags.some((f) => f.id === 'mintable')).toBe(true);
  });

  it('flags top_holder_concentration as warn (55% top holder)', () => {
    const flag = report.flags.find((f) => f.id === 'top_holder_concentration');
    expect(flag).toBeDefined();
    expect(flag!.severity).toBe('warn');
  });

  it('caps total penalty at 1 even though every flag fires', () => {
    // raw sum would be 0.5 + 0.3 + 0.15(buy warn) + 0.3(sell danger) + 0.1 + 0.15 + 0.2 = 1.7
    expect(report.penalty).toBe(1);
  });
});

describe('buildGoPlusRiskReport — not-found (empty holders/undefined fields)', () => {
  it('produces zero flags and zero penalty for a bare entry with no risk fields set', () => {
    const report = buildGoPlusRiskReport({});
    expect(report.flags).toEqual([]);
    expect(report.penalty).toBe(0);
  });
});

describe('createGoPlusRiskProvider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('never returns null — GoPlus is keyless-live (no key required)', () => {
    expect(createGoPlusRiskProvider({})).not.toBeNull();
  });

  it('calls the doc-verified /api/v1/token_security/56 endpoint with contract_addresses, no Authorization header when keyless', async () => {
    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        capturedUrl = url;
        capturedHeaders = (init?.headers as Record<string, string>) ?? {};
        return new Response(JSON.stringify(cleanTokenFixture), { status: 200 });
      })
    );

    const provider = createGoPlusRiskProvider({});
    const report = await provider.getTokenRisk('BSC', CLEAN_ADDRESS);

    expect(capturedUrl).toContain('/api/v1/token_security/56');
    expect(capturedUrl).toContain(`contract_addresses=${CLEAN_ADDRESS}`);
    expect(capturedHeaders.Authorization).toBeUndefined();
    expect(report.penalty).toBeCloseTo(0.15, 5);
  });

  it('sends an Authorization header when GOPLUS_API_KEY is set', async () => {
    let capturedHeaders: Record<string, string> = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        capturedHeaders = (init?.headers as Record<string, string>) ?? {};
        return new Response(JSON.stringify(cleanTokenFixture), { status: 200 });
      })
    );

    const provider = createGoPlusRiskProvider({ GOPLUS_API_KEY: 'my-goplus-key' });
    await provider.getTokenRisk('BSC', CLEAN_ADDRESS);
    expect(capturedHeaders.Authorization).toBe('Bearer my-goplus-key');
  });

  it('returns a zero-flag/zero-penalty report for the documented "no data" case (empty result object)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(notFoundFixture), { status: 200 }))
    );

    const provider = createGoPlusRiskProvider({});
    const report = await provider.getTokenRisk('BSC', '0xnotfound00000000000000000000000000000');
    expect(report).toEqual({ flags: [], penalty: 0 });
  });

  it('never leaks the api key into a thrown error message on a non-2xx response', async () => {
    const secretKey = 'super-secret-goplus-key';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('server error', { status: 500, statusText: 'Internal Server Error' }))
    );

    const provider = createGoPlusRiskProvider({ GOPLUS_API_KEY: secretKey });
    try {
      await provider.getTokenRisk('BSC', CLEAN_ADDRESS);
      throw new Error('expected getTokenRisk to throw');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toContain(secretKey);
      expect(message).toMatch(/500/);
    }
  });

  // Regression test: a live worker smoke test this session crashed with
  // "Cannot read properties of undefined (reading '0x...')" because GoPlus
  // returns HTTP 200 + `{"code":4029,"message":"too many requests"}` with NO
  // `result` field at all when rate-limited (live-verified, see
  // rate-limited.json's `_docSource`) — the old code went straight to
  // `response.result[address]` without checking `code` first.
  it('throws a clear (non-crashing) error instead of a TypeError when GoPlus returns a rate-limited/non-success code with no result field', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(rateLimitedFixture), { status: 200 }))
    );

    const provider = createGoPlusRiskProvider({});
    await expect(provider.getTokenRisk('BSC', CLEAN_ADDRESS)).rejects.toThrow(/4029|too many requests/);
  });
});
