# Historical Runner-Wallet Mining — Status Report

**Date:** 2026-07-11 (consolidation run). **Branch:** `feat/pre-public-accumulation`.
**Honest scope statement:** Tasks 1–2 (design + pure engine) are DONE and Codex-approved.
Tasks 3–6 (bulk history reconstruction, repeat-runner mining, observation import, live
shadow feed) are **NOT built yet** — this report records the provider capability probe
and the end-to-end pilot that UNBLOCK them, and the exact remaining requirements. No
machine-readable mining outputs exist yet (they are Task 3–4 deliverables).

## 1. Birdeye capability probe (live, 1 request/endpoint, existing key)

| Endpoint | Result | Meaning for mining |
|---|---|---|
| `/defi/ohlcv` (1H, 24h span) | **200 + data** | Historical price series ARE obtainable — the core Task-3 requirement |
| `/defi/history_price` | **200 + data** | Alternative/backup series source |
| `/defi/txs/token` | **200 + data** | Per-token trade tape (owner field included) |
| `/defi/v2/tokens/top_traders` | **200 + data** | Token-scoped wallet discovery |
| `/defi/v3/token/list` (sortable) | **200 + data** | Token-universe discovery (volume/mcap sorts) |
| `/defi/token_creation_info` | **401 plan-gated** | No launch anchoring from Birdeye → series stay window-relative |
| `/defi/txs/token/seek_by_time` (owner-scoped) | **401 plan-gated** | Convenience loss only — per-wallet history comes from Helius (existing provider) |

**Rate limit reality:** 429s appear at >~1 req/s on this plan. Any bulk job must pace at
≤1 rps and budget requests explicitly (a 1,000-token universe × 1 OHLCV call ≈ 17 min of
pure pacing; per-wallet reconstruction dominates and must be Helius-side).

## 2. End-to-end pilot (7 requests, read-only, no DB writes)

Discovery → 7-day 1H OHLCV (168 points) → current-supply assumption → **approved pure
engine**, on a real token (`DRAM…Y4Cw`):

- Outcome: `reached_1m_mcap`, `seven_figure_runner`; baseline $1.21M → ATH $1.25M
  (multiple 1.03); confidence **medium** with the honest caveat attached verbatim:
  *"baseline = first OBSERVED point (window-relative, not launch-anchored) — runner
  multiples may be understated."*
- Market cap uses `current_supply_assumption` (labeled; historical supply has no source
  yet — unknown stays unknown).
- Liquidity is current-only in the pilot (constant across the series) — illiquidity
  labels are explicitly not meaningful there and were not claimed.
- Top-trader ENTRY reconstruction was blocked by the plan-gated owner-scoped endpoint —
  the production path for Task 3 is **Helius wallet history** (already live in the repo)
  joined against Birdeye OHLCV series.

Pilot script: `scripts/runner-mining-pilot.ts` (re-runnable; paces every request incl.
failures; never prints the key).

## 3. Exact remaining path for Tasks 3–6

- **Task 3 (wallet-token history reconstruction):** per-wallet buys/sells/transfers from
  Helius (existing `walletActivity` provider + ingest), entry contexts from
  `computeEntryContext` over Birdeye OHLCV series (mcap = price × supply assumption,
  `supplySource` labeled; Helius `getTokenSupply` gives current supply). All losers
  included by construction (reconstruction is per wallet, not per winner).
- **Task 4 (repeat-runner mining + bias controls):** needs Task 3 output plus the
  documented sample-size guards; sensitivity at 3 threshold sets. Entity adjustment via
  the existing `EntityCluster` machinery.
- **Task 5 (observation import):** path already exists and is approved
  (`importObservationUniverse` — observation_only, shadow snapshots, never eligible).
- **Task 6 (live shadow feed):** the stealth snapshot pipeline (P2, done) is the
  consumer; qualified wallets simply enter the observed universe.
- **Launch anchoring (optional quality upgrade):** requires either the Birdeye plan tier
  that unlocks `token_creation_info`, or a Dune batch (client exists; needs
  `DUNE_API_KEY` + a launch/OHLCV query; `DUNE_EXECUTE_FRESH=false` stands — cached
  results only). Without it, outcomes stay window-relative with capped confidence —
  honest, already engine-enforced.

## 4. Machine-readable outputs (Task 3–4 deliverables — NOT yet produced)

Runner token universe · wallet-token edge set · wallet quality table · observation
candidate batch · rejection-reason table: **none exist yet**; they are the acceptance
artifacts of Tasks 3–4 and must not be fabricated from the pilot's single token.
