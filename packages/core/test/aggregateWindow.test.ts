import { describe, expect, it } from 'vitest';
import { aggregateWindow } from '../src/window/aggregate';
import type {
  ClusterMembershipInput,
  MarketPointInput,
  TradeRowInput,
  WalletInfoInput
} from '../src/window/aggregate';

// FlowRadar — aggregateWindow tests (Task 15).
//
// Fixture convention: a fixed `NOW` anchor with trades/market points placed
// at exact minute offsets from a `WINDOW_START` so every expected number
// (volumes, ratios, counts) is hand-computed in each test's comment rather
// than re-derived from the implementation.

const WINDOW_START = new Date('2026-07-05T00:00:00.000Z');
const min = (n: number) => new Date(WINDOW_START.getTime() + n * 60_000);

function wallet(walletId: string, overrides: Partial<WalletInfoInput> = {}): WalletInfoInput {
  return {
    walletId,
    isWatched: false,
    walletScore: 50,
    labels: [],
    meetsProfitable: false,
    // Pre-taxonomy tests exercise watched/profitable semantics WITHIN the
    // eligible cohort; the status gate has its own suite (aggregateStatusGate).
    status: 'signal_eligible',
    ...overrides
  };
}

function trade(
  walletId: string,
  action: 'BUY' | 'SELL',
  ts: Date,
  amountUsd: number,
  overrides: Partial<TradeRowInput> = {}
): TradeRowInput {
  return {
    walletId,
    action,
    amountUsd,
    ts,
    blockOrSlot: BigInt(Math.floor(ts.getTime() / 1000)),
    marketCapAtTrade: null,
    ...overrides
  };
}

describe('aggregateWindow', () => {
  describe('basic shape / anchoring', () => {
    it('anchors `to` to now when now <= latest trade ts (a trade exists AT/AFTER now — the live case), from = to - windowMinutes', () => {
      const now = min(20);
      // Latest trade is AT `now` itself (>= now), so `to` = min(now, latestTradeTs) = now.
      const trades: TradeRowInput[] = [trade('w1', 'BUY', min(5), 100), trade('w1', 'BUY', min(20), 50)];
      const result = aggregateWindow({
        trades,
        wallets: [wallet('w1')],
        clusters: [],
        market: [],
        windowMinutes: 30,
        now
      });

      expect(result.to.getTime()).toBe(now.getTime());
      expect(result.from.getTime()).toBe(now.getTime() - 30 * 60_000);
    });

    it('anchors `to` to the LATEST trade ts when now is far in the future (bounded mock histories stay scoreable)', () => {
      const now = new Date(WINDOW_START.getTime() + 1000 * 60 * 60 * 24 * 365); // 1 year later
      const latestTradeTs = min(20);
      const trades: TradeRowInput[] = [
        trade('w1', 'BUY', min(5), 100),
        trade('w1', 'BUY', latestTradeTs, 200)
      ];
      const result = aggregateWindow({
        trades,
        wallets: [wallet('w1')],
        clusters: [],
        market: [],
        windowMinutes: 30,
        now
      });

      expect(result.to.getTime()).toBe(latestTradeTs.getTime());
      expect(result.from.getTime()).toBe(latestTradeTs.getTime() - 30 * 60_000);
    });

    it('carries tokenId and windowMinutes through verbatim', () => {
      const result = aggregateWindow({
        trades: [],
        wallets: [],
        clusters: [],
        market: [],
        windowMinutes: 1440,
        now: min(0)
      });
      // tokenId isn't an input field per the binding decision's input shape —
      // confirm the aggregate always has SOME tokenId (caller sets it) is out
      // of scope here; this test only pins windowMinutes passthrough.
      expect(result.windowMinutes).toBe(1440);
    });
  });

  describe('buyers[] construction', () => {
    it('includes only wallets with >=1 BUY inside [from, to]; a SELL-only wallet is excluded from buyers', () => {
      const now = min(30);
      const trades: TradeRowInput[] = [
        trade('buyer-1', 'BUY', min(10), 500),
        trade('seller-only', 'SELL', min(12), 300)
      ];
      const result = aggregateWindow({
        trades,
        wallets: [wallet('buyer-1'), wallet('seller-only')],
        clusters: [],
        market: [],
        windowMinutes: 30,
        now
      });

      const walletIds = result.buyers.map((b) => b.walletId);
      expect(walletIds).toEqual(['buyer-1']);
    });

    it('buyUsd/sellUsd are the SUM of in-window BUY/SELL trades for that wallet', () => {
      const now = min(30);
      const trades: TradeRowInput[] = [
        trade('w1', 'BUY', min(2), 100),
        trade('w1', 'BUY', min(5), 250),
        trade('w1', 'SELL', min(8), 60),
        trade('w1', 'SELL', min(9), 40)
      ];
      const result = aggregateWindow({
        trades,
        wallets: [wallet('w1')],
        clusters: [],
        market: [],
        windowMinutes: 30,
        now
      });

      const w1 = result.buyers.find((b) => b.walletId === 'w1')!;
      expect(w1.buyUsd).toBe(350);
      expect(w1.sellUsd).toBe(100);
    });

    it('firstBuyTs is the EARLIEST buy IN WINDOW, and blockOrSlot is that buy\'s own blockOrSlot', () => {
      const now = min(30);
      const trades: TradeRowInput[] = [
        trade('w1', 'BUY', min(15), 100, { blockOrSlot: 999n }),
        trade('w1', 'BUY', min(5), 50, { blockOrSlot: 111n }) // earlier in window
      ];
      const result = aggregateWindow({
        trades,
        wallets: [wallet('w1')],
        clusters: [],
        market: [],
        windowMinutes: 30,
        now
      });

      const w1 = result.buyers.find((b) => b.walletId === 'w1')!;
      expect(w1.firstBuyTs.getTime()).toBe(min(5).getTime());
      expect(w1.blockOrSlot).toBe(111n);
    });

    it('a buy OUTSIDE the window (before `from`) does not count toward firstBuyTs / buyUsd', () => {
      const now = min(30); // from = min(0) — anchor trade at exactly `now` keeps `to` pinned to `now` itself
      const trades: TradeRowInput[] = [
        trade('w1', 'BUY', min(-5), 1000), // before window
        trade('w1', 'BUY', min(10), 200), // in window
        trade('anchor', 'BUY', min(30), 1) // pins latestTradeTs === now, so to = min(now, now) = now
      ];
      const result = aggregateWindow({
        trades,
        wallets: [wallet('w1'), wallet('anchor')],
        clusters: [],
        market: [],
        windowMinutes: 30,
        now
      });

      const w1 = result.buyers.find((b) => b.walletId === 'w1')!;
      expect(w1.buyUsd).toBe(200);
      expect(w1.firstBuyTs.getTime()).toBe(min(10).getTime());
    });

    it('carries walletScore/labels/isWatched/entityClusterId from the wallets/clusters inputs', () => {
      const now = min(30);
      const trades: TradeRowInput[] = [trade('w1', 'BUY', min(5), 100)];
      const clusters: ClusterMembershipInput[] = [{ walletId: 'w1', clusterId: 'cluster-A' }];
      const result = aggregateWindow({
        trades,
        wallets: [wallet('w1', { isWatched: true, walletScore: 77, labels: ['smart_money'] })],
        clusters,
        market: [],
        windowMinutes: 30,
        now
      });

      const w1 = result.buyers.find((b) => b.walletId === 'w1')!;
      expect(w1.isWatched).toBe(true);
      expect(w1.walletScore).toBe(77);
      expect(w1.labels).toEqual(['smart_money']);
      expect(w1.entityClusterId).toBe('cluster-A');
    });

    it('a buyer with no cluster membership has entityClusterId undefined', () => {
      const now = min(30);
      const trades: TradeRowInput[] = [trade('w1', 'BUY', min(5), 100)];
      const result = aggregateWindow({
        trades,
        wallets: [wallet('w1')],
        clusters: [],
        market: [],
        windowMinutes: 30,
        now
      });

      expect(result.buyers[0]!.entityClusterId).toBeUndefined();
    });
  });

  describe('smartWalletCount / humanLikeCount / possibleBotCount', () => {
    it('smartWalletCount = buyers where isWatched OR meetsProfitable (union, not intersection)', () => {
      const now = min(30);
      const trades: TradeRowInput[] = [
        trade('watched-not-profitable', 'BUY', min(1), 100),
        trade('profitable-not-watched', 'BUY', min(2), 100),
        trade('both', 'BUY', min(3), 100),
        trade('neither', 'BUY', min(4), 100)
      ];
      const wallets: WalletInfoInput[] = [
        wallet('watched-not-profitable', { isWatched: true, meetsProfitable: false }),
        wallet('profitable-not-watched', { isWatched: false, meetsProfitable: true }),
        wallet('both', { isWatched: true, meetsProfitable: true }),
        wallet('neither', { isWatched: false, meetsProfitable: false })
      ];
      const result = aggregateWindow({ trades, wallets, clusters: [], market: [], windowMinutes: 30, now });

      expect(result.smartWalletCount).toBe(3);
    });

    it('humanLikeCount / possibleBotCount count buyers by label membership', () => {
      const now = min(30);
      const trades: TradeRowInput[] = [
        trade('human-1', 'BUY', min(1), 100),
        trade('human-2', 'BUY', min(2), 100),
        trade('bot-1', 'BUY', min(3), 100),
        trade('other', 'BUY', min(4), 100)
      ];
      const wallets: WalletInfoInput[] = [
        wallet('human-1', { labels: ['human_like'] }),
        wallet('human-2', { labels: ['human_like', 'smart_money'] }),
        wallet('bot-1', { labels: ['possible_bot'] }),
        wallet('other', { labels: ['unknown'] })
      ];
      const result = aggregateWindow({ trades, wallets, clusters: [], market: [], windowMinutes: 30, now });

      expect(result.humanLikeCount).toBe(2);
      expect(result.possibleBotCount).toBe(1);
    });

    it('humanOrSmartLabelCount is the UNION of human_like and smart_money label membership (Task 15 Fix A) — distinct from humanLikeCount', () => {
      const now = min(30);
      const trades: TradeRowInput[] = [
        trade('human-only', 'BUY', min(1), 100),
        trade('smart-only', 'BUY', min(2), 100), // smart_money but NOT human_like — must still count
        trade('both-labels', 'BUY', min(3), 100),
        trade('bot', 'BUY', min(4), 100),
        trade('unlabeled', 'BUY', min(5), 100)
      ];
      const wallets: WalletInfoInput[] = [
        wallet('human-only', { labels: ['human_like'] }),
        wallet('smart-only', { labels: ['smart_money'] }),
        wallet('both-labels', { labels: ['human_like', 'smart_money'] }),
        wallet('bot', { labels: ['possible_bot'] }),
        wallet('unlabeled', { labels: ['unknown'] })
      ];
      const result = aggregateWindow({ trades, wallets, clusters: [], market: [], windowMinutes: 30, now });

      // humanLikeCount only sees the 2 buyers carrying 'human_like'.
      expect(result.humanLikeCount).toBe(2);
      // humanOrSmartLabelCount is the union: human-only + smart-only + both-labels = 3.
      expect(result.humanOrSmartLabelCount).toBe(3);
    });

    it('humanOrSmartLabelCount is 0 for an empty buyer set (no div-by-zero downstream in ruleC)', () => {
      const result = aggregateWindow({
        trades: [],
        wallets: [],
        clusters: [],
        market: [],
        windowMinutes: 30,
        now: min(0)
      });

      expect(result.humanOrSmartLabelCount).toBe(0);
    });
  });

  describe('whaleBuys', () => {
    it('groups single BUY trades >= $10k per wallet, using the MAX single buy', () => {
      const now = min(30);
      const trades: TradeRowInput[] = [
        trade('whale-1', 'BUY', min(1), 12_000),
        trade('whale-1', 'BUY', min(2), 15_000), // max for whale-1
        trade('whale-1', 'BUY', min(3), 3_000), // below $10k, ignored on its own but doesn't reduce the max
        trade('not-whale', 'BUY', min(4), 9_999) // below threshold entirely
      ];
      const result = aggregateWindow({
        trades,
        wallets: [wallet('whale-1'), wallet('not-whale')],
        clusters: [],
        market: [],
        windowMinutes: 30,
        now
      });

      expect(result.whaleBuys).toEqual([{ walletId: 'whale-1', usd: 15_000 }]);
    });

    it('a wallet with no single buy >= $10k produces no whaleBuys entry even if cumulative buyUsd is high', () => {
      const now = min(30);
      const trades: TradeRowInput[] = [
        trade('w1', 'BUY', min(1), 6000),
        trade('w1', 'BUY', min(2), 6000) // cumulative 12k but no SINGLE buy >= 10k
      ];
      const result = aggregateWindow({
        trades,
        wallets: [wallet('w1')],
        clusters: [],
        market: [],
        windowMinutes: 30,
        now
      });

      expect(result.whaleBuys).toEqual([]);
    });
  });

  describe('uniqueEntityCount / largestClusterSize', () => {
    it('with no clusters at all, uniqueEntityCount equals smartWalletCount and largestClusterSize is 0', () => {
      const now = min(30);
      const trades: TradeRowInput[] = [
        trade('smart-1', 'BUY', min(1), 100),
        trade('smart-2', 'BUY', min(2), 100),
        trade('not-smart', 'BUY', min(3), 100)
      ];
      const wallets: WalletInfoInput[] = [
        wallet('smart-1', { isWatched: true }),
        wallet('smart-2', { meetsProfitable: true }),
        wallet('not-smart')
      ];
      const result = aggregateWindow({ trades, wallets, clusters: [], market: [], windowMinutes: 30, now });

      expect(result.smartWalletCount).toBe(2);
      expect(result.uniqueEntityCount).toBe(2);
      expect(result.largestClusterSize).toBe(0);
    });

    it('distinct clusterIds + unclustered smart buyers, largestClusterSize = biggest cluster among smart buyers', () => {
      const now = min(30);
      const trades: TradeRowInput[] = [
        trade('smart-a1', 'BUY', min(1), 100),
        trade('smart-a2', 'BUY', min(2), 100),
        trade('smart-a3', 'BUY', min(3), 100),
        trade('smart-b1', 'BUY', min(4), 100),
        trade('smart-unclustered', 'BUY', min(5), 100)
      ];
      const wallets: WalletInfoInput[] = [
        wallet('smart-a1', { isWatched: true }),
        wallet('smart-a2', { isWatched: true }),
        wallet('smart-a3', { isWatched: true }),
        wallet('smart-b1', { isWatched: true }),
        wallet('smart-unclustered', { isWatched: true })
      ];
      const clusters: ClusterMembershipInput[] = [
        { walletId: 'smart-a1', clusterId: 'cluster-A' },
        { walletId: 'smart-a2', clusterId: 'cluster-A' },
        { walletId: 'smart-a3', clusterId: 'cluster-A' },
        { walletId: 'smart-b1', clusterId: 'cluster-B' }
      ];
      const result = aggregateWindow({ trades, wallets, clusters, market: [], windowMinutes: 30, now });

      // 2 clusters (A, B) + 1 unclustered smart buyer = 3 unique entities
      expect(result.uniqueEntityCount).toBe(3);
      expect(result.largestClusterSize).toBe(3); // cluster-A has 3 members
    });
  });

  describe('volumes / netFlow / buySellRatio', () => {
    it('trackedBuyVolumeUsd/trackedSellVolumeUsd sum ALL tracked wallets\' in-window BUY/SELL, netFlow = buy - sell', () => {
      const now = min(30);
      const trades: TradeRowInput[] = [
        trade('w1', 'BUY', min(1), 1000),
        trade('w2', 'BUY', min(2), 500),
        trade('w1', 'SELL', min(3), 200),
        trade('w3', 'SELL', min(4), 100) // sell-only wallet still counted in sell volume
      ];
      const result = aggregateWindow({
        trades,
        wallets: [wallet('w1'), wallet('w2'), wallet('w3')],
        clusters: [],
        market: [],
        windowMinutes: 30,
        now
      });

      expect(result.trackedBuyVolumeUsd).toBe(1500);
      expect(result.trackedSellVolumeUsd).toBe(300);
      expect(result.netFlowUsd).toBe(1200);
    });

    it('buySellRatio = buyVol / sellVol when sellVol > 0', () => {
      const now = min(30);
      const trades: TradeRowInput[] = [trade('w1', 'BUY', min(1), 900), trade('w1', 'SELL', min(2), 300)];
      const result = aggregateWindow({
        trades,
        wallets: [wallet('w1')],
        clusters: [],
        market: [],
        windowMinutes: 30,
        now
      });

      expect(result.buySellRatio).toBe(3);
    });

    it('buySellRatio is a large sentinel (999) when sellVol is 0 and buyVol > 0', () => {
      const now = min(30);
      const trades: TradeRowInput[] = [trade('w1', 'BUY', min(1), 900)];
      const result = aggregateWindow({
        trades,
        wallets: [wallet('w1')],
        clusters: [],
        market: [],
        windowMinutes: 30,
        now
      });

      expect(result.buySellRatio).toBe(999);
    });

    it('buySellRatio is 0 when both buyVol and sellVol are 0', () => {
      const result = aggregateWindow({
        trades: [],
        wallets: [],
        clusters: [],
        market: [],
        windowMinutes: 30,
        now: min(30)
      });

      expect(result.buySellRatio).toBe(0);
    });
  });

  describe('avgEntryMcap / currentMcap / mcapExpansionFromAvgEntry', () => {
    it('avgEntryMcap is the buy-USD-weighted mean of marketCapAtTrade over buyers\' window buys', () => {
      const now = min(30);
      // w1: two buys, $100 @ mcap 100k, $300 @ mcap 300k -> weighted avg = (100*100k + 300*300k)/400 = 250,000
      const trades: TradeRowInput[] = [
        trade('w1', 'BUY', min(1), 100, { marketCapAtTrade: 100_000 }),
        trade('w1', 'BUY', min(2), 300, { marketCapAtTrade: 300_000 })
      ];
      const result = aggregateWindow({
        trades,
        wallets: [wallet('w1')],
        clusters: [],
        market: [],
        windowMinutes: 30,
        now
      });

      expect(result.avgEntryMcap).toBe(250_000);
    });

    it('null marketCapAtTrade rows are skipped from the weighted average (not treated as 0)', () => {
      const now = min(30);
      const trades: TradeRowInput[] = [
        trade('w1', 'BUY', min(1), 100, { marketCapAtTrade: 200_000 }),
        trade('w1', 'BUY', min(2), 5000, { marketCapAtTrade: null }) // skipped entirely
      ];
      const result = aggregateWindow({
        trades,
        wallets: [wallet('w1')],
        clusters: [],
        market: [],
        windowMinutes: 30,
        now
      });

      expect(result.avgEntryMcap).toBe(200_000);
    });

    it('all-null marketCapAtTrade -> avgEntryMcap is null', () => {
      const now = min(30);
      const trades: TradeRowInput[] = [trade('w1', 'BUY', min(1), 100, { marketCapAtTrade: null })];
      const result = aggregateWindow({
        trades,
        wallets: [wallet('w1')],
        clusters: [],
        market: [],
        windowMinutes: 30,
        now
      });

      expect(result.avgEntryMcap).toBeNull();
    });

    it('currentMcap is the latest market point at or before `to`', () => {
      const now = min(30);
      const market: MarketPointInput[] = [
        { ts: min(10), marketCapUsd: 100_000, liquidityUsd: 10_000 },
        { ts: min(25), marketCapUsd: 150_000, liquidityUsd: 12_000 }, // latest <= to (min(30))
        { ts: min(40), marketCapUsd: 999_999, liquidityUsd: 99_999 } // AFTER `to` — must be ignored
      ];
      const result = aggregateWindow({
        trades: [],
        wallets: [],
        clusters: [],
        market,
        windowMinutes: 30,
        now
      });

      expect(result.currentMcap).toBe(150_000);
      expect(result.liquidityUsd).toBe(12_000);
    });

    it('mcapExpansionFromAvgEntry = currentMcap/avgEntryMcap - 1', () => {
      const now = min(30);
      const trades: TradeRowInput[] = [
        trade('w1', 'BUY', min(1), 100, { marketCapAtTrade: 100_000 }),
        trade('anchor', 'BUY', min(30), 1) // pins to = now so the min(20) market point stays <= to
      ];
      const market: MarketPointInput[] = [{ ts: min(20), marketCapUsd: 250_000, liquidityUsd: 5000 }];
      const result = aggregateWindow({
        trades,
        wallets: [wallet('w1'), wallet('anchor')],
        clusters: [],
        market,
        windowMinutes: 30,
        now
      });

      expect(result.mcapExpansionFromAvgEntry).toBeCloseTo(1.5, 6); // 250k/100k - 1 = 1.5
    });

    it('mcapExpansionFromAvgEntry is null when either mcap input is null', () => {
      const now = min(30);
      const result = aggregateWindow({
        trades: [],
        wallets: [],
        clusters: [],
        market: [],
        windowMinutes: 30,
        now
      });

      expect(result.mcapExpansionFromAvgEntry).toBeNull();
    });
  });

  describe('liquidityChangePct', () => {
    it('= (latest - at-window-start)/at-window-start * 100', () => {
      const now = min(30); // from = min(0)
      const market: MarketPointInput[] = [
        { ts: min(0), marketCapUsd: 100_000, liquidityUsd: 20_000 }, // at/near window start
        { ts: min(30), marketCapUsd: 120_000, liquidityUsd: 25_000 } // latest <= to
      ];
      const result = aggregateWindow({
        trades: [],
        wallets: [],
        clusters: [],
        market,
        windowMinutes: 30,
        now
      });

      expect(result.liquidityChangePct).toBeCloseTo(25, 6); // (25000-20000)/20000*100 = 25%
    });

    it('is null when there is no market point at or before `from`', () => {
      const now = min(30);
      const market: MarketPointInput[] = [{ ts: min(20), marketCapUsd: 100_000, liquidityUsd: 20_000 }];
      const result = aggregateWindow({
        trades: [],
        wallets: [],
        clusters: [],
        market,
        windowMinutes: 30,
        now
      });

      expect(result.liquidityChangePct).toBeNull();
    });
  });

  describe('tokenAgeDays', () => {
    it('is derived from the earliest market point relative to `to`', () => {
      const now = min(30);
      const earliestTs = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000); // 5 days before `to`
      const market: MarketPointInput[] = [{ ts: earliestTs, marketCapUsd: 100, liquidityUsd: 100 }];
      const result = aggregateWindow({
        trades: [],
        wallets: [],
        clusters: [],
        market,
        windowMinutes: 30,
        now
      });

      expect(result.tokenAgeDays).toBeCloseTo(5, 1);
    });

    it('is null when there are no market points at all', () => {
      const result = aggregateWindow({
        trades: [],
        wallets: [],
        clusters: [],
        market: [],
        windowMinutes: 30,
        now: min(30)
      });

      expect(result.tokenAgeDays).toBeNull();
    });
  });

  describe('inflowSpike / trailingBuyVolumeUsd / windowBuyVolumeUsd', () => {
    it('fires when trackedBuyVolumeUsd >= inflowSpikeMult * trailingBuyVolumeUsd (default mult 3)', () => {
      const now = min(60); // window [30,60); trailing window [0,30)
      const trades: TradeRowInput[] = [
        trade('w1', 'BUY', min(10), 1000), // in trailing window
        trade('w2', 'BUY', min(45), 3000) // in current window: 3000 >= 3*1000
      ];
      const result = aggregateWindow({
        trades,
        wallets: [wallet('w1'), wallet('w2')],
        clusters: [],
        market: [],
        windowMinutes: 30,
        now
      });

      expect(result.trailingBuyVolumeUsd).toBe(1000);
      expect(result.windowBuyVolumeUsd).toBe(3000);
      expect(result.inflowSpike).toBe(true);
    });

    it('does not fire when window volume is below the multiplier threshold', () => {
      const now = min(60);
      const trades: TradeRowInput[] = [
        trade('w1', 'BUY', min(10), 1000), // trailing
        trade('w2', 'BUY', min(45), 2999) // just below 3x
      ];
      const result = aggregateWindow({
        trades,
        wallets: [wallet('w1'), wallet('w2')],
        clusters: [],
        market: [],
        windowMinutes: 30,
        now
      });

      expect(result.inflowSpike).toBe(false);
    });

    it('never fires when trailingBuyVolumeUsd is 0 (guards div-by-zero / trivial spike)', () => {
      const now = min(60);
      const trades: TradeRowInput[] = [trade('w2', 'BUY', min(45), 5000)]; // no trailing volume at all
      const result = aggregateWindow({
        trades,
        wallets: [wallet('w2')],
        clusters: [],
        market: [],
        windowMinutes: 30,
        now
      });

      expect(result.trailingBuyVolumeUsd).toBe(0);
      expect(result.inflowSpike).toBe(false);
    });

    it('respects a custom inflowSpikeMult param', () => {
      const now = min(60);
      const trades: TradeRowInput[] = [
        trade('w1', 'BUY', min(10), 1000), // trailing
        trade('w2', 'BUY', min(45), 2000) // 2x trailing
      ];
      const result = aggregateWindow({
        trades,
        wallets: [wallet('w1'), wallet('w2')],
        clusters: [],
        market: [],
        windowMinutes: 30,
        now,
        inflowSpikeMult: 2
      });

      expect(result.inflowSpike).toBe(true);
    });
  });

  describe('exitedSmartPct / topHolderExits (Task 15 Fix B — holder-based, not window-buyer-based)', () => {
    it('exitedSmartPct = % of SMART holders-at-window-start whose IN-WINDOW sells reach >= 80% of their PRE-WINDOW net position', () => {
      const now = min(60); // window [30, 60]
      const trades: TradeRowInput[] = [
        // smart-exited: bought $1000 BEFORE the window (pre-window position), sold 85% of it INSIDE the window.
        trade('smart-exited', 'BUY', min(1), 1000),
        trade('smart-exited', 'SELL', min(45), 850), // 85% of pre-window position >= 80%
        // smart-held: bought $1000 before the window, sold only 10% inside the window.
        trade('smart-held', 'BUY', min(2), 1000),
        trade('smart-held', 'SELL', min(46), 100),
        // smart-no-sell: pre-window position, no in-window activity at all.
        trade('smart-no-sell', 'BUY', min(3), 1000),
        // not-smart: same shape as smart-exited but NOT smart -> excluded from the denominator.
        trade('not-smart', 'BUY', min(4), 1000),
        trade('not-smart', 'SELL', min(47), 1000)
      ];
      const wallets: WalletInfoInput[] = [
        wallet('smart-exited', { isWatched: true }),
        wallet('smart-held', { isWatched: true }),
        wallet('smart-no-sell', { isWatched: true }),
        wallet('not-smart')
      ];
      const result = aggregateWindow({ trades, wallets, clusters: [], market: [], windowMinutes: 30, now });

      // 1 of 3 smart holders-at-window-start exited (>=80% sold) = 33.33%
      expect(result.exitedSmartPct).toBeCloseTo(33.333, 2);
    });

    it('exitedSmartPct UNIONS in smart buyers with NO pre-window position who buy-and-dump >= 80% WITHIN the same window (documented union addition)', () => {
      const now = min(60); // window [30, 60]
      const trades: TradeRowInput[] = [
        // smart-holder-exited: pre-window position, exits in-window (holder-based population).
        trade('smart-holder-exited', 'BUY', min(1), 1000),
        trade('smart-holder-exited', 'SELL', min(45), 900),
        // smart-window-only-exited: FIRST EVER trade is inside the window — zero pre-window
        // position, so it can never be a "holder-at-window-start" — buys then dumps >= 80%
        // entirely within the window. Must still count via the union addition.
        trade('smart-window-only-exited', 'BUY', min(31), 500),
        trade('smart-window-only-exited', 'SELL', min(50), 450), // 90% of the SAME window's buy
        // smart-window-only-held: also no pre-window position, buys in-window, does not dump.
        trade('smart-window-only-held', 'BUY', min(32), 500)
      ];
      const wallets: WalletInfoInput[] = [
        wallet('smart-holder-exited', { isWatched: true }),
        wallet('smart-window-only-exited', { isWatched: true }),
        wallet('smart-window-only-held', { isWatched: true })
      ];
      const result = aggregateWindow({ trades, wallets, clusters: [], market: [], windowMinutes: 30, now });

      // Denominator = 1 holder (smart-holder-exited) + 2 window-only smart buyers = 3.
      // Numerator = smart-holder-exited (holder-based) + smart-window-only-exited (union) = 2.
      expect(result.exitedSmartPct).toBeCloseTo((2 / 3) * 100, 5);
    });

    it('exitedSmartPct is 0 when there are no smart holders or smart window-only buyers (no div-by-zero)', () => {
      const now = min(30);
      const trades: TradeRowInput[] = [trade('not-smart', 'BUY', min(1), 100)];
      const result = aggregateWindow({
        trades,
        wallets: [wallet('not-smart')],
        clusters: [],
        market: [],
        windowMinutes: 30,
        now
      });

      expect(result.exitedSmartPct).toBe(0);
    });

    it('topHolderExits counts, among the top-5 PRE-WINDOW holders by pre-window net USD position, how many sold >= 80% of that position in-window', () => {
      const now = min(60); // window [30, 60]
      // 6 wallets accumulate a pre-window position (all BUYs before `from`=30), only top 5 by
      // that pre-window net position are considered; in-window SELLs determine the exit.
      const trades: TradeRowInput[] = [
        trade('top1', 'BUY', min(1), 5000),
        trade('top1', 'SELL', min(45), 4500), // 90% of pre-window position -> exit
        trade('top2', 'BUY', min(2), 4000),
        trade('top2', 'SELL', min(46), 3600), // 90% -> exit
        trade('top3', 'BUY', min(3), 3000), // no in-window sell
        trade('top4', 'BUY', min(4), 2000), // no in-window sell
        trade('top5', 'BUY', min(5), 1000), // no in-window sell
        trade('top6-smallest', 'BUY', min(6), 100),
        trade('top6-smallest', 'SELL', min(47), 100) // 100% exit, but rank 6 by pre-window position -> NOT counted
      ];
      const wallets: WalletInfoInput[] = [
        wallet('top1'),
        wallet('top2'),
        wallet('top3'),
        wallet('top4'),
        wallet('top5'),
        wallet('top6-smallest')
      ];
      const result = aggregateWindow({ trades, wallets, clusters: [], market: [], windowMinutes: 30, now });

      expect(result.topHolderExits).toBe(2);
    });

    it('topHolderExits is 0 when nobody holds a pre-window position (buys inside the window don\'t count as "holders")', () => {
      const now = min(30);
      const trades: TradeRowInput[] = [
        trade('window-only', 'BUY', min(1), 5000),
        trade('window-only', 'SELL', min(20), 4900) // 98% exit, but zero PRE-window position -> not a holder
      ];
      const result = aggregateWindow({
        trades,
        wallets: [wallet('window-only')],
        clusters: [],
        market: [],
        windowMinutes: 30,
        now
      });

      expect(result.topHolderExits).toBe(0);
    });

    it('DUMP-shaped fixture: buys long before the window, >=40% of smart holders sell >= 80% inside the window -> exitedSmartPct >= 40 (regression for the exact bug Fix B closes)', () => {
      // Mirrors $DUMP's real shape (packages/providers/src/mock/scenarios.ts
      // buildDump): 20 smart holders accumulate ~60h before a 24h window that
      // is anchored at the later sell burst; 10 of them (50%) dump >= 80% of
      // their pre-window position inside that window. Under the OLD
      // window-buyer-based definition this was structurally unmeasurable
      // (zero window buyers, since every BUY sits before `from`) — this
      // fixture pins that the NEW holder-based definition fixes it.
      const now = new Date(WINDOW_START.getTime() + 70 * 60 * 60 * 1000); // hour 70, window = [46, 70]
      const preWindowBuyHour = 5; // hour 5 -- ~41h before `from` (hour 46), comfortably pre-window
      const inWindowSellHour = 66; // hour 66 -- inside [46, 70]
      const trades: TradeRowInput[] = [];
      const wallets: WalletInfoInput[] = [];
      for (let i = 0; i < 20; i++) {
        const walletId = `dump-holder-${i}`;
        wallets.push(wallet(walletId, { isWatched: true }));
        trades.push(
          trade(walletId, 'BUY', new Date(WINDOW_START.getTime() + preWindowBuyHour * 60 * 60 * 1000), 1000)
        );
        if (i < 10) {
          // 10 of 20 (50%) dump 85% of their pre-window position inside the window.
          trades.push(
            trade(walletId, 'SELL', new Date(WINDOW_START.getTime() + inWindowSellHour * 60 * 60 * 1000), 850)
          );
        }
      }

      const result = aggregateWindow({ trades, wallets, clusters: [], market: [], windowMinutes: 1440, now });

      expect(result.exitedSmartPct).toBeGreaterThanOrEqual(40);
      expect(result.exitedSmartPct).toBeCloseTo(50, 5);
    });

    it('newSmartBuyers counts smart buyers whose window firstBuyTs is also their first trade ever (in the full trades input)', () => {
      const now = min(60);
      const trades: TradeRowInput[] = [
        // brand-new smart buyer: only trade ever is inside the window
        trade('new-smart', 'BUY', min(45), 500),
        // smart buyer with a PRIOR trade outside the window (not new)
        trade('old-smart', 'BUY', min(5), 200), // prior, before window [30,60)
        trade('old-smart', 'BUY', min(50), 500),
        // not smart at all
        trade('new-not-smart', 'BUY', min(46), 500)
      ];
      const wallets: WalletInfoInput[] = [
        wallet('new-smart', { isWatched: true }),
        wallet('old-smart', { isWatched: true }),
        wallet('new-not-smart')
      ];
      const result = aggregateWindow({ trades, wallets, clusters: [], market: [], windowMinutes: 30, now });

      expect(result.newSmartBuyers).toBe(1);
    });
  });

  describe('earlyWindowBuyerCount', () => {
    it('counts buyers whose window firstBuyTs falls in [from, from + windowMinutes/2)', () => {
      const now = min(1440); // 24h window [0, 1440)
      const trades: TradeRowInput[] = [
        trade('early-1', 'BUY', min(10), 100), // well within first half [0,720)
        trade('early-2', 'BUY', min(719), 100), // just inside first half
        trade('late-1', 'BUY', min(720), 100), // exactly at half -> NOT early (exclusive upper bound)
        trade('late-2', 'BUY', min(1000), 100),
        trade('anchor', 'BUY', min(1440), 1) // pins to = now = min(1440), so from = min(0)
      ];
      const result = aggregateWindow({
        trades,
        wallets: [
          wallet('early-1'),
          wallet('early-2'),
          wallet('late-1'),
          wallet('late-2'),
          wallet('anchor')
        ],
        clusters: [],
        market: [],
        windowMinutes: 1440,
        now
      });

      expect(result.earlyWindowBuyerCount).toBe(2);
    });
  });

  describe('accumulation (multi-window metrics, 1440-min aggregate only)', () => {
    it('is present (defined) for a 1440-minute aggregate', () => {
      const result = aggregateWindow({
        trades: [],
        wallets: [],
        clusters: [],
        market: [],
        windowMinutes: 1440,
        now: min(1440)
      });

      expect(result.accumulation).toBeDefined();
    });

    it('is undefined for a 30-minute aggregate', () => {
      const result = aggregateWindow({
        trades: [],
        wallets: [],
        clusters: [],
        market: [],
        windowMinutes: 30,
        now: min(30)
      });

      expect(result.accumulation).toBeUndefined();
    });

    it('smartWalletCount30m/1h/6h count distinct buyers in the trailing N minutes ending at `to`', () => {
      const now = min(1440); // to = min(1440), pinned by the anchor trade AT now itself
      const trades: TradeRowInput[] = [
        trade('anchor', 'BUY', now, 1),
        trade('buyer-25m-ago', 'BUY', new Date(now.getTime() - 25 * 60_000), 100), // inside 30m, 1h, 6h
        trade('buyer-45m-ago', 'BUY', new Date(now.getTime() - 45 * 60_000), 100), // inside 1h, 6h only
        trade('buyer-3h-ago', 'BUY', new Date(now.getTime() - 3 * 60 * 60_000), 100), // inside 6h only
        trade('buyer-12h-ago', 'BUY', new Date(now.getTime() - 12 * 60 * 60_000), 100) // outside all three
      ];
      const wallets: WalletInfoInput[] = [
        wallet('anchor'),
        wallet('buyer-25m-ago'),
        wallet('buyer-45m-ago'),
        wallet('buyer-3h-ago'),
        wallet('buyer-12h-ago')
      ];
      const result = aggregateWindow({ trades, wallets, clusters: [], market: [], windowMinutes: 1440, now });

      // anchor itself is also within all three trailing windows (25m/45m/3h buyers plus anchor)
      expect(result.accumulation!.smartWalletCount30m).toBe(2); // anchor + buyer-25m-ago
      expect(result.accumulation!.smartWalletCount1h).toBe(3); // anchor + 25m + 45m
      expect(result.accumulation!.smartWalletCount6h).toBe(4); // anchor + 25m + 45m + 3h
    });

    it('percentWalletsSold = share of THIS WINDOW\'S buyers with sellUsd > 0', () => {
      const now = min(1440);
      const trades: TradeRowInput[] = [
        trade('sold-1', 'BUY', min(10), 100),
        trade('sold-1', 'SELL', min(20), 10),
        trade('sold-2', 'BUY', min(30), 100),
        trade('sold-2', 'SELL', min(40), 10),
        trade('held-1', 'BUY', min(50), 100),
        trade('held-2', 'BUY', min(60), 100)
      ];
      const wallets: WalletInfoInput[] = [
        wallet('sold-1'),
        wallet('sold-2'),
        wallet('held-1'),
        wallet('held-2')
      ];
      const result = aggregateWindow({ trades, wallets, clusters: [], market: [], windowMinutes: 1440, now });

      expect(result.accumulation!.percentWalletsSold).toBeCloseTo(50, 6); // 2 of 4 buyers sold
    });
  });

  describe('empty inputs', () => {
    it('produces a fully zeroed/null/empty aggregate with no throw', () => {
      expect(() =>
        aggregateWindow({
          trades: [],
          wallets: [],
          clusters: [],
          market: [],
          windowMinutes: 30,
          now: min(0)
        })
      ).not.toThrow();

      const result = aggregateWindow({
        trades: [],
        wallets: [],
        clusters: [],
        market: [],
        windowMinutes: 30,
        now: min(0)
      });

      expect(result.buyers).toEqual([]);
      expect(result.smartWalletCount).toBe(0);
      expect(result.whaleBuys).toEqual([]);
      expect(result.avgEntryMcap).toBeNull();
      expect(result.currentMcap).toBeNull();
      expect(result.exitedSmartPct).toBe(0);
      expect(result.topHolderExits).toBe(0);
      expect(result.newSmartBuyers).toBe(0);
    });
  });
});
