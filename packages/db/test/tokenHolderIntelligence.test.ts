import { describe, expect, it } from 'vitest';
import {
  dedupeResolvedHolders,
  holderQualificationReasons,
  normalizeTokenHolderRow,
  selectIndependentHolderProfiles,
  selectSmartAndUnratedHolderProfiles
} from '../src/operator/tokenHolderIntelligence';

const OWNER = 'GV6UUmNxz2RpKxmNAPadYKb7uQpszwqQAu3qLJxVdC52';
const ACCOUNT_ONE = '2U9XFtekYTstzMYXmuyDCNdFxRYB91dMtSKxtUB5rVct';
const ACCOUNT_TWO = 'C1mnv5eunJjrkCtMx5QQZ3Y1htCLbHwZHpzNg7FDa8vV';

describe('token holder intelligence', () => {
  it('uses the actual holder list position and current balance fields', () => {
    const row = normalizeTokenHolderRow({
      address: OWNER,
      account_address: ACCOUNT_ONE,
      balance: 584_284_549.844501,
      amount_percentage: 0.5843176403367909,
      usd_value: 107_547_445.8,
      realized_profit: 2_464_433
    }, 7);

    expect(row.holderRank).toBe(7);
    expect(row.providerOwner).toBe(OWNER);
    expect(row.tokenAccount).toBe(ACCOUNT_ONE);
    expect(row.supplyPercentage).toBeCloseTo(58.431764, 5);
    expect(row.positionUsd).toBeCloseTo(107_547_445.8);
  });

  it('deduplicates token accounts only after owner resolution', () => {
    const first = { ...normalizeTokenHolderRow({ address: OWNER, account_address: ACCOUNT_ONE, balance: 10, amount_percentage: 0.01 }, 3), ownerAddress: OWNER, ownerResolution: 'rpc_token_account' as const, accountType: 'wallet' as const, isOnCurve: true };
    const second = { ...normalizeTokenHolderRow({ address: OWNER, account_address: ACCOUNT_TWO, balance: 20, amount_percentage: 0.02 }, 9), ownerAddress: OWNER, ownerResolution: 'rpc_token_account' as const, accountType: 'wallet' as const, isOnCurve: true };

    const rows = dedupeResolvedHolders([first, second]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ holderRank: 3, balance: 30, supplyPercentage: 3 });
    expect(rows[0]?.tokenAccounts).toEqual([ACCOUNT_ONE, ACCOUNT_TWO]);
  });

  it('treats current Core CSV membership as a source prior, never as Reliability', () => {
    expect(holderQualificationReasons({ currentCoreCsv: true, sourceScore: 92, completedPositions: 0, liveTraderEvidence: false }))
      .toEqual(['authoritative_core_csv', 'authoritative_core_source_score_85']);
    expect(holderQualificationReasons({ currentCoreCsv: false, sourceScore: 92, completedPositions: 0, liveTraderEvidence: false }))
      .toEqual([]);
    expect(holderQualificationReasons({ currentCoreCsv: false, completedPositions: 0, liveTraderEvidence: true }))
      .toEqual([]);
  });

  it('keeps at most one displayed wallet per entity', () => {
    const selected = selectIndependentHolderProfiles([
      { wallet: 'a', entityKey: 'entity:one' },
      { wallet: 'b', entityKey: 'entity:one' },
      { wallet: 'c', entityKey: 'entity:two' }
    ], 5);
    expect(selected.map((row) => row.wallet)).toEqual(['a', 'c']);
  });

  it('shows smart holders first and uses unrated holders only to fill remaining slots', () => {
    const selected = selectSmartAndUnratedHolderProfiles(
      [{ wallet: 'smart-a', entityKey: 'entity:a' }, { wallet: 'smart-b', entityKey: 'entity:b' }],
      [{ wallet: 'whale-a', entityKey: 'entity:a' }, { wallet: 'whale-c', entityKey: 'entity:c' }, { wallet: 'whale-d', entityKey: 'entity:d' }],
      3
    );
    expect(selected.map((row) => row.wallet)).toEqual(['smart-a', 'smart-b', 'whale-c']);
  });
});
