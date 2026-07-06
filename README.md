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

**Solana (Helius)** — set `HELIUS_API_KEY` (see `.env.example`) to enable the live Solana wallet-activity and token-risk adapters (`packages/providers/src/solana/{helius,risk}.ts`). Once set, `MOCK_MODE=false` resolves real Helius calls for SOLANA's `walletActivity` (Enhanced Transactions API, `GET /v0/addresses/{address}/transactions`, mapped to `NormalizedTx`) and `risk` (RPC `getTokenLargestAccounts` + `getTokenSupply` for top-holder concentration; mint/freeze-authority checks are a documented stub — see `TODO(provider)` in `risk.ts`) capabilities, rate-limited to ~9 requests/sec. Without a key, both capabilities report `missing_key` via `getProviderStatuses()` and gracefully fall back to the deterministic mock world rather than crashing. Everything else (BSC activity/risk, market data, token metadata, wallet discovery) remains Wave-4-pending; see the rest of `.env.example` for their env vars.

_Remaining chains/capabilities to be filled in Task 32._
