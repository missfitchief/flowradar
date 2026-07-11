// FlowRadar — Capital Lineage (Wave C): pure monitoring-schedule logic.
//
// The scheduler is QUEUE-based (persisted nextPollAt), never one timer per
// wallet. This module holds the pure decisions: how often each priority tier
// polls, when a fresh_receiver_hot tier expires, exponential backoff on
// errors, and cold-archive transition. No I/O — the DB scheduler applies these.

export type MonitoringTier =
  | 'fresh_receiver_hot'
  | 'root_permanent'
  | 'strong_link'
  | 'probable_link'
  | 'standard'
  | 'weak_cold'
  | 'cold_archive';

export interface MonitoringScheduleConfig {
  /** Base poll interval per tier, seconds. cold_archive is effectively never. */
  tierIntervalsSec: Record<MonitoringTier, number>;
  /** fresh_receiver_hot window — after this it demotes to probable_link. */
  hotWindowHours: number;
  /** Days without relevant activity before a tier is demoted toward cold. */
  coldAfterDays: number;
  /** Max backoff multiplier applied to the base interval on repeated errors. */
  maxBackoffMultiplier: number;
  /** A claim older than this (seconds) is stale and reclaimable. */
  staleClaimSec: number;
}

export const DEFAULT_MONITORING_SCHEDULE: MonitoringScheduleConfig = {
  tierIntervalsSec: {
    fresh_receiver_hot: 300, // 5 min — immediate hot observation
    root_permanent: 900, // 15 min — permanent, high priority
    strong_link: 1800, // 30 min
    probable_link: 3600, // 1 h — normal
    standard: 7200, // 2 h
    weak_cold: 86_400, // 1 day — cold, low frequency
    cold_archive: 604_800 // 7 days — archived; reactivated on relevant event
  },
  hotWindowHours: 48,
  coldAfterDays: 14,
  maxBackoffMultiplier: 8,
  staleClaimSec: 900
};

/** Tier priority order (lower = higher priority) for batch selection. */
const TIER_ORDER: MonitoringTier[] = [
  'fresh_receiver_hot',
  'root_permanent',
  'strong_link',
  'probable_link',
  'standard',
  'weak_cold',
  'cold_archive'
];

export function tierRank(tier: MonitoringTier): number {
  const i = TIER_ORDER.indexOf(tier);
  return i === -1 ? TIER_ORDER.length : i;
}

/** Persisted tier-priority integer (0=highest). Every subscription writer stores this so the scheduler can order in the DB (the enum's on-disk order is migration order, not tier order). Must match the migration backfill CASE. */
export function tierPriorityValue(tier: MonitoringTier): number {
  return tierRank(tier);
}

/** Base poll interval for a tier, seconds. */
export function pollIntervalSec(tier: MonitoringTier, config: MonitoringScheduleConfig): number {
  return config.tierIntervalsSec[tier];
}

/**
 * Next poll time from `now`, applying exponential backoff on consecutive
 * errors (bounded). A successful poll passes consecutiveErrors=0.
 */
export function computeNextPollAt(
  tier: MonitoringTier,
  now: Date,
  consecutiveErrors: number,
  config: MonitoringScheduleConfig
): Date {
  const base = pollIntervalSec(tier, config);
  const mult = Math.min(config.maxBackoffMultiplier, 2 ** Math.max(0, consecutiveErrors));
  return new Date(now.getTime() + base * mult * 1000);
}

/**
 * fresh_receiver_hot expiry: a subscription whose hotUntil has passed demotes
 * to probable_link (long-lived normal monitoring). Returns the new tier, or
 * null when no transition applies.
 */
export function hotExpiryTransition(
  tier: MonitoringTier,
  hotUntil: Date | null,
  now: Date
): MonitoringTier | null {
  if (tier !== 'fresh_receiver_hot') return null;
  if (hotUntil !== null && hotUntil.getTime() <= now.getTime()) return 'probable_link';
  return null;
}

/**
 * Cold transition: a non-permanent, non-service tier with no relevant activity
 * for coldAfterDays demotes one step toward cold_archive. root_permanent and
 * fresh_receiver_hot never cold-transition here (permanent / time-boxed).
 */
export function coldTransition(
  tier: MonitoringTier,
  lastActiveAt: Date | null,
  now: Date,
  config: MonitoringScheduleConfig
): MonitoringTier | null {
  if (tier === 'root_permanent' || tier === 'fresh_receiver_hot' || tier === 'cold_archive') return null;
  const idleDays = lastActiveAt ? (now.getTime() - lastActiveAt.getTime()) / (86_400_000) : Infinity;
  if (idleDays < config.coldAfterDays) return null;
  const demote: Partial<Record<MonitoringTier, MonitoringTier>> = {
    strong_link: 'probable_link',
    probable_link: 'standard',
    standard: 'weak_cold',
    weak_cold: 'cold_archive'
  };
  return demote[tier] ?? null;
}

/**
 * Reactivation: a relevant new event (transfer/buy) on a cold wallet warms it
 * back to probable_link so it is polled at normal frequency again. Applies to
 * weak_cold and cold_archive only.
 */
export function reactivationTier(tier: MonitoringTier): MonitoringTier | null {
  if (tier === 'weak_cold' || tier === 'cold_archive') return 'probable_link';
  return null;
}
