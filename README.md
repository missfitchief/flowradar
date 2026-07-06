# FlowRadar

FlowRadar is a local-first Solana + BNB Chain wallet-intelligence dashboard and worker bot. It discovers early "insider-like" token activity by tracking profitable wallets, capital rotation, wallet clusters, smart-wallet accumulation, fresh-wallet funding, bridge movement, and token flow, using only public on-chain and market data. It is analytics only — not financial advice, not a trading bot, and it never claims to identify or deanonymize real people.

## Quick Start

FlowRadar ships two infra modes with identical application code. **LITE** is the default and needs no Docker; **FULL** uses Docker Compose for Postgres + Redis + BullMQ.

### LITE mode (default, no Docker required)

```bash
npm install
npm run db:migrate
npm run db:seed
npm run dev               # web on http://localhost:5188
npm run worker
```

### FULL mode (Docker Compose: Postgres + Redis)

```bash
npm install
docker compose up -d
npm run db:migrate
npm run db:seed
npm run dev               # web on http://localhost:5188
npm run worker
```

Run `npm run verify` (typecheck + tests + build) to validate the whole workspace at once.

## What works

_To be filled in Task 32 (final polish + Done Bar verification)._

## What is mocked

_To be filled in Task 32._

## What needs API keys

**Solana (Helius)** — set `HELIUS_API_KEY` (see `.env.example`) to enable the live Solana wallet-activity and token-risk adapters (`packages/providers/src/solana/{helius,risk}.ts`). Once set, `MOCK_MODE=false` resolves real Helius calls for SOLANA's `walletActivity` (Enhanced Transactions API, `GET /v0/addresses/{address}/transactions`, mapped to `NormalizedTx`) and `risk` (RPC `getTokenLargestAccounts` + `getTokenSupply` for top-holder concentration; mint/freeze-authority checks are a documented stub — see `TODO(provider)` in `risk.ts`) capabilities, rate-limited to ~9 requests/sec. Without a key, both capabilities report `missing_key` via `getProviderStatuses()` and gracefully fall back to the deterministic mock world rather than crashing. Everything else (BSC activity/risk, token metadata, wallet discovery) remains Wave-4-pending; see the rest of `.env.example` for their env vars.

**Market data (DexScreener, keyless)** — set `MOCK_MODE=false` and market data for BOTH chains works out of the box, no API key required (`packages/providers/src/market/dexscreener.ts`). It calls the public `GET https://api.dexscreener.com/latest/dex/tokens/{tokenAddress}` endpoint (confirmed live this session — the docs site's per-endpoint rate-limit badge didn't render machine-readably, so the ~300 req/min limiter figure this adapter uses is a widely-documented-but-not-verbatim-doc-confirmed default; re-check `docs.dexscreener.com/api/reference` before relying on it for capacity planning), filters the returned pairs to the requested chain, and picks the highest-liquidity pair (ties broken by 24h volume) for `getTokenMarket`; `getTokenPairs` returns every matching pair. Provides `priceUsd`, `marketCapUsd`, `fdvUsd`, `liquidityUsd`, and `vol5m`/`vol1h`/`vol6h`/`vol24h` — **`holderCount` is always `null`**, since DexScreener's pair payload has no holder-count field at all. `getProviderStatuses()` reports this capability `'live'` unconditionally (there's no key to be missing). When a token address isn't a real on-chain mint/contract (e.g. this repo's synthetic mock-world seed addresses), DexScreener returns no pairs and `getTokenMarket` returns `null` — the `marketDataHot`/`marketDataNormal` worker jobs log that as a normal 0-refreshed cycle, not an error.

**BSC (BscScan + GoPlus)** — set `MOCK_MODE=false` and BSC's `walletActivity`/`risk` capabilities resolve to real adapters (`packages/providers/src/bsc/{bscscan,goplus}.ts`). `walletActivity` uses **BscScan via the unified Etherscan API V2** (`https://api.etherscan.io/v2/api?chainid=56&...` — confirmed live this session that the legacy `api.bscscan.com/api` endpoint now hard-rejects with "You are using a deprecated V1 endpoint, switch to Etherscan API V2"), calling both `account/txlist` (native BNB transfers) and `account/tokentx` (BEP-20 transfer events) and merging both into one `NormalizedTx` per tx hash. It needs a **new Etherscan-issued API key** — set `BSCSCAN_API_KEY` (the env var name is unchanged from before the V2 migration, but the value must be an Etherscan-V2-compatible key). Rate-limited to the doc-verified free-tier **3 requests/sec**. Without a key, `walletActivity` reports `missing_key` and gracefully falls back to the mock world. **Swap detection is best-effort/deferred**: BscScan's txlist/tokentx rows carry no decoded swap event (unlike Helius's `events.swap` for Solana), so a DEX swap shows up as its constituent `token_transfer`/`native_transfer`/`contract_interaction` legs rather than a synthesized `swap_leg` pair — see `bscscanMapper.ts`'s file header for the full rationale. `risk` uses **GoPlus's `token_security` endpoint**, which is **keyless-live** (`GOPLUS_API_KEY` is optional, only raising rate limits — live-verified this session with real calls against BSC USDT and a second address with no security data) and reports flags for honeypot, buy/sell tax, unverified source, mintable authority, `cannot_sell_all`, and top-holder concentration. `getProviderStatuses()` reports BSC `risk` as `'live'` unconditionally (no key ever gates it). GoPlus's keyless tier throttles aggressively under bursty load (HTTP 200 with `{"code":4029,"message":"too many requests"}`, no `result` field) — this adapter checks the response `code` before reading `result` and surfaces a clean per-token error (never a crash) when throttled; the rate limiter is tuned to 1 req/sec as a conservative default. Three more BSC-capable providers — **Birdeye, Moralis, Bitquery** — exist only as typed stubs (`packages/providers/src/bsc/stubs.ts`): every method resolves empty/null with no network I/O, existing solely so `getProviderStatuses()` surfaces their swap-in point on the Settings page (env vars `BIRDEYE_API_KEY`/`MORALIS_API_KEY`/`BITQUERY_API_KEY` already reserved in `.env.example`).

_Remaining chains/capabilities to be filled in Task 32._

## External candidate-wallet connectors (Wave 4.5, Spec §5b)

FlowRadar bootstraps its own candidate-wallet universe from 6 external feeders, seeded once as `ExternalWalletSource` rows and visible (enabled state, live/mock/stub status, env-key presence, last sync, candidate counts) on the **Source Health** page (`/sources`). **Critical trust rule:** a `CandidateWallet` row from any of these sources is NEVER counted by the signal engine (smart-wallet counts, scores, signals) until it passes Task 35's validation pipeline and is promoted to a real, tracked `Wallet` — a source's own claimed PnL/win-rate/ROI figures are never trusted at face value.

| Source name | Status | Docs | Env vars |
|---|---|---|---|
| `solana_tracker_pnl` | **Live** (key-gated) | [Solana Traders Leaderboard](https://docs.solanatracker.io/data-api/pnl-v2/leaderboard/solana-traders-leaderboard.md) — `GET https://data.solanatracker.io/v2/pnl/leaderboard/top`, header `x-api-key` | `SOLANA_TRACKER_API_KEY` |
| `birdeye_wallet_pnl` | **Live** (key-gated), evidence-only | [Wallet PnL Summary](https://docs.birdeye.so/reference/get-wallet-v2-pnl-summary.md) — `GET https://public-api.birdeye.so/wallet/v2/pnl/summary`, headers `X-API-KEY` + `x-chain` | `BIRDEYE_API_KEY` |
| `birdeye_top_traders` | **Live** (key-gated), evidence-only | [Token Top Traders](https://docs.birdeye.so/reference/get-defi-v2-tokens-top_traders.md) — `GET https://public-api.birdeye.so/defi/v2/tokens/top_traders` | `BIRDEYE_API_KEY` |
| `cielo` | **Stub** — no public API reference found | in-app "Settings > API key" only, no REST reference discoverable | `CIELO_API_KEY` |
| `kolscan` | **Stub** — no official public API | none found | `KOLSCAN_API_KEY`, `KOLSCAN_API_BASE` (operator-supplied swap-in point) |
| `gmgn_smart_money` | **Stub** — no official public API | none found (site returned 403 to an unauthenticated fetch) | `GMGN_API_KEY`, `GMGN_API_BASE` (operator-supplied swap-in point) |

Notes:
- **Solana Tracker** is the primary Solana PnL leaderboard feeder — `fetchCandidates('SOLANA')` maps the doc-verified leaderboard response directly into `ExternalCandidate` rows (wallet, rank, claimed PnL/win-rate/trade-count/ROI).
- **Birdeye**'s two doc-verified endpoints are single-wallet-lookup and single-token-top-traders respectively — neither is itself a "list of candidate addresses to scan" endpoint, so both `CandidateSourceProvider.fetchCandidates` adapters return `[]` by design; their real value is as evidence providers (`getBirdeyeWalletPnl`, `createBirdeyeTokenTopTraders().getTopTraders`) called with a specific address/token by the validation and top-trader-backfill jobs.
- **Cielo / KOLScan / GMGN**: per the "no hardcoded unofficial endpoints" rule, these three ship as typed stubs only — `fetchCandidates` always resolves to `[]`, status reports `'stub'`, and no network call is ever made regardless of whether an API key is set. KOLScan/GMGN additionally expose an operator-supplied `*_API_BASE` env var as a documented swap-in point (e.g. for an operator's own scraper or a future official API) — setting it changes nothing about this repo's behavior today, since the stub bodies contain no fetch call at all.
- Missing key ⇒ `createXCandidateSource(...)` returns `null` (docs-verified adapters) and `runExternalWalletSourceSync`'s resolver treats that as a graceful per-source skip, never a crash. `getCandidateSourceStatuses()` (analogous to `getProviderStatuses()`) reports `mock`/`live`/`missing_key`/`stub` per source for the Source Health page.
