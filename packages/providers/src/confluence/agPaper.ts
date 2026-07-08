// FlowRadar — AG Paper Trading observation provider (design doc §Module E).
// MANUAL / STUB ONLY. Global constraint 9/19: NO automation, NO Telegram
// button clicking, NO bot control, NO execution, NO private keys, NO scraping,
// and NO assuming an API exists without docs. There is likely no public API,
// so this adapter fetches NOTHING and resolves status 'stub'. Keyless (no env).
//
// MANUAL IMPORT CSV SHAPE (documentation only — this task builds NO parser and
// NO importer; any conversion happens OUTSIDE this task, operator-driven):
//
//   tokenAddress,chain,paperEntryAt,paperExitAt,paperEntryPrice,paperExitPrice,paperPnlPct,notes
//
// where:
//   tokenAddress   - the token's on-chain address (links by (chain,address), never creates a Token)
//   chain          - 'SOLANA' (Solana-only in practice; schema stays chain-aware)
//   paperEntryAt   - ISO-8601 timestamp of the PAPER (not real) entry, or empty
//   paperExitAt    - ISO-8601 timestamp of the PAPER exit, or empty
//   paperEntryPrice- decimal price at paper entry, or empty
//   paperExitPrice - decimal price at paper exit, or empty
//   paperPnlPct    - percent PnL of the paper observation, or empty
//   notes          - free-text operator note
//
// Paper observations are for COMPARISON against FlowRadar / social / wallet
// signals only — NEVER treated as real execution. When (later, outside this
// task) an operator imports such a CSV, each row becomes a TokenConfluenceSnapshot
// with snapshotType 'paper_trade' (design doc: no dedicated PaperTradeObservation
// table — reuse the snapshot). This provider itself imports nothing.
import type { Chain } from '@flowradar/core';
import type { ConfluenceFetchResult, ConfluenceProvider } from './types';

export function createAgPaperProvider(): ConfluenceProvider | null {
  return {
    name: 'ag_paper',
    provider: 'ag_paper',
    snapshotType: 'paper_trade',
    chains: ['SOLANA'],
    async fetchForToken(_chain: Chain, _tokenAddress: string): Promise<ConfluenceFetchResult> {
      return {
        status: 'stub',
        dataJson: {
          providerClaimed: false,
          note: 'AG Paper is manual/stub only — no automated fetch. Paper observations are imported by the operator out-of-band and are NOT real execution. Absence is NOT a safe signal.'
        },
        observedAt: new Date(0)
      };
    }
  };
}
