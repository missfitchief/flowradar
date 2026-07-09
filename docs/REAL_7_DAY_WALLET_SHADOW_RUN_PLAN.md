# Real 7-Day Wallet Shadow Run — Plan

**Status:** PLAN ONLY — **do not start the run yet.** Prereq: wallet sourcing complete + imported (see [WALLET_SOURCING_PLAN.md](WALLET_SOURCING_PLAN.md)) and Phase-6 safety checklist all green. This is a **forward, observe-only** run: FlowRadar watches real profitable Solana wallets and records what its signals/confluence would have flagged — **no trading, no alerts acted on, no scoring changes.**

---

## 1. Source used
*(fill at run time)* Primary: **Solana Tracker** `/v2/pnl/leaderboard/top` (`days=30&sort=realized`). Cross-check/dedup: **Birdeye** `/trader/gainers-losers` (`type=30d`). On-chain verifier: **Helius**. Record exact endpoints + query dates.

## 2. Filters used
Record the exact Phase-2 filter values applied: `realizedPnl30dUsd ≥ 4000`, `tradeCount30d ≥ 20`, `activeDays30d ≥ 5`, `volume30dUsd ≥ <value>`, `winRate30d ∈ [0.35, 0.95]`, `avgTradeSizeUsd ≥ 50`, plus exclusions (bot, single-token concentration, dirty data). Note any tuning from the defaults.

## 3. Number of candidate wallets found
*(fill)* Raw leaderboard rows pulled, and rows surviving the Phase-2 filter, per source, and after cross-source dedup.

## 4. Number imported
*(fill)* Rows imported via `POST /api/import` (Path A) — `imported` vs `skipped` vs `errors` from the importer's job result. Target 50–200; start 50.

## 5. Provider-claimed vs locally-verified count
*(fill)* Of the imported set: `locally_verified` (Helius/FIFO agreed), `provider_claimed` (not yet verified), `insufficient_history`, `rejected_dirty`. Verification covers all high-stakes + a ≥20% random sample.

## 6. Worker command / config
Normal speed (**not** `WORKER_FAST`). Live Solana, mock elsewhere. Record verbatim, e.g.:
```
# .env (values are NAMES/flags only — never paste secrets into the report)
MOCK_MODE=false
DUNE_EXECUTE_FRESH=false          # keep cached-only
HELIUS_API_KEY=<set, not printed>
HELIUS_RPS=9                       # sane; within plan limit
# BSC connectors OFF; no private keys; GMGN disabled/status-only

# run
npm run worker          # normal cadence (NOT WORKER_FAST)
```
Record: worker start time (UTC), the job cadences in effect (`walletActivity`, `signals`, `externalConfluence`, discovery/stats), and confirmation BSC/Dune-fresh/trading are all off.

## 7. Daily metrics (capture once per 24h, 7 rows)
| Day | walletActivity cycles | txsIngested | tokens discovered | signals emitted | confluence snapshots | social mentions* | Helius 400 | Helius 429 | crashes/fatal/unhandled | RSS peak (MB) |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | | | | | | | | | | |
| … | | | | | | | | | | |
| 7 | | | | | | | | | | |

\*social mentions only if Telegram/Discord sources are configured (optional; otherwise "n/a").

Also log daily: new signals per rule (A–G), how many fired on **imported** wallets vs discovered ones, and any wallet that went dormant.

## 8. Final 7-day report format
A `REAL_7_DAY_WALLET_SHADOW_RUN_REPORT.md` with:
1. Source + filters + counts (found / imported / verified) — §1–5 filled in.
2. Worker config + uptime + the 7-day daily-metrics table (§7) with totals and trends.
3. Stability: total Helius 400/429, any crash/fatal/unhandled, RSS trend (leak or plateau).
4. Signal behavior: total signals emitted, breakdown by rule, and the share fired on imported (known-profitable) wallets — the core observation.
5. Confluence: snapshots produced (internal LiquidityRisk always; external only if keys set), and any conflict flags.
6. Data quality: provider-claimed-vs-Helius agreement rate on the verified sample.
7. Verdict + next step (tune filters? widen sources? proceed to a scored evaluation?).

## 9. What this run PROVES
- That FlowRadar **ingests and tracks real, independently-profitable Solana wallets** end-to-end at normal speed without crashing (stability under real load).
- **Coverage/latency:** whether, and how quickly, FlowRadar's signals/confluence light up around wallets that are *known* to be good — i.e. does the pipeline *see* smart-money activity it should see.
- Real-world **operational health**: Helius error/limit behavior, memory profile, throughput over a week.
- A **data-quality baseline**: how closely provider-claimed realized PnL matches on-chain (Helius/FIFO) truth.

## 10. What this run DOES NOT prove
- **Not predictive edge / profitability.** Watching known-good wallets forward for 7 days does not show FlowScore predicts future winners, nor that acting on its signals is profitable. That needs the backtest/shadow-outcome evaluator over a longer horizon with outcome labeling — not this run.
- **Not selection-bias-free.** Wallets were selected *because* they were already profitable last 30d (survivorship); past PnL ≠ forward PnL, and mean-reversion is common.
- **Not statistically powered.** 50–200 wallets over 7 days is a smoke/observation window, not a significant sample; no p-values, no confidence intervals.
- **Not a provider-accuracy audit.** Only a sample is on-chain-verified; unverified wallets remain provider-claimed.
- **Nothing about execution.** No trades are placed; this says nothing about slippage, fills, or realized returns of copying.

---

*Forward observation only. On completion, decide whether to (a) tune the Phase-2 filter, (b) widen sources, or (c) graduate to a longer, outcome-labeled backtest/shadow evaluation before any conclusion about edge.*
