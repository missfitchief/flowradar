# Wallet Universe — win_rate Enrichment Report

**Run:** 2026-07-09. **Status:** enriched + import-approved CSVs produced. **NOT imported. Shadow run NOT started.** All metrics **provider-claimed, unverified on-chain** (nothing marked `locally_verified`).

**Goal:** turn the 670-wallet universe into an **import-ready 500-wallet CSV** by filling the missing `win_rate` on the 516 Birdeye-only rows (which the importer would otherwise skip).

## Output files (scratchpad)
| File | Rows | Purpose |
|---|---|---|
| `wallet-universe-combined-enriched.csv` | 670 | full universe, every row now has `win_rate` |
| **`wallet-universe-import-approved-500.csv`** | **500** | import-ready subset (exact importer header, all constraints pass) |

---

## Report

1. **Input wallets:** **670** (`wallet-universe-combined-operator-review.csv`).
2. **Birdeye-only rows needing enrichment:** **516** (blank `win_rate`, tagged `incomplete_provider_stats`).
3. **Enrichment endpoint used:** `GET https://public-api.birdeye.so/wallet/v2/pnl/summary?wallet=<addr>&duration=30d` — `win_rate` read from `data.summary.counts.win_rate` (a 0–1 fraction). Only `win_rate` was filled; each wallet's existing `realized_pnl_30d / unrealized_pnl_30d / trade_count_30d / avg_trade_size_usd` were **preserved** from Batch 002.
4. **API key / plan status:** `BIRDEYE_API_KEY` (already provisioned). The wallet-PnL endpoint **was accessible on the current plan** (not Premium-gated for this key). 516 calls, throttled ~1 req/1.3 s with 429 backoff — **0 plan-blocks, 0 persistent rate-limits.**
5. **Enriched successfully:** **516 / 516** (100%).
6. **Still incomplete:** **0** (none required the `incomplete`/exclude fallback).
7. **Excluded and why:** **170** — solely the 670 → 500 **import cap**, dropping the lowest-priority tail (win_rate artifacts beyond the cross-source tier, extreme-HF wallets, and lowest realized). **0** excluded for missing win_rate, invalid address, or dirty data.
8. **Final import-approved count:** **500.**
   - By priority tier: **48** `cross_source_confirmed` · **63** Solana-Tracker non-artifact · **389** Birdeye-enriched non-artifact · 0 other. (`birdeye_enriched_winrate` tag added to all 516 enriched rows.)
9. **`realized_pnl_30d`** (USD) — **min $43,044 / median $88,823 / max $1,659,760.**
10. **`trade_count_30d`** — **min 22 / median 520 / max 56,026.**
11. **Suspicious win_rate artifacts (`winrate_provider_artifact`, ≥0.99) in the approved 500:** **21** — all inside the `cross_source_confirmed` tier (kept for two-provider confirmation despite the 100%-win-rate flag; spot-verify before trusting).
12. **Exact import command (DO NOT RUN — awaiting your approval):**
    ```
    # dev server running + DB reachable; importer .toUpperCase()s chain, so 'solana' is accepted
    curl -sS -F "file=@<scratchpad>/wallet-universe-import-approved-500.csv" \
      http://localhost:<web-port>/api/import
    ```
    (or upload `wallet-universe-import-approved-500.csv` via the `/wallets/import` UI). Import upserts each as `Wallet(isWatched=true)` + inserts `WalletStats(source='csv')`.

---

## Prioritization applied (import-approved ordering)
1. `cross_source_confirmed` (appeared in both Solana Tracker + Birdeye) → 2. Solana-Tracker wallets with **non-artifact** win_rate → 3. Birdeye wallets with **enriched** win_rate → 4. remainder. Within a tier, **extreme-HF wallets (>10,000 trades/30d) sink**, then larger realized first. Bots (>60,000 trades/30d) excluded entirely (0 present).

## win_rate distribution in the approved 500 (provider-claimed)
| <0.3 | 0.3–0.5 | 0.5–0.7 | 0.7–0.99 | 0.99–1.0 (artifact) |
|---|---|---|---|---|
| 224 | 63 | 83 | 109 | 21 |

> **Read before importing:** 224 wallets show `win_rate < 0.3` (some exactly 0). These are **real provider values, not errors** — realized-profitable wallets with low hit rates (asymmetric payoff: few big wins, many small losses). They were kept because they clear the realized-PnL and trade-count floors. Verify a sample on-chain (Helius/FIFO) before trusting any provider PnL/win-rate, and re-check the 21 artifacts.

## Rules honored
No app code changed · no import run · no shadow run · no trades · no private keys · no BSC · no Dune fresh (`DUNE_EXECUTE_FRESH=false` untouched) · public API only (authenticated with the operator's provisioned key, never printed/committed) · **no win_rate fabricated** (every value came from Birdeye's `counts.win_rate`) · nothing marked `locally_verified`.
