# Shadow Run — Current Health (sprint-start checkpoint, 2026-07-11 ~18:00Z)

**Run:** `shadow-20260711105525-9280` (started 10:55Z, target end 07-18) — **RUNNING, Segment B** (cached-risk path, resumed 16:26:25Z on commit `0ed64db`). Controller pid 8644 + worker 16516, both alive, exactly one of each; last heartbeat 17:56:31Z; trust invariant HOLDS. Cohort: walletBudget 50/tick, organic universe (no explicit cohort version), env `HELIUS_RPS=5, HELIUS_RISK_RPS=4`.

| Metric | Value |
|---|---|
| wallets | 1,000 (999 observation_only + **1 signal_eligible**) |
| tokens | 10,489 |
| trades | 249,156 |
| flow edges | 1,283,161 |
| relationships | 545 |
| stealth snapshots | 2,003 |
| **token_flow_snapshots** | **102,835** (the Task-0 growth target) |
| DB size | 1,414 MB |
| Segment-B Helius 429 | 93 — **100% walletActivity** (Enhanced-Tx @ RPS 5), **0 from risk RPCs**; the risk-cache fix holds. Combined 5+4 rps occasionally trips the key; adapter has retry/backoff, wallets re-polled next cycle. Optional tune: HELIUS_RPS 5→4 at next operator window. |
| Segment-B Helius 400 | 0 |
| worker RSS | ~2.9–3.1 GB sawtooth (F8-class working set; watch daily) |

**The 1 signal_eligible wallet** is (unchanged) the pre-isolation BSC test fixture `0x1234...5678`, chain=BSC, csv-sourced WalletStats — provenance + quarantine plan in `docs/STALE_BSC_FIXTURE.md`; provably inert for Solana calcs (regression suite); NOT mutated.

**Segment boundaries preserved:** `runs/.../deployment-marker.json` (A: direct-risk `a3401fa` 10:55→14:30Z; B: cached `0ed64db` 16:26Z→). Reports never mix segments.

**Sprint safety posture:** development on stacked worktree `../flowradar-runner` branch `feat/runner-dormant-behavior` (from `feat/gmgn-runner-behavior` @ `7e4dac4`); all tests on `flowradar_test`; no live migrations, no cohort changes, no restarts, no WORKER_FAST.
