// FlowRadar — MockConfluenceProvider: deterministic 'ok' confluence results
// for the demo/mock world (design doc §Architecture — MOCK_MODE selects the
// mock, same one-switch convention as MockSocialSource/MockCandidateSource).
// Fully deterministic: dataJson is a pure function of (provider, snapshotType,
// chain, tokenAddress) via a small string hash — same inputs => byte-identical
// output, always. No Math.random()/Date.now(). SHADOW-ONLY: every payload is
// labeled providerClaimed and NEVER asserts a safe/clean verdict (constraint
// 15,16). Non-SOLANA chain => 'unavailable' (Solana-only in practice, no BSC).
import type { Chain } from '@flowradar/core';
import type { ConfluenceFetchResult, ConfluenceProvider } from './types';

// Fixed genesis so observedAt is deterministic across runs (mirrors the mock
// world's genesis-derived timestamps; no Date.now()).
const MOCK_GENESIS = new Date('2026-07-05T00:00:00.000Z');

export interface MockConfluenceProviderOpts {
  name?: string;
  provider?: string;
  snapshotType?: string;
}

/** Small deterministic non-negative 32-bit string hash (cyrb53-lite; pure, no node: builtin). */
function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export class MockConfluenceProvider implements ConfluenceProvider {
  readonly name: string;
  readonly provider: string;
  readonly snapshotType: string;
  readonly chains: Chain[] = ['SOLANA'];

  constructor(opts: MockConfluenceProviderOpts = {}) {
    this.name = opts.name ?? 'mock-confluence';
    this.provider = opts.provider ?? 'mock';
    this.snapshotType = opts.snapshotType ?? 'holder_risk';
  }

  async fetchForToken(chain: Chain, tokenAddress: string): Promise<ConfluenceFetchResult> {
    // Solana-only in practice; a non-SOLANA chain yields honest 'unavailable',
    // NEVER 'ok' and NEVER a green verdict (constraint 15).
    if (chain !== 'SOLANA') {
      return {
        status: 'unavailable',
        dataJson: { note: 'mock confluence is SOLANA-only; no data for this chain' },
        observedAt: MOCK_GENESIS
      };
    }

    const seed = hash32(`${this.provider}:${this.snapshotType}:${chain}:${tokenAddress}`);
    // Deterministic pseudo-metrics derived from the seed — clearly demo values,
    // labeled provider-claimed, with NO safe/clean/verdict key.
    const holderCount = 200 + (seed % 4800);
    const topHolderConcentrationPct = Number((5 + (seed % 45)).toFixed(2));
    const holderDelta24h = ((seed % 401) - 200); // -200..+200, can be negative
    const observedAt = new Date(MOCK_GENESIS.getTime() + (seed % 3600) * 1000);

    return {
      status: 'ok',
      dataJson: {
        providerClaimed: true,
        holderCount,
        topHolderConcentrationPct,
        holderDelta: { '24h': holderDelta24h },
        sourceName: this.name,
        note: 'MOCK_MODE deterministic confluence — demo values, not real provider data'
      },
      observedAt
    };
  }
}
