// FlowRadar — heliusMapper.ts fixture tests (Task 27).
//
// Fixtures live in test/fixtures/helius/*.json, each faithfully derived from
// the Helius Enhanced Transactions docs' documented response schema (see each
// fixture's own `_docSource` field for the exact doc URL + what was verified
// vs synthesized). These are the 3 required cases: a SWAP tx, a TRANSFER tx
// (native + token in one tx), and an unknown/complex tx exercising
// schema-lenient passthrough parsing.

import { describe, expect, it } from 'vitest';
import { mapHeliusTransaction } from '../src/solana/heliusMapper';
import type { HeliusTransaction } from '../src/solana/heliusMapper';
import swapFixture from './fixtures/helius/swap.json';
import transferFixture from './fixtures/helius/transfer.json';
import unknownFixture from './fixtures/helius/unknown.json';

const SWAP_WALLET = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const TRANSFER_WALLET = '4kG9xRvW2sT6pL8mN3qZ1yB7cA5dF9eH2jK4lM6nP8oQ';
const UNKNOWN_WALLET = '6mN5oP4qR3sT2uV1wX9yZ8aB7cD6eF5gH4iJ3kL2mN1o';

describe('mapHeliusTransaction — SWAP fixture', () => {
  const tx = mapHeliusTransaction(swapFixture as unknown as HeliusTransaction, SWAP_WALLET);

  it('maps txHash/blockOrSlot/ts from signature/slot/timestamp', () => {
    expect(tx.txHash).toBe(swapFixture.signature);
    expect(tx.blockOrSlot).toBe(BigInt(swapFixture.slot));
    expect(tx.ts.getTime()).toBe(swapFixture.timestamp * 1000);
  });

  it('produces paired swap_leg legs: SELL side (nativeInput) + BUY side (tokenOutputs)', () => {
    const swapLegs = tx.legs.filter((l) => l.kind === 'swap_leg');
    expect(swapLegs.length).toBe(2);

    const sellLeg = swapLegs.find((l) => l.asset.symbol === 'SOL');
    expect(sellLeg).toBeDefined();
    expect(sellLeg!.from).toBe(SWAP_WALLET);
    expect(sellLeg!.amountToken).toBe('1');

    const buyLeg = swapLegs.find((l) => l.asset.address === 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263');
    expect(buyLeg).toBeDefined();
    expect(buyLeg!.to).toBe(SWAP_WALLET);
    expect(buyLeg!.asset.decimals).toBe(5);
    expect(buyLeg!.amountToken).toBe('9500');
  });

  it('does not invent an amountUsd (events.swap carries no USD field)', () => {
    for (const leg of tx.legs) {
      expect(leg.amountUsd).toBeUndefined();
    }
  });
});

describe('mapHeliusTransaction — TRANSFER fixture (native + token in one tx)', () => {
  const tx = mapHeliusTransaction(transferFixture as unknown as HeliusTransaction, TRANSFER_WALLET);

  it('maps one native_transfer leg with lamports converted to a SOL decimal string', () => {
    const nativeLegs = tx.legs.filter((l) => l.kind === 'native_transfer');
    expect(nativeLegs.length).toBe(1);
    expect(nativeLegs[0]!.from).toBe(TRANSFER_WALLET);
    expect(nativeLegs[0]!.to).toBe('8pQ7rS6tU5vW4xY3zA2bC1dE9fG8hJ7kL6mN5oP4qR3s');
    expect(nativeLegs[0]!.asset).toEqual({ symbol: 'SOL', decimals: 9 });
    expect(nativeLegs[0]!.amountToken).toBe('0.5');
  });

  it('maps one token_transfer leg, respecting mint decimals from accountData', () => {
    const tokenLegs = tx.legs.filter((l) => l.kind === 'token_transfer');
    expect(tokenLegs.length).toBe(1);
    expect(tokenLegs[0]!.asset.address).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    expect(tokenLegs[0]!.asset.decimals).toBe(6);
    expect(tokenLegs[0]!.amountToken).toBe('100');
  });

  it('produces no swap_leg or contract_interaction legs for a plain transfer', () => {
    expect(tx.legs.some((l) => l.kind === 'swap_leg')).toBe(false);
    expect(tx.legs.some((l) => l.kind === 'contract_interaction')).toBe(false);
  });
});

describe('mapHeliusTransaction — unknown/complex fixture (schema-lenient passthrough)', () => {
  it('does not throw on unrecognized extra fields', () => {
    expect(() => mapHeliusTransaction(unknownFixture as unknown as HeliusTransaction, UNKNOWN_WALLET)).not.toThrow();
  });

  const tx = mapHeliusTransaction(unknownFixture as unknown as HeliusTransaction, UNKNOWN_WALLET);

  it('falls back to a single contract_interaction leg when no transfers/swap events are present', () => {
    expect(tx.legs.length).toBe(1);
    expect(tx.legs[0]!.kind).toBe('contract_interaction');
    expect(tx.legs[0]!.from).toBe(unknownFixture.feePayer);
    expect(tx.legs[0]!.to).toBe(unknownFixture.feePayer);
  });

  it('still maps txHash/blockOrSlot/ts correctly', () => {
    expect(tx.txHash).toBe(unknownFixture.signature);
    expect(tx.blockOrSlot).toBe(BigInt(unknownFixture.slot));
  });
});

describe('mapHeliusTransaction — determinism', () => {
  it('mapping the same fixture twice produces deep-equal NormalizedTx (excluding object identity)', () => {
    const a = mapHeliusTransaction(swapFixture as unknown as HeliusTransaction, SWAP_WALLET);
    const b = mapHeliusTransaction(swapFixture as unknown as HeliusTransaction, SWAP_WALLET);
    expect(a).toEqual(b);
  });
});

describe('mapHeliusTransaction - provider-classified SWAP fallback', () => {
  it('keeps an inbound token transfer alertable when events.swap is absent', () => {
    const tx = mapHeliusTransaction({
      type: 'SWAP', source: 'JUPITER', feePayer: SWAP_WALLET,
      signature: 'fallback-swap', slot: 123, timestamp: 1_700_000_000,
      tokenTransfers: [{
        fromUserAccount: 'Pool111111111111111111111111111111111111111',
        toUserAccount: SWAP_WALLET, tokenAmount: 42,
        mint: 'Mint111111111111111111111111111111111111111'
      }]
    }, SWAP_WALLET);

    expect(tx.legs).toHaveLength(1);
    expect(tx.legs[0]).toMatchObject({
      kind: 'swap_leg', to: SWAP_WALLET,
      asset: { address: 'Mint111111111111111111111111111111111111111' }
    });
  });
});
