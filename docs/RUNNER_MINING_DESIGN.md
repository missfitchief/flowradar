# Historical Runner-Origin Wallet Mining — Design & Recon (Task 1)

**Date:** 2026-07-11 (overnight). **Status:** design + data recon; Task 2 (pure engine) implemented alongside.
**Boundary:** public on-chain analytics only. No trading, no private keys, no mempool/front-running,
no identity claims. Every discovered wallet enters as `observation_only`; smart-signal contribution is
zero until the EXISTING trust boundary (candidate validation / operator promotion) approves it.
Shadow-only throughout: FlowScore, signal thresholds, and promotion thresholds are untouched.

## 1. Objective

Mine the historical lifecycle of many Solana tokens to find wallets/entities that REPEATEDLY bought
major runners at very low market cap (primary focus: entry mcap < $20k, configurable), then judge
those wallets across their ENTIRE history (losers, rugs, one-hit wonders included), and monitor the
qualified survivors as shadow signals.

## 2. Data reality (recon, 2026-07-11)

### EXISTS today (canonical, in-repo)
| Asset | Where | Notes |
|---|---|---|
| Token identity | `Token` (schema :326) | chain, address, pair, dex, `firstSeenAt`, `tokenCreatedAt?` (null in live ingest) |
| Market snapshots | `TokenMarketSnapshot` (:364) | price/mcap/fdv/liquidity/vol + ts, indexed (tokenId, ts) — **forward-only from first-seen** (60s hot / 300s normal) |
| Per-trade context | `WalletTokenTrade` (:396) | `priceUsd`, `marketCapAtTrade` — derived from latest LOCAL prior snapshot, 0 when none |
| Transfer truth | Helius provider | full wallet tx history walkable (`before-signature` pagination) |
| Money-flow graph | `MoneyFlowEdge` + honest valuation (Wave A) | valuation provenance statuses already canonical |
| Outcome labeling | `packages/core/src/backtest/evaluate.ts` | pure label automaton (hitPlus50/2x/5x/10x, liquidity hard-failure) |
| No-lookahead replay | `packages/core/src/backtest/replay.ts` | ts<=T filtering conventions to reuse |
| Wallet trust gate | `WalletStatus` + `ObservationProviderSnapshot` | observation import path proven (Task F) |

### MISSING (and how we'll get it — provider-gated, NOT tonight)
| Gap | Consequence | Path |
|---|---|---|
| Historical price/mcap series BEFORE a token entered our DB | can't reconstruct entry mcap for pre-DB buys | Birdeye OHLCV (plan-gated, unverified). Dune: the CLIENT exists (overlap/trader queries) but a historical-OHLCV/runner-universe QUERY + adapter must be **added** and operator-enabled (`DUNE_API_KEY` + queryIds; `DUNE_EXECUTE_FRESH=false` stands) |
| Supply assumptions per token | mcap = price × supply needs a dated supply value | Helius token supply at slot (RPC), else FDV-based assumption labeled as such |
| Launch/pool-creation timestamps | lifecycle anchoring | Pump.fun/Raydium/Meteora program logs via Helius (batch job), Dune |
| ATH mcap / drawdown | outcome labels at scale | derivable from acquired series; never fabricated |
| Bulk token universe (thousands) | mining breadth | provider batch jobs above; universe grows dynamically, **no hardcoded count** |

**Honest consequence:** tonight's implementable slice is the PURE ENGINE (labels + entry-mcap math +
no-lookahead guarantees) over canonical series, fixture-tested. Live backfill of thousands of tokens
requires operator-side provider enablement (Dune key/queryIds or Birdeye OHLCV plan) — recorded as
the module's external dependency, not silently faked with synthetic series (hard rule 16).

## 3. Canonical shapes (Task 2, pure `@flowradar/core/runnermining`)

- `TokenSeriesPoint { ts, priceUsd|null, marketCapUsd|null, liquidityUsd|null, source }` — reuses
  snapshot semantics; `insufficient_data` when the series can't support a judgment.
- `TokenOutcome` — evaluation-only labels: `runner_2x|5x|10x|50x`, `reached_1m|10m|100m_mcap`,
  `seven_figure_runner`, `eight_figure_runner`, `failed_launch`, `rug_or_collapse`,
  `illiquid_untradeable`, `insufficient_data` + peak/drawdown metrics + provenance/confidence.
- `EntryContext` (IMPLEMENTED, Task 2) — per-buy reconstruction: `entryPriceUsd?`,
  `entryMarketCapUsd?`, `entryLiquidityUsd?`, `priceTimestamp?`, `valuationStatus`
  (`nearest_prior_snapshot | unavailable` — historical mining deliberately has NO
  `current_price_estimate`), `valuationConfidence`, `valuationAgeSeconds?`, `bucket`
  (`under_5k … above_1m`, `unknown`). **Task 3 additions (NOT yet implemented):**
  `supplyValue?`, `supplySource`, `valuationSource` — these require the provider-gated
  supply/series backfill and are listed here as forward shapes only.
- Config: `RunnerMiningConfig` — thresholds (runner multiples, mcap milestones, rug collapse pct,
  illiquidity floor, max snapshot age at entry, low-mcap focus ceiling default $20k) — all
  configurable, defaults derived later from observed distributions with sensitivity reporting
  (threshold sets A/B/C), never tuned to force a wallet count.

## 4. No-lookahead architecture (the load-bearing rule)

1. `computeEntryContext(buyTs, series, …)` may only read points with `ts <= buyTs` (nearest PRIOR,
   bounded by max age). Structurally enforced: the function first truncates the series at `buyTs`.
2. `computeTokenOutcome(series, …)` reads the FULL series — it is an OUTCOME, stored separately and
   joined to entries only at evaluation/report time. The wall is ARCHITECTURAL, not procedural:
   `entry.ts` may import only `types.ts` and never the outcome module (static leak-guard test), so
   no entry-time feature can even name an outcome type. The Task-4 wallet-quality model will keep
   this split: feature builders accept `EntryContext[]` only; outcomes join in a separate evaluator
   whose outputs are labels/metrics, never inputs back into feature construction for the same token.
   Outcomes also carry their window honestly: baselines are first-OBSERVED-point relative
   (forward-only history), stated in `dataQuality`, with confidence capped at `medium` unless the
   caller proves the series is launch-anchored (`anchoredAtLaunch`).
3. Property test (the leak detector): for every fixture buy,
   `computeEntryContext(ts, truncate(series, ts))` ≡ `computeEntryContext(ts, fullSeries)`.
4. Unknown stays unknown: missing prior point ⇒ `valuationStatus: 'unavailable'`, bucket `unknown`,
   never $0, never current-price-as-historical (current-price fallback is for LIVE monitoring only
   and is labeled `current_price_estimate` with reduced confidence — never used for historical mining).

## 5. Wallet evaluation & quality model (Tasks 3–4, after data backfill)

Full-portfolio metrics per wallet/entity (ALL evaluable entries, losers included): win rate, realized
PnL, median PnL/token, rug exposure, drawdown, hold times, low-MC entry count/win-rate, PnL
concentration (largest-winner share, top-3 share, one-hit-wonder score), lead time before expansion,
KOL-follow delay, cluster-adjusted counts (linked wallets are ONE entity — reuse
`EntityCluster`/`WalletRelationship`). `EarlyRunnerWalletScore` is SHADOW-ONLY with recorded
components before weighting; output classes per spec (`elite_repeat_early_buyer` …
`rejected_dirty_data`); `dev_or_insider_linked` is descriptive on-chain evidence, never identity.
Sample-size guards: configurable minimums (evaluable tokens, low-MC entries, independent runner wins,
active days; max single-winner concentration, bot-like frequency, rug exposure) with sensitivity
analysis at 3 threshold sets — reported, not silently chosen.

## 6. Bias controls (tests to ship with Tasks 3–4)

survivor bias (universe must include failed/dead tokens by construction — discovery from launches,
not winners-only lists, with the winner-first pass explicitly labeled as such), lookahead (property
tests above), dead-token exclusion, wallet survivorship, unrealized-PnL inflation (realized-first),
wash/self-trading, creator/dev/sniper/bundler filters (provider_claimed markers + local heuristics),
KOL contamination (existing `public_kol` statuses), linked-wallet double counting (entity-adjusted),
illiquid fake markups (liquidity floor at entry AND at exit valuation), transfer-exit recognition
(TRANSFER_OUT before sale = exit-shaped), migration/pool duplication (canonical token lifecycle key).
Every wallet and token carries a data-quality status; incomplete/contradictory ⇒ capped confidence.

## 7. Implementation order (per spec; each task: red tests → impl → Codex → commit → push)

- **Task 2 (TONIGHT):** `packages/core/src/runnermining/` pure engine — outcome labels,
  entry-mcap reconstruction, buckets, no-lookahead property tests, deterministic fixtures.
- **Task 3:** wallet-token full-history reconstruction (DB driver over trades + edges; negative
  outcomes included; entity-adjusted).
- **Task 4:** repeat-runner mining + quality metrics + bias controls + sensitivity reporting.
- **Task 5:** observation-only candidate import (reuses Task F path; provenance = runners caught,
  entry mcaps, outcomes; NEVER signal_eligible automatically).
- **Task 6:** live shadow-signal materialization (qualified wallets buying new low-mcap tokens;
  invalidation reasons; shadow-only).
- **External dependency to unblock 3–6 at scale:** operator enables ONE bulk-history provider
  (Dune key + queryIds, or Birdeye OHLCV plan confirmation). Until then Tasks 3–4 run only over
  tokens already in our DB (forward-only window) — honest, narrow, correctly labeled.

## 8. Codex reviewer focus (standing)

lookahead leakage, survivor bias, dead-token omission, current-mcap-as-historical, entity double
counting, one-hit-wonder inflation, provider-claimed treated as local truth, KOL/copytrader
contamination, illiquid fake PnL, eligibility bypass.
