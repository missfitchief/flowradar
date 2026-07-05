# FlowRadar MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the FlowRadar Solana+BSC wallet-intelligence dashboard + worker bot to the Module-16 Done Bar, mock-first, LITE-mode-verified on this machine, per the approved spec at `docs/superpowers/specs/2026-07-05-flowradar-design.md` (the **Spec** — normative for all data shapes, thresholds, and page contents).

**Architecture:** npm-workspaces monorepo — `apps/web` (Next.js 15, port 5188), `apps/worker` (job functions on a `JobRunner` abstraction), `packages/core` (pure logic, unit-tested), `packages/db` (Prisma + ingest), `packages/providers` (interfaces + deterministic mock world + live adapters). Dual infra: FULL (docker compose pg+redis+BullMQ) / LITE default (embedded-postgres + InlineRunner). Mock world is ingested through the same pipeline live data will use.

**Tech Stack:** TypeScript strict everywhere, Next.js 15 / React 19 / Tailwind 4 / shadcn/ui, Prisma 6 + PostgreSQL 16, BullMQ 5 + ioredis (FULL only), `embedded-postgres` (LITE), Zod 4, Vitest 3, Recharts (incl. Sankey), Cytoscape.js, papaparse, tsx.

## Global Constraints

- Node ≥ 20 (box has 24.17). npm workspaces; all documented commands are `npm run …` per Spec §13.
- Web port **5188**. `MOCK_MODE=true` default. Empty `REDIS_URL` ⇒ LITE mode.
- Money precision per Spec §4: USD `Decimal(20,4)`, token `Decimal(38,18)`, price `Decimal(24,12)`, block/slot `BigInt`.
- Probabilistic language contract (Spec §1): UI/alert copy uses `weak/possible/probable/strong link`, never "same person confirmed". Footer: "Analytics only — not financial advice."
- All thresholds come from the Settings singleton (Zod-validated, defaults = Spec §6 table). No magic numbers in rules.
- Every pure-logic module lands with Vitest tests **written first** (TDD). UI tasks land with build + preview verification.
- Commit after every task (conventional commits, `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`).
- Live endpoints: fetch official docs before implementing; unverifiable ⇒ typed stub + `TODO(provider)` comment + README note. Never hallucinate endpoints. Missing API key ⇒ provider reports `status: "missing_key"`, system continues on mock.
- Branch: `feat/mvp` off `main`; merge to `main` at final gate.

## File Structure (target)

```
flowradar/
  package.json  tsconfig.base.json  docker-compose.yml  .env.example  README.md  vitest.config.ts (test.projects — Vitest 4 API)
  scripts/db-local.ts                  # embedded-postgres lifecycle (LITE)
  apps/web/                            # Next.js: app/(pages), app/api/(routes), components/, lib/
  apps/worker/src/index.ts             # runner bootstrap + job registry
  apps/worker/src/jobs/*.ts            # one file per job (15 jobs, Spec §7)
  packages/core/src/
    types.ts        settings.ts        # domain types/enums; Zod SettingsSchema + DEFAULT_SETTINGS
    scoring/{walletScore,flowScore}.ts
    pnl/fifo.ts                        # FIFO ledger, realized/unrealized, confidence
    rules/{types,ruleA..ruleG,index}.ts
    cluster/{linkConfidence,unionFind,clusterer}.ts
    graph/{bfs,paths}.ts
    rotation/matcher.ts
    backtest/evaluate.ts
    alerts/{templates,cooldown}.ts
    window/aggregate.ts                # trades[] -> 30min/24h TokenWindowAggregate
  packages/db/prisma/schema.prisma     # 22 models per Spec §4
  packages/db/src/{client,ingest,seed}.ts
  packages/providers/src/
    types.ts  registry.ts  rateLimiter.ts
    mock/{world,scenarios,provider}.ts
    solana/{helius,dexscreener,risk}.ts
    bsc/{bscscan,goplus,stubs}.ts
  packages/{core,db,providers}/test/*.test.ts
```

## Shared Contracts (normative for every task)

```ts
// packages/core/src/types.ts (excerpts — full enums mirror Spec §4)
export type Chain = 'SOLANA' | 'BSC';
export type TradeAction = 'BUY'|'SELL'|'TRANSFER_IN'|'TRANSFER_OUT'|'LP_ADD'|'LP_REMOVE';
export type LegKind = 'native_transfer'|'token_transfer'|'swap_leg'|'lp_add'|'lp_remove'|'bridge_deposit'|'bridge_withdrawal'|'contract_interaction';
export interface TxLeg { kind: LegKind; from: string; to: string; asset: { address?: string; symbol: string; decimals: number }; amountToken: string; amountUsd?: number; programOrContract?: string; }
export interface NormalizedTx { txHash: string; blockOrSlot: bigint; ts: Date; legs: TxLeg[]; }
export interface TokenMarket { priceUsd: number; marketCapUsd: number|null; fdvUsd: number|null; liquidityUsd: number|null; vol5m: number; vol1h: number; vol6h: number; vol24h: number; holderCount: number|null; pairAddress?: string; dex?: string; }
export interface RiskReport { flags: { id: string; label: string; severity: 'info'|'warn'|'danger' }[]; penalty: number /* 0..1 */; }

// window/aggregate.ts
export interface TokenWindowAggregate {
  tokenId: string; windowMinutes: 30|1440; from: Date; to: Date;
  buyers: { walletId: string; walletScore: number; labels: string[]; buyUsd: number; sellUsd: number; firstBuyTs: Date; blockOrSlot: bigint; entityClusterId?: string }[];
  trackedBuyVolumeUsd: number; trackedSellVolumeUsd: number; netFlowUsd: number; buySellRatio: number;
  smartWalletCount: number; humanLikeCount: number; possibleBotCount: number; whaleBuys: { walletId: string; usd: number }[];
  uniqueEntityCount: number; largestClusterSize: number;
  avgEntryMcap: number|null; currentMcap: number|null; mcapExpansionFromAvgEntry: number|null;
  liquidityUsd: number|null; liquidityChangePct: number|null; tokenAgeDays: number|null; inflowSpike: boolean;
  exitedSmartPct: number; topHolderExits: number; newSmartBuyers: number;
}
export function aggregateWindow(input: { trades: TradeRow[]; wallets: WalletInfo[]; clusters: ClusterMembership[]; market: MarketPoint[]; windowMinutes: 30|1440; now: Date }): TokenWindowAggregate;

// rules/types.ts
export interface RuleResult { rule: 'A'|'B'|'C'|'D'|'E'|'F'|'G'; fired: boolean; severity: 'INFO'|'WATCH'|'HIGH'|'CRITICAL'; reasons: string[]; metrics: Record<string, number|string|boolean>; }
export type Rule = (agg: TokenWindowAggregate, settings: Settings, extra?: RuleExtras) => RuleResult;
// RuleExtras carries fundingEvents (rule E) and rotationCandidates (rule F) — see Tasks 14, 23.

// scoring
export function computeWalletScore(s: WalletStatsInput): { score: number; components: Record<string, number> };
export function computeFlowScore(agg: TokenWindowAggregate, risk: RiskReport, settings: Settings): { score: number; components: Record<string, number> };

// cluster
export function calculateWalletLinkConfidence(evidence: LinkEvidence): number; // 0..100, weights = Spec §6 verbatim
export interface LinkEvidence { directTransfer: boolean; repeatedDirectTransfers: boolean; sameFundingSource: boolean; sameGasFunder: boolean; bridgeAmountTimeMatch: boolean; amountSimilarityAbove90: boolean; destBuysNewTokenWithin60m: boolean; freshWalletActivated: boolean; sameTokenRotation: boolean; repeatedCrossLaunchPattern: boolean; cexOrMixerInterruption: boolean; routerOnlyInteraction: boolean; weakAmountMatch: boolean; dustOnlyInteraction: boolean; }

// graph/bfs.ts
export interface GraphSearchParams { rootAddress: string; chain: Chain; mode: 'DIRECT'|'CAPITAL_FLOW'|'ENTITY_DISCOVERY'|'FULL_RAW'; maxDepth: number; minTransferUsd: number; timeRange?: { from?: Date; to?: Date }; includeNative: boolean; includeToken: boolean; includeSwaps: boolean; includeBridges: boolean; includeCex: boolean; excludeRoutersPoolsContracts: boolean; maxNodes: number; maxEdges: number; }
export interface EdgeFetcher { (address: string, chain: Chain, params: GraphSearchParams): Promise<RawGraphEdge[]>; }
export function runBfs(params: GraphSearchParams, fetchEdges: EdgeFetcher, registry: RegistryLookup): Promise<{ nodes: GraphNode[]; edges: GraphEdge[]; truncated: boolean }>;

// providers/types.ts — capabilities per Spec §5, plus:
export interface ProviderStatus { name: string; chain: Chain; capability: string; mode: 'live'|'mock'|'missing_key'|'stub'; note?: string; }
export interface JobRunner { schedule(name: string, intervalMs: number, fn: () => Promise<void>): void; enqueue(name: string, payload: unknown): Promise<string>; process(name: string, fn: (payload: unknown) => Promise<void>): void; start(): Promise<void>; stop(): Promise<void>; }
```

`packages/core/src/settings.ts` defines `SettingsSchema` (Zod) with **every** default from Spec §6/§7 tables (rule thresholds incl. ruleA `{watchMinWallets:10, minWallets:20, windowMin:30, minBuyVolumeUsd:25000, maxSoldPct:30, mcapMin:100_000, mcapMax:5_000_000, minLiquidityUsd:20_000, maxTokenAgeDays:7, inflowSpikeMult:3}` — Rule A is TIERED per scope correction 2026-07-05: ≥watchMinWallets watched/profitable buyers ⇒ WATCH, ≥minWallets + all volume/flow/mcap/liq conditions ⇒ HIGH, …, `entityConfidenceThreshold:61`, `alertCooldownMin:30`, all job intervals, graph defaults `{maxDepth:3, minTransferUsd:100, maxNodes:5000, maxEdges:25000, perNodeTxCap:500}`, profitable-wallet thresholds `{pnl30d:4000, minTrades:8, minWinRate:0.35, minRealized:1000}`).

---

# Wave 1 — Foundation, Schema, Mock World, Core Pages (Spec Phases 1–2)

### Task 1: Monorepo scaffold

**Files:** Create root `package.json` (workspaces `apps/*`,`packages/*`; scripts: `dev`→`npm -w apps/web run dev`, `worker`→`npm -w apps/worker run dev`, `db:migrate`, `db:seed`, `db:studio`, `test`→`vitest run`, `typecheck` (tsc -b all), `build`→`npm -w apps/web run build`, `verify`→`typecheck && test && build`), `tsconfig.base.json` (strict, NodeNext), `vitest.config.ts (test.projects — Vitest 4 API)`, `docker-compose.yml` (postgres:16 on 5432 + redis:7 on 6379, volumes), `.env.example` (all vars Spec §13 with comments), README skeleton, workspace `package.json`+`tsconfig.json` for all 5 workspaces with placeholder `src/index.ts`.

- [ ] Write all files; `npm install` at root — expect clean resolve, zero vulnerabilities blocking.
- [ ] `npm run typecheck` — expect pass (placeholders).
- [ ] Commit `chore: monorepo scaffold (workspaces, compose, env, scripts)`.

### Task 2: Prisma schema + LITE database lifecycle

**Files:** Create `packages/db/prisma/schema.prisma` (**all 22 models, every field/index/enum exactly per Spec §4** — Spec is normative; no field renames), `packages/db/src/client.ts` (singleton PrismaClient), `scripts/db-local.ts` (embedded-postgres: start PG16 in `./.pgdata` if `FLOWRADAR_LITE` resolves true — i.e. `REDIS_URL` empty — idempotent port 5439, writes effective `DATABASE_URL` for child commands), wire `db:migrate` = `tsx scripts/db-local.ts ensure && prisma migrate dev`, `db:seed` similarly.

**Interfaces:** Produces `prisma` client consumed by every later task; `DATABASE_URL` default `postgresql://flowradar:flowradar@localhost:5439/flowradar` (LITE) / `:5432` (FULL).

- [ ] Write schema (22 models) + db-local helper.
- [ ] Run `npm run db:migrate` — expect embedded PG downloads, starts, migration `init` applied. **If embedded-postgres fails after 2 fix attempts:** per approval constraint #5, document Docker path in README, set tests to schema-validate only, and continue (do not block).
- [ ] `npx prisma validate` — expect valid.
- [ ] Commit `feat(db): full prisma schema (22 models) + LITE embedded-postgres lifecycle`.

### Task 3: Core types, Settings schema, WalletScore + FlowScore (TDD)

**Files:** Create `packages/core/src/{types,settings}.ts`, `scoring/{walletScore,flowScore}.ts`; Test `packages/core/test/{settings,walletScore,flowScore}.test.ts`.

**Interfaces:** Produces Shared Contracts types + `DEFAULT_SETTINGS`; `computeWalletScore`, `computeFlowScore` signatures above.

- [ ] Write failing tests first. Required cases — settings: defaults parse, partial override merges, bad value rejects. walletScore: weights sum to 100 (pnl 25/winRate 15/tradeCount 10/human 15/entryQuality 10/holding 10/recentPerf 15), botPenalty caps at −30, confidence multiplier 0.5–1.0, clamp 0–100, e.g.
  ```ts
  expect(computeWalletScore({ pnl30d: 20000, winRate: 0.7, tradeCount: 40, humanLikelihood: 0.9, entryQuality: 0.8, holdingQuality: 0.7, recentPerf: 0.8, botLikelihood: 0, pnlConfidence: 90 }).score).toBeGreaterThan(75);
  ```
  flowScore: component weights per Spec §6 (20/15/15/15/10/10/10/5), curves `min(n/40,1)`, `min(entities/25,1)`, `clamp(net/50000,0,1)`, expansion `1−min(exp/2,1)`; zero-activity token → score < 5; $NOVA-like aggregate → score ≥ 70.
- [ ] `npm run test -w packages/core` — expect FAIL (not implemented).
- [ ] Implement; run tests — expect PASS.
- [ ] Commit `feat(core): domain types, settings schema, wallet+flow scoring (TDD)`.

### Task 4: Provider layer + deterministic mock world

**Files:** Create `packages/providers/src/{types,registry,rateLimiter}.ts`, `mock/{world,scenarios,provider}.ts`; Test `packages/providers/test/{world,provider}.test.ts`.

**Interfaces:** Produces all Spec §5 capability interfaces; `createMockWorld(seed: number, genesis: Date): MockWorld`; `MockProvider` implementing every capability from the world; `getProvider(chain, capability)` env-driven (MOCK_MODE ⇒ mock); `getProviderStatuses(): ProviderStatus[]`.

Scenario invariants (tests assert these; mulberry32 PRNG, seed 20260705):
| Scenario | Invariant |
|---|---|
| `$NOVA` | ≥35 distinct smart-wallet buyers inside one 25-min span; 1 whale buy ≥ $12k; ≥70% buyers human_like/smart_money; contains 18-wallet single-funder cluster; mcap in $100k–$5M; liq ≥ $20k |
| `$QUIET` | buyers grow 22→≥44 across 36h; mcap expansion ≤ 1.8× |
| `$SEED` | watched wallet funds 3 fresh wallets (0 prior txs); each buys $SEED 15–40 min later; buy = 50–90% of funded amount |
| `$ALPHA→$BETA` | wallet exits $ALPHA with profit; bridge_deposit (Wormhole label) SOL side + bridge_withdrawal BSC side, amounts within 95–100%, gap < 60 min; BSC wallet buys $BETA < 45 min after receipt |
| `$DUMP` | ≥40% of its smart buyers sell ≥80% of position in final 6h; liquidity −35% |
| `$RUGZ` | riskFlags: mint authority active, top holder 60% |
| graph demo | root `FLOWDEEMO…` has 3-depth web incl. 1 CEX + 1 router node and value chain A→B→C (10k→9.8k USDC) |
World: ~160 wallets (labels mixed incl. 12 bots/6 snipers/4 cex-related), ~28 tokens, 72h history, plus background noise trades.

- [ ] Failing tests: same seed ⇒ identical world hash; each invariant above as an assertion; rate limiter: 5 rps bucket delays 6th call.
- [ ] Implement world+scenarios+provider+registry+limiter; tests PASS.
- [ ] Commit `feat(providers): interfaces, registry, rate limiter, deterministic mock world (7 scenarios)`.

### Task 5: Ingest pipeline + JobRunner + worker bootstrap

**Files:** Create `packages/db/src/ingest.ts` (`ingestNormalizedTxs(prisma, chain, txs)` → upsert Wallet/Token/WalletTokenTrade/MoneyFlowEdge rows with dedupe key unique(chain,txHash,walletId,tokenId,action); `snapshotMarket(prisma, tokenId, market)`), `apps/worker/src/runner/{inline,bullmq,index}.ts` (JobRunner contract; InlineRunner = setInterval + per-name serial queue; BullMqRunner = queues+schedulers, only constructed when REDIS_URL set), `apps/worker/src/jobs/{walletActivity,marketDataHot,marketDataNormal,flowScoring}.ts`, `apps/worker/src/index.ts` (registry: register jobs with Settings intervals; graceful SIGINT). Test `packages/db/test/ingest.test.ts` (dedupe: same tx ingested twice ⇒ 1 row) — runs against LITE PG if available, else skipped with notice.

**Interfaces:** Consumes MockProvider + prisma. Produces `ingestNormalizedTxs`, `snapshotMarket`, runner + 4 registered jobs; `flowScoring` job = aggregateWindow + computeFlowScore → TokenFlowSnapshot rows.

- [ ] Implement + tests; `npm run worker` runs, logs one full cycle in mock mode, Ctrl-C clean.
- [ ] Commit `feat(worker): job runner (inline+bullmq), ingest pipeline, first 4 jobs`.

### Task 6: Seed script

**Files:** Create `packages/db/src/seed.ts`: bootstrap Chains, Settings(DEFAULT_SETTINGS), AddressRegistry (mock-world CEX/router/bridge addresses), CSV fixture import (`packages/db/fixtures/wallets.csv`, 40 rows, columns per Spec Module 1) → then one synchronous pass: mock world → ingest all 72h → market snapshots (hourly) → aggregate+flowScore all tokens → TokenFlowSnapshots. (Signals arrive in Wave 2 seed extension.)

- [ ] `npm run db:seed` — expect summary log: `wallets: ~200, tokens: 28, trades: >4000, snapshots: >600, flowSnapshots: 28`.
- [ ] Spot-check via `npx prisma studio` or a query script: $NOVA flowScore ≥ 70, $RUGZ risk flags present.
- [ ] Commit `feat(db): seed — bootstrap + full mock-world ingest + flow scores`.

### Task 7: Next.js app scaffold + navigation

**Files:** Create `apps/web` — Next 15 App Router, Tailwind 4, shadcn/ui init (dark default), `app/layout.tsx` (sidebar nav: Overview, Tokens, Wallets, Money Flow, Wallet Graph, Alerts, Settings; footer disclaimer line per Global Constraints), `lib/db.ts` (re-export prisma), `lib/format.ts` (usd/pct/age/address-shorten helpers), placeholder pages for all 7 routes. Port 5188 in dev script.

- [ ] `npm run dev` → `http://localhost:5188` renders shell, dark, all nav links live. Verify via preview snapshot.
- [ ] Commit `feat(web): app shell, nav, theme, formatters (port 5188)`.

### Task 8: Overview page

**Files:** Create `apps/web/app/page.tsx` + `components/tokens/HotTokensTable.tsx`.
**Interfaces:** Consumes latest TokenFlowSnapshot per token joined Token + latest TokenMarketSnapshot + last Alert. Columns exactly Spec §8.1. Sort FlowScore desc; signal status badge colors (watching gray, hot orange, profit_rotation violet, exit_warning red, dead zinc); 30s revalidate/poll.

- [ ] Implement; seeded data shows 28 rows, $NOVA top with score ≥ 70.
- [ ] Preview verify (snapshot: table headers + first row values present). Commit `feat(web): overview hot-tokens table`.

### Task 9: Token Detail page

**Files:** Create `apps/web/app/tokens/[id]/page.tsx` + `components/tokens/{PriceChart,TradesTimeline,WalletBuyersTable,RiskPanel,NetFlowChart}.tsx`.
**Interfaces:** Recharts ComposedChart price+mcap with buy/sell scatter markers from WalletTokenTrade; buys timeline list; buyer wallets table (score, pnl, labels); clusters involved (from entityClusterId on trades — may be empty until Wave 3); net-flow bar chart from flow snapshots; risk flags panel (riskFlags Json); explorer + DexScreener links built from Chain registry URLs; alert history (empty until Wave 2).

- [ ] Implement; verify $NOVA page renders chart + ≥35 buyers + risk empty, $RUGZ shows 2 danger flags.
- [ ] Commit `feat(web): token detail page`.

### Task 10: Wallet Leaderboard page

**Files:** Create `apps/web/app/wallets/page.tsx` + `components/wallets/LeaderboardTable.tsx`.
**Interfaces:** WalletStats join Wallet + classifications; columns per Spec §8.3 incl. best/worst recent tokens (top/bottom realized PnL per wallet from trades); sortable by pnl/winRate/score; profitable-threshold highlight (settings).

- [ ] Implement; verify: ≥40 CSV-imported wallets present with scores; sort works.
- [ ] Commit `feat(web): wallet leaderboard`.

### Task 11: WAVE 1 GATE

- [ ] `npm run verify` (typecheck + all tests + next build) — all green; fix anything red.
- [ ] Fresh run-through: `db:migrate` → `db:seed` → `dev` + `worker` simultaneously; preview-check Overview/Token/Leaderboard; worker log shows cycles without errors.
- [ ] Review checklist (Spec §12): runs? satisfies Phases 1–2? biggest gap → fix now.
- [ ] Commit `chore: wave 1 gate — verify green`.

# Wave 2 — CSV Import, Rules, Signals, Telegram (Spec Phases 3–5)

### Task 12: CSV import (UI + job + validation)

**Files:** Create `apps/web/app/api/import/route.ts` (multipart upload → ImportJob row → enqueue `walletImport`), `apps/web/app/wallets/import/page.tsx` (upload form + history table w/ per-row errors), `apps/worker/src/jobs/walletImport.ts`, `packages/core/src/csv/walletCsv.ts` (papaparse + Zod row schema: columns per Spec Module 1; address validated per chain — base58 32-byte for SOLANA via `@solana/addresses`-style check implemented locally (decode+length), EIP-55/lowercase hex for BSC). Test `packages/core/test/walletCsv.test.ts`: valid row parses; bad chain, malformed address, negative trade_count, missing wallet_address each produce row-level error not throw; tags split on `|`.

- [ ] Tests first (FAIL) → implement → PASS.
- [ ] End-to-end: upload fixture CSV via UI → ImportJob completes, wallets upserted (source=csv wins over computed), history shows counts.
- [ ] Commit `feat(import): csv wallet import — parser, job, UI, history`.

### Task 13: FIFO PnL + rules A–D (TDD)

**Files:** Create `packages/core/src/pnl/fifo.ts`, `rules/{types,ruleA,ruleB,ruleC,ruleD}.ts`; Tests `packages/core/test/{fifo,ruleA,ruleB,ruleC,ruleD}.test.ts`.

**Interfaces:** `computeFifoPnl(trades: TradeRow[], currentPrice: number): { realizedUsd, unrealizedUsd, winRate, tradeCount, confidence }` (confidence per Spec §6 L4). Rules implement `Rule` contract; **thresholds only via settings arg**.

- [ ] Failing tests. fifo: buy10@1+buy10@2 sell15@3 ⇒ realized = 15*3 − (10*1+5*2) = 25; unrealized = 5*(current−2); sells exceeding inventory clamp + lower confidence. Each rule: one firing fixture (numbers straight from Spec §6 row), plus near-misses — A (tiered): 9 wallets ⇒ no signal; 12 wallets ⇒ fires WATCH; 19 wallets meeting every HIGH condition ⇒ still WATCH; 20 wallets + $24k vol ⇒ WATCH not HIGH; 20 wallets + all conditions ⇒ HIGH; 31% sold (no HIGH), mcap $6M (no HIGH). Rule A also adds `watchMinWallets: 10` to settings rules.A (schema + DEFAULT_SETTINGS + settings test update — this task owns that settings change). B: growth 20→39 (no), expansion 2.1× (no); C: 69% human (no), 35% of buys in one block (no); D: whale $9.9k (no), ratio 2.9 (no).
- [ ] Implement → PASS. Commit `feat(core): fifo pnl + rules A–D (TDD)`.

### Task 14: Rules E–G (TDD)

**Files:** Create `packages/core/src/rules/{ruleE,ruleF,ruleG,index}.ts`; Tests per rule.
**Interfaces:** `RuleExtras = { fundingEvents?: FundingEvent[]; rotationCandidates?: RotationCandidate[] }`; `FundingEvent = { funderWalletId, fundedWalletId, fundedAddressFresh: boolean, amountUsd, ts, fundedFirstBuy?: { tokenId, usd, ts, mcapAtBuy } }`; `RotationCandidate` mirrors Spec §6 F fields. `evaluateAllRules(agg30, agg24h, settings, extras): RuleResult[]` in `rules/index.ts`.

- [ ] Failing tests. E: funded fresh wallet buys 47 min later at 60% of funding ⇒ fire; 3 min (no), 130 min (no), buy 20% of funding (no), mcap $6M (no). F: value match 92%, gap 4h, re-buy 30 min ⇒ fire; match 70% (no), transfer after 25h (no). G: each of the 4 disjunct triggers fires alone; none ⇒ no fire.
- [ ] Implement → PASS. Commit `feat(core): rules E–G + evaluateAllRules (TDD)`.

### Task 15: Window aggregation + signal job + seed signals

**Files:** Create `packages/core/src/window/aggregate.ts` (+ test: fixture trades ⇒ exact counts/volumes/ratios; exit% = wallets sold ≥80% of position), `apps/worker/src/jobs/signalDetection.ts` (per token: build agg30+agg24h from DB rows, evaluateAllRules, persist Signal rows (dedupe: no duplicate open signal same token+rule), update TokenFlowSnapshot.signalStatus per Spec mapping: G⇒exit_warning, F⇒profit_rotation, A–E⇒hot, none+score<10 for 24h⇒dead, else watching), extend `seed.ts` to run signal pass (expect: A,C,D on $NOVA; B on $QUIET; E on $SEED; G on $DUMP — F arrives Wave 3 when rotation matcher exists). Wallet-driven scope correction (2026-07-05, binding): buyers in the aggregate carry `isWatched` (watched∪profitable counts drive Rule A tiers); aggregate ALSO computes multi-window accumulation metrics {smartWalletCount30m, smartWalletCount1h, smartWalletCount6h, percentWalletsSold} persisted into TokenFlowSnapshot.componentBreakdown.metrics (no schema change); every Signal row's metrics JSON carries rawWalletCount, uniqueEntityCount, largestClusterSize, entityConcentrationRisk (entity values degrade gracefully to raw count / 0 / 'unknown' until Task 22 clustering lands). This replaces T5's interim basicAggregate (delete it; worker + seed both consume core aggregateWindow).

- [ ] aggregate tests FAIL→PASS; seed rerun produces expected signals (assert in a seed self-check block, log table).
- [ ] Commit `feat(signals): window aggregation, signal worker, seeded signals`.

### Task 16: Telegram alerts + cooldowns (TDD on logic)

**Files:** Create `packages/core/src/alerts/{templates,cooldown}.ts` (+ tests), `apps/worker/src/jobs/alertDispatch.ts`, `apps/web/app/api/alerts/test/route.ts`.
**Interfaces:** `renderAlert(kind: 'SIGNAL'|'ROTATION'|'WALLET_GRAPH'|'TEST', data): string` — HTML-mode Telegram strings **exactly matching Spec Module 10 templates** (incl. emoji headers, Why-it-triggered bullets from RuleResult.reasons, links block, risk flags, probabilistic wording); SIGNAL template additionally carries the entity-adjusted block per scope correction: `Smart wallets buying: N / Estimated unique entities: N / Largest cluster: N wallets / Cluster concentration: low|medium|high`; `shouldSendAlert(lastSentAt: Date|null, severityPrev, severityNow, settings): boolean` (30-min cooldown; HIGH→CRITICAL escalation bypasses once). Sender: `fetch https://api.telegram.org/bot${token}/sendMessage`; missing token ⇒ Alert row with deliveryStatus `skipped_no_token`.

- [ ] Template tests (snapshot of $NOVA alert text; escapes `<`/`&`), cooldown truth table tests FAIL→PASS.
- [ ] Wire alertDispatch: pending Signals without Alert → render → send/skip → persist. Run worker in mock: alerts created (skipped_no_token locally).
- [ ] Commit `feat(alerts): telegram templates, cooldowns, dispatch job, test endpoint`.

### Task 17: Alerts page + Settings page

**Files:** Create `apps/web/app/alerts/page.tsx` (chronological feed per Spec §8.6 incl. mcap-at-trigger vs now + post-alert perf %), `apps/web/app/settings/page.tsx` + `app/api/settings/route.ts` (GET/PUT, Zod-validated full Settings form grouped by section; provider key **status only** (set/missing via env presence + ProviderStatus) — never echo secrets; chains enabled toggles; **Send test alert** button → `/api/alerts/test`).

- [ ] Verify: settings edit persists + rejects invalid (e.g. mcapMin > mcapMax); test-alert button yields Alert row (skipped_no_token) and success toast; alerts feed shows seeded signals.
- [ ] Commit `feat(web): alerts feed + settings editor + test alert`.

### Task 18: WAVE 2 GATE

- [ ] `npm run verify` green; fresh `db:seed` → signals + alerts present; preview-check Import/Alerts/Settings; review checklist; fix biggest gap.
- [ ] Commit `chore: wave 2 gate — verify green`.

# Wave 3 — Wallet Graph, Money Flow, Clustering, Rotation (Spec Phases 6–7)

### Task 19: BFS engine (TDD)

**Files:** Create `packages/core/src/graph/{bfs,paths}.ts`; Tests `packages/core/test/bfs.test.ts` with an in-memory `EdgeFetcher` fixture graph (12 nodes incl. router/CEX).
Required cases: depth-1 DIRECT returns only neighbors; maxDepth honored; router/CEX shown as nodes but **not expanded** when excludeRoutersPoolsContracts (registry lookup) — expanded when toggled; minTransferUsd filters; maxNodes/maxEdges ⇒ `truncated:true` with partial graph; CAPITAL_FLOW extracts path A→B→C with `pathValueUsd` decay (10k→9.8k) and time gaps; ENTITY_DISCOVERY only follows edges whose LinkEvidence-derived confidence > 0; frontier priority = USD desc.

- [ ] Tests FAIL → implement `runBfs` + `extractPaths(nodes, edges, root): TransactionPath[]` → PASS.
- [ ] Commit `feat(core): graph BFS engine, 4 modes, caps, path extraction (TDD)`.

### Task 20: Graph search job + API + exports

**Files:** Create `apps/worker/src/jobs/walletGraph.ts` (EdgeFetcher backed by provider activity + MoneyFlowEdge rows; persists WalletGraphSearch/Node/Edge; status transitions queued→running→done|truncated|failed), `apps/web/app/api/graph/route.ts` (POST create+enqueue, GET by id w/ nodes+edges), `apps/web/app/api/graph/[id]/export/route.ts` (`?format=nodes.csv|edges.csv|json`).

- [ ] Run search on mock graph-demo root: completes < 10s, node/edge counts match world fixture; exports download with correct headers/columns (nodes: address,chain,depth,type,totalSent,totalReceived,netFlow,interactions,firstSeen,lastSeen,tags,confidence).
- [ ] Commit `feat(graph): search job, API, CSV/JSON exports`.

### Task 21: Wallet Graph Finder page

**Files:** Create `apps/web/app/graph/page.tsx` + `components/graph/{SearchForm,GraphCanvas,ConnectedWalletsTable,PathsTable}.tsx`. Cytoscape in client component: concentric layout by depth, node size ∝ total flow, edge width ∝ log10(USD), type-colored nodes (wallet/bridge/CEX/router/pool/contract legend), click node ⇒ side detail. Form = all Spec Module 6 inputs with settings defaults; poll status while running; tables per Spec §8.5; export buttons.

- [ ] Verify on demo root: canvas renders 3 depth rings, CEX/router visible un-expanded, paths table shows A→B→C $9.8k path, exports work. Preview screenshot.
- [ ] Commit `feat(web): wallet graph finder page (cytoscape + tables + export)`.

### Task 22: Link confidence + clustering (TDD) + clustering job

**Files:** Create `packages/core/src/cluster/{linkConfidence,unionFind,clusterer}.ts`; Tests each. `apps/worker/src/jobs/entityClustering.ts`.
Required tests: each Spec §6 weight contributes exactly (direct 35, repeated +20, funding 25, gas 10, bridge 30, amount 15, dest-buy 15, fresh 15, rotation 10, cross-launch 25; negatives −30/−20/−15/−25); clamp 0..100; band labels (weak/possible/probable/strong); union-find merges transitively at ≥61, not at 60; cluster confidence = mean of member max-pair confidences. Job: derive LinkEvidence pairs from MoneyFlowEdge + funding patterns + trade timing, upsert EntityCluster(+Wallet), stamp `entityClusterId` onto trades, recompute `uniqueEntityCount` for aggregates.

- [ ] TDD cycle → PASS; job run on seed: $NOVA 18-wallet cluster detected (one cluster ≥ 15 members, confidence ≥ 61); Token Detail + Overview now show raw vs unique counts diverging for $NOVA.
- [ ] Commit `feat(cluster): link confidence, union-find clustering, worker (TDD)`.

### Task 23: Money flow + bridge + rotation (TDD on matcher)

**Files:** Create `apps/worker/src/jobs/{moneyFlow,bridgeFlow,profitRotation}.ts`, `packages/core/src/rotation/matcher.ts` + test.
Matcher tests: exit(realized ≥ $500) + transfer 4h later + receipt 92% + dest buy 30 min + dest mcap $800k ⇒ candidate with confidence (uses linkConfidence w/ bridge evidence); 70% value match ⇒ none; 25h gap ⇒ none. bridgeFlow: mock Wormhole deposit/withdrawal matched on asset+amount(95–105%)+time(<60m)+protocol ⇒ MoneyFlowEdge pair + high confidence; CEX-interrupted ⇒ low. profitRotation job persists ProfitRotationSignal + fires Rule F signal + ROTATION alert (template Module 10 type 2).

- [ ] TDD → PASS; seed/worker pass yields $ALPHA→$BETA rotation row + F signal + rotation alert (skipped_no_token).
- [ ] Commit `feat(flow): money-flow/bridge workers + rotation matcher (TDD)`.

### Task 24: Money Flow page

**Files:** Create `apps/web/app/flow/page.tsx` + `components/flow/{RotationsTable,ClustersTable,BridgeFlowsTable,FlowSankey}.tsx` — tables A/B/C exactly per Spec §8.4 + Recharts Sankey (Token A → Cluster → Bridge → Wallet → Token B built from the $ALPHA→$BETA chain) + summary cards (biggest exits, fresh-wallet entries, top funders).

- [ ] Verify all three tables populated from seed, Sankey renders the rotation chain. Preview screenshot.
- [ ] Commit `feat(web): money flow page (rotations, clusters, bridges, sankey)`.

### Task 25: WAVE 3 GATE

- [ ] `npm run verify` green; fresh seed→worker→all 7 pages preview-checked; wallet-graph alert (type 3) wired for fresh-wallet fundings from watched wallets (rule E context) — template test passes.
- [ ] Review checklist; fix biggest gap. Commit `chore: wave 3 gate`.

# Wave 4 — Live Adapters + Registry (Spec Phases 8–10)

### Task 26: Address registry data + tagging

**Files:** Create `packages/providers/src/registryData/{solana,bsc}.ts` — curated static lists (major CEX hot wallets, Raydium/Jupiter/Orca + PancakeSwap routers, Wormhole/deBridge/Mayan/Allbridge program/router addresses; each entry `{address, category, label, source:'static-2026-07'}`), seed loads them; BFS + clustering consume registry (do-not-expand, cex interruption penalty) — verify via existing tests still green + one new test: registry CEX node not expanded.

- [ ] Commit `feat(registry): known service addresses (sol+bsc) + tagging integration`.

### Task 27: Solana live adapters (Helius + risk)

**Files:** Create `packages/providers/src/solana/{helius,risk}.ts`.
Process: WebFetch official Helius docs (parsed transaction history + RPC). Implement `WalletActivityProvider` (map Helius parsed txs → NormalizedTx legs: SWAP→swap_leg pair, TRANSFER→token/native_transfer, unknown→contract_interaction), base58 address validation, cursor via `before` signature, limiter ~9 rps, ProviderSyncState cursors. Risk: `getAccountInfo` mint parse (mintAuthority/freezeAuthority) + `getTokenLargestAccounts` concentration. **If docs unreachable or shape unverifiable: keep typed stub returning `mode:'stub'`, write TODO(provider) + README note, continue.** No key ⇒ `missing_key` status, registry falls back to mock.

- [ ] Unit-test the normalization mapper on 3 recorded/synthetic Helius-shaped payloads (checked into `test/fixtures/helius/*.json`).
- [ ] Commit `feat(solana): helius activity adapter + risk checks (docs-verified or stubbed)`.

### Task 28: DexScreener market adapter (keyless — live-verifiable)

**Files:** Create `packages/providers/src/solana/dexscreener.ts` (serves both chains). WebFetch docs; implement token-pairs lookup → `TokenMarket` (pick highest-liquidity pair; mcap/fdv/liquidity/vols mapping), 300 rpm limiter.

- [ ] Mapper unit test on fixture payload. Live smoke test (guarded `LIVE_SMOKE=1`): fetch SOL or a bluechip token, expect non-null price — run it once here since keyless, record output in task summary.
- [ ] Wire marketData jobs: MOCK_MODE=false path uses DexScreener; hot/normal tiering per Spec §7.
- [ ] Commit `feat(market): dexscreener adapter (live-verified) + live market jobs`.

### Task 29: BSC scaffold (BscScan + GoPlus + stubs)

**Files:** Create `packages/providers/src/bsc/{bscscan,goplus,stubs}.ts`. WebFetch BscScan docs (`account/tokentx`,`account/txlist`) → NormalizedTx mapper + EIP-55 validation + 5 rps limiter (key-gated); GoPlus token_security if docs verify (keyless tier) else stub; Birdeye/Moralis/Bitquery typed stubs with env vars + TODO(provider) notes; ProviderStatus surfaces all of it on Settings page.

- [ ] Mapper unit tests on fixture payloads; Settings page shows per-provider mode badges.
- [ ] Commit `feat(bsc): bscscan adapter scaffold, goplus risk, provider stubs`.

### Task 30: WAVE 4 GATE

- [ ] `npm run verify` green. MOCK_MODE=false boot check: system runs, providers report `missing_key`/`live` correctly, nothing crashes (graceful degradation proven). Flip back to mock default.
- [ ] walletDiscovery + walletStatsRefresh jobs implemented (computed L2 PnL via `computeFifoPnl` over stored trades → WalletStats source=computed, CSV rows untouched).
- [ ] Review checklist; fix biggest gap. Commit `chore: wave 4 gate`.

# Wave 4.5 — External Smart Wallet Source Connectors (Spec §5b, added 2026-07-05)

Executed after Task 30 (Wave 4 gate), before Wave 5 polish. Goal: FlowRadar bootstraps its wallet universe with ZERO user CSV and zero API keys (mock candidate source), with live connectors docs-verified or cleanly stubbed.

### Task 34: Connector framework + schema + mock candidate source (TDD)

**Files:** Modify `packages/db/prisma/schema.prisma` (+ migration `connectors`): `ExternalWalletSource` + `CandidateWallet` models per Spec §5b (CandidateWallet unique (walletAddress, chain, source); validationStatus enum pending|validating|promoted|rejected; promotedWalletId FK→Wallet nullable). Create `packages/providers/src/candidates/{types,mockSource}.ts` — `CandidateSourceProvider { name: string; chains: Chain[]; fetchCandidates(chain, opts: {limit?: number}): Promise<ExternalCandidate[]> }`, `ExternalCandidate = {walletAddress, chain, sourceRank?, claimedPnlUsd?, claimedWinRate?, claimedTradeCount?, claimedRoi?, metadata?}`; `MockCandidateSource` derives a deterministic leaderboard from the mock world (top ~30 wallets by scripted profitability) PLUS poisoned entries that MUST later fail validation: 2 router/CEX addresses from the registry, 2 possible_bot wallets, 1 wallet below thresholds. Create `apps/worker/src/jobs/externalWalletSource.ts` (iterate enabled ExternalWalletSource rows → resolve provider by name (mock mode ⇒ MockCandidateSource for all) → upsert CandidateWallets pending, dedupe on the unique tuple, update source lastSyncAt/status; per-source try/catch). Seed: create the 6 ExternalWalletSource rows (solana_tracker_pnl, birdeye_wallet_pnl, birdeye_top_traders, kolscan, gmgn_smart_money, cielo — enabled per settings, apiKeyEnvName filled, rateLimitPerMinute defaults).

**Interfaces:** Produces CandidateSourceProvider + candidate job consumed by Task 35; settings gains `connectors: { sourcesEnabled: Record<string, boolean>, syncHours: 6, validationBatchSize: 100, topTraderBackfill: { mcapExpansionMin: 2, lookbackHours: 24, topN: 20 } }` (added to core SettingsSchema + DEFAULT_SETTINGS + tests, owned by this task).

- [ ] TDD: mock source determinism + poisoned entries present; job dedupe (second run adds 0 rows); disabled source skipped; migration applies.
- [ ] Root typecheck/test green. Commit `feat(connectors): candidate source framework, schema, mock leaderboard source (TDD)` + trailer.

### Task 35: Candidate validation + promotion + top-trader backfill (TDD)

**Files:** Create `packages/core/src/candidates/validate.ts` (pure: `evaluateCandidate(candidate, evidence: {pnl?: {pnl30d, realized, winRate, tradeCount, confidence}, registryCategory?: string, labels?: string[]}, settings) → {verdict: 'promote'|'reject'|'insufficient', confidence: 0–100, reason?}` — thresholds from settings.profitableWallet; auto-reject registryCategory in CEX/ROUTER/POOL/BRIDGE or labels containing possible_bot/mev/sniper-dominant; confidence blends claimed-vs-validated agreement), `apps/worker/src/jobs/{walletCandidateValidation,tokenTopTraderBackfill}.ts`. Validation job: pending candidates (batch from settings) → evidence: provider wallet-PnL capability if available else local `computeFifoPnl` over ingested trades else claimed-only (⇒ 'insufficient' stays pending with lastSeenAt bump, never promoted on claims alone unless claimed data meets thresholds AND source is a validator-grade source — NO: claims alone NEVER promote; document); promote ⇒ upsert Wallet (isWatched=true) + WalletStats(source 'provider' or 'computed') + WalletClassification, set promotedWalletId; reject ⇒ rejectionReason. Backfill job: tokens whose latest mcap ≥ settings multiple vs 24h-ago snapshot → provider topTraders capability (add `TokenTopTradersProvider.getTopTraders(chain, tokenAddress, {limit})` interface + mock impl from world buyers) → insert candidates source `birdeye_top_traders`.

**Interfaces:** Consumes T34 framework. Produces promotion pipeline; **trust-boundary test (required):** insert an unvalidated CandidateWallet for a fresh address → run signal-engine aggregate → assert the address contributes NOTHING to smartWalletCount/uniqueEntityCount until promoted, then promote and assert it counts.

- [ ] TDD (validate.ts fixture matrix: pass, each threshold-miss, registry reject, bot reject, insufficient-evidence hold). Job run in mock mode: poisoned candidates rejected with reasons, ≥20 promoted, counts logged. Root verify green. Commit `feat(connectors): validation + promotion pipeline, top-trader backfill (TDD)` + trailer.

### Task 36: Live connector adapters (docs-verified or stubbed) + Source Health page

**Files:** Create `packages/providers/src/candidates/{solanaTracker,birdeyeCandidates,kolscan,gmgn,cielo}.ts` — for each: WebFetch official docs first; implement only what docs verify (SolanaTracker top-PnL wallets, SOLANA_TRACKER_API_KEY; Birdeye wallet-PnL + token top-traders, BIRDEYE_API_KEY; Cielo, CIELO_API_KEY); KOLScan/GMGN: no hardcoded unofficial endpoints — typed stubs returning status 'stub' with TODO(provider) + configurable GMGN_API_BASE env respected when set. Missing key ⇒ ProviderStatus 'missing_key', source status reflects it. Create `apps/web/app/sources/page.tsx` + nav link — per-source rows (enabled toggle → PATCH /api/sources, status, lastSyncAt, candidates found/validated/promoted via CandidateWallet groupBy, last error) + README section (env vars table + trust rule).

- [ ] Adapter mapper unit tests on fixture payloads for docs-verified adapters; page renders mock-mode counts; toggle persists. Root verify green. Commit `feat(connectors): live source adapters (verified-or-stubbed) + source health page` + trailer.

# Wave 5 — Backtest + Polish + Done Bar (Spec Phases 11–12)

### Task 31: Backtest (TDD) + page

**Files:** Create `packages/core/src/backtest/evaluate.ts` + test (fixture snapshot series: signal at $500k mcap, series peaks 3× at +4h, dips −40% at +30m ⇒ M15 drawdown −40%, H6 upside +200%, timeTo2x ≈ 3h, roiNow from last point; missing series ⇒ null metrics + note), `apps/worker/src/jobs/backtest.ts` (all horizons per signal, upsert BacktestResult), `apps/web/app/backtest/page.tsx` (simple table: signal, rule, token, per-horizon ROI/upside/drawdown, smart-exit flag) + nav link.

- [ ] TDD → PASS; job on seeded signals fills results; page renders.
- [ ] Commit `feat(backtest): evaluator (TDD), worker, results page`.

### Task 32: Polish + README + Done Bar verification

**Files:** Modify all pages: loading.tsx, empty states ("No data yet — run npm run db:seed" style), error boundaries; README.md final — exact commands (Spec §13), LITE vs FULL setup, **what works / what is mocked / what needs API keys / remaining gaps** sections; `.env.example` final with per-key comments.

- [ ] Full Done-Bar walkthrough (Spec Module 16, every item) from a clean state: fresh clone simulation (`git clean -xdf` dry-run caution — use temp clone instead), `npm install` → `db:migrate` → `db:seed` → `dev`+`worker` → preview-verify all 7 pages + import + test alert + graph search + exports; `npm run verify` green.
- [ ] Fix everything found. Commit `chore: polish, readme, done-bar verification`.

### Task 33: FINAL GATE — merge + summary

- [ ] `npm run verify` green on `feat/mvp`; merge to `main` (no-ff), tag `v0.1.0-mvp`.
- [ ] Final summary per approval constraint #10: exact commands, what works, what's mocked, what needs keys, remaining gaps.

---

## Self-review notes (done)

- **Spec coverage:** Modules 1–16 all mapped: M1→T3/T12/T30, M2→T5/T6, M3→T13–T15, M4→T3, M5→T22/T23, M6→T19–T21, M7→T23/T26, M8→T9/T27/T29, M9→T7–T10/T17/T21/T24/T31, M10→T16, M11→T31, M12→T2, M13→T5/T15/T16/T20/T22/T23/T30/T31, M14→settings intervals T3/T5, M15 order preserved via waves, M16→T32/T33. Rule F seed expectation deliberately lands Wave 3 (matcher dependency) — noted in T15.
- **Type consistency:** contracts defined once in Shared Contracts; tasks reference identical names (`aggregateWindow`, `evaluateAllRules`, `computeFifoPnl`, `runBfs`, `renderAlert`, `shouldSendAlert`, `calculateWalletLinkConfidence`).
- **No placeholders:** every task has concrete files, behaviors, test cases, and commands; live-provider unknowns are explicit stub-with-TODO decisions per approval constraint #8, not plan gaps.
