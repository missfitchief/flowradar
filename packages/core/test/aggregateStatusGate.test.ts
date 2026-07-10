// FlowRadar — aggregateWindow status gate (Phase 0,
// feat/pre-public-accumulation). Spec regression tests: smartness requires
// status='signal_eligible' AND (isWatched || meetsProfitable). Public
// KOL/promoter/copytrader/bot/observation wallets NEVER count toward early
// smart-money metrics regardless of how good their stats look or whether an
// operator watches them — public entry is a late-stage crowd signal by
// definition, not an early one. Their activity is still aggregated (buyers,
// volumes) — observation is persisted, it just carries zero signal weight.

import { describe, expect, it } from 'vitest';
import { aggregateWindow } from '../src/window/aggregate';
import type { WalletStatus } from '../src/wallets/status';

const NOW = new Date('2026-07-10T12:00:00Z');

function buyTrade(walletId: string, minutesAgo: number) {
  return {
    walletId,
    action: 'BUY' as const,
    amountUsd: 1000,
    ts: new Date(NOW.getTime() - minutesAgo * 60_000),
    blockOrSlot: BigInt(1000 - minutesAgo),
    marketCapAtTrade: 500_000
  };
}

function walletInfo(walletId: string, status: WalletStatus, opts: { isWatched?: boolean; meetsProfitable?: boolean } = {}) {
  return {
    walletId,
    isWatched: opts.isWatched ?? false,
    walletScore: 70,
    labels: [],
    meetsProfitable: opts.meetsProfitable ?? true,
    status
  };
}

function aggregate(wallets: ReturnType<typeof walletInfo>[]) {
  return aggregateWindow({
    trades: wallets.map((w, i) => buyTrade(w.walletId, 30 + i)),
    wallets,
    clusters: [],
    market: [],
    windowMinutes: 1440,
    now: NOW
  });
}

describe('aggregateWindow status gate', () => {
  it('signal_eligible + profitable counts as smart', () => {
    const agg = aggregate([walletInfo('w_eligible', 'signal_eligible', { meetsProfitable: true })]);
    expect(agg.smartWalletCount).toBe(1);
  });

  it('every non-eligible status carries ZERO smart weight — even watched, even with excellent stats', () => {
    const NON_ELIGIBLE: WalletStatus[] = [
      'observation_only',
      'public_kol',
      'public_promoter',
      'copytrader',
      'bot_or_service',
      'excluded'
    ];
    for (const status of NON_ELIGIBLE) {
      const agg = aggregate([walletInfo(`w_${status}`, status, { isWatched: true, meetsProfitable: true })]);
      expect(agg.smartWalletCount, `status=${status}`).toBe(0);
      // Observation persists: the wallet is still a buyer with real volume.
      expect(agg.buyers, `status=${status} buyers`).toHaveLength(1);
      expect(agg.trackedBuyVolumeUsd, `status=${status} volume`).toBe(1000);
    }
  });

  it('mixed cohort: only the eligible wallets count; public KOL and copytrader buys still show in buyers[]', () => {
    const agg = aggregate([
      walletInfo('w_e1', 'signal_eligible', { meetsProfitable: true }),
      walletInfo('w_e2', 'signal_eligible', { isWatched: true, meetsProfitable: false }),
      walletInfo('w_kol', 'public_kol', { isWatched: true, meetsProfitable: true }),
      walletInfo('w_copy', 'copytrader', { meetsProfitable: true }),
      walletInfo('w_obs', 'observation_only', { meetsProfitable: true })
    ]);
    expect(agg.buyers).toHaveLength(5);
    expect(agg.smartWalletCount).toBe(2);
  });

  it('signal_eligible but neither watched nor profitable still does not count (status is necessary, not sufficient)', () => {
    const agg = aggregate([walletInfo('w_plain', 'signal_eligible', { meetsProfitable: false })]);
    expect(agg.smartWalletCount).toBe(0);
  });

  it('windowed accumulation counts (smartWalletCount30m/1h/6h) are smart-gated too — a KOL/copytrader crowd cannot inflate Rule A tiering', () => {
    // 1440-min window so the accumulation block computes; all buys 5 minutes
    // ago so every trailing window (30m/1h/6h) contains them.
    const wallets = [
      walletInfo('w_smart', 'signal_eligible', { meetsProfitable: true }),
      walletInfo('w_kol', 'public_kol', { isWatched: true, meetsProfitable: true }),
      walletInfo('w_copy', 'copytrader', { meetsProfitable: true })
    ];
    const agg = aggregateWindow({
      trades: wallets.map((w) => buyTrade(w.walletId, 5)),
      wallets,
      clusters: [],
      market: [],
      windowMinutes: 1440,
      now: NOW
    });
    expect(agg.accumulation).toBeDefined();
    expect(agg.accumulation!.smartWalletCount30m).toBe(1);
    expect(agg.accumulation!.smartWalletCount1h).toBe(1);
    expect(agg.accumulation!.smartWalletCount6h).toBe(1);
  });
});
