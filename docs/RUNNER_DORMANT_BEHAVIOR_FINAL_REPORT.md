# Runner / Dormant / Behavior Sprint — Final Report (increment 1, 2026-07-11)

Branch `feat/runner-dormant-behavior` (stacked on `feat/gmgn-runner-behavior` @ 7e4dac4), draft [PR #6](https://github.com/missfitchief/flowradar/pull/6). Commits: `eb5f189` (health checkpoint + ≤300-line plan), `91565a5` (Task 0). Full suite **1,488 green** on `flowradar_test`; live shadow DB proven untouched by tests (experimental tables absent on live; run `shadow-20260711105525-9280` running throughout, controller 8644 / worker 16516, cohort and Segment-A/B boundaries preserved).

## Completed
**Task 0 — TokenFlowSnapshot storage bound (Codex APPROVE after 3 adversarial rounds).**
- Measured live before changing anything: ~639 rows/min (~920k/day projected), ~57 rows/token/hour, **98.8% of consecutive per-token rows byte-identical** (SQL lag-compare over the last hour), table 79 MB (63 data + 16 index) at 102k rows, writers = `runFlowScoringPass` via flowScoring (60s) + entityClustering re-score (180s); consumers verified: alerts/UI/market-tiering read latest-per-token, signals updates in place, backtest/replay do not read the table, social-overlap reads time ranges.
- Implemented the smallest safe bound: exact-duplicate suppression (no thresholds — any real change persists) + 900s routine heartbeat; Decimal(20,4) fields quantized to column scale on both sides of the comparison; `componentBreakdown` compared via stable key-sorted fingerprint; latest-row reads tie-broken by id.
- Codex-driven hardening across three rounds: **(Critical)** signal transitions now persist their own trigger-time row (clone-on-transition in `signals.ts`) instead of rewriting a possibly-heartbeat-old row — no transition or trigger snapshot can be lost or backdated; **(Important)** scoring carries the latest `signalStatus` forward so hot tokens neither oscillate nor double-write; insert-failure accounting (`attempted == inserted + suppressedUnchanged + insertFailed`); seed self-checks reconciled to per-token coverage + per-token leaderboards (full seed: 0 failures).
- Accepted + documented: social-overlap queries with windows shorter than the heartbeat see heartbeat-spaced rows (directive-sanctioned cadence); overlapping scoring passes can still each insert one changed row (pre-existing, strictly no worse).
- **Not deployed to the active run** — the live worker still writes at the old rate (145,569 rows at report time); deployment happens at the next controller-approved resume, same procedure as the risk-cache rollout.

## Not started (honest)
Tasks 1–20 of the plan: historical token universe, $10M+ runner cohort + matched controls, first-buyer extraction, full wallet-token history (RM3), meaningful-activity classifier, address/entity dormancy engines, dormant funding analysis, repeat-runner mining (RM4) + sensitivity, negative evidence, Wallet DNA integration, candidate output (RM5), live shadow integration (RM6), pre-bond scanner, scan surfaces, and the real pilot + `RUNNER_DORMANT_WALLET_MINING_REPORT.md`. The committed plan (`docs/RUNNER_DORMANT_BEHAVIOR_PLAN.md`) sequences all of it; the pure-engine foundations these build on (behavior reconstruction, hold/dump classifier, receipts engine, runnermining outcome labels + entry-mcap reconstruction with no-lookahead) already exist on the base branch.

## Shadow-run health at sprint end
Running, Segment B, heartbeats current, trust invariant HOLDS, wallets 1,000, eligible 1 (the labeled BSC fixture), zero risk-RPC 429s since cutover (the 93 Segment-B 429s are 100% walletActivity at HELIUS_RPS=5 — optional tune to 4 at the next window). Operator flags carried forward: TokenFlowSnapshot growth continues on live until Task 0 deploys; worker RSS ~3 GB sawtooth.

## Verdict
**PARTIAL** — Task 0 (the sprint's urgent operational item) is done, adversarially reviewed, and merged-ready on the stacked branch; runner-mining Tasks 1+ await the next increment with fresh provider budget.

**NEXT HUMAN ACTION:** (1) approve deploying Task 0 to the live run at the next controller window (stop → pull `feat/runner-dormant-behavior` or merge PR #6 into the stack → resume; same controller-safe procedure as the risk-cache rollout) — this stops the ~920k-rows/day growth immediately; (2) green-light the next increment (runner mining T1–T5) with a Birdeye quota budget; (3) review PRs #4/#6.
