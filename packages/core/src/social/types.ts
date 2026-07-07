// FlowRadar — social intelligence: shared pure types.
//
// packages/core is PURE (zero I/O, zod is the only runtime dep; no Node
// builtins — contentHash uses a pure-JS hash so @flowradar/core stays safe to
// import from client bundles). These types are the contract every
// later social task (providers ingest, socialIngest worker job, db helpers,
// web token-social-section) imports from @flowradar/core.
//
// Spec §3 (extraction), §4 (spam), §5 (velocity), §7 (settings config).

/** One resolved token mention extracted from a single post (spec §3). */
export interface ExtractedMention {
  mentionType: 'address' | 'ticker' | 'url';
  /** Extracted contract address (from a CA or a token URL); null for a pure ticker. */
  tokenAddress: string | null;
  /** Extracted $TICKER symbol (uppercase, no `$`); null when not a cashtag. */
  tokenSymbol: string | null;
  /** The source token URL when mentionType==='url'; null otherwise. */
  tokenUrl: string | null;
  /** 0..100 extraction confidence (address 90, url 85, ticker 40). */
  confidence: number;
}

/** Spam classification reasons (spec §4). Maps to SocialMention.spamReason. */
export type SpamReason = 'copypasta' | 'repeat_author' | 'low_content';

/** Per-mention spam context (the job supplies the two window counts via lookback queries). */
export interface SpamContext {
  normalizedSnippet: string;
  /** # distinct authors who posted this contentHash in the lookback window. */
  distinctAuthorsSameHash: number;
  /** # posts by THIS author in the lookback window. */
  sameAuthorRecentCount: number;
  /** Length of the content after stripping urls/emojis/punctuation (from normalizeSnippet's alnum core). */
  alnumLength: number;
}

/** Tunable spam thresholds/weights (spec §7 → settings.connectors.social.spam). */
export interface SocialSpamConfig {
  copypastaAuthorMin: number;
  repeatAuthorMin: number;
  lowContentMinChars: number;
  windowMinutes: number;
  weights: {
    copypasta: number;
    repeat_author: number;
    low_content: number;
  };
  uiHideThreshold: number;
}

/** The `social` block inside settings.connectors (spec §7). */
export interface SocialConfig {
  syncHours: number;
  spam: SocialSpamConfig;
  velocityWindowsMin: number[];
}

/** One mention row fed into computeMentionVelocity (spec §5). */
export interface MentionVelocityInput {
  tokenId: string | null;
  tokenAddress: string | null;
  authorHash: string | null;
  postedAt: Date;
  spamScore: number;
}

/** Per-token velocity output: counts + distinct-author counts per window, plus accel. */
export interface MentionVelocityRow {
  tokenId: string | null;
  tokenAddress: string | null;
  windows: { windowMin: number; count: number; distinctAuthors: number }[];
  /**
   * Acceleration: shortest-window per-minute mention rate divided by the
   * longest-window per-minute mention rate. >1 = accelerating, <1 = cooling,
   * 0 when the long window has no qualifying mentions.
   */
  accel: number;
}
