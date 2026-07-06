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
