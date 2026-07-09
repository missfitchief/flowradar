# Wallet Universe (500+) — Plan & Batches

**Built:** 2026-07-09. **Status:** combined CSV produced for **operator review**. **NOT imported. Shadow run NOT started.** All metrics **provider-claimed, unverified on-chain.**

**Target:** ≥ 500 unique Solana wallets. **Result: 670 unique — target met.**

## Output files (scratchpad)
| File | Rows | Source |
|---|---|---|
| `wallet-universe-batch-001-solana-tracker.csv` | 154 | Solana Tracker PnL leaderboard (Batch 001) |
| `wallet-universe-batch-002-birdeye.csv` | 564 | Birdeye `/trader/gainers-losers` 30d (Batch 002) |
| `wallet-universe-batch-003-dune.csv` | 0 (header only) | Dune — **blocked** (see below) |
| **`wallet-universe-combined-operator-review.csv`** | **670** | deduped merge, importer header |

---

## Batch details

### Batch 001 — Solana Tracker (154)
`GET data.solanatracker.io/v2/pnl/leaderboard/top?days=30&sort=realized&direction=desc&minTrades=20&minDays=3&excludeArbitrage=true&maxSingleTokenPct=90` (key `SOLANA_TRACKER_API_KEY`, free tier). 938 fetched, 784 automated MM/HF bots excluded (>2,000 trades/day), 154 kept. Realized **$210k–$2.16M** (top-of-leaderboard whales). Has `win_rate` (but 62 report 1.0 = artifact). See [WALLET_BATCH_001_SOLANA_TRACKER.md](WALLET_BATCH_001_SOLANA_TRACKER.md).

### Batch 002 — Birdeye gainers-losers (564)
`GET public-api.birdeye.so/trader/gainers-losers?type=30d&sort_by=realized_pnl&sort_type=desc` (key `BIRDEYE_API_KEY`, throttled ~1 req/1.3s, offset-paginated; endpoint exposes ~600 wallets). Fields: `address, realized_pnl, unrealized_pnl, volume, trade_count` — **no `win_rate`** → every Batch-002 row is tagged `incomplete_provider_stats`. Filters: `realized_pnl ≥ 4000`, `trade_count ≥ 20` (36 rejected below), reject `>60,000 trades/30d` (bot; 0 hit), valid Solana address. Realized **$40k–$1.44M** (median $67k) — a more copy-tradeable mid-range than Batch 001.

### Batch 003 — Dune (0 rows, blocked)
**No `DUNE_API_KEY` is provisioned**, there is no saved wallet-PnL `queryId`, and fresh execution is forbidden (`DUNE_EXECUTE_FRESH=false`, per your rules). A cached read is therefore impossible right now. To unblock: provision `DUNE_API_KEY` (min "Read" scope) + save a wallet-PnL query in Dune and record its `queryId`. A starter query template already ships at [docs/dune/solana_wallet_pnl_30d.sql](dune/solana_wallet_pnl_30d.sql) (illustrative; verify the SQL before trusting it). Public community dashboards you can manually export from (unverified): `dune.com/couldbebasic/top-traders`, `dune.com/queries/3514694`, `dune.com/webtester5/solana-wallet-pnl`.

### Batch 004 — not needed
001 + 002 already cleared 670 unique; the optional Solana-Tracker/Birdeye per-token sweep was skipped.

---

## Combined CSV — merge rules applied
Deduped by `wallet_address`. For a wallet in both sources, the **Solana Tracker** record is kept as the base (it carries `win_rate`), and Birdeye provenance is merged into tags. Every row's tags include `provider_claimed` + `operator_pending_review`, plus:
- source tags: `solana_tracker` and/or `birdeye` (Dune contributed none),
- `cross_source_confirmed` when a wallet appeared in both (48 wallets),
- `winrate_provider_artifact` when `win_rate ≥ 0.99` (implausible 100%),
- `incomplete_provider_stats` when `win_rate` is missing (all Birdeye-only rows).

**Nothing is marked `locally_verified`** — no Helius/FIFO verification has run (per your rule).

---

## Report

1. **Wallets per source:** Batch 001 (Solana Tracker) = **154**; Batch 002 (Birdeye) = **564**; Batch 003 (Dune) = **0** (blocked).
2. **Duplicates removed:** **48** (cross-source, kept once, tagged `cross_source_confirmed`).
3. **Final unique wallet count:** **670**.
4. **Distribution of `realized_pnl_30d`** (min $39,943 / median $81,326 / max $2,161,356):
   | 4k–10k | 10k–50k | 50k–100k | 100k–500k | 500k–1M | ≥1M |
   |---|---|---|---|---|---|
   | 0 | 134 | 257 | 221 | 46 | 12 |
   *(none in 4k–10k — both leaderboards bottom out ~$40k, so the universe is effectively ≥$40k realized.)*
5. **Distribution of `trade_count_30d`** (min 22 / median 436 / max 56,026):
   | 20–100 | 100–500 | 500–2k | 2k–10k | ≥10k |
   |---|---|---|---|---|
   | 74 | 287 | 209 | 75 | 25 |
6. **Suspicious `win_rate` (`winrate_provider_artifact`, ≥0.99):** **64**.
7. **Incomplete stats (`incomplete_provider_stats`, no win_rate):** **516** (all Birdeye-only rows).
8. **Reached 500 unique?** **YES — 670.**
9. **Recommendation: import a filtered/enriched subset — do NOT blind-import all, and do NOT collect more (target met).** Reasoning:
   - **`win_rate` gap blocks a clean full import.** The importer requires `win_rate ∈ [0,1]`; the **516 Birdeye rows have blank `win_rate` and would be skipped** on import. So "import all" today would silently land only the ~154 win_rate-complete rows. Fix before import by **enriching `win_rate`** for the Birdeye set (Birdeye `/wallet/v2/pnl/summary` per wallet — throttled, ~10 min, may need a paid tier; or Helius/FIFO), **or** import the win_rate-complete subset first and enrich the rest.
   - **Spot-verify the 64 `winrate_provider_artifact` wallets** (100% win rate is implausible) and a ≥20% random sample against on-chain (Helius/FIFO) before trusting any PnL.
   - The universe is **≥$40k realized** (not $4k-band); acceptable for a movement-tracking shadow run, but note it skews to larger wallets.
   - Suggested path: **enrich → filter (drop artifacts/unverifiable) → import the surviving subset → 7-day shadow run.**

---

## Rules honored
No app code changed · no import run · no shadow run · no trades · no private keys · no BSC · **no Dune fresh** (`DUNE_EXECUTE_FRESH=false` untouched; Batch 003 left blocked rather than executing) · public APIs only (authenticated with the operator's provisioned keys) · no `.env`/secrets printed or committed · nothing marked `locally_verified`.
