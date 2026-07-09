# Wallet Batch 001 — Solana Tracker (30d realized PnL ≥ $4,000)

**Collected:** 2026-07-09. **Status:** CSV produced, **NOT imported.** Do not import or run the shadow test yet.
**Output CSV:** `scratchpad/solana-tracker-wallets-30d-ge-4000.csv` (154 rows; ephemeral scratchpad — move into the repo if you want it version-controlled).
**All metrics are provider-claimed (Solana Tracker), unverified on-chain.**

---

## Report

1. **Source used:** Solana Tracker — Data API, PnL v2 **Solana Traders Leaderboard**. (Primary per [WALLET_SOURCING_RESEARCH.md](WALLET_SOURCING_RESEARCH.md); Birdeye/Dune not needed this batch.)

2. **Exact endpoint + params (paginated via `pagination.nextCursor`):**
   ```
   GET https://data.solanatracker.io/v2/pnl/leaderboard/top
       ?days=30&sort=realized&direction=desc&limit=100
       &minTrades=20&minDays=3&excludeArbitrage=true
       &maxSingleTokenPct=90&pnlMode=strict
   Header: x-api-key: <SOLANA_TRACKER_API_KEY>   (never printed/committed)
   ```
   Native filters used: `minTrades=20` (trade-count floor), `minDays=3` (rejects one-day bursts), `excludeArbitrage=true` (drops arb/wash), `maxSingleTokenPct=90` (rejects one-token-lucky wallets). Matches the in-repo client `packages/providers/src/candidates/solanaTracker.ts`.

3. **API key / plan needed:** **Yes** — `SOLANA_TRACKER_API_KEY` (header `x-api-key`). It was already provisioned in `.env`; the **free tier sufficed** (10 API calls; free tier = 2,500 req/mo, 3 rps). Key value never printed or committed. No paid plan required for this batch.

4. **Rows fetched:** **938** (the leaderboard's cursor pagination ended after 938 rows — i.e. the endpoint exposes ~938 top wallets, all far above the $4k floor).

5. **Rows passing filter:**
   - **938** cleared the literal floor (`realized ≥ 4000` AND `trade_count ≥ 20` AND valid address — every fetched row cleared it, since the leaderboard is top-of-list).
   - **154** remained after excluding **automated MM/HF bots** (see #9).

6. **Rows written to CSV:** **154** (within the 50–200 target; the non-bot pool was exhausted at 154 when pagination ended — not capped).

7. **realized_pnl_30d (USD) — min / median / max:** **$210,702.85 / $388,452.66 / $2,161,355.98**.

8. **trade_count_30d — min / median / max:** **26 / 1,075 / 56,026**.

9. **Rejected rows and reasons:**
   | Reason | Count |
   |---|---|
   | `automated_bot` — >2,000 trades/day (automated MM/HF; treated as "spam" per your reject-spam clause) | **784** |
   | invalid Solana address | 0 |
   | realized < $4,000 | 0 |
   | trade_count < 20 | 0 |
   | dirty/impossible data | 0 |
   | duplicate address | 0 |
   | no computable win rate | 0 |

   > **Why the bot exclusion:** the raw top-of-leaderboard is dominated by market-maker bots — the top 3 wallets do **74,000–76,000 trades/day** at $7–10M realized. Those clear the numeric floor but are not copy-tradeable and are automated ("spam" in spirit), so they were excluded. Threshold = >2,000 trades/day; adjustable. 30 of the 154 kept wallets are "aggressive" (500–2,000 trades/day) — flagged for your review.

10. **Exact next step to import (DO NOT RUN YET — awaiting your approval):**
    - **Via API** (dev server running, DB reachable; the importer `.toUpperCase()`s `chain`, so `solana` is accepted):
      ```
      curl -sS -F "file=@scratchpad/solana-tracker-wallets-30d-ge-4000.csv" \
        http://localhost:<web-port>/api/import
      ```
    - **Via UI:** open `/wallets/import` and upload the CSV.
    - Import upserts each as `Wallet(isWatched=true)` + inserts `WalletStats(source='csv')` (provider-claimed, treated as authoritative — Phase-3 Helius/FIFO verification is then a read recorded in `tags`).

---

## Field mapping used (provider → CSV)
`wallet_address = trader.wallet` · `chain = solana` · `realized_pnl_30d = period.realized` · `unrealized_pnl_30d = 0` (the leaderboard's `ending.pnl` is 0 for this window — realized-only) · `pnl_30d = realized + unrealized = realized` · `win_rate = (top-level winRate, or period.days.winRate when top-level is 0/missing) ÷ 100`, clamped [0,1] · `trade_count_30d = counts.trades` · `avg_trade_size_usd = period.volume ÷ counts.trades` · `tags = solana_tracker|provider_claimed|pnl_30d_ge_4000|operator_pending_review` · `source = solana_tracker_pnl`.

## Data-quality caveats (read before importing)
- **These are big-whale wallets, not $4k-band.** The $4,000 was a *floor*; sorting by realized-desc surfaces the largest — every row here is **≥ $210k realized**. Solana Tracker's leaderboard only exposes ~938 top wallets, so the $4k–$50k "copy-tradeable mid-band" is **not reachable** from this endpoint. If you want that band, it needs a different approach (Birdeye gainers-losers, a Dune query, or a per-token seed) — call it **Batch 002**.
- **62 of 154 rows report `win_rate = 1.0` (100%).** Implausible as a true per-trade win rate over 100+ trades — a **provider methodology artifact** (likely profitable-closed-tokens / total-closed = 1). Flagged, `operator_pending_review`; **verify a sample against on-chain (Helius/FIFO) before trusting any PnL or win rate.**
- **All provider-claimed, none on-chain-verified.** Per the plan's Phase 3, verify a ≥20% sample (and any high-stakes wallet) via Helius before a shadow run.

## Rules honored
No app code changed · no import run · no shadow run · no trades · no private keys · no Dune fresh (untouched, `DUNE_EXECUTE_FRESH=false`) · public API only (authenticated with the operator's provisioned key) · no `.env`/secrets printed or committed.
