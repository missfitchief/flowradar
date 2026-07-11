# Consolidated Progress Report (audit-first run, 2026-07-11)

**Branch:** `feat/pre-public-accumulation` · **Draft PR:** [#3](https://github.com/missfitchief/flowradar/pull/3) (**NOT merged**)
**This run:** `7b1cd8e → f81fa11` + gate commits · **Writer:** Claude (sole) · **Reviewer:** Codex `gpt-5.6-sol` xhigh (read-only)
Full capability audit: [docs/CURRENT_STATE_RECONCILIATION.md](CURRENT_STATE_RECONCILIATION.md).

## Current-state audit outcome (Phase 0, from git/code/tests/live DB — no narrative trust)
- **Confirmed DONE from prior runs:** trust boundary, root importer, test/live DB isolation,
  transfer valuation, revaluation, receiver enrollment, gas-funding path, relationship
  persistence, monitoring lifecycle, lineage frontier, 500-wallet observation universe,
  poll budget, stealth PURE engine, runner-mining Tasks 1–2, EVM parking.
- **Stale/false-claim register:** (1) the GMGN setup file `~/.config/gmgn-setup-output.txt`
  DOES exist (verified `ls`) but was an operator-hostile location — replaced by the visible
  `scratchpad/gmgn-auth-required.txt` (existence-verified); (2) "stealth COMPLETE" had meant
  pure-engine-only — the DB/worker layer was NOT DONE (now built, this run); (3) bridge
  correlation & profit rotation are code-done but live-unexercised (0 bridge edges,
  0 trades post-reset); (4) prior smoke's "163 replay-skips = idempotency proof" was
  imprecise — replaced by a per-root isolated proof (below).

## Work completed THIS run (each Codex-APPROVED)
1. **P0 audit** (`09ffd5b`) — matrix A–V + full live census.
2. **P1 lineage proven live** (`873ee7c`…`20c54f9`, APPROVE after 5 revs) — per-root
   isolated true-replay smoke: 4 roots × 2 passes, **replayDelta {edges:0, rels:0, subs:0}
   on every root**, deterministic replay-skip counts, unavailable-never-numeric = 0
   violations, service-never-in-frontier = 0, signal_eligible 1→1, 0 provider errors.
   Root-caused the earlier +384 anomaly to a stranded-pending-roots artifact of the first
   smoke revision — **engine dedupe was never defective**. The smoke revisions' bounded
   passes also progressively drained the stranded backlog (legitimate new coverage;
   final totals in the census section below), producing the first `direct_funding`
   relationships (e.g. confidence 60, $1,026 known value, 34 interactions, 0 unknown-value
   legs).
3. **P2 stealth DB wiring COMPLETE** (`66d856e`…`4bea73d`, APPROVE after 3 rounds) —
   `StealthSnapshot` model (replay-idempotent per-bucket upserts, 14-day retention),
   `fetchStealthInputs` (RepeatableRead snapshot; cohorts eligible/observation/
   publicKol/crowd; bot/excluded dropped; fresh buyers = first-ever buy; entity-cluster
   collapse), `runStealthPass` (Serializable per-token transition chain), worker job on
   additive `intervals.stealthAccumulationSec`. **Cross-cutting root fix:** entity
   clustering's destructive rebuild is now ONE atomic transaction (torn memberships can
   no longer inflate independence for any reader). 13 new tests; full db suite 302 green.
   Live smoke: honest no-op (0 tokens have trades yet).
4. **P3 GMGN** (`e2ce947`, APPROVE) — visible `scratchpad/gmgn-auth-required.txt`
   (existence-verified; public-key link only; keypair NOT regenerated). Status:
   **blocked_by_auth** (`config --check` exit 1). Nothing purchased.
5. **P5 Birdeye probe + pilot** (`e11d912`…, APPROVE after 3 rounds) — **current plan
   supports OHLCV, history price, token trades, top traders, token discovery** (200+data);
   `creation_info` and owner-scoped `seek_by_time` are 401 plan-gated; 429s above ~1 rps.
   E2E pilot: real token → 168-point candle-END series → labeled supply assumption →
   approved engine (honest labels + window-relative caveat). Tasks 3–6 remain NOT built;
   report states no machine-readable mining outputs exist
   ([HISTORICAL_RUNNER_WALLET_MINING_REPORT.md](HISTORICAL_RUNNER_WALLET_MINING_REPORT.md)).
6. **P7 shadow-run controller** (`da87f98`…`f81fa11`, APPROVE after 6 rounds) —
   supervised resumable start/status/stop/report: ownership-token ACTIVE claim +
   serialized fail-closed eviction, direct-node spawn (kill guard works), verified
   graceful-then-forced kills that never report unverified success, orphan detection with
   exact remedies, membership-digest trust invariant, itemized provider projection,
   outcome report with coverage gates (non-synthetic baselines, fresh post-horizon
   snapshots, max-gap sparse labeling, true peak-to-trough drawdown).

## PARTIAL / deferred (with reasons)
- **P4 GMGN wallet audition:** BLOCKED on GMGN auth (one-time operator action).
- **P5 runner-mining Tasks 3–6:** provider-unblocked but not built (bounded pilot only);
  build is a multi-session effort with explicit request budgeting (~1 rps ceiling).
- **P6 universe scaling to 750/1,000:** deferred **gate-honestly** — the scale-up gates
  require observed Helius 400/429 safety under the budgeted poller, and no polling window
  has run yet. The shadow run produces exactly that evidence; scale after its first
  checkpoints. Verified universe at gate: **648 observation wallets** (+1 eligible; grew by 1 during the P1 smoke enrollments).
- **Bridge correlation / profit rotation:** live-unexercised until the shadow run
  ingests trades (0 bridge edges / 0 trades in live DB at gate time).

## Live DB at final gate (queried at the gate, byte-identical before/after verify)
**649 wallets** (648 observation / **1 signal_eligible — unchanged all run**) · **3,513
flow edges** (valuation: 2,770 current_price_estimate / 676 unavailable /
21 stablecoin_nominal / 46 not_applicable — sums to 3,513; **0 unknown-as-zero**) ·
**135 relationships** (incl. the first `direct_funding` rows) · **151 subscriptions**
(30 root_permanent / 121 fresh_receiver_hot) · **161 frontier nodes** · **500** provider
shadow snapshots · 0 stealth snapshots (no trades in live DB yet) · 0 tokens/trades ·
WalletStats **1** (csv) — never fabricated.

## Verify / tests / gate evidence
Final gate: full `npm run verify` through the ISOLATED `flowradar_test` DB —
**1,334 tests passed / 1 skipped, EXIT=0**, and the live census above diffed
**byte-identical** before/after the run. New tests this run: 13 stealth-DB; plus
script-level live proofs (the P1 smoke exits non-zero on any violated invariant).

## GMGN / shadow-run / next action
- **GMGN:** installed 1.5.2, keypair ready, **blocked_by_auth** — see
  `scratchpad/gmgn-auth-required.txt` (verified to exist).
- **Shadow run:** controller ready and approved. Start state is recorded in the
  overnight ledger + session summary AFTER an actual verified start (check anytime with
  `npx tsx scripts/shadow-run-controller.ts status`); this document makes no
  started-claim of its own.
- **EXACT NEXT HUMAN ACTION:** do the GMGN one-time key step (2 min, instructions in
  `scratchpad/gmgn-auth-required.txt`), and review the shadow run's first daily
  checkpoint (runs/<runId>/checkpoint-*.json) before approving universe scaling to
  750/1,000.
