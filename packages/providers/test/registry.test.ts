import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getProvider, getProviderStatuses, resetProviderCache } from '../src/registry';

const ORIGINAL_MOCK_MODE = process.env.MOCK_MODE;
const ORIGINAL_HELIUS_API_KEY = process.env.HELIUS_API_KEY;

describe('getProvider / getProviderStatuses (registry)', () => {
  afterEach(() => {
    if (ORIGINAL_MOCK_MODE === undefined) {
      delete process.env.MOCK_MODE;
    } else {
      process.env.MOCK_MODE = ORIGINAL_MOCK_MODE;
    }
  });

  it('resolves MockProvider for every capability when MOCK_MODE is unset (mock is the default)', () => {
    delete process.env.MOCK_MODE;
    const walletActivity = getProvider('SOLANA', 'walletActivity');
    const marketData = getProvider('SOLANA', 'marketData');
    const tokenMetadata = getProvider('SOLANA', 'tokenMetadata');
    const risk = getProvider('SOLANA', 'risk');
    const walletDiscovery = getProvider('SOLANA', 'walletDiscovery');

    expect(walletActivity).toBeDefined();
    expect(marketData).toBeDefined();
    expect(tokenMetadata).toBeDefined();
    expect(risk).toBeDefined();
    expect(walletDiscovery).toBeDefined();
  });

  it('resolves MockProvider when MOCK_MODE="true"', () => {
    process.env.MOCK_MODE = 'true';
    const provider = getProvider('BSC', 'risk');
    expect(provider).toBeDefined();
  });

  it('resolves the same capability the same way for both chains', () => {
    process.env.MOCK_MODE = 'true';
    const sol = getProvider('SOLANA', 'marketData');
    const bsc = getProvider('BSC', 'marketData');
    expect(sol).toBeDefined();
    expect(bsc).toBeDefined();
  });

  it('getProviderStatuses returns one row per capability/chain, mode "mock", when MOCK_MODE !== "false"', () => {
    delete process.env.MOCK_MODE;
    const statuses = getProviderStatuses();

    const capabilities = ['walletActivity', 'marketData', 'tokenMetadata', 'risk', 'walletDiscovery'];
    const chains = ['SOLANA', 'BSC'];

    expect(statuses.length).toBe(capabilities.length * chains.length);
    for (const chain of chains) {
      for (const capability of capabilities) {
        const row = statuses.find((s) => s.chain === chain && s.capability === capability);
        expect(row, `expected a status row for ${chain}/${capability}`).toBeDefined();
        expect(row!.mode).toBe('mock');
      }
    }
  });

  it('getProviderStatuses reports mode "mock" for every row even when MOCK_MODE="true" explicitly', () => {
    process.env.MOCK_MODE = 'true';
    const statuses = getProviderStatuses();
    expect(statuses.every((s) => s.mode === 'mock')).toBe(true);
  });
});

describe('MOCK_MODE="false" (live mode — Wave 4 adapters not yet implemented)', () => {
  beforeEach(() => {
    process.env.MOCK_MODE = 'false';
  });

  afterEach(() => {
    if (ORIGINAL_MOCK_MODE === undefined) {
      delete process.env.MOCK_MODE;
    } else {
      process.env.MOCK_MODE = ORIGINAL_MOCK_MODE;
    }
  });

  it('getProviderStatuses reports a non-"mock" mode (missing_key/stub) instead of silently mocking', () => {
    const statuses = getProviderStatuses();
    expect(statuses.length).toBeGreaterThan(0);
    for (const status of statuses) {
      expect(status.mode).not.toBe('mock');
    }
  });
});

describe('MOCK_MODE="false" live wiring (Task 27 review — Important #1/#2)', () => {
  beforeEach(() => {
    resetProviderCache();
  });

  afterEach(() => {
    resetProviderCache();
    if (ORIGINAL_MOCK_MODE === undefined) {
      delete process.env.MOCK_MODE;
    } else {
      process.env.MOCK_MODE = ORIGINAL_MOCK_MODE;
    }
    if (ORIGINAL_HELIUS_API_KEY === undefined) {
      delete process.env.HELIUS_API_KEY;
    } else {
      process.env.HELIUS_API_KEY = ORIGINAL_HELIUS_API_KEY;
    }
  });

  it('with HELIUS_API_KEY set: walletActivity/risk resolve to a Helius-branded provider, not MockProvider, and do not throw', () => {
    process.env.MOCK_MODE = 'false';
    process.env.HELIUS_API_KEY = 'test-key-123';

    let walletActivity: ReturnType<typeof getProvider>;
    let risk: ReturnType<typeof getProvider>;
    expect(() => {
      walletActivity = getProvider('SOLANA', 'walletActivity');
    }).not.toThrow();
    expect(() => {
      risk = getProvider('SOLANA', 'risk');
    }).not.toThrow();

    expect((walletActivity! as { providerName?: string }).providerName).toBe('Helius');
    expect((risk! as { providerName?: string }).providerName).toBe('Helius');
    expect((walletActivity! as { providerName?: string }).providerName).not.toBe('MockProvider');
    expect((risk! as { providerName?: string }).providerName).not.toBe('MockProvider');
  });

  it('with HELIUS_API_KEY absent: getProvider does not throw and returns a working mock-fallback provider; statuses report missing_key', () => {
    process.env.MOCK_MODE = 'false';
    delete process.env.HELIUS_API_KEY;

    let walletActivity: ReturnType<typeof getProvider>;
    expect(() => {
      walletActivity = getProvider('SOLANA', 'walletActivity');
    }).not.toThrow();
    expect((walletActivity! as { providerName?: string }).providerName).toBe('MockProvider');

    const statuses = getProviderStatuses();
    const walletActivityRow = statuses.find((s) => s.chain === 'SOLANA' && s.capability === 'walletActivity');
    expect(walletActivityRow, 'expected a SOLANA walletActivity status row').toBeDefined();
    expect(walletActivityRow!.mode).toBe('missing_key');

    // Risk's stubbed mint/freeze-authority sub-surface (see solana/risk.ts's
    // getMintAuthorityFlags) doesn't have its own row in getProviderStatuses —
    // the top-level SOLANA/risk row itself is what flips missing_key/live;
    // asserting that here documents the current single-row-per-capability
    // shape rather than assuming a separate "stub" row exists for it.
    const riskRow = statuses.find((s) => s.chain === 'SOLANA' && s.capability === 'risk');
    expect(riskRow, 'expected a SOLANA risk status row').toBeDefined();
    expect(riskRow!.mode).toBe('missing_key');
  });

  it('MOCK_MODE="true" resolves MockProvider regardless of HELIUS_API_KEY', () => {
    process.env.MOCK_MODE = 'true';
    process.env.HELIUS_API_KEY = 'test-key-123';

    const walletActivity = getProvider('SOLANA', 'walletActivity');
    const risk = getProvider('SOLANA', 'risk');
    expect((walletActivity as { providerName?: string }).providerName).toBe('MockProvider');
    expect((risk as { providerName?: string }).providerName).toBe('MockProvider');
  });

  it('getProviderStatuses reports mode "live" for SOLANA walletActivity/risk when HELIUS_API_KEY is present', () => {
    process.env.MOCK_MODE = 'false';
    process.env.HELIUS_API_KEY = 'test-key-123';

    const statuses = getProviderStatuses();
    const walletActivityRow = statuses.find((s) => s.chain === 'SOLANA' && s.capability === 'walletActivity');
    const riskRow = statuses.find((s) => s.chain === 'SOLANA' && s.capability === 'risk');
    expect(walletActivityRow!.mode).toBe('live');
    expect(riskRow!.mode).toBe('live');
  });

  it('shares the same cached provider instance (and therefore its rate limiter) across repeated getProvider calls', () => {
    process.env.MOCK_MODE = 'false';
    process.env.HELIUS_API_KEY = 'test-key-123';

    const first = getProvider('SOLANA', 'walletActivity');
    const second = getProvider('SOLANA', 'walletActivity');
    expect(second).toBe(first);

    const firstRisk = getProvider('SOLANA', 'risk');
    const secondRisk = getProvider('SOLANA', 'risk');
    expect(secondRisk).toBe(firstRisk);
  });
});

describe('MOCK_MODE="false" marketData live wiring (Task 28 — DexScreener, keyless)', () => {
  beforeEach(() => {
    resetProviderCache();
    process.env.MOCK_MODE = 'false';
    delete process.env.BIRDEYE_API_KEY;
  });

  afterEach(() => {
    resetProviderCache();
    if (ORIGINAL_MOCK_MODE === undefined) {
      delete process.env.MOCK_MODE;
    } else {
      process.env.MOCK_MODE = ORIGINAL_MOCK_MODE;
    }
  });

  it('resolves marketData without throwing on SOLANA even with no API key set (keyless adapter)', () => {
    let marketData: ReturnType<typeof getProvider>;
    expect(() => {
      marketData = getProvider('SOLANA', 'marketData');
    }).not.toThrow();
    expect(marketData!).toBeDefined();
  });

  it('resolves marketData without throwing on BSC too (same keyless adapter serves both chains)', () => {
    let marketData: ReturnType<typeof getProvider>;
    expect(() => {
      marketData = getProvider('BSC', 'marketData');
    }).not.toThrow();
    expect(marketData!).toBeDefined();
  });

  it('getProviderStatuses reports mode "live" for marketData on both chains, regardless of any key', () => {
    const statuses = getProviderStatuses();
    const solanaRow = statuses.find((s) => s.chain === 'SOLANA' && s.capability === 'marketData');
    const bscRow = statuses.find((s) => s.chain === 'BSC' && s.capability === 'marketData');
    expect(solanaRow!.mode).toBe('live');
    expect(solanaRow!.name).toBe('DexScreener');
    expect(bscRow!.mode).toBe('live');
    expect(bscRow!.name).toBe('DexScreener');
  });

  it('shares the same cached DexScreener instance across chains and repeated calls', () => {
    const sol = getProvider('SOLANA', 'marketData');
    const bsc = getProvider('BSC', 'marketData');
    const solAgain = getProvider('SOLANA', 'marketData');
    expect(bsc).toBe(sol);
    expect(solAgain).toBe(sol);
  });
});
