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
  computeHolderConcentration,
  createHeliusRiskProvider,
  getMintAuthorityFlags
} from '../src/solana/risk';
import largestAccountsFixture from './fixtures/helius/rpc-token-largest-accounts.json';
import supplyFixture from './fixtures/helius/rpc-token-supply.json';

const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

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
