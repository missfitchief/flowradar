// FlowRadar — wallet status taxonomy (Phase 0, feat/pre-public-accumulation).
//
// THE single signal-eligibility gate. Wallet.status (schema enum
// WalletStatus) decides whether a wallet may EVER count toward early
// smart-money metrics; this module is the only place that decision is
// encoded. aggregateWindow's isSmart consumes isSignalEligibleStatus — no
// other code may re-derive eligibility from isWatched, stats presence, or
// source strings.
//
// Status semantics (spec, 2026-07-10 pre-public-accumulation refocus):
// - observation_only: polled, activity persisted, ZERO signal weight. The
//   default for every wallet that was not explicitly vetted (provider
//   discovery, flow-graph receivers, unclassified imports).
// - signal_eligible: earned ONLY via operator CSV import, candidate
//   promotion (validation pipeline), or explicit operator action.
// - public_kol / public_promoter: publicly-followed wallets (Phase 1
//   registry). Their buys feed late-stage CROWD ARRIVAL metrics only —
//   public entry is not an early signal by definition.
// - copytrader: follows public wallets (Phase 2 detector). Crowd cohort.
// - bot_or_service: MM/MEV/router/CEX-adjacent operational wallets.
// - excluded: operator-excluded; never polled, never counted.

export type WalletStatus =
  | 'observation_only'
  | 'signal_eligible'
  | 'public_kol'
  | 'public_promoter'
  | 'copytrader'
  | 'bot_or_service'
  | 'excluded';

/** True ONLY for 'signal_eligible' — every other status carries zero early-signal weight. */
export function isSignalEligibleStatus(status: WalletStatus): boolean {
  return status === 'signal_eligible';
}

// ---------------------------------------------------------------------------
// Stats trust taxonomy. WalletStats.source (schema enum StatsSource) keeps
// its compact storage values; this mapping names how much each is trusted:
// numbers an external provider merely CLAIMED vs figures an operator vouched
// for vs FIFO computed locally over real ingested trades vs synthetic
// backtest continuations (machine-marked, never evidence).
// ---------------------------------------------------------------------------

export type StatsSourceValue = 'csv' | 'computed' | 'provider' | 'synthetic';

export type StatsTrust = 'provider_claimed' | 'operator_approved' | 'locally_verified' | 'synthetic';

const TRUST_BY_SOURCE: Record<StatsSourceValue, StatsTrust> = {
  provider: 'provider_claimed',
  csv: 'operator_approved',
  computed: 'locally_verified',
  synthetic: 'synthetic'
};

export function statsTrustOf(source: StatsSourceValue): StatsTrust {
  return TRUST_BY_SOURCE[source];
}
