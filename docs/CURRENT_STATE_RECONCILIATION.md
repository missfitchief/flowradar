# Current-State Reconciliation (Phase 0 audit)

**Audited:** 2026-07-11, from git + code + tests + live DB directly (no narrative trust).
**Branch:** `feat/pre-public-accumulation` @ `7b1cd8e` = `origin/feat/pre-public-accumulation`. Tree clean.
**main:** local `204314b` (1 ahead of `origin/main` `cfb32ed` — an unpushed doc commit from the prior writer session; not this branch's concern).
**Open PR:** [#3](https://github.com/missfitchief/flowradar/pull/3) draft, head = this branch. **Migrations:** 23 (latest `20260711001059_observation_provider_snapshot`). **Worker registry:** 24 jobs in `apps/worker/src/index.ts` (incl. `lineageExpansion`, `monitoringScheduler`, `bridgeFlow`, `profitRotation`, `socialIngest`, budgeted `walletActivity`).
**Env booleans:** HELIUS/SOLANA_TRACKER/BIRDEYE keys SET; DUNE/GMGN/TELEGRAM unset; `MOCK_MODE=false`; `DUNE_EXECUTE_FRESH=false`. **Processes:** embedded Postgres cluster only (no workers/dev servers running).
**Databases on cluster:** `flowradar` (live) and `flowradar_test` (isolated) — distinct, both present.

## Live DB census (queried 2026-07-11)

| Metric | Value |
|---|---|
| Wallet by status | `observation_only` **647** · `signal_eligible` **1** |
| WalletStats by source | `csv` **1** (nothing fabricated; provider claims live in the shadow model) |
| Lineage roots | **30** (dynamic import, never hardcoded) |
| Monitoring subscriptions by tier (all active) | `root_permanent` **30** · `fresh_receiver_hot` **120** |
| Flow edges by actionType | `transfer` **1,621** (0 bridge/cex/swap edges yet) |
| Flow edges by valuationStatus | `current_price_estimate` **1,126** · `unavailable` **495** · **0** unknown-as-zero, 0 nearest_prior (no local market snapshots exist to price against — honest) |
| Relationships by kind/band | `first_funder`/probable **131** (0 direct_funding, 0 strong — see P1 note) |
| Fresh receivers | 120 `fresh_receiver_hot` subscriptions |
| Bridge correlations | **0** (no bridge-type edges in live data yet) |
| Frontier (LineageExpansionNode) | `done` **160** · 0 pending / in_progress / error |
| Observation universe | 647 observation wallets; **500** `ObservationProviderSnapshot` rows (389 birdeye / 63 solana_tracker / 48 multi_source) |
| Accumulation (stealth) snapshots | **table does not exist** (see P) |
| Runner-mining tables | **do not exist** (see Q) |
| GMGN observations | **0** (`TokenConfluenceSnapshot` empty; no GMGN auth) |
| Shadow outcomes | 0 (`BacktestResult` 0, `BacktestRun` 0, `Signal` 0, `ProfitRotationSignal` 0) |
| Tokens / trades / market snapshots | **0 / 0 / 0** — the live DB holds wallet/lineage data only; no token-trade ingestion has run since the clean reset |
| AddressRegistry | 24 · Candidates 0 · SocialSource 2 / mentions 0 |

## Capability matrix

| # | Capability | Status | Evidence (commit · files · tests · live DB) |
|---|---|---|---|
| A | Trust boundary | **DONE** | `20260710163955` migration; `packages/core/src/wallets/status.ts` (`isSignalEligibleStatus` = the single gate consumed by `aggregateWindow`); static guards `dunecandidateTrustBoundary.test.ts`, `aggregateStatusGate.test.ts`. Live: exactly **1** signal_eligible wallet; imports/enrollment never changed it (per-address proofs ran at import time). |
| B | Root importer | **DONE** | `scripts/import-root-wallets.ts` + `packages/core/src/lineage/parseRootWalletFile.ts` (+tests). Live: 30 roots + 30 `root_permanent` subs; EVM parked to sidecar. |
| C | Test/live DB isolation | **DONE** | `afbbb84`→`2d877f8`; `packages/db/src/testDb.ts` (fail-closed `resolveDatabaseUrlForEnv`), `test/vitestGlobalSetup.ts` (creates `flowradar_test`, `migrate deploy` same migrations); 14 tests (`packages/db/test/isolation/`). Live: `flowradar_test` exists on cluster; every full verify this window ran through it with **byte-identical live census** before/after. |
| D | Transfer valuation | **DONE** | `12a00bf`…; `packages/core/src/lineage/valuation.ts`, `packages/db/src/lineage/resolveValuation.ts` (+tests). Live: all 1,621 edges carry a status; **0 unknown-as-zero**. Caveat: only `current_price_estimate`/`unavailable` appear because the live DB has no historical snapshots — correct behavior, not a gap in the engine. |
| E | Revaluation job | **DONE** | `3463991`…; `packages/db/src/lineage/revaluateEdges.ts` (bounded, cursor-resumable, idempotent; reopens nodes on newly-valued edges) + `scripts/revaluate-smoke.ts`. Live evidence = the valuation distribution above (produced by its live run). |
| F | Direct receiver enrollment | **DONE** | `7631936`/`7a5f791`/`9b7906a`; `packages/db/src/lineage/enrollReceiver.ts` + `lineageClassify.ts` (incl. `unknown ≠ dust`). Live: **131 receivers enrolled**, all observation_only, 0 auto-eligible. |
| G | First-gas-funding | **DONE** | Raw-SOL gas path (`usdUnavailable`-gated, bounds `gasFundingMinSol..MaxSol`, activation window) in `lineageClassify.ts`; tests in `lineageClassify.test.ts`. Exercised in the Wave-B live smoke (part of the 131). |
| H | Relationship persistence | **DONE** (code) / live distribution narrow | `WalletRelationship` model; honest value math (`valuedUsd`, service legs excluded, `unknownValueTxCount` column). Live: 131 rows, **all `first_funder`/probable** — no `direct_funding` and no strong band yet (single-pass history: every qualifying inbound was a first meaningful inbound; strong needs repeat interactions/activation evidence). P1 examines this distribution; no threshold changes. |
| I | Monitoring lifecycle | **DONE** (code+tests+smoke) / not yet in steady-state operation | `b2aa4dc`…`74099d4`; `runMonitoringScheduler.ts` + `monitoringSchedule.ts` (tierPriority column, backoff, claims, hot-expiry, cold demotion; 24 tests) + worker job. Live: 150 subs by tier; hot-expiry/cold transitions will only fire when a worker actually runs (none running now). |
| J | Lineage scheduler/frontier | **DONE** | `LineageExpansionNode` frontier (cursor resume, stop reasons). Live: 160 nodes all `done`, 0 error. |
| K | Bridge correlation | **PARTIAL — code DONE (MVP Task 23), live UNEXERCISED** | `apps/worker/src/jobs/bridgeFlow.ts` → `runBridgeFlow` (bridge_deposit↔bridge_withdrawal pairing, 95–105% + <60m). Live: 0 bridge-type edges exist, so 0 correlations — no live validation possible until ingestion produces bridge legs. |
| L | Profit rotation | **PARTIAL — code DONE (MVP), live UNEXERCISED** | `packages/core/src/rotation/matcher.ts` + `profitRotation` job. Live: 0 rotation signals — there are **0 trades** in the live DB post-reset; nothing to rotate yet. |
| M | 500-wallet observation universe | **DONE** | `4c8ef60`/`9d79d6c`; `data/wallet-universe/…500.csv` + `scripts/import-observation-universe.ts` (fail-closed `--apply`). Live: 500 shadow snapshots, wallets 647 observation. |
| N | Poll budget/rotation | **DONE (code+tests), not yet observed live** | `67bd7d9`; `walletActivity.ts` `selectPollWindow` (budget 200, deterministic rotation) + 2 tests. No worker has run since, so no live cycle observed. |
| O | Stealth pure engine | **DONE** | `a0f099f`…`8c47a32`; `packages/core/src/stealth/index.ts`; ~30 tests incl. monotonicity sweep. Codex APPROVE. |
| P | Stealth DB driver/worker/snapshots | **NOT DONE** | No stealth table in schema (verified against full model list), no `computeStealth` reference outside `packages/core` + tests (only stale webpack cache hits). **This is the biggest wiring gap** → Priority 2. |
| Q | Runner mining 1–6 | **Tasks 1–2 DONE · Tasks 3–6 NOT DONE** | `2e43aa1`…`3a18916`; `docs/RUNNER_MINING_DESIGN.md` + `packages/core/src/runnermining/` (30 tests, architectural no-lookahead wall). 3–6 blocked on a bulk-history provider (Birdeye plan probe = P5 first step; Dune key absent). |
| R | GMGN CLI/auth/live queries | **PARTIAL / BLOCKED (auth)** | `gmgn-cli@1.5.2` installed & verified this audit (`--version` OK); `config --check` **exit 1 = no API key**; Ed25519 keypair at `~/.config/gmgn/keypair.pem`. **Claim reconciliation:** `~/.config/gmgn-setup-output.txt` DOES exist (verified `ls`: 295 B, Jul 10 17:47) — the prior claim was factually true but the location was operator-hostile; P3 re-creates the instructions at `scratchpad/gmgn-auth-required.txt` and verifies. Live queries: 0 (blocked_by_auth). Static guards DONE (`gmgnQueryOnlyGuard` repo-wide). |
| S | GMGN wallet behavior classifier | **NOT DONE** | No code exists; correctly gated on R (Priority 4). |
| T | Seven-day wallet audition | **NOT DONE** | Plan doc only (`REAL_7_DAY_WALLET_SHADOW_RUN_PLAN.md`); **no shadow-run controller code exists** (grep: zero hits). → Priority 7. |
| U | Social live sources | **PARTIAL — subsystem DONE (merged PR #1), live adapters are config-gated STUBS** | 2 SocialSource rows live, 0 mentions; Telegram/Discord adapters return null/[] without `SOCIAL_TELEGRAM_READ_TOKEN`/`SOCIAL_DISCORD_BOT_TOKEN` (both unset). Never live-validated with real tokens. |
| V | EVM/Robinhood parked roots | **DONE (parked as designed)** | EVM addresses parked to `insider-root-wallets.txt.txt.evm-parked.txt` sidecar (verified on disk); intentionally NOT in DB. No Robinhood work (rule 12). |

## Stale/misleading-claim register

1. **GMGN setup file** — prior reports pointed the operator at `~/.config/gmgn-setup-output.txt`. The file exists (verified), but a dot-directory file on Windows was the wrong operator surface. Corrective action in P3: visible `scratchpad/gmgn-auth-required.txt`, existence-verified before being referenced again.
2. **"Stealth engine COMPLETE" (Wave F)** was pure-engine-only. The DB driver / worker / snapshot persistence layer was *never claimed* done but was easy to misread as such. Stated plainly: **P is NOT DONE** and is the top wiring gap.
3. **Bridge correlation / profit rotation** were "done" in MVP reports — true for code, but they have never run against post-reset live data (0 bridge edges, 0 trades). Reported here as PARTIAL (live-unexercised) to keep the design/wired/validated axes separate.
4. **"131 receivers enrolled"** — confirmed real in the live DB (131 relationships + 120 hot subs; some hot subs share wallets/roots).
5. **Poll budget** — code+tests done; no live worker cycle has observed it yet.

## Consequence for the priority queue

- P1 (prove lineage live): mostly **verification**, not construction — plus explaining the all-`first_funder`/probable relationship distribution.
- P2 (stealth DB driver/worker/snapshots): **real build work** — the only major missing wiring on this branch.
- P3 (GMGN): auth remains the blocker; fix the operator-instruction surface.
- P4: blocked on P3 auth.
- P5 (runner mining 3–6): starts with a Birdeye capability probe (key present).
- P6 (universe scaling): 647 observation wallets now; scaling gated on provider safety.
- P7 (shadow-run controller): not built; must be supervised/resumable.
