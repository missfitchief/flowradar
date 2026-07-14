import { describe, expect, it } from 'vitest';
import { coreAlertDecision, coreMonitoringSince } from '../src/jobs/monitoringScheduler';

describe('Core monitoring alert pipeline guards', () => {
  it('uses a dedicated cursor with a five-minute overlap', () => {
    expect(coreMonitoringSince('2026-07-14T10:00:00.000Z').toISOString()).toBe('2026-07-14T09:55:00.000Z');
  });

  it('falls back to a bounded 24-hour lookback when no real ingest cursor exists', () => {
    expect(coreMonitoringSince(null, new Date('2026-07-14T10:00:00.000Z')).toISOString()).toBe('2026-07-13T10:00:00.000Z');
  });

  it('lets a valid buy through while keeping ordinary transfers silent', () => {
    expect(coreAlertDecision({ kind: 'token_buy', status: 'succeeded', asset: { address: 'mint' } })).toEqual({
      eligible: true, alertType: 'core_wallet_token_buy', rejectionReason: null
    });
    expect(coreAlertDecision({ kind: 'native_transfer', status: 'succeeded', asset: { address: null } })).toEqual({
      eligible: false, alertType: null, rejectionReason: 'silent_transfer_policy'
    });
  });

  it('rejects failed buys and malformed buy records with an explicit reason', () => {
    expect(coreAlertDecision({ kind: 'token_buy', status: 'failed', asset: { address: 'mint' } }).rejectionReason).toBe('failed_transaction');
    expect(coreAlertDecision({ kind: 'token_buy', status: 'succeeded', asset: { address: null } }).rejectionReason).toBe('token_buy_missing_asset');
  });
});
