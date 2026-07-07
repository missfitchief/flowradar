// FlowRadar — inbound social-source connector interface (Social Intelligence
// subsystem, spec §2). Mirrors candidates/types.ts's CandidateSourceProvider,
// but INBOUND: a SocialSourceProvider READS posts from a configured
// Telegram/Discord channel (or the mock world) and hands back raw posts; it
// NEVER sends. The pure extractor/classifier (packages/core/src/social) and
// the socialIngest job (packages/db + apps/worker) turn these raw posts into
// shadow-only SocialMention rows. Solana-only this build (chains=['SOLANA']),
// schema stays chain-aware.
import type { Chain } from '@flowradar/core';

/** One raw inbound post from a social source — pre-extraction, pre-spam-classification. */
export interface SocialPostRaw {
  externalId: string;
  /** Adapter supplies an ALREADY-hashed/opaque author id — NEVER a real handle (spec global constraint: author de-anonymization is out of scope). */
  authorHash?: string;
  content: string;
  url?: string;
  postedAt: Date;
  metadata?: Record<string, unknown>;
}

export interface FetchPostsOpts {
  /** Only return posts newer than this (the source's lastSyncAt); adapters MAY ignore it (mock/stub do). */
  since?: Date;
  limit?: number;
}

/** An inbound reader for one or more chains. `name` should match the SocialSource.name row so the ingest job's resolver can look providers up by name. */
export interface SocialSourceProvider {
  name: string;
  platform: string;
  chains: Chain[];
  fetchPosts(chain: Chain, opts?: FetchPostsOpts): Promise<SocialPostRaw[]>;
}

export type SocialSourceMode = 'live' | 'mock' | 'missing_key' | 'stub';

/** Per-source effective-mode row for the /social source-health panel. Mirrors CandidateSourceStatusRow; never echoes a secret VALUE, only the env var NAME. */
export interface SocialSourceStatusRow {
  sourceName: string;
  platform: string;
  mode: SocialSourceMode;
  note: string;
  /** The env VAR NAME the operator configured for this source's read credential — a NAME only, never a value. null for `manual`/mock sources. */
  apiKeyEnvName: string | null;
}
