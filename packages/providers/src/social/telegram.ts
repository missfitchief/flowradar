// FlowRadar — Telegram INBOUND reader stub (spec §2). Config-gated: returns
// null when SOCIAL_TELEGRAM_READ_TOKEN is absent (graceful missing-key skip,
// mirrors createSolanaTrackerCandidateSource's null contract). When keyed it
// is a TYPED STUB — interface + env gating present, fetchPosts returns []
// with a documented TODO until a verified read integration + group links
// exist (same honesty as the kolscan/gmgn candidate stubs). NO hallucinated
// endpoint. This is a distinct env var from the OUTBOUND alert sender's
// TELEGRAM_BOT_TOKEN (packages/providers/src/telegram.ts) — the outbound
// sender is untouched (spec global constraints 1,2).
//
// TODO(provider): implement a real inbound read (Telegram Bot getUpdates /
// MTProto history) against SOCIAL_TELEGRAM_READ_TOKEN once group links +
// credentials exist, following solanaTracker.ts's fixture-tested-mapper
// pattern. Until then fetchPosts is [] and source health reports 'stub'.
import type { Chain } from '@flowradar/core';
import type { FetchPostsOpts, SocialPostRaw, SocialSourceProvider } from './types';

export interface TelegramSocialEnv {
  SOCIAL_TELEGRAM_READ_TOKEN?: string;
}

export function createTelegramSocialSource(env: TelegramSocialEnv): SocialSourceProvider | null {
  if (!env.SOCIAL_TELEGRAM_READ_TOKEN) return null; // missing key => graceful skip
  return {
    name: 'telegram-inbound',
    platform: 'telegram',
    chains: ['SOLANA'],
    async fetchPosts(_chain: Chain, _opts: FetchPostsOpts = {}): Promise<SocialPostRaw[]> {
      return []; // typed stub — no verified inbound integration yet
    }
  };
}
