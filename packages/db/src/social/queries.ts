// FlowRadar — social read helpers (Task E, spec §8/§10). SHADOW-ONLY:
// these are pure reads over SocialSource/SocialMention. They never write,
// never touch FlowScore/Signal/CandidateWallet, and never drop rows by spam
// (the UI collapses high-spam; storage keeps everything — spec constraint 4/11).
import type { PrismaClient, Prisma } from '@prisma/client';

export interface RecentMentionRow {
  id: string;
  platform: string;
  sourceName: string;
  sourceTrustTier: string;
  postedAt: Date;
  chain: string;
  mentionType: string;
  contentSnippet: string;
  spamScore: number;
  spamReason: string | null;
  tokenId: string | null;
  tokenSymbol: string | null;
  tokenAddress: string | null;
  authorHash: string | null;
}

export interface SocialSourceHealthRow {
  id: string;
  name: string;
  platform: string;
  trustTier: string;
  enabled: boolean;
  apiKeyEnvName: string | null;
  chainSupport: string[];
  rateLimitPerMinute: number;
  status: string;
  lastSyncAt: Date | null;
  lastError: string | null;
  failCount: number;
  mentionCount: number;
  postsScanned: number;
}

const MENTION_INCLUDE = {
  source: { select: { name: true, trustTier: true } },
  token: { select: { symbol: true } }
} as const;

type MentionWithRels = Prisma.SocialMentionGetPayload<{ include: typeof MENTION_INCLUDE }>;

function toRecentMentionRow(m: MentionWithRels): RecentMentionRow {
  return {
    id: m.id,
    platform: m.platform,
    sourceName: m.source.name,
    sourceTrustTier: m.source.trustTier,
    postedAt: m.postedAt,
    chain: m.chain,
    mentionType: m.mentionType,
    contentSnippet: m.contentSnippet,
    spamScore: m.spamScore,
    spamReason: m.spamReason,
    tokenId: m.tokenId,
    // Prefer the linked Token's symbol; fall back to the extracted ticker for unlinked rows.
    tokenSymbol: m.token?.symbol ?? m.tokenSymbol,
    tokenAddress: m.tokenAddress,
    authorHash: m.authorHash
  };
}

/**
 * Newest-first recent mentions across all sources. NEVER drops by spam by
 * default (shadow-only). `includeSpamAtOrAbove` is an OPTIONAL ceiling used
 * only if a caller ever wants to pre-filter server-side; the UI does its own
 * collapse instead, so the page passes it undefined.
 */
export async function getRecentMentions(
  prisma: PrismaClient,
  opts?: { limit?: number; includeSpamAtOrAbove?: number }
): Promise<RecentMentionRow[]> {
  const rows = await prisma.socialMention.findMany({
    orderBy: { postedAt: 'desc' },
    take: opts?.limit ?? 100,
    include: MENTION_INCLUDE,
    ...(opts?.includeSpamAtOrAbove !== undefined
      ? { where: { spamScore: { lt: opts.includeSpamAtOrAbove } } }
      : {})
  });
  return rows.map(toRecentMentionRow);
}

// NOTE: getTokenSocialMentions is NOT defined here — Task F appends it to this
// same file with its own canonical shape (raw Prisma rows via
// include: { source: { select: { name, platform, trustTier } } }).

/**
 * Per-source health: all SocialSource rows (enabled or not) with their
 * stored mention count and the postsScanned counter the ingest job keeps in
 * metadataJson (spec §6). Pure read.
 */
export async function getSocialSourceHealth(prisma: PrismaClient): Promise<SocialSourceHealthRow[]> {
  const [sources, grouped] = await Promise.all([
    prisma.socialSource.findMany({ orderBy: { name: 'asc' } }),
    prisma.socialMention.groupBy({ by: ['sourceId'], _count: { _all: true } })
  ]);
  const countBySource = new Map<string, number>();
  for (const g of grouped) countBySource.set(g.sourceId, g._count._all);

  return sources.map((s) => {
    const meta = (s.metadataJson ?? {}) as Record<string, unknown>;
    const postsScanned = typeof meta.postsScanned === 'number' ? meta.postsScanned : 0;
    return {
      id: s.id,
      name: s.name,
      platform: s.platform,
      trustTier: s.trustTier,
      enabled: s.enabled,
      apiKeyEnvName: s.apiKeyEnvName,
      chainSupport: s.chainSupport as string[],
      rateLimitPerMinute: s.rateLimitPerMinute,
      status: s.status,
      lastSyncAt: s.lastSyncAt,
      lastError: s.lastError,
      failCount: s.failCount,
      mentionCount: countBySource.get(s.id) ?? 0,
      postsScanned
    };
  });
}
