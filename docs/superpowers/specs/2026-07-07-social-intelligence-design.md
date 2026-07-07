# FlowRadar Social Intelligence Subsystem — Design Spec

> **For agentic workers:** implement via superpowers:writing-plans → superpowers:subagent-driven-development, task-by-task, following the existing FlowRadar connector/source/adapter conventions.

**Goal:** Add a standalone social-intelligence layer that reads configured Telegram/Discord channels (inbound only), extracts Solana token mentions (contract addresses, `$TICKER` cashtags, and token URLs), filters spam/copy-paste, tracks mention velocity, and surfaces it all as **shadow-only confluence evidence** on a new `/social` page, a token-detail social section, and a wallet-signal overlap view — without touching FlowScore, signal rules, wallet scoring, or production alerts.

**Architecture:** Mirrors the existing `ExternalWalletSource` → `CandidateSourceProvider` → `sourceStatus` → worker-job → `/sources` pattern. A `SocialSource` registry (operator-managed via a manual add/edit UI) drives config-gated inbound platform readers (mock-first). A `socialIngest` worker job fetches posts, runs a pure extractor + spam classifier, and upserts `SocialMention` rows linked to existing `Token` rows when present (gracefully unlinked otherwise). Mock fixtures drive everything until real group links + credentials exist.

**Tech Stack:** Prisma + embedded-postgres (LITE), TypeScript strict, Zod, Next.js 15 / React 19 / Tailwind / shadcn, Vitest. No new runtime deps.

## Global Constraints (operator hard rules — every task inherits these)

1. **Inbound only.** Telegram/Discord are readers that ingest posts. No outbound Discord alert sender.
2. **Do not modify the existing outbound Telegram alert sender** (`packages/providers/src/telegram.ts`) except to share types/config if genuinely needed.
3. **Do not wire social mentions into production alerts.** No `Alert` rows generated from social-only mentions.
4. **Social data is shadow-only confluence/evidence.** Never a primary data source.
5. **No FlowScore formula changes.** `packages/core/src/scoring/flowScore.ts` untouched.
6. **No signal threshold changes.** No changes to rule constants or `evaluateAllRules`.
7. **No wallet scoring changes.** `walletScore.ts` and the candidate/promotion pipeline untouched.
8. **No BSC.** Solana-only extraction; schema stays chain-aware (`ChainId`) but default/only `SOLANA`.
9. **`DUNE_EXECUTE_FRESH=false`; no Dune fresh execution.**
10. **No secrets printed or committed.** `apiKeyEnvName` stores the env var NAME, never a value. `.env` stays gitignored.
11. **Graceful skips everywhere.** No configured sources, missing keys, or missing tokens must degrade to a clean skip + honest empty state, never a crash.
12. **Follow existing conventions** (cuid ids, `ChainId` enum, Json columns, `@@map` snake_case, `probePort(5439)` DB tests, `MOCK_MODE !== 'false'` switch, `force-dynamic` pages).

## Non-Goals (explicitly out of scope this build)

- Outbound social alerts; Discord/Telegram *sending*.
- Feeding social signals into FlowScore or the signal engine.
- A raw `SocialPost` archive table (future normalization; see §11).
- Twitter/X ingestion (schema leaves room; only Telegram + Discord readers are built).
- Real group links / live credentials (adapters ship as config-gated stubs + mock fixtures).
- Author de-anonymization (author identity is stored only as an opaque hash).

---

## 1. Data Model (2 tables + reuse `ChainId`)

`packages/db/prisma/schema.prisma`.

### `SocialSource` (registry — operator-managed)
```
id                 String   @id @default(cuid())
name               String   @unique          // operator label, e.g. "alpha-callers-tg"
platform           String                    // "telegram" | "discord" (String for extensibility)
handle             String                    // group/channel identifier (opaque; may be a placeholder pre-link)
enabled            Boolean  @default(true)
chainSupport       ChainId[]                 // default ["SOLANA"]
apiKeyEnvName      String                    // env VAR NAME for this platform's read credential
rateLimitPerMinute Int      @default(30)
status             String   @default("idle") // idle|ok|error
lastSyncAt         DateTime?
lastError          String?
failCount          Int      @default(0)
addedAt            DateTime @default(now())  // for the manual-add UI display
metadataJson       Json?
mentions           SocialMention[]
@@map("social_sources")
```

### `SocialMention` (extractor output — shadow-only)
```
id                String   @id @default(cuid())
sourceId          String
source            SocialSource @relation(fields: [sourceId], references: [id], onDelete: Cascade)
platform          String
externalPostId    String                     // platform message/post id (dedup)
authorHash        String?                    // opaque author id (NEVER a real handle)
postedAt          DateTime
ingestedAt        DateTime @default(now())
chain             ChainId
contentSnippet    String                     // trimmed raw snippet (display)
normalizedSnippet String                     // lowercased/stripped, for copy-paste grouping
contentHash       String                     // hash(normalizedSnippet) — copy-paste key
mentionType       String                     // "address" | "ticker" | "url"
tokenAddress      String?                    // extracted CA (from CA or URL); null for pure ticker
tokenSymbol       String?                    // extracted $TICKER
tokenUrl          String?                    // extracted token URL if any
tokenId           String?                    // FK→Token when resolvable; null = graceful skip
token             Token?   @relation(fields: [tokenId], references: [id])
confidence        Int                        // 0..100 extraction confidence
spamScore         Int      @default(0)       // 0..100 (higher = more spammy)
spamReason        String?                    // "copypasta" | "low_content" | "repeat_author" | null
dedupeKey         String                     // NON-NULL: `${externalPostId}::${tokenAddress ?? '$'+tokenSymbol ?? 'none'}`
metadataJson      Json?
@@unique([sourceId, dedupeKey])              // idempotent re-ingest (non-null key; NULLs-are-distinct-safe)
@@index([tokenId])
@@index([chain, tokenAddress])
@@index([postedAt])
@@index([contentHash])
@@map("social_mentions")
```
Notes: one post mentioning 2 tokens → 2 rows. Zero-token posts are **not** stored (only counted, see §6/§8 source health). `Token` gets a back-relation `socialMentions SocialMention[]` (relation-only; no column/logic change to Token).

---

## 2. Source Registry / Provider Framework

`packages/providers/src/social/` (mirrors `candidates/`).

### Interface (`types.ts`)
```typescript
export interface SocialPostRaw {
  externalId: string;
  authorHash?: string;          // adapter supplies an already-hashed/opaque id
  content: string;
  url?: string;
  postedAt: Date;
  metadata?: Record<string, unknown>;
}
export interface FetchPostsOpts { since?: Date; limit?: number; }
export interface SocialSourceProvider {
  name: string;                 // matches SocialSource.name
  platform: string;             // "telegram" | "discord"
  chains: Chain[];
  fetchPosts(chain: Chain, opts?: FetchPostsOpts): Promise<SocialPostRaw[]>;
}
```

### Adapters
- **`MockSocialSource`** — deterministic fixture posts (mention seeded mock-world tokens like NOVA/QUIET so overlap + velocity demo end-to-end in `MOCK_MODE`), including some copy-paste/spam and multi-token posts to exercise the classifier. Selected for ANY source when `MOCK_MODE !== 'false'`, same as `MockCandidateSource`.
- **Seed:** `packages/db/src/seed.ts` creates 2 example `SocialSource` rows (1 telegram, 1 discord, enabled) so `MOCK_MODE` demonstrates the pipeline end-to-end; the `/social` empty state is what renders when no sources exist (fresh operator / all deleted).
- **`createTelegramSocialSource(env)`** / **`createDiscordSocialSource(env)`** — config-gated live factories. Return `null` when the source's `apiKeyEnvName` env value is absent (graceful skip). Ship as **typed stubs**: interface + env gating present, `fetchPosts` returns `[]` with a documented `TODO(provider)` until real read credentials + group links exist (mirrors the `kolscan`/`gmgn`/`cielo` stub honesty). No hallucinated endpoints. Distinct env var NAMES from the outbound alert sender (e.g. `SOCIAL_TELEGRAM_READ_TOKEN`, `SOCIAL_DISCORD_BOT_TOKEN`) — the existing `TELEGRAM_BOT_TOKEN` is not reused.
- **`getSocialSourceStatuses(prisma)`** → `{ sourceName, platform, mode: 'live'|'mock'|'missing_key'|'stub', note }[]` (mirrors `getCandidateSourceStatuses`).
- Live adapters cached per source name (same `Map` pattern as `liveProviderCache`) so the rate limiter is shared.

---

## 3. Extraction (pure — `packages/core/src/social/`)

### `extractMentions(content: string, chain: Chain): ExtractedMention[]`
Pure. Detects, on `chain === 'SOLANA'`:
- **Contract addresses:** base58, length 32–44, excluding obvious false positives → `{ mentionType: 'address', tokenAddress, confidence: 90 }`.
- **Token URLs:** dexscreener.com/solana/`<addr>`, birdeye.so/token/`<addr>`, pump.fun/`<addr>`, solscan.io/token/`<addr>`, jup.ag/…`<addr>` → extract embedded address → `{ mentionType: 'url', tokenAddress, tokenUrl, confidence: 85 }`.
- **Cashtags:** `$TICKER` (2–10 uppercase alnum) → `{ mentionType: 'ticker', tokenSymbol, confidence: 40 }`.
Dedup within a post by resolved `tokenAddress` (an address + its URL for the same token collapse to one). Returns `[]` for no-token posts.

### `normalizeSnippet(content: string): string`
Lowercase, strip URLs/emojis/mentions/extra whitespace/punctuation → the copy-paste comparison key. `contentHash = sha256(normalizeSnippet(content))` (Node `crypto`).

---

## 4. Spam / Copy-Paste Filtering (pure classifier + job-supplied context)

`packages/core/src/social/classifySpam.ts`.
```typescript
export interface SpamContext {
  normalizedSnippet: string;
  distinctAuthorsSameHash: number;   // # distinct authors posting this contentHash in the window
  sameAuthorRecentCount: number;     // # posts by this author in the window
  alnumLength: number;               // length after stripping urls/emojis
}
export function classifySpam(ctx: SpamContext, cfg: SocialSpamConfig): { spamScore: number; spamReason: string | null };
```
Rules (all configurable, see §7): `copypasta` when `distinctAuthorsSameHash >= copypastaAuthorMin`; `repeat_author` when `sameAuthorRecentCount >= repeatAuthorMin`; `low_content` when `alnumLength < lowContentMinChars`. Score is the max of the triggered rule weights (0–100). **Shadow-only: mentions are stored with their score, never dropped**; the UI filters/greys high-spam (≥ `uiHideThreshold`). The job supplies `distinctAuthorsSameHash` via a `contentHash` lookback query.

---

## 5. Mention Velocity (pure — computed on read, not stored)

`packages/core/src/social/mentionVelocity.ts`.
```typescript
export function computeMentionVelocity(
  mentions: { tokenId: string | null; tokenAddress: string | null; authorHash: string | null; postedAt: Date; spamScore: number }[],
  now: Date,
  cfg: { windowsMin: number[]; spamMaxScore: number }
): MentionVelocityRow[];  // per token: counts per window, distinctAuthors per window, accel (short vs long window rate)
```
Excludes mentions with `spamScore > spamMaxScore`. Windows default `[60, 360, 1440]` (1h/6h/24h). Distinct-author dominated (10 mentions from 1 author ≠ 10 from 10 authors). Displayed on `/social` and the token social section.

---

## 6. Worker Job — `socialIngest` (`apps/worker/src/jobs/socialIngest.ts`)

Mirrors `externalWalletSource.ts`. Registered in `apps/worker/src/index.ts` on `settings.connectors.socialSyncHours * 3600` (WORKER_FAST override applies).
Flow per pass:
1. Load **enabled** `SocialSource` rows.
2. Resolve provider: `MOCK_MODE` → shared `MockSocialSource`; live → per-platform factory; `null` → skip (log).
3. Per chain in `chainSupport`: `fetchPosts(chain, { since: lastSyncAt })`.
4. Per post: `extractMentions`; for each mention compute `normalizeSnippet`/`contentHash`, look up `distinctAuthorsSameHash` (lookback query), `classifySpam`, resolve `tokenId` via `Token.findUnique({ chain, address })` if `tokenAddress` present (else `tokenId=null` — **missing-token skip**), **upsert** `SocialMention` (unique key idempotent).
5. Update source `status/lastSyncAt/lastError/failCount`. Per-source + per-post `try/catch` → catch, record, continue (never abort). Zero-token posts increment a per-source `postsScanned` counter in `metadataJson` for source health.

---

## 7. Settings Additions (`packages/core/src/settings.ts`)

Extend `ConnectorsSchema` with a `social` object (Zod + DEFAULT_SETTINGS):
```typescript
social: {
  syncHours: 6,
  spam: { copypastaAuthorMin: 3, repeatAuthorMin: 5, lowContentMinChars: 12, windowMinutes: 360, weights: { copypasta: 80, repeat_author: 60, low_content: 50 }, uiHideThreshold: 70 },
  velocityWindowsMin: [60, 360, 1440]
}
```
Per-source enable lives on `SocialSource.enabled` (UI-managed), not a settings Record. `parseSettings` deep-merge keeps existing configs valid.

---

## 8. Web UI (`apps/web`)

All pages `export const dynamic = 'force-dynamic'`, Card-based, dark theme, added to the sidebar (`components/layout/sidebar`).

### `/social` (`app/social/page.tsx`)
- **Empty state** when 0 sources or 0 mentions: honest message + a "Add a source" affordance.
- **Recent mentions feed**: token (linked chip → `/tokens/[id]`, or "unlinked · `<addr/ticker>`"), source, platform, snippet, postedAt, spam badge; high-spam (≥ `uiHideThreshold`) collapsed/greyed by default.
- **Mention velocity** panel: top tokens by 1h/6h/24h mention count + distinct authors + accel.
- **Wallet-signal overlap** panel (§9).
- **Manage sources** section: add/edit/enable/delete form (client component, `ImportForm` pattern) + inline **source health** (mode badge from `getSocialSourceStatuses`, `apiKeyEnvName`, lastSync age, lastError, mention/postsScanned counts via `groupBy`).

### Token detail social section (`app/tokens/[id]/page.tsx`)
Add a **"Social mentions"** section (shadow-only): this token's recent `SocialMention` rows (spam-filtered) + its mention velocity. Read-only; no change to existing token scoring/flow display.

### API routes (`app/api/social/sources/route.ts`)
- `POST` create, `PATCH` edit/toggle `enabled`, `DELETE` remove a `SocialSource`. Zod-validated; `apiKeyEnvName` accepted as a name only. Mirrors `PATCH /api/sources` + `POST /api/import`. On success client `router.refresh()`.

---

## 9. Wallet-Signal Overlap (read-only confluence display)

`packages/db/src/social/overlap.ts` (query helper): join `SocialMention.tokenId` to tokens that ALSO have recent wallet-driven evidence (`Signal` rows and/or `TokenFlowSnapshot`) in a window → return rows `{ token, socialMentionCount, distinctAuthors, latestFlowScore, firedSignals[] }`. Rendered on `/social` as a "Social + smart-money confluence" panel and referenced in the token social section. **Read-only, shadow-only** — no scoring, no alerts, no writes.

---

## 10. Error Handling / Graceful Skips (must be tested)

- No sources configured → `/social` empty state; job logs "0 sources", no error.
- Source `enabled=false` → job skips it.
- Missing key → factory returns `null` → job skips, source health shows `missing_key`.
- Live adapter stub → returns `[]`, source health shows `stub`.
- Provider throws → catch → `lastError`/`failCount++`/`status='error'` → continue.
- Extracted token not in DB → mention stored with `tokenId=null` (unlinked); UI shows "unlinked".
- Pure `$TICKER` with no address → stored unlinked (`tokenSymbol` set, `tokenId=null`).

---

## 11. Testing Plan

- **core (unit, parallel):** `extractMentions` (address / URL-embedded address / cashtag / none / mixed / false-positive base58); `normalizeSnippet` + `contentHash` stability; `classifySpam` (each reason + clean); `computeMentionVelocity` (window counts, distinct-author dominance, spam exclusion).
- **providers (unit, parallel):** `MockSocialSource` determinism; telegram/discord factories return `null` on missing key and `[]` as stubs; `getSocialSourceStatuses` mode mapping (`vi.stubGlobal('fetch')` where relevant).
- **db (integration, `probePort(5439)` skipIf, prefix cleanup, serialized):** `socialIngest` upsert + dedup idempotency; token link vs graceful skip; spam lookback; disabled/missing-source skips; wallet-signal overlap join.
- **web:** `/social` empty state + populated render; token social section render.
- `npm run verify` green on a clean/rebuilt DB.

---

## 12. Future (explicitly deferred)

Normalize into a raw `SocialPost` table if raw-message archival/audit is needed; add Twitter/X reader; consider (separately, behind its own approval) feeding a spam-filtered, author-diverse social-velocity signal into the scoring/shadow layer. None of this is in this build.
