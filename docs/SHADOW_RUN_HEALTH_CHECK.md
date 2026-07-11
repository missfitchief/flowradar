# Shadow-Run Health Check (Task 0)

**Audited:** 2026-07-11 ~12:30Z, read-only against the live DB + controller state (run not disturbed).

## Ownership & liveness
- **Run ID:** `shadow-20260711105525-9280` · **Start:** 2026-07-11T10:55:25Z · **Target end:** 2026-07-18T10:55:25Z.
- **Controller:** ONE instance — process tree `npx(8920) → tsx(13820) → node(9280)`; pid 9280 tracked in state, alive.
- **Worker:** ONE instance, pid 12400, alive. No duplicate controller/worker (verified via `Get-CimInstance` command-line match — the 3 node processes are one controller tree).
- **Last heartbeat:** 2026-07-11T12:25:35Z (6 heartbeats, ~15 min cadence). Status `running`; trust invariant HOLDS.
- **Cohort:** the run polls whatever is `observation_only`/watched under the rotating `walletActivity` budget; no explicit cohort version (the universe grows organically via walletDiscovery + lineage receivers).

## Live census (heartbeat @ 12:25Z)
| Metric | Value |
|---|---|
| wallets | **954** (953 observation_only + **1 signal_eligible**) |
| flow edges | 475,476 |
| relationships | 490 |
| fresh_receiver_hot subs | 427 |
| tokens | 2,978 |
| trades | 73,751 |
| market snapshots | 7,779 |
| **stealth snapshots** | **90** (all `WATCHING`; 0 non-watching, 0 KOL arrivals) |
| provider errors (failCount>0) | 0 |
| signals | 0 |
| walletStats | 1 (unchanged all run — nothing fabricated) |
| Helius 400 | **0** |
| Helius 429 | **3,440** (see finding H-1) |
| fatal/uncaught/unhandled | 0 |
| worker RSS (heartbeat) | reads 0 — controller RSS parser bug (finding H-2), NOT a run fault |

The run is **healthy and productive**: no crashes, trust boundary intact, and the P2 stealth engine is producing live snapshots. Growth since the consolidation gate (649→954 wallets, 3.5k→475k edges) is organic discovery + lineage expansion on real Helius data.

## Finding H-1 (HIGH, motivates the Task-1 fix) — Helius 429 burst
**3,440 × 429**, sourced almost entirely from token-RISK RPC calls issued redundantly per cycle:
- `flowScoring` 459, `entityClustering→flowScoring` 314 → underlying `getTokenLargestAccounts` 227 + `getTokenSupply` 81 (per-token, per-cycle, no cache/dedupe).
- **Impact:** per-token isolated (0 crashes, 0 provider errors, tokens still scored on retry), but wasteful and it BLOCKS universe scaling (Task 8 gate "no sustained 429"). This is exactly the redundant-risk-call problem Task 1 targets. Fix is built on `fix/helius-risk-refresh-budget` and reaches the live run ONLY via an operator-approved controller resume after the first daily checkpoint — never a silent hot-swap.

## Finding H-2 (LOW, cosmetic) — worker RSS reads 0 in heartbeats
The controller's `workerRssMb()` tasklist parse returns 0 for pid 12400 (likely the `.slice`/locale format). The run's memory is not actually 0; this is a monitoring-display bug in the controller, fixable on the shadow-controller branch. Recorded; does not affect the run.

## Finding H-3 (MEDIUM, STOP-AND-REPORT per Task 0.6) — the single `signal_eligible` wallet is stale test data
The one `signal_eligible` wallet is **`0x1234567890abcdef1234567890abcdef12345678`** — a well-known **EVM test-fixture placeholder**, `chain = BSC`, `WalletStats.source = csv`, classification `bridge_related` (conf 90). It is **NOT** a lineage root and **NOT** a CandidateWallet promotion.
- **Isolation confirmed:** it is a BSC/EVM address with **0 Solana trades and 0 Solana money-flow edges** — it can never enter a Solana aggregation / `smartWalletCount` (those filter `chain = SOLANA`), so it is **inert for the pre-public-accumulation Solana intelligence** (hard rule 20 holds).
- **Provenance:** appears to be leaked test-fixture data from BEFORE the test/live DB isolation existed (the exact class of incident isolation was built to prevent, but this row predates the fix and was never cleaned).
- **Action taken:** per Task 0.6, eligibility here is NOT backed by explicit operator approval of a real wallet, so I am **reporting, not changing** it — and it lives in the LIVE shadow DB which must not be mutated mid-run (rule 25). It is the constant baseline the "eligible = 1" trust invariant has tracked all along.
- **Recommended operator action:** after the shadow run ends (or at a controller-approved maintenance window), delete/exclude this BSC test fixture from the live DB so `signal_eligible` reflects only real approved wallets. Until then it is harmless but should not be mistaken for a real signal-eligible wallet.

## Verdict
Run is **HEALTHY — preserve as-is.** No restart. One HIGH efficiency issue (H-1, fix in progress on a separate branch, controller-gated rollout), one cosmetic monitoring bug (H-2), and one stale-test-data flag (H-3, reported not changed, inert). Evidence and checkpoints preserved.
