// FlowRadar — candidate-source taxonomy (GMGN behavior plan Task 3 /
// directive Task 2: candidate buffer).
//
// Pure classification of a candidate-buffer provenance row into the canonical
// source-category taxonomy. The category NEVER grants anything — it is a
// labeling of WHERE a candidate was seen (and whether the provider marked it
// as a public figure / bot), used for buffer reporting and later behavior
// analysis. Public KOLs/promoters are deliberately separated OUT of the
// trader categories so no downstream consumer can mistake crowd-followed
// wallets for stealth candidates. Unknown provenance stays 'unclassified' —
// missing data is unknown, never defaulted into a trader category.

export const CANDIDATE_SOURCE_CATEGORIES = [
  'gmgn_smartmoney',
  'gmgn_token_top_trader',
  'gmgn_trenches_trader',
  'gmgn_trending_trader',
  'public_kol',
  'public_promoter',
  'probable_copytrader',
  'lineage_receiver',
  'solana_tracker_pnl',
  'birdeye_gainer',
  'repeat_runner_candidate',
  'bot_or_service',
  'unclassified'
] as const;

export type CandidateSourceCategory = (typeof CANDIDATE_SOURCE_CATEGORIES)[number];

export interface CandidateSourceInput {
  /** The provenance string persisted on the candidate row (e.g. 'gmgn:track smartmoney', 'birdeye_top_traders'). */
  source: string;
  /** Provider marked this wallet as a KOL on the observation. */
  isKolTagged?: boolean;
  /** Provider marked this wallet as a promoter/influencer. */
  isPromoterTagged?: boolean;
  /** Raw provider label tokens (lowercased exact tokens, e.g. from wallet_tag_v2/tags). */
  rawTags?: string[];
}

/** EXACT label tokens (same discipline as gmgn ingest's detectKol/detectPromoter —
 *  never substring matching, so 'robotics' can't read as a bot). */
const BOT_TOKENS = new Set(['bot', 'mev_bot', 'arb_bot', 'sandwich_bot', 'sniper_bot', 'trading_bot', 'bundler']);
const COPYTRADER_TOKENS = new Set(['copytrader', 'copy_trader', 'copy_trade', 'copytrading']);

/**
 * Resolves the canonical category for one provenance row. Precedence:
 * bot/service > public KOL > public promoter > copytrader tag > the source
 * string's own family. Bot detection outranks everything (a bot tagged as
 * KOL is still a bot for buffer purposes); public-figure flags outrank the
 * trader families (a KOL seen in the smartmoney feed is categorized
 * public_kol, never gmgn_smartmoney — the separation the directive requires).
 */
export function categorizeCandidateSource(input: CandidateSourceInput): CandidateSourceCategory {
  const tags = (input.rawTags ?? []).map((t) => t.toLowerCase().trim());
  if (tags.some((t) => BOT_TOKENS.has(t))) return 'bot_or_service';
  if (input.isKolTagged === true) return 'public_kol';
  if (input.isPromoterTagged === true) return 'public_promoter';
  if (tags.some((t) => COPYTRADER_TOKENS.has(t))) return 'probable_copytrader';

  const s = input.source.toLowerCase().trim();
  if (s.startsWith('gmgn:')) {
    const cmd = s.slice('gmgn:'.length).trim();
    if (cmd.includes('smartmoney')) return 'gmgn_smartmoney';
    if (cmd.includes('kol')) return 'public_kol'; // the KOL feed is public by definition
    if (cmd.includes('traders') || cmd.includes('holders')) return 'gmgn_token_top_trader';
    if (cmd.includes('trenches')) return 'gmgn_trenches_trader';
    if (cmd.includes('trending')) return 'gmgn_trending_trader';
    return 'unclassified';
  }
  if (s.startsWith('lineage:') || s === 'lineage_receiver') return 'lineage_receiver';
  if (s === 'solana_tracker_pnl' || s.startsWith('solana_tracker')) return 'solana_tracker_pnl';
  if (s.startsWith('birdeye')) return 'birdeye_gainer';
  if (s.startsWith('runner_mining') || s.startsWith('runnermining') || s === 'repeat_runner_candidate') {
    return 'repeat_runner_candidate';
  }
  return 'unclassified';
}

/** True when the category identifies a PUBLIC figure (crowd-followed) — these
 *  never increase early-stealth signals and are reported separately. */
export function isPublicFigureCategory(category: CandidateSourceCategory): boolean {
  return category === 'public_kol' || category === 'public_promoter';
}
