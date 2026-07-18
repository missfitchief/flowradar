import { describe, expect, it } from 'vitest';
import { correlateBridgeEvents, type MassTransactionEvent } from '../../src';

const baseTs = new Date('2026-07-13T00:00:00Z');
function leg(kind: 'bridge_source' | 'bridge_destination', chain: 'SOLANA' | 'BSC', id: string, messageId: string | null, verifiedBy: 'protocol_message' | 'heuristic' = 'protocol_message'): MassTransactionEvent {
  const source = kind === 'bridge_source';
  return {
    eventId: id, chain, txHash: `${id}-tx`, eventIndex: 0, blockOrSlot: 1n,
    ts: new Date(baseTs.getTime() + (source ? 0 : 60_000)), kind, status: 'succeeded',
    from: source ? 'alice' : 'wormhole', to: source ? 'wormhole' : 'receiver', actor: source ? 'alice' : 'receiver',
    asset: { address: null, symbol: 'USDC', decimals: 6, amount: '100', amountUsd: source ? 100 : 99.5 },
    programOrContract: 'wormhole', provider: 'fixture', observedAt: baseTs,
    bridge: { protocol: 'Wormhole', officialMessageId: messageId, sourceChain: 'SOLANA', destinationChain: 'BSC', sourceTxHash: source ? `${id}-tx` : null, destinationTxHash: source ? null : `${id}-tx`, sender: 'alice', recipient: 'receiver', verifiedBy, protocolCompleted: true, sourceFinality: 'confirmed' },
    metadata: {}
  };
}

describe('correlateBridgeEvents', () => {
  it('officially verifies only the same finalized protocol message id', () => {
    const correlations = correlateBridgeEvents([leg('bridge_destination', 'BSC', 'dest', '1/emitter/42'), leg('bridge_source', 'SOLANA', 'src', '1/emitter/42')]);
    expect(correlations).toHaveLength(1);
    expect(correlations[0]).toMatchObject({ correlationId: 'wormhole:1/emitter/42', status: 'verified', confidence: 100 });
  });

  it('labels amount/time matches as probable, never verified', () => {
    const correlations = correlateBridgeEvents([leg('bridge_source', 'SOLANA', 'src', null, 'heuristic'), leg('bridge_destination', 'BSC', 'dest', null, 'heuristic')]);
    expect(correlations[0]).toMatchObject({ status: 'probable', confidence: 55 });
    expect(correlations[0]?.reasonCodes).toContain('not_officially_verified');
  });

  it('does not correlate different official ids even when amount/time match', () => {
    const correlations = correlateBridgeEvents([leg('bridge_source', 'SOLANA', 'src', '1/e/1'), leg('bridge_destination', 'BSC', 'dest', '1/e/2')], { allowHeuristic: false });
    expect(correlations).toEqual([]);
  });
});
