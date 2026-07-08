// FlowRadar — external-confluence provider unit tests (Task C): MockConfluenceProvider
// deterministic ok results; holderscan/clobr/gmgn/agPaper config-gated stubs
// (null on missing required key, honest stub/plan_required/unavailable statuses,
// NEVER 'ok', NEVER 'safe'); getConfluenceSourceStatuses mode mapping; no secret
// value ever echoed (env NAME only). Parallel-safe: no DB, fetch stubbed, env
// restored per test. Mirrors socialSources.test.ts conventions.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MockConfluenceProvider,
  createHolderScanProvider,
  createClobrProvider,
  createGmgnProvider,
  createAgPaperProvider,
  getConfluenceSourceStatuses
} from '../src/confluence';
import type { ConfluenceFetchResult } from '../src/confluence';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// A fetch result must never claim a reassuring/"clean"/"safe" verdict — global
// constraint 15 (unavailable !== safe). This asserts on the shape a shadow-only
// provider is allowed to return: no key named 'safe'/'clean'/'verdict' in dataJson.
function assertNoSafeVerdict(r: ConfluenceFetchResult) {
  const keys = Object.keys(r.dataJson).map((k) => k.toLowerCase());
  expect(keys).not.toContain('safe');
  expect(keys).not.toContain('clean');
  expect(keys).not.toContain('verdict');
}

describe('MockConfluenceProvider', () => {
  it('implements ConfluenceProvider with a holderscan-shaped default identity', () => {
    const p = new MockConfluenceProvider();
    expect(p.name).toBe('mock-confluence');
    expect(p.provider).toBe('mock');
    expect(p.snapshotType).toBe('holder_risk');
    expect(p.chains).toEqual(['SOLANA']);
    expect(typeof p.fetchForToken).toBe('function');
  });

  it('honours name/provider/snapshotType overrides so one class can back any source', () => {
    const p = new MockConfluenceProvider({
      name: 'mock-gmgn',
      provider: 'gmgn',
      snapshotType: 'external_intel'
    });
    expect(p.name).toBe('mock-gmgn');
    expect(p.provider).toBe('gmgn');
    expect(p.snapshotType).toBe('external_intel');
  });

  it('fetchForToken returns a deterministic ok result: same inputs => byte-identical dataJson', async () => {
    const p = new MockConfluenceProvider();
    const a = await p.fetchForToken('SOLANA', 'MockTokenAddr1111111111111111111111111111111');
    const b = await p.fetchForToken('SOLANA', 'MockTokenAddr1111111111111111111111111111111');
    expect(a.status).toBe('ok');
    expect(a.dataJson).toEqual(b.dataJson);
    expect(a.observedAt.getTime()).toBe(b.observedAt.getTime());
  });

  it('different addresses => different deterministic dataJson (address-seeded)', async () => {
    const p = new MockConfluenceProvider();
    const a = await p.fetchForToken('SOLANA', 'AddrAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    const b = await p.fetchForToken('SOLANA', 'AddrBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB');
    expect(a.dataJson).not.toEqual(b.dataJson);
  });

  it('labels its ok payload provider-claimed and never asserts a safe/clean verdict', async () => {
    const p = new MockConfluenceProvider();
    const r = await p.fetchForToken('SOLANA', 'MockTokenAddr1111111111111111111111111111111');
    expect(r.dataJson.providerClaimed).toBe(true);
    assertNoSafeVerdict(r);
  });

  it('returns unavailable (never ok) for a non-SOLANA chain — Solana-only in practice, no BSC', async () => {
    const p = new MockConfluenceProvider();
    const r = await p.fetchForToken('BSC', 'MockTokenAddr1111111111111111111111111111111');
    expect(r.status).toBe('unavailable');
    expect(r.dataJson.providerClaimed).toBeUndefined();
  });
});

describe('createHolderScanProvider (optional/paid, config-gated, plan-aware STUB)', () => {
  it('returns null when HOLDERSCAN_API_KEY is absent (graceful missing-key skip)', () => {
    expect(createHolderScanProvider({})).toBeNull();
  });

  it('keyed => a provider whose fetchForToken is a documented STUB with NO network call', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const p = createHolderScanProvider({ HOLDERSCAN_API_KEY: 'k' })!;
    expect(p.provider).toBe('holderscan');
    expect(p.snapshotType).toBe('holder_risk');
    expect(p.chains).toEqual(['SOLANA']);
    const r = await p.fetchForToken('SOLANA', 'AddrAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    // Plan-gated / no verified endpoint yet => plan_required or unavailable,
    // NEVER 'ok' (no hallucinated endpoint), NEVER a safe/clean verdict.
    expect(['plan_required', 'unavailable']).toContain(r.status);
    expect(r.status).not.toBe('ok');
    assertNoSafeVerdict(r);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does NOT infer safe from absence — dataJson carries a plan/unavailable note, no green fields', async () => {
    const p = createHolderScanProvider({ HOLDERSCAN_API_KEY: 'k' })!;
    const r = await p.fetchForToken('SOLANA', 'AddrAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    expect(typeof r.dataJson.note).toBe('string');
    expect(r.dataJson.holderCount).toBeUndefined();
  });
});

describe('createClobrProvider (optional, stub-only — no confirmed public API)', () => {
  it('returns a provider even with no key (stub registers regardless), fetch => "stub", NO network call', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const p = createClobrProvider({})!;
    expect(p).not.toBeNull();
    expect(p.provider).toBe('clobr');
    expect(p.snapshotType).toBe('liquidity_map');
    expect(p.chains).toEqual(['SOLANA']);
    const r = await p.fetchForToken('SOLANA', 'AddrAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    expect(r.status).toBe('stub');
    expect(r.status).not.toBe('ok');
    assertNoSafeVerdict(r);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a present CLOBR_API_KEY does NOT upgrade the stub to ok (unverified endpoint stays a stub)', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const p = createClobrProvider({ CLOBR_API_KEY: 'k' })!;
    const r = await p.fetchForToken('SOLANA', 'AddrAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    expect(r.status).toBe('stub');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('createGmgnProvider (query-only external intel, stub — no verified public API)', () => {
  it('returns a query-only provider, fetch => "stub", labeled provider-claimed context, NO network call', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const p = createGmgnProvider({})!;
    expect(p).not.toBeNull();
    expect(p.provider).toBe('gmgn');
    expect(p.snapshotType).toBe('external_intel');
    expect(p.chains).toEqual(['SOLANA']);
    const r = await p.fetchForToken('SOLANA', 'AddrAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    expect(['stub', 'unavailable']).toContain(r.status);
    expect(r.status).not.toBe('ok');
    assertNoSafeVerdict(r);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a present GMGN_API_KEY does NOT upgrade the query-only stub to ok', async () => {
    const p = createGmgnProvider({ GMGN_API_KEY: 'k' })!;
    const r = await p.fetchForToken('SOLANA', 'AddrAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    expect(r.status).not.toBe('ok');
  });
});

describe('createAgPaperProvider (manual/stub only — no automation, no parser)', () => {
  it('returns a keyless provider whose fetch => "stub" with NO network call', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const p = createAgPaperProvider()!;
    expect(p).not.toBeNull();
    expect(p.provider).toBe('ag_paper');
    expect(p.snapshotType).toBe('paper_trade');
    expect(p.chains).toEqual(['SOLANA']);
    const r = await p.fetchForToken('SOLANA', 'AddrAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    expect(r.status).toBe('stub');
    expect(r.status).not.toBe('ok');
    assertNoSafeVerdict(r);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('agPaper.ts source-text contract (manual CSV shape documented, NO parser built)', () => {
  it('documents the exact manual CSV column shape in a comment', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, '..', 'src', 'confluence', 'agPaper.ts'), 'utf8');
    for (const col of [
      'tokenAddress', 'chain', 'paperEntryAt', 'paperExitAt',
      'paperEntryPrice', 'paperExitPrice', 'paperPnlPct', 'notes'
    ]) {
      expect(src).toContain(col);
    }
  });

  it('builds NO CSV parser (no split/parse/csv machinery in the file)', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, '..', 'src', 'confluence', 'agPaper.ts'), 'utf8').toLowerCase();
    // A parser would call .split(',') or a csv lib; none may appear.
    expect(src).not.toContain(".split(','");
    expect(src).not.toContain('.split(",")');
    expect(src).not.toContain('parsecsv');
    expect(src).not.toContain("require('csv");
    expect(src).not.toContain('papaparse');
  });
});

describe('getConfluenceSourceStatuses', () => {
  function fakePrisma(
    rows: { name: string; provider: string; apiKeyEnvName: string | null }[]
  ) {
    return { externalConfluenceSource: { findMany: async () => rows } } as any;
  }
  const ROWS = [
    { name: 'holderscan', provider: 'holderscan', apiKeyEnvName: 'HOLDERSCAN_API_KEY' },
    { name: 'clobr', provider: 'clobr', apiKeyEnvName: 'CLOBR_API_KEY' },
    { name: 'gmgn', provider: 'gmgn', apiKeyEnvName: 'GMGN_API_KEY' },
    { name: 'ag_paper', provider: 'ag_paper', apiKeyEnvName: null }
  ];

  it('MOCK_MODE (default): every row reports mode "mock"', async () => {
    process.env.MOCK_MODE = 'true';
    const statuses = await getConfluenceSourceStatuses(fakePrisma(ROWS));
    expect(statuses).toHaveLength(4);
    expect(statuses.every((s) => s.mode === 'mock')).toBe(true);
    // NAME is echoed, value never is.
    const hs = statuses.find((s) => s.sourceName === 'holderscan')!;
    expect(hs.apiKeyEnvName).toBe('HOLDERSCAN_API_KEY');
  });

  it('live mode: holderscan unkeyed => missing_key; holderscan keyed => plan_required; clobr/gmgn => stub; ag_paper => stub', async () => {
    process.env.MOCK_MODE = 'false';
    delete process.env.HOLDERSCAN_API_KEY;
    delete process.env.CLOBR_API_KEY;
    delete process.env.GMGN_API_KEY;
    const unkeyed = Object.fromEntries(
      (await getConfluenceSourceStatuses(fakePrisma(ROWS))).map((s) => [s.sourceName, s])
    );
    expect(unkeyed['holderscan'].mode).toBe('missing_key');
    expect(unkeyed['clobr'].mode).toBe('stub'); // no confirmed API — stub regardless of key
    expect(unkeyed['gmgn'].mode).toBe('stub');
    expect(unkeyed['ag_paper'].mode).toBe('stub'); // manual, keyless

    process.env.HOLDERSCAN_API_KEY = 'present';
    const keyed = Object.fromEntries(
      (await getConfluenceSourceStatuses(fakePrisma(ROWS))).map((s) => [s.sourceName, s])
    );
    // A key present makes HolderScan plan_required (needs a verified plan), not live.
    expect(keyed['holderscan'].mode).toBe('plan_required');
  });

  it('missing-key note names the env var but NEVER a secret value', async () => {
    process.env.MOCK_MODE = 'false';
    process.env.HOLDERSCAN_API_KEY = 'super-secret-value';
    const rows = await getConfluenceSourceStatuses(
      fakePrisma([{ name: 'holderscan', provider: 'holderscan', apiKeyEnvName: 'HOLDERSCAN_API_KEY' }])
    );
    const note = rows[0].note;
    // env var NAME appears; the resolved secret value must never leak into any field.
    expect(rows[0].apiKeyEnvName).toBe('HOLDERSCAN_API_KEY');
    for (const field of [note, rows[0].apiKeyEnvName ?? '', JSON.stringify(rows[0])]) {
      expect(field).not.toContain('super-secret-value');
    }
  });

  it('no returned row leaks a resolved process.env value in ANY field (secret-free rows)', async () => {
    process.env.MOCK_MODE = 'false';
    process.env.HOLDERSCAN_API_KEY = 'HS-SECRET-XYZ';
    process.env.CLOBR_API_KEY = 'CLOBR-SECRET-XYZ';
    process.env.GMGN_API_KEY = 'GMGN-SECRET-XYZ';
    const rows = await getConfluenceSourceStatuses(fakePrisma(ROWS));
    const blob = JSON.stringify(rows);
    expect(blob).not.toContain('HS-SECRET-XYZ');
    expect(blob).not.toContain('CLOBR-SECRET-XYZ');
    expect(blob).not.toContain('GMGN-SECRET-XYZ');
  });
});
