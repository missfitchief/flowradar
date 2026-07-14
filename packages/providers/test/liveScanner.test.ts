import { describe, expect, it } from 'vitest';
import { mapGmgnActivity } from '../src/walletCapital/liveScanner';

describe('GMGN Core monitoring normalization', () => {
  it('extracts nested token evidence so a real buy remains alertable', () => {
    const event = mapGmgnActivity('wallet', {
      tx_hash: 'tx', timestamp: 1_784_045_398, event_type: 'buy',
      token: { address: 'mint', symbol: 'NEW', decimals: 6 },
      token_amount: '30241.478335', cost_usd: '99.2994',
      from_address: '', to_address: ''
    }, 0, new Date('2026-07-14T16:10:00.000Z'));

    expect(event).toMatchObject({
      kind: 'token_buy', actor: 'wallet', from: 'wallet', to: 'wallet',
      asset: { address: 'mint', symbol: 'NEW', decimals: 6, amount: '30241.478335', amountUsd: 99.2994 },
      provider: 'GMGN'
    });
  });
});
