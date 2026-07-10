// FlowRadar — replaySignals: no-lookahead historical replay tests (Task 41
// binding decision 1; Task 41 REVIEW follow-up — Critical 1 + Critical 2).
// TDD RED-then-GREEN per task-41-brief.md / task-41-report.md.
//
// ---------------------------------------------------------------------------
// Critical 2 finding, traced (documented per the review's own escape hatch:
// "if you cannot construct [a trades-channel discriminator], report
// DONE_WITH_CONCERNS explaining precisely why the trades channel is
// structurally leak-free")
// ---------------------------------------------------------------------------
// The review's hypothesized trades-channel mechanism was: delete replay.ts's
// `trades.filter(ts <= T)` pre-filter, let a poison future SELL barrage widen
// aggregateWindow's own `to = min(now, latestTradeTs)` anchor FORWARD past T
// so the sells land inside the window and flip soldPct. Traced against
// window/aggregate.ts's actual anchoring line:
//   const to = latestTradeTs !== null && latestTradeTs < now.getTime()
//     ? new Date(latestTradeTs) : now;
// This is a MIN, not a max: `to` can only be pulled BACKWARD (earlier than
// `now`) when the latest trade is older than `now`; a future trade
// (ts > now) can never make `to` exceed `now`, because the ternary's
// only other branch is `now` itself. Since replay.ts always calls
// aggregateWindow with `now: T` (never a value derived from the trades
// array), `to` is therefore bounded by `<= T` UNCONDITIONALLY, regardless of
// whether replay.ts's own outer ts<=T pre-filter exists at all. Deleting that
// pre-filter and re-running the full suite (recorded in task-41-report.md)
// left every existing test GREEN — confirming this by construction, not
// merely by assertion.
//
// Every other place aggregateWindow scans the RAW (window-unfiltered)
// `trades` array is independently safe for the same reason or a stronger
// one: trailingBuyVolumeUsd and preWindowNetUsdByWallet are explicitly bounded
// `< from` (strictly the window's own start, itself <= T); the 1440m-only
// accumulation trailing counts are bounded `<= to` (<= T); and
// firstEverTsByWallet/newSmartBuyers is a MIN-seeking scan (earliest-ever
// trade per wallet) that a LATER poison trade can structurally never win,
// regardless of any bound. There is no code path in aggregateWindow through
// which a trade dated after `now` can influence any field it returns.
//
// CONCLUSION: the trades channel is structurally leak-free at the
// aggregateWindow layer, independent of replay.ts's own ts<=T pre-filter —
// that pre-filter is still correct defense-in-depth (and is exercised by
// fixture (a) below) but is not the sole guarantee for this channel the way
// it is for funding/rotation. The two side-channel tests below ((b) rule E,
// (b2) rule F) are therefore the tests that carry the actual guarantee this
// Critical-2 review item asked for — each is independently proven
// discriminating (deleting the corresponding replay.ts gate turns exactly
// that one test red; see task-41-report.md for the recorded output).
//
//   (a) rule-A trades-channel poisoned-future-trade — retained as a general
//       trades-channel regression check (real bug class if aggregateWindow's
//       own bounding ever regressed) but NOT independently discriminating
//       against replay.ts's ts<=T filter specifically, per the trace above.
//   (b) NO-LOOKAHEAD LEAK PROOF (Rule E / fundedFirstBuy) — funding-event
//       side-channel; FundingEvent is not a trades/market-channel input, so
//       aggregateWindow's anchoring has nothing to do with it at all. This is
//       the genuinely discriminating test for the Critical-1 leak fixed in
//       replay.ts (confirmed red when the fundedFirstBuy scrub is reverted —
//       see task-41-report.md).
//   (b2) NO-LOOKAHEAD PROOF (Rule F / rotationCandidates) — confirms
//       destBuyTs gating (already present in replay.ts) stays gated;
//       independently discriminating for the same reason as (b) (confirmed
//       red when the destBuyTs filter is removed).

import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/settings';
import { replaySignals } from '../src/backtest/replay';
import type { TradeRowInput, WalletInfoInput, MarketPointInput } from '../src/window/aggregate';
import type { FundingEvent, RotationCandidate } from '../src/types';

const MIN_MS = 60_000;

function wallet(id: string): WalletInfoInput {
  return { walletId: id, isWatched: true, walletScore: 80, labels: ['smart_money'], meetsProfitable: true, status: 'signal_eligible' };
}

function buy(walletId: string, ts: Date, amountUsd: number, mcap = 500_000): TradeRowInput {
  return { walletId, action: 'BUY', amountUsd, ts, blockOrSlot: BigInt(Math.floor(ts.getTime())), marketCapAtTrade: mcap };
}

function sell(walletId: string, ts: Date, amountUsd: number, mcap = 500_000): TradeRowInput {
  return { walletId, action: 'SELL', amountUsd, ts, blockOrSlot: BigInt(Math.floor(ts.getTime())), marketCapAtTrade: mcap };
}

function marketPoint(ts: Date, mcap: number, liq = 100_000): MarketPointInput {
  return { ts, marketCapUsd: mcap, liquidityUsd: liq };
}

describe('replaySignals — no-lookahead', () => {
  it('rule A trades-channel regression: fires only at the step where its qualifying trades have actually happened, never earlier from a poisoned future trade (NOTE: not independently discriminating — aggregateWindow\'s own trade-anchoring happens to also catch this one; see the soldPct-flip test below for the load-bearing trades-channel proof)', () => {
    const genesis = new Date('2026-01-01T00:00:00Z');
    const tokenId = 'tok-nolookahead';

    // 25 smart wallets buy strictly AFTER T1 (genesis + 60min) — these alone
    // are what should make Rule A's HIGH tier fire, and only once replay
    // reaches a step at/after their timestamps.
    const qualifyingWallets: WalletInfoInput[] = [];
    const qualifyingTrades: TradeRowInput[] = [];
    const laterTs = new Date(genesis.getTime() + 90 * MIN_MS); // step T3 (0,30,60,90)
    for (let i = 0; i < 25; i++) {
      const id = `smart-${i}`;
      qualifyingWallets.push(wallet(id));
      qualifyingTrades.push(buy(id, new Date(laterTs.getTime() + i * 1000), 2000));
    }

    // The market series is fine throughout (mcap/liquidity always in-band).
    const market: MarketPointInput[] = [
      marketPoint(genesis, 500_000),
      marketPoint(new Date(genesis.getTime() + 30 * MIN_MS), 500_000),
      marketPoint(new Date(genesis.getTime() + 60 * MIN_MS), 500_000),
      marketPoint(laterTs, 500_000),
      marketPoint(new Date(genesis.getTime() + 120 * MIN_MS), 500_000)
    ];

    const wallets = qualifyingWallets;
    const trades = qualifyingTrades;

    const from = genesis;
    const to = new Date(genesis.getTime() + 120 * MIN_MS);

    const replayed = replaySignals({
      trades,
      wallets,
      clusters: [],
      marketPoints: market,
      fundingEvents: [],
      rotationCandidates: [],
      from,
      to,
      stepMinutes: 30,
      settings: DEFAULT_SETTINGS,
      tokenId
    });

    const anyAFires = replayed.filter((s) => s.rule === 'A');
    expect(anyAFires.length).toBeGreaterThan(0);
    // Every fire is correctly attributed to this single-token fixture's tokenId.
    expect(anyAFires.every((f) => f.tokenId === tokenId)).toBe(true);

    // None of the fires may be dated before laterTs (T3) — if the engine
    // leaked the future trades backward, we'd see a fire at T1 (genesis+60min)
    // or earlier, which is exactly the lookahead bug this test guards against.
    for (const fire of anyAFires) {
      expect(fire.firedAt.getTime()).toBeGreaterThanOrEqual(laterTs.getTime());
    }

    // And confirm a fire DOES eventually occur at or after the correct step
    // (T3 or T4) — i.e. this isn't just silently never firing at all.
    const firedAtCorrectStep = anyAFires.some(
      (f) => f.firedAt.getTime() === laterTs.getTime() || f.firedAt.getTime() === to.getTime()
    );
    expect(firedAtCorrectStep).toBe(true);
  });

  it('dedupe parity: same token+rule suppressed for 24h after firing, refires after the window elapses', () => {
    const genesis = new Date('2026-01-01T00:00:00Z');
    const wallets: WalletInfoInput[] = Array.from({ length: 25 }, (_, i) => wallet(`w-${i}`));

    // Trades qualifying Rule A HIGH tier at step 0 (T0) AND again re-qualifying
    // continuously through T0+30h (so without dedupe it would refire every step).
    const trades: TradeRowInput[] = [];
    for (let hour = 0; hour <= 30; hour += 1) {
      const ts = new Date(genesis.getTime() + hour * 60 * MIN_MS);
      for (let i = 0; i < 25; i++) {
        trades.push(buy(`w-${i}`, new Date(ts.getTime() - i * 1000), 2000));
      }
    }

    const market: MarketPointInput[] = [];
    for (let hour = 0; hour <= 30; hour += 1) {
      market.push(marketPoint(new Date(genesis.getTime() + hour * 60 * MIN_MS), 500_000));
    }

    const from = genesis;
    const to = new Date(genesis.getTime() + 30 * 60 * MIN_MS);

    const replayed = replaySignals({
      trades,
      wallets,
      clusters: [],
      marketPoints: market,
      fundingEvents: [],
      rotationCandidates: [],
      from,
      to,
      stepMinutes: 60, // hourly steps so 24h dedupe window spans 24 steps
      settings: DEFAULT_SETTINGS
    });

    const aFires = replayed.filter((s) => s.rule === 'A').sort((x, y) => x.firedAt.getTime() - y.firedAt.getTime());
    expect(aFires.length).toBeGreaterThanOrEqual(2);

    // First fire at (or very near) T0.
    expect(aFires[0]!.firedAt.getTime()).toBe(genesis.getTime());

    // No fire strictly between T0(exclusive) and T0+24h(exclusive) — dedupe
    // suppression window.
    const suppressedWindowEnd = genesis.getTime() + 24 * 60 * MIN_MS;
    const withinSuppression = aFires.filter(
      (f) => f.firedAt.getTime() > genesis.getTime() && f.firedAt.getTime() < suppressedWindowEnd
    );
    expect(withinSuppression.length).toBe(0);

    // A refire occurs at/after T0+24h.
    const refire = aFires.find((f) => f.firedAt.getTime() >= suppressedWindowEnd);
    expect(refire).toBeDefined();
  });

  it('step walking bounds: from is inclusive, to is inclusive (documented), steps are exactly stepMinutes apart', () => {
    const genesis = new Date('2026-01-01T00:00:00Z');
    const to = new Date(genesis.getTime() + 90 * MIN_MS);

    // No trades/wallets at all — we only care about which T values get
    // visited, which we infer indirectly via a deterministic zero-signal run
    // not throwing and covering the right span. To directly observe visited
    // steps we rely on a wallet set that fires at EVERY step so firedAt values
    // reveal the walked timestamps once dedupe is accounted for (24h dedupe
    // won't suppress anything within this 90-minute span's single first fire,
    // so instead we assert index count via a rule that doesn't dedupe as
    // aggressively — but replay only exposes fired signals, so we use Rule A
    // once and check bounds structurally via firedAt <= to and >= from).
    const wallets: WalletInfoInput[] = Array.from({ length: 25 }, (_, i) => wallet(`w-${i}`));
    const trades: TradeRowInput[] = Array.from({ length: 25 }, (_, i) => buy(`w-${i}`, genesis, 2000, 500_000));
    const market: MarketPointInput[] = [marketPoint(genesis, 500_000), marketPoint(to, 500_000)];

    const replayed = replaySignals({
      trades,
      wallets,
      clusters: [],
      marketPoints: market,
      fundingEvents: [],
      rotationCandidates: [],
      from: genesis,
      to,
      stepMinutes: 30,
      settings: DEFAULT_SETTINGS
    });

    for (const fire of replayed) {
      expect(fire.firedAt.getTime()).toBeGreaterThanOrEqual(genesis.getTime());
      expect(fire.firedAt.getTime()).toBeLessThanOrEqual(to.getTime());
    }
    // At least the first step (from) produced a fire since qualifying trades
    // exist right at genesis.
    expect(replayed.some((f) => f.firedAt.getTime() === genesis.getTime())).toBe(true);
  });

  it('is deterministic: running the exact same input twice yields identical output', () => {
    const genesis = new Date('2026-01-01T00:00:00Z');
    const to = new Date(genesis.getTime() + 180 * MIN_MS);
    const wallets: WalletInfoInput[] = Array.from({ length: 22 }, (_, i) => wallet(`w-${i}`));
    const trades: TradeRowInput[] = Array.from({ length: 22 }, (_, i) =>
      buy(`w-${i}`, new Date(genesis.getTime() + i * 1000), 1500, 500_000)
    );
    const market: MarketPointInput[] = [marketPoint(genesis, 500_000), marketPoint(to, 500_000)];

    const input = {
      trades,
      wallets,
      clusters: [],
      marketPoints: market,
      fundingEvents: [],
      rotationCandidates: [],
      from: genesis,
      to,
      stepMinutes: 30,
      settings: DEFAULT_SETTINGS
    };

    const run1 = replaySignals(input);
    const run2 = replaySignals(input);
    expect(JSON.stringify(run1)).toBe(JSON.stringify(run2));
  });

  it('defaults stepMinutes to 30 when omitted', () => {
    const genesis = new Date('2026-01-01T00:00:00Z');
    const to = new Date(genesis.getTime() + 60 * MIN_MS);
    const replayed = replaySignals({
      trades: [],
      wallets: [],
      clusters: [],
      marketPoints: [],
      fundingEvents: [],
      rotationCandidates: [],
      from: genesis,
      to,
      settings: DEFAULT_SETTINGS
    });
    expect(Array.isArray(replayed)).toBe(true);
  });

  // ---------------------------------------------------------------------
  // CRITICAL 1 — Rule E lookahead leak via fundingEvents.fundedFirstBuy
  // ---------------------------------------------------------------------
  it('NO-LOOKAHEAD LEAK PROOF (rule E / fundedFirstBuy): a funding event whose transfer is at-or-before T but whose fundedFirstBuy is AFTER T must not let rule E fire at T — the buy has not happened yet as of T, even though the funding transfer has', () => {
    const tokenId = 'tok-ruleE-leak';
    const genesis = new Date('2026-01-01T00:00:00Z'); // T0
    const buyTs = new Date(genesis.getTime() + 30 * MIN_MS); // T1 — 30min after funding, within E.minDelayMin..maxDelayMin (5..120)

    const fundingEvent: FundingEvent = {
      funderWalletId: 'funder-1',
      fundedWalletId: 'fresh-1',
      fundedAddressFresh: true,
      amountUsd: 10_000,
      ts: genesis, // funding transfer at T0
      fundedFirstBuy: {
        tokenId,
        usd: 5_000, // 50% of funding — within E.minBuyToFundingPct..maxBuyToFundingPct (30..110)
        ts: buyTs, // the buy itself happens at T1, STRICTLY AFTER T0
        mcapAtBuy: 500_000 // <= E.maxMcap (5,000,000)
      }
    };

    const from = genesis;
    const to = new Date(genesis.getTime() + 90 * MIN_MS); // steps: T0, T1(+30), T2(+60), T3(+90)

    const replayed = replaySignals({
      trades: [],
      wallets: [],
      clusters: [],
      marketPoints: [],
      fundingEvents: [fundingEvent],
      rotationCandidates: [],
      from,
      to,
      stepMinutes: 30,
      settings: DEFAULT_SETTINGS,
      tokenId
    });

    const eFires = replayed.filter((s) => s.rule === 'E');

    // Must NOT fire at T0: as of T0 the funding transfer has happened but the
    // buy it supposedly financed (dated T1, 30 min later) has not — a leak
    // would let ruleE.ts see fundedFirstBuy early (it reads firstBuy.ts/
    // mcapAtBuy/usd directly with no T-gating of its own) and fire at T0.
    expect(eFires.some((f) => f.firedAt.getTime() === genesis.getTime())).toBe(false);

    // Must fire at T1 (first step >= buy time) once delay/mcap/ratio
    // conditions are satisfied — proves this isn't just silently never firing.
    expect(eFires.some((f) => f.firedAt.getTime() === buyTs.getTime())).toBe(true);
  });

  // ---------------------------------------------------------------------
  // CRITICAL 2(b) — Rule F / rotationCandidates destBuyTs gating (confirms
  // it stays gated; rotationCandidates are untouched by trade anchoring so
  // this is independently discriminating, same as the Rule E test above)
  // ---------------------------------------------------------------------
  it('NO-LOOKAHEAD PROOF (rule F / rotationCandidates): a candidate whose destBuyTs is AFTER T must not let rule F fire at T', () => {
    const tokenId = 'tok-ruleF-gate';
    const genesis = new Date('2026-01-01T00:00:00Z'); // T0
    const transferTs = genesis;
    const receiptTs = genesis;
    const destBuyTs = new Date(genesis.getTime() + 30 * MIN_MS); // T1 — <= F.maxBuyDelayMin (60) after receipt

    const candidate: RotationCandidate = {
      sourceWalletId: 'src-1',
      destWalletId: 'dest-1',
      sourceTokenId: 'tok-source',
      destTokenId: tokenId,
      realizedProfitUsd: 1_000, // >= F.minRealizedProfitUsd (500)
      transferredValueUsd: 1_000,
      receivedValueUsd: 900, // 90% value match — within F.minValueMatchPct..maxValueMatchPct (80..105)
      transferTs,
      receiptTs,
      destBuyTs, // buy itself lands at T1, STRICTLY AFTER T0
      destBuyUsd: 900,
      destTokenMcapAtBuy: 500_000, // <= F.maxMcap (5,000,000)
      bridged: false,
      chainPath: ['src-1', 'dest-1']
    };

    const from = genesis;
    const to = new Date(genesis.getTime() + 90 * MIN_MS);

    const replayed = replaySignals({
      trades: [],
      wallets: [],
      clusters: [],
      marketPoints: [],
      fundingEvents: [],
      rotationCandidates: [candidate],
      from,
      to,
      stepMinutes: 30,
      settings: DEFAULT_SETTINGS,
      tokenId
    });

    const fFires = replayed.filter((s) => s.rule === 'F');

    // Must NOT fire at T0 — destBuyTs (T1) is after T0, so as of T0 the
    // rotation chain isn't complete yet.
    expect(fFires.some((f) => f.firedAt.getTime() === genesis.getTime())).toBe(false);

    // Must fire at T1 (first step >= destBuyTs) — proves the gate isn't just
    // permanently suppressing the candidate.
    expect(fFires.some((f) => f.firedAt.getTime() === destBuyTs.getTime())).toBe(true);
  });

  // ---------------------------------------------------------------------
  // Trades-channel regression check (soldPct flip) — NOT a Critical-2
  // discriminator against replay.ts's own filter (see this file's header
  // trace: aggregateWindow's `to = min(now, latestTradeTs)` can only pull
  // `to` BACKWARD, never forward past `now`/T, so a future poison trade can
  // never enter the window regardless of whether replay.ts's outer ts<=T
  // pre-filter exists). Verified empirically: deleting replay.ts's trades
  // pre-filter and re-running this exact test left it GREEN (see
  // task-41-report.md for the recorded output) — which is what motivated the
  // trace above rather than shipping this as a decorative "discriminating"
  // test. Kept as a real regression check on aggregateWindow's own bounding
  // invariant (soldPct must reflect only ts<=T trades) — a guarantee this
  // suite should still assert even though it is not the fix this Critical-2
  // item is about; the actual guarantee for Critical 2 is carried by the two
  // side-channel tests above ((b) rule E, (b2) rule F).
  it('trades-channel regression: a future SELL barrage beyond T must not flip rule A HIGH soldPct at T (guaranteed by aggregateWindow\'s own to<=now bounding, not by this file\'s filter alone — see header trace)', () => {
    const tokenId = 'tok-soldpct-flip';
    const genesis = new Date('2026-01-01T00:00:00Z');
    const T = new Date(genesis.getTime() + 60 * MIN_MS); // the step under test (T2 of steps 0,30,60,90)

    const wallets: WalletInfoInput[] = Array.from({ length: 20 }, (_, i) => wallet(`w-${i}`));

    // 20 qualifying buyers, all buying well before T so the buy itself is
    // legitimately visible at T (window is 30min: [T-30, T]). Each buys
    // $2,000 (total $40,000 >= A.minBuyVolumeUsd of $25,000). None of them
    // sell anything as of T — soldPct = 0% at T, well under A.maxSoldPct (30%).
    const trades: TradeRowInput[] = [];
    const buyTs = new Date(T.getTime() - 10 * MIN_MS); // inside [T-30, T]
    for (let i = 0; i < 20; i++) {
      trades.push(buy(`w-${i}`, new Date(buyTs.getTime() + i * 100), 2000, 500_000));
    }

    // POISON: a SELL barrage from 7 of those SAME buyers (>30% of 20 = 6, so
    // 7 crosses A.maxSoldPct), dated AFTER T but still inside the window an
    // UNFILTERED aggregateWindow call would anchor `to` onto (T+ up to
    // T+29min is still within a 30-min window starting from the poisoned
    // `to`). If replay.ts's ts<=T filter were absent, these sells would (1)
    // become the new `latestTradeTs`, pulling `to` forward past T, and (2)
    // land inside the resulting window, pushing soldPct from 0% to 35% (7/20)
    // — above the 30% cap — which would make rule A's HIGH tier fail to fire
    // at T even though, correctly filtered, it must fire.
    const poisonSellTs = new Date(T.getTime() + 5 * MIN_MS); // strictly AFTER T
    for (let i = 0; i < 7; i++) {
      trades.push(sell(`w-${i}`, new Date(poisonSellTs.getTime() + i * 100), 2000, 500_000));
    }

    // Market series: mcap/liquidity in-band throughout, including at T.
    const market: MarketPointInput[] = [
      marketPoint(genesis, 500_000),
      marketPoint(T, 500_000),
      marketPoint(new Date(genesis.getTime() + 120 * MIN_MS), 500_000)
    ];

    const from = genesis;
    const to = new Date(genesis.getTime() + 120 * MIN_MS);

    const replayed = replaySignals({
      trades,
      wallets,
      clusters: [],
      marketPoints: market,
      fundingEvents: [],
      rotationCandidates: [],
      from,
      to,
      stepMinutes: 30,
      settings: DEFAULT_SETTINGS,
      tokenId
    });

    const aFiresAtT = replayed.filter((s) => s.rule === 'A' && s.firedAt.getTime() === T.getTime());
    expect(aFiresAtT.length).toBe(1);
    expect(aFiresAtT[0]!.severity).toBe('HIGH');
    // Explicitly confirm soldPct as computed AT T is unaffected by the future
    // sells (0%, not the poisoned 35%).
    expect(aFiresAtT[0]!.metrics.soldPct).toBe(0);
  });
});
