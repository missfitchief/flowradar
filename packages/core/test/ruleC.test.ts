import { describe, expect, it } from 'vitest';
import { ruleC } from '../src/rules/ruleC';
import { DEFAULT_SETTINGS } from '../src/settings';
import type { TokenWindowAggregate } from '../src/types';

// Rule C: organic-buyer-base check.
//   humanRatio = humanOrSmartLabelCount / buyers.length >= minHumanRatio (0.7)
//     Product brief verbatim (Task 15 Fix A): "70%+ buying wallets are
//     human_like OR smart_money" — humanOrSmartLabelCount is a UNION count
//     (buyers whose labels include human_like OR smart_money), NOT the
//     human_like-only humanLikeCount. Fixtures below build buyers with a
//     mix of both labels (not just human_like) to exercise that union.
//   botRatio   = possibleBotCount / buyers.length     <= maxBotRatio (0.2)
//   no single blockOrSlot holds > maxSingleBlockBuysPct% (30%) of window buyers
//   funding-diversity check (minFundingRoots/minFundingRootsPct) is SKIPPED —
//   aggregate carries no funding-root data yet (documented in rules/ruleC.ts).

function makeBuyer(
  walletId: string,
  blockOrSlot: bigint,
  overrides: Partial<TokenWindowAggregate['buyers'][number]> = {}
): TokenWindowAggregate['buyers'][number] {
  return {
    walletId,
    walletScore: 50,
    labels: [],
    buyUsd: 100,
    sellUsd: 0,
    firstBuyTs: new Date('2026-07-05T00:05:00Z'),
    blockOrSlot,
    isWatched: false,
    ...overrides
  };
}

/** N buyers spread across N distinct blocks (no single-block concentration), no labels. */
function spreadBuyers(n: number): TokenWindowAggregate['buyers'] {
  return Array.from({ length: n }, (_, i) => makeBuyer(`w${i}`, BigInt(i)));
}

/**
 * `humanOrSmart` buyers spread across distinct blocks, alternating
 * human_like/smart_money labels (mirrors NOVA's real split rather than a
 * trivial single-label 100%), followed by `other` buyers carrying neither
 * label (e.g. possible_bot). Mirrors how aggregateWindow itself derives
 * humanOrSmartLabelCount — a union over buyers[].labels — so these fixtures
 * exercise the union path Fix A introduced, not just a hand-set count.
 */
function mixedLabelBuyers(
  humanOrSmart: number,
  other: number,
  otherLabel: TokenWindowAggregate['buyers'][number]['labels'][number] = 'possible_bot'
): TokenWindowAggregate['buyers'] {
  const smartCohort = Array.from({ length: humanOrSmart }, (_, i) =>
    makeBuyer(`smart-${i}`, BigInt(i), { labels: [i % 2 === 0 ? 'smart_money' : 'human_like'] })
  );
  const otherCohort = Array.from({ length: other }, (_, i) =>
    makeBuyer(`other-${i}`, BigInt(humanOrSmart + i), { labels: [otherLabel] })
  );
  return [...smartCohort, ...otherCohort];
}

/** Union count matching aggregateWindow's own humanOrSmartLabelCount derivation. */
function countHumanOrSmart(buyers: TokenWindowAggregate['buyers']): number {
  return buyers.filter((b) => b.labels.includes('human_like') || b.labels.includes('smart_money')).length;
}

function makeAggregate(overrides: Partial<TokenWindowAggregate> = {}): TokenWindowAggregate {
  const base: TokenWindowAggregate = {
    tokenId: 'token-1',
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

describe('ruleC', () => {
  it('75% human_like-OR-smart_money (mixed labels), 10% bot, spread across blocks -> fires', () => {
    const buyers = [...mixedLabelBuyers(75, 10), ...spreadBuyers(15)]; // 75 smart/human + 10 bot + 15 unlabeled filler = 100
    const agg = makeAggregate({
      buyers,
      humanOrSmartLabelCount: countHumanOrSmart(buyers), // 75 (mixed smart_money/human_like)
      possibleBotCount: 10
    });

    const result = ruleC(agg, DEFAULT_SETTINGS);

    expect(result.fired).toBe(true);
    expect(result.rule).toBe('C');
  });

  it('69% human_like-OR-smart_money (below minHumanRatio=0.7) -> does not fire', () => {
    const buyers = [...mixedLabelBuyers(69, 10), ...spreadBuyers(21)]; // 69 smart/human + 10 bot + 21 filler = 100
    const agg = makeAggregate({
      buyers,
      humanOrSmartLabelCount: countHumanOrSmart(buyers), // 69
      possibleBotCount: 10
    });

    const result = ruleC(agg, DEFAULT_SETTINGS);

    expect(result.fired).toBe(false);
  });

  it('35% of buys concentrated in one block (above maxSingleBlockBuysPct=30) -> does not fire', () => {
    const buyers: TokenWindowAggregate['buyers'] = [
      ...Array.from({ length: 35 }, (_, i) => makeBuyer(`clustered-${i}`, 1000n, { labels: ['smart_money'] })),
      ...mixedLabelBuyers(45, 0).map((b, i) => ({ ...b, blockOrSlot: BigInt(2000 + i) })),
      ...spreadBuyers(20).map((b, i) => ({ ...b, blockOrSlot: BigInt(3000 + i) }))
    ];
    const agg = makeAggregate({
      buyers,
      humanOrSmartLabelCount: countHumanOrSmart(buyers), // 80 (35 clustered smart_money + 45 mixed)
      possibleBotCount: 5
    });

    const result = ruleC(agg, DEFAULT_SETTINGS);

    expect(result.fired).toBe(false);
  });

  it('bot ratio above maxBotRatio (0.2) -> does not fire even with good human-or-smart ratio', () => {
    const buyers = [...mixedLabelBuyers(75, 25, 'possible_bot')]; // 75 smart/human + 25 bot = 100
    const agg = makeAggregate({
      buyers,
      humanOrSmartLabelCount: countHumanOrSmart(buyers), // 75
      possibleBotCount: 25 // 25% > 20%
    });

    const result = ruleC(agg, DEFAULT_SETTINGS);

    expect(result.fired).toBe(false);
  });

  it('exactly at the single-block boundary (30%) does not trip the over-concentration check', () => {
    const buyers: TokenWindowAggregate['buyers'] = [
      ...Array.from({ length: 30 }, (_, i) => makeBuyer(`clustered-${i}`, 1000n, { labels: ['human_like'] })),
      ...mixedLabelBuyers(50, 0).map((b, i) => ({ ...b, blockOrSlot: BigInt(2000 + i) })),
      ...spreadBuyers(20).map((b, i) => ({ ...b, blockOrSlot: BigInt(3000 + i) }))
    ];
    const agg = makeAggregate({
      buyers,
      humanOrSmartLabelCount: countHumanOrSmart(buyers), // 80 (30 clustered human_like + 50 mixed)
      possibleBotCount: 5
    });

    const result = ruleC(agg, DEFAULT_SETTINGS);

    expect(result.fired).toBe(true);
  });

  it('empty buyers list does not fire and does not throw (avoids divide-by-zero)', () => {
    const agg = makeAggregate({ buyers: [], humanOrSmartLabelCount: 0, possibleBotCount: 0 });

    expect(() => ruleC(agg, DEFAULT_SETTINGS)).not.toThrow();
    expect(ruleC(agg, DEFAULT_SETTINGS).fired).toBe(false);
  });

  it('metrics report humanRatio (human_like-OR-smart_money union), botRatio, and largestSingleBlockPct', () => {
    const buyers = [...mixedLabelBuyers(75, 10), ...spreadBuyers(15)];
    const agg = makeAggregate({
      buyers,
      humanOrSmartLabelCount: countHumanOrSmart(buyers), // 75
      possibleBotCount: 10
    });

    const result = ruleC(agg, DEFAULT_SETTINGS);

    expect(result.metrics.humanRatio).toBeCloseTo(0.75, 5);
    expect(result.metrics.botRatio).toBeCloseTo(0.1, 5);
    expect(typeof result.metrics.largestSingleBlockPct).toBe('number');
  });

  it('a scenario shaped like NOVA (18 smart_money + 17 human_like out of 41 buyers, ~85%) fires on the union even though human_like alone would be ~41%', () => {
    // Regression fixture for the exact bug Fix A closes: NOVA's real cohort
    // is an 18/17 smart_money/human_like split (35 of 41 total buyers) plus
    // 5 possible_bot + 1 whale/smart_money — humanLikeCount alone reads only
    // the human_like half (17/41 = 41.5%, would fail); humanOrSmartLabelCount
    // reads the full union (35/41 = 85.4%, clears the 70% floor).
    const smartMoney = Array.from({ length: 18 }, (_, i) => makeBuyer(`nova-sm-${i}`, BigInt(i), { labels: ['smart_money'] }));
    const humanLike = Array.from({ length: 17 }, (_, i) => makeBuyer(`nova-hl-${i}`, BigInt(20 + i), { labels: ['human_like'] }));
    const bots = Array.from({ length: 5 }, (_, i) => makeBuyer(`nova-bot-${i}`, BigInt(50 + i), { labels: ['possible_bot'] }));
    const whale = [makeBuyer('nova-whale', 60n, { labels: ['whale', 'smart_money'] })];
    const buyers = [...smartMoney, ...humanLike, ...bots, ...whale];

    const agg = makeAggregate({
      buyers,
      humanOrSmartLabelCount: countHumanOrSmart(buyers), // 18 + 17 + 1 (whale also tags smart_money) = 36 of 41 = 87.8%
      possibleBotCount: 5
    });

    const result = ruleC(agg, DEFAULT_SETTINGS);

    expect(result.fired).toBe(true);
    expect(result.metrics.humanRatio).toBeGreaterThanOrEqual(0.7);
  });
});
