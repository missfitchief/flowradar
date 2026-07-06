// FlowRadar — bscscanMapper.ts fixture tests (Task 29).
//
// Fixtures live in test/fixtures/bscscan/*.json — txlist-page.json and
// tokentx-page.json use doc-verified field NAMES (values synthetic, see each
// fixture's `_docSource`), empty-page.json documents the "no transactions
// found" not-an-error case.

import { describe, expect, it } from 'vitest';
import {
  buildLegForTokentxRow,
  buildLegForTxlistRow,
  extractRows,
  mapBscScanTransactions
} from '../src/bsc/bscscanMapper';
import type { BscScanTokentxRow, BscScanTxlistRow } from '../src/bsc/bscscanMapper';
import txlistFixture from './fixtures/bscscan/txlist-page.json';
import tokentxFixture from './fixtures/bscscan/tokentx-page.json';
import emptyFixture from './fixtures/bscscan/empty-page.json';

const txlistRows = txlistFixture.result as unknown as BscScanTxlistRow[];
const tokentxRows = tokentxFixture.result as unknown as BscScanTokentxRow[];

describe('extractRows', () => {
  it('returns the result array for a successful response', () => {
    expect(extractRows(txlistFixture as any).length).toBe(3);
  });

  it('returns [] for the documented "no transactions found" empty case', () => {
    expect(extractRows(emptyFixture as any)).toEqual([]);
  });

  it('returns [] for a null/undefined response', () => {
    expect(extractRows(null)).toEqual([]);
    expect(extractRows(undefined)).toEqual([]);
  });
});

describe('buildLegForTxlistRow', () => {
  it('maps a native-value row to a native_transfer leg with wei converted to a BNB decimal string', () => {
    const leg = buildLegForTxlistRow(txlistRows[0]!);
    expect(leg).not.toBeNull();
    expect(leg!.kind).toBe('native_transfer');
    expect(leg!.from).toBe('0x9f3a2bcd11ee44ff33aa55bb66cc77dd88ee99f0');
    expect(leg!.to).toBe('0x5c1e3f7a2b9d4e6f8a0c2d4e6f8a0c2d4e6f8a0c');
    expect(leg!.asset).toEqual({ symbol: 'BNB', decimals: 18 });
    expect(leg!.amountToken).toBe('0.5');
  });

  it('maps a zero-value row with non-empty input to a contract_interaction leg (router call, not a synthesized swap)', () => {
    const leg = buildLegForTxlistRow(txlistRows[1]!);
    expect(leg).not.toBeNull();
    expect(leg!.kind).toBe('contract_interaction');
    expect(leg!.to).toBe('0x10ed43c718714eb63d5aa57b78b54704e256024e');
    expect(leg!.amountToken).toBe('0');
  });

  it('lowercases addresses per repo convention', () => {
    const mixedCaseRow: BscScanTxlistRow = {
      ...txlistRows[0]!,
      from: '0x9F3A2BCD11EE44FF33AA55BB66CC77DD88EE99F0',
      to: '0x5C1E3F7A2B9D4E6F8A0C2D4E6F8A0C2D4E6F8A0C'
    };
    const leg = buildLegForTxlistRow(mixedCaseRow);
    expect(leg!.from).toBe('0x9f3a2bcd11ee44ff33aa55bb66cc77dd88ee99f0');
    expect(leg!.to).toBe('0x5c1e3f7a2b9d4e6f8a0c2d4e6f8a0c2d4e6f8a0c');
  });

  it('returns null for a zero-value row with empty input (nothing of ledger interest)', () => {
    const noop: BscScanTxlistRow = { ...txlistRows[0]!, value: '0', input: '0x' };
    expect(buildLegForTxlistRow(noop)).toBeNull();
  });
});

describe('buildLegForTokentxRow', () => {
  it('maps a tokentx row to a token_transfer leg using the row-provided symbol/decimals', () => {
    const leg = buildLegForTokentxRow(tokentxRows[0]!);
    expect(leg.kind).toBe('token_transfer');
    expect(leg.asset.address).toBe('0x55d398326f99059ff775485246999027b3197955');
    expect(leg.asset.symbol).toBe('USDT');
    expect(leg.asset.decimals).toBe(18);
    expect(leg.amountToken).toBe('100');
  });

  it('handles a small-value WBNB transfer with correct decimal formatting', () => {
    const leg = buildLegForTokentxRow(tokentxRows[1]!);
    expect(leg.asset.symbol).toBe('WBNB');
    expect(leg.amountToken).toBe('2.5');
  });
});

describe('mapBscScanTransactions', () => {
  it('merges txlist + tokentx rows into one NormalizedTx per hash, sorted by block ascending', () => {
    const merged = mapBscScanTransactions(txlistRows, tokentxRows);
    // 3 txlist hashes (one fails/isError -> skip its leg but tokentx row 0
    // has a DIFFERENT hash) + 2 tokentx hashes = 5 distinct hashes total,
    // minus the failed-isError txlist row producing no leg and having no
    // tokentx counterpart -> excluded entirely.
    const hashes = merged.map((tx) => tx.txHash);
    expect(hashes).toContain(txlistRows[0]!.hash);
    expect(hashes).toContain(txlistRows[1]!.hash);
    expect(hashes).not.toContain(txlistRows[2]!.hash); // isError="1" -> excluded
    expect(hashes).toContain(tokentxRows[0]!.hash);
    expect(hashes).toContain(tokentxRows[1]!.hash);

    // sorted ascending by block
    const blocks = merged.map((tx) => tx.blockOrSlot);
    const sorted = [...blocks].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(blocks).toEqual(sorted);
  });

  it('excludes isError="1" txlist rows entirely (failed tx moved no value)', () => {
    const merged = mapBscScanTransactions(txlistRows, []);
    expect(merged.some((tx) => tx.txHash === txlistRows[2]!.hash)).toBe(false);
  });

  it('never produces a swap_leg (BscScan txlist/tokentx carry no decoded swap event)', () => {
    const merged = mapBscScanTransactions(txlistRows, tokentxRows);
    for (const tx of merged) {
      expect(tx.legs.some((l) => l.kind === 'swap_leg')).toBe(false);
    }
  });

  it('a router-call tx (zero value, non-empty input) plus its tokentx legs coexist on one NormalizedTx when they share a hash', () => {
    const sharedHash = '0xshared00000000000000000000000000000000000000000000000000000000';
    const routerCall: BscScanTxlistRow = { ...txlistRows[1]!, hash: sharedHash };
    const tokenLeg: BscScanTokentxRow = { ...tokentxRows[0]!, hash: sharedHash };
    const merged = mapBscScanTransactions([routerCall], [tokenLeg]);
    expect(merged.length).toBe(1);
    expect(merged[0]!.legs.length).toBe(2);
    expect(merged[0]!.legs.some((l) => l.kind === 'contract_interaction')).toBe(true);
    expect(merged[0]!.legs.some((l) => l.kind === 'token_transfer')).toBe(true);
  });

  it('is deterministic: mapping the same fixtures twice produces deep-equal output', () => {
    const a = mapBscScanTransactions(txlistRows, tokentxRows);
    const b = mapBscScanTransactions(txlistRows, tokentxRows);
    expect(a).toEqual(b);
  });
});
