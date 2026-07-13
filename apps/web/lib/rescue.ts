// FlowRadar — shared presentation helpers for the operator (rescue) views.
// Pure formatting/labeling only — no domain logic, no I/O.

export const STATE_LABEL: Record<string, string> = {
  WATCHING: 'Watching',
  STEALTH_ACCUMULATION: 'Stealth accumulation',
  EARLY_INDEPENDENT_CONFIRMATION: 'Early independent confirmation',
  PUBLIC_KOL_ARRIVAL: 'Public / KOL arrival',
  CROWD_EXPANSION: 'Crowd expansion',
  DISTRIBUTION_RISK: 'Distribution risk',
  INVALIDATED: 'Invalidated'
};

export const STATE_DESCRIPTION: Record<string, string> = {
  WATCHING: 'At least one qualified wallet bought, but the evidence is not yet strong enough to call it accumulation.',
  STEALTH_ACCUMULATION: 'Two or more independent qualified entities are buying while the token is still quiet — no KOL or crowd involvement observed.',
  EARLY_INDEPENDENT_CONFIRMATION: 'Three or more independent qualified entities have bought — the strongest pre-public pattern this system tracks.',
  PUBLIC_KOL_ARRIVAL: 'A known KOL / promoter / copytrader wallet has bought — the quiet phase is over.',
  CROWD_EXPANSION: 'Retail buyer count now far exceeds the qualified cohort — late-stage.',
  DISTRIBUTION_RISK: 'Qualified buyers are exiting or distributing — treat any position as at risk.',
  INVALIDATED: 'The token outcome is a rug/failed launch — kept for the record, not actionable.'
};

export const STATE_BADGE_CLASS: Record<string, string> = {
  WATCHING: 'bg-zinc-500/15 text-zinc-300',
  STEALTH_ACCUMULATION: 'bg-emerald-500/15 text-emerald-300',
  EARLY_INDEPENDENT_CONFIRMATION: 'bg-sky-500/15 text-sky-300',
  PUBLIC_KOL_ARRIVAL: 'bg-amber-500/15 text-amber-300',
  CROWD_EXPANSION: 'bg-orange-500/15 text-orange-300',
  DISTRIBUTION_RISK: 'bg-red-500/15 text-red-300',
  INVALIDATED: 'bg-red-900/30 text-red-400'
};

export const CLASSIFICATION_LABEL: Record<string, string> = {
  true_positive: 'Caught',
  false_positive: 'False alert',
  miss: 'Missed',
  true_negative: 'Correct rejection'
};

export const CLASSIFICATION_LONG: Record<string, string> = {
  true_positive: 'Caught — a real historical $10M+ runner that FlowRadar would have flagged at the evaluation moment.',
  false_positive: 'False alert — a control token FlowRadar would have flagged, but it did not run.',
  miss: 'Missed — a real runner FlowRadar did NOT flag; the evidence never met the rule.',
  true_negative: 'Correct rejection — a control token FlowRadar correctly did not flag.'
};

export const CLASSIFICATION_BADGE_CLASS: Record<string, string> = {
  true_positive: 'bg-emerald-500/15 text-emerald-300',
  false_positive: 'bg-red-500/15 text-red-300',
  miss: 'bg-amber-500/15 text-amber-300',
  true_negative: 'bg-zinc-500/15 text-zinc-300'
};

/** Plain-English rendering of the machine reason codes. */
export function explainReason(code: string): string {
  if (code.startsWith('independent_entities:')) {
    return `${code.split(':')[1]} independent qualified entities bought`;
  }
  if (code.startsWith('kol_or_copytrader_buyers:')) {
    return `${code.split(':')[1]} KOL/copytrader wallet(s) among the buyers`;
  }
  if (code.startsWith('non_cohort_buyers_')) {
    return 'retail buyers now far outnumber the qualified cohort';
  }
  if (code.startsWith('distribution_behavior_')) {
    return 'qualified buyers show exit/distribution behavior on this token';
  }
  if (code.startsWith('unpriced_only_buyers_excluded_from_state:')) {
    return `${code.split(':')[1]} buyer(s) had no priceable trades — excluded from the evidence`;
  }
  switch (code) {
    case 'single_entity_observed':
      return 'only one qualified entity observed so far';
    case 'token_outcome_invalidated':
      return 'token outcome was a rug or failed launch';
    case 'unpriced_only_coverage_signal_impossible':
      return 'all observed buys were unpriceable — a signal is impossible under the honesty rules';
    default:
      return code.replaceAll('_', ' ');
  }
}

export function shortAddr(a: string): string {
  return a.length > 12 ? `${a.slice(0, 5)}…${a.slice(-4)}` : a;
}

export function fmtPct(x: number | null | undefined, digits = 0): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return 'unknown';
  return `${(x * 100).toFixed(digits)}%`;
}

export function fmtMult(from: number | null, to: number | null): string | null {
  if (from === null || to === null || from <= 0) return null;
  const m = to / from;
  return m >= 10 ? `${Math.round(m)}×` : `${m.toFixed(1)}×`;
}

/** What evidence is missing for a WATCHING row — the operator's next question. */
export function missingEvidence(row: {
  independentEntityCount: number;
  qualifiedBuyerCount: number;
  currentMcapUsd: unknown;
  dormantReactivations: number;
  fundedPathCount: number;
  receiptsJson: unknown;
}): string[] {
  const missing: string[] = [];
  const receipts = (row.receiptsJson ?? {}) as { unpricedOnlyBuyersThisMint?: number };
  if (row.independentEntityCount < 2) {
    missing.push('needs a second INDEPENDENT qualified entity to reach “stealth accumulation”');
  }
  if ((receipts.unpricedOnlyBuyersThisMint ?? 0) > 0) {
    missing.push(`${receipts.unpricedOnlyBuyersThisMint} buyer(s) have only unpriceable trades — valuation coverage would unlock their evidence`);
  }
  if (row.currentMcapUsd === null) {
    missing.push('no market-cap observation for this token yet');
  }
  if (row.dormantReactivations === 0 && row.fundedPathCount === 0) {
    missing.push('no dormancy or funding-path evidence recorded at the entry events');
  }
  return missing;
}
