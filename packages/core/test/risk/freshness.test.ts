// FlowRadar — pure risk-cache freshness tests (Task 1 Helius 429 fix).
// Covers the pure half of the operator's 12 required tests:
//   #5 repeated 429 uses bounded backoff (the delay math)
//   #7 unavailable data is not safe
//   #8 stale fallback is labeled
//   #9 flowScoring output is unchanged for identical risk input
// plus full freshness-state derivation and report reconstruction.

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RISK_FRESHNESS,
  nextRefreshDelaySec,
  reportForSnapshot,
  riskFreshness,
  unavailableRiskReport,
  type RiskSnapshotView
} from '../../src/risk/freshness';
import { computeFlowScore } from '../../src/scoring/flowScore';
import { DEFAULT_SETTINGS } from '../../src/settings';
import type { RiskReport, TokenWindowAggregate } from '../../src/types';

const NOW = new Date('2026-07-11T12:00:00Z');

function snap(over: Partial<RiskSnapshotView>): RiskSnapshotView {
  return {
    status: 'ok',
    penalty: 0.3,
    flags: [{ id: 'top_holder_concentration', label: 'Top holder controls 42.0% of supply', severity: 'danger' }],
    observedAt: new Date(NOW.getTime() - 60_000), // 1 min ago -> fresh
    expiresAt: new Date(NOW.getTime() + 540_000),
    nextRefreshAt: new Date(NOW.getTime() + 540_000),
    confidence: 1,
    ...over
  };
}

describe('riskFreshness', () => {
  it('is fresh within the fresh window', () => {
    expect(riskFreshness(snap({}), NOW)).toBe('fresh');
  });

  it('is fresh exactly at the window edge', () => {
    const observedAt = new Date(NOW.getTime() - DEFAULT_RISK_FRESHNESS.freshSec * 1000);
    expect(riskFreshness(snap({ observedAt }), NOW)).toBe('fresh');
  });

  it('is stale_usable past the window when refresh is not yet due', () => {
    const observedAt = new Date(NOW.getTime() - (DEFAULT_RISK_FRESHNESS.freshSec + 60) * 1000);
    const nextRefreshAt = new Date(NOW.getTime() + 30_000); // not due yet
    expect(riskFreshness(snap({ observedAt, nextRefreshAt }), NOW)).toBe('stale_usable');
  });

  it('is refresh_pending past the window once refresh is due', () => {
    const observedAt = new Date(NOW.getTime() - (DEFAULT_RISK_FRESHNESS.freshSec + 60) * 1000);
    const nextRefreshAt = new Date(NOW.getTime() - 1000); // due
    expect(riskFreshness(snap({ observedAt, nextRefreshAt }), NOW)).toBe('refresh_pending');
  });

  it('is refresh_pending when ok but never observed', () => {
    expect(riskFreshness(snap({ observedAt: null }), NOW)).toBe('refresh_pending');
  });

  it('maps provider statuses to their states', () => {
    expect(riskFreshness(snap({ status: 'unavailable' }), NOW)).toBe('unavailable');
    expect(riskFreshness(snap({ status: 'throttled' }), NOW)).toBe('provider_throttled');
    expect(riskFreshness(snap({ status: 'error' }), NOW)).toBe('error');
  });
});

describe('reportForSnapshot', () => {
  it('#9 fresh returns the stored penalty and flags verbatim', () => {
    const s = snap({});
    const report = reportForSnapshot(s, 'fresh');
    expect(report.penalty).toBe(s.penalty);
    expect(report.flags).toEqual(s.flags);
  });

  it('#8 stale fallback keeps the penalty but is labeled stale', () => {
    const observedAt = new Date(NOW.getTime() - (DEFAULT_RISK_FRESHNESS.freshSec + 60) * 1000);
    const s = snap({ observedAt, nextRefreshAt: new Date(NOW.getTime() + 30_000) });
    const report = reportForSnapshot(s, 'stale_usable');
    expect(report.penalty).toBe(s.penalty); // unchanged -> score identical to when fresh
    expect(report.flags.some((f) => f.id === 'risk_data_stale')).toBe(true);
    // original flags preserved
    expect(report.flags.some((f) => f.id === 'top_holder_concentration')).toBe(true);
  });

  it('#7 unavailable/throttled/error report is unknown, NOT safe (penalty 0 + warn flag)', () => {
    for (const state of ['unavailable', 'provider_throttled', 'error'] as const) {
      const report = reportForSnapshot(snap({ status: state === 'unavailable' ? 'unavailable' : 'ok', observedAt: null }), state);
      expect(report.penalty).toBe(0);
      // A warn flag makes it read as UNKNOWN; a bare empty report would read as "clean".
      expect(report.flags.some((f) => f.severity === 'warn')).toBe(true);
    }
  });

  it('throttled/error WITH a last-good value returns that value labeled stale (never drops the penalty to a false 0)', () => {
    const observedAt = new Date(NOW.getTime() - 120_000);
    for (const state of ['provider_throttled', 'error'] as const) {
      const s = snap({ status: state === 'provider_throttled' ? 'throttled' : 'error', penalty: 0.4, observedAt });
      const report = reportForSnapshot(s, state);
      expect(report.penalty).toBe(0.4); // last-good penalty preserved
      expect(report.flags.some((f) => f.id === 'risk_data_stale')).toBe(true);
    }
  });

  it('unavailableRiskReport is penalty 0 with a warn flag (not empty/clean)', () => {
    const r = unavailableRiskReport();
    expect(r.penalty).toBe(0);
    expect(r.flags.length).toBeGreaterThan(0);
    expect(r.flags[0].severity).toBe('warn');
  });
});

describe('nextRefreshDelaySec (#5 bounded backoff)', () => {
  const opts = { baseSec: 30, factor: 2, maxSec: 900 };
  it('grows exponentially with fail count', () => {
    expect(nextRefreshDelaySec(1, opts)).toBe(30);
    expect(nextRefreshDelaySec(2, opts)).toBe(60);
    expect(nextRefreshDelaySec(3, opts)).toBe(120);
    expect(nextRefreshDelaySec(4, opts)).toBe(240);
  });
  it('is capped at maxSec (bounded, never unbounded)', () => {
    expect(nextRefreshDelaySec(100, opts)).toBe(900);
    expect(nextRefreshDelaySec(1000, opts)).toBe(900);
  });
  it('returns base for the zero/first case', () => {
    expect(nextRefreshDelaySec(0, opts)).toBe(30);
  });
});

describe('#9 FlowScore is identical for a directly-fetched vs cache-reconstructed report', () => {
  function agg(): TokenWindowAggregate {
    const from = new Date(NOW.getTime() - 1440 * 60_000);
    return {
      tokenId: 't',
      windowMinutes: 1440,
      from,
      to: NOW,
      buyers: [
        {
          walletId: 'w1',
          walletScore: 80,
          labels: ['smart_money'],
          buyUsd: 3000,
          sellUsd: 500,
          firstBuyTs: from,
          blockOrSlot: 1n,
          isWatched: true
        }
      ],
      trackedBuyVolumeUsd: 5000,
      trackedSellVolumeUsd: 1000,
      netFlowUsd: 4000,
      buySellRatio: 5,
      smartWalletCount: 3,
      humanLikeCount: 3,
      humanOrSmartLabelCount: 3,
      possibleBotCount: 0,
      whaleBuys: [],
      uniqueEntityCount: 3,
      largestClusterSize: 1,
      avgEntryMcap: 100000,
      currentMcap: 200000,
      mcapExpansionFromAvgEntry: 1,
      liquidityUsd: 50000,
      liquidityChangePct: 0,
      tokenAgeDays: 2,
      inflowSpike: false,
      trailingBuyVolumeUsd: 1000,
      windowBuyVolumeUsd: 5000,
      exitedSmartPct: 0,
      topHolderExits: 0,
      newSmartBuyers: 3
    };
  }

  const direct: RiskReport = {
    penalty: 0.3,
    flags: [{ id: 'top_holder_concentration', label: 'x', severity: 'danger' }]
  };

  it('fresh reconstruction preserves score exactly', () => {
    const s = snap({ penalty: direct.penalty, flags: direct.flags });
    const reconstructed = reportForSnapshot(s, 'fresh');

    const a = computeFlowScore(agg(), direct, DEFAULT_SETTINGS);
    const b = computeFlowScore(agg(), reconstructed, DEFAULT_SETTINGS);
    expect(b.score).toBe(a.score);
  });

  it('stale reconstruction (added info flag) still preserves score exactly', () => {
    const observedAt = new Date(NOW.getTime() - (DEFAULT_RISK_FRESHNESS.freshSec + 60) * 1000);
    const s = snap({ penalty: direct.penalty, flags: direct.flags, observedAt, nextRefreshAt: new Date(NOW.getTime() + 30_000) });
    const reconstructed = reportForSnapshot(s, 'stale_usable');

    const a = computeFlowScore(agg(), direct, DEFAULT_SETTINGS);
    const b = computeFlowScore(agg(), reconstructed, DEFAULT_SETTINGS);
    expect(b.score).toBe(a.score); // flags don't affect score -> stale label is score-neutral
  });
});
