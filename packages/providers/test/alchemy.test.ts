import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { mapAlchemySolanaTransaction, normalizeAlchemyWebhook, parseAlchemyWebhookEnvelope, verifyAlchemyWebhookSignature } from '../src';

describe('Alchemy webhook security and normalization', () => {
  it('verifies the exact raw request body with HMAC-SHA256', () => {
    const raw = '{"id":"evt-1","value":1}';
    const signature = createHmac('sha256', 'test-signing-key').update(raw).digest('hex');
    expect(verifyAlchemyWebhookSignature(raw, signature, 'test-signing-key')).toBe(true);
    expect(verifyAlchemyWebhookSignature(`${raw} `, signature, 'test-signing-key')).toBe(false);
    expect(verifyAlchemyWebhookSignature(raw, null, 'test-signing-key')).toBe(false);
  });

  it('normalizes an ordinary EVM Address Activity transfer without classifying it as a buy', async () => {
    const actor = '0x1111111111111111111111111111111111111111';
    const hash = `0x${'a'.repeat(64)}`;
    const raw = JSON.stringify({
      webhookId: 'wh-1', id: 'evt-1', createdAt: '2026-07-15T12:00:00.000Z', type: 'ADDRESS_ACTIVITY',
      event: { network: 'ETH_MAINNET', activity: [{
        blockNum: '0x10', hash, fromAddress: actor,
        toAddress: '0x2222222222222222222222222222222222222222', value: 0.25,
        asset: 'ETH', category: 'external', rawContract: { decimal: '0x12' }
      }] }
    });
    const envelope = parseAlchemyWebhookEnvelope(raw);
    const events = await normalizeAlchemyWebhook('ETHEREUM', envelope, new Set([actor]), { env: {}, observedAt: new Date('2026-07-15T12:00:01.000Z') });
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('native_transfer');
    expect(events[0].eventId).toBe(`alchemy:ETHEREUM:${hash}:0`);
    expect(events[0].metadata.liveWebhook).toBe(true);
  });

  it('maps a parsed Solana transfer using token-account owners', () => {
    const actor = '11111111111111111111111111111111';
    const receiver = '22222222222222222222222222222222';
    const tx = mapAlchemySolanaTransaction({
      slot: 123, blockTime: 1_752_580_800,
      transaction: { signatures: ['signature-1'], message: { accountKeys: ['source-token', 'dest-token'], instructions: [{
        parsed: { type: 'transferChecked', info: { source: 'source-token', destination: 'dest-token', mint: 'mint-1', tokenAmount: { amount: '1250000', decimals: 6 } } }
      }] } },
      meta: { err: null, preTokenBalances: [{ accountIndex: 0, mint: 'mint-1', owner: actor, uiTokenAmount: { decimals: 6 } }], postTokenBalances: [{ accountIndex: 1, mint: 'mint-1', owner: receiver, uiTokenAmount: { decimals: 6 } }] }
    }, actor);
    expect(tx?.legs).toEqual([expect.objectContaining({ from: actor, to: receiver, amountToken: '1.25' })]);
  });
});
