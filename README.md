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

_To be filled in Task 32._
