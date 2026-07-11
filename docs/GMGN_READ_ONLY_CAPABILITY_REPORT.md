# GMGN Read-Only Capability Report

**Date:** 2026-07-11. **CLI:** `gmgn-cli@1.5.2`. **Auth:** configured (`config --check` exit 0 — key
present; value never inspected/printed). **Method:** `gmgn-cli <family> --help` inspected before every
call; 13 tiny read-only probes (limit ≤ 5, paced ~0.7 rps) via `node <dist/index.js>` (Node 24 refuses
to `spawn` a `.cmd` without a shell — the real provider will invoke the resolved JS entry directly, no
shell, which is also the safer allowlist surface).

**13 read-only commands were PROBED LIVE and all returned data with the operator's key.** A 14th,
`market signal`, is documented from `--help` only (read-only per the CLI; signal types 1–18, ≤50
results/group) and is on the allowlist but was **not separately probed** — it is the one matrix row
below without live probe evidence, marked accordingly. No forbidden family was invoked. Chains for every
command: `sol / bsc / base / eth` (some also `robinhood`) — **this branch uses `sol` only** (rules 14/15).

## Command matrix (probed)

| Family / command | Address-bearing? | buy/sell/transfer split | Pagination | Max limit | Timestamps | KOL/label field |
|---|---|---|---|---|---|---|
| `track smartmoney` | **YES** (`maker`, `base_address`) | **YES** (`side`, `is_open_or_close`) | none (page-size only) | 200 | `timestamp` (per trade) | `maker_info` |
| `track kol` | **YES** (`maker`) | **YES** (`side`) | none | 200 | `timestamp` | `maker_info` (KOL) |
| `track follow-wallet` | YES (`--wallet` filter) | YES (`side`) | `next_page_token` | 100 | per trade | — |
| `market trenches` | token-level | n/a | none (per-category) | 80/cat | `created_timestamp` | `smart_degen_count`, `renowned_count` |
| `market trending` | token-level | n/a | none | 100 | interval-based | filter tags |
| `market signal` (help-only, NOT probed) | token-level | n/a | groups | 50/group | trigger ts | signal types 1–18 |
| `token info` | token | n/a | n/a | 1 | `creation_timestamp`, `open_timestamp`, `migrated_timestamp` | `launchpad*`, `og` |
| `token security` | token | n/a | n/a | 1 | n/a | honeypot/renounced/tax/lock flags |
| `token pool` | token | n/a | n/a | 1 | `creation_timestamp` | `creator`, `exchange`, reserves |
| `token holders` | **YES** (`address`) | **YES** (buy/sell/transfer_in/out counts+amounts) | order-by | 100 | `start/end_holding_at`, `last_active_timestamp` | `wallet_tag_v2`, `tags`, `is_suspicious`, `twitter_*` |
| `token traders` | **YES** (`address`) | **YES** (same rich per-wallet fields as holders) | order-by | 100 | holding timestamps | `wallet_tag_v2`, `tags` |
| `portfolio holdings` | per `--wallet` | history buys/sells/transfers counts | `next` cursor | 50 | `start/end_holding_at`, `last_active_timestamp` | `wallet_token_tags` |
| `portfolio stats` | per `--wallet` (multi) | `buy`/`sell` aggregates | n/a | multi-wallet | `last_timestamp` | `pnl_stat`, `common` |
| `portfolio activity` | per `--wallet` | **YES** (`event_type`, `--type buy/sell/transferIn/…`) | `next` cursor | page-size | `timestamp` (per event) | `launchpad*` |

## Key field availability (verified from live shapes)

- **Wallet addresses ARE exposed** on smartmoney/kol (`maker`), holders/traders (`address`,
  `account_address`), and portfolio (via `--wallet`). Enables direct observation ingest.
- **Buy/sell/transfer distinguished:** trade feeds carry `side` + `is_open_or_close`; holders/traders
  carry `buy_*`/`sell_*`/`transfer_in/out` counts and amounts; activity carries `event_type` and a
  `--type buy/sell/transferIn/transferOut` filter.
- **Provider PnL / win-rate / trade counts:** holders/traders expose `realized_profit`, `realized_pnl`,
  `unrealized_profit`, `total_cost`, `buy_tx_count_cur`, `sell_tx_count_cur`, `avg_cost`, `avg_sold`.
  `portfolio stats --period 30d` returns `realized_profit`, `realized_profit_pnl`, `buy`, `sell`,
  `bought_cost`, `sold_income`, `pnl_stat` — **30d statistics exist.**
- **USD values** present (`amount_usd`, `usd_value`, `cost_usd`, `price_usd`).
- **Timestamps** are Unix per-row (`timestamp`, `last_active_timestamp`, `start/end_holding_at`,
  `creation_timestamp`) — freshness is queryable, not just "now".
- **Provider labels:** `wallet_tag_v2`, `tags`, `maker_info`, `is_suspicious`, `is_new`, and
  trenches `smart_degen_count`/`renowned_count` — these are **provider-CLAIMED**, mapped to
  `provider_claimed` trust and (for KOL/promoter tags) `public_kol`/`public_promoter` status ONLY.
- **Pagination:** cursor-based on follow-wallet (`next_page_token`), portfolio holdings/activity
  (`next`); the trade feeds are page-size only (no historical cursor) → time-bounded polling.

## Rate limits
No 429 across 26 paced probe calls (~0.7 rps). GMGN plan limit is ~1 req/s class (consistent with the
Birdeye tier). Production provider budgets: per-command caps + Retry-After + exponential backoff (Task 2).

## Trust mapping (enforced downstream)
Every GMGN-discovered wallet → `observation_only`, provider metrics → `ObservationProviderSnapshot`
(`provider_claimed`), **zero smart votes** (status gate), no automatic WalletStats/eligibility. KOL/
promoter-tagged wallets may take `public_kol`/`public_promoter` status (crowd-arrival analysis only —
never early-smart eligible).

## Verdict
**GMGN read-only integration is UNBLOCKED.** Proceeding to Task 2 (real query-only provider + raw
observation ingest, test-DB first) with the exact command contracts documented above.
