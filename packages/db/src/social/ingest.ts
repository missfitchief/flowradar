// FlowRadar — runSocialIngestPass: the Social Intelligence ingest body (Task
// D, Spec §6). Same worker/seed-sharing pattern as every other job body in
// this directory (see externalWalletSource.ts's header) —
// apps/worker/src/jobs/socialIngest.ts is a thin wrapper around this function.
//
// SHADOW-ONLY, INBOUND-ONLY (Spec global constraints 1/3/4): this pass only
// READS configured SocialSource rows and WRITES SocialMention rows. It never
// creates an Alert, never touches FlowScore/Signal/CandidateWallet, and never
// sends anything outbound. Every mention is stored WITH its spamScore, never
// dropped (the UI greys high-spam; see classifySpam's shadow-only note).
//
// For each ENABLED SocialSource row: resolve a SocialSourceProvider by the
// row (resolveSource(sourceRow) => provider | null | undefined — MOCK_MODE /
// missing-key / stub / manual all resolve to null-or-mock at the caller). For
// each chainSupport chain, fetchPosts(chain, { since: lastSyncAt }); per post,
// extract every token mention, hash it, look back for copy-paste across
// authors, classify spam, resolve the Token (or leave tokenId=null — a
// graceful unlinked mention, NOT a skip), and upsert keyed on
// [sourceId, dedupeKey] (idempotent re-ingest). Zero-token posts are counted
// (postsScanned) but stored as zero rows.
//
// Per-source try/catch: a source's resolve/fetch throwing is caught into that
// source's own lastError/status='error'/failCount++ row and NEVER aborts the
// pass for any other enabled source. Per-post try/catch: one malformed post
// throwing is logged and skipped, and NEVER aborts sibling posts in the same
// source (nor marks the source 'error' — the source itself fetched fine).

import type { Prisma, PrismaClient } from '@prisma/client';
import type { Chain, Settings } from '@flowradar/core';
import { extractMentions, normalizeSnippet, contentHash, classifySpam } from '@flowradar/core';
import type { SocialSourceProvider, SocialPostRaw } from '@flowradar/providers';

export interface SocialIngestLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/** Row shape this module needs from SocialSource — narrower than the full Prisma model. */
export interface SocialSourceRow {
  id: string;
  name: string;
  platform: string;
  enabled: boolean;
  chainSupport: string[];
  lastSyncAt: Date | null;
}

/**
 * Resolves a SocialSourceProvider for a given SocialSource row. Returns
 * null/undefined (OR throws) to signal "no reader available for this source" —
 * both are handled gracefully (mirrors CandidateSourceResolver in
 * externalWalletSource.ts). The caller decides mock-vs-live-vs-null: MOCK_MODE
 * => shared MockSocialSource for every source; live => per-platform factory
 * (null when the apiKeyEnvName env value is absent); manual platform => null.
 */
export type SocialSourceResolver = (
  source: SocialSourceRow
) => SocialSourceProvider | null | undefined;

export interface SocialIngestPassResult {
  sourcesConsidered: number;
  sourcesSynced: number;
  sourcesSkippedDisabled: number;
  sourcesSkippedNoProvider: number;
  mentionsUpserted: number;
  postsScanned: number;
  errors: number;
}

const VALID_CHAINS: Chain[] = ['SOLANA', 'BSC'];
const SNIPPET_MAX = 280;

/** dedupeKey per Spec §1: `${externalPostId}::${tokenAddress ?? '$'+tokenSymbol ?? 'none'}`. */
function buildDedupeKey(externalPostId: string, tokenAddress: string | null, tokenSymbol: string | null): string {
  const tokenPart = tokenAddress ?? (tokenSymbol ? `$${tokenSymbol}` : 'none');
  return `${externalPostId}::${tokenPart}`;
}

export async function runSocialIngestPass(
  prisma: PrismaClient,
  settings: Settings,
  resolveSource: SocialSourceResolver,
  log?: SocialIngestLogger
): Promise<SocialIngestPassResult> {
  const allSources = await prisma.socialSource.findMany();
  const spamCfg = settings.connectors.social.spam;

  let sourcesSynced = 0;
  let sourcesSkippedDisabled = 0;
  let sourcesSkippedNoProvider = 0;
  let mentionsUpserted = 0;
  let postsScanned = 0;
  let errors = 0;

  for (const source of allSources) {
    if (!source.enabled) {
      sourcesSkippedDisabled += 1;
      log?.info('socialIngest: source disabled, skipping', { source: source.name });
      continue;
    }

    try {
      const provider = resolveSource({
        id: source.id,
        name: source.name,
        platform: source.platform,
        enabled: source.enabled,
        chainSupport: source.chainSupport,
        lastSyncAt: source.lastSyncAt
      });
      if (!provider) {
        sourcesSkippedNoProvider += 1;
        log?.info('socialIngest: no provider resolved for source, skipping', { source: source.name, platform: source.platform });
        continue;
      }

      let sourcePostsScanned = 0;
      let sourceMentionsUpserted = 0;

      for (const chainRaw of source.chainSupport) {
        if (!VALID_CHAINS.includes(chainRaw as Chain)) continue;
        const chain = chainRaw as Chain;

        const posts = await provider.fetchPosts(chain, { since: source.lastSyncAt ?? undefined });
        for (const post of posts) {
          try {
            sourcePostsScanned += 1;
            const upserted = await ingestPost(prisma, source, post, chain, spamCfg);
            sourceMentionsUpserted += upserted;
          } catch (postErr) {
            // Per-post guard: a single malformed post never aborts its
            // siblings and never marks the SOURCE 'error' (the source fetched
            // fine). Logged and counted; the loop continues.
            errors += 1;
            const message = postErr instanceof Error ? postErr.message : String(postErr);
            log?.error('socialIngest: post ingest error (skipped, source continues)', {
              source: source.name,
              externalPostId: (post as SocialPostRaw)?.externalId,
              error: message
            });
          }
        }
      }

      postsScanned += sourcePostsScanned;
      mentionsUpserted += sourceMentionsUpserted;

      // metadataJson.postsScanned is a cumulative per-source counter (Spec §6/§8
      // source health) — merged onto whatever the row already carries.
      const priorMeta = (source.metadataJson ?? {}) as Record<string, unknown>;
      const priorScanned = typeof priorMeta.postsScanned === 'number' ? priorMeta.postsScanned : 0;

      await prisma.socialSource.update({
        where: { id: source.id },
        data: {
          lastSyncAt: new Date(),
          status: 'ok',
          lastError: null,
          failCount: 0,
          metadataJson: { ...priorMeta, postsScanned: priorScanned + sourcePostsScanned } as Prisma.InputJsonValue
        }
      });
      sourcesSynced += 1;
      log?.info('socialIngest: source sync complete', {
        source: source.name,
        postsScanned: sourcePostsScanned,
        mentionsUpserted: sourceMentionsUpserted
      });
    } catch (err) {
      // Per-source guard: resolve/fetch throwing marks THIS source 'error' and
      // continues the pass (Spec §10 "provider throws => lastError/failCount++/
      // status='error' => continue").
      errors += 1;
      const message = err instanceof Error ? err.message : String(err);
      await prisma.socialSource.update({
        where: { id: source.id },
        data: { status: 'error', lastError: message, failCount: { increment: 1 } }
      });
      log?.error(`socialIngest: provider error for source ${source.name}`, { source: source.name, error: message });
    }
  }

  const summary: SocialIngestPassResult = {
    sourcesConsidered: allSources.length,
    sourcesSynced,
    sourcesSkippedDisabled,
    sourcesSkippedNoProvider,
    mentionsUpserted,
    postsScanned,
    errors
  };
  log?.info('socialIngest cycle complete', { ...summary });
  return summary;
}

/**
 * Extracts every token mention from a single post and upserts one
 * SocialMention row per mention. Returns the number of mentions upserted (0
 * for a zero-token post — counted as scanned by the caller, but stored as no
 * rows, per Spec §1/§6). Shared normalizedSnippet/contentHash across all of a
 * post's mentions (they come from the same content). The contentHash lookback
 * counts DISTINCT authors that have posted this hash in the spam window,
 * driving classifySpam's copypasta rule.
 */
async function ingestPost(
  prisma: PrismaClient,
  source: { id: string; platform: string },
  post: SocialPostRaw,
  chain: Chain,
  spamCfg: Settings['connectors']['social']['spam']
): Promise<number> {
  const mentions = extractMentions(post.content, chain);
  if (mentions.length === 0) return 0;

  const normalized = normalizeSnippet(post.content);
  const hash = contentHash(normalized);
  const contentSnippet = post.content.slice(0, SNIPPET_MAX);
  const normalizedSnippet = normalized.slice(0, SNIPPET_MAX);

  // Copy-paste lookback (Spec §4): DISTINCT authors that have posted this exact
  // contentHash inside the spam window. Includes this post's own author (its
  // row is upserted below, so on re-ingest the count is stable). windowMinutes
  // is measured back from the post's own postedAt.
  const windowStart = new Date(post.postedAt.getTime() - spamCfg.windowMinutes * 60_000);
  const sameHashRows = await prisma.socialMention.findMany({
    where: { contentHash: hash, postedAt: { gte: windowStart } },
    select: { authorHash: true, externalPostId: true }
  });
  const distinctAuthors = new Set<string>();
  for (const row of sameHashRows) if (row.authorHash) distinctAuthors.add(row.authorHash);
  if (post.authorHash) distinctAuthors.add(post.authorHash);

  // Same author's recent post count (repeat_author rule) — distinct posts by
  // this author in the window, this one included.
  let sameAuthorRecentCount = 0;
  if (post.authorHash) {
    const authorPosts = await prisma.socialMention.findMany({
      where: { authorHash: post.authorHash, postedAt: { gte: windowStart } },
      select: { externalPostId: true },
      distinct: ['externalPostId']
    });
    const authorPostIds = new Set(authorPosts.map((r) => r.externalPostId));
    authorPostIds.add(post.externalId);
    sameAuthorRecentCount = authorPostIds.size;
  }

  const alnumLength = normalized.replace(/[^a-z0-9]/g, '').length;

  const { spamScore, spamReason } = classifySpam(
    {
      normalizedSnippet,
      distinctAuthorsSameHash: distinctAuthors.size,
      sameAuthorRecentCount,
      alnumLength
    },
    spamCfg
  );

  let upserted = 0;
  for (const mention of mentions) {
    const tokenAddress = mention.tokenAddress ?? null;
    const tokenSymbol = mention.tokenSymbol ?? null;
    const tokenUrl = mention.tokenUrl ?? null;

    // Token resolve by (chain, address). Missing token => tokenId=null (a
    // graceful UNLINKED mention, NOT a skip — Spec §10). Pure-ticker mentions
    // have no address to resolve, so they are always unlinked here.
    let tokenId: string | null = null;
    if (tokenAddress) {
      const token = await prisma.token.findUnique({
        where: { chain_address: { chain, address: tokenAddress } },
        select: { id: true }
      });
      tokenId = token?.id ?? null;
    }

    const dedupeKey = buildDedupeKey(post.externalId, tokenAddress, tokenSymbol);

    await prisma.socialMention.upsert({
      where: { sourceId_dedupeKey: { sourceId: source.id, dedupeKey } },
      create: {
        sourceId: source.id,
        platform: source.platform,
        externalPostId: post.externalId,
        authorHash: post.authorHash ?? null,
        postedAt: post.postedAt,
        chain,
        contentSnippet,
        normalizedSnippet,
        contentHash: hash,
        mentionType: mention.mentionType,
        tokenAddress,
        tokenSymbol,
        tokenUrl,
        tokenId,
        confidence: mention.confidence,
        spamScore,
        spamReason,
        dedupeKey,
        metadataJson: (post.metadata as Prisma.InputJsonValue) ?? undefined
      },
      // Re-ingest refreshes the derived fields (spam re-classified with the
      // latest lookback; tokenId re-resolved in case the Token now exists) but
      // never changes the identity keys.
      update: {
        contentSnippet,
        normalizedSnippet,
        contentHash: hash,
        tokenId,
        confidence: mention.confidence,
        spamScore,
        spamReason
      }
    });
    upserted += 1;
  }

  return upserted;
}
