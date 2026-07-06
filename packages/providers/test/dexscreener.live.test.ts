// FlowRadar — DexScreener LIVE smoke test (Task 28).
//
// Guarded by LIVE_SMOKE=1 (unset/0 -> skipped, matches this repo's existing
// live-smoke convention). This is the one adapter in the whole provider
// layer that is genuinely keyless-live, so a real network smoke test is
// runnable on any box without secrets — this test exists specifically to
// prove the doc-verified response shape against reality, not just against
// fixtures. Run once (and paste the real output) whenever this adapter or
// its mapper changes:
//
//   LIVE_SMOKE=1 npx vitest run packages/providers/test/dexscreener.live.test.ts

import { describe, expect, it } from 'vitest';
import { createDexScreenerProvider } from '../src/market/dexscreener';

const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';

describe.skipIf(!process.env.LIVE_SMOKE)('DexScreener LIVE smoke (LIVE_SMOKE=1)', () => {
  it('fetches real market data for wrapped SOL and gets a non-null positive price + at least one pair', async () => {
    const provider = createDexScreenerProvider();

    const market = await provider.getTokenMarket('SOLANA', WRAPPED_SOL_MINT);
    // eslint-disable-next-line no-console
    console.log('[LIVE SMOKE] getTokenMarket(SOLANA, wrapped SOL):', JSON.stringify(market));

    expect(market).not.toBeNull();
    expect(market!.priceUsd).toBeGreaterThan(0);

    const pairs = await provider.getTokenPairs('SOLANA', WRAPPED_SOL_MINT);
    // eslint-disable-next-line no-console
    console.log('[LIVE SMOKE] getTokenPairs(SOLANA, wrapped SOL) count:', pairs.length);

    expect(pairs.length).toBeGreaterThan(0);
    expect(pairs.every((p) => p.priceUsd > 0)).toBe(true);
  }, 20_000);
});
