// FlowRadar — Helius Enhanced Transactions -> NormalizedTx mapper (Task 27).
//
// Pure function, no I/O: maps one raw Helius "parsed transaction" object (the
// per-element shape of the GET /v0/addresses/{address}/transactions response
// array — doc-verified, see helius.ts header for the fetched doc URLs and
// what each verified) into the shared NormalizedTx/TxLeg contract
// (@flowradar/core types.ts). Schema-lenient: only reads the fields it needs
// via manual picks with `?? []` / `?? null` fallbacks, so unrecognized extra
// fields on the payload (Helius adds fields over time) never throw — see
// mapUnknownHeliusTx's fixture-tested "someFutureFieldNotYetModeled" case.
//
// Mapping rules (Task 27 binding decision 3):
//   - events.swap present -> one paired swap_leg per side: the wallet's SELL
//     side (tokenInputs / nativeInput, i.e. what left the wallet) and BUY
//     side (tokenOutputs / nativeOutput, i.e. what the wallet received).
//     amountUsd is left undefined — Helius's events.swap payload (per the
//     doc-verified shape) carries no USD field, only raw token amounts; a
//     later task/layer that has market-price data can backfill amountUsd,
//     this mapper never invents a USD figure it can't derive from the input.
//   - nativeTransfers[] (present on TRANSFER-type and many other tx types,
//     independent of `type`) -> one native_transfer leg per entry, lamports
//     converted to a decimal SOL string (9 decimals, matches native SOL).
//   - tokenTransfers[] -> one token_transfer leg per entry. Decimals: prefer
//     the matching accountData[].tokenBalanceChanges[].rawTokenAmount.decimals
//     entry for the same mint (most precise, present on the doc-verified
//     shape); tokenTransfers[].tokenAmount itself is already UI-decimal
//     (per docs: "tokenAmount": 100.5, a float, NOT a raw integer), so when no
//     accountData match exists this mapper falls back to a best-effort
//     decimals of 0 fractional-digit inference from the number's own string
//     form rather than guessing a mint's real decimals count.
//   - Every other/unrecognized `type` (no native/token transfers, no
//     events.swap) -> a single contract_interaction leg summarizing the
//     transaction (from/to = feePayer twice, since no counterparty is
//     derivable without a transfer/swap event).
//   - Bridge detection: `source === 'WORMHOLE'` (Helius's own `source`
//     classification field, doc-verified enum-like string field) marks every
//     leg bridge_deposit (native token leaving the wallet into a bridge
//     program) or bridge_withdrawal (token arriving FROM a bridge program)
//     depending on transfer direction relative to `walletAddress`.
//
// blockOrSlot: Helius's top-level `slot` field (verified in the docs'
// response shape) — always present, mapped straight to a bigint.
// ts: `timestamp` is Unix seconds (docs: "timestamp": 1656442333) -> Date.

import type { LegKind, NormalizedTx, TxLeg } from '@flowradar/core';

// ---------------------------------------------------------------------------
// Raw Helius payload shapes (schema-lenient: optional/passthrough by design)
// ---------------------------------------------------------------------------

export interface HeliusNativeTransfer {
  fromUserAccount: string;
  toUserAccount: string;
  amount: number; // lamports
}

export interface HeliusTokenTransfer {
  fromUserAccount: string;
  toUserAccount: string;
  fromTokenAccount?: string;
  toTokenAccount?: string;
  tokenAmount: number; // UI-decimal (already divided by 10^decimals) per docs example
  mint: string;
}

export interface HeliusRawTokenAmount {
  tokenAmount: string;
  decimals: number;
}

export interface HeliusTokenBalanceChange {
  userAccount: string;
  tokenAccount: string;
  mint: string;
  rawTokenAmount: HeliusRawTokenAmount;
}

export interface HeliusAccountData {
  account: string;
  nativeBalanceChange: number;
  tokenBalanceChanges?: HeliusTokenBalanceChange[];
}

export interface HeliusSwapTokenLeg {
  userAccount: string;
  tokenAccount: string;
  mint: string;
  rawTokenAmount: HeliusRawTokenAmount;
}

export interface HeliusSwapNativeLeg {
  account: string;
  amount: string; // lamports, as string per docs example
}

export interface HeliusSwapEvent {
  nativeInput?: HeliusSwapNativeLeg | null;
  nativeOutput?: HeliusSwapNativeLeg | null;
  tokenInputs?: HeliusSwapTokenLeg[];
  tokenOutputs?: HeliusSwapTokenLeg[];
}

export interface HeliusEvents {
  swap?: HeliusSwapEvent | null;
}

/**
 * One element of the GET /v0/addresses/{address}/transactions response array
 * (Task 27 doc-verified shape). Extra unmodeled fields are tolerated (not
 * listed here) — this interface only names what the mapper reads.
 */
export interface HeliusTransaction {
  description?: string;
  type: string;
  source?: string;
  fee?: number;
  feePayer: string;
  signature: string;
  slot: number;
  timestamp: number;
  nativeTransfers?: HeliusNativeTransfer[];
  tokenTransfers?: HeliusTokenTransfer[];
  accountData?: HeliusAccountData[];
  transactionError?: unknown;
  events?: HeliusEvents;
  // Deliberately no index signature / passthrough field listed: unknown
  // extra keys on the raw JSON are simply never read, which is exactly
  // "tolerate unknown fields" for a plain-TS manual-pick mapper (no crash,
  // no validation library needed for this pure/no-I/O module).
}

const SOL_DECIMALS = 9;
const NATIVE_SOL_SYMBOL = 'SOL';
const WORMHOLE_SOURCE = 'WORMHOLE';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Exact-enough decimal formatter — trims trailing zeros but keeps at least one digit if there's a fractional part. */
function toDecimalString(value: number, decimals: number): string {
  if (decimals <= 0) return String(Math.trunc(value));
  const fixed = value.toFixed(decimals);
  const trimmed = fixed.replace(/0+$/, '').replace(/\.$/, '');
  return trimmed === '' || trimmed === '-' ? '0' : trimmed;
}

function findMintDecimals(accountData: HeliusAccountData[] | undefined, mint: string): number | null {
  if (!accountData) return null;
  for (const entry of accountData) {
    for (const change of entry.tokenBalanceChanges ?? []) {
      if (change.mint === mint) return change.rawTokenAmount.decimals;
    }
  }
  return null;
}

function isBridgeSource(source: string | undefined): boolean {
  return source === WORMHOLE_SOURCE;
}

// ---------------------------------------------------------------------------
// Leg builders
// ---------------------------------------------------------------------------

function buildNativeTransferLegs(tx: HeliusTransaction, walletAddress: string): TxLeg[] {
  const bridge = isBridgeSource(tx.source);
  return (tx.nativeTransfers ?? [])
    .filter((t) => t.amount > 0)
    .map((t) => {
      let kind: LegKind = 'native_transfer';
      if (bridge) {
        kind = t.fromUserAccount === walletAddress ? 'bridge_deposit' : 'bridge_withdrawal';
      }
      return {
        kind,
        from: t.fromUserAccount,
        to: t.toUserAccount,
        asset: { symbol: NATIVE_SOL_SYMBOL, decimals: SOL_DECIMALS },
        amountToken: toDecimalString(t.amount / 10 ** SOL_DECIMALS, SOL_DECIMALS)
      } satisfies TxLeg;
    });
}

function buildTokenTransferLegs(tx: HeliusTransaction, walletAddress: string): TxLeg[] {
  const bridge = isBridgeSource(tx.source);
  return (tx.tokenTransfers ?? []).map((t) => {
    const decimals = findMintDecimals(tx.accountData, t.mint) ?? inferDecimalsFromUiAmount(t.tokenAmount);
    let kind: LegKind = 'token_transfer';
    if (bridge) {
      kind = t.fromUserAccount === walletAddress ? 'bridge_deposit' : 'bridge_withdrawal';
    }
    return {
      kind,
      from: t.fromUserAccount,
      to: t.toUserAccount,
      asset: { address: t.mint, symbol: t.mint.slice(0, 4), decimals },
      amountToken: toDecimalString(t.tokenAmount, decimals)
    } satisfies TxLeg;
  });
}

/** Best-effort decimals guess from a UI-decimal float's own fractional-digit count, when no accountData match exists (see file header). */
function inferDecimalsFromUiAmount(value: number): number {
  const s = String(value);
  const dot = s.indexOf('.');
  return dot === -1 ? 0 : s.length - dot - 1;
}

function buildSwapLegs(tx: HeliusTransaction): TxLeg[] {
  const swap = tx.events?.swap;
  if (!swap) return [];

  const legs: TxLeg[] = [];

  // SELL side (from the wallet's perspective): what the wallet gave up.
  if (swap.nativeInput) {
    legs.push({
      kind: 'swap_leg',
      from: swap.nativeInput.account,
      to: '',
      asset: { symbol: NATIVE_SOL_SYMBOL, decimals: SOL_DECIMALS },
      amountToken: toDecimalString(Number(swap.nativeInput.amount) / 10 ** SOL_DECIMALS, SOL_DECIMALS)
    });
  }
  for (const input of swap.tokenInputs ?? []) {
    legs.push({
      kind: 'swap_leg',
      from: input.userAccount,
      to: '',
      asset: { address: input.mint, symbol: input.mint.slice(0, 4), decimals: input.rawTokenAmount.decimals },
      amountToken: toDecimalString(Number(input.rawTokenAmount.tokenAmount) / 10 ** input.rawTokenAmount.decimals, input.rawTokenAmount.decimals)
    });
  }

  // BUY side: what the wallet received.
  if (swap.nativeOutput) {
    legs.push({
      kind: 'swap_leg',
      from: '',
      to: swap.nativeOutput.account,
      asset: { symbol: NATIVE_SOL_SYMBOL, decimals: SOL_DECIMALS },
      amountToken: toDecimalString(Number(swap.nativeOutput.amount) / 10 ** SOL_DECIMALS, SOL_DECIMALS)
    });
  }
  for (const output of swap.tokenOutputs ?? []) {
    legs.push({
      kind: 'swap_leg',
      from: '',
      to: output.userAccount,
      asset: { address: output.mint, symbol: output.mint.slice(0, 4), decimals: output.rawTokenAmount.decimals },
      amountToken: toDecimalString(Number(output.rawTokenAmount.tokenAmount) / 10 ** output.rawTokenAmount.decimals, output.rawTokenAmount.decimals)
    });
  }

  return legs;
}

function buildContractInteractionLeg(tx: HeliusTransaction): TxLeg {
  return {
    kind: 'contract_interaction',
    from: tx.feePayer,
    to: tx.feePayer,
    asset: { symbol: NATIVE_SOL_SYMBOL, decimals: SOL_DECIMALS },
    amountToken: '0',
    programOrContract: tx.source
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Maps one raw Helius transaction (doc-verified shape) into a NormalizedTx.
 * `walletAddress` is the wallet this tx was fetched FOR — used only to decide
 * bridge_deposit vs bridge_withdrawal direction (see file header). Never
 * throws on unrecognized/extra fields (schema-lenient manual picks).
 */
export function mapHeliusTransaction(tx: HeliusTransaction, walletAddress: string): NormalizedTx {
  const legs: TxLeg[] = [
    ...buildSwapLegs(tx),
    ...buildNativeTransferLegs(tx, walletAddress),
    ...buildTokenTransferLegs(tx, walletAddress)
  ];

  if (legs.length === 0) {
    legs.push(buildContractInteractionLeg(tx));
  }

  return {
    txHash: tx.signature,
    blockOrSlot: BigInt(tx.slot),
    ts: new Date(tx.timestamp * 1000),
    legs,
    status: tx.transactionError == null ? 'succeeded' : 'failed'
  };
}

/** Maps a full page of raw Helius transactions for one wallet. */
export function mapHeliusTransactions(txs: HeliusTransaction[], walletAddress: string): NormalizedTx[] {
  return txs.map((tx) => mapHeliusTransaction(tx, walletAddress));
}
