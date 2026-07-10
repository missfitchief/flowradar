// FlowRadar — wallet status eligibility + stats trust mapping (Phase 0,
// feat/pre-public-accumulation). These two pure functions are THE single
// decision points for (a) whether a wallet may ever count toward early
// smart-money metrics and (b) how much a WalletStats row's numbers are
// trusted. Everything downstream (aggregateWindow, cohort engines) must
// consume these — never re-derive eligibility from isWatched or source
// strings inline.

import { describe, expect, it } from 'vitest';
import { isSignalEligibleStatus, statsTrustOf } from '../src/wallets/status';
import type { WalletStatus } from '../src/wallets/status';

describe('isSignalEligibleStatus', () => {
  const ALL_STATUSES: WalletStatus[] = [
    'observation_only',
    'signal_eligible',
    'public_kol',
    'public_promoter',
    'copytrader',
    'bot_or_service',
    'excluded'
  ];

  it('is true for signal_eligible ONLY — every other status carries zero signal weight', () => {
    for (const status of ALL_STATUSES) {
      expect(isSignalEligibleStatus(status), `status=${status}`).toBe(status === 'signal_eligible');
    }
  });
});

describe('statsTrustOf', () => {
  it('maps every StatsSource value onto the trust taxonomy', () => {
    expect(statsTrustOf('provider')).toBe('provider_claimed');
    expect(statsTrustOf('csv')).toBe('operator_approved');
    expect(statsTrustOf('computed')).toBe('locally_verified');
    expect(statsTrustOf('synthetic')).toBe('synthetic');
  });
});
