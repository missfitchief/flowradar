# FlowRadar — Handoff (for Codex)

> Prepared 2026-07-13. This document is the primary orientation file for whoever
> picks up the project. There is **no `AGENTS.md` / `CLAUDE.md`** in this repo —
> read this file plus `README.md`, `docs/POST_MVP_AUDIT.md`, and
> `docs/CURRENT_STATE_RECONCILIATION.md` first, and use `.claude/launch.json` for
> the two dev-server presets.

**Snapshot:** branch `feat/runner-dormant-behavior` @ `6ba6c3c` (this working
tree == `origin` at handoff time), base branch `main`, draft PR **#6** open (not
merged). Private remote `origin = github.com/missfitchief/flowradar`. Full git
history (275 commits) is included in this folder's `.git`.

---

## Table of contents
1. [What the project does](#1-what-the-project-does)
2. [Current status & completed work](#2-current-status--completed-work)
3. [Architecture & important files](#3-architecture--important-files)
4. [Setup & run commands](#4-setup--run-commands)
5. [Tests & build commands](#5-tests--build-commands)
6. [Unfinished tasks & known bugs](#6-unfinished-tasks--known-bugs)
7. [Important technical decisions](#7-important-technical-decisions)
8. [Required environment variables (names only)](#8-required-environment-variables-names-only)
9. [Exact next recommended step](#9-exact-next-recommended-step)

---

## 1. What the project does

FlowRadar is a **local-first, single-user Solana + BNB Chain wallet-intelligence
dashboard plus a background worker bot**. It surfaces early, "insider-like" token
activity by continuously tracking profitable/known wallets and their capital
movements, using **only public on-chain and market data**. It is **wallet-driven
by design**: tokens enter the system only when tracked wallets — or their funded
fresh-wallet receivers, or profit-rotation paths — touch them, at which point the
**token** (not just the wallet) is scored, signalled, and alerted.

The engine computes a per-wallet **WalletScore** and per-token **FlowScore
(0–100)**, runs **seven signal rules A–G** (multi-wallet accumulation, sustained
accumulation, human-vs-bot composition, whale conviction, fresh-wallet
funding→buy, cross-bridge profit rotation, smart-money exit/rug warning), does
**union-find entity clustering** to deflate sybil clusters, **BFS wallet-graph**
tracing, and validates/backtests signals against real later price series in a
shadow/observation mode.

**Primary loop:** start from a known/tracked **signal_eligible** root entity →
follow its outbound capital (direct transfer, gas funding, or bridge hop) → to a
fresh/inactive **receiver** wallet → enroll & monitor it as **observation_only** →
watch for its first token buy or a deployment → surface the touched token as a
scored **candidate/signal** — never letting the un-promoted receiver itself count
toward smart-wallet counts, FlowScore, or signals until it passes validation and
is promoted.

**Product framing (enforced in code *and* copy):** analytics-only (never sends a
transaction, places an order, moves funds, or holds keys); observation-only trust
boundary; probabilistic labels only (confidence bands weak/possible/probable/
strong = 0–30/31–60/61–80/81–100); the strongest claim is "strong link
(on-chain evidence, repeated behavior)" — **never** a real-world identity.

**Non-goals (explicit):** no trade execution / order placement / fund movement;
no global new-token/new-pair scanning (discovery is strictly wallet/lineage
driven); no deanonymization; never trust a source's self-claimed PnL at face
value; no market manipulation / front-running / KYC-fraud evasion; no multi-tenant
SaaS/auth; **no Dune fresh (billable) execution by default** (`DUNE_EXECUTE_FRESH=false`).
Deferred: Discord sender, live cross-chain bridge matching beyond
registry+heuristics, and BSC live providers.

---

## 2. Current status & completed work

**Status.** The full **runner-mining / dormant-wallet detection** subsystem is
BUILT and piloted end-to-end. It has passed repeated adversarial **Codex** reviews
(final `VERDICT: APPROVE` each sprint; the most recent live-recovery sprint got
APPROVE after 8 rounds on Codex thread `019f5aef-...`). Everything is
**observation-only / shadow-only by hard rule** — no wallet is `signal_eligible`
except one labeled BSC test fixture.

- **Branch / git:** `feat/runner-dormant-behavior` @ `6ba6c3c`, in sync with
  `origin`; draft PR **#6** (base `main`). Not merged; `main` untouched.
- **Tests (verified this session):** `npm run test` → **1650 passed / 1 skipped**
  against `flowradar_test`. *(Note: `README.md:49` still says "865 tests" — that
  number is stale; the current suite is ~153 `*.test.ts(x)` files.)*
- **Typecheck:** clean across all workspaces (`npm run typecheck`).

**Completed (recent → older):**
- **Live-recovery sprint** (`d3fd3ae..6ba6c3c`): receiver post-receipt backfill +
  token-metadata resolution builders (`packages/db/src/runnermining/liveRecovery.ts`),
  token-identity trust boundary (`apps/web/lib/tokenIdentity.ts`), reusable
  sortable/searchable table (`apps/web/components/SortableTable.tsx`), truthful
  Source Health, plain-English proof pages. Codex re-review rounds 2–8 closed.
  Latest pilot result (`data/runner-mining/live-recovery-report.json`): receivers
  **77 retryable / 63 partial_coverage / 11 covered_no_post_receipt_buy / 0
  deployment**; token metadata **683 considered / 0 resolved / 683 retryable / 0
  missing-credential** (Helius + Birdeye quota-exhausted); capital chains **233
  staging / 0 deployment / 2 profit_rotation**; candidates **320 WATCHING / 1
  STEALTH_ACCUMULATION / 15 INVALIDATED**.
- **Rescue sprint** (`0fac64a..44094ca`): valuation backfill, golden cohort, Wallet
  DNA v2, no-lookahead as-of-T historical replay, decision-first operator dashboard
  (setups / proof / entities / capital / watching).
- **Finish-pipeline sprint** (`a3c4121..ffa3371`): per-token extraction status for
  all 347 runners, real capital chains.
- **Complete-discovery sprint** (`ba3016c..ea592be`): evidence-backed wallet roles,
  entity-adjusted Entity DNA (union-find), operator-root integration.
- **Working-loop milestone** (`a8b95ed..4f5e2fc`): top-PnL discovery, Wallet DNA,
  capital-outflow tiers, receiver enrollment, automatic token-candidate feed.
- **Runner-mining Tasks 1–12**: canonical token universe (10,489 SOLANA mints),
  $10M+ runner cohort (347 `verified_above_10m`), matched controls, early-buyer
  extraction, meaningful-activity classifier, address/entity dormancy,
  funding/reactivation paths, post-entry behavior, repeat/dormant-runner engines.
- **Infra invariants**: test/live DB isolation harness
  (`packages/db/src/testDb.ts` fail-closed + `test/vitestGlobalSetup.ts`), global
  job serialization lock (`packages/db/src/locks/globalJobLock.ts`), structural
  trust-boundary gate (`packages/core/src/wallets/status.ts`).

**Live shadow run (context — NOT part of this handoff folder).** A 7-day forward
shadow run (`runId shadow-20260711105525-9280`) executes in a *separate git
worktree* (`session/flowradar`, branch `feat/pre-public-accumulation`) against a
separate live DB — neither is in this clone. As of the last check this session it
was **recovered and advancing** (collection grew to ~1.28M edges / 10,489 tokens /
249K trades; the worker OOM-cycles roughly every ~75 min but the controller
restarts it) and the **trust invariant HOLDS** (1 `signal_eligible` = baseline,
999 `observation_only`, no auto-promotion). `feat/pre-public-accumulation` is a
**sibling branch**, not this one — do not conflate the two.

---

## 3. Architecture & important files

**Monorepo** (npm workspaces, `apps/*` + `packages/*`). Pure domain logic is
isolated from all I/O.

| Workspace | Path | Purpose |
|---|---|---|
| `@flowradar/core` | `packages/core` | **Pure** domain engine (only runtime dep is Zod, zero I/O): FlowScore + WalletScore, rules A–G, entity clustering, FIFO PnL, window aggregation, profit-rotation matcher, Sankey builder, backtest/shadow evaluators, plain-English feed explanations, and the pure stealth / capital-lineage / runner-mining / dormancy / post-entry engines. |
| `@flowradar/providers` | `packages/providers` | External-data capability layer: capability interfaces, env-driven `getProvider` registry + `getProviderStatuses`, token-bucket rate limiter, live adapters (Helius, DexScreener, BscScan, GoPlus, GMGN, Telegram), and the deterministic `MockWorld`/`MockProvider` that back `MOCK_MODE`. |
| `@flowradar/db` | `packages/db` | Persistence + orchestration: Prisma client singleton (LITE vs FULL + TEST/LIVE isolation), schema/migrations, and every stateful "pass" builder (ingest, flow scoring, signal detection, clustering, money-flow/rotation, backtest/replay, alerts, graph/CSV, Dune overlap, candidate validation, capital-lineage expansion + receiver enrollment, and the whole runner-mining pipeline). |
| `worker` (app) | `apps/worker` | Background job process. Boots dotenv + ensures the LITE embedded Postgres, builds one shared provider world (mock or live registry), then registers ~25 jobs on a scheduler. Runner is `InlineRunner` (LITE) or `BullMqRunner` (FULL/Redis). |
| `web` (app) | `apps/web` | Next.js 15 (React 19, Tailwind 4, Recharts, Cytoscape) dashboard on **port 5188**. Server-component pages read the DB directly. |

**Most important files to read first:**
- `apps/worker/src/index.ts` — the runtime spine; its header is the single best map of the system (boot sequence, LITE-vs-FULL detection, and the authoritative registry of every scheduled/on-demand job with its interval). Jobs include `walletActivity`, `marketDataHot/Normal`, `tokenRiskRefresh`, `flowScoring`, `entityClustering`, `moneyFlow`, `bridgeFlow`, `profitRotation`, `signalDetection`, `alertDispatch`, `backtest`, `walletStats`/`walletDiscovery`, `lineageExpansion`, `monitoringScheduler`, `stealthAccumulation`, `socialIngest`, `externalConfluence`, `walletCandidateValidation`, `tokenTopTraderBackfill`, plus on-demand `walletImport`/`walletGraph`.
- `packages/db/prisma/schema.prisma` — the 60+-model data model (~2,600 lines); every table, enum, index and the `observation_only` / SHADOW-ONLY boundaries.
- `packages/core/src/index.ts` — public surface of the pure engine (fastest index of "what logic exists and where").
- `packages/db/src/index.ts` — public surface of the persistence layer (maps a job name to the function that does the work, e.g. `runSignalDetectionPass`, `runLineageExpansion`, `buildCapitalChains`).
- `packages/core/src/scoring/flowScore.ts` / `walletScore.ts` — the 0–100 composite and the smart-wallet gate.
- `packages/core/src/rules/index.ts` (+ `ruleA.ts..ruleG.ts`) — `evaluateAllRules`.
- `packages/db/src/signals.ts` — `runSignalDetectionPass` (rules → persisted `Signal` rows).
- `packages/db/src/scoring-pass.ts` (+ `fetchAggregateInputs.ts`) — the flow-scoring pass → `TokenFlowSnapshot`.
- `packages/db/src/runnermining/pipeline.ts` — `buildCapitalChains` (staging → deployment → profit rotation; the runner-mining payoff).
- `packages/db/src/runnermining/liveRecovery.ts` — receiver backfill + token-metadata builders (the live-recovery sprint's core).
- `packages/db/src/lineage/runLineageExpansion.ts` (+ `enrollReceiver.ts`, `runMonitoringScheduler.ts`) — the capital-lineage engine.
- `packages/db/src/client.ts` — Prisma singleton + `resolveDatabaseUrl` (LITE default :5439 + fail-closed TEST/LIVE isolation). Read before touching anything DB-connection related.
- `apps/worker/src/runner/index.ts` — `createRunner()` (InlineRunner vs BullMqRunner behind one interface).
- `packages/db/src/seed.ts` — the deterministic mock-world seed (`NOVA/QUIET/SEED/ALPHA→BETA/DUMP/RUGZ` scenarios).
- `apps/web/app/feed/page.tsx` — canonical server-component page reading persisted results.

**Data model highlights** (see `schema.prisma`): `Wallet` (single `WalletStatus`
eligibility gate, default `observation_only`) · `WalletStats`/`WalletClassification`
· `Token`/`TokenMarketSnapshot` · `WalletTokenTrade` (atomic BUY/SELL fact table
with honest valuation) · `TokenFlowSnapshot` (flow-scoring output) · `Signal`/`Alert`
· `EntityCluster` (union-find sybil collapse) · `MoneyFlowEdge`/`ProfitRotationSignal`
· `LineageRoot`/`MonitoringSubscription`/`WalletRelationship` (lineage engine) ·
runner-mining shadow substrate: `TokenLifecycle`, `CohortMatch`, `EarlyBuyerEntry`,
`WalletDnaProfile`/`EntityDnaProfile`, `CapitalOutflowPath`, `ReceiverEnrollment`,
`ReceiverActivityBackfill`, `TokenCandidateScore`, `CapitalChain`, `StealthSnapshot`,
`TokenMetadata`, `TokenTopPnlCandidate`.

---

## 4. Setup & run commands

**Requirements:** **Node ≥ 20 (verified on v24.17.0)**, npm. No Docker required in
LITE mode (the default). First `db:migrate` downloads ~50 MB of embedded-Postgres
binaries. Windows is the reference dev OS (paths in scripts use it), but the stack
is cross-platform.

```bash
# 0. one-time: create your env file (LITE + MOCK defaults are ready to go)
cp .env.example .env

# 1. install
npm install

# 2. bring up the LITE embedded Postgres (port 5439) + apply migrations (idempotent)
npm run db:migrate

# 3. load the deterministic mock world (seed 20260705) — MOCK_MODE only
npm run db:seed

# 4a. run the dashboard  ->  http://localhost:5188
npm run dev

# 4b. run the worker (SEPARATE terminal)
npm run worker
```

- Web port **5188** is hard-coded in `apps/web/package.json` (`next dev -p 5188`);
  `WEB_PORT` in `.env.example` is documentation/deep-links only.
- **Ordering matters:** `install → db:migrate` (this is what first starts the
  embedded cluster + creates the schema) `→ db:seed → dev/worker`.
- **LITE vs FULL** is auto-detected (`scripts/db-local.ts` `isFullMode()`): FULL
  when `REDIS_URL` is set OR `DATABASE_URL` port is 5432; else LITE (embedded PG
  :5439). FULL alternative: `docker compose up -d` (postgres:16 on 5432 + redis:7),
  then set `REDIS_URL` + a `:5432` `DATABASE_URL` and run `db:migrate`/`db:seed`.
- `.claude/launch.json` presets: `flowradar-web` → `npm run dev` (:5188);
  `flowradar-web-pilot` → `npx next dev -p 5190` (cwd `apps/web`, `MOCK_MODE=false`,
  `DATABASE_URL=...5439/flowradar_pilot?connection_limit=20&pool_timeout=30`).

**Database commands:**
```bash
npm run db:migrate                            # prisma migrate deploy (idempotent)
npm run db:migrate:new -- --name your_change  # author a NEW migration (needs the `--`)
npm run db:seed                               # wipe + reseed the mock world (rerunnable)
npm run db:studio                             # prisma studio
npm run generate -w packages/db               # prisma generate (no root alias)
npm run backtest:replay                       # tsx src/scripts/runReplay.ts
npm run lineage:import-roots                  # tsx scripts/import-root-wallets.ts
npx tsx scripts/db-local.ts stop              # stop the LITE embedded cluster
# There is NO db:reset. Full reset: db-local stop -> delete ./.pgdata -> db:migrate -> db:seed
```

---

## 5. Tests & build commands

```bash
npm run test        # root: `vitest run` — all 5 projects (core, db, providers, web, worker)
npm run typecheck   # `tsc -b apps/worker packages/core packages/db packages/providers` + `tsc --noEmit` in apps/web
npm run build       # `next build` (apps/web)
npm run verify      # typecheck + test + build (the full gate)

# focused runs (Vitest 4 syntax):
npx vitest run --project db                          # or core | providers | web | worker
npx vitest run packages/db/test/backtest.test.ts     # by file
npx vitest run -t "substring of test name"           # by name
npx vitest                                           # watch mode
```

**Testing gotchas (read before running the suite):**
- **The full suite needs the DB up.** `packages/db` integration tests self-skip
  when Postgres is unreachable on :5439, so `npm run test` on a fresh checkout
  *before* `npm run db:migrate` silently skips them and still exits 0. Run
  `npm run db:migrate` first for the complete suite (~1650 tests; one opt-in
  `LIVE_SMOKE` DexScreener test stays skipped).
- Vitest uses per-project config on the root `vitest.config.ts` (`test.projects`);
  the **`db`** project runs `fileParallelism:false`, `testTimeout:20000` against
  one shared embedded cluster (default concurrency causes P2002 races / pool
  timeouts). DB tests import the shared `prisma` from `../src/client`, add **no**
  new `PrismaClient`, and `$disconnect` only in `afterAll`.
- `globalSetup` (`test/vitestGlobalSetup.ts`) provisions a **separate
  `flowradar_test` database** and migrate-deploys it before any project runs;
  test-DB URL resolution is **fail-closed** under `VITEST`.
- `verify` (and the historical-replay test) should run against a **clean/rebuilt
  DB** — soak-scale residue can trigger a Prisma pool timeout (P2024); this is a
  test-harness/DB-size interaction, not a shipped-code regression.

---

## 6. Unfinished tasks & known bugs

### Unfinished / blocked
- **Token-metadata resolution is quota-blocked.** Last run: 683 considered, **0
  resolved, all 683 retryable** (Helius/Birdeye rate-limit/quota). Never
  fabricated — re-run when quota resets (`data/runner-mining/live-recovery-report.json`).
- **Receiver deployment chains remain 0/151.** 77 `retryable_provider_failure`
  (un-polled), 63 `partial_coverage` (absence not provable), 11
  `covered_no_post_receipt_buy`. Needs polling budget + priced post-receipt trade
  data. (The 2 profit **rotations** are the only proven capital→next-token links.)
- **Birdeye `top_traders` quota-blocked across all 347 runners** (each call
  persisted as `retryable provider_error`); the GMGN top-trader path is an honest
  stub.
- **Early-buyer in-band entries = 0 and verified-NON-runners = 0** — needs a
  historical first-buyer *transaction* backfill (Birdeye token-trades pagination or
  Helius historical) + `tokenCreatedAt` launch-anchoring; cannot be fabricated.
- **Task 0 (TokenFlowSnapshot storage bound) is implemented but NOT deployed to the
  live shadow run** — the live worker still writes at the old ~639 rows/min
  (~920 k rows/day). Deploy at the next controller-approved resume
  (stop → pull/merge → resume), same procedure as the risk-cache rollout.
- **`winRate`/EV are honestly NULL across the pilot** — all positions carry
  unpriced legs on the frozen copy; needs live-ingest valuations or a historical
  valuation backfill.
- **GMGN wallet-behavior classifier** blocked on GMGN auth (no verified public
  API; ships as a query-only typed stub).
- **Social live adapters (Telegram/Discord)**, **BSC price/liquidity providers**,
  and **Solana risk parse** are config-gated typed stubs (see TODOs below).
- **Bridge correlation + profit rotation** code is done but live-unexercised.

### Known bugs / documented limitations
- **Local ATH-mcap inflation on large-supply mints:** of 347 `verified_above_10m`
  runners, ~37 have implausible ATH (27 in $10B–$1T, 10 ≥$1T). `verified_above_10m`
  only means "local observations recorded ≥ $10M"; same-basis inflation is
  invisible to the cross-provider conflict detector until Birdeye enrichment
  succeeds (currently quota-blocked). *(`packages/db/src/runnermining/enrich.ts` +
  universe classification.)*
- **Live worker RSS grows in a ~3 GB sawtooth** and `TokenFlowSnapshot` grows
  unbounded on the live instance until Task 0 is deployed (operator-carried flag).
- **Overlap query-id placeholder duplication** (harmless today):
  `apps/web/components/overlap/OverlapFinder.tsx:236` hardcodes
  `'overlap_finder_ad_hoc'`, duplicating `duneOverlap.ts`'s
  `DEFAULT_QUERY_ID_PLACEHOLDER` instead of threading a real per-search queryId.

### Code TODO markers (all "honest stub" boundaries, not silent gaps)
- `packages/providers/src/solana/risk.ts:16` (`:89,:99`) — Solana token risk
  (mint/freeze authority) returns stub values.
- `packages/providers/src/social/telegram.ts:11` / `social/discord.ts:7` — inbound
  read stubs (`fetchPosts` returns `[]`).
- `packages/providers/src/bsc/stubs.ts` — BSC price/liquidity via Birdeye/Moralis/
  Bitquery (all typed stubs).
- `packages/providers/src/market/dexscreener.ts` — rate-limit not doc-confirmed
  verbatim.
- `packages/providers/src/candidates/{cielo,gmgnStub,kolscanStub}.ts` — no verified
  public API; return no candidates.
- `packages/providers/src/confluence/{holderscan,gmgn,clobr}.ts` — no confirmed
  public API; **absence is never treated as a "safe" signal**.
- `packages/providers/src/registryData/{solana,bsc}.ts` — operator TODO to add
  more exchange hot-wallet addresses.

---

## 7. Important technical decisions

1. **npm-workspaces monorepo** (`apps/*` + `packages/*`), no turbo/pnpm/nx; root
   scripts delegate via `-w`. TS project references wire `apps/worker` +
   `packages/{core,db,providers}`; `apps/web` typechecks separately (Next has its
   own tsc).
2. **Stack:** Next.js 15 App Router + React 19 + Tailwind 4 + shadcn/ui + Prisma/
   PostgreSQL + Vitest, strict TypeScript. Cytoscape.js for the wallet graph
   (React Flow rejected for 1k+ node hairballs); Recharts (incl. Sankey); Zod v4;
   raw Telegram Bot API via `fetch`; **tsx** as the worker/script runtime.
3. **`moduleResolution: "bundler"` (NOT `nodenext`)** — every consumer is a
   bundler toolchain (Next webpack/turbopack, Vitest/esbuild, tsx/esbuild).
   `nodenext` would force `.js` extensions on every relative import. **Do not
   "fix" this back.** (`apps/web` target is bumped to ES2020 for typecheck because
   it transitively imports BigInt-using provider code — also intentional.)
4. **Two infra modes, identical app code — LITE (default) vs FULL.** LITE = real
   embedded PostgreSQL 16 (`embedded-postgres`, `./.pgdata`, port 5439) +
   in-process `InlineRunner`; FULL = `docker-compose.yml` (pg:16 :5432 + redis:7) +
   `BullMqRunner`. Chosen because Docker is not installed on the dev box. Alert
   cooldowns are DB-based so both modes behave identically.
5. **Single `MOCK_MODE=true` switch** drives a deterministic in-memory mock world
   for every provider capability; workers ingest the mock through the *exact same*
   pipeline as live. Missing keys degrade honestly (`missing_key`/`stub`), never
   crash a worker loop.
6. **Structural trust boundary:** `packages/core` contains **zero** Prisma
   references and can read no table. "Candidates never influence signals" is an
   *architecture property*, not caller discipline.
7. **`Wallet.status` is THE single signal-eligibility gate.** `observation_only`
   is the default; `signal_eligible` is earned only by operator CSV import,
   candidate-validation promotion, or explicit operator action. Enforced in
   `packages/core/src/window/aggregate.ts` (`isSmart = isSignalEligibleStatus(status) && ...`).
   Runner-mined wallets also enter `observation_only` — no auto-promotion.
8. **Candidate → validate → promote pipeline.** A source's self-claimed PnL is
   never trusted; external feeders write `CandidateWallet` rows only, promoted
   only after validation (thresholds pnl_30d ≥ $4000, trades ≥ 8, winRate ≥ 35%,
   realized ≥ $1000 where available; reject routers/pools/CEX/bridges/bots).
   Stats-trust taxonomy: `provider_claimed` < `operator_approved` < `locally_verified`.
9. **Dune credit-safety.** Serve latest cached result by default; a fresh billable
   `/execute` is only attempted when `DUNE_EXECUTE_FRESH === 'true'` — a global
   kill switch that **per-call flags cannot bypass**.
10. **Honest valuation.** An unknown price is never numeric 0; "unavailable" is
    never "safe"; current price never masquerades as historical; a future snapshot
    never values a past transfer. `ValuationStatus` is an explicit enum; asset
    classification is by mint **address** (verified registry), never symbol text.
11. **Live-recovery absence proof** (this branch's headline correctness work).
    A NEGATIVE (`covered_no_post_receipt_buy`) is asserted only when **(a)** every
    configured activity source read completed **and (b)** a clean poll provably
    finished *after* the receipt (`cleanPollWatermark > firstReceiptTs`, where the
    watermark is the newest `lastPolledAt` of a `MonitoringSubscription` with
    `consecutiveErrors===0`). A found BUY (positive) survives partial failure;
    `backfillEnd` is capped to the watermark; any source failure → `retryable`,
    never a false negative. A **mint-prefix is never shown as a symbol or name** —
    a differing name or a logo can't launder a mint prefix onto the screen (see
    `packages/db/src/runnermining/liveRecovery.ts` + `apps/web/lib/tokenIdentity.ts`;
    `LIVE_RECOVERY_ENGINE_VERSION` is bumped on classifier-semantic changes so
    resume re-derives previously-terminal rows).
12. **Supervised, resumable, orphan-safe shadow-run controller**
    (`scripts/shadow-run-controller.ts`): runs the real worker at normal cadence
    (`WORKER_FAST` must never be used with live providers — it floods Helius),
    single-owner `runId|pid` lock that fails closed, verified graceful-then-forced
    kills, and a **trust invariant = sha256 of the sorted `signal_eligible`
    wallet-id membership** re-checked each 15-min heartbeat.
13. **"Production-ready" = robust local single-user app.** Mutation routes are
    unauthenticated by design (localhost-bound); secrets are handled strongly to
    compensate (`ExternalWalletSource` stores the env-var *name*, never the value;
    no `NEXT_PUBLIC_` vars; `.env` git-ignored).
14. **Known, deliberate MVP trade-off:** `scoring-pass.ts` fetches token risk
    once per token serially inside the scoring loop (fine under mock / small live
    sets; a bottleneck at scale — a production build would move it to a cached
    refresh job).

---

## 8. Required environment variables (names only)

No secret values are included anywhere in this handoff. `.env.example` is the
canonical template (copy it to `.env`). **In LITE + mock mode you need none of the
provider keys** — the defaults run the full mock world offline.

**Core / infra**
| Name | Req? | Purpose |
|---|---|---|
| `DATABASE_URL` | Required | Postgres connection string. LITE default embedded-PG :5439; FULL uses :5432. |
| `MOCK_MODE` | Optional (default true) | `!= 'false'` ⇒ deterministic mock world; `false` ⇒ live APIs. |
| `REDIS_URL` | Optional | Empty ⇒ LITE (in-process runner); set ⇒ FULL (BullMQ). |
| `WEB_PORT` | Optional | Dashboard port + alert deep-links (fallback 5188). |
| `TEST_DATABASE_URL` | Optional | Test-DB override, honored only under `VITEST` and only if it ends in `_test`. |
| `VITEST` | Auto | Set by the Vitest runtime; forks DB resolution to the isolated test DB. |

**Provider keys (all optional; missing ⇒ honest skip/stub, never a crash)**
| Name | Purpose |
|---|---|
| `HELIUS_API_KEY` | Solana wallet activity + risk (required for live Solana). |
| `HELIUS_RPS` | Helius Enhanced-Tx rate (req/s); default 9; set 1–2 for free-tier keys. |
| `BIRDEYE_API_KEY` | Solana/BSC market data + wallet-PnL/top-trader candidate feeds. |
| `BSCSCAN_API_KEY` | BSC activity (Etherscan-V2, chainid=56; required for live BSC). |
| `GOPLUS_API_KEY` | BSC token risk; works keyless at free tier (a key only raises limits). |
| `MORALIS_API_KEY`, `BITQUERY_API_KEY` | Reserved BSC adapter stubs. |
| `SOLANA_TRACKER_API_KEY` | Primary Solana PnL-leaderboard candidate feeder. |
| `KOLSCAN_API_KEY`, `KOLSCAN_API_BASE` | KOLScan feeder (typed stub — no verified public API). |
| `GMGN_API_KEY`, `GMGN_API_BASE` | GMGN feeder/confluence (typed stub — no verified public API). |
| `CIELO_API_KEY` | PnL-tracker feeder (typed stub). |
| `HOLDERSCAN_API_KEY` | Shadow-only holder-risk confluence (stub; unavailable ≠ safe). |
| `CLOBR_API_KEY` | Shadow-only liquidity-map confluence (stub). |

**Alerts / social**
| Name | Purpose |
|---|---|
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Send alerts via the raw Bot API (required to actually send). |
| `DISCORD_WEBHOOK_URL` | Reserved (deferred stub, no active consumer). |
| `SOCIAL_TELEGRAM_READ_TOKEN`, `SOCIAL_DISCORD_BOT_TOKEN` | Social-ingest source tokens (NOT in `.env.example`; env-name resolved dynamically). |

**Dune (credit-safety)**
| Name | Purpose |
|---|---|
| `DUNE_API_KEY` | Saved-query execution (overlap / top-trader backfill). |
| `DUNE_DEFAULT_OVERLAP_QUERY_ID` | Default saved-query ID for the Overlap Finder. |
| `DUNE_USE_LATEST_RESULT` | Serve cached result (default `true`). |
| `DUNE_EXECUTE_FRESH` | Allow fresh billable execution — **default `false`; keep it off**. |

**Worker / pilot / script knobs (mostly NOT in `.env.example`; inherited at runtime)**
`WALLET_ACTIVITY_MAX_PAGES` (default 5) · `WALLET_ACTIVITY_MAX_WALLETS` (default 200) ·
`WORKER_FAST` (`'1'` = accelerated cadence; **mock-only**) · `SEED_WIPE_LINEAGE`
(destructive seed guard) · `LINEAGE_IMPORT_MAX_ROOTS` · `LINEAGE_REOPEN` ·
`TOPPNL_REQUEST_BUDGET` · `REPLAY_FROM` / `REPLAY_TO` · `CONFLUENCE_BASE_REF` ·
`LIVE_SMOKE` (enables the DexScreener live network test) · `APPDATA` (Windows
OS-provided; used to resolve a provider allowlist path).

> Two names that appear in docs but have **no code consumer** today (documented so
> you don't hunt for them): `HELIUS_RISK_RPS` (referenced only in a docs file) and
> `NODE_OPTIONS` (external/inherited only).

---

## 9. Exact next recommended step

**First — establish a working local baseline (offline, no keys):**
```bash
cp .env.example .env
npm install
npm run db:migrate      # starts embedded PG :5439, applies migrations
npm run db:seed         # loads the mock world
npm run test            # expect ~1650 passed / 1 skipped
npm run dev             # dashboard at http://localhost:5188  (+ `npm run worker` in another terminal)
```
This confirms the toolchain (Node ≥ 20, embedded Postgres, Vitest) works end-to-end
before you touch anything substantive.

**Then — the single highest-value substantive step:** unblock provider-gated
resolution. The one dependency gating the most downstream product truth is
**Birdeye/Helius quota**. With a fresh key (or after a quota reset), re-run the
bounded live-recovery backfill against the pilot DB and recompute the candidate/
chain layers:
```bash
# against a frozen real copy only — the pilot script hard-refuses any other DB
DATABASE_URL='postgresql://flowradar:flowradar@localhost:5439/flowradar_pilot' \
MOCK_MODE=false HELIUS_API_KEY=<key> BIRDEYE_API_KEY=<key> \
  npx tsx scripts/live-recovery-pilot.mts
```
A successful pass resolves the 683 `retryable` token-metadata rows, fills the 347
runners' `top_traders`, and enables the cross-provider check that would catch the
~37 inflated-ATH mints — all currently blocked purely on quota, none fabricated.

**Operational follow-ups (do not do these blindly):**
- Decide **PR #6** (`feat/runner-dormant-behavior` → `main`): review, then merge or
  keep as the working branch.
- Deploy **Task 0** (TokenFlowSnapshot storage bound) to the live shadow run via
  the controller-approved resume (`stop → pull/merge → resume`) to stop the
  unbounded ~920 k rows/day growth. The live run is in a *separate* worktree/DB,
  not this folder — treat it as production.

---

### Appendix — orientation docs already in this repo
`README.md` (operator guide) · `docs/POST_MVP_AUDIT.md` (invariants audit) ·
`docs/CURRENT_STATE_RECONCILIATION.md` (authoritative capability matrix) ·
`docs/RUNNER_MINING_DESIGN.md` + `docs/RUNNER_DORMANT_BEHAVIOR_PLAN.md` (subsystem
design) · `docs/RUNNER_DORMANT_BEHAVIOR_FINAL_REPORT.md` (latest sprint report) ·
`docs/superpowers/specs/2026-07-05-flowradar-design.md` (original spec).
