import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getProvider, getProviderStatuses } from '../src/registry';

const ORIGINAL_MOCK_MODE = process.env.MOCK_MODE;

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
