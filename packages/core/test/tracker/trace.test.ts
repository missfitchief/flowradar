import { describe, expect, it } from 'vitest';
import { traceCapitalToTokenBuys, type ClassifiedMassEvent, type MassTransactionEvent, type RelevanceVerdict } from '../../src';

const start = new Date('2026-07-13T00:00:00Z');
function classified(id: string, from: string, to: string, minute: number, kind: MassTransactionEvent['kind'], assetAddress: string | null = null): ClassifiedMassEvent {
  const event: MassTransactionEvent = {
    eventId: id, chain: 'SOLANA', txHash: id, eventIndex: 0, blockOrSlot: BigInt(minute), ts: new Date(start.getTime() + minute * 60_000), kind, status: 'succeeded', from, to,
    actor: from, asset: { address: assetAddress, symbol: assetAddress ? 'TOKEN' : 'SOL', decimals: 9, amount: '1', amountUsd: 200 },
    programOrContract: null, provider: 'fixture', observedAt: start, bridge: null, metadata: {}
  };
  const verdict: RelevanceVerdict = { relevant: true, category: kind === 'token_buy' ? 'token_deployment' : 'capital_transfer', score: 85, reasonCodes: [], safeEntityLink: true, enrollmentCandidate: kind !== 'token_buy', grantsTraderRole: false };
  return { event, verdict };
}

describe('traceCapitalToTokenBuys', () => {
  it('builds deterministic entity -> multi-hop -> receiver -> buy chains', () => {
    const events = [
      classified('a', 'root', 'side', 0, 'native_transfer'),
      classified('b', 'side', 'execution', 2, 'native_transfer'),
      classified('c', 'execution', 'execution', 5, 'token_buy', 'mint-new')
    ];
    // A buy is represented as wallet -> wallet for terminal ownership, but the
    // classifier accepts it before the transfer self-noise rule in real input.
    const traces = traceCapitalToTokenBuys({ sourceEntityKey: 'entity', sourceWallet: 'root', sourceChain: 'SOLANA', sourceRole: 'operator_root', events });
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({ terminalWallet: 'execution', tokenBought: 'mint-new', route: 'multi_hop_transfer', grantsEligibility: false });
    expect(traces[0]?.hops.map((h) => h.event.eventId)).toEqual(['a', 'b', 'c']);
  });

  it('is cycle-safe and bounded', () => {
    const events = [classified('a', 'root', 'a', 0, 'native_transfer'), classified('b', 'a', 'root', 1, 'native_transfer')];
    expect(traceCapitalToTokenBuys({ sourceEntityKey: 'e', sourceWallet: 'root', sourceChain: 'SOLANA', sourceRole: 'operator_root', events, config: { maxHops: 2, maxPaths: 2 } })).toEqual([]);
  });
});
