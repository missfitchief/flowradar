import { describe, expect, it } from 'vitest';
import { coreAlertDecision, coreMonitoringSince } from '../src/jobs/monitoringScheduler';

describe('Core monitoring alert pipeline guards', () => {
  it('uses a dedicated cursor with a five-minute overlap', () => {
    expect(coreMonitoringSince('2026-07-14T10:00:00.000Z').toISOString()).toBe('2026-07-14T09:55:00.000Z');
  });

  it('falls back to a bounded 24-hour lookback when no real ingest cursor exists', () => {
    expect(coreMonitoringSince(null, new Date('2026-07-14T10:00:00.000Z')).toISOString()).toBe('2026-07-13T10:00:00.000Z');
  });

  it('persists a qualifying solo buy without making it push-alert eligible', () => {
    expect(coreAlertDecision({ kind: 'token_buy', status: 'succeeded', asset: { address: 'mint', amountUsd: 100 } })).toEqual({
      eligible: false, alertType: null, rejectionReason: 'solo_core_buy_no_confluence'
    });
    expect(coreAlertDecision({ kind: 'native_transfer', status: 'succeeded', asset: { address: null, amountUsd: 1_000 } })).toEqual({
      eligible: false, alertType: null, rejectionReason: 'silent_transfer_policy'
    });
  });

  it('rejects failed, unpriced, below-threshold, and malformed buys with an explicit reason', () => {
    expect(coreAlertDecision({ kind: 'token_buy', status: 'failed', asset: { address: 'mint', amountUsd: 100 } }).rejectionReason).toBe('failed_transaction');
    expect(coreAlertDecision({ kind: 'token_buy', status: 'succeeded', asset: { address: null, amountUsd: 100 } }).rejectionReason).toBe('token_buy_missing_asset');
    expect(coreAlertDecision({ kind: 'token_buy', status: 'succeeded', asset: { address: 'mint', amountUsd: null } }).rejectionReason).toBe('usd_value_unavailable');
    expect(coreAlertDecision({ kind: 'token_buy', status: 'succeeded', asset: { address: 'mint', amountUsd: 99.99 } }).rejectionReason).toBe('below_minimum_buy_threshold');
  });
});
