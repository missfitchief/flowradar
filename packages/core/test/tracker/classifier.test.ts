import { describe, expect, it } from 'vitest';
import { classifyMassEvent, type MassTransactionEvent, type TrackerAddressContext } from '../../src';

const ts = new Date('2026-07-13T00:00:00Z');
function event(overrides: Partial<MassTransactionEvent> = {}): MassTransactionEvent {
  return {
    eventId: 'SOLANA:tx:0', chain: 'SOLANA', txHash: 'tx', eventIndex: 0,
    blockOrSlot: 1n, ts, kind: 'native_transfer', status: 'succeeded',
    from: 'root', to: 'receiver', actor: 'root', asset: { address: null, symbol: 'SOL', decimals: 9, amount: '1', amountUsd: 150 },
    programOrContract: null, provider: 'fixture', observedAt: ts, bridge: null, metadata: {}, ...overrides
  };
}
function ctx(address: string, overrides: Partial<TrackerAddressContext> = {}): TrackerAddressContext {
  return { chain: 'SOLANA', address, infrastructure: null, trackedEntityKey: null, role: 'unknown', observationOnly: true, distinctCounterparties: 0, dormantDays: null, ...overrides };
}

describe('classifyMassEvent', () => {
  it('tracks operator-root capital without granting a trader role', () => {
    const verdict = classifyMassEvent(event(), ctx('root', { trackedEntityKey: 'entity-1', role: 'operator_root' }), ctx('receiver', { dormantDays: 30 }));
    expect(verdict).toMatchObject({ category: 'capital_transfer', relevant: true, safeEntityLink: true, enrollmentCandidate: true, grantsTraderRole: false });
    expect(verdict.reasonCodes).toContain('operator_root_is_capital_provenance_not_trader');
  });

  it('keeps infrastructure visible but blocks entity linking and enrollment', () => {
    const verdict = classifyMassEvent(event(), ctx('root', { trackedEntityKey: 'entity-1', role: 'execution_wallet' }), ctx('receiver', { infrastructure: 'CEX' }));
    expect(verdict).toMatchObject({ category: 'infrastructure_noise', relevant: false, safeEntityLink: false, enrollmentCandidate: false });
  });

  it('does not classify unknown-value token transfers as dust or relevant capital', () => {
    const verdict = classifyMassEvent(
      event({ kind: 'token_transfer', asset: { address: 'mint', symbol: null, decimals: 6, amount: '1000000', amountUsd: null } }),
      ctx('root', { trackedEntityKey: 'entity-1', role: 'execution_wallet' }), ctx('receiver', { dormantDays: 90 })
    );
    expect(verdict).toMatchObject({ category: 'unrelated', relevant: false });
    expect(verdict.reasonCodes).toContain('unknown_value_not_assumed_relevant');
  });

  it('accepts only bounded native gas funding when USD is unknown', () => {
    const verdict = classifyMassEvent(
      event({ asset: { address: null, symbol: 'SOL', decimals: 9, amount: '0.05', amountUsd: null } }),
      ctx('root', { trackedEntityKey: 'entity-1', role: 'operator_root' }), ctx('receiver')
    );
    expect(verdict).toMatchObject({ category: 'gas_funding', relevant: true, grantsTraderRole: false });
  });

  it('classifies a BSC token output as a buy only with same-tx outflow + contract-call structure', () => {
    const verdict = classifyMassEvent(
      event({ chain: 'BSC', kind: 'token_transfer', from: '0xrouter', to: '0xactor', actor: '0xactor', asset: { address: '0xtoken', symbol: 'NEW', decimals: 18, amount: '10', amountUsd: 200 }, metadata: { sameTxActorSentValue: true, sameTxContractTargets: ['0xrouter'] } }),
      ctx('0xrouter', { chain: 'BSC', infrastructure: 'ROUTER' }), ctx('0xactor', { chain: 'BSC' })
    );
    expect(verdict).toMatchObject({ category: 'token_deployment', relevant: true, score: 80, grantsTraderRole: false });
  });
});
