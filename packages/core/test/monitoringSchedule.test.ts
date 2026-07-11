// FlowRadar — pure monitoring-schedule tests (Wave C).
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MONITORING_SCHEDULE,
  tierRank,
  pollIntervalSec,
  computeNextPollAt,
  hotExpiryTransition,
  coldTransition,
  reactivationTier
} from '../src/lineage/monitoringSchedule';

const C = DEFAULT_MONITORING_SCHEDULE;
const NOW = new Date('2026-07-10T12:00:00Z');

describe('tier ordering', () => {
  it('orders hot > root_permanent > strong > probable > standard > weak_cold > cold_archive', () => {
    expect(tierRank('fresh_receiver_hot')).toBeLessThan(tierRank('root_permanent'));
    expect(tierRank('root_permanent')).toBeLessThan(tierRank('strong_link'));
    expect(tierRank('strong_link')).toBeLessThan(tierRank('probable_link'));
    expect(tierRank('probable_link')).toBeLessThan(tierRank('standard'));
    expect(tierRank('standard')).toBeLessThan(tierRank('weak_cold'));
    expect(tierRank('weak_cold')).toBeLessThan(tierRank('cold_archive'));
  });

  it('intervals increase as tiers get colder', () => {
    expect(pollIntervalSec('fresh_receiver_hot', C)).toBeLessThan(pollIntervalSec('root_permanent', C));
    expect(pollIntervalSec('probable_link', C)).toBeLessThan(pollIntervalSec('weak_cold', C));
    expect(pollIntervalSec('weak_cold', C)).toBeLessThan(pollIntervalSec('cold_archive', C));
  });
});

describe('computeNextPollAt', () => {
  it('adds the base interval with no errors', () => {
    const next = computeNextPollAt('probable_link', NOW, 0, C);
    expect(next.getTime()).toBe(NOW.getTime() + C.tierIntervalsSec.probable_link * 1000);
  });

  it('applies exponential backoff on consecutive errors, bounded by maxBackoffMultiplier', () => {
    const one = computeNextPollAt('probable_link', NOW, 1, C).getTime() - NOW.getTime();
    const three = computeNextPollAt('probable_link', NOW, 3, C).getTime() - NOW.getTime();
    const huge = computeNextPollAt('probable_link', NOW, 99, C).getTime() - NOW.getTime();
    expect(three).toBeGreaterThan(one);
    // Bounded: 99 errors == maxBackoffMultiplier, not 2^99.
    expect(huge).toBe(C.tierIntervalsSec.probable_link * C.maxBackoffMultiplier * 1000);
  });
});

describe('hotExpiryTransition', () => {
  it('demotes fresh_receiver_hot to probable_link after hotUntil', () => {
    expect(hotExpiryTransition('fresh_receiver_hot', new Date(NOW.getTime() - 1000), NOW)).toBe('probable_link');
  });
  it('does nothing while still hot', () => {
    expect(hotExpiryTransition('fresh_receiver_hot', new Date(NOW.getTime() + 1000), NOW)).toBeNull();
  });
  it('does nothing for other tiers', () => {
    expect(hotExpiryTransition('root_permanent', new Date(NOW.getTime() - 1000), NOW)).toBeNull();
  });
});

describe('coldTransition', () => {
  it('demotes an idle tier one step toward cold', () => {
    const idle = new Date(NOW.getTime() - (C.coldAfterDays + 1) * 86_400_000);
    expect(coldTransition('strong_link', idle, NOW, C)).toBe('probable_link');
    expect(coldTransition('probable_link', idle, NOW, C)).toBe('standard');
    expect(coldTransition('standard', idle, NOW, C)).toBe('weak_cold');
    expect(coldTransition('weak_cold', idle, NOW, C)).toBe('cold_archive');
  });
  it('never cold-transitions root_permanent or fresh_receiver_hot', () => {
    const idle = new Date(NOW.getTime() - 999 * 86_400_000);
    expect(coldTransition('root_permanent', idle, NOW, C)).toBeNull();
    expect(coldTransition('fresh_receiver_hot', idle, NOW, C)).toBeNull();
  });
  it('does nothing while still active', () => {
    expect(coldTransition('probable_link', new Date(NOW.getTime() - 1000), NOW, C)).toBeNull();
  });
});

describe('reactivationTier', () => {
  it('warms a cold wallet back to probable_link', () => {
    expect(reactivationTier('weak_cold')).toBe('probable_link');
    expect(reactivationTier('cold_archive')).toBe('probable_link');
  });
  it('does nothing for already-warm tiers', () => {
    expect(reactivationTier('root_permanent')).toBeNull();
    expect(reactivationTier('fresh_receiver_hot')).toBeNull();
  });
});
