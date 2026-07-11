# GMGN / Behavior / Runner-Mining Progress Report — 2026-07-11

Branch `feat/gmgn-runner-behavior` (draft [PR #4](https://github.com/missfitchief/flowradar/pull/4), base `feat/pre-public-accumulation`). Claude sole writer; Codex (gpt-5.6-sol, xhigh) read-only adversarial reviewer. NOT merged to main.

## State at a glance
| Task (directive) | Status | Where |
|---|---|---|
| GMGN capability + ingest (Tasks 1-2, prior run) | DONE (not redone) | `packages/providers/src/gmgn/*`, `packages/db/src/gmgn/ingest.ts` |
| Base update onto risk-cache base | DONE | merge `262b947` (conflicts: .gitignore, db index — trivial) |
| Task 2 — candidate buffer | DONE | `6f4897b` + hardening `55cc502` |
| Task 3 — behavior reconstruction | DONE | `0738453` + hardening `55cc502` |
| Task 4 — hold/dump classifier | DONE | `0738453` + hardening `55cc502` |
| Task 5 — receipts/behavior engine | DONE (v1 scope below) | `2897e05` + hardening `55cc502` |
| Task 6 — runner mining 3-6 | **NOT STARTED** | — |
| Active audition scaling (750/1k) | NOT STARTED (gated: risk-cache rollout + daily checkpoint green) | — |
| Stealth enrichment / pre-bond scanner / scan surfaces | NOT STARTED | — |

Full suite on the branch: **1,475 passed / 1 skipped** on `flowradar_test`; typecheck clean; live DB untouched by tests (the new `wallet_behavior_profiles` migration is applied to the TEST DB only — it reaches live only when this branch rolls out).

## Task 2 — candidate buffer
`packages/core/src/candidates/sourceCategory.ts` + `packages/db/src/gmgn/candidateBuffer.ts`. Aggregates GmgnObservation (all command families) + active `fresh_receiver_hot` lineage receivers into the EXISTING `CandidateWallet` table — one row per (wallet, chain, source) preserves all provenance; dedupe by chain+wallet is the grouping. External sources (`birdeye_*`, `solana_tracker_pnl`) keep flowing through `runExternalWalletSourceSync`; `runner_mining:*` slots into the taxonomy when Task 6 lands. The 12 directive categories + `unclassified`; **public KOL/promoter separation is wallet-level** (KOL in any feed → `public_kol` on every provenance row); bot/copytrader detection is exact-token. Bounded: `maxBufferSize` (default 5,000) with deterministic admission (distinct canonical categories, then recency) and **reported** drops (`droppedOverCap`, `preexistingOverCap`, scan-truncation flags). Hard-verified: zero writes to wallet status / WalletStats / subscriptions / validationStatus; chain-specific identity; idempotent monotonic re-runs. 14 tests.

## Tasks 3-4 — behavior reconstruction + hold/dump classifier
Pure `packages/core/src/behavior/{reconstruct,holdClassifier}.ts`, driver `packages/db/src/behavior/reconstruct.ts`, table `wallet_behavior_profiles` (one row per chain+wallet; profile + classification JSON, engine-versioned).
- **Field-level provenance**: `locally_observed` / `locally_computed` / `provider_claimed` (confidence capped at 60, never blended into local fields) / `inferred` / `unknown`. Missing = null + unknown, never fabricated.
- Token positions: exits (partial/full with **threshold-crossing** full-exit timing), holds, repeat entries, received-not-bought, entry mcap where locally known. `localViewTruncated` flag lowers confidence and adds a caveat when the fetch bound cut history.
- Conflicts (provider vs local trade counts, PnL sign/magnitude) are **surfaced, never reconciled**; ≥2 conflicts → `rejected_dirty_data` at confidence 95 (always primary).
- Classifier metrics: first-sell buckets (1m/5m/30m/2h) over **observable-outcome denominators** (aged unsold positions count against fast-flipping), held-after horizons (young positions excluded as unknowable), retained pct; **retention-after-2x/5x and exit liquidity stay null with caveats** (no price/depth series); rug exposure only with outcome data. Labels per the directive list; sample-size gated; `grantsEligibility: false` hard-coded. 15 tests.

## Task 5 — receipts engine (v1)
Pure `packages/core/src/behavior/receipts.ts`: local-evidence-only derivation (trades with slots + tx hashes, transfer edges — no provider labels, no external branding/scraping) of: `same_block_launch_cluster` (launch anchor = first observed trade of ANY side), `single_burst_exit` (post-buy sells only; USD-proxy caveat), `distribution_into_later_buyers` (sell→transfer→buy sequencing enforced), side-wallet tiers (`possible`/`probable`/`strong_onchain_link` — undirected pair identity, self-transfer guard, only known non-dust funding counts; unknown value reported, never $0), `repeated_coordinated_crew` (exact-set v1, evasion caveat), `launch_team_linked_destructive_exit` (funding transfer tx in evidence), `repeat_low_mcap_early_buyer` vs `independent_sharp_trader` (independence = absence-of-evidence caveat), `bot_or_arbitrage` (cadence CV, DCA caveat), `market_maker_or_service`, `one_hit_wonder`, `high_rug_exposure` (outcome-data-only). Every receipt: componentMetrics + exact evidence txs + exampleTokens + independent-token repetition + confidence + caveats + version + dataQuality + https-only path-encoded explorer links. Hard input bounds with reported truncation. `grantsEligibility: false`. 11 tests.

## Codex verdicts
- Round 1 (Tasks 2-5): **0 Critical, 18 Important, 4 Minor**.
- Round 2 fixes (`55cc502`): addressed Important 1b/2/3/4/5/6/7/9/10/12/13(partial: USD-proxy caveat — token-quantity accounting needs amount series)/14/15/17 + Minor 1/3; **documented-as-accepted**: Important 1 (cap admission is not transactional — single-writer worker; pre-existing overflow now reported), 8 (zero-valued counts on empty local views — gated by `insufficient_history`), 11 (hold labels carry example tokens, not per-trade tx hashes — `LocalTradeInput` has no txHash; receipts engine covers tx-level evidence), 16 (crew exact-set evasion — caveated v1), 18 (directive-mandated label names kept; independence/no-promotion caveats added). Test-gap list retained in the review thread for the next hardening pass.

## Task 6 (runner mining 3-6) — NOT started, honestly
Wallet-token full-history reconstruction (Birdeye), repeat-runner/entity mining, observation-only candidate output, and live shadow integration are **not built**. The pure no-lookahead runner-mining engine from the earlier run exists (`packages/core/src/runnermining`) and the receipts/classifier layers already accept `tokenOutcomes` from it, so Task 6 slots in without rework. It needs a dedicated session with live Birdeye budget (~1 rps ceiling on the current plan).

## Boundaries held throughout
No FlowScore/threshold/promotion changes; provider data provider_claimed only; every GMGN wallet observation_only (KOL/promoter classified separately); linked wallets never auto-promoted; no Dune fresh execution; no trading/keys/execution anywhere; buffer size ≠ subscriptions; missing data = unknown.
