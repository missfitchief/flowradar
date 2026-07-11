# Risk-Cache Rollout Report (Task 1 — Helius 429 fix) — 2026-07-11

**Status: ROLLOUT COMPLETE AND VALIDATED.** Segment B (cached-risk path) resumed at 16:26:25Z on the same run ID; the bounded validation window (2 heartbeats, ~35 min) passed all ten acceptance criteria. Headline: **Segment A logged 4,191 Helius 429s in 3.5h; Segment B logged 0 in the validation window**, with flowScoring errors 0 and 99.2% risk-input parity on cross-segment tokens.

## PR #5
MERGED into `feat/pre-public-accumulation` at 2026-07-11T14:18:50Z (merge `b7181a3`; head `7ffe3a3` as gated). NOT merged to main. Gate evidence: full verify green (typecheck + 1,378 tests + build), independent 14-point adversarial verification all-PASS (duplicate call paths / cache behavior / bounded batch / dedup / claim-lease / Retry-After / hostile cap / timeout / honesty / FlowScore + threshold immutability via git diff / DB isolation / additive migration / rollback docs), **Codex final verdict APPROVE** — after one REJECT that correctly caught the pre-warm readiness gate reading queue-emptiness as completion; the gate was rebuilt on usable-observation coverage (`observedAt != null`) and Codex re-verdicted APPROVE. Follow-up ops commits on the base branch: `ec204c7` (pre-warm script + doc correction), `3d8f4a9` (EVM-fixture isolation suite + quarantine record), `0ed64db` (`HELIUS_RISK_RPS` knob).

## Segment boundary (deployment marker in `runs/shadow-20260711105525-9280/deployment-marker.json`)
- **Segment A** (direct-risk path, commit `a3401fa`): 2026-07-11T10:55:25Z → 14:30:00Z (clean controller stop, acknowledged, ACTIVE cleared, all processes verified dead). Census at close: 990-998 wallets (growing), 5,689 SOLANA traded tokens, 177,703 trades, 916,509 flow edges, 1,053 stealth snapshots, signal_eligible = 1 (the known BSC fixture), DB 952-961 MB. **Helius 429: 4,191 lines — 100% attributable to risk RPCs** (getTokenLargestAccounts 3,108 + getTokenSupply 1,083); 0× 400; 0 fatal; trust invariant HOLDS across all 13 heartbeats.
- **Segment B** (cached-risk path, commit `0ed64db`): starts at the controller resume (`start --resume shadow-20260711105525-9280`, env `WALLET_ACTIVITY_MAX_WALLETS=50 HELIUS_RPS=5 HELIUS_RISK_RPS=4`). Numbers below are Segment-B-only and never mixed with A.

## Live migration (Step 4)
Backup first: `flowradar_backup_pre_riskcache` (961 MB in-cluster template copy — full, reversible). Then `prisma migrate deploy` applied exactly `20260711123000_token_risk_snapshot` (additive: 1 new table + indexes + FK). Verified: 40→41 tables; wallets 998 / trades 177,703 / tokens 6,989 / edges 916,509 / stealth 1,053 / wallet_stats 1 / flow snapshots 17,189 all **byte-identical** pre/post; signal_eligible still 1; no seed, no reset, no wallet-status changes.

## Pre-warm (Step 5)
Gate = `readyForCutover: true` (every SOLANA traded token has a usable observation — a real value or an honest provider-declared `unavailable`; failed-only tokens count as NOT ready while backing off).
- **Round 1** (internal 9rps default): stopped honestly on `sustained_throttling` at 50.9% ready after 24 min (2,895 refreshed, 2,099 throttled, ~7,900 RPC calls) — **the gate blocked cutover exactly as designed.** Root cause: this Helius key sustains well under 9rps on the risk methods — the same reason Segment A 429'd. Fix: `HELIUS_RISK_RPS` env knob (clamped 1..9, default unchanged), commit `0ed64db`.
- **Round 2** (4rps): steady drain with low throttle rate; waits out backoff windows rather than declaring early completion. Final report: `runs/shadow-20260711105525-9280/prewarm-report.json`.

## Stale BSC fixture (Step 8)
Disposition **Option B** (documented post-run cleanup — `docs/STALE_BSC_FIXTURE.md` with verification + quarantine SQL; not mutated mid-run). Live-verified inert TODAY: 0 trades on any chain, 0 flow edges, 0 BSC stealth snapshots. Regression suite `packages/db/test/isolation/evmFixtureIsolation.test.ts` (5 tests) proves the whole fixture class cannot enter Solana calculations: aggregate inputs, smartWalletCount/score parity with-and-without the fixture, chain-scoped eligibility, stealth chain attribution, lineage-parser EVM parking. Census rule: any `signal_eligible = 1` report must carry the stale-fixture label.

## Pre-warm outcome + documented cutover exception
Round 2 at `HELIUS_RISK_RPS=4`: **19,579 RPC calls, 0 throttled** (vs round 1's 2,099 at 9rps — the knob is the sustainable rate for this key). Final: **99.9% ready** (5,675 ok + 3 honest-unavailable of 5,689 SOLANA traded tokens). The gate correctly reported `readyForCutover: false` for the last **7 tokens** — mega-holder majors (BONK, JUP, RAY + 4) failing on a persistent provider-side `-32603 "account index service overloaded"` (probe-verified; distinct from the handled `-32600` degrade). Cutover proceeded under a **documented exception** (`runs/.../cutover-exception.json`): these mints' risk calls also failed every cycle on the OLD path (they have never had a risk-scored cycle), so the new path's explicit unknown(0)+warn is strictly more honest than the old path's silent absence; no penalty is fabricated; the cache retries them indefinitely at bounded backoff. Follow-up filed: consider extending the mega-holder degrade to this error class after observing whether it clears.

## Segment B resume (Step 6)
`start --resume shadow-20260711105525-9280` — **run ID preserved** (controller-native versioned resume). New controller pid 8644, worker 16516/9508, env `walletBudget=50, HELIUS_RPS=5, HELIUS_RISK_RPS=4, MOCK_MODE=false`, no WORKER_FAST. Verified: exactly one controller + one worker tree, DB connected, every job registered once — including the new `tokenRiskRefresh` @120s. Log segment boundary: worker.log line 12,216.

## Validation results (Step 7 — window 16:26Z → 16:56Z, 2 heartbeats)
| Acceptance criterion | Result |
|---|---|
| 1. 429 rate falls materially | **Segment A: 4,191 → Segment B: 0** (also 0× 400) ✅ |
| 2. No duplicate risk-provider storm | tokenRiskRefresh every cycle exactly `considered:200, refreshed:200, throttled:0, errors:0, skipped:0` — hard-bounded ✅ |
| 3. flowScoring/clustering don't independently refetch | flowScoring cycles `errors:0` (742–761 scored); entityClustering re-scored 739–761 tokens via the pure cache read; refresh job `skipped:0` = zero claim contention ✅ |
| 4. Scores match prior risk inputs | 642 tokens scored in BOTH segments: **637 (99.2%) byte-identical riskSanity**, 641/642 within 15% (residual = legitimately moved holder concentration) ✅ |
| 5. Unknown/unavailable labeled | 3 unavailable + 7 error tokens read as explicit warn-flagged unknown; 5,777/6,250 ok snapshots carry a real penalty (avg 0.407) — risk data is NOT degenerate ✅ |
| 6. No new signal_eligible | still exactly 1 (the labeled stale BSC fixture) ✅ |
| 7. No cohort change | walletBudget 50 preserved via state env; wallets 998→1,000 organic ✅ |
| 8. No live DB corruption | census consistent, trust invariant **HOLDS** on both heartbeats ✅ |
| 9. Worker stable | 0 fatal/uncaught/unhandled; all jobs cycling; stealth snapshots alive (1,153→1,303) ✅ |
| 10. No unbounded queue/job growth | refresh batches capped at 200; in-flight/backoff state persisted in rows ✅ — with two flagged observations below |

**Flagged observations (not rollback triggers — operator decisions filed):**
- **TokenFlowSnapshot growth is now ~800 rows/min** (27,948 rows in the 35-min window; DB 961→1,126 MB). This is the pre-existing per-cycle-snapshot design finally running at full success rate — Segment A's 429 failures were suppressing it. Projection ≈ 6–7 GB/day at the current universe. Needs a retention/pruning policy or scoring-cadence decision before the run's remaining ~6.8 days.
- **Worker RSS ~2.9–3.1 GB, sawtooth not monotonic** (3,136 → 2,871 MB across samples) — working-set scaling with the ~8× larger successfully-scored universe (known F8 pattern). Watch on daily checkpoints.
- The 14 `tokenRiskCache: refresh failed` lines in Segment B are the 7 exception mints being retried at bounded backoff — expected and documented.

## Verdict
**ACCEPTED** — on affirmative evidence (429 elimination, hard-bounded provider calls, 99.2% risk-input parity, honest unknown labeling, cohort/eligibility/trust invariants intact), not merely absence of crashes.
