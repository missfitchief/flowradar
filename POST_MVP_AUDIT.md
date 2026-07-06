# FlowRadar — Post-MVP Production-Readiness Audit

**Scope:** Hardening / audit pass on the merged `v0.1.0-mvp`. **No new features. No
business-logic changes** (signal rules, scoring, validation thresholds) unless a
confirmed bug with a small, obvious, testable fix. Risky or unclear changes are
documented here, not implemented.

**Started:** 2026-07-06 (overnight pass) · **Baseline commit:** `4a49cfb` (`main`, tag `v0.1.0-mvp`)

---

## Phase 1 — Git & release baseline

| Check | Result |
|---|---|
| Branch / HEAD | `main` @ `4a49cfb` |
| Tag | `v0.1.0-mvp` → `4a49cfb` ✅ |
| Merge commit in history | `49a079d` (`Merge feat/mvp: FlowRadar v0.1.0 MVP`) ✅ |
| Working tree | clean ✅ |
| `core.autocrlf` | `true` (Windows) |
| `.gitattributes` | none at baseline (addressed in Phase 2) |
| `npm run verify` | **exit 0** — typecheck + test + Next build all green |
| `npm run test` | **865 passed / 1 skipped** (76 files / 1 skipped) |
| `npm run db:seed` | **66/66 self-checks PASS, 0 FAIL** |

Baseline is green and matches the expected MVP release point. Proceeding.

---

## Phase 2 — Safe Windows/LF hardening

Added a minimal `.gitattributes` (`* text=auto eol=lf` + explicit binary types).

- **Renormalization performed:** none. `git status` after adding the file showed
  **0 modified tracked files** — the committed blobs were already LF-clean, so the
  attribute only governs future checkouts. No noisy whole-repo rewrite.
- `git check-attr` confirms the policy resolves (`text: auto`, `eol: lf`) for
  `.ts`/`.tsx`/`.md` samples.
- `npm run verify` after adding: **exit 0** (green).
- **Commit:** `d254e82` (`.gitattributes` only).

This prevents recurrence of the autocrlf CRLF-smudge that broke the byte-exact
`framingBanner.test.ts` at the v0.1.0 merge, without touching the working tree.

---

## Phase 3 — Deep production-readiness audit

**Verdict:** 0 Critical · 0 High · 2 Medium (both already disclosed / by-design) ·
4 Low/cosmetic. No business logic was changed. The security- and
correctness-critical axes (trust boundary, credit safety, secret handling,
migration integrity) are genuinely strong.

### Findings

#### M1 — No authentication on mutation routes
- **Severity:** Medium · **Evidence:** Confirmed (and **already documented** — `README.md:149` "No auth/multi-user")
- **Location:** `apps/web/app/api/settings/route.ts` (PUT), `apps/web/app/api/sources/route.ts` (PATCH), `apps/web/app/api/import/route.ts` (POST), `apps/web/app/api/alerts/test/route.ts` (POST)
- **Problem:** All mutation endpoints are unauthenticated. Anyone who can reach the port can change thresholds, toggle sources, trigger a CSV import, or send a Telegram test.
- **Impact:** None for the intended local-first single-operator use (bound to `localhost`). Real risk only if the app is ever bound to `0.0.0.0` / port-forwarded / deployed.
- **Minimal safe fix:** None for local use — this is a deliberate scope decision. **Do not add auth in this pass** (net-new feature). Mitigation is operational: keep it on `localhost`; put a reverse proxy + auth in front before any non-local exposure. Documented as a known limitation.
- **Verify:** `README.md` "Known limitations" already states this.

#### M2 — Test coverage varies silently with DB availability
- **Severity:** Medium · **Evidence:** Confirmed
- **Location:** every `packages/db/test/*.test.ts` uses `describe.skipIf(!(await probePort('localhost', 5439)))`; `package.json` `verify = typecheck && test && build`.
- **Problem:** The DB-integration suite runs **only when the LITE Postgres is already up on :5439**. On a fresh clone, `npm run verify` (or `npm run test`) run *before* `npm run db:migrate` silently **skips dozens of DB tests and still exits 0**, presenting as fully green.
- **Impact:** A contributor can believe the full suite passed when the integration layer never ran. (In this audit the DB was up, so coverage was full: 865 passed / 1 skipped.)
- **Minimal safe fix (applied):** documentation only — a note in the README verify section that full coverage requires the LITE DB running (`db:migrate` first). **Not** wiring DB-startup into the `test` script: that would be a behavior change that could break `test` on machines where embedded PG can't start (the skipIf exists precisely so the suite degrades gracefully). By-design behavior, made explicit.
- **Verify:** `npm run db:migrate && npm run test` → 865 passed / 1 skipped (full); the skipped one is the opt-in live smoke (see L2).

#### L1 — Four migrations named `_init`
- **Severity:** Low (cosmetic) · **Evidence:** Confirmed clean at runtime
- **Location:** `packages/db/prisma/migrations/{20260705193951,20260705210705,20260706074131,20260706173733}_init/`
- **Problem:** Four migrations share the `_init` label (dev regenerated the baseline several times). Confusing when reading history.
- **Impact:** None functional. **Proven:** applying all 14 `migration.sql` in timestamp order into a fresh throwaway DB succeeds — `applied=14, failedAt=none, tables=29`, no duplicate-`CREATE TABLE` conflict (later `_init`s are incremental ALTERs, 0 `CREATE TABLE`).
- **Minimal safe fix:** **None — do NOT rename applied migrations** (would break every existing `_prisma_migrations` checksum). Documented only.
- **Verify:** the throwaway-DB apply above (non-destructive; `migrate reset` is correctly blocked by Prisma's agent guard).

#### L2 — One test skipped by default (opt-in live smoke)
- **Severity:** Low (informational) · **Evidence:** Confirmed
- **Location:** `packages/providers/test/dexscreener.live.test.ts:18` — `describe.skipIf(!process.env.LIVE_SMOKE)`.
- **Problem/Impact:** The "1 skipped" in every run is the intentional live-network DexScreener smoke, gated off unless `LIVE_SMOKE=1`. Correct design (no network/paid calls in CI); not a gap.
- **Fix:** none. Run `LIVE_SMOKE=1 npm run test` to exercise it against the live API.

#### L3 — `/tokens/<bad-id>` returns HTTP 200 (not 404) — **not a defect**
- **Severity:** Low (informational) · **Evidence:** Confirmed at runtime — **app code is correct**
- **Location:** `apps/web/app/tokens/[id]/page.tsx:74`
- **Finding:** Runtime check (`/tokens/does-not-exist-xyz` → **200**, 108 KB body) initially looked like the T32-ledger "inline not-found" bug. On inspection the page **already handles it correctly**: `const token = await prisma.token.findUnique(...); if (!token) notFound();` — it calls `notFound()`, which renders the app's `not-found.tsx`. The user sees a proper not-found page.
- **Why 200 not 404:** these routes are `force-dynamic` and stream; the shell's `200` headers flush before the mid-stream `notFound()` throw, so Next.js 15 can't retroactively set `404`. This is a known App-Router streaming nuance, **framework-level, not app code**.
- **Minimal safe fix:** **None.** The code is already correct; there is no defect to fix. (Forcing a 404 status would require rendering the not-found check before any streaming — a structural change with no user-visible benefit, out of scope for a hardening pass.)
- **Verify:** `apps/web/app/tokens/[id]/page.tsx:74` calls `notFound()`; the rendered body is the not-found UI.

#### L4 — `docker-compose.yml` is infra-only (no app service)
- **Severity:** Low (informational, accurate as documented) · **Evidence:** Confirmed
- **Location:** `docker-compose.yml` (postgres:16 + redis:7 only; no Dockerfile).
- **Problem/Impact:** FULL mode runs the Next app + worker on the host; compose provides only Postgres+Redis. This **matches** `README.md:25-37` exactly, so it's by-design, not a defect. Noted so a future reader doesn't expect `docker compose up` to serve the app.
- **Fix:** none.

### Area-by-area confirmations (no findings)

| Area | Result |
|---|---|
| Repo structure | npm-workspaces monorepo (`apps/*`, `packages/*`); clean separation. ✅ |
| Package scripts | Root scripts minimal + correct (`verify = typecheck && test && build`); DB scripts wrap `db-local.ts ensure`. ✅ |
| `.env.example` | All 20+ keys present, empty, commented; credit-safe Dune defaults (`DUNE_USE_LATEST_RESULT=true`, `DUNE_EXECUTE_FRESH=false`). ✅ |
| README accuracy | Spot-checked: `scoring-pass.ts` path real, FULL-mode auto-detect claim matches `db-local.ts`/`runner/index.ts`, DexScreener `holderCount=null`, Telegram `skipped_no_token` all correct. ✅ |
| LITE setup | `db:migrate` → embedded PG16 on :5439 via `db-local.ts ensure`; proven end-to-end. ✅ |
| FULL/Docker docs | `docker-compose.yml` = pg16+redis7; auto-detected by `REDIS_URL` or `DATABASE_URL` :5432. ✅ |
| Prisma / migrations | 14 migrations apply cleanly from zero → 29 tables (see L1). ✅ |
| API routes | 11 route handlers; JSON-parse guarded, Zod-validated, correct 400/404 codes. ✅ |
| Server-side validation | `parseSettings` (deep-merge + `SettingsSchema` incl. cross-field refinement) on settings PUT; `PatchSourceSchema` exactly-one-of refinement on sources. ✅ |
| Provider adapters | Keys read from injected env server/worker-side; graceful `missing_key`/`stub` fallbacks; no hardcoded endpoints in stubs. ✅ |
| Dune credit-safety | Hard kill switch, **code-confirmed** (`client.ts:209-223`): `/execute` unreachable unless `DUNE_EXECUTE_FRESH=true`; per-call override can't bypass. 5 dedicated tests. ✅ |
| Candidate trust boundary | Structural — `packages/core/src` has **zero** PrismaClient/`prisma.` refs; core cannot read `CandidateWallet` (or any table). Signal engine reads only promoted `Wallet`s. ✅ |
| Secret handling | See Phase 4. ✅ |
| Telegram | Token/chat read server-side from env; `skipped_no_token` when unset (seed + `alerts.ts`). ✅ |
| Source Health page | Renders safe fields only (`apiKeyEnvName`, status, counts) — no secret column exists. ✅ |
| Overlap finder | Local/dune/hybrid/provider modes; CoverageBanner honesty surface; Dune rows → `CandidateWallet` only. ✅ |
| Backtest / Shadow | Present; synthetic provenance machine-marked; shadow empty-by-design in mock. ✅ |
| Error/loading/empty states | 13 `loading.tsx` + root `error.tsx` + `not-found.tsx`. ✅ |
| Deployment readiness | LITE proven; FULL documented; scale caveats + no-auth disclosed in README. ✅ |

---

## Phase 4 — Secret / env safety

| Check | Evidence | Result |
|---|---|---|
| Hardcoded secrets in source | `grep -iE "(api_key\|secret\|token\|password\|bearer)\s*[:=]\s*['\"][A-Za-z0-9_-]{12,}"` (excl. node_modules) | Only **fake test fixtures** (`'test-key-123'`, `'secret-abc-123'`, …) in `*/test/*`. **Zero in `src/`.** ✅ |
| Client-exposed env vars | `grep NEXT_PUBLIC_ apps/web` | **No matches.** No env value reaches the client bundle. ✅ |
| `process.env` in client components | `grep process.env apps/web/components` | **No matches.** Client code reads no env. ✅ |
| Keys stored in DB | `ExternalWalletSource` schema | Stores `apiKeyEnvName` (the env-var **name**, e.g. `"HELIUS_API_KEY"`) — **never the value**. Sources PATCH returning the full row is safe. ✅ |
| Status pages expose only safe data | `/sources`, `/settings` selects | Env-**presence booleans** + status strings + counts; no secret values. ✅ |
| Provider keys read server/worker-side | provider factories take injected env | Keys flow through `process.env` on server/worker only; never imported into a client module. ✅ |
| Dune API key transport | `client.ts` | Sent as `X-Dune-API-Key` header from server-side fetch only. ✅ |

**Conclusion:** No secret exposure vector found. The env-var-name-in-DB pattern is a deliberately strong design.

---

## Phase 5 — Route smoke / Done Bar repeat

**Commands:** `npm run db:migrate` (idempotent, DB already current) → `npm run db:seed` (66/66) → `npm run verify` (green — Phase 1) → dev server (`flowradar-web`, :5188) → HTTP smoke of all routes → worker soak.

### Route smoke (dev server on :5188, `MOCK_MODE=true`)

Fetched via the page origin; all return **HTTP 200** with full bodies:

| Route | Status | Route | Status |
|---|---|---|---|
| `/` (Signal Feed) | 200 (578 KB) | `/alerts` | 200 (180 KB) |
| `/tokens` | 200 (442 KB) | `/backtest` | 200 (74 KB) |
| `/flow` | 200 (173 KB) | `/shadow` | 200 (86 KB) |
| `/graph` | 200 (106 KB) | `/settings` | 200 (160 KB) |
| `/overlap` | 200 (165 KB) | `/wallets/import` | 200 (78 KB) |
| `/wallets` | 200 (796 KB) | `/sources` | 200 (130 KB) |

- `/tokens/[id]` (valid) renders; `/tokens/<bad-id>` → 200 rendering the not-found UI (see **L3** — correct `notFound()` code, streaming-status nuance).
- `POST /api/alerts/test` → `200 {"deliveryStatus":"skipped_no_token"}` — Telegram graceful-skip confirmed at runtime. ✅

_(Charts/graphs mount only in a real browser; the hidden preview tab skips ResizeObserver, so this smoke verifies HTTP + server render, not pixel paint — consistent with the app's documented verification convention.)_

### Worker soak

Bounded fast soak (`WORKER_FAST=1`, 3s intervals), each window self-terminated via `taskkill //T`:

**Mock mode (`MOCK_MODE=true`, ~24s) — one full pass, every job `errors:0`:**
`marketDataNormal` 26/28 refreshed · `walletDiscovery` 43 candidates (SOL 40 / BSC 3) · `externalWalletSource` 6 sources synced, 230 candidates · `walletActivity` 155 polled · `tokenTopTraderBackfill` 30 considered/15 qualified · `flowScoring` 29 scored/1 no-window · `entityClustering` 4 clusters, 29 rescored · `signalDetection` 29 processed, 14 deduped · `walletStatsRefresh` 116 refreshed, **37 CSV-skipped (anti-clobber holding)** · `profitRotation` 3 matched. **Zero crash/error lines.** ✅

**Keyless live mode (`MOCK_MODE=false`, ~24s, free providers only) — graceful degradation + credit safety:**
- Missing-key providers skip cleanly: `externalWalletSource: no provider resolved ... skipping` (solana_tracker, birdeye ×2); `tokenTopTraderBackfill: no provider available for chain, skipping token` (per-token). `externalWalletSource` cycle `errors:0` (6 considered, 3 stub-synced).
- **Dune credit safety, runtime-proven:** `[duneQuery] runDuneQuerySync: source disabled, skipping {source: default_token_overlap}` → `sourcesSkippedDisabled:1, sourcesSkippedNoClient:0, errors:0`. **No `/execute` POST, zero credits consumed.** ✅
- `walletStatsRefresh` errors:0; `alertDispatch` 0 pending/0 failed. **Zero crash/error lines.** ✅

Both soaks confirm the worker never crashes, degrades honestly when keys are absent, and never triggers a billable Dune execution.

---

## Phase 6 — Final report

See the session message accompanying this commit for the operator-facing summary. Net result of the pass:

- **Commits:** `d254e82` (`.gitattributes` LF policy) + one docs commit (README coverage note) + this audit report. **No source/logic changes.**
- **Critical/High fixed:** none needed (none found).
- **Critical/High remaining:** none.
- **Medium backlog:** M1 no-auth (by-design, documented), M2 coverage-varies-with-DB (documented + README note added).
- **Low backlog:** L1 `_init` naming (do not rename), L2 opt-in live smoke (working as designed), L3 bad-id 200 (correct `notFound()` + Next streaming nuance, no fix), L4 infra-only compose (by-design).
- **MVP still green:** yes — `verify` green, seed 66/66, all routes 200, both worker soaks clean, migrations apply from zero.
- **Still `v0.1.0-mvp`-ready:** yes. Hardened (LF policy, verified migration integrity, confirmed security posture); no regressions.


