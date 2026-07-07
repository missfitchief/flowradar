// FlowRadar — social inbound-provider unit tests (Task C): MockSocialSource
// determinism + world-linked addresses, telegram/discord config-gated stubs
// (null on missing key, [] as stub), and getSocialSourceStatuses mode mapping.
// Parallel-safe: no DB, fetch stubbed, env restored per test.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMockWorld } from '../src/mock/world';
import {
  MockSocialSource,
  createTelegramSocialSource,
  createDiscordSocialSource,
  getSocialSourceStatuses
} from '../src/social';

const GENESIS = new Date('2026-07-05T00:00:00.000Z');
const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function world() {
  return createMockWorld({ genesis: GENESIS });
}

describe('MockSocialSource', () => {
  it('implements SocialSourceProvider with a telegram-default identity', () => {
    const src = new MockSocialSource(world());
    expect(src.platform).toBe('telegram');
    expect(src.name).toBe('mock-social');
    expect(src.chains).toEqual(['SOLANA']);
    expect(typeof src.fetchPosts).toBe('function');
  });

  it('honours name/platform overrides so one instance can back any source', () => {
    const src = new MockSocialSource(world(), { name: 'alpha-callers-tg', platform: 'discord' });
    expect(src.name).toBe('alpha-callers-tg');
    expect(src.platform).toBe('discord');
  });
});

describe('MockSocialSource.fetchPosts', () => {
  it('is deterministic: same world => byte-identical posts', async () => {
    const a = await new MockSocialSource(world()).fetchPosts('SOLANA');
    const b = await new MockSocialSource(world()).fetchPosts('SOLANA');
    expect(a).toEqual(b);
    expect(a.length).toBe(8);
  });

  it('resolves {{SYMBOL}} placeholders to the world\'s REAL scenario-token addresses', async () => {
    const w = world();
    const novaAddr = w.tokens.find((t) => t.symbol === 'NOVA')!.address;
    const posts = await new MockSocialSource(w).fetchPosts('SOLANA');
    const novaCaPost = posts.find((p) => p.externalId === 'tg-0001')!;
    expect(novaCaPost.content).toContain(novaAddr);
    expect(novaCaPost.content).not.toContain('{{NOVA}}');
  });

  it('includes a copy-paste cluster (3 authors, identical content) and a multi-token post for the classifier/velocity demo', async () => {
    const posts = await new MockSocialSource(world()).fetchPosts('SOLANA');
    const cluster = posts.filter((p) => ['tg-0005', 'tg-0006', 'tg-0007'].includes(p.externalId));
    expect(cluster).toHaveLength(3);
    expect(new Set(cluster.map((p) => p.content)).size).toBe(1); // identical content
    expect(new Set(cluster.map((p) => p.authorHash)).size).toBe(3); // 3 distinct authors
    const multi = posts.find((p) => p.externalId === 'tg-0004')!;
    expect(multi.content).toContain('$NOVA');
    expect(multi.content).toContain('$SEED');
  });

  it('never emits a raw author handle — authorHash is an opaque prefixed id', async () => {
    const posts = await new MockSocialSource(world()).fetchPosts('SOLANA');
    expect(posts.every((p) => p.authorHash!.startsWith('mockauthor-'))).toBe(true);
  });

  it('honours `since` and `limit` like an incremental reader', async () => {
    const w = world();
    const genesis = w.meta.genesis.getTime();
    const all = await new MockSocialSource(w).fetchPosts('SOLANA');
    const since = new Date(genesis + 15 * 60_000); // after offsetMin=12, before 20
    const recent = await new MockSocialSource(w).fetchPosts('SOLANA', { since });
    expect(recent.length).toBeLessThan(all.length);
    expect(recent.every((p) => p.postedAt > since)).toBe(true);
    const limited = await new MockSocialSource(w).fetchPosts('SOLANA', { limit: 2 });
    expect(limited).toHaveLength(2);
  });

  it('returns [] for a non-SOLANA chain (Solana-only extraction; no BSC)', async () => {
    const posts = await new MockSocialSource(world()).fetchPosts('BSC');
    expect(posts).toEqual([]);
  });
});

describe('createTelegramSocialSource / createDiscordSocialSource (config-gated stubs)', () => {
  it('telegram: null when SOCIAL_TELEGRAM_READ_TOKEN absent (graceful missing-key skip)', () => {
    expect(createTelegramSocialSource({})).toBeNull();
  });

  it('discord: null when SOCIAL_DISCORD_BOT_TOKEN absent', () => {
    expect(createDiscordSocialSource({})).toBeNull();
  });

  it('telegram: keyed => a stub provider whose fetchPosts is [] with NO network call', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const src = createTelegramSocialSource({ SOCIAL_TELEGRAM_READ_TOKEN: 'k' })!;
    expect(src.platform).toBe('telegram');
    expect(src.chains).toEqual(['SOLANA']);
    expect(await src.fetchPosts('SOLANA')).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('discord: keyed => a stub provider whose fetchPosts is [] with NO network call', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const src = createDiscordSocialSource({ SOCIAL_DISCORD_BOT_TOKEN: 'k' })!;
    expect(src.platform).toBe('discord');
    expect(await src.fetchPosts('SOLANA')).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does NOT reuse the outbound TELEGRAM_BOT_TOKEN env var', () => {
    // The inbound stub keys off SOCIAL_TELEGRAM_READ_TOKEN only; the outbound
    // alert sender's TELEGRAM_BOT_TOKEN must never gate it.
    expect(createTelegramSocialSource({ SOCIAL_TELEGRAM_READ_TOKEN: undefined } as any)).toBeNull();
    const spoofed = { TELEGRAM_BOT_TOKEN: 'outbound' } as Record<string, string>;
    expect(createTelegramSocialSource(spoofed as any)).toBeNull();
  });
});

describe('getSocialSourceStatuses', () => {
  function fakePrisma(rows: { name: string; platform: string; apiKeyEnvName: string | null }[]) {
    return { socialSource: { findMany: async () => rows } } as any;
  }
  const ROWS = [
    { name: 'alpha-callers-tg', platform: 'telegram', apiKeyEnvName: 'SOCIAL_TELEGRAM_READ_TOKEN' },
    { name: 'degen-discord', platform: 'discord', apiKeyEnvName: 'SOCIAL_DISCORD_BOT_TOKEN' },
    { name: 'ops-manual', platform: 'manual', apiKeyEnvName: null }
  ];

  it('MOCK_MODE (default): every row reports mode "mock"', async () => {
    process.env.MOCK_MODE = 'true';
    const statuses = await getSocialSourceStatuses(fakePrisma(ROWS));
    expect(statuses).toHaveLength(3);
    expect(statuses.every((s) => s.mode === 'mock')).toBe(true);
    // NAME is echoed, value never is.
    expect(statuses[0].apiKeyEnvName).toBe('SOCIAL_TELEGRAM_READ_TOKEN');
  });

  it('live mode: manual => stub; keyed telegram/discord => stub; unkeyed => missing_key', async () => {
    process.env.MOCK_MODE = 'false';
    process.env.SOCIAL_TELEGRAM_READ_TOKEN = 'present';
    delete process.env.SOCIAL_DISCORD_BOT_TOKEN;
    const byName = Object.fromEntries(
      (await getSocialSourceStatuses(fakePrisma(ROWS))).map((s) => [s.sourceName, s])
    );
    expect(byName['alpha-callers-tg'].mode).toBe('stub'); // keyed but unverified integration
    expect(byName['degen-discord'].mode).toBe('missing_key'); // no key
    expect(byName['ops-manual'].mode).toBe('stub'); // manual, no reader
  });

  it('live mode: missing-key note names the env var but never a secret value', async () => {
    process.env.MOCK_MODE = 'false';
    delete process.env.SOCIAL_DISCORD_BOT_TOKEN;
    const [row] = await getSocialSourceStatuses(
      fakePrisma([{ name: 'd', platform: 'discord', apiKeyEnvName: 'SOCIAL_DISCORD_BOT_TOKEN' }])
    );
    expect(row.mode).toBe('missing_key');
    expect(row.note).toContain('SOCIAL_DISCORD_BOT_TOKEN');
  });
});
