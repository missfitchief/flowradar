// FlowRadar — MockSocialSource: deterministic inbound posts derived from the
// mock world (spec §2). Selected for ANY SocialSource when MOCK_MODE !==
// 'false' (same convention as MockCandidateSource). Posts are loaded from a
// static fixture whose {{SYMBOL}} placeholders are resolved to the world's
// REAL scenario-token addresses (NOVA/QUIET/SEED), so the extractor links
// them to seeded Token rows and the velocity/overlap panels demo end-to-end.
// Fully deterministic: same world genesis => same posts, same ids, same
// timestamps, always. No Math.random()/Date.now().
import type { Chain } from '@flowradar/core';
import type { MockWorld } from '../mock/world';
import type { FetchPostsOpts, SocialPostRaw, SocialSourceProvider } from './types';
import fixturePosts from '../../test/fixtures/social/mockPosts.json';

interface MockPostTemplate {
  externalId: string;
  author: string;
  offsetMin: number;
  content: string;
}

const SCENARIO_SYMBOLS = ['NOVA', 'QUIET', 'SEED', 'ALPHA', 'BETA', 'DUMP', 'RUGZ'] as const;

export interface MockSocialSourceOpts {
  name?: string;
  platform?: string;
}

export class MockSocialSource implements SocialSourceProvider {
  readonly name: string;
  readonly platform: string;
  readonly chains: Chain[] = ['SOLANA'];
  private readonly world: MockWorld;

  constructor(world: MockWorld, opts: MockSocialSourceOpts = {}) {
    this.world = world;
    this.name = opts.name ?? 'mock-social';
    this.platform = opts.platform ?? 'telegram';
  }

  /** symbol -> real world token address, for the scenario tokens the fixtures reference. */
  private addressBySymbol(): Map<string, string> {
    const map = new Map<string, string>();
    for (const token of this.world.tokens) {
      if (token.chain === 'SOLANA' && (SCENARIO_SYMBOLS as readonly string[]).includes(token.symbol)) {
        map.set(token.symbol, token.address);
      }
    }
    return map;
  }

  private resolve(content: string, addrs: Map<string, string>): string {
    // Replace every {{SYMBOL}} with the real address, or a stable
    // synthetic fallback if that scenario symbol isn't in this world
    // (keeps the post deterministic and still extractable/unlinked).
    return content.replace(/\{\{([A-Z]+)\}\}/g, (_m, sym: string) => {
      return addrs.get(sym) ?? `MockUnlinked${sym}AddressXXXXXXXXXXXXXXXXXXXXXX`;
    });
  }

  async fetchPosts(chain: Chain, opts: FetchPostsOpts = {}): Promise<SocialPostRaw[]> {
    if (chain !== 'SOLANA') return []; // mock world's social scenarios are SOLANA-only
    const addrs = this.addressBySymbol();
    const genesis = this.world.meta.genesis.getTime();
    const templates = fixturePosts as MockPostTemplate[];

    const posts: SocialPostRaw[] = templates.map((t) => ({
      externalId: t.externalId,
      authorHash: `mockauthor-${t.author}`,
      content: this.resolve(t.content, addrs),
      postedAt: new Date(genesis + t.offsetMin * 60_000),
      metadata: { mock: true }
    }));

    // Respect `since` (deterministic filter) and `limit` so the source
    // behaves like a real incremental reader for the ingest job.
    const filtered = opts.since ? posts.filter((p) => p.postedAt > opts.since!) : posts;
    const limit = opts.limit ?? filtered.length;
    return filtered.slice(0, limit);
  }
}
