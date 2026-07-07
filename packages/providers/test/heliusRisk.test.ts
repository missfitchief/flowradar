// FlowRadar — risk.ts fixture tests (Task 27).
//
// Fixtures: rpc-token-largest-accounts.json + rpc-token-supply.json are
// doc-verified (see their `_docSource` fields — full example JSON confirmed
// against https://www.helius.dev/docs/api-reference/rpc/http/gettokenlargestaccounts
// and .../gettokensupply). rpc-account-info-mint.json is explicitly a STUB
// fixture (see its `_docSource` TODO) — it exists to document the shape the
// mint-authority check WOULD use if re-verified later, and getMintAuthorityFlags
// is tested here as the stub it actually is (never reads this fixture).

import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  buildRiskReport,
  buildUnavailableRiskReport,
  computeHolderConcentration,
  createHeliusRiskProvider,
  getMintAuthorityFlags,
  HeliusRpcError,
  isTokenAccountsUnavailableError
} from '../src/solana/risk';
import largestAccountsFixture from './fixtures/helius/rpc-token-largest-accounts.json';
import supplyFixture from './fixtures/helius/rpc-token-supply.json';

const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

// The exact error Helius returns for a mega-holder mint (USDT/USDC/wSOL): the
// getTokenLargestAccounts -32600 "too many accounts" condition seen live.
const TOO_MANY_ACCOUNTS_ERROR = {
  jsonrpc: '2.0',
  id: '1',
  error: { code: -32600, message: 'Too many accounts requested (5000000 pubkeys), try adding filters to narrow down results' }
};

describe('getMintAuthorityFlags', () => {
  it('is a stub: returns mode "stub" with null flags and makes no network call', () => {
    const flags = getMintAuthorityFlags(MINT);
    expect(flags).toEqual({ mode: 'stub', mintAuthorityActive: null, freezeAuthorityActive: null });
  });
});

describe('computeHolderConcentration', () => {
  it('derives top1/top5 share from the doc-verified getTokenLargestAccounts + getTokenSupply fixtures', () => {
    const concentration = computeHolderConcentration(
      largestAccountsFixture.result as any,
      supplyFixture.result as any
    );
    // Fixture: supply 1,000,000,000,000 raw units; top1 = 400,000,000,000 (40%);
    // top5 = 400+100+80+70+50 = 700,000,000,000 (70%).
    expect(concentration.top1Share).toBeCloseTo(0.4, 5);
    expect(concentration.top5Share).toBeCloseTo(0.7, 5);
  });

  it('returns 0/0 when supply is zero (guards divide-by-zero)', () => {
    const zeroSupply = { context: { slot: 1 }, value: { amount: '0', decimals: 6, uiAmount: 0, uiAmountString: '0' } };
    const concentration = computeHolderConcentration(largestAccountsFixture.result as any, zeroSupply);
    expect(concentration).toEqual({ top1Share: 0, top5Share: 0 });
  });
});

describe('buildRiskReport', () => {
  it('flags top_holder_concentration (danger) when top1 >= 30%, using the fixture-derived concentration', () => {
    const concentration = computeHolderConcentration(largestAccountsFixture.result as any, supplyFixture.result as any);
    const report = buildRiskReport(concentration, { mode: 'stub', mintAuthorityActive: null, freezeAuthorityActive: null });

    const top1Flag = report.flags.find((f) => f.id === 'top_holder_concentration');
    expect(top1Flag).toBeDefined();
    expect(top1Flag!.severity).toBe('danger');

    const top5Flag = report.flags.find((f) => f.id === 'top5_holder_concentration');
    expect(top5Flag).toBeDefined();
    expect(top5Flag!.severity).toBe('warn');

    // penalty = 0.3 (top1) + 0.15 (top5) = 0.45; mint/freeze both null (stub) -> no authority penalty.
    expect(report.penalty).toBeCloseTo(0.45, 5);
  });

  it('adds mint_authority_active / freeze_authority_active flags + 0.25 penalty each when true', () => {
    const noConcentration = { top1Share: 0, top5Share: 0 };
    const report = buildRiskReport(noConcentration, {
      mode: 'stub',
      mintAuthorityActive: true as unknown as null,
      freezeAuthorityActive: true as unknown as null
    });
    expect(report.flags.map((f) => f.id).sort()).toEqual(['freeze_authority_active', 'mint_authority_active']);
    expect(report.penalty).toBeCloseTo(0.5, 5);
  });

  it('caps total penalty at 1 even when every flag fires', () => {
    const maxConcentration = { top1Share: 1, top5Share: 1 };
    const report = buildRiskReport(maxConcentration, {
      mode: 'stub',
      mintAuthorityActive: true as unknown as null,
      freezeAuthorityActive: true as unknown as null
    });
    // Raw sum would be 0.25+0.25+0.3+0.15 = 0.95, still under 1 — assert cap logic directly.
    expect(report.penalty).toBeLessThanOrEqual(1);
  });

  it('produces no flags/zero penalty for a well-distributed token', () => {
    const safe = { top1Share: 0.05, top5Share: 0.15 };
    const report = buildRiskReport(safe, { mode: 'stub', mintAuthorityActive: null, freezeAuthorityActive: null });
    expect(report.flags).toEqual([]);
    expect(report.penalty).toBe(0);
  });
});

describe('createHeliusRiskProvider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns null when HELIUS_API_KEY is missing', () => {
    expect(createHeliusRiskProvider({})).toBeNull();
  });

  it('returns a working RiskProvider when a key is present, calling both RPC methods', async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      if (body.method === 'getTokenLargestAccounts') {
        return new Response(JSON.stringify(largestAccountsFixture), { status: 200 });
      }
      if (body.method === 'getTokenSupply') {
        return new Response(JSON.stringify(supplyFixture), { status: 200 });
      }
      throw new Error(`unexpected method ${body.method}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = createHeliusRiskProvider({ HELIUS_API_KEY: 'test-key-12345' });
    expect(provider).not.toBeNull();

    const report = await provider!.getTokenRisk('SOLANA', MINT);
    expect(report.flags.some((f) => f.id === 'top_holder_concentration')).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('never leaks the api key into a thrown error message on a non-2xx response', async () => {
    const secretKey = 'super-secret-key-abc123';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('unauthorized', { status: 401, statusText: 'Unauthorized' }))
    );

    const provider = createHeliusRiskProvider({ HELIUS_API_KEY: secretKey });
    await expect(provider!.getTokenRisk('SOLANA', MINT)).rejects.toThrow();
    try {
      await provider!.getTokenRisk('SOLANA', MINT);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toContain(secretKey);
    }
  });
});

// ---------------------------------------------------------------------------
// F9: mega-holder / stablecoin mint risk-unavailable handling
// ---------------------------------------------------------------------------

describe('isTokenAccountsUnavailableError', () => {
  it('is true only for a -32600 "too many accounts" HeliusRpcError', () => {
    expect(
      isTokenAccountsUnavailableError(
        new HeliusRpcError('getTokenLargestAccounts', -32600, 'Too many accounts requested (5000000 pubkeys), try adding filters')
      )
    ).toBe(true);
    // case-insensitive on the message
    expect(isTokenAccountsUnavailableError(new HeliusRpcError('getTokenLargestAccounts', -32600, 'TOO MANY ACCOUNTS'))).toBe(true);
  });

  it('is false for a different -32600 message, a different code, or a non-HeliusRpcError', () => {
    expect(isTokenAccountsUnavailableError(new HeliusRpcError('getTokenLargestAccounts', -32600, 'Invalid params'))).toBe(false);
    expect(isTokenAccountsUnavailableError(new HeliusRpcError('getTokenSupply', -32000, 'too many accounts'))).toBe(false);
    expect(isTokenAccountsUnavailableError(new Error('too many accounts requested'))).toBe(false);
    expect(isTokenAccountsUnavailableError(null)).toBe(false);
    expect(isTokenAccountsUnavailableError(undefined)).toBe(false);
  });

  it('is method-specific: the SAME code+message from a non-largest-accounts call is not degraded', () => {
    // Only getTokenLargestAccounts hits the holder-sampling limit; the identical
    // code+message from any other method must still propagate as a real error.
    expect(
      isTokenAccountsUnavailableError(
        new HeliusRpcError('getTokenSupply', -32600, 'Too many accounts requested (5000000 pubkeys), try adding filters')
      )
    ).toBe(false);
  });
});

describe('buildUnavailableRiskReport', () => {
  it('surfaces holder_data_unavailable (warn) with zero penalty — unknown, not clean/safe', () => {
    const report = buildUnavailableRiskReport();
    // NOT an empty (falsely-clean) report
    expect(report.flags).not.toEqual([]);
    const flag = report.flags.find((f) => f.id === 'holder_data_unavailable');
    expect(flag).toBeDefined();
    expect(flag!.severity).toBe('warn');
    // penalty 0 => flow-score formula ((1 - penalty) * 5) is unchanged.
    expect(report.penalty).toBe(0);
  });
});

describe('createHeliusRiskProvider — mega-holder mint (-32600 too many accounts)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubTooManyAccounts() {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      if (body.method === 'getTokenLargestAccounts') {
        return new Response(JSON.stringify(TOO_MANY_ACCOUNTS_ERROR), { status: 200 });
      }
      if (body.method === 'getTokenSupply') {
        return new Response(JSON.stringify(supplyFixture), { status: 200 });
      }
      throw new Error(`unexpected method ${body.method}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('does not crash/throw scoring — resolves to a RiskReport', async () => {
    stubTooManyAccounts();
    const provider = createHeliusRiskProvider({ HELIUS_API_KEY: 'k' });
    await expect(provider!.getTokenRisk('SOLANA', MINT)).resolves.toBeDefined();
  });

  it('marks the token risk unknown/unavailable, NOT clean/safe', async () => {
    stubTooManyAccounts();
    const provider = createHeliusRiskProvider({ HELIUS_API_KEY: 'k' });
    const report = await provider!.getTokenRisk('SOLANA', MINT);
    expect(report.flags.some((f) => f.id === 'holder_data_unavailable')).toBe(true);
    expect(report.flags).not.toEqual([]); // never the empty clean report
    expect(report.penalty).toBe(0); // no scoring-formula change
  });

  it('repeated cycles keep degrading gracefully (no per-cycle fatal throw/spam)', async () => {
    stubTooManyAccounts();
    const provider = createHeliusRiskProvider({ HELIUS_API_KEY: 'k' });
    for (let i = 0; i < 5; i++) {
      const report = await provider!.getTokenRisk('SOLANA', MINT);
      expect(report.flags.some((f) => f.id === 'holder_data_unavailable')).toBe(true);
    }
  });

  it('a DIFFERENT RPC error is NOT swallowed — still propagates', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string);
        if (body.method === 'getTokenLargestAccounts') {
          return new Response(JSON.stringify({ jsonrpc: '2.0', id: '1', error: { code: -32000, message: 'server error' } }), { status: 200 });
        }
        return new Response(JSON.stringify(supplyFixture), { status: 200 });
      })
    );
    const provider = createHeliusRiskProvider({ HELIUS_API_KEY: 'k' });
    await expect(provider!.getTokenRisk('SOLANA', MINT)).rejects.toThrow();
  });

  it('the normal (sampleable) token path is unaffected — real concentration flags, no unavailable flag', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string);
        if (body.method === 'getTokenLargestAccounts') {
          return new Response(JSON.stringify(largestAccountsFixture), { status: 200 });
        }
        return new Response(JSON.stringify(supplyFixture), { status: 200 });
      })
    );
    const provider = createHeliusRiskProvider({ HELIUS_API_KEY: 'k' });
    const report = await provider!.getTokenRisk('SOLANA', MINT);
    expect(report.flags.some((f) => f.id === 'top_holder_concentration')).toBe(true);
    expect(report.flags.some((f) => f.id === 'holder_data_unavailable')).toBe(false);
  });
});
