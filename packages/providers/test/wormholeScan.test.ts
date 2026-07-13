import { describe, expect, it } from 'vitest';
import { mapWormholeOperation, streamWormholeSolanaBscEvents, type WormholeScanOperation } from '../src';

const operation: WormholeScanOperation = {
  id: '1/emitter/42', emitterChain: 1, sequence: '42', vaa: { raw: 'signed-vaa' },
  content: { standarizedProperties: { fromChain: 1, fromAddress: 'SolSender', toChain: 4, toAddress: '0xABCD', tokenChain: 1, tokenAddress: 'Mint', amount: '1000000', normalizedDecimals: 6 } },
  sourceChain: { chainId: 1, timestamp: '2026-07-13T00:00:00Z', transaction: { txHash: 'soltx' }, from: 'SolSender', status: 'confirmed' },
  targetChain: { chainId: 4, timestamp: '2026-07-13T00:02:00Z', transaction: { txHash: '0xDEST' }, to: '0xABCD', status: 'completed' },
  data: { symbol: 'USDC', tokenAmount: '1', usdAmount: '0.999' }
};

describe('WormholeScan canonical mapper', () => {
  it('produces two officially linked Solana/BSC legs without overstating source finality', () => {
    const events = mapWormholeOperation(operation, new Date('2026-07-13T01:00:00Z'));
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.kind)).toEqual(['bridge_source', 'bridge_destination']);
    expect(events[1]).toMatchObject({ chain: 'BSC', to: '0xabcd', actor: '0xabcd' });
    expect(events[0]?.asset.address).toBe('Mint');
    expect(events[1]?.asset.address).toBeNull();
    expect(events[0]?.bridge).toMatchObject({ officialMessageId: '1/emitter/42', protocolCompleted: true, sourceFinality: 'confirmed' });
  });

  it('filters unrelated API rows and deduplicates pages', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ operations: [operation, operation, { id: 'bad' }] }), { status: 200 });
    const events = [];
    for await (const event of streamWormholeSolanaBscEvents({ pages: 1, fetchImpl: fetchImpl as typeof fetch, observedAt: new Date(0) })) events.push(event);
    expect(events).toHaveLength(2);
  });
});
