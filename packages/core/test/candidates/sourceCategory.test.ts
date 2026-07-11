// FlowRadar — candidate source-category taxonomy tests (Task 2 buffer).

import { describe, expect, it } from 'vitest';
import {
  CANDIDATE_SOURCE_CATEGORIES,
  categorizeCandidateSource,
  isPublicFigureCategory
} from '../../src/candidates/sourceCategory';

describe('categorizeCandidateSource', () => {
  it('maps every directive source family', () => {
    expect(categorizeCandidateSource({ source: 'gmgn:track smartmoney' })).toBe('gmgn_smartmoney');
    expect(categorizeCandidateSource({ source: 'gmgn:token traders' })).toBe('gmgn_token_top_trader');
    expect(categorizeCandidateSource({ source: 'gmgn:token holders' })).toBe('gmgn_token_top_trader');
    expect(categorizeCandidateSource({ source: 'gmgn:trenches feed' })).toBe('gmgn_trenches_trader');
    expect(categorizeCandidateSource({ source: 'gmgn:trending wallets' })).toBe('gmgn_trending_trader');
    expect(categorizeCandidateSource({ source: 'lineage:receiver' })).toBe('lineage_receiver');
    expect(categorizeCandidateSource({ source: 'solana_tracker_pnl' })).toBe('solana_tracker_pnl');
    expect(categorizeCandidateSource({ source: 'birdeye_top_traders' })).toBe('birdeye_gainer');
    expect(categorizeCandidateSource({ source: 'birdeye_wallet_pnl' })).toBe('birdeye_gainer');
    expect(categorizeCandidateSource({ source: 'runner_mining:repeat' })).toBe('repeat_runner_candidate');
  });

  it('separates public figures OUT of trader categories (KOL/promoter precedence)', () => {
    expect(categorizeCandidateSource({ source: 'gmgn:track smartmoney', isKolTagged: true })).toBe('public_kol');
    expect(categorizeCandidateSource({ source: 'gmgn:token traders', isPromoterTagged: true })).toBe('public_promoter');
    expect(categorizeCandidateSource({ source: 'gmgn:track kol' })).toBe('public_kol'); // the KOL feed is public by definition
  });

  it('bot detection outranks everything, with EXACT tokens only', () => {
    expect(categorizeCandidateSource({ source: 'gmgn:track smartmoney', isKolTagged: true, rawTags: ['sandwich_bot'] })).toBe('bot_or_service');
    // exact-token discipline: 'robotics' is NOT a bot
    expect(categorizeCandidateSource({ source: 'gmgn:track smartmoney', rawTags: ['robotics'] })).toBe('gmgn_smartmoney');
  });

  it('copytrader tag maps to probable_copytrader (below public flags)', () => {
    expect(categorizeCandidateSource({ source: 'gmgn:track smartmoney', rawTags: ['copytrader'] })).toBe('probable_copytrader');
    expect(categorizeCandidateSource({ source: 'gmgn:track smartmoney', isKolTagged: true, rawTags: ['copytrader'] })).toBe('public_kol');
  });

  it('unknown provenance stays unclassified — never defaulted into a trader category', () => {
    expect(categorizeCandidateSource({ source: 'mystery_feed' })).toBe('unclassified');
    expect(categorizeCandidateSource({ source: 'gmgn:unknown command' })).toBe('unclassified');
  });

  it('taxonomy contains all 12 directive categories + unclassified', () => {
    expect(CANDIDATE_SOURCE_CATEGORIES.length).toBe(13);
    expect(isPublicFigureCategory('public_kol')).toBe(true);
    expect(isPublicFigureCategory('public_promoter')).toBe(true);
    expect(isPublicFigureCategory('gmgn_smartmoney')).toBe(false);
  });
});
