// FlowRadar — FIFO realized/unrealized PnL.
//
// Normative source: Task 13 brief + plan Shared Contracts.
//   computeFifoPnl(trades, currentPriceUsd) matches SELLs against BUY lots
//   in first-in-first-out order. Brief fixture (exact):
//     buy 10 @ $1 (lot cost $10) + buy 10 @ $2 (lot cost $20)
//     sell 15 @ $3 (proceeds $45)
//     -> consumes all 10 units of lot 1 ($10 cost) + 5 units of lot 2 ($10 cost)
//     -> realizedUsd = 45 - (10 + 10) = 45 - 20 = 25
//   Remaining inventory (5 units of the $2 lot) valued at currentPriceUsd for
//   unrealizedUsd; null price -> null unrealizedUsd (+ confidence penalty).
//
// A SELL is a "win" when its proceeds exceed the FIFO cost of the lots it
// consumed. Sells whose amountToken exceeds available inventory are matched
// against whatever inventory exists; the un-backed excess is ignored for
// realized-PnL purposes (not treated as a phantom gain/loss) but marks the
// trade sequence as having an over-sell, which reduces confidence.
//
// confidence (0-100) heuristic, starting at 90:
//   -20 if any sell over-sold its available inventory
//   -15 if currentPriceUsd is null
//   -10 if tradeCount < 4
//   floor 10 (never negative)

export interface FifoTradeRow {
  action: 'BUY' | 'SELL';
  amountToken: number;
  amountUsd: number;
  ts: Date;
}

export interface FifoPnlResult {
  realizedUsd: number;
  unrealizedUsd: number | null;
  winRate: number;
  tradeCount: number;
  confidence: number;
}

interface Lot {
  remainingToken: number;
  costUsd: number; // total cost of the ORIGINAL lot (used to derive per-unit cost)
  originalToken: number;
}

export function computeFifoPnl(trades: FifoTradeRow[], currentPriceUsd: number | null): FifoPnlResult {
  // FIFO match in chronological order regardless of input ordering.
  const ordered = [...trades].sort((a, b) => a.ts.getTime() - b.ts.getTime());

  const lots: Lot[] = [];
  let realizedUsd = 0;
  let sellCount = 0;
  let winCount = 0;
  let anyOverSell = false;

  for (const trade of ordered) {
    if (trade.action === 'BUY') {
      if (trade.amountToken > 0) {
        lots.push({ remainingToken: trade.amountToken, costUsd: trade.amountUsd, originalToken: trade.amountToken });
      }
      continue;
    }

    if (trade.action !== 'SELL') {
      // Non-BUY/SELL trade rows are out of scope for FIFO PnL (transfers,
      // LP ops) — the contract only accepts 'BUY' | 'SELL' rows, but guard
      // defensively rather than throwing on unexpected input.
      continue;
    }

    sellCount += 1;

    let unitsToSell = trade.amountToken;
    let costOfSoldUnits = 0;
    let unitsActuallySold = 0;

    while (unitsToSell > 0 && lots.length > 0) {
      const lot = lots[0];
      const perUnitCost = lot.costUsd / lot.originalToken;
      const consumed = Math.min(unitsToSell, lot.remainingToken);

      costOfSoldUnits += consumed * perUnitCost;
      unitsActuallySold += consumed;
      lot.remainingToken -= consumed;
      unitsToSell -= consumed;

      if (lot.remainingToken <= 0) {
        lots.shift();
      }
    }

    if (unitsToSell > 0) {
      // Sell exceeded available inventory — the un-backed excess is ignored
      // for realized PnL (proceeds are pro-rated to the units actually
      // backed by inventory), but flagged for the confidence penalty.
      anyOverSell = true;
    }

    // Pro-rate proceeds to only the units actually backed by inventory.
    const proceedsForSoldUnits =
      trade.amountToken > 0 ? (unitsActuallySold / trade.amountToken) * trade.amountUsd : 0;

    realizedUsd += proceedsForSoldUnits - costOfSoldUnits;
    if (unitsActuallySold > 0 && proceedsForSoldUnits > costOfSoldUnits) {
      winCount += 1;
    }
  }

  const remainingToken = lots.reduce((sum, lot) => sum + lot.remainingToken, 0);
  const remainingCostUsd = lots.reduce((sum, lot) => sum + lot.remainingToken * (lot.costUsd / lot.originalToken), 0);

  const unrealizedUsd =
    currentPriceUsd === null ? null : remainingToken * currentPriceUsd - remainingCostUsd;

  const tradeCount = ordered.length;
  const winRate = sellCount > 0 ? winCount / sellCount : 0;

  let confidence = 90;
  if (anyOverSell) confidence -= 20;
  if (currentPriceUsd === null) confidence -= 15;
  if (tradeCount < 4) confidence -= 10;
  confidence = Math.max(10, confidence);

  return { realizedUsd, unrealizedUsd, winRate, tradeCount, confidence };
}
