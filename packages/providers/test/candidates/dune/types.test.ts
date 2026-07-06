// FlowRadar — DuneOverlapRowSchema / parseOverlapRows tests (Task 37, Wave
// 4.6). Valid rows map; rows missing wallet_address are dropped + counted,
// not thrown; extra/unknown fields are tolerated.

import { describe, expect, it } from 'vitest';
import { DuneOverlapRowSchema, parseOverlapRows } from '../../../src/candidates/dune/types';

describe('DuneOverlapRowSchema / parseOverlapRows', () => {
  it('parses a fully-populated valid row', () => {
    const row = {
      wallet_address: 'WALLET1',
      chain: 'SOLANA',
      token_address: 'TOKEN1',
      token_symbol: 'FOO',
      first_buy_time: '2026-07-01T00:00:00Z',
      buy_count: 5,
      sell_count: 2,
      total_buy_usd: 1000,
      total_sell_usd: 1500,
      estimated_pnl_usd: 500,
      entry_market_cap_usd: 200000,
      tx_hashes: ['0xabc', '0xdef'],
      tokens_overlap_count: 3,
      overlap_group_id: 'group_1'
    };
    const result = DuneOverlapRowSchema.safeParse(row);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.wallet_address).toBe('WALLET1');
      expect(result.data.tokens_overlap_count).toBe(3);
    }
  });

  it('parses a minimal row with ONLY wallet_address — every other field optional', () => {
    const result = DuneOverlapRowSchema.safeParse({ wallet_address: 'WALLET_MIN' });
    expect(result.success).toBe(true);
  });

  it('rejects (does not throw) a row missing wallet_address', () => {
    const result = DuneOverlapRowSchema.safeParse({ chain: 'SOLANA', buy_count: 3 });
    expect(result.success).toBe(false);
  });

  it('rejects a row with an empty-string wallet_address', () => {
    const result = DuneOverlapRowSchema.safeParse({ wallet_address: '' });
    expect(result.success).toBe(false);
  });

  it('tolerates extra/unknown fields not in the schema', () => {
    const result = DuneOverlapRowSchema.safeParse({
      wallet_address: 'WALLET2',
      some_future_dune_column: 'unexpected',
      another_new_field: 42
    });
    expect(result.success).toBe(true);
  });

  describe('parseOverlapRows', () => {
    it('maps valid rows and drops+counts invalid ones, never throwing', () => {
      const raw = [
        { wallet_address: 'GOOD1', tokens_overlap_count: 2 },
        { chain: 'SOLANA' }, // missing wallet_address — dropped
        { wallet_address: 'GOOD2', tokens_overlap_count: 3 },
        { wallet_address: 123 }, // wrong type — dropped
        { wallet_address: 'GOOD3', extra_field: 'tolerated' }
      ];

      const result = parseOverlapRows(raw);

      expect(result.rows).toHaveLength(3);
      expect(result.rows.map((r) => r.wallet_address)).toEqual(['GOOD1', 'GOOD2', 'GOOD3']);
      expect(result.droppedCount).toBe(2);
    });

    it('empty input => empty output, zero dropped', () => {
      const result = parseOverlapRows([]);
      expect(result.rows).toEqual([]);
      expect(result.droppedCount).toBe(0);
    });

    it('all-invalid input => all dropped, zero rows', () => {
      const result = parseOverlapRows([{ foo: 'bar' }, {}]);
      expect(result.rows).toEqual([]);
      expect(result.droppedCount).toBe(2);
    });
  });
});
