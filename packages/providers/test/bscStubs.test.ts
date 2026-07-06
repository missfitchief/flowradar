// FlowRadar — bsc/stubs.ts tests (Task 29, binding decision 4).
//
// These typed stubs make no network calls and always resolve empty/null —
// this suite proves that contract without ever stubbing `fetch` (a real
// unstubbed fetch call would throw/hang in this sandbox, so a passing test
// here is itself proof no I/O occurred).

import { describe, expect, it } from 'vitest';
import { createBirdeyeStub, createBitqueryStub, createMoralisStub } from '../src/bsc/stubs';

describe('createBirdeyeStub', () => {
  const stub = createBirdeyeStub();

  it('getTokenMarket resolves null with no network call', async () => {
    await expect(stub.getTokenMarket('BSC', '0xanything')).resolves.toBeNull();
  });

  it('getTokenPairs resolves an empty array', async () => {
    await expect(stub.getTokenPairs('BSC', '0xanything')).resolves.toEqual([]);
  });

  it('getTokenMetadata resolves null', async () => {
    await expect(stub.getTokenMetadata('BSC', '0xanything')).resolves.toBeNull();
  });
});

describe('createMoralisStub', () => {
  const stub = createMoralisStub();

  it('is providerName-tagged as a stub', () => {
    expect(stub.providerName).toBe('Moralis (stub)');
  });

  it('getWalletTransactions resolves an empty page', async () => {
    await expect(stub.getWalletTransactions('BSC', '0xanything')).resolves.toEqual({ txs: [] });
  });
});

describe('createBitqueryStub', () => {
  const stub = createBitqueryStub();

  it('is providerName-tagged as a stub', () => {
    expect(stub.providerName).toBe('Bitquery (stub)');
  });

  it('getWalletTransactions resolves an empty page', async () => {
    await expect(stub.getWalletTransactions('BSC', '0xanything')).resolves.toEqual({ txs: [] });
  });

  it('getCandidateWallets resolves an empty array', async () => {
    await expect(stub.getCandidateWallets('BSC')).resolves.toEqual([]);
  });

  it('getTokenRisk resolves a zero-penalty report', async () => {
    await expect(stub.getTokenRisk('BSC', '0xanything')).resolves.toEqual({ flags: [], penalty: 0 });
  });
});
