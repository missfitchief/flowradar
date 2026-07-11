// FlowRadar — receipts-backed behavior engine tests (directive Task 5).

import { describe, expect, it } from 'vitest';
import { deriveBehaviorReceipts, RECEIPTS_ENGINE_VERSION } from '../../src/behavior/receipts';
import type { ReceiptTradeInput, ReceiptTransferInput, ReceiptsEngineInput } from '../../src/behavior/receipts';

const NOW = new Date('2026-07-11T12:00:00Z');
let txSeq = 0;

function trade(wallet: string, token: string, action: 'BUY' | 'SELL', usd: number, tsOffsetSec: number, slot: bigint, mcap: number | null = 100_000): ReceiptTradeInput {
  return { walletAddress: wallet, tokenAddress: token, action, amountUsd: usd, ts: new Date(NOW.getTime() - tsOffsetSec * 1000), blockOrSlot: slot, txHash: `tx${++txSeq}`, marketCapAtTrade: mcap };
}
function transfer(src: string, dst: string, usd: number, tsOffsetSec: number): ReceiptTransferInput {
  return { sourceAddress: src, destinationAddress: dst, usd, ts: new Date(NOW.getTime() - tsOffsetSec * 1000), txHash: `tx${++txSeq}` };
}
function run(trades: ReceiptTradeInput[], transfers: ReceiptTransferInput[] = [], extra: Partial<ReceiptsEngineInput> = {}) {
  return deriveBehaviorReceipts({ trades, transfers, now: NOW, ...extra });
}

describe('deriveBehaviorReceipts', () => {
  it('every receipt carries the full evidence contract — no opaque labels', () => {
    const trades = [
      trade('A', 'TOK', 'BUY', 100, 7200, 100n),
      trade('B', 'TOK', 'BUY', 100, 7190, 101n),
      trade('C', 'TOK', 'BUY', 100, 7180, 102n)
    ];
    const r = run(trades);
    expect(r.grantsEligibility).toBe(false);
    for (const receipt of r.receipts) {
      expect(receipt.classificationVersion).toBe(RECEIPTS_ENGINE_VERSION);
      expect(receipt.evidenceTxs.length).toBeGreaterThan(0);
      expect(receipt.exampleTokens.length).toBeGreaterThan(0);
      expect(receipt.caveats.length).toBeGreaterThan(0);
      expect(receipt.componentMetrics).toBeTruthy();
      expect(receipt.explorerLinks.every((l) => l.startsWith('https://solscan.io/tx/'))).toBe(true);
      expect(typeof receipt.independentTokenRepetition).toBe('number');
    }
  });

  it('same_block_launch_cluster: >=3 first buys inside the launch slot window', () => {
    const trades = [
      trade('A', 'LNCH', 'BUY', 100, 7200, 1000n),
      trade('B', 'LNCH', 'BUY', 100, 7195, 1005n),
      trade('C', 'LNCH', 'BUY', 100, 7190, 1010n),
      trade('LATE', 'LNCH', 'BUY', 100, 3600, 5000n) // far outside the window
    ];
    const r = run(trades);
    const cluster = r.receipts.find((x) => x.classification === 'same_block_launch_cluster');
    expect(cluster).toBeDefined();
    expect(cluster!.wallets.sort()).toEqual(['A', 'B', 'C']);
    expect(cluster!.wallets).not.toContain('LATE');
  });

  it('single_burst_exit: >=90% of the position sold within one 60s burst', () => {
    const trades = [
      trade('W', 'TOK', 'BUY', 1000, 86400, 10n),
      trade('W', 'TOK', 'SELL', 500, 3600, 500n),
      trade('W', 'TOK', 'SELL', 450, 3590, 501n) // 950 of 1000 within 10s
    ];
    const r = run(trades);
    const burst = r.receipts.find((x) => x.classification === 'single_burst_exit');
    expect(burst).toBeDefined();
    expect(burst!.evidenceTxs.length).toBe(2);
    expect(burst!.componentMetrics.burstUsd).toBe(950);
  });

  it('slow exits do NOT fire single_burst_exit', () => {
    const trades = [
      trade('W', 'TOK', 'BUY', 1000, 86400, 10n),
      trade('W', 'TOK', 'SELL', 500, 7200, 500n),
      trade('W', 'TOK', 'SELL', 450, 3600, 900n) // an hour apart
    ];
    expect(run(trades).receipts.find((x) => x.classification === 'single_burst_exit')).toBeUndefined();
  });

  it('distribution_into_later_buyers: seller transfer -> receiver buys same token within 1h', () => {
    const trades = [
      trade('SELLER', 'TOK', 'SELL', 900, 3000, 100n),
      trade('RCV', 'TOK', 'BUY', 200, 1800, 200n) // buys 30 min after the transfer below
    ];
    const transfers = [transfer('SELLER', 'RCV', 500, 2400)];
    const r = run(trades, transfers);
    const dist = r.receipts.find((x) => x.classification === 'distribution_into_later_buyers');
    expect(dist).toBeDefined();
    expect(dist!.wallets).toEqual(['SELLER', 'RCV']);
    expect(dist!.evidenceTxs.length).toBe(3); // transfer + sell + buy
  });

  it('side-wallet link tiers escalate with co-entries, and NEVER promote', () => {
    const mk = (coTokens: number) => {
      const trades: ReceiptTradeInput[] = [];
      for (let i = 0; i < coTokens; i++) {
        trades.push(trade('MAIN', `CO${i}`, 'BUY', 100, 7200 + i * 1000, BigInt(100 + i)));
        trades.push(trade('SIDE', `CO${i}`, 'BUY', 100, 7195 + i * 1000, BigInt(100 + i))); // 5s apart
      }
      return run(trades, [transfer('MAIN', 'SIDE', 1000, 90000)]);
    };
    expect(mk(1).receipts.find((x) => x.classification === 'possible_side_wallet')).toBeDefined();
    expect(mk(2).receipts.find((x) => x.classification === 'probable_side_wallet')).toBeDefined();
    const strong = mk(3).receipts.find((x) => x.classification === 'strong_onchain_link');
    expect(strong).toBeDefined();
    expect(strong!.caveats.join(' ')).toMatch(/NEVER inherit any status/i);
  });

  it('repeated_coordinated_crew: the same >=3 wallet set co-entering >=3 tokens', () => {
    const trades: ReceiptTradeInput[] = [];
    for (let i = 0; i < 3; i++) {
      trades.push(trade('X1', `CR${i}`, 'BUY', 100, 9000 + i * 1000, BigInt(10 + i)));
      trades.push(trade('X2', `CR${i}`, 'BUY', 100, 8995 + i * 1000, BigInt(10 + i)));
      trades.push(trade('X3', `CR${i}`, 'BUY', 100, 8990 + i * 1000, BigInt(10 + i)));
    }
    const r = run(trades);
    const crew = r.receipts.find((x) => x.classification === 'repeated_coordinated_crew');
    expect(crew).toBeDefined();
    expect(crew!.wallets.sort()).toEqual(['X1', 'X2', 'X3']);
    expect(crew!.independentTokenRepetition).toBe(3);
  });

  it('launch_team_linked_destructive_exit: cluster member + funding link + burst exit on the launch token', () => {
    const trades = [
      trade('T1', 'PUMP', 'BUY', 100, 86400, 100n),
      trade('T2', 'PUMP', 'BUY', 100, 86395, 101n),
      trade('T3', 'PUMP', 'BUY', 1000, 86390, 102n),
      trade('T3', 'PUMP', 'SELL', 950, 3600, 9000n),
      trade('T3', 'PUMP', 'SELL', 40, 3595, 9001n)
    ];
    const transfers = [transfer('T1', 'T3', 500, 90000)]; // cluster mate funded T3
    const r = run(trades, transfers);
    const destructive = r.receipts.find((x) => x.classification === 'launch_team_linked_destructive_exit');
    expect(destructive).toBeDefined();
    expect(destructive!.wallets).toEqual(['T3']);
  });

  it('repeat low-mcap early buyer is independent_sharp_trader when NO coordination links exist', () => {
    const trades = [
      trade('SOLO', 'A1', 'BUY', 100, 9000, 10n, 50_000),
      trade('SOLO', 'A2', 'BUY', 100, 8000, 20n, 80_000),
      trade('SOLO', 'A3', 'BUY', 100, 7000, 30n, 120_000)
    ];
    const r = run(trades);
    expect(r.receipts.find((x) => x.classification === 'independent_sharp_trader')).toBeDefined();
    expect(r.receipts.find((x) => x.classification === 'repeat_low_mcap_early_buyer')).toBeUndefined();
  });

  it('bot_or_arbitrage: near-constant cadence, with the DCA caveat', () => {
    const trades: ReceiptTradeInput[] = [];
    for (let i = 0; i < 25; i++) trades.push(trade('BOT', `B${i % 3}`, i % 2 ? 'BUY' : 'SELL', 50, 90000 - i * 120, BigInt(i), 100_000));
    const r = run(trades);
    const bot = r.receipts.find((x) => x.classification === 'bot_or_arbitrage');
    expect(bot).toBeDefined();
    expect(bot!.caveats.join(' ')).toMatch(/not proof/i);
  });

  it('high_rug_exposure fires ONLY with outcome data', () => {
    const trades = [
      trade('V', 'R1', 'BUY', 100, 9000, 1n),
      trade('V', 'R2', 'BUY', 100, 8000, 2n),
      trade('V', 'R3', 'BUY', 100, 7000, 3n)
    ];
    expect(run(trades).receipts.find((x) => x.classification === 'high_rug_exposure')).toBeUndefined();
    const withOutcomes = run(trades, [], { tokenOutcomes: { R1: 'rug', R2: 'rug', R3: 'flat' } });
    const rug = withOutcomes.receipts.find((x) => x.classification === 'high_rug_exposure');
    expect(rug).toBeDefined();
    expect(rug!.componentMetrics.rugSharePct).toBe(67);
  });
});
