# FlowRadar — Design Spec

Date: 2026-07-05
Status: awaiting user approval
Location: `C:\Users\akki\session\flowradar`
Source: user-provided 17-module requirements brief (brainstormed, decisions locked below)

## 1. Product summary

Local-first Solana + BNB Chain intelligence dashboard + worker bot. **FlowRadar is a wallet-driven early-token detection system** — the edge is NOT scanning every new coin/pair; it is tracking strong/profitable/watched wallets continuously and surfacing a token early when they cluster-buy or accumulate it. Primary loop: watched wallets → new buys → same-token clustering → accumulation detection → entity adjustment → FlowScore → alert the TOKEN (not just the wallets). Tokens enter the system only via tracked-wallet activity (a tracked/linked/freshly-funded wallet buys it, or it appears in a profit-rotation path); global new-token/pair scanning is explicitly a later optional module, not MVP. Analytics only.

**Non-goals / hard constraints (enforced in code and copy):**
- No trading execution, no market manipulation, no chain spam (read-only public APIs, throttled).
- No deanonymization of real people. Only public blockchain data.
- Probabilistic language everywhere: `weak link` / `possible link` / `probable link` / `strong link`, "likely linked", "probable rotation". The UI never claims "same person confirmed". Max label is "strong link (on-chain evidence, repeated behavior)".
- Alerts are informational, not financial advice (footer on alerts + dashboard).

## 2. Environment facts and runtime decision

Verified on this machine (2026-07-05): Node v24.17.0, npm 11.13.0, git 2.54, **Docker not installed**.

The spec's Done Bar requires `docker compose` for Postgres + Redis. Docker is absent here, so the design ships **two infra modes with identical application code**:

| Mode | Postgres | Queues | When |
|---|---|---|---|
| **FULL** | Docker Compose `postgres:16` | Redis 7 (Compose) + BullMQ | `REDIS_URL` set; the spec-canonical path |
| **LITE** (default in `.env.example`) | `embedded-postgres` npm pkg (real PG 16 binaries, data in `./.pgdata`, auto-started by npm scripts) | `InlineRunner` (in-process interval scheduler, same job functions) | No Docker needed; fully verifiable on this machine |

- `docker-compose.yml` is shipped and documented (Done Bar item satisfied as: file + docs + FULL-mode support; end-to-end verification on this box runs in LITE mode).
- Queue abstraction `JobRunner { schedule(name, intervalMs, fn), enqueue(name, payload), process(name, fn) }` with `BullMqRunner` and `InlineRunner`. Workers are pure job functions registered against whichever runner is active — no behavioral divergence.
- Alert cooldowns are **DB-based** (query last Alert per token+rule), not Redis-based, so they work identically in both modes and survive restarts.

Other locked decisions:
- **Monorepo:** npm workspaces (spec mandates `npm` commands; no turbo/pnpm).
- **Web port:** 5188 (5184–5187 are taken by other session projects).
- **Graph viz:** Cytoscape.js (plain, in a client component; concentric layout keyed by BFS depth; edge width ∝ log USD). React Flow rejected — worse at 1k+ node hairballs.
- **Charts:** Recharts (includes Sankey for Money Flow page).
- **Tests:** Vitest. **CSV:** papaparse. **Validation:** Zod v4. **Telegram:** raw Bot API via fetch (no SDK dep). **Worker runtime:** tsx.
- **Next.js 15 App Router**, React 19, Tailwind 4, shadcn/ui, strict TypeScript everywhere.
- Data axis independent of infra axis: `MOCK_MODE=true` (default) vs live providers.

## 3. Monorepo layout

```
flowradar/
  package.json            # workspaces + root scripts (dev, worker, db:*, verify, test)
  docker-compose.yml      # postgres:16 + redis:7 (FULL mode)
  .env.example  README.md
  apps/
    web/                  # Next.js 15 dashboard (port 5188)
    worker/               # job-function registry + runner bootstrap
  packages/
    db/                   # Prisma schema, client, migrations, seed
    core/                 # pure domain logic: types, scoring, rules, clustering, BFS, rotation, PnL, backtest (unit-tested)
    providers/            # provider interfaces + mock world + live adapters + rate limiter
  scripts/                # db-local (embedded PG lifecycle), verify helpers
```

`core` has zero I/O — every scoring/rule/confidence/graph function is pure and fixture-testable. `worker` and `web` compose `core` + `db` + `providers`.

## 4. Data model (Prisma, PostgreSQL)

Precision policy: USD `Decimal(20,4)`; token amounts `Decimal(38,18)`; prices `Decimal(24,12)`; rates/percentages `Float`; block/slot `BigInt`; enums for chain/action/rule/severity/status/label/node/relationship types. BSC addresses stored lowercase, rendered checksummed; Solana base58 as-is.

Models (22):

1. `Chain` — id (`SOLANA`|`BSC`), name, nativeSymbol, explorerTxUrl, explorerAddressUrl.
2. `Wallet` — address+chain (unique), firstSeenAt, lastActiveAt, isWatched, isExcluded, exclusionReason, notes.
3. `WalletStats` — walletId, window (`30d`), pnlUsd, realizedPnlUsd, unrealizedPnlUsd, winRate, tradeCount, avgTradeSizeUsd, walletScore, scoreComponents Json, pnlConfidence (0–100), source (`csv`|`computed`|`provider`), computedAt.
4. `WalletClassification` — walletId, label (`human_like` … `unknown`, 11 values per brief), confidence, evidence Json.
5. `Token` — chain+address (unique), symbol, name, decimals, pairAddress, dex, firstSeenAt, tokenCreatedAt, website/twitter/telegram, riskFlags Json.
6. `TokenMarketSnapshot` — tokenId, ts, priceUsd, marketCapUsd, fdvUsd, liquidityUsd, vol5m/1h/6h/24h, holderCount. Index (tokenId, ts).
7. `WalletTokenTrade` — walletId, tokenId, chain, action (`BUY`|`SELL`|`TRANSFER_IN`|`TRANSFER_OUT`|`LP_ADD`|`LP_REMOVE`), amountToken, amountUsd, txHash, blockOrSlot, ts, priceUsd, marketCapAtTrade, walletScoreAtTime, entityClusterId?, provider. Dedupe key unique(chain, txHash, walletId, tokenId, action).
8. `TokenFlowSnapshot` — tokenId, ts, windowMinutes, flowScore, smartWalletCount, humanLikeCount, possibleBotCount, uniqueEntityCount, clusterAdjustedWalletCount, entityConcentrationRisk, trackedBuyVolumeUsd, trackedSellVolumeUsd, netFlowUsd, buySellRatio, avgEntryMcap, currentMcap, mcapExpansionFromAvgEntry, holdersGrowth, liquidityChange, signalStatus (`watching`|`hot`|`profit_rotation`|`exit_warning`|`dead`), componentBreakdown Json. Indexes (tokenId, ts), (flowScore).
9. `Signal` — tokenId, rule (`A`–`G`), severity (`INFO`|`WATCH`|`HIGH`|`CRITICAL`), triggeredAt, reasons Json (bullet list), walletCount, uniqueEntityCount, netFlowUsd, mcapAtTrigger, status. Index (severity, triggeredAt).
10. `Alert` — signalId?, type (`SIGNAL`|`ROTATION`|`WALLET_GRAPH`|`TEST`), channel (`TELEGRAM`|`DISCORD`), tokenId?, rule?, sentAt, payload Json, deliveryStatus, error. Index (tokenId, rule, sentAt) → cooldown lookups.
11. `ProviderSyncState` — provider, chain, scope (wallet address | "market" | token), cursor, lastSyncAt, lastError, failCount. Unique (provider, chain, scope).
12. `Settings` — singleton row, Zod-validated Json of all thresholds (§7 defaults), updatedAt.
13. `ImportJob` — filename, status, totalRows, okRows, errorRows, errors Json, createdAt, finishedAt.
14. `MoneyFlowEdge` — sourceAddress, destinationAddress, sourceChain, destinationChain, asset, amountToken, amountUsd, ts, txHash, actionType (12 values per brief), bridgeProtocol?, confidence, providerSource, metadata Json. Indexes (sourceAddress, ts), (destinationAddress, ts), txHash, (sourceChain, ts).
15. `EntityCluster` — confidence, walletCount, total30dPnlUsd, chains[], evidence Json, mainFundingSource?, updatedAt.
16. `EntityClusterWallet` — clusterId+walletId (unique), linkConfidence, evidence Json.
17. `ProfitRotationSignal` — sourceWalletId, destWalletId, sourceTokenId, destTokenId, realizedProfitUsd, transferredValueUsd, chainPath[], timeGapMin, confidence, detectedAt, destTokenMcapAtBuy, currentDestPerfPct.
18. `WalletGraphSearch` — rootAddress, chain, mode (`DIRECT`|`CAPITAL_FLOW`|`ENTITY_DISCOVERY`|`FULL_RAW`), params Json, status (`queued`|`running`|`done`|`failed`|`truncated`), nodeCount, edgeCount, startedAt, finishedAt, error.
19. `WalletGraphNode` — searchId+address (unique), depth, nodeType (`WALLET`|`BRIDGE`|`CEX`|`ROUTER`|`POOL`|`TOKEN_CONTRACT`|`CONTRACT`|`UNKNOWN`), totalSentUsd, totalReceivedUsd, netFlowUsd, interactionCount, firstSeen, lastSeen, tags[], confidence.
20. `WalletGraphEdge` — searchId, sourceAddress, destAddress, relationship (13 values per brief), totalUsd, txCount, firstTs, lastTs, sampleTxHashes[].
21. `BacktestResult` — signalId+horizon (unique; `M15`|`H1`|`H6`|`H24`|`D3`|`D7`), maxUpsidePct, maxDrawdownPct, roiPct, timeTo2xMin?, timeTo5xMin?, timeTo10xMin?, smartExitedBeforeDump?, notes.
22. `AddressRegistry` — chain+address (unique), category (`CEX`|`BRIDGE`|`ROUTER`|`POOL`|`DEPLOYER`|`MIXER`|`TOKEN_CONTRACT`), label, source, doNotExpand (default true). Seeded with known Solana/BSC routers, major CEX hot wallets, bridge programs (Wormhole/Portal, deBridge, Mayan, Allbridge; LayerZero scaffold).

## 5. Provider layer

Interfaces (`packages/providers`), each per-chain, resolved by `getProvider(chain, capability)` from env:

```ts
WalletActivityProvider.getWalletTransactions(chain, address, {since?, cursor?, limit?}) → {txs: NormalizedTx[], nextCursor?}
MarketDataProvider.getTokenMarket(chain, address) → TokenMarket | null
MarketDataProvider.getTokenPairs(chain, address) → PairInfo[]
TokenMetadataProvider.getTokenMetadata(chain, address) → TokenMeta | null
RiskProvider.getTokenRisk(chain, address) → RiskReport
WalletDiscoveryProvider.getCandidateWallets(chain, opts) → WalletCandidate[]   // optional capability
```

`NormalizedTx = { txHash, blockOrSlot, ts, legs: TxLeg[] }`, `TxLeg = { kind: native_transfer | token_transfer | swap_leg | lp_add | lp_remove | bridge_deposit | bridge_withdrawal | contract_interaction, from, to, asset {address?, symbol, decimals}, amountToken, amountUsd?, programOrContract? }`. Adapters' entire job is mapping raw provider payloads into this shape; everything downstream is provider-agnostic.

**MockProvider (default):** implements every capability against a deterministic in-memory "mock world" (seeded PRNG, genesis = seed-time − 72h, advancing with real time). Workers ingest from it through the exact same pipeline as live — mock mode exercises the full ingest → normalize → store → score → signal → alert path. `db:seed` also runs one synchronous ingest+score+signal pass so the dashboard is fully populated immediately, without the worker running.

**Live adapters (implemented in Wave 4):**
- Solana activity: **Helius** parsed-transaction-history API (`HELIUS_API_KEY`). Solana risk: mint/freeze authority + top holders via Helius RPC.
- Market data (both chains): **DexScreener** public API (keyless) as primary; **Birdeye** adapter stub (`BIRDEYE_API_KEY`) optional.
- BSC activity: **BscScan** (`BSCSCAN_API_KEY`, free tier ~5 rps). **Moralis**/**Bitquery** stubs (`MORALIS_API_KEY`, `BITQUERY_API_KEY`).
- BSC risk: **GoPlus** token_security endpoint if docs verify; else clean stub + TODO.
- Hard rule: official docs are fetched and checked before implementing any live endpoint; unverifiable → interface + stub + documented TODO. No hallucinated endpoints.

Per-provider token-bucket rate limiter + retry w/ exponential backoff (×3) + `ProviderSyncState` cursors and error log. One provider failing never crashes a worker loop.

### 5b. External Smart Wallet Source Connectors (added 2026-07-05)

FlowRadar bootstraps its own candidate wallet universe from external public/on-chain intelligence — no CSV required (CSV stays supported as `csv_import`). No exhaustive chain scanning: candidate FEEDERS only, in priority order: **Solana Tracker** PnL leaderboard (`solana_tracker_pnl`, primary Solana seed), **Birdeye** wallet-PnL as validator + token top-traders as source (`birdeye_wallet_pnl` / `birdeye_top_traders`), **KOLScan** leaderboard (`kolscan`, candidate-only until revalidated), **GMGN** smart-money (`gmgn_smart_money`, candidate + cross-check only; no hardcoded unofficial endpoints — configurable base URL, stub unless documented access), **Cielo** (`cielo`, optional).

Models: `ExternalWalletSource` (name, type, enabled, chainSupport, apiKeyEnvName, rateLimitPerMinute, status, lastSyncAt, metadataJson) and `CandidateWallet` (walletAddress, chain, source, sourceRank, claimedPnlUsd/WinRate/TradeCount/Roi, firstSeenAt, lastSeenAt, validationStatus pending|validating|promoted|rejected, validationConfidence 0–100, promotedWalletId?, rejectionReason?; unique (walletAddress, chain, source)).

Workers: `externalWalletSourceWorker` (pull candidates from enabled sources, dedupe, never promote blindly); `walletCandidateValidationWorker` (validate via provider wallet-PnL where available else local FIFO swap-PnL approximation; thresholds = settings.profitableWallet: pnl_30d ≥ 4000, trades ≥ 8, winRate ≥ 35%, realized ≥ 1000 where available; reject routers/pools/CEX/bridges/obvious bots via AddressRegistry + labels; promote passing candidates to tracked `Wallet` rows with WalletStats + isWatched); `tokenTopTraderBackfillWorker` (tokens with recent strong moves → top traders from supported providers → same validation path).

UI: **Source Health page** (`/sources`) — per source: enabled, status, last sync, candidates found / validated / promoted, errors/rate-limit state.

**Critical trust rule (test-enforced):** the live signal engine reads ONLY validated/promoted tracked wallets; `CandidateWallet` rows never influence counts, scores, or signals until promotion.

## 6. Core engine (pure functions, unit-tested)

**WalletScore (0–100):** pnl 25%, winRate 15%, tradeCount 10%, humanLikelihood 15%, avgEntryQuality 10%, holdingQuality 10%, recentPerformance 15%; botPenalty up to −30; result × confidence multiplier (0.5–1.0 from pnlConfidence); clamp 0–100. Components stored in `scoreComponents`.

**PnL layers:** L1 CSV import (source of truth when present) → L2 FIFO cost-basis over observed trades → L3 realized/unrealized split → L4 `pnlConfidence` = f(coverage of inflows by observed buys, price availability, window completeness).

**FlowScore (0–100):** weighted sum of normalized components (weights per brief): smartWalletCount 20 (`min(n/40,1)`), entityAdjustedCount 15 (`min(entities/25,1)`), netSmartBuyVolume 15 (`clamp(net/50k,0,1)`), walletQualityAvg 15 (`avgScore/100`), humanLikeRatio 10, mcapEfficiency 10 (higher when avg entry mcap sits low in the configured band), accumulationWithoutExpansion 10 (`1−min(expansion/2,1)`), riskLiquiditySanity 5 (1 − risk penalty). Exact curves live in `core/scoring/flowScore.ts` with a test per component.

**Signal rules — concrete defaults (all Settings-editable).** Where the brief said "low"/"sharply", a number is fixed here:

| Rule | Trigger (defaults) | Severity |
|---|---|---|
| A Smart Cluster Buy (tiered) | ≥10 watched/profitable wallets buy within rolling 30 min ⇒ WATCH tier; ≥20 ⇒ HIGH tier with: tracked buy vol ≥ $25k; net flow > 0; <30% of buyers have sold; mcap $100k–$5M; liq ≥ $20k; token age < 7d OR inflow spike (window buy vol ≥ 3× trailing 6h avg). All tiers entity-adjusted: signal carries raw_wallet_count, unique_entity_count, largest_cluster_size, entity_concentration_risk — 40 wallets from 1 cluster ≠ 40 independent wallets | WATCH→HIGH |
| B Accumulation → Breakout | ≥20 buyers grows to ≥40 within 24h window; mcap expansion ≤ 2×; net position > 0; sell vol ≤ 25% of buy vol | HIGH |
| C Human Concentration | ≥70% buyers human_like/smart_money; bot+sniper ≤ 20%; no single block holds >30% of window buys; funding diversity ≥ max(3, 30% of buyers) distinct roots where detectable (check skipped if unknown) | WATCH→HIGH |
| D Whale + Smart Confirm | ≥1 whale buy ≥ $10k; ≥15 profitable wallets buy; buy/sell ratio > 3 | HIGH |
| E Fresh Wallet Funded→Buys | watched/profitable wallet funds fresh wallet (0 trades or ≥30d inactive); buy within 5–120 min; token mcap ≤ $5M; buy size 30%–110% of funded amount | HIGH |
| F Profit Rotation | A exits X with realized PnL ≥ $500; transfer/bridge within 24h; B receives 80–105% of sent value; B buys Y within 60 min; Y mcap ≤ $5M | HIGH |
| G Exit / Danger | any of: ≥30% tracked smart wallets exited (sold ≥80% of position); net flow < 0 AND ≥3 of top-5 scored holders sold; liquidity −30% within 1h; mcap +100% in 6h with <3 new smart buyers | CRITICAL |

Rules A/C/D/E evaluate on rolling 30-min windows; B/F/G on 24h windows. Both aggregates computed per pass by the signal worker. The scoring pass additionally computes multi-window accumulation counts — smart_wallet_count over 30m/1h/6h, tracked buy/sell volume, net smart flow, buy/sell ratio, percent_wallets_sold, avg_smart_entry_mcap vs current_mcap — stored in the flow snapshot's metrics JSON so rising-count accumulation is visible without extra snapshot rows.

**Entity clustering:** `calculateWalletLinkConfidence(a,b)` with the brief's exact weight table (direct transfer +35, repeated +20, same funding source +25, same gas funder +10, bridge amount/time match +30, amount similarity >90% +15, dest buys new token <60 min +15, fresh-wallet activation +15, same rotation behavior +10, repeated cross-launch pattern +25; CEX/mixer interruption −30, router-only −20, weak amount match −15, dust-only −25), clamped 0–100. Bands: 0–30 weak, 31–60 possible, 61–80 probable, 81–100 strong. Clusters = union-find over pairs ≥ `entityConfidenceThreshold` (default 61); evidence JSON retained per pair; FlowScore consumes `uniqueEntityCount` (raw count always shown alongside).

**Wallet graph BFS:** modes DIRECT (depth 1) / CAPITAL_FLOW (follows value ≥ minUsd, tracks path value decay) / ENTITY_DISCOVERY (expands only along linkConfidence-positive edges) / FULL_RAW. Defaults: depth 3, minTransferUsd 100, maxNodes 5 000, maxEdges 25 000, per-node fetch cap 500 txs. `AddressRegistry.doNotExpand` nodes (CEX/bridge/router/pool/contract) render but never expand unless toggled. Frontier prioritized by edge USD desc then repeat count. Hitting caps → status `truncated`, partial graph kept. Exports: nodes CSV, edges CSV, full JSON.

**Rotation matcher:** joins profitable exits (realized PnL from FIFO ledger) × outgoing MoneyFlowEdges × receipts (amount 80–105%, ≤24h) × destination first-buys (≤60 min) → `ProfitRotationSignal` with confidence from the link table.

**Backtest:** per signal × horizon {15m, 1h, 6h, 24h, 3d, 7d} from `TokenMarketSnapshot` series: maxUpside, maxDrawdown, ROI now, time-to-2x/5x/10x, smart-exit-before-dump flag, notes.

## 7. Workers and scheduling

Job functions in `apps/worker/src/jobs/`, registered on the active `JobRunner`:

| Job | Interval (default) |
|---|---|
| walletActivity | 45 s |
| marketDataHot (FlowScore ≥ 50 or active signal) | 60 s |
| marketDataNormal | 5 min |
| flowScoring | 60 s |
| signalDetection | 60 s |
| alertDispatch | 30 s drain |
| moneyFlow | 60 s |
| bridgeFlow | 2 min |
| entityClustering | 3 min |
| profitRotation | 2 min |
| walletStatsRefresh | 6 h |
| walletDiscovery | 24 h |
| backtest | 6 h |
| walletImport, walletGraph | on-demand (enqueued) |

All intervals read from Settings each cycle. Every job body: try/catch → log to ProviderSyncState/console, never crash the process.

## 8. Web app (7 pages, per brief)

1. **Overview** — hot tokens table (FlowScore, chain, symbol, mcap, liq, 5m/1h/24h vol, smart wallets, unique entities, net flow, human ratio, age, signal status, last alert), 30 s poll.
2. **Token Detail** — price/mcap area chart with smart buy/sell markers, buy timeline, wallet list (score, PnL), clusters involved, net-flow chart, accumulation phases, risk flags panel, explorer + DexScreener links, alert history.
3. **Wallet Leaderboard** — sortable stats per brief incl. best/worst recent tokens.
4. **Money Flow** — rotations, clusters, bridge flows tables (A/B/C per brief) + Recharts Sankey (Token → Cluster → Bridge → Wallet → Token).
5. **Wallet Graph Finder** — standalone tool: full input form per brief → enqueues `walletGraph` job → live status → Cytoscape canvas + Connected Wallets table + Transaction Paths table + CSV/JSON export buttons.
6. **Alerts** — chronological feed with severity, rule, reason bullets, mcap at trigger vs now, post-alert performance.
7. **Settings** — every threshold in §6/§7, alert destinations, chains enabled, provider key status (set/missing, never echoing secrets), graph limits, entity confidence threshold; Zod-validated form; **Send test alert** button.

Dark theme default. Server components for tables; route handlers for CSV upload, graph search, settings, telegram test. CSV import: upload → `ImportJob` row → enqueue → papaparse + Zod row validation (columns per brief) → upsert Wallet/WalletStats(source=csv) → history page with per-row errors.

## 9. Alerts (Telegram first)

Raw Bot API `sendMessage` (HTML), `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`. Three templates exactly per brief (Signal / Profit Rotation / Wallet Graph), plus TEST. Cooldown: default 30 min per (token, rule), DB-enforced; severity escalation (HIGH→CRITICAL) bypasses once. Discord webhook: interface stub + env var, deferred. All alerts persisted with payload for the Alerts page and backtesting.

## 10. Mock world scenarios (seeded, deterministic)

~160 wallets (mixed labels incl. bots/snipers/CEX), ~28 tokens, 72 h of history. Scripted stories so every feature demos out of the box:

- **$NOVA** — fires A+C+D (35 smart buyers/25 min, whale $12k, 75% human) and contains an 18-wallet single-funder cluster → shows "42 wallets / 9 entities" style readout.
- **$QUIET** — fires B (22→44 buyers over 36 h, mcap only 1.6×).
- **$SEED** — fires E (watched wallet funds 3 fresh wallets; buys 15–40 min later).
- **$ALPHA → $BETA** — fires F with a mock Wormhole SOL→BSC hop (also populates Bridge Flows).
- **$DUMP** — fires G (40% smart exit, liquidity −35%).
- **$RUGZ** — heavy risk flags (mint authority active, top holder 60%) → risk panel + score penalty demo.
- **Graph demo root wallet** — 3-depth web including CEX/router do-not-expand nodes and a capital-flow path A→B→C (10k → 9.8k USDC style).

## 11. Testing and verification

- Vitest unit suites in `core`: flowScore components, each rule A–G (fixture scenarios that fire and near-miss), walletScore, linkConfidence weights, union-find clustering, BFS caps/do-not-expand/modes, rotation matcher, FIFO PnL + confidence, cooldown logic. Target ≈70 tests.
- `providers`: mock determinism + normalization shape tests.
- `npm run verify` = typecheck (all workspaces) + vitest + `next build`.
- Done Bar mapping: every Module-16 item checked in LITE mode on this machine; `docker compose` item = file shipped + README-documented FULL mode.

## 12. Build plan (12 brief-phases → 5 waves)

Executed with ultracode subagent orchestration inside each wave; integration + `npm run verify` + fresh-context review (runs? satisfies phase? biggest gap → fix) between waves.

- **Wave 1** = Phases 1–2: scaffold, compose, schema+migrations, mock world, seed, Overview + Token Detail + Leaderboard.
- **Wave 2** = Phases 3–5: CSV import, WalletScore/FlowScore + rules A–G + unit tests, Telegram alerts + cooldowns + test button.
- **Wave 3** = Phases 6–7: Wallet Graph Finder (BFS, page, viz, exports), MoneyFlowEdge + clustering + rotation + Money Flow page.
- **Wave 4** = Phases 8–10: Helius + DexScreener live Solana adapters (docs-verified), BSC scaffold (BscScan + risk stubs), AddressRegistry seeding + tagging.
- **Wave 5** = Phases 11–12: backtest worker + results page, polish (loading/empty/error states), README, final verify.

## 13. Commands and env

```
npm install
docker compose up -d      # FULL mode only; LITE mode skips this
npm run db:migrate
npm run db:seed
npm run dev               # web on http://localhost:5188
npm run worker
npm run verify            # typecheck + tests + build
```

`.env.example`: `DATABASE_URL`, `REDIS_URL` (empty ⇒ LITE), `MOCK_MODE=true`, `WEB_PORT=5188`, `HELIUS_API_KEY`, `BIRDEYE_API_KEY`, `BSCSCAN_API_KEY`, `MORALIS_API_KEY`, `BITQUERY_API_KEY`, `GOPLUS_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `DISCORD_WEBHOOK_URL` (deferred). Missing keys ⇒ stub/mock with documented TODO; never a crash.

## 14. Deferred (explicitly out of MVP)

Discord sender implementation, GeckoTerminal adapter, Birdeye/Moralis/Bitquery full adapters, live cross-chain bridge matching beyond registry+heuristics, backtest UI beyond a simple results page, wallet-graph alerts on live data, auth/multi-user, and **global new-token/pair discovery** (scanning/ranking every newly created token) — token discovery is wallet-driven by design in the MVP.

## 15. Flagged risks and assumptions

1. **Cold-start reality:** default Rule A (20+ profitable wallets in 30 min) will rarely fire on live data until hundreds of quality wallets are imported/tracked. Mock mode demonstrates everything; thresholds are Settings-editable for live tuning. Not a bug — stated expectation.
2. **PnL is approximate** from public APIs (pre-window inventory, airdrops, internal transfers invisible). Layer 4 confidence + CSV override is the mitigation; UI shows confidence.
3. **"Production-ready" = robust local single-user app**, not deployed multi-tenant SaaS.
4. **Free-tier rate limits** (Helius/BscScan) bound live wallet coverage; limiter + hot/normal tiering mitigates. DexScreener is keyless and adequate for market data.
5. **embedded-postgres** first run downloads ~50 MB PG binaries; if it misbehaves on this box, fallback is installing Docker Desktop (FULL mode) — application code unaffected.
