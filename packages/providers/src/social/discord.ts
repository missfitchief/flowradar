// FlowRadar — Discord INBOUND reader stub (spec §2). Config-gated: null when
// SOCIAL_DISCORD_BOT_TOKEN is absent. When keyed it is a TYPED STUB —
// fetchPosts returns [] with a documented TODO. INBOUND ONLY: there is NO
// outbound Discord alert sender in this build (spec global constraint 1).
// NO hallucinated endpoint.
//
// TODO(provider): implement a real inbound read (Discord Gateway / channel
// history via a bot token) against SOCIAL_DISCORD_BOT_TOKEN once channel
// links + credentials exist, following the fixture-tested-mapper pattern.
import type { Chain } from '@flowradar/core';
import type { FetchPostsOpts, SocialPostRaw, SocialSourceProvider } from './types';

export interface DiscordSocialEnv {
  SOCIAL_DISCORD_BOT_TOKEN?: string;
}

export function createDiscordSocialSource(env: DiscordSocialEnv): SocialSourceProvider | null {
  if (!env.SOCIAL_DISCORD_BOT_TOKEN) return null; // missing key => graceful skip
  return {
    name: 'discord-inbound',
    platform: 'discord',
    chains: ['SOLANA'],
    async fetchPosts(_chain: Chain, _opts: FetchPostsOpts = {}): Promise<SocialPostRaw[]> {
      return []; // typed stub — no verified inbound integration yet
    }
  };
}
