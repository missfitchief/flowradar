import { describe, expect, it } from 'vitest';
import { matchRotations } from '../src/rotation/matcher';
import type { DestBuy, ProfitExit, TransferRec } from '../src/rotation/matcher';
import { evaluateAllRules } from '../src/rules/index';
import { DEFAULT_SETTINGS } from '../src/settings';
import type { TokenWindowAggregate } from '../src/types';

// matchRotations(input): RotationCandidate[] (Task 23 binding decision 1).
//
// ALPHA -> BETA shaped fixture (mirrors packages/providers/src/mock/
// scenarios.ts's buildAlphaToBeta): a wallet exits ALPHA at a $3,000 realized
// profit (>= F.minRealizedProfitUsd=500), bridges the proceeds to BSC via
// Wormhole (transfer 4h after the exit, <= F.maxTransferDelayHours=24), the
// BSC wallet receives ~97% of the transferred value (within
// [F.minValueMatchPct=80, F.maxValueMatchPct=105]), then buys BETA 30 min
// later (<= F.maxBuyDelayMin=60) at an $800k mcap (<= F.maxMcap=5,000,000).
// Every near-miss variant (profit too low, transfer too late, value match too
// low, rebuy too slow, mcap null, mcap too high) must produce ZERO
// candidates for that scenario.

const SOURCE_WALLET = 'wallet-alpha-source';
const DEST_WALLET = 'wallet-beta-dest';
const SOURCE_TOKEN = 'token-alpha';
const DEST_TOKEN = 'token-beta';

const EXIT_TS = new Date('2026-07-04T12:00:00Z');

function baseExit(overrides: Partial<ProfitExit> = {}): ProfitExit {
  return {
    walletId: SOURCE_WALLET,
    tokenId: SOURCE_TOKEN,
    realizedProfitUsd: 3000,
    exitTs: EXIT_TS,
    ...overrides
  };
}

function baseTransfer(overrides: Partial<TransferRec> = {}): TransferRec {
  const ts = new Date(EXIT_TS.getTime() + 4 * 60 * 60_000); // 4h after exit
  return {
    fromWalletId: SOURCE_WALLET,
    toWalletId: DEST_WALLET,
    amountUsd: 10_000,
    ts,
    bridged: true,
    bridgeProtocol: 'Wormhole',
    chainFrom: 'SOLANA',
    chainTo: 'BSC',
    ...overrides
  };
}

function baseReceipt(transfer: TransferRec, overrides: Partial<TransferRec> = {}): TransferRec {
  const receiptTs = new Date(transfer.ts.getTime() + 25 * 60_000); // 25 min bridge hop
  return {
    fromWalletId: SOURCE_WALLET,
    toWalletId: DEST_WALLET,
    amountUsd: transfer.amountUsd * 0.97, // 97% value match
    ts: receiptTs,
    bridged: transfer.bridged,
    bridgeProtocol: transfer.bridgeProtocol,
    chainFrom: transfer.chainFrom,
    chainTo: transfer.chainTo,
    ...overrides
  };
}

function baseDestBuy(receipt: TransferRec, overrides: Partial<DestBuy> = {}): DestBuy {
  return {
    walletId: DEST_WALLET,
    tokenId: DEST_TOKEN,
    usd: receipt.amountUsd * 0.9,
    ts: new Date(receipt.ts.getTime() + 30 * 60_000), // 30 min after receipt
    mcapAtBuy: 800_000,
    ...overrides
  };
}

describe('matchRotations', () => {
  it('ALPHA -> BETA shaped fixture produces exactly 1 candidate', () => {
    const exit = baseExit();
    const transfer = baseTransfer();
    const receipt = baseReceipt(transfer);
    const destBuy = baseDestBuy(receipt);

    const candidates = matchRotations({
      exits: [exit],
      transfers: [transfer],
      receipts: [receipt],
      destBuys: [destBuy],
      settings: DEFAULT_SETTINGS
    });

    expect(candidates).toHaveLength(1);
    const c = candidates[0]!;
    expect(c.sourceWalletId).toBe(SOURCE_WALLET);
    expect(c.destWalletId).toBe(DEST_WALLET);
    expect(c.sourceTokenId).toBe(SOURCE_TOKEN);
    expect(c.destTokenId).toBe(DEST_TOKEN);
    expect(c.realizedProfitUsd).toBe(3000);
    expect(c.transferredValueUsd).toBe(10_000);
    expect(c.receivedValueUsd).toBeCloseTo(9700, 5);
    expect(c.bridged).toBe(true);
    expect(c.chainPath).toEqual(['SOLANA', 'BSC']);
    expect(c.destTokenMcapAtBuy).toBe(800_000);
    expect(c.timeGapMin).toBeGreaterThan(0);
  });

  it('non-bridged direct transfer still produces a candidate with bridged=false, chainPath=[chain]', () => {
    const exit = baseExit();
    const transfer = baseTransfer({ bridged: false, bridgeProtocol: undefined, chainTo: 'SOLANA' });
    const receipt = baseReceipt(transfer, { chainTo: 'SOLANA', bridged: false, bridgeProtocol: undefined });
    const destBuy = baseDestBuy(receipt);

    const candidates = matchRotations({
      exits: [exit],
      transfers: [transfer],
      receipts: [receipt],
      destBuys: [destBuy],
      settings: DEFAULT_SETTINGS
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.bridged).toBe(false);
    expect(candidates[0]!.chainPath).toEqual(['SOLANA']);
  });

  it('near-miss: realized profit $400 (below F.minRealizedProfitUsd=500) -> no candidate', () => {
    const exit = baseExit({ realizedProfitUsd: 400 });
    const transfer = baseTransfer();
    const receipt = baseReceipt(transfer);
    const destBuy = baseDestBuy(receipt);

    const candidates = matchRotations({
      exits: [exit],
      transfers: [transfer],
      receipts: [receipt],
      destBuys: [destBuy],
      settings: DEFAULT_SETTINGS
    });

    expect(candidates).toHaveLength(0);
  });

  it('near-miss: transfer 25h after exit (above F.maxTransferDelayHours=24 — the window ruleF omits) -> no candidate', () => {
    const exit = baseExit();
    const transfer = baseTransfer({ ts: new Date(EXIT_TS.getTime() + 25 * 60 * 60_000) });
    const receipt = baseReceipt(transfer);
    const destBuy = baseDestBuy(receipt);

    const candidates = matchRotations({
      exits: [exit],
      transfers: [transfer],
      receipts: [receipt],
      destBuys: [destBuy],
      settings: DEFAULT_SETTINGS
    });

    expect(candidates).toHaveLength(0);
  });

  it('near-miss: value match 70% (below F.minValueMatchPct=80) -> no candidate', () => {
    const exit = baseExit();
    const transfer = baseTransfer();
    const receipt = baseReceipt(transfer, { amountUsd: transfer.amountUsd * 0.7 });
    const destBuy = baseDestBuy(receipt);

    const candidates = matchRotations({
      exits: [exit],
      transfers: [transfer],
      receipts: [receipt],
      destBuys: [destBuy],
      settings: DEFAULT_SETTINGS
    });

    expect(candidates).toHaveLength(0);
  });

  it('near-miss: rebuy 65 min after receipt (above F.maxBuyDelayMin=60) -> no candidate', () => {
    const exit = baseExit();
    const transfer = baseTransfer();
    const receipt = baseReceipt(transfer);
    const destBuy = baseDestBuy(receipt, { ts: new Date(receipt.ts.getTime() + 65 * 60_000) });

    const candidates = matchRotations({
      exits: [exit],
      transfers: [transfer],
      receipts: [receipt],
      destBuys: [destBuy],
      settings: DEFAULT_SETTINGS
    });

    expect(candidates).toHaveLength(0);
  });

  it('near-miss: mcap null at buy -> no candidate (null is a hard reject, not "unknown => allow")', () => {
    const exit = baseExit();
    const transfer = baseTransfer();
    const receipt = baseReceipt(transfer);
    const destBuy = baseDestBuy(receipt, { mcapAtBuy: null });

    const candidates = matchRotations({
      exits: [exit],
      transfers: [transfer],
      receipts: [receipt],
      destBuys: [destBuy],
      settings: DEFAULT_SETTINGS
    });

    expect(candidates).toHaveLength(0);
  });

  it('near-miss: mcap $6M at buy (above F.maxMcap=5,000,000) -> no candidate', () => {
    const exit = baseExit();
    const transfer = baseTransfer();
    const receipt = baseReceipt(transfer);
    const destBuy = baseDestBuy(receipt, { mcapAtBuy: 6_000_000 });

    const candidates = matchRotations({
      exits: [exit],
      transfers: [transfer],
      receipts: [receipt],
      destBuys: [destBuy],
      settings: DEFAULT_SETTINGS
    });

    expect(candidates).toHaveLength(0);
  });

  it('is deterministic: repeated calls on the same input produce identical output (order + values)', () => {
    const exit = baseExit();
    const transfer = baseTransfer();
    const receipt = baseReceipt(transfer);
    const destBuy = baseDestBuy(receipt);

    const input = {
      exits: [exit],
      transfers: [transfer],
      receipts: [receipt],
      destBuys: [destBuy],
      settings: DEFAULT_SETTINGS
    };

    const first = matchRotations(input);
    const second = matchRotations(input);

    expect(first).toEqual(second);
  });

  it('deterministic ordering across multiple qualifying candidates (sorted by a stable key)', () => {
    const exitA = baseExit({ walletId: 'wallet-a', exitTs: EXIT_TS });
    const transferA = baseTransfer({ fromWalletId: 'wallet-a', toWalletId: 'wallet-a-dest', ts: new Date(EXIT_TS.getTime() + 2 * 60 * 60_000) });
    const receiptA = baseReceipt(transferA, { fromWalletId: 'wallet-a', toWalletId: 'wallet-a-dest' });
    const destBuyA = baseDestBuy(receiptA, { walletId: 'wallet-a-dest' });

    const laterExitTs = new Date(EXIT_TS.getTime() + 60 * 60_000);
    const exitB = baseExit({ walletId: 'wallet-b', exitTs: laterExitTs });
    const transferB = baseTransfer({
      fromWalletId: 'wallet-b',
      toWalletId: 'wallet-b-dest',
      ts: new Date(laterExitTs.getTime() + 3 * 60 * 60_000)
    });
    const receiptB = baseReceipt(transferB, { fromWalletId: 'wallet-b', toWalletId: 'wallet-b-dest' });
    const destBuyB = baseDestBuy(receiptB, { walletId: 'wallet-b-dest' });

    const input = {
      exits: [exitB, exitA], // deliberately out of order
      transfers: [transferB, transferA],
      receipts: [receiptB, receiptA],
      destBuys: [destBuyB, destBuyA],
      settings: DEFAULT_SETTINGS
    };

    const first = matchRotations(input);
    const second = matchRotations(input);

    expect(first).toHaveLength(2);
    expect(first).toEqual(second); // order stable across repeated calls
  });
});

// ---------------------------------------------------------------------------
// evaluateAllRules integration: feeding the matched candidate through as
// rotationCandidates fires Rule F on destToken (this is the whole point of
// Task 23 — Rule F previously always saw rotationCandidates: []).
// ---------------------------------------------------------------------------

function makeAggregate(overrides: Partial<TokenWindowAggregate> = {}): TokenWindowAggregate {
  const base: TokenWindowAggregate = {
    tokenId: DEST_TOKEN,
    windowMinutes: 1440,
    from: new Date('2026-07-04T00:00:00Z'),
    to: new Date('2026-07-05T00:00:00Z'),
    buyers: [],
    trackedBuyVolumeUsd: 0,
    trackedSellVolumeUsd: 0,
    netFlowUsd: 0,
    buySellRatio: 0,
    smartWalletCount: 0,
    humanLikeCount: 0,
    humanOrSmartLabelCount: 0,
    possibleBotCount: 0,
    whaleBuys: [],
    uniqueEntityCount: 0,
    largestClusterSize: 0,
    avgEntryMcap: null,
    currentMcap: null,
    mcapExpansionFromAvgEntry: null,
    liquidityUsd: null,
    liquidityChangePct: null,
    tokenAgeDays: null,
    inflowSpike: false,
    exitedSmartPct: 0,
    topHolderExits: 0,
    newSmartBuyers: 0
  };
  return { ...base, ...overrides };
}

describe('matchRotations -> evaluateAllRules integration', () => {
  it('the matched ALPHA->BETA candidate fires Rule F when evaluated against destToken', () => {
    const exit = baseExit();
    const transfer = baseTransfer();
    const receipt = baseReceipt(transfer);
    const destBuy = baseDestBuy(receipt);

    const candidates = matchRotations({
      exits: [exit],
      transfers: [transfer],
      receipts: [receipt],
      destBuys: [destBuy],
      settings: DEFAULT_SETTINGS
    });
    expect(candidates).toHaveLength(1);

    const agg30 = makeAggregate({ windowMinutes: 30 });
    const agg24h = makeAggregate({ windowMinutes: 1440 });

    const results = evaluateAllRules(agg30, agg24h, DEFAULT_SETTINGS, { rotationCandidates: candidates });
    const ruleF = results.find((r) => r.rule === 'F')!;

    expect(ruleF.fired).toBe(true);
    expect(ruleF.severity).toBe('HIGH');
  });
});
