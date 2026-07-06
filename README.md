# FlowRadar

FlowRadar is a local-first **Solana + BNB Chain wallet-intelligence dashboard and worker bot**. It surfaces early, "insider-like" token activity by tracking *profitable wallets* — capital rotation, wallet clusters, smart-wallet accumulation, fresh-wallet funding, bridge movement, and money flow — using only public on-chain and market data. It is **analytics only**: not financial advice, not a trading bot, and it never claims to identify or deanonymize real people. Every label it assigns is probabilistic (weak / possible / probable / strong), and nothing it discovers ever executes a transaction.

Token discovery is **wallet-driven by design**: FlowRadar watches wallets you track (imported, or promoted from candidate feeders) and lets *their* behavior surface tokens — it does not scan or rank every newly created token on chain.

---

## Quick start (exact commands — Module 16)

FlowRadar ships two infra modes with **identical application code**. **LITE** is the default and needs no Docker; **FULL** uses Docker Compose for Postgres + Redis + BullMQ.

### LITE mode (default — embedded Postgres, no Docker)

```bash
npm install
npm run db:migrate          # applies existing migrations (idempotent)
npm run db:seed             # loads the deterministic mock world
npm run dev                 # web on http://localhost:5188
npm run worker              # background jobs (separate terminal)
```

`db:migrate` starts an embedded PostgreSQL 16 cluster (from the `embedded-postgres` package's bundled binaries, data in `./.pgdata`, port 5439) on first run — no external Postgres needed. The first run downloads ~50 MB of PG binaries.

### FULL mode (Docker Compose — Postgres + Redis)

```bash
npm install
docker compose up -d        # postgres:16 (5432) + redis:7
# set REDIS_URL and a :5432 DATABASE_URL in .env (see .env.example)
npm run db:migrate
npm run db:seed
npm run dev                 # web on http://localhost:5188
npm run worker
```

FULL mode is auto-detected when `REDIS_URL` is set **or** `DATABASE_URL` points at port 5432; otherwise LITE mode is used. BullMQ (Redis-backed queues) runs the worker jobs in FULL mode; LITE mode runs the same jobs via an in-process inline runner.

### Verify everything

```bash
npm run verify              # typecheck (all workspaces) + vitest + next build
```

> **Full test coverage needs the LITE database up.** The `packages/db` integration
> tests self-skip when Postgres isn't reachable on `:5439`, so `npm run verify`
> (or `npm run test`) on a fresh checkout — *before* `npm run db:migrate` has
> started the embedded cluster — will silently skip them and still exit 0. Run
> `npm run db:migrate` first for the complete suite (865 tests; only the opt-in
> `LIVE_SMOKE` DexScreener test stays skipped).

### Authoring a new DB migration

`npm run db:migrate` applies **existing** migrations idempotently (`prisma migrate deploy`) — safe to run repeatedly, no name needed. To author a NEW migration after changing `packages/db/prisma/schema.prisma`:

```bash
npm run db:migrate:new -- --name your_change_name    # prisma migrate dev --name ...
```

---

## Nav / page map

The sidebar order, top to bottom:

| Page | Route | What it answers |
|---|---|---|
| **Signal Feed** *(default landing)* | `/` | "What token should I look at right now, why, and what evidence?" — plain-English operator cards, not a table. |
| Tokens | `/tokens` | Dense raw table of tracked tokens, sorted by FlowScore. Detail at `/tokens/[id]`. |
| Money Flow | `/flow` | MoneyFlowEdges, bridge matching, profit-rotation, Sankey view. |
| Wallet Graph | `/graph` | BFS wallet-graph finder from a root address; interactive cytoscape viz + CSV/JSON exports. |
| Overlap | `/overlap` | Multi-token wallet overlap finder (which wallets bought N of the same tokens early). |
| Wallets | `/wallets` | Tracked-wallet leaderboard; CSV import at `/wallets/import`. |
| Sources | `/sources` | Source Health — candidate feeders + Dune connector status (live/mock/stub). |
| Alerts | `/alerts` | Fired alerts feed + Telegram test button. |
| Backtest | `/backtest` | Historical replay of signals vs real outcomes; rule/threshold performance. |
| Shadow | `/shadow` | Live signals evaluated against real market data at 15m–7d, observation-only. |
| Settings | `/settings` | Editable thresholds (rules A–G, intervals, connectors) + provider key status. |

---

## What works (mock-first — demoable with zero API keys)

With `MOCK_MODE=true` (the default) and a seeded DB, **everything below runs against the deterministic mock world** — no keys, no network:

- **All pages** render with real data (see the page map above).
- **Signal rules A–G**: A (multi-wallet accumulation), B (sustained accumulation), C (human-vs-bot composition), D (whale conviction), E (fresh-wallet funding→buy), F (profit rotation across a bridge), G (smart-money exit / rug warning).
- **FlowScore** — per-token composite score with a component breakdown.
- **Entity clustering** — union-find over wallet-link evidence; `uniqueEntityCount` vs `smartWalletCount` deflates sybil clusters.
- **Wallet graph finder** — BFS with depth/node/edge caps, do-not-expand on CEX/bridge hubs, interactive viz, CSV + JSON exports.
- **Money flow + Sankey**, bridge deposit↔withdrawal matching, profit-rotation detection.
- **Telegram alert test** — the `/alerts` test button and `POST /api/alerts/test` return `skipped_no_token` gracefully when no bot token is configured.
- **Backtest / Shadow** — historical replay + live shadow evaluation, both render seeded results.
- **Connectors + candidate validation** — external feeders seed `CandidateWallet` rows; the validation pipeline promotes qualifying ones to tracked `Wallet`s.
- **Dune overlap finder** — multi-token overlap search (mock Dune source in `MOCK_MODE`).

### Mock world scenarios (seeded, deterministic)

Seed `20260705`; each scenario is a scripted fixture that fires a specific rule:

| Token | Fires | Scenario |
|---|---|---|
| `NOVA` | Rules A / C / D | Multi-wallet accumulation with a single-funder cluster. |
| `QUIET` | Rule B | Slow, sustained accumulation ramp. |
| `SEED` | Rule E | Fresh wallets funded, then buying. |
| `ALPHA → BETA` | Rule F | Profit rotation across a bridge (deposit↔withdrawal + re-buy). |
| `DUMP` | Rule G | Smart-money exit / distribution. |
| `RUGZ` | risk flags | Honeypot / high-tax / concentration risk fixture. |

---

## What is mocked

`MOCK_MODE=true` is the single switch. When set (the default), **every** provider capability — Solana/BSC wallet activity, market data, token risk, wallet discovery, and all candidate feeders + the Dune overlap source — resolves to the shared `MockProvider` / `MockDuneOverlapSource`, backed by one consistent `MockWorld` (the scenarios above plus ~150 background "noise" wallets). No network calls are made. Set `MOCK_MODE=false` to resolve live adapters where keys are present (see below); capabilities without a live adapter still fall back to the mock world or report their status honestly rather than crashing.

---

## What needs API keys

Set `MOCK_MODE=false` to use live adapters. Missing keys never crash the app — the affected capability reports `missing_key` / `stub` on the Settings and Source Health pages and falls back to mock. Per `.env.example`:

| Env var | Effect when set (`MOCK_MODE=false`) |
|---|---|
| `HELIUS_API_KEY` | **Live Solana** wallet activity (Enhanced Transactions API) + token risk (RPC top-holder concentration). Rate-limited ~9 rps. Without it, Solana activity/risk fall back to mock. |
| `BSCSCAN_API_KEY` | **Live BSC** wallet activity via the unified **Etherscan API V2** (`chainid=56`, `txlist` + `tokentx` merged). Must be an Etherscan-V2 key (legacy BscScan V1 is rejected). Free tier ~3 rps. Swap detection is best-effort. |
| `GOPLUS_API_KEY` | **BSC token risk** (GoPlus `token_security`). **Keyless-live** — the key is *optional*, only raising rate limits. |
| *(none)* — DexScreener | **Market data on both chains** is keyless-live out of the box (`~300 req/min`, default/unconfirmed). `holderCount` is always `null` (not in the API). |
| `SOLANA_TRACKER_API_KEY` | Candidate discovery — Solana PnL leaderboard feeder (primary). |
| `BIRDEYE_API_KEY` | Candidate **evidence** — wallet PnL summary + token top-traders. Evidence-only: consumed by validation / top-trader backfill, does **not** seed candidates directly. |
| `CIELO_API_KEY` | **Stub** — no verified public API; ships as a typed stub (always returns none). |
| `KOLSCAN_API_KEY` / `KOLSCAN_API_BASE` | **Stub** — operator-supplied swap-in point; no network call until a real endpoint is wired. |
| `GMGN_API_KEY` / `GMGN_API_BASE` | **Stub** — operator-supplied swap-in point; same as KOLScan. |
| `DUNE_API_KEY` | Dune saved-query execution for the overlap finder + top-trader backfill. Credit-safe (see below). |
| `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | Real Telegram alert delivery. Without both, alerts are `skipped_no_token`. |
| `BIRDEYE_API_KEY` / `MORALIS_API_KEY` / `BITQUERY_API_KEY` | Reserved for typed BSC provider stubs (swap-in points, no live adapter yet). |
| `DISCORD_WEBHOOK_URL` | Deferred — interface stub only. |

---

## Trust & ethics

- **Probabilistic labels only.** Confidence bands (weak / possible / probable / strong) are shown everywhere; nothing is asserted as certain, and no real-world identity is claimed.
- **Analytics-only, no execution.** FlowRadar never sends a transaction, places an order, or moves funds.
- **Candidates → validate → promote.** External feeders (Solana Tracker, Birdeye, the stubs) write `CandidateWallet` rows. A candidate is **never** counted by the signal engine — smart-wallet counts, FlowScore, signals all read **only promoted, tracked `Wallet`s**. A source's own claimed PnL / win-rate / ROI is never trusted at face value; it must pass validation and be promoted first.
- **Dune credit-safety.** The default serves each query's **latest cached result** (`DUNE_USE_LATEST_RESULT=true`); fresh, billable execution is gated behind `DUNE_EXECUTE_FRESH=true` and off by default.

---

## Known limitations / scale notes

- **Inline per-token risk fetch doesn't scale on live data.** The flow-scoring pass (`packages/db/src/scoring-pass.ts`) calls `getTokenRisk` once per token, serially, inside the scoring loop. Under mock mode this is free, but against a live risk provider (Helius ~9 rps, GoPlus ~1 rps) N tracked tokens means N sequential rate-limited calls per cycle — fine for a handful of tokens, a bottleneck at scale. A production build would batch/cache risk out of the hot loop (e.g. a separate risk-refresh job writing a cached `RiskReport` per token). Deliberately left inline for the MVP.
- **Cold-start thresholds.** Default Rule A (20+ profitable wallets in 30 min) will rarely fire on *live* data until hundreds of quality wallets are tracked. Mock mode demonstrates every rule; thresholds are Settings-editable for live tuning. Expected, not a bug.
- **Single-token threshold tuning.** Rule thresholds are global, not per-token/per-chain; a token with unusual liquidity/age may need manual Settings tuning.
- **PnL is approximate** from public APIs (pre-window inventory, airdrops, internal transfers are invisible). Confidence scoring + CSV override mitigate; the UI always shows confidence.
- **Live top-trader backfill uses Birdeye** (evidence-only endpoints), and several candidate sources (Cielo / KOLScan / GMGN) are **typed stubs** — no verified public API exists yet, so they return nothing regardless of key until an endpoint is wired at their documented swap-in point.
- **"Production-ready" = a robust local single-user app**, not a deployed multi-tenant SaaS. No auth/multi-user.

---

*FlowRadar is an analytics tool. It is not financial advice. Do your own research.*
