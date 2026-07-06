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

### 5c. Wave 3.5 — Operator UI (Signal Feed) + Backtest/Shadow Simulation (added 2026-07-06)

Queued by the user after the Wave 3 gate, before Wave 4 live providers. Rationale (verbatim intent): the current UI is technically functional but not operator-friendly — it reads like a raw admin/Dune table, not a signal a trader can act on in under 10 seconds. Separately, mock data only proves the code path runs; it does not prove the strategy has edge. Both problems are fixed together, in build order Phase A→D (backtest/shadow first, then the UI redesign), before wiring any live provider in Wave 4. This wave supersedes the original Wave 5 Task 31 (see §12 and the plan's Task 31 heading).

**Backtest evaluator (Phase A).** Evaluate a signal against its later price series. Metrics: signal count; hit rate to +50%/2x/5x/10x; median & average return; max upside; max drawdown; time-to-peak; time-to-2x; false-positive rate; rug/exit-warning rate; how often smart wallets exited before the dump; performance broken out by mcap bucket, liquidity bucket, unique-entity-count, cluster-concentration, and rule-combination. Horizons: 15m/1h/6h/24h/3d/7d — the `BacktestResult` schema is expanded to carry these metrics. Mock-world historical-replay unit tests exist here too, but per the hard framing rule below they only prove the evaluator's code path, not signal quality.

**Positive-signal label taxonomy (binding).** +50% before −50% = small win; 2x before −50% = good win; 5x before −60% = major win; a dump >60% without hitting 2x first = failure; a liquidity/rug failure = hard failure.

**Historical replay + tuning (Phase B).** Historical replay re-runs signals over a chosen period using only data available as-of time T (aggregates are reconstructed as-of T — no lookahead bias). Reports rule performance per rule A–G, and combined-strategy performance for: A only; A+B; A+C; A+entity-adjusted count; A+low sell pressure; F only; F+entity cluster confidence; A/B/F combined. Threshold tuning sweeps: min smart wallets, min unique entities, min net smart flow, max sell pressure, max mcap expansion, min liquidity, min confidence, min profit-rotation confidence, max cluster-concentration risk — output is best/worst threshold sets, precision by signal type, recommended default settings, and an explicit overfitting warning. Walk-forward validation is required: tune on period 1, test on later period 2; never tune and test on the same sample only.

**Shadow mode (Phase C).** Runs live for days, recording every signal without trading or acting on it, then evaluates outcomes at 15m/1h/6h/24h/3d/7d. Two new pages: **Backtest** (rule-performance table, threshold comparison, best/worst sets, recommended defaults, overfitting warning) and **Shadow Mode** (live alerts generated, current outcome, pending evaluation windows, per-window results, good/bad/unknown). Hard framing line, enforced in UI copy: do **not** claim the bot is trained or profitable from mock data — only historical replay and shadow results validate signal quality.

**Signal Feed / operator UI redesign (Phase D, built last).** New **default landing page**, "Signal Feed / Alpha Feed," answering: what token should I look at right now, why, and what evidence supports it? Signal card fields: token symbol/name/address, chain, status (HOT/WATCH/PROFIT_ROTATION/EXIT_WARNING/DEAD), confidence, FlowScore, mcap, liquidity, smart wallets buying, unique entities, largest cluster size, net smart flow, avg smart entry mcap, current mcap, mcap expansion, sell pressure, profit rotation y/n, risk level, last updated.

Every card leads with a plain-English explanation, in this order: why it fired (first), what would invalidate it, what changed since the previous check — evidence is second, raw data is third. Example copy: "36 tracked smart wallets bought $NOVA, but entity clustering estimates 19 unique entities. Net smart flow is +$75k, sell pressure is low, and market cap expanded only 1.4x from average smart entry. This looks like accumulation, not late chase." Rotation copy example: "Wallet group realized profit on $ALPHA, bridged funds through Wormhole, and a linked wallet bought $BETA 65 minutes later. Amount match: 80%. Confidence: probable."

Sections: Hot now / Accumulating / Profit rotation / Exit warnings / New watched tokens / Best performing previous alerts / Worst performing previous alerts. Visual hierarchy: bigger font, fewer columns, larger cards, clear badges, plain explanations, why→evidence→raw ordering, responsive mobile/desktop — tables become **tertiary** evidence, not the main UX.

Nav reorder (replaces the Wave-1 order in §8): 1 Signal Feed (default) → 2 Token Detail → 3 Money Flow → 4 Wallet Graph → 5 Wallets → 6 Alerts → 7 Settings.

### 5d. Wave 4.6 — Dune Query Connector + Multi-Token Wallet Overlap Finder (added 2026-07-06)

**Product framing (binding).** Dune is the best bootstrap/backfill source for wallet-overlap discovery, smart-wallet discovery, and token-trader backfill — it helps *discover* and *validate* candidate wallets. It does **not** replace the 30–60s tracked-wallet monitoring loop: live alerts still come only from FlowRadar's own tracked-wallet pipeline. Dune rows are never trusted blindly and never auto-promote to tracked wallets; they enter as `CandidateWallet` and go through the same validation path as Wave 4.5 connectors.

**Use case.** Given 2–5 token contract addresses, find wallets that traded multiple/all of them — especially early or profitable recurring wallets and co-trading groups — via `CandidateWallet` with `source=dune_token_overlap` → validate → promote only if thresholds pass (pnl_30d ≥ 4000, trades ≥ 8, winRate ≥ 35%, not a router/pool/CEX/bridge, not an obvious sniper/bot unless explicitly allowed).

**Data-access priority (binding).** Dune saved queries + the Dune API are primary. Frontend scraping is fallback-only and **disabled by default** — the design does not rely on fragile scraping.

**Models.** `DuneQuerySource` — id, name, queryId, purpose (`token_overlap`|`token_traders`|`smart_wallet_candidates`|`funding_links`|`entity_cluster_research`), enabled, resultFormat (`json`|`csv`), lastExecutionId, lastRunAt, lastSuccessAt, status, creditsEstimate, parametersJson, outputSchemaJson, notes. `TokenOverlapSearch` / `TokenOverlapWalletResult` / `TokenOverlapGroupResult` (overlap import target). `CandidateWallet.source` vocabulary (Spec §5b) gains `dune_token_overlap`.

**Dune API client behavior.** Store `query_id`; execute via the Dune API; poll execution status; fetch results as JSON or CSV. Latest-cached-result mode saves credits (`DUNE_USE_LATEST_RESULT=true` default); fresh execution is disabled unless `DUNE_EXECUTE_FRESH=true`. Query params: chain, token_address_1..3, start_time, end_time, min_trade_usd, min_tokens_overlap, max_results. Paginate where needed; respect rate limits; cache results locally; never re-execute expensive queries repeatedly. Errors never break the app — they land as a `ProviderSyncState` error row; a missing key yields mode `missing_key` with mock fallback.

**Overlap query row shape (Zod-validated).** wallet_address, chain, token_address, token_symbol, first_buy_time, first_sell_time, buy_count, sell_count, total_buy_usd, total_sell_usd, estimated_pnl_usd, entry_market_cap_usd, tx_hashes, tokens_overlap_count, overlap_group_id?.

**Workers.** `duneQueryWorker` — executes enabled `DuneQuerySource` queries, fetches, Zod-validates rows, stores a raw result snapshot, normalizes useful rows (`source=dune_query`), and never blindly trusts a row. `duneOverlapImportWorker` — imports overlap rows into `TokenOverlapSearch`/`WalletResult`/`GroupResult`, creates `CandidateWallet` rows with `discoverySource=dune_token_overlap`, and hands them to `walletCandidateValidationWorker` (Spec §5b).

**Overlap Finder UI.** Data-source selector: local DB first | Dune query | provider API | hybrid. In Dune mode: paste 2–5 token CAs → call the configured overlap query → import common wallets → show traded-all, bought-all, bought-early-across-multiple, est-PnL-across-selected, recurring co-trader groups, and possible entity clusters. Every Dune result carries a coverage display: query_id, last_run_at, rows_returned, cached-vs-fresh, cap/truncation warning, source confidence.

**Env (added to `.env.example`).** `DUNE_API_KEY`, `DUNE_DEFAULT_OVERLAP_QUERY_ID`, `DUNE_USE_LATEST_RESULT=true`, `DUNE_EXECUTE_FRESH=false`.

**`docs/dune/` templates.** Four parameterized illustrative SQL templates (token_overlap, early_buyer_overlap, recurring_cotraders, token_top_traders), binding params `{{token_1..3}}`/`{{chain}}`/`{{min_trade_usd}}`/`{{start_time}}`/`{{end_time}}`, each requiring saved-query creation in the Dune UI before use — see `docs/dune/README.md`.

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
- **Wave 3** = Phases 6–7: Wallet Graph Finder (BFS, page, viz, exports), MoneyFlowEdge + clustering + rotation + Money Flow page. **→ Wave 3 gate.**
- **Wave 3.5** (added 2026-07-06, §5c) = T40–T43: backtest outcome evaluator + label taxonomy (T40) → historical replay + rule/combined perf + threshold tuning + walk-forward (T41) → shadow mode + Backtest/Shadow pages (T42) → Signal Feed operator UI redesign, default landing, nav reorder (T43). Executes after the Wave 3 gate, before Wave 4.
- **Wave 4** = Phases 8–10: Helius + DexScreener live Solana adapters (docs-verified), BSC scaffold (BscScan + risk stubs), AddressRegistry seeding + tagging. (Tasks 26–30.)
- **Wave 4.5** = External Smart Wallet Source Connectors, §5b (Tasks 34–36).
- **Wave 4.6** (added 2026-07-06, §5d) = Dune Query Connector + multi-token wallet overlap finder: framework+schema+workers+overlap import (T37), Overlap Finder UI + coverage (T38), SQL templates + docs (T39). Depends on Wave 4.5.
- **Wave 5** = Phases 11–12: polish (loading/empty/error states), README, final verify. Original Task 31 (backtest worker + results page) is **removed/superseded** by T40–T42 above — see the superseded note on Task 31 in the plan.

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
