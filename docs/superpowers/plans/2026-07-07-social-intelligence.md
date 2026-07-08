# Social Intelligence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to execute this plan, task-by-task, following the existing FlowRadar connector/source/adapter conventions.

**Goal:** Add a standalone, shadow-only social-intelligence layer that reads configured Telegram/Discord channels (inbound only), extracts Solana token mentions, filters spam/copy-paste, tracks mention velocity, and surfaces it as confluence evidence on a new `/social` page, a token-detail social section, and a wallet-signal overlap view — without touching FlowScore, signal rules, wallet scoring, or production alerts.

**Architecture:** Mirrors the existing `ExternalWalletSource` → `CandidateSourceProvider` → `sourceStatus` → worker-job → `/sources` pattern. A `SocialSource` registry (operator-managed via a manual add/edit UI) drives config-gated inbound platform readers (mock-first); a `socialIngest` worker job fetches posts, runs a pure extractor + spam classifier, and upserts `SocialMention` rows linked to existing `Token` rows when present (gracefully unlinked otherwise). Mock fixtures drive everything until real group links + credentials exist.

**Tech Stack:** Prisma + embedded-postgres (LITE), TypeScript strict, Zod, Next.js 15 / React 19 / Tailwind / shadcn, Vitest. No new runtime deps.

## Global Constraints

1. **Inbound only.** Telegram/Discord are readers that ingest posts. No outbound Discord alert sender.
2. **Do not modify the existing outbound Telegram alert sender** (`packages/providers/src/telegram.ts`) except to share types/config if genuinely needed.
3. **Do not wire social mentions into production alerts.** No `Alert` rows generated from social-only mentions.
4. **Social data is shadow-only confluence/evidence.** Never a primary data source.
5. **No FlowScore formula changes.** `packages/core/src/scoring/flowScore.ts` untouched.
6. **No signal threshold changes.** No changes to rule constants or `evaluateAllRules`.
7. **No wallet scoring or CandidateWallet changes.** `walletScore.ts`, the `CandidateWallet` model, and the candidate/promotion pipeline are untouched (social is entirely separate from the wallet-candidate pipeline).
8. **No BSC.** Solana-only extraction; schema stays chain-aware (`ChainId`) but default/only `SOLANA`.
9. **`DUNE_EXECUTE_FRESH=false`; no Dune fresh execution.**
10. **No secrets printed or committed.** `apiKeyEnvName` stores the env var NAME, never a value. `.env` stays gitignored.
11. **Graceful skips everywhere.** No configured sources, missing keys, or missing tokens must degrade to a clean skip + honest empty state, never a crash.
12. **Follow existing conventions** (cuid ids, `ChainId` enum, Json columns, `@@map` snake_case, `probePort(5439)` DB tests, `MOCK_MODE !== 'false'` switch, `force-dynamic` pages).

---

## File Structure

Every file created or modified across all seven tasks, with its one-line responsibility. Owning task in parentheses.

### `packages/db` — schema, ingest, queries, seed
- `packages/db/prisma/schema.prisma` (Task A, mod) — add `SocialSource` + `SocialMention` models and the `Token.socialMentions` back-relation.
- `packages/db/prisma/migrations/<timestamp>_social_intelligence/migration.sql` (Task A, gen) — Prisma-emitted migration creating both tables (reuses `ChainId`, no new enum).
- `packages/db/test/socialSchema.test.ts` (Task A, test) — schema-behavior integration test: unique-constraint idempotency, cascade, nullable `tokenId`.
- `packages/db/src/social/ingest.ts` (Task D, create) — `runSocialIngestPass` reusable ingest body (extract → hash → spam lookback → classify → token-resolve → upsert).
- `packages/db/test/socialIngest.test.ts` (Task D owns the ingest-body suite; Task G adds the cross-cutting end-to-end gate suite) — LITE-Postgres integration tests for ingest behaviors + the feature gate.
- `packages/db/src/social/queries.ts` (Task E creates it with `getRecentMentions` + `getSocialSourceHealth`; Task F appends `getTokenSocialMentions`) — read helpers.
- `packages/db/src/social/overlap.ts` (Task E, create — canonical owner) — `getSocialSignalOverlap` read-only confluence join.
- `packages/db/src/social/index.ts` (Task E, create) — social-helpers barrel re-exported from `packages/db/src/index.ts`.
- `packages/db/test/socialQueries.test.ts` (Task E, test) — DB integration for the query helpers + overlap join.
- `packages/db/src/social/getTokenSocialMentions.test.ts` (Task F, test) — DB integration for `getTokenSocialMentions` (link, ordering, graceful empty).
- `packages/db/src/index.ts` (Tasks D/E, mod) — re-export `./social/ingest`, `./social/queries`, `./social/overlap`.
- `packages/db/src/seed.ts` (Task D, mod) — Phase 3.7: 2 example `SocialSource` rows + one mock `runSocialIngestPass`; wipe order for the two new tables.

### `packages/core` — pure utilities + settings
- `packages/core/src/social/types.ts` (Task B) — shared pure types (`ExtractedMention`, `SpamContext`, `SocialConfig`, velocity I/O, …).
- `packages/core/src/social/extractMentions.ts` (Task B) — pure Solana-only token-mention extractor (address/url/ticker).
- `packages/core/src/social/normalize.ts` (Task B) — `normalizeSnippet` + `contentHash` copy-paste key.
- `packages/core/src/social/classifySpam.ts` (Task B) — pure spam/copy-paste classifier (max-weight of triggered rules).
- `packages/core/src/social/mentionVelocity.ts` (Task B) — pure `computeMentionVelocity` (windows, distinct authors, accel).
- `packages/core/src/social/index.ts` (Task B) — social barrel.
- `packages/core/src/index.ts` (Task B, mod) — add `export * from './social/index'`.
- `packages/core/src/settings.ts` (Task B, mod) — `SocialConfig`/`SocialSpamConfig` Zod schemas + `DEFAULT_SETTINGS.connectors.social`.
- `packages/core/test/social/extractMentions.test.ts`, `normalize.test.ts`, `classifySpam.test.ts`, `mentionVelocity.test.ts` (Task B) — pure unit tests.
- `packages/core/test/settings.test.ts` (Task B, mod) — `connectors.social` defaults + deep-merge block.

### `packages/providers` — inbound social source connectors
- `packages/providers/src/social/types.ts` (Task C) — `SocialPostRaw`, `FetchPostsOpts`, `SocialSourceProvider`, `SocialSourceMode`, `SocialSourceStatusRow`.
- `packages/providers/src/social/mockSocialSource.ts` (Task C) — `MockSocialSource` (world-derived deterministic posts).
- `packages/providers/src/social/telegram.ts` (Task C) — `createTelegramSocialSource(env)` config-gated stub.
- `packages/providers/src/social/discord.ts` (Task C) — `createDiscordSocialSource(env)` config-gated stub.
- `packages/providers/src/social/sourceStatus.ts` (Task C) — `getSocialSourceStatuses(prisma)` mode mapping.
- `packages/providers/src/social/index.ts` (Task C) — social-providers barrel.
- `packages/providers/test/fixtures/social/mockPosts.json` (Task C) — deterministic `{{SYMBOL}}`-templated post fixtures.
- `packages/providers/src/index.ts` (Task C, mod) — add `export * from './social'`.
- `packages/providers/test/socialSources.test.ts` (Task C, test) — provider unit tests (parallel, fetch stubbed).

### `apps/worker` — ingest job
- `apps/worker/src/jobs/socialIngest.ts` (Task D, create) — thin `run(ctx)` wrapper resolving mock/live providers, calling `runSocialIngestPass`.
- `apps/worker/src/index.ts` (Task D, mod) — register `socialIngest` on `settings.connectors.social.syncHours * 3600`.

### `apps/web` — pages, API, components
- `apps/web/app/social/page.tsx` (Task E, create) — `/social` force-dynamic page: empty state + mentions feed + velocity + overlap + manage-sources + health.
- `apps/web/app/social/SourceManager.tsx` (Task E, create) — client add/edit/enable/delete form (`router.refresh()`).
- `apps/web/app/api/social/sources/route.ts` (Task E, create) — Zod-validated `POST`/`PATCH`/`DELETE`, `apiKeyEnvName` name-only.
- `apps/web/components/layout/sidebar-nav.tsx` (Task E, mod) — add `{ label: 'Social', href: '/social' }` nav item.
- `apps/web/components/tokens/SocialSection.tsx` (Task F, create — canonical server component) — read-only per-token mentions + velocity.
- `apps/web/app/tokens/[id]/page.tsx` (Task F, mod) — fetch token mentions + velocity and render `<SocialSection />` after "Risk & context".
- `apps/web/test/socialPage.test.ts` (Task E owns route + page wiring source-text checks; Task G adds the render-gate source-text checks) — Node source-text checks for the `/social` page and API route.
- `apps/web/test/tokenSocialSection.test.ts` (Task F, test) — Node source-text checks for the token social section wiring.

> Ownership map (authoritative):
> - `apps/web/components/tokens/SocialSection.tsx` + the `apps/web/app/tokens/[id]/page.tsx` wiring + `getTokenSocialMentions` (appended to `queries.ts`) — **Task F** only. Task E does NOT build a competing component or types.
> - `getRecentMentions` + `getSocialSourceHealth` (`queries.ts`) and `getSocialSignalOverlap` (`overlap.ts`) — **Task E**.
> - `MentionVelocityRow` (windows[] shape), `computeMentionVelocity`, settings/`parseSettings` — **Task B**.
> - `SocialSourceStatusRow` (with `apiKeyEnvName`), `getSocialSourceStatuses` (async) — **Task C**.
> The `/social` route (`app/social/page.tsx`) uses its own feed/velocity markup and does NOT import `SocialSection`.

---

### Task A: Schema + Migration — SocialSource & SocialMention models

**Files:**
- **Modify:** `packages/db/prisma/schema.prisma` — add `SocialSource` + `SocialMention` models (spec §1, corrected) and a `socialMentions SocialMention[]` back-relation on the existing `Token` model.
- **Create (generated by Prisma, commit it):** `packages/db/prisma/migrations/<timestamp>_social_intelligence/migration.sql` — the `prisma migrate dev` output. Do NOT hand-write this file; commit whatever Prisma emits.
- **Test:** `packages/db/test/socialSchema.test.ts` — integration test (`probePort(5439)` skipIf, prefix cleanup, serialized) proving the unique-constraint idempotency, `onDelete: Cascade`, and nullable `tokenId` link behaviors.

**Interfaces:**
- **Consumes:** the existing `ChainId` enum and `Token` model (`packages/db/prisma/schema.prisma`); the `prisma` singleton (`packages/db/src/client.ts`, `import { prisma } from '../src/client'`); the `db:migrate:new` script (`tsx ../../scripts/db-local.ts ensure && prisma migrate dev`).
- **Produces** (every later Task in this group relies on these EXACT names/columns):
  - Prisma model `SocialSource` (table `social_sources`) with columns: `id, name (unique), platform, externalId?, inviteLink?, notes?, trustTier (default "medium"), enabled (default true), chainSupport ChainId[], apiKeyEnvName?, rateLimitPerMinute (default 30), status (default "idle"), lastSyncAt?, lastError?, failCount (default 0), addedAt (default now()), metadataJson? Json`, plus relation `mentions SocialMention[]`.
  - Prisma model `SocialMention` (table `social_mentions`) with columns: `id, sourceId, platform, externalPostId, authorHash?, postedAt, ingestedAt (default now()), chain ChainId, contentSnippet, normalizedSnippet, contentHash, mentionType, tokenAddress?, tokenSymbol?, tokenUrl?, tokenId?, confidence Int, spamScore Int (default 0), spamReason?, dedupeKey, metadataJson? Json`; relations `source SocialSource @relation(onDelete: Cascade)` and `token Token?`; constraints `@@unique([sourceId, dedupeKey])`, `@@index([tokenId])`, `@@index([chain, tokenAddress])`, `@@index([postedAt])`, `@@index([contentHash])`.
  - `Token.socialMentions SocialMention[]` back-relation (relation-only; no Token column/logic change).
  - These are what `runSocialIngestPass` (later DB task), the `queries.ts`/`overlap.ts` helpers, `seed.ts`, and the web pages upsert/read against. Field names are load-bearing — do not rename.

---

- [ ] **Step 1: Write the failing schema-behavior integration test.**

  Create `packages/db/test/socialSchema.test.ts` with this exact content (mirrors the `probePort`/prefix-cleanup/`describe.skipIf` pattern from `packages/db/test/externalWalletSource.test.ts`):

  ```typescript
  // FlowRadar — SocialSource + SocialMention schema-behavior integration tests
  // (Social Intelligence, Task A, spec §1). Same LITE-Postgres integration
  // pattern as externalWalletSource.test.ts (prefix-cleanup, describe.skipIf
  // when the embedded Postgres isn't reachable). Proves the three schema
  // guarantees later tasks depend on: [sourceId, dedupeKey] idempotency,
  // onDelete:Cascade from SocialSource, and a nullable tokenId link.

  import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
  import net from 'node:net';
  import { prisma } from '../src/client';

  const SOURCE_PREFIX = 'TAsocSource';
  const TOKEN_PREFIX = 'TAsocToken';

  function probePort(host: string, port: number, timeoutMs = 1000): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = net.createConnection({ host, port });
      const done = (ok: boolean) => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(ok);
      };
      socket.setTimeout(timeoutMs);
      socket.once('connect', () => done(true));
      socket.once('timeout', () => done(false));
      socket.once('error', () => done(false));
    });
  }

  let dbReachable = false;

  beforeAll(async () => {
    dbReachable = await probePort('localhost', 5439);
    if (!dbReachable) {
      // eslint-disable-next-line no-console
      console.warn(
        '[socialSchema.test] LITE Postgres not reachable on localhost:5439 — skipping ' +
          'integration tests. Run `npm run db:migrate` first to exercise this suite.'
      );
    }
  });

  async function cleanup() {
    // SocialMention rows are cascade-deleted with their source, but delete by
    // prefix explicitly so a leftover source-less mention (e.g. from a failed
    // run) is also cleared, and to null out any token linkage first.
    await prisma.socialMention.deleteMany({ where: { source: { name: { startsWith: SOURCE_PREFIX } } } });
    await prisma.socialMention.deleteMany({ where: { tokenAddress: { startsWith: TOKEN_PREFIX } } });
    await prisma.socialSource.deleteMany({ where: { name: { startsWith: SOURCE_PREFIX } } });
    await prisma.token.deleteMany({ where: { address: { startsWith: TOKEN_PREFIX } } });
  }

  afterAll(async () => {
    if (!dbReachable) return;
    await cleanup();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    if (!dbReachable) return;
    await cleanup();
  });

  async function makeSource(name: string, overrides: Partial<Parameters<typeof prisma.socialSource.create>[0]['data']> = {}) {
    return prisma.socialSource.create({
      data: {
        name,
        platform: 'telegram',
        chainSupport: ['SOLANA'],
        apiKeyEnvName: 'SOCIAL_TELEGRAM_READ_TOKEN',
        ...overrides
      }
    });
  }

  /** Deterministic mention payload for a given source + dedupeKey. */
  function mentionData(sourceId: string, dedupeKey: string, over: Partial<Parameters<typeof prisma.socialMention.create>[0]['data']> = {}) {
    return {
      sourceId,
      platform: 'telegram',
      externalPostId: `${dedupeKey}_post`,
      postedAt: new Date('2026-07-07T00:00:00.000Z'),
      chain: 'SOLANA' as const,
      contentSnippet: 'gm buy $NOVA now',
      normalizedSnippet: 'gm buy nova now',
      contentHash: 'hash_nova',
      mentionType: 'ticker',
      tokenSymbol: 'NOVA',
      confidence: 40,
      dedupeKey,
      ...over
    };
  }

  describe.skipIf(!(await probePort('localhost', 5439)))('SocialSource + SocialMention schema', () => {
    it('applies documented column defaults on SocialSource', async () => {
      const source = await makeSource(`${SOURCE_PREFIX}_defaults`);
      expect(source.trustTier).toBe('medium');
      expect(source.enabled).toBe(true);
      expect(source.rateLimitPerMinute).toBe(30);
      expect(source.status).toBe('idle');
      expect(source.failCount).toBe(0);
      expect(source.chainSupport).toEqual(['SOLANA']);
      expect(source.addedAt).toBeInstanceOf(Date);
      expect(source.lastSyncAt).toBeNull();
    });

    it('creates two mentions under one source and applies SocialMention defaults', async () => {
      const source = await makeSource(`${SOURCE_PREFIX}_two`);
      await prisma.socialMention.create({ data: mentionData(source.id, 'dk_a') });
      const m2 = await prisma.socialMention.create({ data: mentionData(source.id, 'dk_b') });

      const rows = await prisma.socialMention.findMany({ where: { sourceId: source.id } });
      expect(rows).toHaveLength(2);
      expect(m2.spamScore).toBe(0);
      expect(m2.spamReason).toBeNull();
      expect(m2.tokenId).toBeNull();
      expect(m2.ingestedAt).toBeInstanceOf(Date);
    });

    it('[sourceId, dedupeKey] is idempotent — re-upsert of the same dedupeKey yields exactly 1 row', async () => {
      const source = await makeSource(`${SOURCE_PREFIX}_idem`);
      const where = { sourceId_dedupeKey: { sourceId: source.id, dedupeKey: 'dk_same' } };

      await prisma.socialMention.upsert({
        where,
        create: mentionData(source.id, 'dk_same', { spamScore: 0 }),
        update: {}
      });
      // Second upsert of the SAME (sourceId, dedupeKey), different spamScore —
      // must UPDATE the existing row, never insert a second.
      const second = await prisma.socialMention.upsert({
        where,
        create: mentionData(source.id, 'dk_same', { spamScore: 0 }),
        update: { spamScore: 80, spamReason: 'copypasta' }
      });

      const rows = await prisma.socialMention.findMany({ where: { sourceId: source.id, dedupeKey: 'dk_same' } });
      expect(rows).toHaveLength(1);
      expect(second.spamScore).toBe(80);
      expect(second.spamReason).toBe('copypasta');
    });

    it('the same dedupeKey under a DIFFERENT source is a distinct row (constraint is per-source)', async () => {
      const s1 = await makeSource(`${SOURCE_PREFIX}_scopeA`);
      const s2 = await makeSource(`${SOURCE_PREFIX}_scopeB`);
      await prisma.socialMention.create({ data: mentionData(s1.id, 'dk_shared') });
      await prisma.socialMention.create({ data: mentionData(s2.id, 'dk_shared') });

      const all = await prisma.socialMention.findMany({ where: { dedupeKey: 'dk_shared' } });
      expect(all).toHaveLength(2);
    });

    it('deleting a SocialSource cascade-deletes its SocialMention rows', async () => {
      const source = await makeSource(`${SOURCE_PREFIX}_cascade`);
      await prisma.socialMention.create({ data: mentionData(source.id, 'dk_c1') });
      await prisma.socialMention.create({ data: mentionData(source.id, 'dk_c2') });

      await prisma.socialSource.delete({ where: { id: source.id } });

      const remaining = await prisma.socialMention.findMany({ where: { sourceId: source.id } });
      expect(remaining).toHaveLength(0);
    });

    it('links a mention to a Token when tokenId is supplied, and reads back via the Token.socialMentions back-relation', async () => {
      const source = await makeSource(`${SOURCE_PREFIX}_linked`);
      const token = await prisma.token.create({
        data: {
          chain: 'SOLANA',
          address: `${TOKEN_PREFIX}_nova`,
          symbol: 'NOVA',
          name: 'Nova',
          decimals: 9,
          firstSeenAt: new Date(),
          riskFlags: []
        }
      });

      const linked = await prisma.socialMention.create({
        data: mentionData(source.id, 'dk_linked', {
          mentionType: 'address',
          tokenAddress: `${TOKEN_PREFIX}_nova`,
          tokenId: token.id,
          confidence: 90
        })
      });
      expect(linked.tokenId).toBe(token.id);

      const tokenWithMentions = await prisma.token.findUnique({
        where: { id: token.id },
        include: { socialMentions: true }
      });
      expect(tokenWithMentions!.socialMentions).toHaveLength(1);
      expect(tokenWithMentions!.socialMentions[0]!.dedupeKey).toBe('dk_linked');
    });

    it('graceful skip: a mention with tokenId=null (unlinked / missing token) persists cleanly', async () => {
      const source = await makeSource(`${SOURCE_PREFIX}_unlinked`);
      const unlinked = await prisma.socialMention.create({
        data: mentionData(source.id, 'dk_unlinked', { tokenSymbol: 'GHOST', tokenId: null })
      });
      expect(unlinked.tokenId).toBeNull();
      expect(unlinked.tokenSymbol).toBe('GHOST');

      const readBack = await prisma.socialMention.findUnique({ where: { id: unlinked.id }, include: { token: true } });
      expect(readBack!.token).toBeNull();
    });
  });
  ```

- [ ] **Step 2: Run the test — expect FAIL (models do not exist yet).**

  ```
  npx vitest run packages/db/test/socialSchema.test.ts
  ```

  Expected: FAIL at compile/type level — `prisma.socialSource` and `prisma.socialMention` are not properties of `PrismaClient` (the generated client has no such delegates yet), and `include: { socialMentions: true }` is not a valid `Token` include. (If the LITE DB on 5439 is not running, the suite would instead be skipped; you MUST have the DB up for this task — see Step 4 — so the correct expected outcome here is a real type/compile failure, not a skip.)

- [ ] **Step 3: Add the two models + the Token back-relation to the schema.**

  In `packages/db/prisma/schema.prisma`, add the `socialMentions` back-relation line to the existing `Token` model's relation block (immediately after the existing `destRotations` line, before the closing `@@unique`/`@@map`):

  ```prisma
    sourceRotations   ProfitRotationSignal[] @relation("ProfitRotationSourceToken")
    destRotations     ProfitRotationSignal[] @relation("ProfitRotationDestToken")
    socialMentions    SocialMention[]

    @@unique([chain, address])
    @@map("tokens")
  }
  ```

  (Replace the existing `sourceRotations`/`destRotations`/`@@unique`/`@@map` tail of the `Token` model with the block above — the only change is the inserted `socialMentions` line; the surrounding lines are shown for an exact anchor.)

  Then append the two new models at the END of the file (after the last model, `BacktestRun`), following the numbered-section-comment + `@@map` snake_case conventions used throughout:

  ```prisma
  // ---------------------------------------------------------------------------
  // 26. SocialSource (Social Intelligence — spec §1; operator-managed registry)
  // ---------------------------------------------------------------------------

  /// One operator-registered inbound social reader (Telegram/Discord channel,
  /// or a `manual` registry-only entry with no automated reader this phase).
  /// Mirrors ExternalWalletSource's role for the wallet-candidate pipeline, but
  /// is ENTIRELY SEPARATE from it: social data is shadow-only confluence
  /// evidence and never feeds FlowScore, signal rules, wallet scoring, or
  /// production alerts. `apiKeyEnvName` stores the env VAR NAME of the read
  /// credential (never a value), distinct from the outbound alert sender's
  /// TELEGRAM_BOT_TOKEN. `trustTier` is operator-assigned display/weighting
  /// confidence only — it never feeds scoring.
  model SocialSource {
    id                 String    @id @default(cuid())
    name               String    @unique
    platform           String
    externalId         String?
    inviteLink         String?
    notes              String?
    trustTier          String    @default("medium")
    enabled            Boolean   @default(true)
    chainSupport       ChainId[]
    apiKeyEnvName      String?
    rateLimitPerMinute Int       @default(30)
    status             String    @default("idle")
    lastSyncAt         DateTime?
    lastError          String?
    failCount          Int       @default(0)
    addedAt            DateTime  @default(now())
    metadataJson       Json?

    mentions           SocialMention[]

    @@map("social_sources")
  }

  // ---------------------------------------------------------------------------
  // 27. SocialMention (Social Intelligence — spec §1; extractor output, shadow-only)
  // ---------------------------------------------------------------------------

  /// One extracted token mention from one social post. A post mentioning two
  /// tokens produces two rows; zero-token posts are NOT stored (only counted).
  /// `contentSnippet`/`normalizedSnippet` are SAFE, TRUNCATED (<=280 char)
  /// excerpts — never a full raw-message archive. `tokenId` is nullable: when
  /// the extracted token is not (yet) a Token row it stays null (graceful
  /// skip / "unlinked" in the UI). `dedupeKey` is NON-NULL
  /// (`${externalPostId}::${tokenAddress ?? '$'+tokenSymbol ?? 'none'}`), so
  /// @@unique([sourceId, dedupeKey]) makes re-ingest idempotent without
  /// NULLs-are-distinct surprises.
  model SocialMention {
    id                String       @id @default(cuid())
    sourceId          String
    source            SocialSource @relation(fields: [sourceId], references: [id], onDelete: Cascade)
    platform          String
    externalPostId    String
    authorHash        String?
    postedAt          DateTime
    ingestedAt        DateTime     @default(now())
    chain             ChainId
    contentSnippet    String
    normalizedSnippet String
    contentHash       String
    mentionType       String
    tokenAddress      String?
    tokenSymbol       String?
    tokenUrl          String?
    tokenId           String?
    token             Token?       @relation(fields: [tokenId], references: [id])
    confidence        Int
    spamScore         Int          @default(0)
    spamReason        String?
    dedupeKey         String
    metadataJson      Json?

    @@unique([sourceId, dedupeKey])
    @@index([tokenId])
    @@index([chain, tokenAddress])
    @@index([postedAt])
    @@index([contentHash])
    @@map("social_mentions")
  }
  ```

- [ ] **Step 4: Create the migration + regenerate the client.**

  From the repo root, run the existing `db:migrate:new` script (it runs `db-local.ts ensure` to bring up LITE Postgres on 5439, then `prisma migrate dev`), passing the migration name non-interactively so no editor prompt blocks:

  ```
  npm -w @flowradar/db run db:migrate:new -- --name social_intelligence
  ```

  Expected: Prisma detects the two new tables + the `Token`↔`SocialMention` FK, writes `packages/db/prisma/migrations/<timestamp>_social_intelligence/migration.sql`, applies it, and regenerates the client. The emitted SQL must contain `CREATE TABLE "social_sources"`, `CREATE TABLE "social_mentions"`, `"chainSupport" "ChainId"[]`, `CREATE UNIQUE INDEX "social_mentions_sourceId_dedupeKey_key"`, an index on each of `tokenId` / `(chain, tokenAddress)` / `postedAt` / `contentHash`, an `ON DELETE CASCADE` FK on `social_mentions.sourceId → social_sources.id`, and an `ON DELETE SET NULL` FK on `social_mentions.tokenId → tokens.id`. No new enum is created (reuses `ChainId`).

  If Prisma reports drift or a shadow-DB issue, do NOT `migrate reset` blindly — inspect `npx prisma migrate status` first; a clean LITE cluster with all prior migrations applied is the assumed starting state.

- [ ] **Step 5: Re-run the test — expect PASS.**

  ```
  npx vitest run packages/db/test/socialSchema.test.ts
  ```

  Expected: all cases in `SocialSource + SocialMention schema` PASS — defaults applied, two mentions under one source, `upsert` on `[sourceId, dedupeKey]` idempotent (1 row, `spamScore` updated to 80), same key under a different source distinct (2 rows), cascade delete leaves 0 mentions, the `Token.socialMentions` include returns the linked row, and the `tokenId=null` unlinked mention persists with `token` null.

- [ ] **Step 6: Confirm the generated client + full typecheck are clean.**

  ```
  npm -w @flowradar/db run generate
  npm -w @flowradar/db run build
  ```

  Expected: `prisma generate` succeeds and `tsc -b` for `@flowradar/db` passes with no errors (the new delegates `prisma.socialSource` / `prisma.socialMention` and the `Token.socialMentions` relation now typecheck).

- [ ] **Step 7: Commit (schema + migration + test in one small, coherent commit).**

  ```
  git add packages/db/prisma/schema.prisma packages/db/prisma/migrations packages/db/test/socialSchema.test.ts
  git commit -m "feat(db): add SocialSource + SocialMention models + migration (social intel Task A)"
  ```

  (Do not `git add -A`; stage only the four paths above so the commit stays scoped to Task A. The generated `migrations/<timestamp>_social_intelligence/` directory is included by staging `packages/db/prisma/migrations`.)

**Done Bar:**
- `packages/db/prisma/schema.prisma` contains `model SocialSource { … @@map("social_sources") }` and `model SocialMention { … @@map("social_mentions") }` with EXACTLY the columns, defaults, relations, `@@unique([sourceId, dedupeKey])`, and four `@@index` lines listed in Produces; `Token` gains `socialMentions SocialMention[]` and nothing else changes on `Token`.
- A new `packages/db/prisma/migrations/<timestamp>_social_intelligence/migration.sql` exists, is applied, and reuses `ChainId` (creates no new enum).
- `npx vitest run packages/db/test/socialSchema.test.ts` passes with the LITE DB up, and is skipped (not errored) when 5439 is unreachable.
- `npm -w @flowradar/db run build` (tsc) and `npm -w @flowradar/db run generate` succeed.
- The commit stages only schema + migrations + the new test file.

**Reviewer Focus:**
- **Constraint semantics:** verify `@@unique([sourceId, dedupeKey])` (NOT a bare `dedupeKey` unique, and NOT `[externalPostId, …]`) and that `dedupeKey`/`contentSnippet`/`normalizedSnippet`/`contentHash` are all NON-nullable `String` — a nullable `dedupeKey` would break idempotency (NULLs are distinct in Postgres). The idempotency test must actually assert 1 row after a second upsert with a changed field, not just that upsert doesn't throw.
- **Cascade vs SET NULL:** `source` relation must be `onDelete: Cascade`; the `token` relation must be the Prisma default (`ON DELETE SET NULL`, since `tokenId` is optional) — deleting a Token must NOT delete mentions, and deleting a Source MUST delete its mentions. Confirm the emitted SQL matches (one `CASCADE`, one `SET NULL`).
- **No Token bleed-through (global constraints 5–7):** the ONLY change to `Token` is the added back-relation line — no new columns, no FlowScore/scoring/CandidateWallet touch, no change to any other model. Diff the `Token` model carefully.
- **Secrets (constraint 10):** `apiKeyEnvName` is `String?` and is only ever an env-var NAME; no credential column exists on either model; nothing in the test or migration prints a secret value.
- **Chain-awareness but Solana-only (constraint 8):** `chainSupport ChainId[]` and `chain ChainId` are present (schema stays chain-aware) but the test/seed data use `'SOLANA'` only; no BSC-specific column or default sneaks in.
- **Convention fidelity (constraint 12):** `cuid()` ids, `Json?` (not `Jsonb` literal), `@@map` snake_case table names, `ChainId[]` scalar-list (as used by `EntityCluster.chains`/`ProfitRotationSignal.chainPath`), and the numbered section-comment header style — all matching the surrounding schema. The test reuses the canonical `probePort(5439)` + prefix-cleanup + `describe.skipIf` harness verbatim.

### Task B: Core social utilities (extract / normalize / spam / velocity) + settings

**Files:**
- Create: `packages/core/src/social/types.ts`
- Create: `packages/core/src/social/extractMentions.ts`
- Create: `packages/core/src/social/normalize.ts`
- Create: `packages/core/src/social/classifySpam.ts`
- Create: `packages/core/src/social/mentionVelocity.ts`
- Create: `packages/core/src/social/index.ts`
- Modify: `packages/core/src/index.ts` (add `export * from './social/index';`)
- Modify: `packages/core/src/settings.ts` (add `SocialConfig`/`SocialSpamConfig` Zod schemas into `ConnectorsSchema` + `DEFAULT_SETTINGS.connectors.social`, spec §7)
- Test: `packages/core/test/social/extractMentions.test.ts`
- Test: `packages/core/test/social/normalize.test.ts`
- Test: `packages/core/test/social/classifySpam.test.ts`
- Test: `packages/core/test/social/mentionVelocity.test.ts`
- Test: `packages/core/test/settings.test.ts` (extend — add a `connectors.social` describe block)

**Interfaces:**

- **Consumes:** `Chain` from `packages/core/src/types.ts` (`export type Chain = 'SOLANA' | 'BSC';`). Node builtin `node:crypto` (`createHash`) — already available; no new dependency (`packages/core/package.json` unchanged). This task consumes nothing from other Task groups; it is the leaf that everything else imports.
- **Produces** (later tasks — providers ingest body, worker `socialIngest`, db helpers, web token-social-section — rely on these EXACT signatures):
  - `interface ExtractedMention { mentionType: 'address' | 'ticker' | 'url'; tokenAddress: string | null; tokenSymbol: string | null; tokenUrl: string | null; confidence: number; }`
  - `type SpamReason = 'copypasta' | 'repeat_author' | 'low_content';`
  - `interface SpamContext { normalizedSnippet: string; distinctAuthorsSameHash: number; sameAuthorRecentCount: number; alnumLength: number; }`
  - `interface SocialSpamConfig { copypastaAuthorMin: number; repeatAuthorMin: number; lowContentMinChars: number; windowMinutes: number; weights: { copypasta: number; repeat_author: number; low_content: number }; uiHideThreshold: number; }`
  - `interface SocialConfig { syncHours: number; spam: SocialSpamConfig; velocityWindowsMin: number[]; }`
  - `interface MentionVelocityInput { tokenId: string | null; tokenAddress: string | null; authorHash: string | null; postedAt: Date; spamScore: number; }`
  - `interface MentionVelocityRow { tokenId: string | null; tokenAddress: string | null; windows: { windowMin: number; count: number; distinctAuthors: number }[]; accel: number; }`
  - `extractMentions(content: string, chain: Chain): ExtractedMention[]`
  - `normalizeSnippet(content: string): string`
  - `contentHash(normalized: string): string`
  - `classifySpam(ctx: SpamContext, cfg: SocialSpamConfig): { spamScore: number; spamReason: SpamReason | null }`
  - `computeMentionVelocity(mentions: MentionVelocityInput[], now: Date, cfg: { windowsMin: number[]; spamMaxScore: number }): MentionVelocityRow[]`

Steps run from the repo root `C:\Users\akki\session\flowradar`. Test runner: `npx vitest run <path>`. These are all pure modules — no DB, so no `probePort(5439)` needed.

---

- [ ] **Step 1: Create the shared social types (no test — pure type declarations consumed by later steps).** Write `packages/core/src/social/types.ts`:

```typescript
// FlowRadar — social intelligence: shared pure types.
//
// packages/core is PURE (zero I/O, zod is the only runtime dep; node:crypto is
// a builtin used only by normalize.ts). These types are the contract every
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
```

Run `npx vitest run packages/core/test/social` — expected FAIL: `No test files found` (directory does not exist yet). This confirms the runner path before we add real tests.

Commit:
```
git add packages/core/src/social/types.ts
git commit -m "social(core): add shared social intelligence types"
```

---

- [ ] **Step 2: FAILING test — `normalizeSnippet` + `contentHash` stability.** Write `packages/core/test/social/normalize.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { normalizeSnippet, contentHash } from '../../src/social/normalize';

describe('normalizeSnippet', () => {
  it('lowercases, strips urls/emojis/mentions/punctuation and collapses whitespace', () => {
    const raw = 'BUY $NOVA NOW!!! 🚀🚀 https://pump.fun/abc @caller_bot  going   PARABOLIC';
    const out = normalizeSnippet(raw);
    expect(out).toBe('buy nova now going parabolic');
    expect(out).not.toContain('http');
    expect(out).not.toContain('@');
    expect(out).not.toMatch(/[🚀!]/u);
  });

  it('two posts that differ only in urls/emojis/case/spacing normalize identically (copy-paste key)', () => {
    const a = 'Ape $NOVA 🔥 https://dexscreener.com/solana/So11111111111111111111111111111111111111112';
    const b = 'ape   $nova https://birdeye.so/token/So11111111111111111111111111111111111111112 🔥🔥🔥';
    expect(normalizeSnippet(a)).toBe(normalizeSnippet(b));
  });

  it('truncates the normalized snippet to <= 280 chars', () => {
    const raw = 'gm '.repeat(200); // 600 chars pre-normalize
    expect(normalizeSnippet(raw).length).toBeLessThanOrEqual(280);
  });

  it('empty / whitespace-only content normalizes to empty string', () => {
    expect(normalizeSnippet('')).toBe('');
    expect(normalizeSnippet('   \n\t  ')).toBe('');
    expect(normalizeSnippet('🚀🚀🚀')).toBe('');
  });
});

describe('contentHash', () => {
  it('is deterministic and stable for identical normalized input', () => {
    const n = normalizeSnippet('Ape $NOVA now 🔥');
    expect(contentHash(n)).toBe(contentHash(n));
  });

  it('is a 64-char lowercase hex sha256 digest', () => {
    const h = contentHash('buy nova now');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs for different normalized content', () => {
    expect(contentHash('buy nova now')).not.toBe(contentHash('buy quiet now'));
  });

  it('copy-paste posts (same normalized snippet) share one hash', () => {
    const a = normalizeSnippet('Ape $NOVA 🔥 https://pump.fun/x');
    const b = normalizeSnippet('ape $nova https://birdeye.so/token/y 🔥🔥');
    expect(contentHash(a)).toBe(contentHash(b));
  });
});
```

Run `npx vitest run packages/core/test/social/normalize.test.ts` — expected FAIL: `Failed to resolve import "../../src/social/normalize"` (module does not exist yet).

---

- [ ] **Step 3: Implement `normalize.ts` minimally to pass.** Write `packages/core/src/social/normalize.ts`:

```typescript
// FlowRadar — social: snippet normalization + content hash (spec §3).
//
// PURE. node:crypto is a Node builtin (no new runtime dep; matches spec's
// "hash(normalizedSnippet) via Node crypto"). normalizeSnippet produces the
// copy-paste comparison key: lowercase, urls/emojis/mentions/punctuation
// stripped, whitespace collapsed, truncated to <= 280 chars (schema limit).

import { createHash } from 'node:crypto';

const MAX_SNIPPET_LEN = 280;

// URL (http/https/www) — removed wholesale so links never affect the key.
const URL_RE = /\b(?:https?:\/\/|www\.)\S+/gi;
// @mentions / t.me handles — opaque, removed.
const MENTION_RE = /@[a-z0-9_]+/gi;
// Everything that is NOT a-z, 0-9 or whitespace (after lowercasing) — strips
// punctuation, emojis, and every non-ASCII symbol in one pass.
const NON_ALNUM_RE = /[^a-z0-9\s]/g;
const WS_RE = /\s+/g;

/**
 * Normalizes post content into a stable copy-paste key: lowercased, with URLs,
 * @mentions, emojis, and punctuation stripped, whitespace collapsed to single
 * spaces, and truncated to <= 280 chars. Two posts that differ only in
 * links/emojis/case/spacing normalize to the SAME string.
 */
export function normalizeSnippet(content: string): string {
  const normalized = content
    .toLowerCase()
    .replace(URL_RE, ' ')
    .replace(MENTION_RE, ' ')
    .replace(NON_ALNUM_RE, ' ')
    .replace(WS_RE, ' ')
    .trim();
  return normalized.length > MAX_SNIPPET_LEN ? normalized.slice(0, MAX_SNIPPET_LEN) : normalized;
}

/** sha256 hex digest of a normalized snippet — the copy-paste grouping key. */
export function contentHash(normalized: string): string {
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}
```

Run `npx vitest run packages/core/test/social/normalize.test.ts` — expected PASS (all 8 assertions green).

Commit:
```
git add packages/core/src/social/normalize.ts packages/core/test/social/normalize.test.ts
git commit -m "social(core): normalizeSnippet + contentHash (copy-paste key)"
```

---

- [ ] **Step 4: FAILING test — `extractMentions` (address / URL-embedded / cashtag / none / mixed / false-positive base58).** Write `packages/core/test/social/extractMentions.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { extractMentions } from '../../src/social/extractMentions';

// A real-length Solana base58 mint (44 chars, no 0/O/I/l) used across cases.
const CA = '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr';

describe('extractMentions (SOLANA)', () => {
  it('extracts a bare contract address with confidence 90', () => {
    const out = extractMentions(`aping ${CA} now`, 'SOLANA');
    expect(out).toEqual([
      { mentionType: 'address', tokenAddress: CA, tokenSymbol: null, tokenUrl: null, confidence: 90 }
    ]);
  });

  it('extracts an address embedded in a dexscreener URL as a url mention (conf 85)', () => {
    const out = extractMentions(`chart: https://dexscreener.com/solana/${CA}`, 'SOLANA');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      mentionType: 'url',
      tokenAddress: CA,
      tokenUrl: `https://dexscreener.com/solana/${CA}`,
      confidence: 85
    });
  });

  it('extracts addresses from pump.fun / birdeye / solscan / jup URLs', () => {
    for (const url of [
      `https://pump.fun/${CA}`,
      `https://birdeye.so/token/${CA}`,
      `https://solscan.io/token/${CA}`,
      `https://jup.ag/swap/SOL-${CA}`
    ]) {
      const out = extractMentions(`look ${url}`, 'SOLANA');
      expect(out).toHaveLength(1);
      expect(out[0].mentionType).toBe('url');
      expect(out[0].tokenAddress).toBe(CA);
      expect(out[0].tokenUrl).toBe(url);
    }
  });

  it('extracts a $TICKER cashtag with confidence 40 (symbol uppercased, no $)', () => {
    const out = extractMentions('sending $nova to the moon', 'SOLANA');
    expect(out).toEqual([
      { mentionType: 'ticker', tokenAddress: null, tokenSymbol: 'NOVA', tokenUrl: null, confidence: 40 }
    ]);
  });

  it('returns [] for a no-token post', () => {
    expect(extractMentions('gm frens wagmi', 'SOLANA')).toEqual([]);
  });

  it('mixed post → one address + one distinct ticker (2 rows)', () => {
    const out = extractMentions(`ape ${CA} and also $QUIET`, 'SOLANA');
    const types = out.map((m) => m.mentionType).sort();
    expect(types).toEqual(['address', 'ticker']);
    expect(out.find((m) => m.mentionType === 'address')?.tokenAddress).toBe(CA);
    expect(out.find((m) => m.mentionType === 'ticker')?.tokenSymbol).toBe('QUIET');
  });

  it('collapses an address + its own URL for the SAME token to ONE mention', () => {
    // address prefers the URL form (or bare); either way the resolved
    // tokenAddress is deduped so a post with both CA and its dexscreener URL
    // yields exactly one row for that token.
    const out = extractMentions(`${CA} https://dexscreener.com/solana/${CA}`, 'SOLANA');
    expect(out).toHaveLength(1);
    expect(out[0].tokenAddress).toBe(CA);
  });

  it('does NOT flag a short base58-looking word as an address (false-positive guard)', () => {
    // 31 chars — below the 32-char CA floor.
    expect(extractMentions('gmgmgmgmgmgmgmgmgmgmgmgmgmgmgmg', 'SOLANA')).toEqual([]);
    // ordinary English words are never addresses
    expect(extractMentions('this is a totally normal sentence about tokens', 'SOLANA')).toEqual([]);
  });

  it('does NOT extract anything for a non-SOLANA chain (Solana-only, spec §3/global constraint 8)', () => {
    expect(extractMentions(`bsc post ${CA} $NOVA`, 'BSC')).toEqual([]);
  });

  it('dedupes a repeated cashtag within one post', () => {
    const out = extractMentions('$NOVA $NOVA $NOVA', 'SOLANA');
    expect(out.filter((m) => m.mentionType === 'ticker')).toHaveLength(1);
  });
});
```

Run `npx vitest run packages/core/test/social/extractMentions.test.ts` — expected FAIL: `Failed to resolve import "../../src/social/extractMentions"`.

---

- [ ] **Step 5: Implement `extractMentions.ts` to pass.** Write `packages/core/src/social/extractMentions.ts`:

```typescript
// FlowRadar — social: pure token-mention extractor (spec §3).
//
// PURE. Solana-only (global constraint 8): returns [] for any non-SOLANA chain.
// Detects, in priority order, so an address + its own token URL collapse to
// ONE mention for the same token:
//   1. Token URLs (dexscreener/birdeye/pump.fun/solscan/jup) → embedded address
//   2. Bare contract addresses (base58, 32–44 chars)
//   3. $TICKER cashtags (2–10 uppercase alnum)
// Dedup within a post by resolved tokenAddress (url/address) and by symbol
// (ticker). Confidence: address 90, url 85, ticker 40.

import type { Chain } from '../types';
import type { ExtractedMention } from './types';

// Solana base58 alphabet excludes 0 O I l. A mint is 32–44 chars.
const BASE58 = '[1-9A-HJ-NP-Za-km-z]';
const ADDRESS_CORE = `${BASE58}{32,44}`;
const ADDRESS_RE = new RegExp(ADDRESS_CORE, 'g');

// Token URLs whose path embeds a Solana address. Ordered patterns; each
// capture group 1 is the address. `\S*` after the host lets a trailing
// SOL- prefix (jup swap route) or path segment precede the address.
const URL_PATTERNS: RegExp[] = [
  new RegExp(`https?://(?:www\\.)?dexscreener\\.com/solana/(${ADDRESS_CORE})`, 'gi'),
  new RegExp(`https?://(?:www\\.)?birdeye\\.so/token/(${ADDRESS_CORE})`, 'gi'),
  new RegExp(`https?://(?:www\\.)?solscan\\.io/token/(${ADDRESS_CORE})`, 'gi'),
  new RegExp(`https?://(?:www\\.)?pump\\.fun/(?:coin/)?(${ADDRESS_CORE})`, 'gi'),
  new RegExp(`https?://(?:www\\.)?jup\\.ag/\\S*?(${ADDRESS_CORE})`, 'gi')
];

// $TICKER: 2–10 uppercase alnum, must start with a letter so `$100` is not a
// ticker. Case-insensitive match, uppercased on capture.
const CASHTAG_RE = /\$([A-Za-z][A-Za-z0-9]{1,9})\b/g;

export function extractMentions(content: string, chain: Chain): ExtractedMention[] {
  if (chain !== 'SOLANA') return [];

  const byAddress = new Map<string, ExtractedMention>();
  const bySymbol = new Map<string, ExtractedMention>();

  // -- 1. Token URLs first (so the URL form wins the address for a token) ---
  for (const re of URL_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const addr = m[1]!;
      const url = m[0]!;
      if (!byAddress.has(addr)) {
        byAddress.set(addr, {
          mentionType: 'url',
          tokenAddress: addr,
          tokenSymbol: null,
          tokenUrl: url,
          confidence: 85
        });
      }
    }
  }

  // -- 2. Bare contract addresses (skip any already captured via a URL) ----
  // Strip URLs before scanning for bare addresses so a URL's embedded address
  // isn't re-matched as a second, bare mention.
  const contentSansUrls = content.replace(/\bhttps?:\/\/\S+/gi, ' ');
  ADDRESS_RE.lastIndex = 0;
  let am: RegExpExecArray | null;
  while ((am = ADDRESS_RE.exec(contentSansUrls)) !== null) {
    const addr = am[0]!;
    if (!byAddress.has(addr)) {
      byAddress.set(addr, {
        mentionType: 'address',
        tokenAddress: addr,
        tokenSymbol: null,
        tokenUrl: null,
        confidence: 90
      });
    }
  }

  // -- 3. Cashtags (deduped by uppercased symbol) --------------------------
  CASHTAG_RE.lastIndex = 0;
  let cm: RegExpExecArray | null;
  while ((cm = CASHTAG_RE.exec(content)) !== null) {
    const symbol = cm[1]!.toUpperCase();
    if (!bySymbol.has(symbol)) {
      bySymbol.set(symbol, {
        mentionType: 'ticker',
        tokenAddress: null,
        tokenSymbol: symbol,
        tokenUrl: null,
        confidence: 40
      });
    }
  }

  return [...byAddress.values(), ...bySymbol.values()];
}
```

Run `npx vitest run packages/core/test/social/extractMentions.test.ts` — expected PASS (all cases green, incl. false-positive guard and BSC-returns-[]).

Commit:
```
git add packages/core/src/social/extractMentions.ts packages/core/test/social/extractMentions.test.ts
git commit -m "social(core): extractMentions (address/url/ticker, Solana-only)"
```

---

- [ ] **Step 6: FAILING test — `classifySpam` (each SpamReason + clean + max-of-triggered + shadow-only never drops).** Write `packages/core/test/social/classifySpam.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { classifySpam } from '../../src/social/classifySpam';
import type { SocialSpamConfig, SpamContext } from '../../src/social/types';

const CFG: SocialSpamConfig = {
  copypastaAuthorMin: 3,
  repeatAuthorMin: 5,
  lowContentMinChars: 12,
  windowMinutes: 360,
  weights: { copypasta: 80, repeat_author: 60, low_content: 50 },
  uiHideThreshold: 70
};

function ctx(over: Partial<SpamContext>): SpamContext {
  return {
    normalizedSnippet: 'a reasonably long clean snippet about a token',
    distinctAuthorsSameHash: 1,
    sameAuthorRecentCount: 1,
    alnumLength: 45,
    ...over
  };
}

describe('classifySpam', () => {
  it('clean content → score 0, reason null', () => {
    expect(classifySpam(ctx({}), CFG)).toEqual({ spamScore: 0, spamReason: null });
  });

  it('copypasta: distinctAuthorsSameHash >= copypastaAuthorMin → weight 80', () => {
    expect(classifySpam(ctx({ distinctAuthorsSameHash: 3 }), CFG)).toEqual({
      spamScore: 80,
      spamReason: 'copypasta'
    });
  });

  it('repeat_author: sameAuthorRecentCount >= repeatAuthorMin → weight 60', () => {
    expect(classifySpam(ctx({ sameAuthorRecentCount: 5 }), CFG)).toEqual({
      spamScore: 60,
      spamReason: 'repeat_author'
    });
  });

  it('low_content: alnumLength < lowContentMinChars → weight 50', () => {
    expect(classifySpam(ctx({ alnumLength: 5 }), CFG)).toEqual({
      spamScore: 50,
      spamReason: 'low_content'
    });
  });

  it('multiple triggers → score is the MAX weight, reason is that rule', () => {
    // copypasta (80) AND low_content (50) both fire → 80 / copypasta wins
    const r = classifySpam(ctx({ distinctAuthorsSameHash: 4, alnumLength: 3 }), CFG);
    expect(r.spamScore).toBe(80);
    expect(r.spamReason).toBe('copypasta');
  });

  it('boundary: exactly at the threshold triggers (>=), one below does not', () => {
    expect(classifySpam(ctx({ distinctAuthorsSameHash: 3 }), CFG).spamReason).toBe('copypasta');
    expect(classifySpam(ctx({ distinctAuthorsSameHash: 2 }), CFG).spamReason).toBeNull();
    expect(classifySpam(ctx({ alnumLength: 12 }), CFG).spamReason).toBeNull(); // 12 is NOT < 12
    expect(classifySpam(ctx({ alnumLength: 11 }), CFG).spamReason).toBe('low_content');
  });

  it('is pure: never mutates the input context', () => {
    const c = ctx({ distinctAuthorsSameHash: 4 });
    const snapshot = JSON.stringify(c);
    classifySpam(c, CFG);
    expect(JSON.stringify(c)).toBe(snapshot);
  });
});
```

Run `npx vitest run packages/core/test/social/classifySpam.test.ts` — expected FAIL: `Failed to resolve import "../../src/social/classifySpam"`.

---

- [ ] **Step 7: Implement `classifySpam.ts` to pass.** Write `packages/core/src/social/classifySpam.ts`:

```typescript
// FlowRadar — social: pure spam / copy-paste classifier (spec §4).
//
// PURE. Shadow-only: this ONLY assigns a score + reason. It NEVER drops a
// mention (the job stores every mention with its score; the UI greys/hides
// >= uiHideThreshold). The job supplies distinctAuthorsSameHash and
// sameAuthorRecentCount from lookback queries; alnumLength comes from the
// normalized snippet's alnum core.
//
// Rules (spec §4), each with a configurable weight; the returned score is the
// MAX weight among triggered rules and the reason is that same rule:
//   copypasta      when distinctAuthorsSameHash >= copypastaAuthorMin
//   repeat_author  when sameAuthorRecentCount   >= repeatAuthorMin
//   low_content    when alnumLength             <  lowContentMinChars

import type { SocialSpamConfig, SpamContext, SpamReason } from './types';

export function classifySpam(
  ctx: SpamContext,
  cfg: SocialSpamConfig
): { spamScore: number; spamReason: SpamReason | null } {
  const triggered: { reason: SpamReason; weight: number }[] = [];

  if (ctx.distinctAuthorsSameHash >= cfg.copypastaAuthorMin) {
    triggered.push({ reason: 'copypasta', weight: cfg.weights.copypasta });
  }
  if (ctx.sameAuthorRecentCount >= cfg.repeatAuthorMin) {
    triggered.push({ reason: 'repeat_author', weight: cfg.weights.repeat_author });
  }
  if (ctx.alnumLength < cfg.lowContentMinChars) {
    triggered.push({ reason: 'low_content', weight: cfg.weights.low_content });
  }

  if (triggered.length === 0) {
    return { spamScore: 0, spamReason: null };
  }

  const worst = triggered.reduce((max, t) => (t.weight > max.weight ? t : max));
  return { spamScore: worst.weight, spamReason: worst.reason };
}
```

Run `npx vitest run packages/core/test/social/classifySpam.test.ts` — expected PASS (all 7 assertions green).

Commit:
```
git add packages/core/src/social/classifySpam.ts packages/core/test/social/classifySpam.test.ts
git commit -m "social(core): classifySpam (copypasta/repeat_author/low_content, max weight)"
```

---

- [ ] **Step 8: FAILING test — `computeMentionVelocity` (window counts, distinct-author dominance, spam exclusion, accel).** Write `packages/core/test/social/mentionVelocity.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { computeMentionVelocity } from '../../src/social/mentionVelocity';
import type { MentionVelocityInput } from '../../src/social/types';

const NOW = new Date('2026-07-07T12:00:00.000Z');
// minutes-ago helper
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000);

const CFG = { windowsMin: [60, 360, 1440], spamMaxScore: 70 };

function row(over: Partial<MentionVelocityInput>): MentionVelocityInput {
  return { tokenId: 't1', tokenAddress: 'A1', authorHash: 'auth1', postedAt: ago(5), spamScore: 0, ...over };
}

describe('computeMentionVelocity', () => {
  it('counts mentions per window (nested windows include shorter-window mentions)', () => {
    const mentions = [
      row({ postedAt: ago(5) }), // in 60 / 360 / 1440
      row({ postedAt: ago(120) }), // in 360 / 1440
      row({ postedAt: ago(1000) }) // in 1440 only
    ];
    const [r] = computeMentionVelocity(mentions, NOW, CFG);
    const byWin = Object.fromEntries(r.windows.map((w) => [w.windowMin, w.count]));
    expect(byWin[60]).toBe(1);
    expect(byWin[360]).toBe(2);
    expect(byWin[1440]).toBe(3);
  });

  it('excludes mentions with spamScore > spamMaxScore', () => {
    const mentions = [
      row({ postedAt: ago(5), spamScore: 0 }),
      row({ postedAt: ago(5), spamScore: 71 }), // > 70 → excluded
      row({ postedAt: ago(5), spamScore: 70 }) // == 70 → kept (not > 70)
    ];
    const [r] = computeMentionVelocity(mentions, NOW, CFG);
    expect(r.windows.find((w) => w.windowMin === 60)!.count).toBe(2);
  });

  it('distinctAuthors is author-dominance aware (10 from 1 author != 10 from 10)', () => {
    const oneAuthor = Array.from({ length: 10 }, () => row({ authorHash: 'solo', postedAt: ago(10) }));
    const tenAuthors = Array.from({ length: 10 }, (_, i) => row({ authorHash: `a${i}`, postedAt: ago(10) }));

    const [rSolo] = computeMentionVelocity(oneAuthor, NOW, CFG);
    const [rMany] = computeMentionVelocity(tenAuthors, NOW, CFG);

    const w60 = (rows: typeof rSolo) => rows.windows.find((w) => w.windowMin === 60)!;
    expect(w60(rSolo).count).toBe(10);
    expect(w60(rSolo).distinctAuthors).toBe(1);
    expect(w60(rMany).count).toBe(10);
    expect(w60(rMany).distinctAuthors).toBe(10);
  });

  it('null authorHash counts toward count but not toward distinctAuthors', () => {
    const mentions = [row({ authorHash: null, postedAt: ago(5) }), row({ authorHash: null, postedAt: ago(5) })];
    const [r] = computeMentionVelocity(mentions, NOW, CFG);
    const w60 = r.windows.find((w) => w.windowMin === 60)!;
    expect(w60.count).toBe(2);
    expect(w60.distinctAuthors).toBe(0);
  });

  it('groups by tokenId when present, else by tokenAddress', () => {
    const mentions = [
      row({ tokenId: 't1', tokenAddress: 'A1' }),
      row({ tokenId: 't1', tokenAddress: 'A1' }),
      row({ tokenId: null, tokenAddress: 'A2' })
    ];
    const rows = computeMentionVelocity(mentions, NOW, CFG);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.tokenId === 't1')!.windows.find((w) => w.windowMin === 60)!.count).toBe(2);
    expect(rows.find((r) => r.tokenAddress === 'A2')!.windows.find((w) => w.windowMin === 60)!.count).toBe(1);
  });

  it('accel = shortest-window rate / longest-window rate (>1 when recent burst)', () => {
    // 3 mentions in last 60m, 3 more between 60m and 1440m ago → 6 total in 1440.
    const mentions = [
      row({ postedAt: ago(5) }),
      row({ postedAt: ago(10) }),
      row({ postedAt: ago(20) }),
      row({ postedAt: ago(600) }),
      row({ postedAt: ago(700) }),
      row({ postedAt: ago(800) })
    ];
    const [r] = computeMentionVelocity(mentions, NOW, CFG);
    // shortRate = 3/60 = 0.05 /min ; longRate = 6/1440 = 0.004166.. /min
    // accel = 0.05 / 0.0041666 = 12
    expect(r.accel).toBeCloseTo(12, 4);
  });

  it('accel is 0 when the longest window has no qualifying mentions', () => {
    // all mentions spam-excluded → no long-window mentions → accel 0, counts 0
    const mentions = [row({ postedAt: ago(5), spamScore: 99 })];
    const [r] = computeMentionVelocity(mentions, NOW, CFG) as [ReturnType<typeof computeMentionVelocity>[number]];
    expect(r?.accel ?? 0).toBe(0);
  });

  it('returns [] for empty input', () => {
    expect(computeMentionVelocity([], NOW, CFG)).toEqual([]);
  });
});
```

Run `npx vitest run packages/core/test/social/mentionVelocity.test.ts` — expected FAIL: `Failed to resolve import "../../src/social/mentionVelocity"`.

---

- [ ] **Step 9: Implement `mentionVelocity.ts` to pass.** Write `packages/core/src/social/mentionVelocity.ts`:

```typescript
// FlowRadar — social: pure mention-velocity computation (spec §5).
//
// PURE. Computed on READ, never stored. Excludes mentions with
// spamScore > cfg.spamMaxScore. Groups by tokenId (else tokenAddress). Per
// window: count and distinctAuthors (null authorHash counts toward count but
// not distinct authors — author-dominance aware). accel = the shortest
// window's per-minute rate divided by the longest window's per-minute rate
// (>1 = accelerating), 0 when the longest window has no qualifying mentions.

import type { MentionVelocityInput, MentionVelocityRow } from './types';

const MIN_MS = 60_000;

export function computeMentionVelocity(
  mentions: MentionVelocityInput[],
  now: Date,
  cfg: { windowsMin: number[]; spamMaxScore: number }
): MentionVelocityRow[] {
  const windowsMin = [...cfg.windowsMin].sort((a, b) => a - b);
  if (windowsMin.length === 0) return [];

  const kept = mentions.filter((m) => m.spamScore <= cfg.spamMaxScore);

  // Group by tokenId when present, else by tokenAddress. `none` collects
  // mentions with neither (still surfaced so unlinked tickers aren't dropped).
  interface Group {
    tokenId: string | null;
    tokenAddress: string | null;
    items: MentionVelocityInput[];
  }
  const groups = new Map<string, Group>();
  for (const m of kept) {
    const key = m.tokenId !== null ? `id:${m.tokenId}` : m.tokenAddress !== null ? `addr:${m.tokenAddress}` : 'none';
    let g = groups.get(key);
    if (!g) {
      g = { tokenId: m.tokenId, tokenAddress: m.tokenAddress, items: [] };
      groups.set(key, g);
    }
    g.items.push(m);
  }

  const nowMs = now.getTime();
  const shortMin = windowsMin[0]!;
  const longMin = windowsMin[windowsMin.length - 1]!;

  const rows: MentionVelocityRow[] = [];
  for (const g of groups.values()) {
    const windows = windowsMin.map((windowMin) => {
      const cutoff = nowMs - windowMin * MIN_MS;
      const inWin = g.items.filter((m) => m.postedAt.getTime() >= cutoff && m.postedAt.getTime() <= nowMs);
      const distinctAuthors = new Set(
        inWin.filter((m) => m.authorHash !== null).map((m) => m.authorHash as string)
      ).size;
      return { windowMin, count: inWin.length, distinctAuthors };
    });

    const shortCount = windows.find((w) => w.windowMin === shortMin)!.count;
    const longCount = windows.find((w) => w.windowMin === longMin)!.count;
    const shortRate = shortCount / shortMin;
    const longRate = longCount / longMin;
    const accel = longRate > 0 ? shortRate / longRate : 0;

    rows.push({ tokenId: g.tokenId, tokenAddress: g.tokenAddress, windows, accel });
  }

  return rows;
}
```

Run `npx vitest run packages/core/test/social/mentionVelocity.test.ts` — expected PASS (all 8 assertions green).

Commit:
```
git add packages/core/src/social/mentionVelocity.ts packages/core/test/social/mentionVelocity.test.ts
git commit -m "social(core): computeMentionVelocity (windows, distinct authors, accel)"
```

---

- [ ] **Step 10: Create the social barrel + wire the core public API.** Write `packages/core/src/social/index.ts`:

```typescript
// FlowRadar — @flowradar/core social intelligence barrel.
// PURE re-exports (spec §3-§5, §7). Consumed by providers, worker, db, web.
export * from './types';
export * from './extractMentions';
export * from './normalize';
export * from './classifySpam';
export * from './mentionVelocity';
```

Then Edit `packages/core/src/index.ts` to add the re-export. Insert after the existing `export * from './candidates/validate';` line:

```typescript
export * from './candidates/validate';
export * from './social/index';
```

Run `npx vitest run packages/core/test/social` — expected PASS (all 4 social test files green, ~30 assertions). This also proves the barrel + core index compile.

Commit:
```
git add packages/core/src/social/index.ts packages/core/src/index.ts
git commit -m "social(core): barrel + wire social exports into @flowradar/core"
```

---

- [ ] **Step 11: FAILING test — `connectors.social` settings defaults (spec §7).** Edit `packages/core/test/settings.test.ts` to append a new describe block at the end of the file (after the existing `SettingsSchema.connectors (Task 34 ...)` block's closing `});`):

```typescript
describe('SettingsSchema.connectors.social (Task B — social intelligence config §7)', () => {
  it('DEFAULT_SETTINGS.connectors.social carries the spec §7 defaults', () => {
    expect(DEFAULT_SETTINGS.connectors.social).toEqual({
      syncHours: 6,
      spam: {
        copypastaAuthorMin: 3,
        repeatAuthorMin: 5,
        lowContentMinChars: 12,
        windowMinutes: 360,
        weights: { copypasta: 80, repeat_author: 60, low_content: 50 },
        uiHideThreshold: 70
      },
      velocityWindowsMin: [60, 360, 1440]
    });
  });

  it('DEFAULT_SETTINGS parses through SettingsSchema with social present', () => {
    const parsed = SettingsSchema.parse(DEFAULT_SETTINGS);
    expect(parsed.connectors.social).toEqual(DEFAULT_SETTINGS.connectors.social);
  });

  it('parseSettings deep-merges a partial social override and keeps other social defaults', () => {
    const result = parseSettings({ connectors: { social: { syncHours: 12, spam: { uiHideThreshold: 60 } } } });
    expect(result.connectors.social.syncHours).toBe(12);
    expect(result.connectors.social.spam.uiHideThreshold).toBe(60);
    // untouched nested spam fields retained
    expect(result.connectors.social.spam.copypastaAuthorMin).toBe(3);
    expect(result.connectors.social.spam.weights).toEqual(DEFAULT_SETTINGS.connectors.social.spam.weights);
    expect(result.connectors.social.velocityWindowsMin).toEqual([60, 360, 1440]);
    // sibling connectors sub-configs untouched
    expect(result.connectors.dune).toEqual(DEFAULT_SETTINGS.connectors.dune);
    expect(result.connectors.sourcesEnabled).toEqual(DEFAULT_SETTINGS.connectors.sourcesEnabled);
  });

  it('parseSettings throws on an invalid social type', () => {
    expect(() => parseSettings({ connectors: { social: { syncHours: 'x' } } })).toThrow();
  });
});
```

Run `npx vitest run packages/core/test/settings.test.ts` — expected FAIL: the `DEFAULT_SETTINGS.connectors.social` assertion fails (`social` is `undefined`) and the invalid-type test fails to throw (a missing schema tolerates the unknown nested key).

---

- [ ] **Step 12: Add the `social` schema + default to `settings.ts`.** In `packages/core/src/settings.ts`:

First, add the two new Zod schemas immediately BEFORE the existing `const ConnectorsSchema = z.object({` line (right after the `DuneConnectorSchema` declaration). Use Edit with `old_string` = the `DuneConnectorSchema` block through `const ConnectorsSchema = z.object({`:

```typescript
const DuneConnectorSchema = z.object({
  syncHours: z.number()
});

// Task B (Social Intelligence, spec §7) — the inbound social-mention subsystem's
// config. syncHours reuses the hours→seconds *3600 worker convention. spam holds
// the pure-classifier thresholds/weights (see classifySpam.ts); velocityWindowsMin
// feeds computeMentionVelocity. Shadow-only: none of these feed FlowScore or the
// signal engine.
const SocialSpamConfigSchema = z.object({
  copypastaAuthorMin: z.number(),
  repeatAuthorMin: z.number(),
  lowContentMinChars: z.number(),
  windowMinutes: z.number(),
  weights: z.object({
    copypasta: z.number(),
    repeat_author: z.number(),
    low_content: z.number()
  }),
  uiHideThreshold: z.number()
});

const SocialConfigSchema = z.object({
  syncHours: z.number(),
  spam: SocialSpamConfigSchema,
  velocityWindowsMin: z.array(z.number())
});

const ConnectorsSchema = z.object({
```

Then add `social` to the `ConnectorsSchema` object body. Edit — replace:

```typescript
const ConnectorsSchema = z.object({
  sourcesEnabled: z.record(z.string(), z.boolean()),
  syncHours: z.number(),
  validationBatchSize: z.number(),
  topTraderBackfill: TopTraderBackfillSchema,
  dune: DuneConnectorSchema
});
```

with:

```typescript
const ConnectorsSchema = z.object({
  sourcesEnabled: z.record(z.string(), z.boolean()),
  syncHours: z.number(),
  validationBatchSize: z.number(),
  topTraderBackfill: TopTraderBackfillSchema,
  dune: DuneConnectorSchema,
  social: SocialConfigSchema
});
```

Then add the default to `DEFAULT_SETTINGS.connectors`. Edit — replace the `dune` block that closes the `connectors` object:

```typescript
    dune: {
      // Slower-moving than the wallet-source connectors — Dune refreshes are
      // credit-conscious by design (latest-cached-result only by default), so
      // a daily-ish default cadence (24h) rather than syncHours' 6h.
      syncHours: 24
    }
  }
};
```

with:

```typescript
    dune: {
      // Slower-moving than the wallet-source connectors — Dune refreshes are
      // credit-conscious by design (latest-cached-result only by default), so
      // a daily-ish default cadence (24h) rather than syncHours' 6h.
      syncHours: 24
    },
    // Social intelligence (spec §7). Shadow-only inbound-mention config.
    social: {
      syncHours: 6,
      spam: {
        copypastaAuthorMin: 3,
        repeatAuthorMin: 5,
        lowContentMinChars: 12,
        windowMinutes: 360,
        weights: { copypasta: 80, repeat_author: 60, low_content: 50 },
        uiHideThreshold: 70
      },
      velocityWindowsMin: [60, 360, 1440]
    }
  }
};
```

Run `npx vitest run packages/core/test/settings.test.ts` — expected PASS (existing settings tests still green + the 4 new social-config assertions green; note the invalid-type test now throws because `SocialConfigSchema` requires `syncHours: z.number()`).

Commit:
```
git add packages/core/src/settings.ts packages/core/test/settings.test.ts
git commit -m "social(core): add connectors.social config schema + defaults (spec §7)"
```

---

- [ ] **Step 13: Full-package regression + gate.** Run `npx vitest run packages/core` — expected PASS (every existing core test plus the 5 new social/settings files green; no regressions). Then run `npm run verify` — expected PASS (typecheck picks up the new `./social/index` re-export cleanly; no DB required for this task's tests). If `npm run verify` surfaces an unrelated red DB test that needs the LITE Postgres, confirm the port-5439 embedded DB is up per the repo's DB-test convention, but this task adds no DB tests of its own.

No commit for this step (verification only). If `verify` is green, Task B is complete.

**Done Bar:**
- `packages/core/src/social/` contains `types.ts`, `extractMentions.ts`, `normalize.ts`, `classifySpam.ts`, `mentionVelocity.ts`, `index.ts` with the EXACT signatures listed under Interfaces/Produces.
- `extractMentions('<CA>', 'SOLANA')` → one `address` mention conf 90; token-URL → `url` conf 85 with embedded address + `tokenUrl`; `$TICKER` → `ticker` conf 40 (uppercased, no `$`); no-token → `[]`; mixed → 2 rows; address+its-own-URL collapse to 1; sub-32-char base58 / plain words → `[]`; `chain !== 'SOLANA'` → `[]`.
- `normalizeSnippet` yields identical output for posts differing only in urls/emojis/case/spacing, is `<=280` chars, and empty/emoji-only → `''`; `contentHash` is a stable 64-hex sha256 that collapses copy-paste posts to one key.
- `classifySpam` returns the correct reason per rule, `spamScore` = max triggered weight, `{0,null}` for clean, and never mutates its input; thresholds are `>=` (copypasta/repeat) and `<` (low_content).
- `computeMentionVelocity` excludes `spamScore > spamMaxScore`, counts per nested window, is author-dominance aware (null author excluded from distinct), groups by tokenId then tokenAddress, computes `accel` = short-rate/long-rate (0 when long window empty), and returns `[]` for empty input.
- `DEFAULT_SETTINGS.connectors.social` deep-equals the spec §7 object and round-trips through `SettingsSchema`; a partial `social` override deep-merges; an invalid social type throws.
- `packages/core/src/index.ts` re-exports the social barrel; `npx vitest run packages/core` and `npm run verify` are green.

**Reviewer Focus:**
- **Shadow-only / no-scoring leakage (global constraints 4-7):** confirm NOTHING in this task imports or calls `flowScore.ts`, `walletScore.ts`, rule constants, or `evaluateAllRules`, and that `classifySpam`/`computeMentionVelocity` only *score/filter* — they must never drop a mention or emit an alert. Velocity/spam config lives under `connectors.social` and is never read by the scoring or signal engine.
- **Solana-only (constraint 8):** verify `extractMentions` early-returns `[]` for `chain !== 'SOLANA'` (test present) and that no BSC address heuristics were added.
- **False-positive base58 discipline:** scrutinize the `{32,44}` address regex and the base58 class `[1-9A-HJ-NP-Za-km-z]` (excludes 0/O/I/l) — a 31-char or plain-English string must not match, and a URL's embedded address must not double-count as a separate bare-address mention (URL-stripping before the bare scan).
- **Copy-paste key stability:** confirm `normalizeSnippet` strips URLs/emojis/mentions BEFORE hashing so genuinely-identical posts collapse, and the `<=280` truncation matches the schema `contentSnippet`/`normalizedSnippet` limit (spec §1).
- **Settings deep-merge integrity:** verify the new `SocialConfigSchema` is nested (not top-level, so `.strict()` still only guards the outermost object) and that a partial `connectors.social.spam` override deep-merges without wiping sibling `dune`/`sourcesEnabled` — matching the existing `parseSettings` deep-merge behavior.
- **Purity:** `packages/core` must stay dependency-clean — only `zod` (settings) and the Node builtin `node:crypto` (normalize); confirm no new entry in `packages/core/package.json` and no I/O/Date.now()/randomness inside these pure functions (`now` is always passed in).

### Task C: Inbound social providers (mock + telegram/discord stubs) + source status

**Depends on:** Task A (schema: `SocialSource`/`SocialMention` models migrated; `packages/db` client regenerated) and Task B (`packages/core/src/social` types + `extractMentions`/`normalizeSnippet`/`contentHash` exported from `@flowradar/core`). This task only *consumes* `Chain` and the `@flowradar/core` re-exports; it does not import anything from Task D (db helpers) or later. If Task A/B are not yet merged, the only hard dependency is the `Chain` type (already in `@flowradar/core` today), so every step below is runnable against the current tree.

**Files:**
- **Create** `packages/providers/src/social/types.ts` — `SocialPostRaw`, `FetchPostsOpts`, `SocialSourceProvider`, `SocialSourceMode`, `SocialSourceStatusRow`.
- **Create** `packages/providers/src/social/mockSocialSource.ts` — `MockSocialSource` (world-derived deterministic posts).
- **Create** `packages/providers/src/social/telegram.ts` — `createTelegramSocialSource(env)` (config-gated stub).
- **Create** `packages/providers/src/social/discord.ts` — `createDiscordSocialSource(env)` (config-gated stub).
- **Create** `packages/providers/src/social/sourceStatus.ts` — `getSocialSourceStatuses(prisma)`.
- **Create** `packages/providers/src/social/index.ts` — re-exports.
- **Create** `packages/providers/test/fixtures/social/mockPosts.json` — deterministic post templates.
- **Modify** `packages/providers/src/index.ts` — add `export * from './social';`.
- **Test** `packages/providers/test/socialSources.test.ts` — unit tests (parallel, `vi.stubGlobal('fetch')`).

**Interfaces:**

*Consumes* (exact signatures, already exported):
- `type Chain = 'SOLANA' | 'BSC'` from `@flowradar/core`.
- `createMockWorld(opts: { seed?: number; genesis: Date }): MockWorld`, `type MockWorld` (with `tokens: MockToken[]`, `type MockToken = { id: string; chain: Chain; address: string; symbol: string; name: string; decimals: number; createdAt: Date }`) from `../mock/world`.

*Produces* (later tasks rely on these EXACT names/signatures):
- `interface SocialPostRaw { externalId: string; authorHash?: string; content: string; url?: string; postedAt: Date; metadata?: Record<string, unknown>; }`
- `interface FetchPostsOpts { since?: Date; limit?: number; }`
- `interface SocialSourceProvider { name: string; platform: string; chains: Chain[]; fetchPosts(chain: Chain, opts?: FetchPostsOpts): Promise<SocialPostRaw[]>; }`
- `type SocialSourceMode = 'live' | 'mock' | 'missing_key' | 'stub';`
- `interface SocialSourceStatusRow { sourceName: string; platform: string; mode: SocialSourceMode; note: string; apiKeyEnvName: string | null; }`
- `class MockSocialSource implements SocialSourceProvider` with `constructor(world: MockWorld, opts?: { platform?: string; name?: string })`.
- `function createTelegramSocialSource(env: { SOCIAL_TELEGRAM_READ_TOKEN?: string }): SocialSourceProvider | null`
- `function createDiscordSocialSource(env: { SOCIAL_DISCORD_BOT_TOKEN?: string }): SocialSourceProvider | null`
- `function getSocialSourceStatuses(prisma: SocialSourceStatusClient): Promise<SocialSourceStatusRow[]>` (Task D's worker/UI call it; the ingest job in Task D resolves providers via `MOCK_MODE !== 'false' → new MockSocialSource(world) : per-platform factory`).

---

- [ ] **Step 1: Failing test — provider interface types + fixture shape.**
  Create the fixtures file FIRST (real content, referencing scenario symbols via `{{SYMBOL}}` placeholders — MockSocialSource resolves each to that symbol's real world address). Write `packages/providers/test/fixtures/social/mockPosts.json`:
  ```json
  [
    {
      "externalId": "tg-0001",
      "author": "a1",
      "offsetMin": 5,
      "content": "New play: $NOVA looking strong, CA {{NOVA}} aping a bag"
    },
    {
      "externalId": "tg-0002",
      "author": "a2",
      "offsetMin": 12,
      "content": "chart here https://dexscreener.com/solana/{{QUIET}} $QUIET early"
    },
    {
      "externalId": "tg-0003",
      "author": "a3",
      "offsetMin": 20,
      "content": "gm frens"
    },
    {
      "externalId": "tg-0004",
      "author": "a4",
      "offsetMin": 25,
      "content": "double play {{NOVA}} and {{SEED}} both moving, $NOVA $SEED"
    },
    {
      "externalId": "tg-0005",
      "author": "a5",
      "offsetMin": 30,
      "content": "🚀🚀 100x incoming ape now {{NOVA}} dont miss 🚀🚀"
    },
    {
      "externalId": "tg-0006",
      "author": "a6",
      "offsetMin": 31,
      "content": "🚀🚀 100x incoming ape now {{NOVA}} dont miss 🚀🚀"
    },
    {
      "externalId": "tg-0007",
      "author": "a7",
      "offsetMin": 32,
      "content": "🚀🚀 100x incoming ape now {{NOVA}} dont miss 🚀🚀"
    },
    {
      "externalId": "tg-0008",
      "author": "a2",
      "offsetMin": 40,
      "content": "still bullish $QUIET {{QUIET}} adding more"
    }
  ]
  ```
  (Templates give: a CA post, a URL-embedded-address post, a zero-token post, a multi-token post, and a 3-author copy-paste cluster — everything Task B's classifier and Task D's velocity/overlap need to demo end-to-end.)
  Write `packages/providers/test/socialSources.test.ts` with the first behavior only:
  ```typescript
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
  ```
- [ ] **Run it → expect FAIL** (module not found: `../src/social`):
  `npx vitest run packages/providers/test/socialSources.test.ts`
- [ ] **Step 2: Implement `types.ts`.**
  Create `packages/providers/src/social/types.ts`:
  ```typescript
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
  ```
- [ ] **Step 3: Implement `mockSocialSource.ts`.**
  Create `packages/providers/src/social/mockSocialSource.ts`:
  ```typescript
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
  ```
- [ ] **Step 4: Implement telegram/discord stubs + status + index; add the deterministic/world-linked test behaviors.**
  Create `packages/providers/src/social/telegram.ts`:
  ```typescript
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
  ```
  Create `packages/providers/src/social/discord.ts`:
  ```typescript
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
  ```
  Create `packages/providers/src/social/sourceStatus.ts`:
  ```typescript
  // FlowRadar — getSocialSourceStatuses: reports the effective mode for every
  // SocialSource ROW in the registry (spec §2/§8). Unlike the candidate
  // sourceStatus (a fixed 6-source spec list), social sources are
  // operator-managed DB rows, so this reads them from Prisma. Mirrors
  // getCandidateSourceStatuses's mode taxonomy ('live'|'mock'|'missing_key'|
  // 'stub'). Never echoes a secret VALUE — only the configured env var NAME
  // and whether it is present in process.env.
  //
  // Mode per source:
  //   - MOCK_MODE (default): every row => 'mock' (all resolve to the shared
  //     MockSocialSource, same one-switch convention as candidates).
  //   - live (MOCK_MODE=false):
  //       * platform 'manual'         => 'stub' (registry entry, no reader).
  //       * telegram/discord, no key  => 'missing_key' (apiKeyEnvName env
  //         value absent — factory returns null, ingest skips gracefully).
  //       * telegram/discord, keyed   => 'stub' (typed stub reader — a key
  //         alone doesn't make an unverified inbound integration real, same
  //         rule the kolscan/gmgn candidate stubs follow).
  import type { SocialSourceMode, SocialSourceStatusRow } from './types';

  /** Minimal shape this function reads — a full PrismaClient satisfies it. */
  export interface SocialSourceStatusClient {
    socialSource: {
      findMany(args: {
        select: { name: true; platform: true; apiKeyEnvName: true };
        orderBy: { name: 'asc' };
      }): Promise<{ name: string; platform: string; apiKeyEnvName: string | null }[]>;
    };
  }

  function isMockMode(): boolean {
    return process.env.MOCK_MODE !== 'false';
  }

  export async function getSocialSourceStatuses(prisma: SocialSourceStatusClient): Promise<SocialSourceStatusRow[]> {
    const sources = await prisma.socialSource.findMany({
      select: { name: true, platform: true, apiKeyEnvName: true },
      orderBy: { name: 'asc' }
    });

    const mockMode = isMockMode();

    return sources.map((s): SocialSourceStatusRow => {
      if (mockMode) {
        return {
          sourceName: s.name,
          platform: s.platform,
          mode: 'mock',
          note: 'MOCK_MODE active — serving deterministic mock posts.',
          apiKeyEnvName: s.apiKeyEnvName ?? null
        };
      }

      if (s.platform === 'manual') {
        return {
          sourceName: s.name,
          platform: s.platform,
          mode: 'stub',
          note: 'Manual registry entry — no automated reader this phase.',
          apiKeyEnvName: null
        };
      }

      const envName = s.apiKeyEnvName ?? null;
      const hasKey = Boolean(envName && process.env[envName]);
      const mode: SocialSourceMode = hasKey ? 'stub' : 'missing_key';
      return {
        sourceName: s.name,
        platform: s.platform,
        mode,
        note: hasKey
          ? 'Typed inbound stub — key present but no verified read integration yet; fetchPosts returns []. See file header TODO(provider).'
          : `Missing ${envName ?? 'read credential'}; factory returns null, ingest skips gracefully.`,
        apiKeyEnvName: envName
      };
    });
  }
  ```
  Create `packages/providers/src/social/index.ts`:
  ```typescript
  // FlowRadar — inbound social-source connector public API (spec §2).
  // Re-exported from @flowradar/providers's top-level index.ts.
  export * from './types';
  export * from './mockSocialSource';
  export * from './telegram';
  export * from './discord';
  export * from './sourceStatus';
  ```
  Append the remaining behaviors to `packages/providers/test/socialSources.test.ts` (inside the existing file, after the `MockSocialSource` describe block):
  ```typescript
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
  ```
- [ ] **Wire the barrel:** add to `packages/providers/src/index.ts`, immediately after the `export * from './candidates';` line:
  ```typescript
  export * from './social';
  ```
- [ ] **Run tests → expect PASS:**
  `npx vitest run packages/providers/test/socialSources.test.ts`
  (All ~16 assertions green. If TS complains about importing a `.json` fixture from `src`, confirm `resolveJsonModule` is on in `packages/providers/tsconfig.json` — it already is for the candidate fixtures, which are imported the same way in `candidateAdapters.test.ts`; the mock source imports the fixture with the identical relative `../../test/fixtures/...` path convention.)
- [ ] **Typecheck the package** (catches the cross-file `SocialSourceProvider` contract):
  `npx tsc -p packages/providers/tsconfig.json --noEmit`
  Expect: no errors.
- [ ] **Commit:**
  ```
  git add packages/providers/src/social packages/providers/test/socialSources.test.ts packages/providers/test/fixtures/social/mockPosts.json packages/providers/src/index.ts
  git commit -m "feat(providers): inbound social sources (mock + tg/discord stubs) + source status"
  ```

**Done Bar:**
- `packages/providers/src/social/{types,mockSocialSource,telegram,discord,sourceStatus,index}.ts` exist and are re-exported from `packages/providers/src/index.ts` (`export * from './social';`).
- `MockSocialSource(world)` produces the 8 deterministic posts from `test/fixtures/social/mockPosts.json`, with `{{SYMBOL}}` resolved to the world's real NOVA/QUIET/SEED addresses, identical across runs.
- The fixture set includes a 3-author copy-paste cluster (`tg-0005/06/07`), a multi-token post (`tg-0004`), a URL-embedded-address post (`tg-0002`), and a zero-token post (`tg-0003`) so Task B's classifier and Task D's velocity/overlap demo end-to-end in `MOCK_MODE`.
- `createTelegramSocialSource({})` and `createDiscordSocialSource({})` return `null`; keyed calls return a provider whose `fetchPosts` is `[]` with **no** `fetch` call; env var names are `SOCIAL_TELEGRAM_READ_TOKEN` / `SOCIAL_DISCORD_BOT_TOKEN` (NOT the outbound `TELEGRAM_BOT_TOKEN`).
- `getSocialSourceStatuses(prisma)` returns one row per `SocialSource`, mode `mock` under `MOCK_MODE`, and `stub`/`missing_key`/`stub` (manual/keyed/unkeyed) in live mode; `apiKeyEnvName` carries the NAME only; notes never contain a secret value.
- `npx vitest run packages/providers/test/socialSources.test.ts` and `npx tsc -p packages/providers/tsconfig.json --noEmit` both pass. (No DB, no network — parallel-safe.)

**Reviewer Focus:**
- **Outbound sender untouched (global constraints 1–2):** confirm nothing in `social/telegram.ts` imports or edits `packages/providers/src/telegram.ts`, and that the inbound stub gates on `SOCIAL_TELEGRAM_READ_TOKEN`, never `TELEGRAM_BOT_TOKEN`. Discord is inbound-only (no send path added anywhere).
- **No secrets (global constraint 10):** `getSocialSourceStatuses` and every stub must expose the env var NAME only; grep the `note` strings and returned objects for any `process.env[...]` VALUE leaking into output.
- **No hallucinated endpoints:** telegram/discord `fetchPosts` bodies are literally `return []` — verify there is no fabricated URL/host anywhere in `social/`.
- **Determinism & world-linkage:** MockSocialSource must derive addresses from `world.tokens` (not hardcoded literals) and use `world.meta.genesis` (not `Date.now()`), so the same world yields identical posts and the addresses actually resolve to seeded Token rows in Task D's ingest.
- **Graceful-skip contract for Task D:** the `null`-on-missing-key return (telegram/discord) and the `[]`-on-stub / `[]`-on-non-SOLANA returns are the exact behaviors Task D's ingest relies on to skip without crashing — check they can never throw.
- **Mode taxonomy parity:** `SocialSourceMode` is exactly `'live'|'mock'|'missing_key'|'stub'` (matches `ProviderStatus.mode`); the `keyed-stub => 'stub'` rule (a key alone doesn't make an unverified integration live) must mirror the candidate stubs, and `MOCK_MODE !== 'false'` (default-on) is the switch.

### Task D: Worker `socialIngest` job + reusable `runSocialIngestPass` + seed

**Files:**
- **Create:** `packages/db/src/social/ingest.ts` — `runSocialIngestPass(prisma, settings, resolveProvider, log)` (the reusable ingest body; mirrors `packages/db/src/externalWalletSource.ts`).
- **Create:** `apps/worker/src/jobs/socialIngest.ts` — `run(ctx)` thin wrapper (mirrors `apps/worker/src/jobs/externalWalletSource.ts`).
- **Create/Test:** `packages/db/test/socialIngest.test.ts` — `probePort(5439)` LITE-Postgres integration suite (mirrors `packages/db/test/externalWalletSource.test.ts`).
- **Modify:** `packages/db/src/index.ts` — add `export * from './social/ingest';` (place after the existing `export * from './externalWalletSource';` line).
- **Modify:** `apps/worker/src/index.ts` — import `* as socialIngest` and register it on `settings.connectors.social.syncHours * 3600`.
- **Modify:** `packages/db/src/seed.ts` — add a Phase 3.7 that creates 2 example `SocialSource` rows (1 telegram, 1 discord) and runs one `runSocialIngestPass` against the shared mock source.

**Interfaces:**

Consumes (from earlier tasks — exact signatures):
- Task A (schema, already migrated): Prisma models `SocialSource` (fields: `id, name, platform, externalId, inviteLink, notes, trustTier, enabled, chainSupport: ChainId[], apiKeyEnvName, rateLimitPerMinute, status, lastSyncAt, lastError, failCount, addedAt, metadataJson: Json?`) and `SocialMention` (`@@unique([sourceId, dedupeKey])`, fields per spec §1).
- Task B (`@flowradar/providers`): `SocialSourceProvider` (`{ name; platform; chains: Chain[]; fetchPosts(chain, opts?: FetchPostsOpts): Promise<SocialPostRaw[]> }`), `SocialPostRaw` (`{ externalId; authorHash?; content; url?; postedAt: Date; metadata? }`), `FetchPostsOpts` (`{ since?: Date; limit?: number }`), `MockSocialSource` (class; `new MockSocialSource(world)`), `createTelegramSocialSource(env)`, `createDiscordSocialSource(env)`.
- Task C (`@flowradar/core`): `extractMentions(content: string, chain: Chain): ExtractedMention[]` where `ExtractedMention = { mentionType: 'address'|'ticker'|'url'; tokenAddress?: string; tokenSymbol?: string; tokenUrl?: string; confidence: number }`; `normalizeSnippet(content: string): string`; `contentHash(normalized: string): string`; `classifySpam(ctx: SpamContext, cfg: SocialSpamConfig): { spamScore: number; spamReason: SpamReason | null }`; `Settings.connectors.social: SocialConfig` (`{ syncHours: number; spam: SocialSpamConfig; velocityWindowsMin: number[] }`) with `SocialSpamConfig = { copypastaAuthorMin; repeatAuthorMin; lowContentMinChars; windowMinutes; weights: { copypasta; repeat_author; low_content }; uiHideThreshold }`.

Produces (later tasks — Task E queries/overlap, Task F web UI — rely on these):
- `runSocialIngestPass(prisma, settings, resolveSocialProvider, log?): Promise<SocialIngestPassResult>` — the reusable body; the web app and seed both call it.
- `SocialSourceResolver = (source: SocialSourceRow) => SocialSourceProvider | null | undefined`.
- `SocialSourceRow = { id: string; name: string; platform: string; enabled: boolean; chainSupport: string[]; lastSyncAt: Date | null }`.
- `SocialIngestPassResult = { sourcesConsidered: number; sourcesSynced: number; sourcesSkippedDisabled: number; sourcesSkippedNoProvider: number; mentionsUpserted: number; postsScanned: number; errors: number }`.
- `SocialIngestLogger = { info(msg, meta?): void; error(msg, meta?): void }`.

---

- [ ] **Step 1: Write the failing integration test file (`socialIngest.test.ts`).**
  Create `packages/db/test/socialIngest.test.ts` with the full suite below. It uses a hand-rolled fake `SocialSourceProvider` (not the real `MockSocialSource`, to keep fixtures explicit and deterministic in-test), pre-seeds a `Token` for the link case, and a scoped resolver so shared-DB seed rows never pollute assertions. Prefix all created rows with `T_D_social_` for cleanup.

```typescript
// FlowRadar — runSocialIngestPass integration tests (Task D, Social
// Intelligence, Spec §6/§10). Same LITE-Postgres integration pattern as
// externalWalletSource.test.ts (probePort skipIf, prefix-cleanup, serialized).
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import net from 'node:net';
import { DEFAULT_SETTINGS } from '@flowradar/core';
import type { Chain } from '@flowradar/core';
import type { SocialSourceProvider, SocialPostRaw, FetchPostsOpts } from '@flowradar/providers';
import { prisma } from '../src/client';
import { runSocialIngestPass } from '../src/social/ingest';

const SOURCE_PREFIX = 'T_D_socialSource';
const ADDR_PREFIX = 'T_D_socialAddr';
const POST_PREFIX = 'T_D_socialPost';

function probePort(host: string, port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

let dbReachable = false;

beforeAll(async () => {
  dbReachable = await probePort('localhost', 5439);
  if (!dbReachable) {
    // eslint-disable-next-line no-console
    console.warn(
      '[socialIngest.test] LITE Postgres not reachable on localhost:5439 — skipping ' +
        'integration tests. Run `npm run db:migrate` first to exercise this suite.'
    );
  }
});

async function cleanup(): Promise<void> {
  await prisma.socialMention.deleteMany({ where: { source: { name: { startsWith: SOURCE_PREFIX } } } });
  await prisma.socialSource.deleteMany({ where: { name: { startsWith: SOURCE_PREFIX } } });
  await prisma.token.deleteMany({ where: { address: { startsWith: ADDR_PREFIX } } });
}

afterAll(async () => {
  if (!dbReachable) return;
  await cleanup();
  await prisma.$disconnect();
});

beforeEach(async () => {
  if (!dbReachable) return;
  await cleanup();
});

/** Explicit fake provider — deterministic post list, records fetch call count + the `since` it was handed. */
function makeFakeSocialProvider(
  platform: string,
  posts: SocialPostRaw[]
): SocialSourceProvider & { callCount: number; lastSince: Date | undefined } {
  return {
    name: 'fake-social',
    platform,
    chains: ['SOLANA'],
    callCount: 0,
    lastSince: undefined,
    async fetchPosts(_chain: Chain, opts?: FetchPostsOpts) {
      this.callCount += 1;
      this.lastSince = opts?.since;
      return posts;
    }
  };
}

async function makeSourceRow(
  name: string,
  overrides: Partial<{ enabled: boolean; platform: string; chainSupport: string[]; apiKeyEnvName: string | null }> = {}
) {
  return prisma.socialSource.create({
    data: {
      name,
      platform: overrides.platform ?? 'telegram',
      enabled: overrides.enabled ?? true,
      chainSupport: overrides.chainSupport ?? ['SOLANA'],
      apiKeyEnvName: overrides.apiKeyEnvName ?? 'SOCIAL_TELEGRAM_READ_TOKEN',
      rateLimitPerMinute: 30
    }
  });
}

describe.skipIf(!(await probePort('localhost', 5439)))('runSocialIngestPass', () => {
  it('extracts + upserts a SocialMention linked to an existing Token (chain,address)', async () => {
    const sourceName = `${SOURCE_PREFIX}_link`;
    await makeSourceRow(sourceName);
    const tokenAddress = `${ADDR_PREFIX}1111111111111111111111111111`; // 44-ish base58-ish for the extractor
    const token = await prisma.token.create({
      data: { chain: 'SOLANA', address: tokenAddress, symbol: 'TDLINK', name: 'Task D Link Token', decimals: 9, firstSeenAt: new Date() }
    });

    const provider = makeFakeSocialProvider('telegram', [
      {
        externalId: `${POST_PREFIX}_a`,
        authorHash: 'author-hash-1',
        content: `aping ${tokenAddress} looks strong, big volume incoming`,
        postedAt: new Date()
      }
    ]);

    const result = await runSocialIngestPass(prisma, DEFAULT_SETTINGS, (s) => (s.name === sourceName ? provider : null));

    expect(result.errors).toBe(0);
    expect(result.mentionsUpserted).toBe(1);

    const mention = await prisma.socialMention.findFirst({ where: { source: { name: sourceName } } });
    expect(mention).not.toBeNull();
    expect(mention!.tokenId).toBe(token.id);
    expect(mention!.mentionType).toBe('address');
    expect(mention!.tokenAddress).toBe(tokenAddress);
    expect(mention!.chain).toBe('SOLANA');
    expect(mention!.platform).toBe('telegram');
    expect(mention!.contentSnippet.length).toBeLessThanOrEqual(280);
    expect(mention!.dedupeKey).toBe(`${POST_PREFIX}_a::${tokenAddress}`);

    const sourceRow = await prisma.socialSource.findUnique({ where: { name: sourceName } });
    expect(sourceRow?.status).toBe('ok');
    expect(sourceRow?.lastSyncAt).not.toBeNull();
    expect(sourceRow?.failCount).toBe(0);
  });

  it('extracted token NOT in DB is stored with tokenId=null (graceful unlinked skip, never a crash)', async () => {
    const sourceName = `${SOURCE_PREFIX}_unlinked`;
    await makeSourceRow(sourceName);
    const unknownAddress = `${ADDR_PREFIX}9999999999999999999999999999`;

    const provider = makeFakeSocialProvider('telegram', [
      { externalId: `${POST_PREFIX}_u`, authorHash: 'author-hash-x', content: `fresh gem ${unknownAddress} not indexed yet`, postedAt: new Date() }
    ]);

    const result = await runSocialIngestPass(prisma, DEFAULT_SETTINGS, (s) => (s.name === sourceName ? provider : null));

    expect(result.errors).toBe(0);
    expect(result.mentionsUpserted).toBe(1);
    const mention = await prisma.socialMention.findFirst({ where: { source: { name: sourceName } } });
    expect(mention).not.toBeNull();
    expect(mention!.tokenId).toBeNull();
    expect(mention!.tokenAddress).toBe(unknownAddress);
  });

  it('pure $TICKER with no address stored unlinked (tokenSymbol set, tokenId null)', async () => {
    const sourceName = `${SOURCE_PREFIX}_ticker`;
    await makeSourceRow(sourceName);

    const provider = makeFakeSocialProvider('discord', [
      { externalId: `${POST_PREFIX}_t`, authorHash: 'author-hash-y', content: 'watching $BONK closely today', postedAt: new Date() }
    ]);

    const result = await runSocialIngestPass(prisma, DEFAULT_SETTINGS, (s) => (s.name === sourceName ? provider : null));

    expect(result.mentionsUpserted).toBe(1);
    const mention = await prisma.socialMention.findFirst({ where: { source: { name: sourceName } } });
    expect(mention!.mentionType).toBe('ticker');
    expect(mention!.tokenSymbol).toBe('BONK');
    expect(mention!.tokenAddress).toBeNull();
    expect(mention!.tokenId).toBeNull();
    expect(mention!.dedupeKey).toBe(`${POST_PREFIX}_t::$BONK`);
  });

  it('re-ingest (second pass, same post) is idempotent — 0 net new rows, upsert not insert', async () => {
    const sourceName = `${SOURCE_PREFIX}_idem`;
    await makeSourceRow(sourceName);
    const addr = `${ADDR_PREFIX}2222222222222222222222222222`;
    const provider = makeFakeSocialProvider('telegram', [
      { externalId: `${POST_PREFIX}_i`, authorHash: 'author-hash-i', content: `same post ${addr}`, postedAt: new Date() }
    ]);

    await runSocialIngestPass(prisma, DEFAULT_SETTINGS, (s) => (s.name === sourceName ? provider : null));
    await runSocialIngestPass(prisma, DEFAULT_SETTINGS, (s) => (s.name === sourceName ? provider : null));

    const rows = await prisma.socialMention.findMany({ where: { source: { name: sourceName } } });
    expect(rows).toHaveLength(1); // deduped on [sourceId, dedupeKey]
  });

  it('one post mentioning 2 tokens produces 2 mention rows (distinct dedupeKeys)', async () => {
    const sourceName = `${SOURCE_PREFIX}_multi`;
    await makeSourceRow(sourceName);
    const addrA = `${ADDR_PREFIX}3333333333333333333333333333`;
    const addrB = `${ADDR_PREFIX}4444444444444444444444444444`;
    const provider = makeFakeSocialProvider('telegram', [
      { externalId: `${POST_PREFIX}_m`, authorHash: 'author-hash-m', content: `rotating from ${addrA} into ${addrB}`, postedAt: new Date() }
    ]);

    const result = await runSocialIngestPass(prisma, DEFAULT_SETTINGS, (s) => (s.name === sourceName ? provider : null));
    expect(result.mentionsUpserted).toBe(2);
    const rows = await prisma.socialMention.findMany({ where: { source: { name: sourceName } }, orderBy: { tokenAddress: 'asc' } });
    expect(rows.map((r) => r.tokenAddress).sort()).toEqual([addrA, addrB].sort());
  });

  it('copy-paste across distinct authors is flagged copypasta via the contentHash lookback', async () => {
    const sourceName = `${SOURCE_PREFIX}_spam`;
    await makeSourceRow(sourceName);
    const addr = `${ADDR_PREFIX}5555555555555555555555555555`;
    // 3 distinct authors post the IDENTICAL content — copypastaAuthorMin default is 3.
    const identical = `buy ${addr} now 100x guaranteed to the moon rocket`;
    const provider = makeFakeSocialProvider('telegram', [
      { externalId: `${POST_PREFIX}_s1`, authorHash: 'spammer-A', content: identical, postedAt: new Date() },
      { externalId: `${POST_PREFIX}_s2`, authorHash: 'spammer-B', content: identical, postedAt: new Date() },
      { externalId: `${POST_PREFIX}_s3`, authorHash: 'spammer-C', content: identical, postedAt: new Date() }
    ]);

    const result = await runSocialIngestPass(prisma, DEFAULT_SETTINGS, (s) => (s.name === sourceName ? provider : null));
    expect(result.mentionsUpserted).toBe(3);

    const rows = await prisma.socialMention.findMany({ where: { source: { name: sourceName } } });
    // Shadow-only: rows are STORED, never dropped. The 3rd-ingested one sees 3 distinct authors -> copypasta.
    const flagged = rows.filter((r) => r.spamReason === 'copypasta');
    expect(flagged.length).toBeGreaterThanOrEqual(1);
    expect(Math.max(...rows.map((r) => r.spamScore))).toBeGreaterThanOrEqual(DEFAULT_SETTINGS.connectors.social.spam.weights.copypasta);
  });

  it('zero-token post is counted (postsScanned) but stored as ZERO mentions', async () => {
    const sourceName = `${SOURCE_PREFIX}_notoken`;
    await makeSourceRow(sourceName);
    const provider = makeFakeSocialProvider('telegram', [
      { externalId: `${POST_PREFIX}_z`, authorHash: 'author-z', content: 'gm everyone, great vibes today no tokens here', postedAt: new Date() }
    ]);

    const result = await runSocialIngestPass(prisma, DEFAULT_SETTINGS, (s) => (s.name === sourceName ? provider : null));
    expect(result.mentionsUpserted).toBe(0);
    expect(result.postsScanned).toBeGreaterThanOrEqual(1);

    const rows = await prisma.socialMention.findMany({ where: { source: { name: sourceName } } });
    expect(rows).toHaveLength(0);

    const sourceRow = await prisma.socialSource.findUnique({ where: { name: sourceName } });
    const meta = (sourceRow?.metadataJson ?? {}) as { postsScanned?: number };
    expect(meta.postsScanned).toBeGreaterThanOrEqual(1);
  });

  it('disabled source is skipped entirely — provider never called, no mentions', async () => {
    const sourceName = `${SOURCE_PREFIX}_disabled`;
    await makeSourceRow(sourceName, { enabled: false });
    const provider = makeFakeSocialProvider('telegram', [
      { externalId: `${POST_PREFIX}_d`, authorHash: 'author-d', content: 'should never run', postedAt: new Date() }
    ]);

    const result = await runSocialIngestPass(prisma, DEFAULT_SETTINGS, (s) => (s.name === sourceName ? provider : null));
    expect(result.sourcesSkippedDisabled).toBeGreaterThanOrEqual(1);
    expect(provider.callCount).toBe(0);
    const rows = await prisma.socialMention.findMany({ where: { source: { name: sourceName } } });
    expect(rows).toHaveLength(0);
  });

  it('resolver returning null (missing key / manual platform) is a graceful skip, never throws', async () => {
    const sourceName = `${SOURCE_PREFIX}_noprovider`;
    await makeSourceRow(sourceName, { platform: 'manual', apiKeyEnvName: null });

    const result = await runSocialIngestPass(prisma, DEFAULT_SETTINGS, () => null);
    expect(result.errors).toBe(0);
    expect(result.mentionsUpserted).toBe(0);
    expect(result.sourcesSkippedNoProvider).toBeGreaterThanOrEqual(1);
  });

  it('one source throwing never aborts other enabled sources (per-source try/catch)', async () => {
    const goodName = `${SOURCE_PREFIX}_good`;
    const badName = `${SOURCE_PREFIX}_bad`;
    await makeSourceRow(goodName);
    await makeSourceRow(badName);
    const addr = `${ADDR_PREFIX}6666666666666666666666666666`;

    const goodProvider = makeFakeSocialProvider('telegram', [
      { externalId: `${POST_PREFIX}_g`, authorHash: 'author-g', content: `clean call ${addr}`, postedAt: new Date() }
    ]);
    const badProvider: SocialSourceProvider = {
      name: 'bad-social',
      platform: 'telegram',
      chains: ['SOLANA'],
      async fetchPosts() {
        throw new Error('simulated social provider failure');
      }
    };

    const result = await runSocialIngestPass(prisma, DEFAULT_SETTINGS, (s) => (s.name === goodName ? goodProvider : badProvider));

    expect(result.errors).toBeGreaterThanOrEqual(1);
    expect(result.mentionsUpserted).toBeGreaterThanOrEqual(1);

    const goodMention = await prisma.socialMention.findFirst({ where: { source: { name: goodName } } });
    expect(goodMention).not.toBeNull();

    const badRow = await prisma.socialSource.findUnique({ where: { name: badName } });
    expect(badRow?.status).toBe('error');
    expect(badRow?.lastError).toContain('simulated social provider failure');
    expect(badRow?.failCount).toBeGreaterThanOrEqual(1);

    const goodRow = await prisma.socialSource.findUnique({ where: { name: goodName } });
    expect(goodRow?.status).toBe('ok');
  });

  it('one bad post never aborts sibling posts in the same source (per-post try/catch)', async () => {
    const sourceName = `${SOURCE_PREFIX}_perpost`;
    await makeSourceRow(sourceName);
    const addr = `${ADDR_PREFIX}7777777777777777777777777777`;
    const provider = makeFakeSocialProvider('telegram', [
      // A malformed post: content forced null-ish to trip an in-loop throw; the pass must catch + continue.
      { externalId: `${POST_PREFIX}_bad`, authorHash: 'author-bad', content: null as unknown as string, postedAt: new Date() },
      { externalId: `${POST_PREFIX}_ok`, authorHash: 'author-ok', content: `still fine ${addr}`, postedAt: new Date() }
    ]);

    const result = await runSocialIngestPass(prisma, DEFAULT_SETTINGS, (s) => (s.name === sourceName ? provider : null));
    // The good post still landed even though a sibling threw.
    const ok = await prisma.socialMention.findFirst({ where: { source: { name: sourceName }, tokenAddress: addr } });
    expect(ok).not.toBeNull();
    // Source is NOT marked error by a per-post failure (only per-source resolve/fetch failures are).
    const sourceRow = await prisma.socialSource.findUnique({ where: { name: sourceName } });
    expect(sourceRow?.status).toBe('ok');
    void result;
  });

  it('lastSyncAt from the prior pass is handed to fetchPosts as opts.since on the next pass', async () => {
    const sourceName = `${SOURCE_PREFIX}_since`;
    await makeSourceRow(sourceName);
    const provider = makeFakeSocialProvider('telegram', []);

    await runSocialIngestPass(prisma, DEFAULT_SETTINGS, (s) => (s.name === sourceName ? provider : null));
    const firstSyncAt = (await prisma.socialSource.findUnique({ where: { name: sourceName } }))!.lastSyncAt;
    expect(firstSyncAt).not.toBeNull();

    await runSocialIngestPass(prisma, DEFAULT_SETTINGS, (s) => (s.name === sourceName ? provider : null));
    expect(provider.lastSince).not.toBeUndefined();
    expect(provider.lastSince!.getTime()).toBe(firstSyncAt!.getTime());
  });
});
```

- [ ] **Step 2: Run the test — expect FAIL (module missing).**
  From repo root:
  `npx vitest run packages/db/test/socialIngest.test.ts`
  Expected: FAIL — `Cannot find module '../src/social/ingest'` (the file does not exist yet). If the DB is not up, the suite is skipped (`describe.skipIf`); before implementing, ensure it is reachable with `npm run db:migrate`, then re-run and confirm the tests actually execute and fail on the missing module / assertions (not silently skip).

- [ ] **Step 3: Implement `runSocialIngestPass` (`packages/db/src/social/ingest.ts`).**
  Write the reusable body. It mirrors `externalWalletSource.ts`'s structure exactly (narrow row type, per-source try/catch, status/lastError/failCount update) and additionally: per-post try/catch, `extractMentions` → `normalizeSnippet`/`contentHash` → contentHash lookback for `distinctAuthorsSameHash` → `classifySpam` → token resolve by `(chain, address)` → upsert on `[sourceId, dedupeKey]` → `postsScanned` counter in `metadataJson`.

```typescript
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
```

- [ ] **Step 4: Wire the DB export.**
  In `packages/db/src/index.ts`, add directly below the `export * from './externalWalletSource';` line:
  ```typescript
  export * from './social/ingest';
  ```

- [ ] **Step 5: Run the test — expect PASS.**
  `npx vitest run packages/db/test/socialIngest.test.ts`
  Expected: PASS — all cases green (link, unlinked, pure-ticker, idempotency, multi-token, copypasta lookback, zero-token counted, disabled skip, null-provider skip, per-source throw isolation, per-post throw isolation, `since` handoff). If `extractMentions`'s base58 detector rejects the `T_D_socialAddr…` fixtures as too short/invalid, lengthen the fixture addresses to a valid 32–44-char base58 string that Task C's extractor accepts (check `packages/core/test/extractMentions.test.ts` for a known-good address literal and reuse its shape), keeping the `ADDR_PREFIX` startsWith for cleanup.

- [ ] **Step 6: Commit the DB ingest body + test.**
  ```
  git add packages/db/src/social/ingest.ts packages/db/test/socialIngest.test.ts packages/db/src/index.ts
  git commit -m "feat(db): runSocialIngestPass — shadow-only social mention ingest + integration tests"
  ```

- [ ] **Step 7: Implement the worker-job wrapper (`apps/worker/src/jobs/socialIngest.ts`).**
  The worker `run(ctx)` is a THIN adapter over `runSocialIngestPass` — it only resolves mock-vs-live providers and delegates. Its behavior is already covered by the `runSocialIngestPass` DB integration test in this task (Steps 1-5) plus Task G's end-to-end gate, so there is NO separate failing worker-job test to write here (this mirrors `externalWalletSource.ts`/`walletCandidateValidation.ts` — the job body is tested through the DB, and the wrapper is exercised by `npm run verify`'s typecheck + the worker boot). Implement the thin wrapper:

```typescript
// FlowRadar — socialIngest job (Task D, Social Intelligence, Spec §6). Thin
// wrapper around @flowradar/db's runSocialIngestPass — the actual per-source
// provider resolution / mention upsert logic lives there (same
// worker/seed-sharing pattern as every other job in this directory — see
// externalWalletSource.ts's header).
//
// SHADOW-ONLY, INBOUND-ONLY (Spec global constraints 1/3/4): this job only
// reads SocialSource rows and writes SocialMention rows. It never emits an
// Alert, never touches FlowScore/Signal/CandidateWallet, and never sends
// anything outbound (it does NOT import packages/providers/src/telegram.ts's
// outbound alert sender).
//
// resolveSource: in MOCK_MODE, EVERY SocialSource row resolves to the SAME
// shared MockSocialSource instance (same "MOCK_MODE => mock source for ALL
// sources" decision as externalWalletSource.ts's getSharedMockCandidateSource),
// built once against a fresh MockWorld. Live mode (MOCK_MODE=false) maps each
// source by platform to its config-gated factory: telegram =>
// createTelegramSocialSource (null when SOCIAL_TELEGRAM_READ_TOKEN is absent),
// discord => createDiscordSocialSource (null when SOCIAL_DISCORD_BOT_TOKEN is
// absent), manual (or anything unrecognized) => null. A null return is treated
// by runSocialIngestPass as a graceful per-source skip, never a crash. These
// env var NAMES are DISTINCT from the outbound alert sender's TELEGRAM_BOT_TOKEN
// (Spec constraint 2 — the outbound sender is not reused or modified here).

import { runSocialIngestPass } from '@flowradar/db';
import {
  MockSocialSource,
  createMockWorld,
  createTelegramSocialSource,
  createDiscordSocialSource
} from '@flowradar/providers';
import type { SocialSourceProvider } from '@flowradar/providers';
import type { JobContext } from '../context';

const HOUR_MS = 60 * 60 * 1000;
const WORLD_HORIZON_HOURS = 72;

function isMockMode(): boolean {
  return process.env.MOCK_MODE !== 'false';
}

let sharedMockSocialSource: SocialSourceProvider | null = null;

/** Lazily builds ONE shared MockSocialSource for the life of this process — same genesis convention as externalWalletSource.ts's getSharedMockCandidateSource. */
function getSharedMockSocialSource(): SocialSourceProvider {
  if (!sharedMockSocialSource) {
    const genesis = new Date(Date.now() - WORLD_HORIZON_HOURS * HOUR_MS);
    const world = createMockWorld({ genesis });
    sharedMockSocialSource = new MockSocialSource(world);
  }
  return sharedMockSocialSource;
}

// Live-adapter cache (same rationale as externalWalletSource.ts's
// liveCandidateSourceCache — construct each factory at most once per process,
// reuse the returned instance + its single rate limiter on every call). Keyed
// by platform, since the live factory choice is platform-driven, not
// name-driven, for social sources.
const liveSocialSourceCache = new Map<string, SocialSourceProvider | null>();

/**
 * Live-mode (MOCK_MODE=false) source resolution by SocialSource.platform. Each
 * platform maps to its config-gated factory in @flowradar/providers/social —
 * both telegram/discord factories return `null` when their read-credential env
 * var is absent (a graceful per-source skip). `manual` (and any unrecognized
 * platform) resolves to null — no automated reader this phase.
 */
function resolveLiveSocialSource(platform: string): SocialSourceProvider | null {
  if (liveSocialSourceCache.has(platform)) {
    return liveSocialSourceCache.get(platform) ?? null;
  }

  let resolved: SocialSourceProvider | null;
  switch (platform) {
    case 'telegram':
      resolved = createTelegramSocialSource({ SOCIAL_TELEGRAM_READ_TOKEN: process.env.SOCIAL_TELEGRAM_READ_TOKEN });
      break;
    case 'discord':
      resolved = createDiscordSocialSource({ SOCIAL_DISCORD_BOT_TOKEN: process.env.SOCIAL_DISCORD_BOT_TOKEN });
      break;
    default:
      resolved = null;
  }

  liveSocialSourceCache.set(platform, resolved);
  return resolved;
}

export async function run(ctx: JobContext): Promise<void> {
  const { prisma, settings, log } = ctx;
  await runSocialIngestPass(
    prisma,
    settings,
    (source) => {
      if (isMockMode()) {
        return getSharedMockSocialSource();
      }
      return resolveLiveSocialSource(source.platform);
    },
    log
  );
}
```

- [ ] **Step 8: Register the job in `apps/worker/src/index.ts`.**
  Add the import alongside the other job imports (after the `duneQuery` import line):
  ```typescript
  import * as socialIngest from './jobs/socialIngest';
  ```
  Then add a new entry to the `jobs` array, after the `duneQuery` entry (mind the comma after the `duneQuery` object):
  ```typescript
  ,
  // socialIngest (Task D, Social Intelligence): shadow-only inbound social
  // mention ingest. Registered on settings.connectors.social.syncHours (6h
  // default) — same *3600 hours->seconds conversion as every other
  // hours-denominated interval above. INBOUND-ONLY / SHADOW-ONLY: never emits
  // an Alert and never touches the wallet/signal/scoring pipeline.
  {
    name: 'socialIngest',
    run: socialIngest.run,
    intervalSec: settings.connectors.social.syncHours * 3600
  }
  ```

- [ ] **Step 9: Typecheck + build the worker — expect PASS.**
  `npx tsc -p apps/worker/tsconfig.json --noEmit`
  Expected: PASS (no type errors). This confirms `@flowradar/db` re-exports `runSocialIngestPass`, `@flowradar/providers` re-exports `MockSocialSource`/`createTelegramSocialSource`/`createDiscordSocialSource` (Task B), and `settings.connectors.social.syncHours` exists on the `Settings` type (Task C).

- [ ] **Step 10: Commit the worker job + registration.**
  ```
  git add apps/worker/src/jobs/socialIngest.ts apps/worker/src/index.ts
  git commit -m "feat(worker): socialIngest job registered on connectors.social.syncHours"
  ```

- [ ] **Step 11: Add the seed rows + one ingest pass (`packages/db/src/seed.ts`).**
  Add a Phase 3.7. First, near the other `run*` seed imports (after `import { runExternalWalletSourceSync } from './externalWalletSource';`), add:
  ```typescript
  import { runSocialIngestPass } from './social/ingest';
  ```
  Add `MockSocialSource` to the existing `@flowradar/providers` import list (it already imports `MockCandidateSource, createMockWorld, ...` — append `MockSocialSource`).
  Add a wipe line in `wipeAllTables()` — SocialMention is a leaf under SocialSource (FK `onDelete: Cascade`), and both must be wiped before `token.deleteMany()` (SocialMention carries a nullable FK to Token). Place these two lines just above the `await prisma.externalWalletSource.deleteMany();` line:
  ```typescript
  // SocialMention carries FKs to SocialSource (Cascade) and Token (nullable) —
  // wiped leaf-first, before token.deleteMany() below (Task D, Social
  // Intelligence).
  await prisma.socialMention.deleteMany();
  await prisma.socialSource.deleteMany();
  ```
  Then add the seed helpers (near the ExternalWalletSource seed block, Phase 3.5):
  ```typescript
  // ---------------------------------------------------------------------------
  // Phase 3.7: SocialSource seed rows + one social ingest pass (Task D, Social
  // Intelligence, Spec §2/§6). 2 example rows (1 telegram, 1 discord, both
  // enabled) so `npm run db:seed` demonstrates the /social pipeline end-to-end
  // in MOCK_MODE. apiKeyEnvName is the env VAR NAME only (never a value — Spec
  // constraint 10). The /social empty state is what renders when zero sources
  // exist (fresh operator / all deleted).
  // ---------------------------------------------------------------------------

  const SOCIAL_SOURCE_SEED_ROWS = [
    {
      name: 'alpha-callers-tg',
      platform: 'telegram',
      trustTier: 'high',
      apiKeyEnvName: 'SOCIAL_TELEGRAM_READ_TOKEN',
      rateLimitPerMinute: 30,
      notes: 'Example seeded Telegram caller channel (mock-backed until real group link + read token exist).'
    },
    {
      name: 'degen-signals-dc',
      platform: 'discord',
      trustTier: 'medium',
      apiKeyEnvName: 'SOCIAL_DISCORD_BOT_TOKEN',
      rateLimitPerMinute: 30,
      notes: 'Example seeded Discord signals server (mock-backed until real channel + bot token exist).'
    }
  ] as const;

  async function bootstrapSocialSources(): Promise<number> {
    await prisma.socialSource.createMany({
      data: SOCIAL_SOURCE_SEED_ROWS.map((row) => ({
        name: row.name,
        platform: row.platform,
        trustTier: row.trustTier,
        enabled: true,
        chainSupport: ['SOLANA'] as Chain[],
        apiKeyEnvName: row.apiKeyEnvName,
        rateLimitPerMinute: row.rateLimitPerMinute,
        notes: row.notes
      }))
    });
    log('bootstrapped SocialSource rows.', { count: SOCIAL_SOURCE_SEED_ROWS.length });
    return SOCIAL_SOURCE_SEED_ROWS.length;
  }

  /**
   * Runs ONE runSocialIngestPass (Spec §6) — every enabled SocialSource row
   * resolves to the SAME shared MockSocialSource built from this seed run's own
   * `world` (deterministic, same convention as seedExternalWalletSourceSync).
   * The mock source's fixtures mention seeded mock-world tokens so /social's
   * mention-feed / velocity / wallet-signal-overlap panels populate out of the
   * box.
   */
  async function seedSocialIngestPass(world: MockWorld, settings: Settings) {
    const socialSource = new MockSocialSource(world);
    const result = await runSocialIngestPass(
      prisma,
      settings,
      () => socialSource,
      {
        info: (msg, meta) => log(msg, meta),
        error: (msg, meta) => log(`ERROR: ${msg}`, meta)
      }
    );
    log('social ingest pass complete.', { ...result });
    return result;
  }
  ```
  Finally, call them in `main()` — the ingest pass must run AFTER the Token rows are upserted (Phase 3.9's token loop, ~line 2172-2191) so `(chain, address)` token resolution links mentions. Add, immediately after `log('upserted Token rows + persisted riskFlags.', ...)`:
  ```typescript
  // Phase 3.7 (Task D, Social Intelligence): seed 2 example SocialSource rows,
  // then run ONE runSocialIngestPass against the shared mock source so
  // `npm run db:seed` populates SocialMention rows out of the box (no live
  // read credentials required — MockSocialSource, same mock-mode-by-default
  // convention as Phase 3.5). Runs AFTER Token upserts above so
  // (chain,address) resolution links mentions to real seeded tokens.
  await bootstrapSocialSources();
  const socialIngestResult = await seedSocialIngestPass(world, settings);
  log('social seed totals.', { ...socialIngestResult });
  ```

- [ ] **Step 12: Run the seed against the LITE DB — expect PASS with linked mentions.**
  `npm run db:seed`
  Expected: completes without error; the log shows `bootstrapped SocialSource rows. {"count":2}` and `social ingest pass complete.` with `mentionsUpserted` > 0, `errors: 0`. Then confirm at least one linked mention exists:
  `npx tsx -e "import('@flowradar/db').then(async ({prisma})=>{const n=await prisma.socialMention.count();const linked=await prisma.socialMention.count({where:{tokenId:{not:null}}});console.log(JSON.stringify({total:n,linked}));await prisma.$disconnect();})"`
  Expected: `total` > 0 and `linked` > 0 (mock fixtures reference seeded mock-world tokens, so some mentions link).

- [ ] **Step 13: Commit the seed integration.**
  ```
  git add packages/db/src/seed.ts
  git commit -m "feat(seed): 2 example SocialSource rows + one mock social ingest pass"
  ```

- [ ] **Step 14: Full gate — `npm run verify`.**
  `npm run verify`
  Expected: PASS (lint + typecheck + all Vitest suites, including `socialIngest.test.ts`, green on the rebuilt DB). If the social integration suite skipped because the DB was down, bring it up (`npm run db:migrate`) and re-run so the suite actually executes.

**Done Bar:**
- `packages/db/src/social/ingest.ts` exports `runSocialIngestPass` with the exact `SocialIngestPassResult` shape above, re-exported from `packages/db/src/index.ts`.
- `apps/worker/src/jobs/socialIngest.ts` exports `run(ctx)`; the worker registers `socialIngest` on `settings.connectors.social.syncHours * 3600` and boots without error.
- `packages/db/test/socialIngest.test.ts` passes every case: token-link, unlinked-token, pure-ticker, idempotent re-ingest, multi-token → 2 rows, copypasta lookback flag, zero-token counted-not-stored, disabled skip, null-provider skip, per-source throw isolation, per-post throw isolation, `lastSyncAt` → `opts.since` handoff.
- `npm run db:seed` creates exactly 2 `SocialSource` rows (1 telegram, 1 discord, enabled) and produces `SocialMention` rows with `errors: 0` and ≥1 `tokenId`-linked mention.
- No `Alert` row, no `Signal`/`CandidateWallet`/`FlowScore` write, and no import of the outbound `packages/providers/src/telegram.ts` sender anywhere in the created/modified files.
- `npm run verify` is green.

**Reviewer Focus:**
- **Shadow-only / inbound-only (constraints 1, 3, 4):** confirm `ingest.ts` and `socialIngest.ts` write ONLY `SocialSource`/`SocialMention` — no `prisma.alert.*`, no `prisma.signal.*`, no `prisma.candidateWallet.*`, no scoring writes — and that mentions are stored WITH `spamScore` (never `where`-filtered out / dropped at ingest).
- **Outbound sender untouched (constraint 2):** neither new file imports `packages/providers/src/telegram.ts`; the live factory env NAMES are `SOCIAL_TELEGRAM_READ_TOKEN` / `SOCIAL_DISCORD_BOT_TOKEN`, distinct from the existing `TELEGRAM_BOT_TOKEN`.
- **Graceful skips (constraint 11):** verify disabled sources, `manual` platform, missing-key/null-provider, stub `[]`, and missing-token all degrade cleanly (no throw); per-source `try/catch` isolates a throwing source and per-post `try/catch` isolates a malformed post without marking the source `error`.
- **dedupeKey + idempotency:** the formula matches Spec §1 exactly (`${externalPostId}::${tokenAddress ?? '$'+tokenSymbol ?? 'none'}`), the upsert keys on `[sourceId, dedupeKey]`, and a second identical pass adds zero rows.
- **Snippet safety (Spec §1):** both `contentSnippet` and `normalizedSnippet` are truncated to ≤280 chars; no full raw-message archival, and `authorHash` is stored opaquely (never a real handle — the pass copies whatever the adapter supplies without de-anonymizing).
- **Seed correctness:** wipe order removes `socialMention` then `socialSource` before `token`; the ingest pass runs AFTER Token upserts so `(chain, address)` linkage actually resolves; exactly 2 rows are seeded and `chainSupport` is Solana-only (no BSC).

### Task E: /social page + source-management API/UI + social query helpers

**Files:**
- Create `packages/db/src/social/queries.ts` — `getRecentMentions`, `getSocialSourceHealth` (Task F appends `getTokenSocialMentions` to this same file — NOT owned here).
- Create `packages/db/src/social/overlap.ts` — `getSocialSignalOverlap`.
- Modify `packages/db/src/index.ts` — add `export * from './social/queries';` and `export * from './social/overlap';`.
- Create `apps/web/app/social/page.tsx` — `/social` page (force-dynamic; empty state + mentions feed + velocity + wallet-signal overlap + Manage-sources + health). Uses its own feed/velocity markup; does NOT use the token-detail `SocialSection` (Task F owns that).
- Create `apps/web/app/social/SourceManager.tsx` — client add/edit/enable/delete form (`ImportForm` pattern, `router.refresh()`).
- Create `apps/web/app/api/social/sources/route.ts` — `POST` / `PATCH` / `DELETE`, Zod-validated, `apiKeyEnvName` name-only.
- Modify `apps/web/components/layout/sidebar-nav.tsx` — add `{ label: 'Social', href: '/social' }` nav item.
- Test `packages/db/test/socialQueries.test.ts` — DB integration (`probePort(5439)` skipIf) for `getRecentMentions`, `getSocialSourceHealth`, `getSocialSignalOverlap` (link vs unlinked, spam ordering, overlap join, empty).
- Test `apps/web/test/socialPage.test.ts` — Node source-text checks (matches this app's established `framingBanner.test.ts` pattern) for empty-state copy, spam-collapse threshold usage, `apiKeyEnvName`-name-only handling in the route, force-dynamic, and sidebar wiring.

> The token-detail `SocialSection` component (`apps/web/components/tokens/SocialSection.tsx`), the `apps/web/app/tokens/[id]/page.tsx` wiring, and `getTokenSocialMentions` are OWNED by Task F. This task builds only the `/social` route, its API, and the `getRecentMentions`/`getSocialSourceHealth`/`getSocialSignalOverlap` helpers.

> **Ownership note:** the token-detail social section (`apps/web/components/tokens/SocialSection.tsx`) and the `apps/web/app/tokens/[id]/page.tsx` wiring are OWNED by Task F. Where this task references that component/its props, defer to Task F's canonical version; implement only the `/social` route, API, and query helpers here.

**Interfaces:**

Consumes (from earlier tasks — exact signatures, do NOT redefine):
- Prisma models `SocialSource`, `SocialMention` (Task A schema, spec §1) — including `SocialMention` fields `tokenId: string | null`, `tokenAddress: string | null`, `tokenSymbol: string | null`, `authorHash: string | null`, `postedAt: Date`, `spamScore: number`, `spamReason: string | null`, `contentSnippet: string`, `mentionType: string`, `platform: string`, `chain: ChainId`, relation `source SocialSource`, relation `token Token?`; and `SocialSource` fields `id`, `name`, `platform`, `trustTier`, `enabled`, `apiKeyEnvName: string | null`, `chainSupport: ChainId[]`, `rateLimitPerMinute`, `notes: string | null`, `externalId: string | null`, `inviteLink: string | null`, `status`, `lastSyncAt: Date | null`, `lastError: string | null`, `failCount`, `metadataJson: Prisma.JsonValue | null`, `addedAt`.
- `getSocialSourceStatuses(prisma: PrismaClient): Promise<SocialSourceStatusRow[]>` where `SocialSourceStatusRow = { sourceName: string; platform: string; mode: 'live' | 'mock' | 'missing_key' | 'stub'; note: string; apiKeyEnvName: string | null }` (Task C providers, spec §2 — canonical owner), exported from `@flowradar/providers`. `getSocialSourceStatuses` is ASYNC — `await` it.
- `computeMentionVelocity(mentions, now, cfg): MentionVelocityRow[]` and type `MentionVelocityRow` (Task B core, spec §5), exported from `@flowradar/core`. Task B is the canonical owner: `MentionVelocityRow = { tokenId: string | null; tokenAddress: string | null; windows: { windowMin: number; count: number; distinctAuthors: number }[]; accel: number }` — per-window `count`/`distinctAuthors` live in the `windows[]` array (there is NO `counts`/`distinctAuthors` Record and NO `tokenSymbol` field on a velocity row). Read a window with `v.windows.find((w) => w.windowMin === W)?.count ?? 0` / `...?.distinctAuthors ?? 0`. `computeMentionVelocity` is SYNC (no `await`). Treat the row read-only; the display symbol for a velocity row comes from the mentions list (keyed by tokenId/tokenAddress), NOT from the velocity row.
- `Settings` from `@flowradar/core` with `connectors.social.spam.uiHideThreshold: number` and `connectors.social.velocityWindowsMin: number[]` (Task B settings, spec §7). The page reads the live `Settings` row via the existing pattern `const settingsRow = await prisma.settings.findFirst(); const settings = parseSettings(settingsRow?.values ?? {});` (import `parseSettings` from `@flowradar/core`).
- `prisma` from `@/lib/db` (web), `probePort` DB-test helper (existing test convention).

Produces (later tasks / this task's UI rely on these — exact names + types):
- `getRecentMentions(prisma: PrismaClient, opts?: { limit?: number; includeSpamAtOrAbove?: number }): Promise<RecentMentionRow[]>` — newest-first `SocialMention` rows with source + token eager-loaded, shaped as `RecentMentionRow`.
- `getSocialSourceHealth(prisma: PrismaClient): Promise<SocialSourceHealthRow[]>` — one row per `SocialSource` with mention counts + `postsScanned` from `metadataJson`.
- `getSocialSignalOverlap(prisma: PrismaClient, opts?: { windowMinutes?: number; limit?: number }): Promise<SocialSignalOverlapRow[]>` — read-only join of `SocialMention.tokenId` to `Signal` + latest `TokenFlowSnapshot`. Task E is the canonical owner of this function (see the exact shape below).
- Exported types `RecentMentionRow`, `SocialSourceHealthRow`, `SocialSignalOverlapRow`.

> `getTokenSocialMentions` is NOT produced here — Task F owns it (appended to this same `queries.ts` file). Task E ships only `getRecentMentions` + `getSocialSourceHealth` from `queries.ts`.

Exact produced type shapes (define verbatim in `queries.ts` / `overlap.ts`):
```typescript
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
  tokenSymbol: string | null;    // from linked Token if resolved, else extracted tokenSymbol
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
  mentionCount: number;      // stored SocialMention rows for this source
  postsScanned: number;      // metadataJson.postsScanned ?? 0
}
export interface SocialSignalOverlapRow {
  tokenId: string;
  tokenSymbol: string;
  tokenAddress: string;
  socialMentionCount: number;
  distinctAuthors: number;
  latestFlowScore: number | null;
  firedSignals: { rule: string; severity: string; triggeredAt: Date }[];
}
```

---

- [ ] **Step 1: Failing test — `getRecentMentions` / `getSocialSourceHealth` (link vs unlinked, spam ordering, per-source counts).**
  Create `packages/db/test/socialQueries.test.ts`. Mirror the `probePort(5439)` skipIf + prefix-cleanup + serialized convention used by other DB integration tests in `packages/db/test`.
  ```typescript
  import { afterAll, beforeAll, describe, expect, it } from 'vitest';
  import net from 'node:net';
  import {
    getRecentMentions,
    getSocialSourceHealth,
    getSocialSignalOverlap
  } from '../src/index';
  import { prisma } from '../src/client';

  function probePort(host: string, port: number, timeoutMs = 1000): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = net.createConnection({ host, port });
      const done = (ok: boolean) => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(ok);
      };
      socket.setTimeout(timeoutMs);
      socket.once('connect', () => done(true));
      socket.once('timeout', () => done(false));
      socket.once('error', () => done(false));
    });
  }

  const PREFIX = 'sq_test_';
  let dbReachable = false;

  beforeAll(async () => {
    dbReachable = await probePort('localhost', 5439);
    if (!dbReachable) return;
    // Clean any leftover rows from a prior run (prefix-scoped).
    await prisma.socialMention.deleteMany({ where: { source: { name: { startsWith: PREFIX } } } });
    await prisma.socialSource.deleteMany({ where: { name: { startsWith: PREFIX } } });
  });

  afterAll(async () => {
    if (dbReachable) {
      await prisma.socialMention.deleteMany({ where: { source: { name: { startsWith: PREFIX } } } });
      await prisma.socialSource.deleteMany({ where: { name: { startsWith: PREFIX } } });
    }
    await prisma.$disconnect();
  });

  describe.skipIf(!dbReachable)('social queries (DB integration)', () => {
    it('getRecentMentions orders newest-first and shapes link vs unlinked rows', async () => {
      const source = await prisma.socialSource.create({
        data: { name: `${PREFIX}tg`, platform: 'telegram', trustTier: 'high', enabled: true, chainSupport: ['SOLANA'], apiKeyEnvName: 'SOCIAL_TELEGRAM_READ_TOKEN' }
      });
      // A real Token to link one mention to.
      const token = await prisma.token.create({
        data: { chain: 'SOLANA', address: `${PREFIX}addr_nova`, symbol: 'NOVA', name: 'Nova', decimals: 9, firstSeenAt: new Date(), riskFlags: [] }
      });
      const older = new Date('2026-07-07T10:00:00Z');
      const newer = new Date('2026-07-07T11:00:00Z');
      await prisma.socialMention.create({
        data: {
          sourceId: source.id, platform: 'telegram', externalPostId: 'p1', postedAt: older,
          chain: 'SOLANA', contentSnippet: 'buy $NOVA now', normalizedSnippet: 'buy nova now',
          contentHash: 'h1', mentionType: 'ticker', tokenSymbol: 'NOVA', tokenId: token.id,
          confidence: 40, spamScore: 10, dedupeKey: 'p1::$NOVA'
        }
      });
      await prisma.socialMention.create({
        data: {
          sourceId: source.id, platform: 'telegram', externalPostId: 'p2', postedAt: newer,
          chain: 'SOLANA', contentSnippet: 'ticker only $GHOST', normalizedSnippet: 'ticker only ghost',
          contentHash: 'h2', mentionType: 'ticker', tokenSymbol: 'GHOST', tokenId: null,
          confidence: 40, spamScore: 5, dedupeKey: 'p2::$GHOST'
        }
      });

      const rows = await getRecentMentions(prisma, { limit: 10 });
      const mine = rows.filter((r) => r.sourceName === `${PREFIX}tg`);
      expect(mine).toHaveLength(2);
      // Newest first.
      expect(mine[0].tokenSymbol).toBe('GHOST');
      expect(mine[0].tokenId).toBeNull();          // unlinked
      expect(mine[1].tokenId).toBe(token.id);      // linked
      expect(mine[1].tokenSymbol).toBe('NOVA');
      expect(mine[0].sourceTrustTier).toBe('high');
    });

    it('getRecentMentions excludes rows at/above includeSpamAtOrAbove only when asked (default returns all)', async () => {
      const source = await prisma.socialSource.create({
        data: { name: `${PREFIX}spam`, platform: 'discord', enabled: true, chainSupport: ['SOLANA'] }
      });
      await prisma.socialMention.create({
        data: {
          sourceId: source.id, platform: 'discord', externalPostId: 's1', postedAt: new Date(),
          chain: 'SOLANA', contentSnippet: 'spammy', normalizedSnippet: 'spammy', contentHash: 'hs1',
          mentionType: 'ticker', tokenSymbol: 'SPAM', spamScore: 90, spamReason: 'copypasta', dedupeKey: 's1::$SPAM'
        }
      });
      const all = await getRecentMentions(prisma, { limit: 100 });
      expect(all.some((r) => r.sourceName === `${PREFIX}spam`)).toBe(true);
      // getRecentMentions never DROPS by spam by default (UI collapses; shadow-only stores everything).
      const stillThere = await getRecentMentions(prisma, { limit: 100, includeSpamAtOrAbove: 100 });
      expect(stillThere.some((r) => r.sourceName === `${PREFIX}spam`)).toBe(true);
    });

    it('getSocialSourceHealth reports mention counts + postsScanned from metadataJson', async () => {
      const source = await prisma.socialSource.create({
        data: {
          name: `${PREFIX}health`, platform: 'telegram', trustTier: 'medium', enabled: false,
          chainSupport: ['SOLANA'], apiKeyEnvName: 'SOCIAL_TELEGRAM_READ_TOKEN',
          rateLimitPerMinute: 30, status: 'ok', metadataJson: { postsScanned: 42 }
        }
      });
      await prisma.socialMention.create({
        data: {
          sourceId: source.id, platform: 'telegram', externalPostId: 'hp1', postedAt: new Date(),
          chain: 'SOLANA', contentSnippet: 'x', normalizedSnippet: 'x', contentHash: 'hh1',
          mentionType: 'ticker', tokenSymbol: 'HLTH', dedupeKey: 'hp1::$HLTH'
        }
      });
      const health = await getSocialSourceHealth(prisma);
      const row = health.find((h) => h.name === `${PREFIX}health`);
      expect(row).toBeDefined();
      expect(row!.enabled).toBe(false);
      expect(row!.mentionCount).toBe(1);
      expect(row!.postsScanned).toBe(42);
      expect(row!.apiKeyEnvName).toBe('SOCIAL_TELEGRAM_READ_TOKEN');
    });
  });
  ```
  NOTE: this file uses the pinned repo pattern — `let dbReachable = false; beforeAll(async () => { dbReachable = await probePort('localhost', 5439); });` + `describe.skipIf(!dbReachable)` (NO top-level await), and the shared `prisma` from `../src/client`. `getTokenSocialMentions` is NOT tested here — Task F owns it and ships `packages/db/src/social/getTokenSocialMentions.test.ts`.

- [ ] **Step 2: Run the test — expect FAIL (module not found / functions undefined).**
  Command (repo root): `npx vitest run packages/db/test/socialQueries.test.ts`
  Expected: FAIL — `getRecentMentions`/`getSocialSourceHealth`/`getSocialSignalOverlap` are not exported from `../src/index` yet (import error), OR (if the DB isn't up) the whole suite is SKIPPED. If skipped, start the LITE Postgres on 5439 first (the repo's documented DB-test prerequisite) so the assertions actually run and fail.

- [ ] **Step 3: Implement `packages/db/src/social/queries.ts` (minimal, real).**
  ```typescript
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
      include: MENTION_INCLUDE
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
  ```

- [ ] **Step 4: Implement `packages/db/src/social/overlap.ts` (read-only join — no writes/scoring/alerts).**
  ```typescript
  // FlowRadar — getSocialSignalOverlap (Task E, spec §9). READ-ONLY, SHADOW-
  // ONLY confluence display: joins SocialMention.tokenId to tokens that ALSO
  // have recent wallet-driven evidence (Signal rows and/or a latest
  // TokenFlowSnapshot) in a window. NO scoring, NO alerts, NO writes, NO
  // FlowScore/CandidateWallet interaction (spec constraints 3/4/5/7).
  import type { PrismaClient } from '@prisma/client';

  export interface SocialSignalOverlapRow {
    tokenId: string;
    tokenSymbol: string;
    tokenAddress: string;
    socialMentionCount: number;
    distinctAuthors: number;
    latestFlowScore: number | null;
    firedSignals: { rule: string; severity: string; triggeredAt: Date }[];
  }

  const DEFAULT_WINDOW_MIN = 1440; // 24h

  export async function getSocialSignalOverlap(
    prisma: PrismaClient,
    opts?: { windowMinutes?: number; limit?: number }
  ): Promise<SocialSignalOverlapRow[]> {
    const windowMinutes = opts?.windowMinutes ?? DEFAULT_WINDOW_MIN;
    const limit = opts?.limit ?? 25;
    const since = new Date(Date.now() - windowMinutes * 60_000);

    // 1) Tokens with LINKED social mentions in the window (tokenId not null).
    const mentionGroups = await prisma.socialMention.groupBy({
      by: ['tokenId'],
      where: { tokenId: { not: null }, postedAt: { gte: since } },
      _count: { _all: true }
    });
    const tokenIds = mentionGroups
      .map((g) => g.tokenId)
      .filter((id): id is string => id !== null);
    if (tokenIds.length === 0) return [];

    // 2) Which of those tokens ALSO have wallet-driven evidence in the window:
    //    a Signal fired OR a TokenFlowSnapshot exists. Fetch both, then keep
    //    only tokens present in at least one.
    const [tokens, signals, flowSnaps, mentions] = await Promise.all([
      prisma.token.findMany({
        where: { id: { in: tokenIds } },
        select: { id: true, symbol: true, address: true }
      }),
      prisma.signal.findMany({
        where: { tokenId: { in: tokenIds }, triggeredAt: { gte: since } },
        select: { tokenId: true, rule: true, severity: true, triggeredAt: true },
        orderBy: { triggeredAt: 'desc' }
      }),
      prisma.tokenFlowSnapshot.findMany({
        where: { tokenId: { in: tokenIds }, ts: { gte: since } },
        select: { tokenId: true, flowScore: true, ts: true },
        orderBy: { ts: 'desc' }
      }),
      // distinct-author + count per token — pull the linked mentions in-window.
      prisma.socialMention.findMany({
        where: { tokenId: { in: tokenIds }, postedAt: { gte: since } },
        select: { tokenId: true, authorHash: true }
      })
    ]);

    const tokenById = new Map(tokens.map((t) => [t.id, t]));

    const signalsByToken = new Map<string, { rule: string; severity: string; triggeredAt: Date }[]>();
    for (const s of signals) {
      const list = signalsByToken.get(s.tokenId) ?? [];
      list.push({ rule: String(s.rule), severity: String(s.severity), triggeredAt: s.triggeredAt });
      signalsByToken.set(s.tokenId, list);
    }

    // latest flow score per token (list is already ts-desc).
    const latestFlowByToken = new Map<string, number>();
    for (const f of flowSnaps) {
      if (!latestFlowByToken.has(f.tokenId)) latestFlowByToken.set(f.tokenId, f.flowScore);
    }

    const countByToken = new Map<string, number>();
    const authorsByToken = new Map<string, Set<string>>();
    for (const m of mentions) {
      if (!m.tokenId) continue;
      countByToken.set(m.tokenId, (countByToken.get(m.tokenId) ?? 0) + 1);
      const set = authorsByToken.get(m.tokenId) ?? new Set<string>();
      if (m.authorHash) set.add(m.authorHash);
      authorsByToken.set(m.tokenId, set);
    }

    const rows: SocialSignalOverlapRow[] = [];
    for (const tokenId of tokenIds) {
      const token = tokenById.get(tokenId);
      if (!token) continue;
      const firedSignals = signalsByToken.get(tokenId) ?? [];
      const latestFlowScore = latestFlowByToken.get(tokenId) ?? null;
      // "Overlap" = social mention AND at least one wallet-driven evidence leg.
      if (firedSignals.length === 0 && latestFlowScore === null) continue;
      rows.push({
        tokenId,
        tokenSymbol: token.symbol,
        tokenAddress: token.address,
        socialMentionCount: countByToken.get(tokenId) ?? 0,
        distinctAuthors: authorsByToken.get(tokenId)?.size ?? 0,
        latestFlowScore,
        firedSignals
      });
    }

    // Strongest confluence first: most social mentions, then flow score.
    rows.sort((a, b) => b.socialMentionCount - a.socialMentionCount || (b.latestFlowScore ?? 0) - (a.latestFlowScore ?? 0));
    return rows.slice(0, limit);
  }
  ```

- [ ] **Step 5: Wire exports + add the overlap test case, then run — expect PASS.**
  In `packages/db/src/index.ts` add (after the existing `export * from './dune/localOverlap';` line):
  ```typescript
  export * from './social/queries';
  export * from './social/overlap';
  ```
  Append this overlap test to `packages/db/test/socialQueries.test.ts`'s `describe` block:
  ```typescript
    it('getSocialSignalOverlap joins linked mentions to Signal/flow evidence; skips unlinked and evidence-less tokens', async () => {
      const source = await prisma.socialSource.create({
        data: { name: `${PREFIX}ov`, platform: 'telegram', enabled: true, chainSupport: ['SOLANA'] }
      });
      // Token WITH social + a Signal + a flow snapshot => appears.
      const hot = await prisma.token.create({
        data: { chain: 'SOLANA', address: `${PREFIX}addr_hot`, symbol: 'HOT', name: 'Hot', decimals: 9, firstSeenAt: new Date(), riskFlags: [] }
      });
      // Token WITH social but NO wallet evidence => excluded.
      const cold = await prisma.token.create({
        data: { chain: 'SOLANA', address: `${PREFIX}addr_cold`, symbol: 'COLD', name: 'Cold', decimals: 9, firstSeenAt: new Date(), riskFlags: [] }
      });
      const now = new Date();
      for (const [i, tk] of [hot, cold].entries()) {
        await prisma.socialMention.create({
          data: {
            sourceId: source.id, platform: 'telegram', externalPostId: `ov${i}`, postedAt: now,
            chain: 'SOLANA', contentSnippet: 'x', normalizedSnippet: 'x', contentHash: `ovh${i}`,
            mentionType: 'address', tokenAddress: tk.address, tokenId: tk.id, authorHash: `a${i}`,
            dedupeKey: `ov${i}::${tk.address}`
          }
        });
      }
      await prisma.signal.create({
        data: {
          tokenId: hot.id, rule: 'A', severity: 'HIGH', triggeredAt: now, reasons: {},
          walletCount: 5, uniqueEntityCount: 4, netFlowUsd: 1000, mcapAtTrigger: 50000, status: 'active'
        }
      });
      await prisma.tokenFlowSnapshot.create({
        data: {
          tokenId: hot.id, ts: now, windowMinutes: 60, flowScore: 77, smartWalletCount: 5,
          humanLikeCount: 4, possibleBotCount: 1, uniqueEntityCount: 4, clusterAdjustedWalletCount: 4,
          entityConcentrationRisk: 0.2, trackedBuyVolumeUsd: 1000, trackedSellVolumeUsd: 100,
          netFlowUsd: 900, buySellRatio: 10, avgEntryMcap: 40000, currentMcap: 50000,
          mcapExpansionFromAvgEntry: 1.25, holdersGrowth: 0.1, liquidityChange: 0.05,
          signalStatus: 'hot', componentBreakdown: {}
        }
      });

      const overlap = await getSocialSignalOverlap(prisma, { windowMinutes: 1440, limit: 25 });
      const hotRow = overlap.find((r) => r.tokenId === hot.id);
      const coldRow = overlap.find((r) => r.tokenId === cold.id);
      expect(hotRow).toBeDefined();
      expect(hotRow!.socialMentionCount).toBe(1);
      expect(hotRow!.distinctAuthors).toBe(1);
      expect(hotRow!.latestFlowScore).toBe(77);
      expect(hotRow!.firedSignals.map((s) => s.rule)).toContain('A');
      expect(coldRow).toBeUndefined(); // social but no wallet evidence => excluded
    });
  ```
  NOTE: match the `Signal`/`TokenFlowSnapshot` create payloads to the actual required columns/enum values in `packages/db/prisma/schema.prisma` (e.g. `rule`/`severity` are enums `SignalRule`/`SignalSeverity`, `signalStatus` is `FlowSignalStatus`). If a required column is missing or an enum literal differs, read the schema and correct the literal — do NOT stub the model.
  Command: `npx vitest run packages/db/test/socialQueries.test.ts`
  Expected: PASS (all 5 tests) with the LITE Postgres up.

- [ ] **Step 6: Commit the query helpers.**
  ```
  git add packages/db/src/social/queries.ts packages/db/src/social/overlap.ts packages/db/src/index.ts packages/db/test/socialQueries.test.ts
  git commit -m "Task E: social read helpers (recent mentions, source health, token mentions, signal overlap)"
  ```

- [ ] **Step 7: Failing test — `/api/social/sources` route: Zod-validated POST/PATCH/DELETE, apiKeyEnvName name-only.**
  This app has no route-handler runtime test harness (see `overlapHybridTruncation.test.ts` header). Follow that exact precedent: a Node source-text check that the route enforces the shadow-only + name-only contract. Create `apps/web/test/socialPage.test.ts` with the route portion first:
  ```typescript
  import { describe, expect, it } from 'vitest';
  import { readFileSync } from 'node:fs';
  import { fileURLToPath } from 'node:url';
  import path from 'node:path';

  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const APP_ROOT = path.resolve(HERE, '..');
  const read = (...p: string[]) => readFileSync(path.join(APP_ROOT, ...p), 'utf-8').replace(/\r\n/g, '\n');

  describe('/api/social/sources route (Task E — Zod, name-only key, shadow-only)', () => {
    const src = read('app', 'api', 'social', 'sources', 'route.ts');

    it('exports POST, PATCH and DELETE handlers', () => {
      expect(src).toMatch(/export async function POST\s*\(/);
      expect(src).toMatch(/export async function PATCH\s*\(/);
      expect(src).toMatch(/export async function DELETE\s*\(/);
    });

    it('validates the body with Zod (parses a schema, not raw body)', () => {
      expect(src).toMatch(/z\.object\(/);
      expect(src).toMatch(/\.parse\(/);
    });

    it('treats apiKeyEnvName as a NAME only — never reads process.env[...] for its value and never stores a secret value', () => {
      // The route must not resolve the env VALUE of the submitted name.
      expect(src).not.toMatch(/process\.env\[[^\]]*apiKeyEnvName/);
      // A plain field named apiKeyEnvName is expected (the NAME), so its
      // presence as a schema field is fine; the guard above is the real check.
      expect(src).toMatch(/apiKeyEnvName/);
    });

    it('never creates Alert rows or touches CandidateWallet/FlowScore (shadow-only, constraint 3/4/7)', () => {
      expect(src).not.toMatch(/\.alert\./);
      expect(src).not.toMatch(/candidateWallet/i);
      expect(src).not.toMatch(/flowScore/i);
    });
  });
  ```

- [ ] **Step 8: Run — expect FAIL (route file does not exist).**
  Command: `npx vitest run apps/web/test/socialPage.test.ts`
  Expected: FAIL — `readFileSync(...route.ts)` throws ENOENT (file missing).

- [ ] **Step 9: Implement `apps/web/app/api/social/sources/route.ts`.**
  ```typescript
  // FlowRadar — /api/social/sources (Task E, spec §8). Operator CRUD over the
  // SocialSource registry from the /social "Manage sources" UI.
  //
  // SHADOW-ONLY + secret-safe (spec constraints 3/4/10):
  //   - apiKeyEnvName is stored as the env VAR NAME only — the route never
  //     resolves process.env[name] and never persists a secret value.
  //   - No Alert rows, no CandidateWallet/FlowScore interaction — this only
  //     writes SocialSource registry rows.
  // Mirrors the "accept either sourceId or name" + Zod-issue-list convention of
  // /api/sources and /api/import.
  import { NextResponse } from 'next/server';
  import { z, ZodError } from 'zod';
  import { prisma } from '@/lib/db';

  const PLATFORMS = ['telegram', 'discord', 'manual'] as const;
  const TRUST_TIERS = ['high', 'medium', 'low'] as const;

  const CreateSchema = z.object({
    name: z.string().min(1).max(100),
    platform: z.enum(PLATFORMS),
    trustTier: z.enum(TRUST_TIERS).default('medium'),
    externalId: z.string().min(1).max(200).optional(),
    inviteLink: z.string().min(1).max(500).optional(),
    notes: z.string().max(1000).optional(),
    // NAME of an env var, not a value (spec constraint 10). Loosely validated
    // as an env-var-name shape; null/omitted allowed (required-null for manual).
    apiKeyEnvName: z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'must be an ENV VAR NAME (e.g. SOCIAL_TELEGRAM_READ_TOKEN)').optional(),
    rateLimitPerMinute: z.number().int().positive().max(6000).default(30),
    chainSupport: z.array(z.enum(['SOLANA', 'BSC'])).default(['SOLANA']),
    enabled: z.boolean().default(true)
  });

  const PatchSchema = z
    .object({
      sourceId: z.string().min(1).optional(),
      name: z.string().min(1).optional(),
      // Every editable field optional — this is a partial update / toggle.
      enabled: z.boolean().optional(),
      trustTier: z.enum(TRUST_TIERS).optional(),
      externalId: z.string().max(200).nullable().optional(),
      inviteLink: z.string().max(500).nullable().optional(),
      notes: z.string().max(1000).nullable().optional(),
      apiKeyEnvName: z.string().regex(/^[A-Z][A-Z0-9_]*$/).nullable().optional(),
      rateLimitPerMinute: z.number().int().positive().max(6000).optional()
    })
    .refine((b) => Boolean(b.sourceId) !== Boolean(b.name), {
      message: 'exactly one of sourceId or name must be provided'
    });

  const DeleteSchema = z
    .object({
      sourceId: z.string().min(1).optional(),
      name: z.string().min(1).optional()
    })
    .refine((b) => Boolean(b.sourceId) !== Boolean(b.name), {
      message: 'exactly one of sourceId or name must be provided'
    });

  async function readBody(request: Request): Promise<unknown | null> {
    try {
      return await request.json();
    } catch {
      return null;
    }
  }

  function zodError(err: ZodError): NextResponse {
    return NextResponse.json(
      {
        error: 'invalid request body',
        issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))
      },
      { status: 400 }
    );
  }

  export async function POST(request: Request): Promise<NextResponse> {
    const body = await readBody(request);
    if (body === null) return NextResponse.json({ error: 'request body is not valid JSON' }, { status: 400 });

    let parsed;
    try {
      parsed = CreateSchema.parse(body);
    } catch (err) {
      if (err instanceof ZodError) return zodError(err);
      throw err;
    }

    const existing = await prisma.socialSource.findUnique({ where: { name: parsed.name } });
    if (existing) return NextResponse.json({ error: 'a source with that name already exists' }, { status: 409 });

    const created = await prisma.socialSource.create({
      data: {
        name: parsed.name,
        platform: parsed.platform,
        trustTier: parsed.trustTier,
        externalId: parsed.externalId ?? null,
        inviteLink: parsed.inviteLink ?? null,
        notes: parsed.notes ?? null,
        apiKeyEnvName: parsed.apiKeyEnvName ?? null,
        rateLimitPerMinute: parsed.rateLimitPerMinute,
        chainSupport: parsed.chainSupport,
        enabled: parsed.enabled
      }
    });
    return NextResponse.json({ source: created }, { status: 201 });
  }

  export async function PATCH(request: Request): Promise<NextResponse> {
    const body = await readBody(request);
    if (body === null) return NextResponse.json({ error: 'request body is not valid JSON' }, { status: 400 });

    let parsed;
    try {
      parsed = PatchSchema.parse(body);
    } catch (err) {
      if (err instanceof ZodError) return zodError(err);
      throw err;
    }

    const where = parsed.sourceId ? { id: parsed.sourceId } : { name: parsed.name! };
    const existing = await prisma.socialSource.findUnique({ where });
    if (!existing) return NextResponse.json({ error: 'source not found' }, { status: 404 });

    // Build the update patch from only the fields that were provided.
    const data: Record<string, unknown> = {};
    if (parsed.enabled !== undefined) data.enabled = parsed.enabled;
    if (parsed.trustTier !== undefined) data.trustTier = parsed.trustTier;
    if (parsed.externalId !== undefined) data.externalId = parsed.externalId;
    if (parsed.inviteLink !== undefined) data.inviteLink = parsed.inviteLink;
    if (parsed.notes !== undefined) data.notes = parsed.notes;
    if (parsed.apiKeyEnvName !== undefined) data.apiKeyEnvName = parsed.apiKeyEnvName;
    if (parsed.rateLimitPerMinute !== undefined) data.rateLimitPerMinute = parsed.rateLimitPerMinute;

    const updated = await prisma.socialSource.update({ where: { id: existing.id }, data });
    return NextResponse.json({ source: updated });
  }

  export async function DELETE(request: Request): Promise<NextResponse> {
    const body = await readBody(request);
    if (body === null) return NextResponse.json({ error: 'request body is not valid JSON' }, { status: 400 });

    let parsed;
    try {
      parsed = DeleteSchema.parse(body);
    } catch (err) {
      if (err instanceof ZodError) return zodError(err);
      throw err;
    }

    const where = parsed.sourceId ? { id: parsed.sourceId } : { name: parsed.name! };
    const existing = await prisma.socialSource.findUnique({ where });
    if (!existing) return NextResponse.json({ error: 'source not found' }, { status: 404 });

    // Cascade deletes this source's SocialMention rows (schema onDelete: Cascade).
    await prisma.socialSource.delete({ where: { id: existing.id } });
    return NextResponse.json({ ok: true, deletedId: existing.id });
  }
  ```

- [ ] **Step 10: Run the route source test — expect PASS.**
  Command: `npx vitest run apps/web/test/socialPage.test.ts`
  Expected: PASS for the route `describe` block. (The page/sidebar assertions added later are not present yet — either add them in Step 13 before running the full file, or run only this describe with `-t "/api/social/sources"`.)

- [ ] **Step 11: Commit the API route.**
  ```
  git add apps/web/app/api/social/sources/route.ts apps/web/test/socialPage.test.ts
  git commit -m "Task E: /api/social/sources CRUD route (Zod, env-name-only, shadow-only)"
  ```

- [ ] **Step 12: Failing test — `/social` page: empty state, spam-collapse threshold, force-dynamic; SourceManager present; sidebar wired.**
  Append to `apps/web/test/socialPage.test.ts`:
  ```typescript
  describe('/social page (Task E — empty state, spam collapse, force-dynamic, wiring)', () => {
    const page = read('app', 'social', 'page.tsx');
    const manager = read('app', 'social', 'SourceManager.tsx');
    const nav = read('components', 'layout', 'sidebar-nav.tsx');

    it('page is force-dynamic (DB-backed, per-request)', () => {
      expect(page).toMatch(/export const dynamic = 'force-dynamic';/);
    });

    it('renders an honest empty state when there are no sources or no mentions', () => {
      // Both the zero-sources and zero-mentions branches must exist.
      expect(page).toMatch(/sources\.length === 0/);
      expect(page).toMatch(/mentions\.length === 0/);
      // A visible "add a source" affordance in the empty state.
      expect(page).toMatch(/Add (a |your first )?source/i);
    });

    it('collapses/greys high-spam mentions at or above the settings uiHideThreshold (spec §4/§8)', () => {
      // The threshold must come from settings, not a magic literal.
      expect(page).toMatch(/uiHideThreshold/);
      // A comparison of a mention spamScore against that threshold.
      expect(page).toMatch(/spamScore\s*>=\s*uiHideThreshold/);
    });

    it('renders the four required panels: mentions feed, velocity, wallet-signal overlap, manage-sources', () => {
      expect(page).toMatch(/Recent mentions/i);
      expect(page).toMatch(/velocity/i);
      // wallet-signal overlap uses the getSocialSignalOverlap helper.
      expect(page).toMatch(/getSocialSignalOverlap/);
      expect(page).toMatch(/<SourceManager/);
      // source health surfaced via getSocialSourceHealth + status mode.
      expect(page).toMatch(/getSocialSourceHealth/);
      expect(page).toMatch(/getSocialSourceStatuses/);
    });

    it('page reads mentions/velocity/overlap via the Task E DB helpers and velocity via core', () => {
      expect(page).toMatch(/getRecentMentions/);
      expect(page).toMatch(/computeMentionVelocity/);
    });

    it('SourceManager is a client component that POST/PATCH/DELETEs /api/social/sources and refreshes', () => {
      expect(manager).toMatch(/^'use client';/m);
      expect(manager).toMatch(/\/api\/social\/sources/);
      expect(manager).toMatch(/method:\s*'POST'/);
      expect(manager).toMatch(/method:\s*'PATCH'/);
      expect(manager).toMatch(/method:\s*'DELETE'/);
      expect(manager).toMatch(/router\.refresh\(\)/);
    });

    it('sidebar nav includes a Social link to /social', () => {
      expect(nav).toMatch(/\{ label: 'Social', href: '\/social' \}/);
    });
  });
  ```

- [ ] **Step 13: Run — expect FAIL (page/manager files missing, sidebar not yet edited).**
  Command: `npx vitest run apps/web/test/socialPage.test.ts`
  Expected: FAIL — `readFileSync(app/social/page.tsx)` and `SourceManager.tsx` throw ENOENT; the sidebar regex also fails until Step 15.

- [ ] **Step 14: Implement `apps/web/app/social/SourceManager.tsx` (client, ImportForm pattern).**
  ```typescript
  'use client';

  // FlowRadar — Social source manager (Task E, spec §8). Client component:
  // add / edit / enable-toggle / delete SocialSource rows via
  // /api/social/sources, then router.refresh() so the server-rendered /social
  // page re-fetches (same pattern as ImportForm + SourceHealthTable).
  //
  // apiKeyEnvName is entered/edited as an env-var NAME ONLY (never a secret
  // value) — the field label says so and the route re-validates it.

  import { useState } from 'react';
  import { useRouter } from 'next/navigation';
  import { Button } from '@/components/ui/button';
  import { Input } from '@/components/ui/input';
  import { Switch } from '@/components/ui/switch';

  export interface ManagedSource {
    id: string;
    name: string;
    platform: string;
    trustTier: string;
    enabled: boolean;
    apiKeyEnvName: string | null;
    rateLimitPerMinute: number;
    notes: string | null;
  }

  interface SourceManagerProps {
    sources: ManagedSource[];
  }

  const PLATFORMS = ['telegram', 'discord', 'manual'] as const;
  const TRUST_TIERS = ['high', 'medium', 'low'] as const;

  type OpState = { status: 'idle' } | { status: 'busy' } | { status: 'error'; message: string };

  export function SourceManager({ sources }: SourceManagerProps) {
    const router = useRouter();
    const [name, setName] = useState('');
    const [platform, setPlatform] = useState<(typeof PLATFORMS)[number]>('telegram');
    const [trustTier, setTrustTier] = useState<(typeof TRUST_TIERS)[number]>('medium');
    const [apiKeyEnvName, setApiKeyEnvName] = useState('');
    const [addState, setAddState] = useState<OpState>({ status: 'idle' });

    async function send(method: 'POST' | 'PATCH' | 'DELETE', body: unknown): Promise<boolean> {
      const response = await fetch('/api/social/sources', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error ?? `request failed (HTTP ${response.status})`);
      }
      return true;
    }

    async function handleAdd(): Promise<void> {
      if (!name.trim()) return;
      setAddState({ status: 'busy' });
      try {
        await send('POST', {
          name: name.trim(),
          platform,
          trustTier,
          apiKeyEnvName: apiKeyEnvName.trim() ? apiKeyEnvName.trim() : undefined
        });
        setName('');
        setApiKeyEnvName('');
        setAddState({ status: 'idle' });
        router.refresh();
      } catch (err) {
        setAddState({ status: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    }

    return (
      <div className="flex flex-col gap-4">
        {/* Add form */}
        <div className="rounded-lg border border-border p-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Name</label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="alpha-callers-tg" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Platform</label>
              <select
                className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
                value={platform}
                onChange={(e) => setPlatform(e.target.value as (typeof PLATFORMS)[number])}
              >
                {PLATFORMS.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Trust tier</label>
              <select
                className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
                value={trustTier}
                onChange={(e) => setTrustTier(e.target.value as (typeof TRUST_TIERS)[number])}
              >
                {TRUST_TIERS.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">API key env NAME (not a value)</label>
              <Input
                value={apiKeyEnvName}
                onChange={(e) => setApiKeyEnvName(e.target.value)}
                placeholder="SOCIAL_TELEGRAM_READ_TOKEN"
              />
            </div>
          </div>
          <div className="mt-3 flex items-center gap-3">
            <Button type="button" disabled={!name.trim() || addState.status === 'busy'} onClick={() => void handleAdd()}>
              {addState.status === 'busy' ? 'Adding…' : 'Add source'}
            </Button>
            {addState.status === 'error' && <span className="text-sm text-red-400">{addState.message}</span>}
          </div>
        </div>

        {/* Existing sources — enable toggle + delete */}
        {sources.length > 0 && (
          <ul className="flex flex-col gap-2">
            {sources.map((s) => (
              <SourceRow key={s.id} source={s} />
            ))}
          </ul>
        )}
      </div>
    );
  }

  function SourceRow({ source }: { source: ManagedSource }) {
    const router = useRouter();
    const [enabled, setEnabled] = useState(source.enabled);
    const [state, setState] = useState<OpState>({ status: 'idle' });

    async function call(method: 'PATCH' | 'DELETE', body: unknown): Promise<void> {
      const response = await fetch('/api/social/sources', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error ?? `request failed (HTTP ${response.status})`);
      }
    }

    async function handleToggle(next: boolean): Promise<void> {
      const prev = enabled;
      setEnabled(next);
      setState({ status: 'busy' });
      try {
        await call('PATCH', { sourceId: source.id, enabled: next });
        setState({ status: 'idle' });
        router.refresh();
      } catch (err) {
        setEnabled(prev);
        setState({ status: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    }

    async function handleDelete(): Promise<void> {
      setState({ status: 'busy' });
      try {
        await call('DELETE', { sourceId: source.id });
        router.refresh();
      } catch (err) {
        setState({ status: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    }

    return (
      <li className="flex flex-wrap items-center gap-3 rounded-md border border-border px-3 py-2 text-sm">
        <span className="font-medium">{source.name}</span>
        <span className="text-xs text-muted-foreground">{source.platform}</span>
        <span className="text-xs text-muted-foreground">trust: {source.trustTier}</span>
        {source.apiKeyEnvName && <code className="text-xs text-muted-foreground">{source.apiKeyEnvName}</code>}
        <label className="ml-auto flex items-center gap-2">
          <Switch checked={enabled} disabled={state.status === 'busy'} onCheckedChange={handleToggle} aria-label={`Toggle ${source.name}`} />
          <span className="text-xs text-muted-foreground">{enabled ? 'enabled' : 'disabled'}</span>
        </label>
        <Button type="button" variant="outline" disabled={state.status === 'busy'} onClick={() => void handleDelete()}>
          Delete
        </Button>
        {state.status === 'error' && <span className="w-full text-xs text-red-400">{state.message}</span>}
      </li>
    );
  }
  ```
  If `variant="outline"` is not a valid `Button` variant in `components/ui/button.tsx`, drop the prop (read the file's `buttonVariants` to confirm — `SettingsForm.tsx` uses `variant="outline"`, so it is valid).

- [ ] **Step 15: Implement `apps/web/app/social/page.tsx` + sidebar nav edit.**
  Add the nav item to `apps/web/components/layout/sidebar-nav.tsx` `NAV_ITEMS` (place it after `{ label: 'Sources', href: '/sources' }` — Social is a sibling ops view; keep it before Alerts):
  ```typescript
    { label: 'Sources', href: '/sources' },
    { label: 'Social', href: '/social' },
    { label: 'Alerts', href: '/alerts' },
  ```
  Create `apps/web/app/social/page.tsx`:
  ```typescript
  import Link from 'next/link';
  import { prisma } from '@/lib/db';
  import {
    getRecentMentions,
    getSocialSourceHealth,
    getSocialSignalOverlap
  } from '@flowradar/db';
  import { getSocialSourceStatuses } from '@flowradar/providers';
  import { computeMentionVelocity, parseSettings } from '@flowradar/core';
  import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
  import { Badge } from '@/components/ui/badge';
  import { fmtAge } from '@/lib/format';
  import { SourceManager } from './SourceManager';
  import type { ManagedSource } from './SourceManager';

  // DB-backed dashboard — per-request, never frozen at build time (same
  // invariant every DB page follows).
  export const dynamic = 'force-dynamic';

  /**
   * /social (Task E, spec §8). SHADOW-ONLY social-intelligence dashboard:
   * recent mentions feed (high-spam collapsed), mention velocity, wallet-signal
   * overlap (confluence, read-only), and a Manage-sources section with per-
   * source health. No writes here; no alerts; no FlowScore/CandidateWallet.
   */

  const MODE_BADGE_CLASS: Record<'live' | 'mock' | 'missing_key' | 'stub', string> = {
    mock: 'border-transparent bg-violet-500/15 text-violet-300',
    live: 'border-transparent bg-emerald-500/15 text-emerald-300',
    missing_key: 'border-transparent bg-amber-500/15 text-amber-300',
    stub: 'border-transparent bg-zinc-500/15 text-zinc-300'
  };

  export default async function SocialPage() {
    const settingsRow = await prisma.settings.findFirst();
    const settings = parseSettings(settingsRow?.values ?? {});
    const social = settings.connectors.social;
    const uiHideThreshold = social.spam.uiHideThreshold;
    const velocityWindowsMin = social.velocityWindowsMin;

    const [sources, mentions, health, statuses, overlap] = await Promise.all([
      prisma.socialSource.findMany({ orderBy: { name: 'asc' } }),
      getRecentMentions(prisma, { limit: 100 }),
      getSocialSourceHealth(prisma),
      getSocialSourceStatuses(prisma),
      getSocialSignalOverlap(prisma, { windowMinutes: 1440, limit: 25 })
    ]);

    // Mention velocity (pure, computed on read). Feed it the linked/unlinked
    // mentions with the fields computeMentionVelocity needs, non-spam only via
    // its own cfg.spamMaxScore.
    const velocityInput = mentions.map((m) => ({
      tokenId: m.tokenId,
      tokenAddress: m.tokenAddress,
      authorHash: m.authorHash,
      postedAt: m.postedAt,
      spamScore: m.spamScore
    }));
    const velocity = computeMentionVelocity(velocityInput, new Date(), {
      windowsMin: velocityWindowsMin,
      spamMaxScore: uiHideThreshold - 1
    });
    // Attach a display symbol per velocity row. The velocity row itself carries
    // NO symbol (MentionVelocityRow has none), so look the symbol up from the
    // mentions list keyed by tokenId (linked) or tokenAddress (unlinked).
    const symbolByTokenId = new Map(mentions.filter((m) => m.tokenId).map((m) => [m.tokenId!, m.tokenSymbol]));
    const symbolByTokenAddress = new Map(mentions.filter((m) => m.tokenAddress).map((m) => [m.tokenAddress!, m.tokenSymbol]));
    const shortWindow = velocityWindowsMin[0];
    const midWindow = velocityWindowsMin[1] ?? velocityWindowsMin[0];
    const longWindow = velocityWindowsMin[velocityWindowsMin.length - 1];

    const statusBySource = new Map(statuses.map((s) => [s.sourceName, s]));

    // Empty state: no sources OR no mentions => honest message + add affordance.
    if (sources.length === 0 || mentions.length === 0) {
      return (
        <div className="flex flex-col gap-6">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Social intelligence</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Shadow-only confluence evidence from configured Telegram/Discord channels. Never a primary signal;
              never fires an alert.
            </p>
          </div>
          <Card>
            <CardHeader>
              <CardTitle>{sources.length === 0 ? 'No sources yet' : 'No mentions yet'}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 text-sm text-muted-foreground">
              <p>
                {sources.length === 0
                  ? 'Add a source below to start ingesting mentions. In MOCK_MODE the mock reader will populate the feed on the next worker pass.'
                  : 'Sources are configured but no mentions have been ingested yet — run the socialIngest worker pass (or wait for its interval).'}
              </p>
            </CardContent>
          </Card>
          <div>
            <h2 className="mb-3 text-lg font-medium tracking-tight">Add a source</h2>
            <SourceManager sources={sources as unknown as ManagedSource[]} />
          </div>
        </div>
      );
    }

    // Split mentions into visible vs collapsed by the settings threshold.
    const visibleMentions = mentions.filter((m) => m.spamScore < uiHideThreshold);
    const collapsedMentions = mentions.filter((m) => m.spamScore >= uiHideThreshold);

    return (
      <div className="flex flex-col gap-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Social intelligence</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Shadow-only confluence evidence from configured Telegram/Discord channels. Never a primary signal;
            never fires an alert.
          </p>
        </div>

        {/* Wallet + smart-money confluence */}
        <Card>
          <CardHeader>
            <CardTitle>Social + smart-money confluence</CardTitle>
          </CardHeader>
          <CardContent>
            {overlap.length === 0 ? (
              <p className="text-sm text-muted-foreground">No tokens currently have both social mentions and wallet-driven evidence in the last 24h.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs text-muted-foreground">
                      <th className="px-3 py-2 font-medium">Token</th>
                      <th className="px-3 py-2 text-right font-medium">Mentions</th>
                      <th className="px-3 py-2 text-right font-medium">Distinct authors</th>
                      <th className="px-3 py-2 text-right font-medium">Flow score</th>
                      <th className="px-3 py-2 font-medium">Signals</th>
                    </tr>
                  </thead>
                  <tbody>
                    {overlap.map((row) => (
                      <tr key={row.tokenId} className="border-b border-border/50 last:border-0">
                        <td className="px-3 py-2">
                          <Link href={`/tokens/${row.tokenId}`} className="font-medium hover:underline">
                            {row.tokenSymbol}
                          </Link>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{row.socialMentionCount}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{row.distinctAuthors}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{row.latestFlowScore ?? '—'}</td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">
                          {row.firedSignals.length === 0 ? '—' : row.firedSignals.map((s) => `${s.rule}/${s.severity}`).join(', ')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Mention velocity */}
        <Card>
          <CardHeader>
            <CardTitle>Mention velocity</CardTitle>
          </CardHeader>
          <CardContent>
            {velocity.length === 0 ? (
              <p className="text-sm text-muted-foreground">No non-spam token mentions in the velocity windows yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs text-muted-foreground">
                      <th className="px-3 py-2 font-medium">Token</th>
                      <th className="px-3 py-2 text-right font-medium">{shortWindow}m</th>
                      <th className="px-3 py-2 text-right font-medium">{midWindow}m</th>
                      <th className="px-3 py-2 text-right font-medium">{longWindow}m</th>
                      <th className="px-3 py-2 text-right font-medium">Authors ({shortWindow}m)</th>
                      <th className="px-3 py-2 text-right font-medium">Accel</th>
                    </tr>
                  </thead>
                  <tbody>
                    {velocity.map((v, i) => {
                      // Symbol comes from the mentions list (keyed by tokenId or
                      // tokenAddress), NOT from the velocity row — MentionVelocityRow
                      // has no symbol field.
                      const label = v.tokenId
                        ? symbolByTokenId.get(v.tokenId) ?? v.tokenAddress
                        : (v.tokenAddress ? symbolByTokenAddress.get(v.tokenAddress) : null) ?? v.tokenAddress;
                      const winCount = (w: number) => v.windows.find((x) => x.windowMin === w)?.count ?? 0;
                      const winAuthors = (w: number) => v.windows.find((x) => x.windowMin === w)?.distinctAuthors ?? 0;
                      return (
                        <tr key={v.tokenId ?? v.tokenAddress ?? `v${i}`} className="border-b border-border/50 last:border-0">
                          <td className="px-3 py-2">
                            {v.tokenId ? (
                              <Link href={`/tokens/${v.tokenId}`} className="font-medium hover:underline">{label ?? '—'}</Link>
                            ) : (
                              <span className="text-muted-foreground">unlinked · {label ?? '—'}</span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">{winCount(shortWindow)}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{winCount(midWindow)}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{winCount(longWindow)}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{winAuthors(shortWindow)}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{v.accel.toFixed(2)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Recent mentions feed */}
        <Card>
          <CardHeader>
            <CardTitle>Recent mentions</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {visibleMentions.map((m) => (
              <div key={m.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/40 pb-2 text-sm last:border-0">
                {m.tokenId ? (
                  <Link href={`/tokens/${m.tokenId}`} className="font-medium hover:underline">{m.tokenSymbol ?? '—'}</Link>
                ) : (
                  <span className="text-muted-foreground">unlinked · {m.tokenSymbol ?? m.tokenAddress ?? '—'}</span>
                )}
                <span className="text-xs text-muted-foreground">{m.sourceName}</span>
                <span className="text-xs text-muted-foreground">{m.platform}</span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">{m.contentSnippet}</span>
                <span className="text-xs text-muted-foreground">{fmtAge(m.postedAt)} ago</span>
                {m.spamScore > 0 && (
                  <Badge className="border-transparent bg-amber-500/15 text-amber-300">
                    spam {m.spamScore}{m.spamReason ? ` · ${m.spamReason}` : ''}
                  </Badge>
                )}
              </div>
            ))}
            {collapsedMentions.length > 0 && (
              <details className="mt-2">
                <summary className="cursor-pointer text-xs text-muted-foreground">
                  {collapsedMentions.length} high-spam mention{collapsedMentions.length === 1 ? '' : 's'} hidden (score ≥ {uiHideThreshold})
                </summary>
                <div className="mt-2 flex flex-col gap-2 opacity-60">
                  {collapsedMentions.map((m) => (
                    <div key={m.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/40 pb-2 text-sm last:border-0">
                      <span className="text-muted-foreground">{m.tokenSymbol ?? m.tokenAddress ?? '—'}</span>
                      <span className="text-xs text-muted-foreground">{m.sourceName}</span>
                      <span className="min-w-0 flex-1 truncate text-muted-foreground">{m.contentSnippet}</span>
                      <Badge className="border-transparent bg-red-500/15 text-red-400">
                        spam {m.spamScore}{m.spamReason ? ` · ${m.spamReason}` : ''}
                      </Badge>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </CardContent>
        </Card>

        {/* Manage sources + health */}
        <div>
          <h2 className="mb-3 text-lg font-medium tracking-tight">Manage sources</h2>
          <SourceManager sources={sources as unknown as ManagedSource[]} />

          <div className="mt-4 overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="px-3 py-2 font-medium">Source</th>
                  <th className="px-3 py-2 font-medium">Platform</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">API key</th>
                  <th className="px-3 py-2 font-medium">Last sync</th>
                  <th className="px-3 py-2 text-right font-medium">Mentions</th>
                  <th className="px-3 py-2 text-right font-medium">Scanned</th>
                  <th className="px-3 py-2 font-medium">Last error</th>
                </tr>
              </thead>
              <tbody>
                {health.map((h) => {
                  const st = statusBySource.get(h.name);
                  const mode = (st?.mode ?? 'stub') as 'live' | 'mock' | 'missing_key' | 'stub';
                  return (
                    <tr key={h.id} className="border-b border-border/50 last:border-0">
                      <td className="px-3 py-2 font-medium">{h.name}</td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">{h.platform}</td>
                      <td className="px-3 py-2">
                        <Badge className={MODE_BADGE_CLASS[mode]} title={st?.note}>{mode}</Badge>
                      </td>
                      <td className="px-3 py-2 text-xs">
                        <code className="text-muted-foreground">{h.apiKeyEnvName ?? '—'}</code>
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">{h.lastSyncAt ? `${fmtAge(h.lastSyncAt)} ago` : 'never'}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{h.mentionCount}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{h.postsScanned}</td>
                      <td className="max-w-[240px] truncate px-3 py-2 text-xs text-red-400" title={h.lastError ?? undefined}>
                        {h.lastError ?? '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    );
  }
  ```
  NOTES for the implementer (these shapes are canonical — code against them exactly):
  - Settings are read via `const settingsRow = await prisma.settings.findFirst(); const settings = parseSettings(settingsRow?.values ?? {});` (import `parseSettings` from `@flowradar/core`). There is no `getSettings(prisma)` helper. The leaf path is `settings.connectors.social.spam.uiHideThreshold` / `settings.connectors.social.velocityWindowsMin` (spec §7).
  - `MentionVelocityRow` (Task B, canonical) = `{ tokenId: string | null; tokenAddress: string | null; windows: { windowMin: number; count: number; distinctAuthors: number }[]; accel: number }`. There is NO `counts`/`distinctAuthors` Record and NO `tokenSymbol` on a velocity row — read a window via `v.windows.find((w) => w.windowMin === W)?.count ?? 0` / `...?.distinctAuthors ?? 0`, and look the display symbol up from the mentions list (keyed by tokenId/tokenAddress). `computeMentionVelocity` is SYNC — no `await`.
  - `getSocialSourceStatuses(prisma)` is ASYNC (spec §2) — `await` it (it is one leg of the `Promise.all`).

- [ ] **Step 16: Run the web source test — expect PASS.**
  Command: `npx vitest run apps/web/test/socialPage.test.ts`
  Expected: PASS (route + page + wiring describes all green).

- [ ] **Step 17: (token-detail SocialSection — built in Task F).**

  The token-detail `SocialSection` component (`apps/web/components/tokens/SocialSection.tsx`), its `getTokenSocialMentions` query, and the `apps/web/app/tokens/[id]/page.tsx` wiring are built in Task F, not here. Task E does NOT create a competing component, does NOT define `SocialSectionMention`/`SocialSectionVelocity` types, and does NOT touch the token-detail page. The `/social` page (Step 15 above) uses its own feed/velocity markup and does not import `SocialSection`. Skip straight to Step 18.

- [ ] **Step 18: Full-file web test run + typecheck slice — expect PASS.**
  Commands:
  - `npx vitest run apps/web/test/socialPage.test.ts` → PASS.
  - `npx vitest run packages/db/test/socialQueries.test.ts` → PASS (LITE Postgres up).
  Then a scoped build/typecheck to catch shape drift in the `/social` page (use the repo's existing web typecheck script; if the project uses `npm run -w apps/web build` / `tsc --noEmit`, run that). Expected: no type errors referencing `computeMentionVelocity`, `MentionVelocityRow`, `parseSettings`, or the `/social` page's own reads.

- [ ] **Step 19: Commit /social UI + sidebar.**
  ```
  git add apps/web/app/social/page.tsx apps/web/app/social/SourceManager.tsx apps/web/components/layout/sidebar-nav.tsx apps/web/test/socialPage.test.ts
  git commit -m "Task E: /social page, source manager UI, sidebar nav"
  ```

- [ ] **Step 20: Full gate.**
  Command: `npm run verify`
  Expected: PASS (lint + typecheck + all package/web test suites green on a clean/rebuilt DB). If verify seeds/reseeds, confirm the seeded example SocialSource rows (Task DB-seed) render the populated `/social` path rather than the empty state.

**Done Bar:**
- `getRecentMentions`, `getSocialSourceHealth`, `getSocialSignalOverlap` exported from `@flowradar/db`, each a pure read (no writes), returning the exact `RecentMentionRow` / `SocialSourceHealthRow` / `SocialSignalOverlapRow` shapes above. (`getTokenSocialMentions` is Task F's, not this task's.)
- `packages/db/test/socialQueries.test.ts` passes with LITE Postgres on 5439: newest-first ordering, linked-vs-unlinked shaping, spam rows never dropped by default, per-source `mentionCount` + `postsScanned`, and the overlap join (token with wallet evidence included; social-only token excluded).
- `/api/social/sources` exposes `POST` (create, 409 on dup name, 201 on success), `PATCH` (partial edit / enable-toggle, 404 on miss), `DELETE` (404 on miss, cascade). All Zod-validated; `apiKeyEnvName` accepted as a NAME only and never resolved to a value.
- `/social` page is `force-dynamic`, renders the empty state when 0 sources OR 0 mentions (with an "Add a source" affordance), and when populated renders: recent-mentions feed with high-spam collapsed behind a `<details>` at `spamScore >= uiHideThreshold`, mention-velocity panel, wallet-signal overlap panel, and a Manage-sources section with per-source health (mode badge, `apiKeyEnvName`, last-sync age, mention/scanned counts, last error).
- `SourceManager.tsx` is a `'use client'` component that POST/PATCH/DELETEs `/api/social/sources` and calls `router.refresh()`.
- Sidebar shows a **Social** link to `/social`. (The token-detail `<SocialSection />` is delivered by Task F, not this task.)
- `apps/web/test/socialPage.test.ts` passes; `npm run verify` is green.

**Reviewer Focus:**
- **Shadow-only / no-alerts (constraints 3, 4):** confirm nothing in `queries.ts`, `overlap.ts`, `route.ts`, or the two pages writes an `Alert`, mutates a `Signal`/`TokenFlowSnapshot`/`Token`, or feeds social data into FlowScore. `overlap.ts` must be pure reads (only `findMany`/`groupBy`) — no `create`/`update`. The route writes ONLY `SocialSource` rows (plus cascade of its own `SocialMention` on delete).
- **Secret safety (constraint 10):** the route (and `SourceManager`) treat `apiKeyEnvName` as a NAME string only — verify the route never does `process.env[submittedName]` and never persists a resolved value; the source-text test guards this but read the code to be sure. Health/status UI shows the env NAME + mode, never a value.
- **Graceful skips / honest empty state (constraint 11):** `/social` must render cleanly with 0 sources and with sources-but-0-mentions; `getSocialSignalOverlap` must return `[]` (not throw) when no linked mentions or no wallet evidence exist; unlinked mentions (`tokenId=null`) must display as "unlinked · <sym/addr>" and be excluded from the overlap join — never crash a page.
- **Spam is collapsed, not dropped (constraints 4, 11):** `getRecentMentions` returns high-spam rows too; only the UI hides them (behind `<details>` at `>= uiHideThreshold`). Confirm the threshold comes from `settings.connectors.social.spam.uiHideThreshold`, not a hardcoded literal, on BOTH `/social` and the token section.
- **Interface fidelity to earlier tasks:** verify the consumed `computeMentionVelocity` input/`MentionVelocityRow` output field names, `getSocialSourceStatuses` sync-vs-async and row shape, and `getSettings`/`settings.connectors.social.*` nesting match the actually-shipped core/providers code — this task's page code is written against the spec's shapes and must be reconciled if an earlier task diverged (adapt the reads; don't stub).
- **Prisma/DB conventions:** `overlap.ts` uses `groupBy(['tokenId'])` with a `not: null` filter correctly (Prisma nullable-groupBy) and a single windowed pass; the DB test uses the repo's `probePort(5439)` skipIf + prefix cleanup and matches the real `Signal`/`TokenFlowSnapshot` required columns + enum literals (`SignalRule`/`SignalSeverity`/`FlowSignalStatus`).
- **No BSC / Solana-only (constraint 8):** the create schema allows `chainSupport` but the page/velocity path is Solana-first; confirm no BSC-specific logic leaks in and the overlap/velocity work with `chain='SOLANA'` rows.

### Task F: Token detail social section

**Files:**
- **Modify** `packages/db/src/social/queries.ts` — add `getTokenSocialMentions(prisma, tokenId)` (file created in Task E; this task appends one exported function + re-exports it through the existing `packages/db/src/social/index.ts` barrel wired in Task E).
- **Create** `apps/web/components/tokens/SocialSection.tsx` — server component that renders the shadow-only "Social mentions" section (spam-filtered recent mentions + this token's mention velocity).
- **Modify** `apps/web/app/tokens/[id]/page.tsx` — fetch this token's mentions via `getTokenSocialMentions`, compute velocity via `computeMentionVelocity`, and render `<SocialSection … />` after the existing "Risk & context" block. No change to existing token scoring/flow display.
- **Create** `apps/web/test/tokenSocialSection.test.ts` — plain Node source-text checks (this app ships no JSX/render harness — see `apps/web/test/framingBanner.test.ts` header): (1) the section render wiring + spam filter + unlinked-safe render, (2) the no-mentions empty case.

> **Ownership note:** Task E may also list `getTokenSocialMentions` and a token-detail `SocialSection` in its Files. Task F is the CANONICAL owner of both the `getTokenSocialMentions` implementation shape below and the `apps/web/components/tokens/SocialSection.tsx` component + token-page wiring. If Task E already created a stub of either, reconcile to THIS task's version (do not create a second component).

**Interfaces:**

*Consumes (exact signatures from earlier tasks — do NOT re-implement):*
- Task E — `packages/db/src/social/queries.ts` already exports `getRecentMentions(prisma, opts)` and `getSocialSourceHealth(prisma)`; this task adds a sibling in the same file. Prisma model `SocialMention` (spec §1) with scalar fields `id, sourceId, platform, externalPostId, authorHash, postedAt, chain, contentSnippet, normalizedSnippet, contentHash, mentionType, tokenAddress, tokenSymbol, tokenUrl, tokenId, confidence, spamScore, spamReason, dedupeKey` and relation `source: SocialSource`.
- Task B — `packages/core/src/social/mentionVelocity.ts`, re-exported from `@flowradar/core`:
  ```typescript
  computeMentionVelocity(
    mentions: { tokenId: string | null; tokenAddress: string | null; authorHash: string | null; postedAt: Date; spamScore: number }[],
    now: Date,
    cfg: { windowsMin: number[]; spamMaxScore: number }
  ): MentionVelocityRow[]
  ```
  where `MentionVelocityRow = { tokenId: string | null; tokenAddress: string | null; windows: { windowMin: number; count: number; distinctAuthors: number }[]; accel: number }` (one row per token key; Task B is the canonical owner). Per-window `count`/`distinctAuthors` live in the `windows[]` array — read a window with `vel.windows.find((w) => w.windowMin === W)?.count ?? 0` / `...?.distinctAuthors ?? 0`. There is NO `counts`/`distinctAuthors` Record and NO `tokenSymbol` on a velocity row.
- Task 3 settings — `@flowradar/core` `DEFAULT_SETTINGS.connectors.social` supplies `velocityWindowsMin` (`[60, 360, 1440]`) and `spam.uiHideThreshold` (`70`). Read them via the already-imported settings on the page (do not hardcode duplicates).
- Existing web deps: `@/components/ui/card` (`Card, CardContent, CardHeader, CardTitle`), `@/components/ui/badge` (`Badge`), `@/lib/format` (`fmtAge`), `next/link` `Link`.

*Produces (later tasks / this task's UI rely on these):*
- `getTokenSocialMentions(prisma: PrismaClient, tokenId: string): Promise<SocialMentionWithSource[]>` where `SocialMentionWithSource = SocialMention & { source: Pick<SocialSource, 'name' | 'platform' | 'trustTier'> }`. Returns this token's mentions ordered `postedAt desc`, capped at 50. Returns `[]` for any tokenId with no mentions (graceful empty — never throws).
- `SocialSection` React server component with props `{ mentions: SocialMentionRowVM[]; velocity: MentionVelocityRow[]; uiHideThreshold: number }` exported from `apps/web/components/tokens/SocialSection.tsx`.

---

- [ ] **Step 1: Write the failing DB-query test for `getTokenSocialMentions` (link + graceful-empty + ordering).**

  Create `packages/db/src/social/getTokenSocialMentions.test.ts` (DB integration test — `probePort(5439)` skipIf + prefix cleanup + serialized, matching the existing Task E db tests in this folder):

  ```typescript
  import { afterAll, beforeAll, describe, expect, it } from 'vitest';
  import net from 'node:net';
  import { getTokenSocialMentions } from './queries';
  import { prisma } from '../client';

  // LITE Postgres on 5439 must be up; skip cleanly otherwise (repo DB-test
  // convention). Standardized probePort signature, shared across every social
  // DB test file.
  function probePort(host: string, port: number, timeoutMs = 1000): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = net.createConnection({ host, port });
      const done = (ok: boolean) => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(ok);
      };
      socket.setTimeout(timeoutMs);
      socket.once('connect', () => done(true));
      socket.once('timeout', () => done(false));
      socket.once('error', () => done(false));
    });
  }

  const PREFIX = 'tsms_test_'; // unique row prefix for isolated cleanup
  let dbReachable = false;

  beforeAll(async () => {
    dbReachable = await probePort('localhost', 5439);
  });

  describe.skipIf(!dbReachable)('getTokenSocialMentions', () => {
    let tokenId = '';
    let sourceId = '';

    beforeAll(async () => {
      const token = await prisma.token.create({
        data: {
          chain: 'SOLANA',
          address: PREFIX + 'addr_nova',
          symbol: PREFIX + 'NOVA',
          name: 'Test Nova',
          decimals: 9,
          firstSeenAt: new Date(),
          riskFlags: [],
        },
      });
      tokenId = token.id;

      const source = await prisma.socialSource.create({
        data: { name: PREFIX + 'tg', platform: 'telegram', trustTier: 'high' },
      });
      sourceId = source.id;

      const base = Date.now();
      // 3 mentions for our token (varying postedAt to assert desc ordering),
      // 1 mention for a DIFFERENT token (must be excluded).
      const otherToken = await prisma.token.create({
        data: {
          chain: 'SOLANA',
          address: PREFIX + 'addr_other',
          symbol: PREFIX + 'OTHER',
          name: 'Other',
          decimals: 9,
          firstSeenAt: new Date(),
          riskFlags: [],
        },
      });
      const rows = [
        { tokenId, postedAt: new Date(base - 3000), post: 'p1' },
        { tokenId, postedAt: new Date(base - 1000), post: 'p2' }, // newest of ours
        { tokenId, postedAt: new Date(base - 2000), post: 'p3' },
        { tokenId: otherToken.id, postedAt: new Date(base), post: 'p4' },
      ];
      for (const r of rows) {
        await prisma.socialMention.create({
          data: {
            sourceId,
            platform: 'telegram',
            externalPostId: PREFIX + r.post,
            postedAt: r.postedAt,
            chain: 'SOLANA',
            contentSnippet: 'gm ' + r.post,
            normalizedSnippet: 'gm ' + r.post,
            contentHash: PREFIX + 'h_' + r.post,
            mentionType: 'address',
            tokenAddress: PREFIX + 'addr_nova',
            tokenId: r.tokenId,
            confidence: 90,
            spamScore: 0,
            dedupeKey: PREFIX + r.post + '::' + PREFIX + 'addr_nova',
          },
        });
      }
    });

    afterAll(async () => {
      await prisma.socialMention.deleteMany({ where: { externalPostId: { startsWith: PREFIX } } });
      await prisma.socialSource.deleteMany({ where: { name: { startsWith: PREFIX } } });
      await prisma.token.deleteMany({ where: { address: { startsWith: PREFIX } } });
      await prisma.$disconnect();
    });

    it('returns only this token\'s mentions, newest first, with source name/platform/trustTier', async () => {
      const rows = await getTokenSocialMentions(prisma, tokenId);
      expect(rows).toHaveLength(3);
      expect(rows.every((r) => r.tokenId === tokenId)).toBe(true);
      // desc by postedAt: p2 (newest) then p3 then p1.
      expect(rows.map((r) => r.externalPostId)).toEqual([
        PREFIX + 'p2', PREFIX + 'p3', PREFIX + 'p1',
      ]);
      expect(rows[0].source).toEqual({ name: PREFIX + 'tg', platform: 'telegram', trustTier: 'high' });
    });

    it('returns [] (never throws) for a token with no mentions — graceful empty', async () => {
      const empty = await getTokenSocialMentions(prisma, 'cixdoesnotexist000000000');
      expect(empty).toEqual([]);
    });
  });
  ```

- [ ] **Step 2: Run the DB test and watch it FAIL.**

  Command (repo root):
  ```
  npx vitest run packages/db/src/social/getTokenSocialMentions.test.ts
  ```
  Expected: FAIL — `getTokenSocialMentions` is not exported from `./queries` (`SyntaxError` / `is not a function`). (If LITE Postgres on 5439 is down, the whole `describe` is `skipIf`-skipped and reports 0 failures — start the LITE db first so the assertions actually run.)

- [ ] **Step 3: Implement `getTokenSocialMentions` in `packages/db/src/social/queries.ts` (minimal, graceful).**

  Append to the existing `packages/db/src/social/queries.ts` (do not touch the Task E functions already in the file). Match the `import type { PrismaClient } from '@prisma/client'` idiom used across `packages/db/src`:

  ```typescript
  // --- Task F: token-detail social section --------------------------------
  // This token's recent SocialMention rows (shadow-only), newest first, with a
  // minimal source projection (name/platform/trustTier) for display. Read-only.
  // Capped at MAX_TOKEN_MENTIONS so a single spammed token can't unbounded the
  // page query. Returns [] for a token with no mentions (graceful empty state).

  const MAX_TOKEN_MENTIONS = 50;

  export type SocialMentionWithSource = Awaited<
    ReturnType<typeof getTokenSocialMentions>
  >[number];

  export async function getTokenSocialMentions(prisma: PrismaClient, tokenId: string) {
    return prisma.socialMention.findMany({
      where: { tokenId },
      orderBy: { postedAt: 'desc' },
      take: MAX_TOKEN_MENTIONS,
      include: {
        source: { select: { name: true, platform: true, trustTier: true } },
      },
    });
  }
  ```

  Confirm the barrel already re-exports this file. Task E created `packages/db/src/social/index.ts` with `export * from './queries';` and wired it into `packages/db/src/index.ts`. If `getTokenSocialMentions` does not appear in the built types, add the missing re-export line to `packages/db/src/social/index.ts`; do not add a second export path.

- [ ] **Step 4: Run the DB test and watch it PASS.**

  Command:
  ```
  npx vitest run packages/db/src/social/getTokenSocialMentions.test.ts
  ```
  Expected: PASS — 2 passing (both `it` cases), 0 failing (with LITE Postgres on 5439 up).

- [ ] **Step 5: Commit the query.**
  ```
  git add packages/db/src/social/queries.ts packages/db/src/social/index.ts packages/db/src/social/getTokenSocialMentions.test.ts
  git commit -m "feat(db): getTokenSocialMentions for token-detail social section"
  ```

- [ ] **Step 6: Write the failing web source-text test for the section (render wiring + spam filter + empty case).**

  Create `apps/web/test/tokenSocialSection.test.ts`. This app has NO JSX/render harness (vitest here has no React transform — see `apps/web/test/framingBanner.test.ts`'s header); the established convention is a plain Node source-text check that the wiring and shadow-only behaviors are present. This test is non-vacuous: it asserts the page fetches via `getTokenSocialMentions`, computes velocity, passes `uiHideThreshold`, renders `<SocialSection`, and that the component implements the spam filter, the unlinked-safe token chip, and the no-mentions empty state.

  ```typescript
  // FlowRadar — token-detail "Social mentions" section wiring test (Task F).
  //
  // apps/web ships no React/JSX render harness (vitest here has no JSX
  // transform — see apps/web/test/framingBanner.test.ts header). Per that
  // established convention this is a Node-only source-text check proving the
  // shadow-only social section is (a) wired into the token page from real data
  // and (b) implements the spam-filter + unlinked-safe + empty-state behaviors
  // required by the spec (§8 token detail social section, §10 graceful skips).
  // Files are read as raw text (importing .tsx would error on JSX under the
  // Node transform), matching framingBanner.test.ts exactly.

  import { describe, expect, it } from 'vitest';
  import { readFileSync } from 'node:fs';
  import { fileURLToPath } from 'node:url';
  import path from 'node:path';

  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const APP_ROOT = path.resolve(HERE, '..');

  const pageSrc = readFileSync(
    path.join(APP_ROOT, 'app', 'tokens', '[id]', 'page.tsx'),
    'utf-8',
  ).replace(/\r\n/g, '\n');
  const compSrc = readFileSync(
    path.join(APP_ROOT, 'components', 'tokens', 'SocialSection.tsx'),
    'utf-8',
  ).replace(/\r\n/g, '\n');

  describe('token-detail Social mentions section (Task F)', () => {
    it('page fetches this token\'s mentions via getTokenSocialMentions', () => {
      expect(pageSrc).toMatch(/getTokenSocialMentions\(\s*prisma\s*,\s*token\.id\s*\)/);
    });

    it('page computes mention velocity via computeMentionVelocity from real settings windows', () => {
      expect(pageSrc).toMatch(/computeMentionVelocity\(/);
      // windows + spam cap come from settings, not hardcoded literals inline.
      expect(pageSrc).toMatch(/velocityWindowsMin/);
    });

    it('page renders <SocialSection /> and passes uiHideThreshold', () => {
      expect(pageSrc).toMatch(/<SocialSection\b/);
      expect(pageSrc).toMatch(/uiHideThreshold=\{/);
    });

    it('page does NOT touch FlowScore / signal / wallet-scoring in this section (shadow-only)', () => {
      // The social block adds no scoring writes — no assignment to flow/signal fields.
      expect(compSrc).not.toMatch(/flowScore|signalStatus\s*=|walletScore\s*=/i);
    });

    it('SocialSection greys/collapses high-spam mentions (>= uiHideThreshold), never drops silently', () => {
      // A comparison against the threshold must exist (spam is filtered for
      // DISPLAY, not deleted — spec §4/§8).
      expect(compSrc).toMatch(/spamScore\s*>=\s*uiHideThreshold/);
    });

    it('SocialSection renders an "unlinked" affordance for mentions with no tokenId (graceful skip)', () => {
      expect(compSrc).toMatch(/unlinked/i);
      expect(compSrc).toMatch(/tokenId/);
    });

    it('SocialSection renders an honest empty state when there are zero mentions', () => {
      expect(compSrc).toMatch(/mentions\.length === 0/);
      expect(compSrc).toMatch(/No social mentions/i);
    });

    it('SocialSection has no client directive — it is a server component (read-only display)', () => {
      expect(compSrc).not.toMatch(/^['"]use client['"]/m);
    });
  });
  ```

- [ ] **Step 7: Run the web test and watch it FAIL.**

  Command (repo root):
  ```
  npx vitest run apps/web/test/tokenSocialSection.test.ts
  ```
  Expected: FAIL — `SocialSection.tsx` does not exist (`ENOENT` on `readFileSync`) and the page has no `getTokenSocialMentions` / `<SocialSection` wiring yet.

- [ ] **Step 8: Create the `SocialSection` server component.**

  Create `apps/web/components/tokens/SocialSection.tsx`. Server component (no `'use client'`), Card-based dark theme matching `RiskPanel.tsx`. Renders: (1) the mention velocity summary (per-window counts + distinct authors + accel for THIS token), (2) the recent-mentions feed with spam-greying and unlinked-safe chips, (3) an honest empty state. Pure display — no scoring, no writes.

  ```tsx
  import Link from 'next/link';
  import { Badge } from '@/components/ui/badge';
  import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
  import { fmtAge } from '@/lib/format';
  import type { MentionVelocityRow } from '@flowradar/core';

  /** One mention row, projected at the page's query boundary (Dates -> Date is
   *  fine for a server component; only client charts need ISO strings). */
  export interface SocialMentionRowVM {
    id: string;
    sourceName: string;
    platform: string;
    trustTier: string;
    postedAt: Date;
    contentSnippet: string;
    mentionType: string;
    tokenId: string | null;
    tokenAddress: string | null;
    tokenSymbol: string | null;
    spamScore: number;
    spamReason: string | null;
  }

  export interface SocialSectionProps {
    mentions: SocialMentionRowVM[];
    /** This token's velocity rows (usually 0 or 1 row after keying by token). */
    velocity: MentionVelocityRow[];
    /** From settings.connectors.social.spam.uiHideThreshold — display filter. */
    uiHideThreshold: number;
  }

  const TRUST_BADGE_CLASS: Record<string, string> = {
    high: 'border-transparent bg-emerald-500/15 text-emerald-300',
    medium: 'border-transparent bg-zinc-500/15 text-zinc-300',
    low: 'border-transparent bg-amber-500/15 text-amber-400',
  };

  const WINDOW_LABEL: Record<number, string> = { 60: '1h', 360: '6h', 1440: '24h' };

  /**
   * Token-detail "Social mentions" section (Task F, spec §8) — SHADOW-ONLY
   * confluence evidence. Read-only: it renders this token's spam-filtered
   * recent SocialMention rows and its mention velocity. It does NOT touch
   * FlowScore, signal status, wallet scoring, or emit any alert — the social
   * subsystem is entirely separate from the wallet-candidate/scoring pipeline.
   *
   * Spam is filtered for DISPLAY, never dropped from data: mentions with
   * spamScore >= uiHideThreshold are greyed + reason-badged, not removed
   * (spec §4). Mentions whose token didn't resolve (tokenId === null) still
   * render, shown as "unlinked" with their raw address/ticker (spec §10).
   */
  export function SocialSection({ mentions, velocity, uiHideThreshold }: SocialSectionProps) {
    // This token has at most one velocity row (keyed by token); take the first.
    const vel = velocity[0] ?? null;
    // Per-window count/distinctAuthors live in vel.windows[] (MentionVelocityRow
    // has no counts/distinctAuthors Record). Sort ascending by window length.
    const windows = vel ? [...vel.windows].sort((a, b) => a.windowMin - b.windowMin) : [];

    return (
      <div className="flex flex-col gap-4">
        {/* Mention velocity summary */}
        <Card>
          <CardHeader>
            <CardTitle>Mention velocity</CardTitle>
          </CardHeader>
          <CardContent>
            {!vel ? (
              <p className="text-sm text-muted-foreground">
                No mention velocity — no non-spam mentions in the tracked windows.
              </p>
            ) : (
              <div className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
                {windows.map((w) => (
                  <div key={w.windowMin}>
                    <div className="text-xs text-muted-foreground">{WINDOW_LABEL[w.windowMin] ?? `${w.windowMin}m`}</div>
                    <div className="font-medium tabular-nums">
                      {w.count}
                      <span className="ml-1 text-xs text-muted-foreground">
                        ({w.distinctAuthors} authors)
                      </span>
                    </div>
                  </div>
                ))}
                <div>
                  <div className="text-xs text-muted-foreground">Accel</div>
                  <div className="font-medium tabular-nums">{vel.accel.toFixed(2)}×</div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Recent mentions feed (spam-greyed, unlinked-safe) */}
        <Card>
          <CardHeader>
            <CardTitle>Recent mentions</CardTitle>
          </CardHeader>
          <CardContent>
            {mentions.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No social mentions for this token yet.
              </p>
            ) : (
              <ul className="flex flex-col gap-3">
                {mentions.map((m) => {
                  const isSpam = m.spamScore >= uiHideThreshold;
                  return (
                    <li
                      key={m.id}
                      className={
                        'flex flex-col gap-1 rounded-md border border-border/50 p-3 ' +
                        (isSpam ? 'opacity-40' : '')
                      }
                    >
                      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <span className="font-medium text-foreground">{m.sourceName}</span>
                        <span>{m.platform}</span>
                        <Badge className={TRUST_BADGE_CLASS[m.trustTier] ?? TRUST_BADGE_CLASS.medium}>
                          {m.trustTier}
                        </Badge>
                        <span>{fmtAge(m.postedAt)} ago</span>
                        {m.tokenId === null && (
                          <Badge className="border-transparent bg-zinc-800/50 text-zinc-400">
                            unlinked · {m.tokenSymbol ? `$${m.tokenSymbol}` : m.tokenAddress ?? m.mentionType}
                          </Badge>
                        )}
                        {isSpam && m.spamReason && (
                          <Badge className="border-transparent bg-red-500/15 text-red-400">
                            {m.spamReason}
                          </Badge>
                        )}
                      </div>
                      <p className="text-sm">{m.contentSnippet}</p>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>

        <p className="text-xs text-muted-foreground">
          Shadow-only social evidence — not a scoring or alert input.{' '}
          <Link href="/social" className="hover:underline">
            View all social mentions
          </Link>
        </p>
      </div>
    );
  }
  ```

- [ ] **Step 9: Wire `SocialSection` into the token detail page.**

  Modify `apps/web/app/tokens/[id]/page.tsx`. Add imports, fetch this token's mentions inside the existing `Promise.all`, compute velocity, map to the component VM, and render the section after the existing "Risk & context" block. Do NOT alter any existing query, prop, or the scoring/flow display.

  Add these imports near the top (alongside the existing component imports):
  ```tsx
  import { getTokenSocialMentions } from '@flowradar/db';
  import { computeMentionVelocity, DEFAULT_SETTINGS } from '@flowradar/core';
  import { SocialSection } from '@/components/tokens/SocialSection';
  import type { SocialMentionRowVM } from '@/components/tokens/SocialSection';
  ```

  Add `getTokenSocialMentions(prisma, token.id)` as the final element of the existing `Promise.all` and capture it:
  ```tsx
  const [chain, latestMarket, latestFlow, marketSeries, flowHistory, trades, socialMentions] =
    await Promise.all([
      prisma.chain.findUnique({ where: { id: token.chain } }),
      prisma.tokenMarketSnapshot.findFirst({ where: { tokenId: token.id }, orderBy: { ts: 'desc' } }),
      prisma.tokenFlowSnapshot.findFirst({ where: { tokenId: token.id }, orderBy: { ts: 'desc' } }),
      prisma.tokenMarketSnapshot.findMany({ where: { tokenId: token.id }, orderBy: { ts: 'asc' } }),
      prisma.tokenFlowSnapshot.findMany({ where: { tokenId: token.id }, orderBy: { ts: 'asc' } }),
      prisma.walletTokenTrade.findMany({
        where: { tokenId: token.id, action: { in: ['BUY', 'SELL'] } },
        orderBy: { ts: 'asc' },
        include: {
          wallet: {
            include: {
              classifications: true,
              stats: { orderBy: { computedAt: 'desc' }, take: 1 },
            },
          },
        },
      }),
      getTokenSocialMentions(prisma, token.id),
    ]);
  ```

  After the RiskPanel `riskFlags` derivation, add the social derivations (place with the other prop-mapping blocks, before `return`):
  ```tsx
  // ---------------------------------------------------------------------
  // SocialSection props (Task F) — shadow-only. Velocity is computed on read
  // from THIS token's mentions (spam excluded above spamMaxScore), never
  // stored. Spam is filtered for display in the component, not dropped here.
  // ---------------------------------------------------------------------
  const socialCfg = DEFAULT_SETTINGS.connectors.social;
  const mentionVelocity = computeMentionVelocity(
    socialMentions.map((m) => ({
      tokenId: m.tokenId,
      tokenAddress: m.tokenAddress,
      authorHash: m.authorHash,
      postedAt: m.postedAt,
      spamScore: m.spamScore,
    })),
    new Date(),
    { windowsMin: socialCfg.velocityWindowsMin, spamMaxScore: socialCfg.spam.uiHideThreshold },
  );
  const socialMentionRows: SocialMentionRowVM[] = socialMentions.map((m) => ({
    id: m.id,
    sourceName: m.source.name,
    platform: m.platform,
    trustTier: m.source.trustTier,
    postedAt: m.postedAt,
    contentSnippet: m.contentSnippet,
    mentionType: m.mentionType,
    tokenId: m.tokenId,
    tokenAddress: m.tokenAddress,
    tokenSymbol: m.tokenSymbol,
    spamScore: m.spamScore,
    spamReason: m.spamReason,
  }));
  ```

  Render the section after the existing "Risk & context" block and before the "Back to Tokens" link:
  ```tsx
      {/* Social mentions (shadow-only confluence — Task F) */}
      <div>
        <h2 className="mb-3 text-lg font-medium tracking-tight">Social mentions</h2>
        <SocialSection
          mentions={socialMentionRows}
          velocity={mentionVelocity}
          uiHideThreshold={socialCfg.spam.uiHideThreshold}
        />
      </div>
  ```

- [ ] **Step 10: Run the web test and watch it PASS.**

  Command:
  ```
  npx vitest run apps/web/test/tokenSocialSection.test.ts
  ```
  Expected: PASS — 8 passing (all `it` cases), 0 failing.

- [ ] **Step 11: Typecheck + build (page must compile against the real signatures).**

  Commands (repo root):
  ```
  npm run typecheck
  npm run build
  ```
  Expected: PASS — `tsc -b` clean for `packages/core packages/db` and the web `tsc --noEmit`; `next build` compiles `/tokens/[id]` with the new imports. (If `DEFAULT_SETTINGS.connectors.social` or `computeMentionVelocity`/`MentionVelocityRow` are not yet exported because Task 3/Task B are unmerged, this task is blocked on those — do not stub them here; the signatures are theirs.)

- [ ] **Step 12: Commit the component + page wiring + web test.**
  ```
  git add apps/web/components/tokens/SocialSection.tsx apps/web/app/tokens/[id]/page.tsx apps/web/test/tokenSocialSection.test.ts
  git commit -m "feat(web): shadow-only Social mentions section on token detail page"
  ```

- [ ] **Step 13: Full gate.**

  Command (repo root):
  ```
  npm run verify
  ```
  Expected: PASS — typecheck + full `vitest run` (incl. this task's db + web tests) + `next build` all green on a clean/rebuilt DB.

**Done Bar:**
- `getTokenSocialMentions(prisma, tokenId)` exists in `packages/db/src/social/queries.ts`, is re-exported from `@flowradar/db`, returns only that token's mentions (newest first, capped 50) each with `source: { name, platform, trustTier }`, and returns `[]` (never throws) for a token with no mentions.
- `apps/web/components/tokens/SocialSection.tsx` exists as a server component (no `'use client'`), renders mention velocity + a spam-greyed, unlinked-safe recent-mentions feed, and shows an honest empty state ("No social mentions for this token yet.") when `mentions.length === 0`.
- `apps/web/app/tokens/[id]/page.tsx` fetches via `getTokenSocialMentions`, computes velocity via `computeMentionVelocity` using `DEFAULT_SETTINGS.connectors.social`, and renders `<SocialSection … uiHideThreshold={…} />` after "Risk & context". No existing query, prop, or scoring/flow display is changed.
- High-spam mentions (`spamScore >= uiHideThreshold`) are greyed + reason-badged, never removed from the data.
- `npx vitest run packages/db/src/social/getTokenSocialMentions.test.ts` → 2 passing (db up); `npx vitest run apps/web/test/tokenSocialSection.test.ts` → 8 passing; `npm run verify` green.

**Reviewer Focus:**
- **Shadow-only / no-scoring (constraints 3–7):** confirm the page's social block adds NO write and touches NO FlowScore / signal-threshold / wallet-scoring / CandidateWallet path — it only reads mentions and displays them. The existing token scoring/flow blocks must be byte-for-byte unchanged except for the added `Promise.all` element and the new JSX block.
- **Graceful skips (constraint 11 / spec §10):** verify the empty-state test actually exercises a no-mentions token, and that `tokenId === null` mentions still render ("unlinked" with raw ticker/address) rather than crashing or being dropped.
- **Spam is filtered for display, not deleted (spec §4):** the `spamScore >= uiHideThreshold` comparison must grey/collapse, and the velocity computation must pass `spamMaxScore` so spammy rows are excluded from counts — but no mention is deleted from the DB or omitted from the feed data.
- **No new render deps (web convention):** the web test must stay a Node source-text check (`readFileSync` + regex, CRLF-normalized) — reject any attempt to add jsdom/@testing-library or import the `.tsx` under vitest, which has no JSX transform here.
- **Signatures owned by earlier tasks:** `getTokenSocialMentions`'s `source` projection, `computeMentionVelocity`'s param shape, `MentionVelocityRow`, and `DEFAULT_SETTINGS.connectors.social` must be consumed exactly as Tasks E/B/3 define them — no re-declaration or divergent stub in this task.
- **Solana-only + cap:** the query is chain-agnostic by `tokenId` (correct — the token already fixes the chain), and `take: 50` bounds a spammed token; confirm no unbounded `findMany` on `SocialMention` in the page path.

### Task G: Integration tests + `npm run verify` + `/social` smoke (feature gate)

**Files:**
- **Create (test):** `packages/db/test/socialIngest.test.ts` — the cross-cutting end-to-end integration test that boots `runSocialIngestPass` against seeded `SocialSource` rows in `MOCK_MODE`, asserts mentions are created, asserts the wallet-signal overlap join returns confluence rows, and asserts graceful skips (disabled source, no-provider source).
- **Create (test):** `apps/web/test/socialPage.test.ts` — plain-Node source-text render check that `/social` renders both the empty state and the populated panels, and that the token-detail `SocialSection` is wired in (matches this app's no-JSX-harness convention: `framingBanner.test.ts` / `overlapHybridTruncation.test.ts`).
- **Modify:** `vitest.config.ts` — no schema change needed; **confirm** the new `packages/db/test/socialIngest.test.ts` lands in the existing `db` project (`root: './packages/db'`, `include: ['test/**/*.test.ts']`, `fileParallelism: false`) and `apps/web/test/socialPage.test.ts` in the existing `web` project. No edits are required if both files are placed under those roots; this task verifies that placement, it does not add a new project.
- **Consume (read-only, no edits — produced by Tasks A–F):** `packages/db/src/social/ingest.ts` (`runSocialIngestPass`), `packages/db/src/social/overlap.ts` (`getSocialSignalOverlap`), `packages/db/src/social/queries.ts` (`getRecentMentions`), `packages/providers/src/social/mockSocialSource.ts` (`MockSocialSource`), `packages/db/src/seed.ts` (2 seeded `SocialSource` rows), `apps/web/app/social/page.tsx`, `apps/web/app/tokens/[id]/page.tsx` + its `SocialSection`.

> **File-name note:** Task D also owns a `packages/db/test/socialIngest.test.ts` (the ingest-body unit suite) and Task E owns `apps/web/test/socialPage.test.ts` (route + page wiring). If those files already exist from D/E, ADD this task's cross-cutting end-to-end cases into the same files (a new `describe` block), rather than clobbering them. The Done Bar below refers to the combined suites.

**Interfaces:**
- **Consumes (exact signatures from earlier tasks — do not redefine):**
  - `runSocialIngestPass(prisma: PrismaClient, settings: Settings, resolveProvider: (source: SocialSourceRow) => SocialSourceProvider | null | undefined, log?: SocialIngestLogger): Promise<SocialIngestResult>` — mirrors `runExternalWalletSourceSync` (Task E). Its result object exposes at least `{ sourcesConsidered, sourcesSynced, sourcesSkippedDisabled, mentionsUpserted, errors }` (asserted below; if a produced field name differs, read `packages/db/src/social/ingest.ts` and use the actual names — do NOT invent).
  - `getSocialSignalOverlap(prisma: PrismaClient, opts?: { windowMinutes?: number; limit?: number }): Promise<SocialSignalOverlapRow[]>` where `SocialSignalOverlapRow = { tokenId: string; tokenSymbol: string; tokenAddress: string; socialMentionCount: number; distinctAuthors: number; latestFlowScore: number | null; firedSignals: { rule: string; severity: string; triggeredAt: Date }[] }` (Task E, canonical owner, Spec §9). NOTE: opts take `windowMinutes`/`limit` only — there is NO `chain` key; `firedSignals` is an array of `{ rule, severity, triggeredAt }` objects, NOT `string[]`, so assert on `.some((s) => s.rule === 'A')` (not `.toContain('A')`).
  - `getRecentMentions(prisma: PrismaClient, opts?: { limit?: number; includeSpamAtOrAbove?: number }): Promise<RecentMentionRow[]>` (Task E).
  - `MockSocialSource` (Task B): `new MockSocialSource(world?)`, implements `SocialSourceProvider` (`name`, `platform`, `chains`, `fetchPosts(chain, opts?)`), returns deterministic fixtures including copy-paste + multi-token posts referencing seeded mock tokens (NOVA/QUIET).
  - `DEFAULT_SETTINGS` from `@flowradar/core` (now carries `connectors.social`, Task C, Spec §7).
- **Produces:** No new exported production symbols. This task produces the **feature gate**: a green `npm run verify` on a rebuilt DB, a smoke-verified `/social` route, and a git-diff scope check confirming no out-of-scope file was touched. Nothing later depends on it.

- [ ] **Step 1: Write the failing db integration test.** Create `packages/db/test/socialIngest.test.ts`. This is the cross-cutting end-to-end test: it seeds its own `SocialSource` + `Token` rows (prefix-namespaced so the shared LITE DB stays clean), runs `runSocialIngestPass` with a `MockSocialSource`-style fixture provider, and asserts mentions created, overlap join returns rows, and both graceful skips. Follow the exact `probePort(5439)` + `describe.skipIf` + prefix-cleanup shape from `externalWalletSource.test.ts`.

```typescript
// packages/db/test/socialIngest.test.ts
// FlowRadar — social ingest end-to-end integration test (Task G, Spec §11 db
// bullet). Same LITE-Postgres integration pattern as
// externalWalletSource.test.ts (probePort(5439), describe.skipIf when the
// embedded Postgres isn't reachable, prefix-namespaced rows + afterAll/
// beforeEach cleanup so the shared single-instance DB stays clean and this
// file is safe under the db project's fileParallelism:false serialization).
//
// This is the CROSS-CUTTING gate test: it drives runSocialIngestPass (the
// reusable ingest body, Task E) end-to-end against seeded SocialSource rows
// in a MOCK_MODE-equivalent path (a deterministic in-test provider, exactly
// as MockSocialSource is selected for any source when MOCK_MODE !== 'false'),
// and asserts:
//   1. mentions are created for a copy-paste + multi-token fixture,
//   2. the wallet-signal overlap join returns a confluence row for a token
//      that has BOTH a social mention and a wallet-driven Signal,
//   3. a disabled source is skipped (no mentions, provider never called),
//   4. a source whose resolver returns null is a graceful no-op (no throw).

import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import net from 'node:net';
import { DEFAULT_SETTINGS } from '@flowradar/core';
import type { Chain } from '@flowradar/core';
import type { SocialPostRaw, FetchPostsOpts, SocialSourceProvider } from '@flowradar/providers';
import { prisma } from '../src/client';
import { runSocialIngestPass } from '../src/social/ingest';
import { getSocialSignalOverlap } from '../src/social/overlap';
import { getRecentMentions } from '../src/social/queries';

const TOKEN_PREFIX = 'TGsocialTok';
const SOURCE_PREFIX = 'TGsocialSrc';

function probePort(host: string, port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

let dbReachable = false;

beforeAll(async () => {
  dbReachable = await probePort('localhost', 5439);
  if (!dbReachable) {
    // eslint-disable-next-line no-console
    console.warn(
      '[socialIngest.test] LITE Postgres not reachable on localhost:5439 — skipping ' +
        'integration tests. Run `npm run db:migrate` first to exercise this suite.'
    );
  }
});

async function cleanup(): Promise<void> {
  // Leaf-to-root: mentions FK -> sources + tokens; signals FK -> tokens.
  await prisma.socialMention.deleteMany({ where: { source: { name: { startsWith: SOURCE_PREFIX } } } });
  await prisma.socialSource.deleteMany({ where: { name: { startsWith: SOURCE_PREFIX } } });
  await prisma.signal.deleteMany({ where: { token: { address: { startsWith: TOKEN_PREFIX } } } });
  await prisma.token.deleteMany({ where: { address: { startsWith: TOKEN_PREFIX } } });
}

afterAll(async () => {
  if (!dbReachable) return;
  await cleanup();
  await prisma.$disconnect();
});

beforeEach(async () => {
  if (!dbReachable) return;
  await cleanup();
});

// A deterministic in-test provider standing in for MockSocialSource: returns
// a fixed post set (a multi-token post + an exact copy-paste of it from a
// second author) so the extractor emits >1 mention and the classifier has a
// copy-paste pair to score. callCount lets the disabled-source test prove the
// provider was never invoked.
function makeFixtureProvider(name: string, posts: SocialPostRaw[]): SocialSourceProvider & { callCount: number } {
  return {
    name,
    platform: 'telegram',
    chains: ['SOLANA'],
    callCount: 0,
    async fetchPosts(_chain: Chain, _opts?: FetchPostsOpts) {
      this.callCount += 1;
      return posts;
    }
  };
}

async function makeSourceRow(name: string, overrides: Partial<{ enabled: boolean; platform: string }> = {}) {
  return prisma.socialSource.create({
    data: {
      name,
      platform: overrides.platform ?? 'telegram',
      enabled: overrides.enabled ?? true,
      chainSupport: ['SOLANA'],
      apiKeyEnvName: null,
      rateLimitPerMinute: 30
    }
  });
}

describe.skipIf(!(await probePort('localhost', 5439)))('runSocialIngestPass (end-to-end, Task G gate)', () => {
  it('enabled source creates SocialMention rows for a multi-token + copy-paste fixture', async () => {
    const sourceName = `${SOURCE_PREFIX}_basic`;
    await makeSourceRow(sourceName);

    // Create a Token the fixture's address mention resolves to, so at least
    // one mention is token-LINKED (tokenId set) rather than gracefully unlinked.
    const linkedAddr = `${TOKEN_PREFIX}Aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`;
    await prisma.token.create({
      data: { chain: 'SOLANA', address: linkedAddr, symbol: 'TGLINK', decimals: 9, firstSeenAt: new Date(), riskFlags: [] }
    });

    // Post 1 mentions the linked address + a $TGTICK cashtag (2 tokens ->
    // 2 rows). Post 2 is a verbatim copy-paste of post 1 from a second author.
    const body = `aping ${linkedAddr} and $TGTICK looks strong ser`;
    const posts: SocialPostRaw[] = [
      { externalId: 'p1', authorHash: 'authorA', content: body, postedAt: new Date() },
      { externalId: 'p2', authorHash: 'authorB', content: body, postedAt: new Date() }
    ];

    const provider = makeFixtureProvider(sourceName, posts);
    const result = await runSocialIngestPass(prisma, DEFAULT_SETTINGS, (s) => (s.name === sourceName ? provider : null));

    expect(result.errors).toBe(0);
    expect(result.mentionsUpserted).toBeGreaterThanOrEqual(2);

    const mentions = await prisma.socialMention.findMany({ where: { source: { name: sourceName } } });
    // 2 posts x 2 tokens = 4 mention rows (dedupeKey = externalPostId::token).
    expect(mentions.length).toBeGreaterThanOrEqual(4);

    // At least one mention is token-LINKED (the address resolved to our Token).
    const linked = mentions.filter((m) => m.tokenId !== null);
    expect(linked.length).toBeGreaterThanOrEqual(1);

    // At least one mention is gracefully UNLINKED (pure $TGTICK cashtag, no
    // Token row) — the Spec §10 "pure ticker with no address is stored unlinked".
    const unlinked = mentions.filter((m) => m.tokenId === null && m.tokenSymbol === 'TGTICK');
    expect(unlinked.length).toBeGreaterThanOrEqual(1);

    // Snippet safety: every stored snippet is <=280 chars (Spec §1), and no
    // full raw archive is stored.
    for (const m of mentions) {
      expect(m.contentSnippet.length).toBeLessThanOrEqual(280);
      expect(m.normalizedSnippet.length).toBeLessThanOrEqual(280);
    }

    // The copy-paste pair (same normalized content from 2 distinct authors)
    // shares a contentHash — the classifier's copy-paste key. Shadow-only:
    // rows are STORED with a spamScore, never dropped.
    const hashes = new Set(mentions.map((m) => m.contentHash));
    expect(hashes.size).toBeLessThan(mentions.length); // at least one shared hash

    // getRecentMentions returns them (feed query works end-to-end).
    const recent = await getRecentMentions(prisma, { limit: 50 });
    expect(recent.some((r) => r.contentSnippet.includes('$TGTICK') || r.tokenSymbol === 'TGTICK')).toBe(true);
  });

  it('overlap join returns a confluence row for a token with BOTH a social mention and a wallet Signal', async () => {
    const sourceName = `${SOURCE_PREFIX}_overlap`;
    await makeSourceRow(sourceName);

    const addr = `${TOKEN_PREFIX}Bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`;
    const token = await prisma.token.create({
      data: { chain: 'SOLANA', address: addr, symbol: 'TGOVL', decimals: 9, firstSeenAt: new Date(), riskFlags: [] }
    });

    // A wallet-driven Signal on this token (the "smart-money" leg of the
    // confluence). Uses the REAL Signal columns (schema.prisma model Signal) —
    // identical field set to Task E's overlap-test Signal.create.
    await prisma.signal.create({
      data: {
        tokenId: token.id,
        rule: 'A',
        severity: 'HIGH',
        reasons: ['multi-wallet accumulation'],
        walletCount: 5,
        uniqueEntityCount: 4,
        netFlowUsd: 1000,
        mcapAtTrigger: 500_000,
        status: 'active',
        triggeredAt: new Date()
      }
    });

    // A social mention on the SAME token (the social leg).
    const posts: SocialPostRaw[] = [
      { externalId: 'ovl1', authorHash: 'authorC', content: `watch ${addr} confluence`, postedAt: new Date() }
    ];
    await runSocialIngestPass(prisma, DEFAULT_SETTINGS, (s) => (s.name === sourceName ? makeFixtureProvider(sourceName, posts) : null));

    const overlap = await getSocialSignalOverlap(prisma, { windowMinutes: 1440 });
    const row = overlap.find((r) => r.tokenId === token.id);
    expect(row).toBeDefined();
    expect(row!.socialMentionCount).toBeGreaterThanOrEqual(1);
    expect(row!.firedSignals.some((s) => s.rule === 'A')).toBe(true);
  });

  it('disabled source is skipped entirely — no mentions, provider never called', async () => {
    const sourceName = `${SOURCE_PREFIX}_disabled`;
    await makeSourceRow(sourceName, { enabled: false });

    const provider = makeFixtureProvider(sourceName, [
      { externalId: 'dp1', authorHash: 'authorD', content: `never ${TOKEN_PREFIX}Cccccccccccccccccccccccccccccccc ingested`, postedAt: new Date() }
    ]);

    // Scoped resolver: only this test's own source could ever resolve, so
    // other (possibly seeded) SocialSource rows in the shared DB don't
    // pollute the callCount / mention assertions.
    const result = await runSocialIngestPass(prisma, DEFAULT_SETTINGS, (s) => (s.name === sourceName ? provider : null));

    expect(result.sourcesSkippedDisabled).toBeGreaterThanOrEqual(1);
    expect(provider.callCount).toBe(0);

    const mentions = await prisma.socialMention.findMany({ where: { source: { name: sourceName } } });
    expect(mentions).toHaveLength(0);
  });

  it('resolver returning null for a source is a graceful no-op — no throw, no mentions', async () => {
    const sourceName = `${SOURCE_PREFIX}_noprovider`;
    await makeSourceRow(sourceName);

    const result = await runSocialIngestPass(prisma, DEFAULT_SETTINGS, (s) => (s.name === sourceName ? null : null));

    expect(result.errors).toBe(0);
    expect(result.mentionsUpserted).toBe(0);

    const mentions = await prisma.socialMention.findMany({ where: { source: { name: sourceName } } });
    expect(mentions).toHaveLength(0);
  });

  it('re-ingest of the same posts is idempotent — dedupeKey collapses, no duplicate rows', async () => {
    const sourceName = `${SOURCE_PREFIX}_idem`;
    await makeSourceRow(sourceName);

    const addr = `${TOKEN_PREFIX}Dddddddddddddddddddddddddddddddd`;
    const posts: SocialPostRaw[] = [
      { externalId: 'idem1', authorHash: 'authorE', content: `gm ${addr}`, postedAt: new Date() }
    ];
    const run = () => runSocialIngestPass(prisma, DEFAULT_SETTINGS, (s) => (s.name === sourceName ? makeFixtureProvider(sourceName, posts) : null));

    await run();
    const afterFirst = await prisma.socialMention.count({ where: { source: { name: sourceName } } });
    await run();
    const afterSecond = await prisma.socialMention.count({ where: { source: { name: sourceName } } });

    expect(afterFirst).toBeGreaterThanOrEqual(1);
    expect(afterSecond).toBe(afterFirst); // @@unique([sourceId, dedupeKey]) upsert — no dup rows
  });
});
```

- [ ] **Step 2: Run the db integration test — expect FAIL only if a produced field/signature drifted; otherwise expect PASS on a migrated DB.** From the repo root:

```
npm run db:migrate
npx vitest run packages/db/test/socialIngest.test.ts
```

Expected on a **migrated** DB with Tasks A–F merged: **PASS** (this is a gate test over already-built code). If it FAILS, the failure is a real defect in an earlier task's produced surface — read the failing assertion, open the named source file (`ingest.ts` / `overlap.ts` / `queries.ts` / `schema.prisma`), and fix the drift (e.g. a `mentionsUpserted` field named differently, a missing `firedSignals` field, a snippet exceeding 280). Do NOT weaken the test to make it pass. If Postgres is not up, the whole `describe` self-skips (green with 0 assertions run) — that is the documented `probePort` skip, not a pass; you MUST run `npm run db:migrate` first so the suite actually executes.

- [ ] **Step 3: Commit the db integration test.**

```
git add packages/db/test/socialIngest.test.ts
git commit -m "test(db): social ingest end-to-end gate — mentions + overlap join + graceful skips"
```

- [ ] **Step 4: Write the failing web source-text render test.** Create `apps/web/test/socialPage.test.ts`. `apps/web` has no JSX/render harness (see `framingBanner.test.ts` / `overlapHybridTruncation.test.ts` headers), so this is a plain-Node source-text check that `/social` renders the empty state + all four panels and that the token detail wires in `SocialSection`.

```typescript
// apps/web/test/socialPage.test.ts
// FlowRadar — /social page + token social section source-text render check
// (Task G, Spec §11 web bullet). apps/web has NO JSX/render test harness
// (no jsdom/@testing-library; new deps are forbidden) — see
// framingBanner.test.ts / overlapHybridTruncation.test.ts for the same
// plain-Node source-text convention. Full page rendering (routing, data
// fetching, hydration) is covered by the preview-snapshot boot check in
// Step 8. This test proves, statically, that:
//   - /social is force-dynamic and wires the empty state + all four panels,
//   - the token detail page renders the shadow-only SocialSection,
//   - the shadow-only invariant copy is present (no alerts from social).

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, '..');
const read = (...p: string[]) => readFileSync(path.join(APP_ROOT, ...p), 'utf-8').replace(/\r\n/g, '\n');

describe('/social page (Task G gate — source-text render check)', () => {
  const page = read('app', 'social', 'page.tsx');

  it('is force-dynamic (Spec §8 — all social pages force-dynamic)', () => {
    expect(page).toMatch(/export const dynamic = ['"]force-dynamic['"]/);
  });

  it('renders an empty state (0 sources / 0 mentions) and a way to add a source', () => {
    // Empty-state affordance text + the SourceManager add form must both be
    // referenced so a fresh operator sees an honest empty state, not a crash.
    expect(page).toMatch(/SourceManager/);
    expect(page).toMatch(/[Aa]dd a source/);
  });

  it('renders the recent-mentions feed, velocity, and wallet-signal overlap panels', () => {
    // Panel data comes from the Task F query helpers — the page must call them.
    expect(page).toMatch(/getRecentMentions/);
    expect(page).toMatch(/computeMentionVelocity/);
    expect(page).toMatch(/getSocialSignalOverlap/);
  });

  it('renders source health (mode badge from getSocialSourceStatuses)', () => {
    expect(page).toMatch(/getSocialSourceStatuses/);
  });
});

describe('token detail social section (Task G gate)', () => {
  const tokenPage = read('app', 'tokens', '[id]', 'page.tsx');

  it('token detail page renders <SocialSection /> (shadow-only social mentions)', () => {
    expect(tokenPage).toMatch(/<SocialSection\b/);
  });

  it('SocialSection reads this token\'s mentions + velocity (shadow-only, read-only)', () => {
    const section = read('components', 'tokens', 'SocialSection.tsx');
    expect(section).toMatch(/mentions/);
    expect(section).toMatch(/velocity/);
  });
});
```

> Note: the `SocialSection` component lives at `apps/web/components/tokens/SocialSection.tsx` (Task F's canonical location). Read it from there, not from `app/tokens/[id]/`.

- [ ] **Step 5: Run the web source-text test — expect PASS once Tasks D/F are merged.**

```
npx vitest run apps/web/test/socialPage.test.ts
```

Expected: **PASS** (the `/social` page, `SourceManager`, token `SocialSection`, and the query helpers exist from Tasks D/F). If a matcher FAILS, it means the page did not actually wire a required helper/panel (a real gap) or a name drifted — fix the page/section, not the test. If `app/social/page.tsx` or `SocialSection.tsx` does not exist, the earlier task is incomplete and must be finished before this gate can pass — do NOT stub them here.

- [ ] **Step 6: Commit the web source-text test.**

```
git add apps/web/test/socialPage.test.ts
git commit -m "test(web): /social + token social section source-text render gate"
```

- [ ] **Step 7: Confirm vitest project placement, then run the full gate on a REBUILT DB.** No `vitest.config.ts` edit is needed — both new files sit under existing project roots (`db` and `web` with `include: ['test/**/*.test.ts']`). Verify they are discovered, then run the full gate. Rebuild the DB first so the `SocialSource`/`SocialMention` tables and the 2 seeded sources exist (the README "Full test coverage needs the LITE database up" caveat — the db suite silently self-skips without it).

```
npm run db:migrate
npm run db:seed
npx vitest run --project db --project web
npm run verify
```

Expected: `npx vitest run --project db --project web` runs `socialIngest.test.ts` (in `db`, serialized — `fileParallelism:false`) and `socialPage.test.ts` (in `web`), both **PASS**. Then `npm run verify` (typecheck all workspaces → full vitest → `next build`) is **green end-to-end**.

> **replayRunner pool-timeout caveat (must honor):** the entire `db` vitest project runs against ONE shared embedded-Postgres instance with `fileParallelism: false` and `testTimeout: 20000` set in `vitest.config.ts` **precisely because** whole-DB-pass files (`clustering`/`rotation`/`signalDedupe`/`replayRunner`) hit P2002 races and connection-pool `Timed out fetching a new connection` failures when run concurrently. `socialIngest.test.ts` MUST live in this same serialized `db` project and MUST NOT open its own second `PrismaClient` — it imports the shared `prisma` from `../src/client` (as every other db test does) so it shares the one pool. Do NOT add `--pool` flags, do NOT bump `fileParallelism` to true, and do NOT run the db suite with `--no-file-parallelism` disabled. If `npm run verify` shows a pool-timeout, re-run after confirming no other `npm run worker`/`npm run dev` process is holding the shared pool, and confirm the new test's `afterAll` calls `prisma.$disconnect()`.

- [ ] **Step 8: Smoke `/social` via the preview server — empty state AND populated.** Start the dev server (launch config `flowradar-web`, port 5188) and snapshot the route in both states.

```
# Populated smoke: DB already seeded in Step 7 -> 2 sources + mentions.
```
Use the preview tools: `preview_start` with name `flowradar-web`, then navigate to `http://localhost:5188/social`.
- **Populated smoke** (DB seeded from Step 7): `preview_snapshot` / `preview_screenshot` of `/social` must show the recent-mentions feed, the mention-velocity panel, the wallet-signal overlap panel, and the Manage-sources + source-health section (2 seeded sources, mode badge `mock`). Confirm no console errors via `preview_console_logs` (level `error`). Recharts note: the hidden preview tab historically cannot mount Recharts — if the velocity panel uses a chart, confirm the page still renders (empty-chart fallback, no crash), not a blank error page.
- **Empty-state smoke:** with the server still up, delete the seeded sources to hit the 0-sources path, reload `/social`, and snapshot the honest empty state + "Add a source" affordance:
```
npx tsx -e "import{prisma}from'./packages/db/src/client.ts';await prisma.socialMention.deleteMany();await prisma.socialSource.deleteMany();await prisma.$disconnect()"
```
Reload `http://localhost:5188/social` (force-dynamic — no rebuild needed) and confirm the empty state renders with no console error and no 500. Then restore the demo state for anyone who runs after you: `npm run db:seed`.

- [ ] **Step 9: Final feature Done Bar — scope + secrets diff check.** Run the objective scope guards for the WHOLE feature (all tasks A–G), from the repo root on the feature branch:

```
git diff --stat origin/feat/mvp...HEAD
git diff origin/feat/mvp...HEAD -- packages/core/src/scoring/flowScore.ts packages/core/src/scoring/walletScore.ts packages/providers/src/telegram.ts
git diff origin/feat/mvp...HEAD -- packages/db/prisma/schema.prisma | grep -iE "candidatewallet|model CandidateWallet"
git grep -nE "SOCIAL_TELEGRAM_READ_TOKEN|SOCIAL_DISCORD_BOT_TOKEN" -- packages apps | grep -viE "apiKeyEnvName|env\[|process\.env|\.md|example"
```
Expected:
- `git diff --stat` touches ONLY social files: `packages/db/prisma/schema.prisma` (2 new models + Token back-relation), `packages/core/src/social/*`, `packages/core/src/settings.ts`, `packages/core/src/index.ts`, `packages/providers/src/social/*`, `packages/providers/src/index.ts`, `packages/db/src/social/*`, `packages/db/src/seed.ts`, `packages/db/src/index.ts`, `apps/worker/src/jobs/socialIngest.ts`, `apps/worker/src/index.ts`, `apps/web/app/social/*`, `apps/web/app/api/social/sources/route.ts`, `apps/web/app/tokens/[id]/*`, `apps/web/components/layout/sidebar*`, and the two new test files. **No** file outside that list.
- The second diff (flowScore.ts / walletScore.ts / outbound telegram.ts) is **EMPTY** — those three files are untouched (Global Constraints 2, 5, 7).
- The third command finds **no `CandidateWallet` model change** in the schema diff (only the `socialMentions` back-relation on `Token`, and 2 new models — grep returns nothing for a CandidateWallet model change).
- The fourth grep confirms the env-var NAMES `SOCIAL_TELEGRAM_READ_TOKEN` / `SOCIAL_DISCORD_BOT_TOKEN` appear only as NAME strings / `apiKeyEnvName` / `process.env` reads / docs — **never** a committed literal token value (Constraint 10). Also run `git diff origin/feat/mvp...HEAD | grep -iE "SOCIAL_.*=.{16,}"` and confirm it is empty (no secret assigned inline).

- [ ] **Step 10: Commit any gate fixes and record the gate result.** If Steps 7–9 required no code changes (pure verification), there is nothing to commit beyond Steps 3 and 6. If a drift fix was needed in an earlier-task file, commit it small-scoped:

```
git add -A
git commit -m "fix(social): close gate finding — <one-line what/why>"
```
Re-run `npm run verify` after any fix and confirm green before declaring the gate passed.

**Done Bar:**
- `packages/db/test/socialIngest.test.ts` exists, is discovered by the `db` vitest project (serialized), and its 5 cases PASS on a migrated DB: mentions created (linked + unlinked), overlap join returns a confluence row with `firedSignals` containing `'A'`, disabled source skipped (provider `callCount === 0`), null-resolver graceful no-op, re-ingest idempotent.
- `apps/web/test/socialPage.test.ts` exists, is discovered by the `web` vitest project, and PASSES: `/social` is force-dynamic and wires the empty state, feed, velocity, overlap, and source-health; token detail renders `<SocialSection />`.
- `npm run verify` is **green end-to-end** (typecheck all workspaces + full vitest + `next build`) on a rebuilt/seeded LITE DB.
- `/social` smoke passes in BOTH states via the `flowradar-web` preview server: populated (feed + velocity + overlap + source health, mode badge `mock`, no console error) and empty (honest empty state + "Add a source", no 500).
- `git diff --stat` scope check confirms ONLY social files changed; flowScore.ts, walletScore.ts, and outbound `packages/providers/src/telegram.ts` are byte-for-byte untouched; no `CandidateWallet` model change; no `Alert` row is generated from social.
- No secret committed: `apiKeyEnvName` values are env-var NAMES only; no inline token value in the diff; `.env` still gitignored.

**Reviewer Focus:**
- **No test weakening to force green.** Confirm each `socialIngest.test.ts` assertion is non-vacuous — especially that the overlap case actually creates BOTH a `Signal` and a `SocialMention` on the *same* `tokenId` before asserting `firedSignals` contains `'A'` (a passing overlap test with no signal seeded would be a false pass). Confirm `expect(provider.callCount).toBe(0)` on the disabled case (proves the skip is real, not just an empty result).
- **Shared-pool discipline (replayRunner caveat).** Verify the new db test imports the shared `prisma` from `../src/client`, lives in the `fileParallelism:false` `db` project, calls `prisma.$disconnect()` only in `afterAll`, and adds no new `PrismaClient` — anything else re-introduces the pool-timeout/P2002 races the config comment documents.
- **Scope-guard diffs are the real gate.** Scrutinize that Step 9's `git diff` guards are run against the correct base (`origin/feat/mvp`) and that the flowScore/walletScore/outbound-telegram diff is genuinely empty — this is the primary defense for Global Constraints 2/5/7. Confirm the schema diff adds only 2 models + a `Token` back-relation, with zero change to the `CandidateWallet` model.
- **Shadow-only / no-alert invariant.** Confirm nothing in the ingest path or the smoke produced an `Alert` row from a social mention, and that the `/social` smoke shows evidence panels only (no "send alert" affordance) — social is confluence evidence, never a production alert trigger (Constraints 3, 4).
- **Secrets.** Confirm the secret grep in Step 9 returns only NAME occurrences and the inline-secret grep is empty; the smoke and tests never print an env value; `apiKeyEnvName` is a name throughout.
- **Graceful-skip honesty.** Confirm the empty-state smoke was actually exercised (sources deleted, page reloaded, no 500) and restored via `npm run db:seed` — the empty state is a first-class required behavior (Constraint 11), not an afterthought.

---

## Notes

- **DB tests need the LITE Postgres on port 5439.** Every social integration test in this plan (`packages/db/test/socialSchema.test.ts`, `socialIngest.test.ts`, `socialQueries.test.ts`, and `packages/db/src/social/getTokenSocialMentions.test.ts`) gates on `probePort(5439)` and self-skips (green, 0 assertions run) when the embedded Postgres is not reachable. A skip is NOT a pass — bring the LITE cluster up with `npm run db:migrate` (which runs `db-local.ts ensure`) BEFORE running any DB suite, so the assertions actually execute. The pure `packages/core` and `packages/providers` unit suites need no DB.
- **`npm run verify` must run on a clean / rebuilt DB.** Run `npm run db:migrate` (apply the new `social_intelligence` migration) and `npm run db:seed` (2 example `SocialSource` rows + one mock ingest pass) before the final gate so the schema/tables exist and `/social` renders the populated path rather than the empty state. The whole `db` vitest project runs against ONE shared embedded-Postgres instance with `fileParallelism: false` and `testTimeout: 20000` set in `vitest.config.ts` **specifically because** the whole-DB-pass suites (`clustering` / `rotation` / `signalDedupe` / `replayRunner`) hit P2002 races and connection-pool `Timed out fetching a new connection` failures on soak-scale data when run concurrently. Keep `socialIngest.test.ts` in that same serialized `db` project, import the shared `prisma` from `../src/client` (never open a second `PrismaClient`), and call `prisma.$disconnect()` only in `afterAll`. If `npm run verify` surfaces a `replayRunner` pool-timeout, re-run on a freshly rebuilt DB with no other `npm run worker` / `npm run dev` process holding the shared pool — do NOT raise `fileParallelism` or add `--pool` flags to work around it.
