import { describe, expect, it } from 'vitest';
import { ruleE } from '../src/rules/ruleE';
import { DEFAULT_SETTINGS } from '../src/settings';
import type { FundingEvent, TokenWindowAggregate } from '../src/types';

// Rule E: fresh-wallet-funded-then-buys (30-min context, per-token).
//   Fires when ANY agg.tokenId-matching FundingEvent has:
//     fundedAddressFresh === true
//     fundedFirstBuy present AND fundedFirstBuy.tokenId === agg.tokenId
//     delayMin = (fundedFirstBuy.ts - ts) in minutes, within
//       [E.minDelayMin (5), E.maxDelayMin (120)]
//     fundedFirstBuy.mcapAtBuy !== null AND <= E.maxMcap (5,000,000)
//       (null mcap => unknown => does NOT fire)
//     ratioPct = fundedFirstBuy.usd / amountUsd * 100, within
//       [E.minBuyToFundingPct (30), E.maxBuyToFundingPct (110)]
//   Severity HIGH when fired.

const TOKEN_ID = 'token-1';

function makeAggregate(overrides: Partial<TokenWindowAggregate> = {}): TokenWindowAggregate {
  const base: TokenWindowAggregate = {
    tokenId: TOKEN_ID,
    windowMinutes: 30,
    from: new Date('2026-07-05T00:00:00Z'),
    to: new Date('2026-07-05T00:30:00Z'),
    buyers: [],
    trackedBuyVolumeUsd: 0,
    trackedSellVolumeUsd: 0,
    netFlowUsd: 0,
    buySellRatio: 0,
    smartWalletCount: 0,
    humanLikeCount: 0,
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

/** Funding event fixture: fund $1,000 at t0, first buy on TOKEN_ID `delayMin` minutes later at `ratioPct`% of funding, mcap `mcapAtBuy`. */
function makeFundingEvent(opts: {
  fresh?: boolean;
  delayMin?: number;
  ratioPct?: number;
  mcapAtBuy?: number | null;
  tokenId?: string;
  amountUsd?: number;
  noFirstBuy?: boolean;
}): FundingEvent {
  const {
    fresh = true,
    delayMin = 47,
    ratioPct = 60,
    mcapAtBuy = 2_000_000,
    tokenId = TOKEN_ID,
    amountUsd = 1000,
    noFirstBuy = false
  } = opts;

  const ts = new Date('2026-07-05T00:00:00Z');
  const buyTs = new Date(ts.getTime() + delayMin * 60_000);

  return {
    funderWalletId: 'funder-1',
    fundedWalletId: 'funded-1',
    fundedAddressFresh: fresh,
    amountUsd,
    ts,
    fundedFirstBuy: noFirstBuy
      ? undefined
      : {
          tokenId,
          usd: amountUsd * (ratioPct / 100),
          ts: buyTs,
          mcapAtBuy
        }
  };
}

describe('ruleE', () => {
  it('fresh wallet funded, buys THIS token 47 min later at 60% of funding, mcap $2M -> fires HIGH', () => {
    const agg = makeAggregate();
    const events = [makeFundingEvent({ delayMin: 47, ratioPct: 60, mcapAtBuy: 2_000_000 })];

    const result = ruleE(agg, DEFAULT_SETTINGS, { fundingEvents: events });

    expect(result.fired).toBe(true);
    expect(result.severity).toBe('HIGH');
    expect(result.rule).toBe('E');
  });

  it('delay 3 min (below minDelayMin=5) -> does not fire', () => {
    const agg = makeAggregate();
    const events = [makeFundingEvent({ delayMin: 3, ratioPct: 60 })];

    const result = ruleE(agg, DEFAULT_SETTINGS, { fundingEvents: events });

    expect(result.fired).toBe(false);
  });

  it('delay 130 min (above maxDelayMin=120) -> does not fire', () => {
    const agg = makeAggregate();
    const events = [makeFundingEvent({ delayMin: 130, ratioPct: 60 })];

    const result = ruleE(agg, DEFAULT_SETTINGS, { fundingEvents: events });

    expect(result.fired).toBe(false);
  });

  it('ratio 20% (below minBuyToFundingPct=30) -> does not fire', () => {
    const agg = makeAggregate();
    const events = [makeFundingEvent({ delayMin: 47, ratioPct: 20 })];

    const result = ruleE(agg, DEFAULT_SETTINGS, { fundingEvents: events });

    expect(result.fired).toBe(false);
  });

  it('ratio 115% (above maxBuyToFundingPct=110) -> does not fire', () => {
    const agg = makeAggregate();
    const events = [makeFundingEvent({ delayMin: 47, ratioPct: 115 })];

    const result = ruleE(agg, DEFAULT_SETTINGS, { fundingEvents: events });

    expect(result.fired).toBe(false);
  });

  it('mcap $6M (above maxMcap=5,000,000) -> does not fire', () => {
    const agg = makeAggregate();
    const events = [makeFundingEvent({ delayMin: 47, ratioPct: 60, mcapAtBuy: 6_000_000 })];

    const result = ruleE(agg, DEFAULT_SETTINGS, { fundingEvents: events });

    expect(result.fired).toBe(false);
  });

  it('not-fresh wallet -> does not fire even though every other condition matches', () => {
    const agg = makeAggregate();
    const events = [makeFundingEvent({ fresh: false, delayMin: 47, ratioPct: 60 })];

    const result = ruleE(agg, DEFAULT_SETTINGS, { fundingEvents: events });

    expect(result.fired).toBe(false);
  });

  it('null mcapAtBuy -> treated as unknown, does not fire', () => {
    const agg = makeAggregate();
    const events = [makeFundingEvent({ delayMin: 47, ratioPct: 60, mcapAtBuy: null })];

    const result = ruleE(agg, DEFAULT_SETTINGS, { fundingEvents: events });

    expect(result.fired).toBe(false);
  });

  it('no funding events -> does not fire', () => {
    const agg = makeAggregate();

    const result = ruleE(agg, DEFAULT_SETTINGS, { fundingEvents: [] });

    expect(result.fired).toBe(false);
  });

  it('missing extras entirely -> does not fire (defaults to empty funding events)', () => {
    const agg = makeAggregate();

    const result = ruleE(agg, DEFAULT_SETTINGS);

    expect(result.fired).toBe(false);
  });

  it('fundedFirstBuy on a DIFFERENT token -> does not fire', () => {
    const agg = makeAggregate();
    const events = [makeFundingEvent({ delayMin: 47, ratioPct: 60, tokenId: 'other-token' })];

    const result = ruleE(agg, DEFAULT_SETTINGS, { fundingEvents: events });

    expect(result.fired).toBe(false);
  });

  it('no fundedFirstBuy at all -> does not fire', () => {
    const agg = makeAggregate();
    const events = [makeFundingEvent({ noFirstBuy: true })];

    const result = ruleE(agg, DEFAULT_SETTINGS, { fundingEvents: events });

    expect(result.fired).toBe(false);
  });

  it('one non-matching + one matching event -> fires (any-match semantics)', () => {
    const agg = makeAggregate();
    const events = [
      makeFundingEvent({ fresh: false, delayMin: 47, ratioPct: 60 }),
      makeFundingEvent({ delayMin: 47, ratioPct: 60, mcapAtBuy: 2_000_000 })
    ];

    const result = ruleE(agg, DEFAULT_SETTINGS, { fundingEvents: events });

    expect(result.fired).toBe(true);
  });

  it('metrics include fundingEvents count, matching count, and best match delay/ratio', () => {
    const agg = makeAggregate();
    const events = [
      makeFundingEvent({ fresh: false, delayMin: 47, ratioPct: 60 }), // non-matching
      makeFundingEvent({ delayMin: 47, ratioPct: 60, mcapAtBuy: 2_000_000 }) // matching
    ];

    const result = ruleE(agg, DEFAULT_SETTINGS, { fundingEvents: events });

    expect(result.metrics.fundingEventCount).toBe(2);
    expect(result.metrics.matchingEventCount).toBe(1);
    expect(result.metrics.bestMatchDelayMin).toBe(47);
    expect(result.metrics.bestMatchRatioPct).toBeCloseTo(60, 5);
  });

  it('boundary: delay exactly minDelayMin (5) fires', () => {
    const agg = makeAggregate();
    const events = [makeFundingEvent({ delayMin: 5, ratioPct: 60 })];

    const result = ruleE(agg, DEFAULT_SETTINGS, { fundingEvents: events });

    expect(result.fired).toBe(true);
  });

  it('boundary: delay exactly maxDelayMin (120) fires', () => {
    const agg = makeAggregate();
    const events = [makeFundingEvent({ delayMin: 120, ratioPct: 60 })];

    const result = ruleE(agg, DEFAULT_SETTINGS, { fundingEvents: events });

    expect(result.fired).toBe(true);
  });

  it('boundary: mcap exactly maxMcap (5,000,000) fires', () => {
    const agg = makeAggregate();
    const events = [makeFundingEvent({ delayMin: 47, ratioPct: 60, mcapAtBuy: 5_000_000 })];

    const result = ruleE(agg, DEFAULT_SETTINGS, { fundingEvents: events });

    expect(result.fired).toBe(true);
  });

  it('not-fired result still returns rule "E"', () => {
    const agg = makeAggregate();

    const result = ruleE(agg, DEFAULT_SETTINGS, { fundingEvents: [] });

    expect(result.rule).toBe('E');
    expect(result.fired).toBe(false);
  });
});
