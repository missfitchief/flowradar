# Overnight Lineage Progress Report (second window, 2026-07-11)

**Branch:** `feat/pre-public-accumulation` · **Draft PR:** [#3](https://github.com/missfitchief/flowradar/pull/3) (checkpoint, **NOT merged**)
**Starting commit (this window):** `ddb8ae9` · **Ending commit:** `67bd7d9` + this report commit
**Prior window:** `3f56c07 → ddb8ae9` (Waves A–F, see `docs/OVERNIGHT_CAPITAL_LINEAGE_REPORT.md`)
**Writer:** Claude (sole) · **Reviewer:** Codex `gpt-5.6-sol` xhigh, read-only adversarial

> Analytics only. No trading, no private keys, no order/swap surface. FlowScore, signal
> thresholds, and promotion thresholds untouched. All new metrics shadow-only.

---

## COMPLETED (this window; every item Codex-APPROVED)

### Task A — TEST/LIVE database isolation ✅ (4 review rounds)
Root cause of the earlier leaked-fixture incident closed: under vitest, DB resolution
automatically targets **`flowradar_test`** on the same embedded cluster (ambient
`DATABASE_URL` is IGNORED in test mode); an explicit `TEST_DATABASE_URL` must be local,
`_test`-suffixed, safe-charset, and canonically distinct from live or resolution **throws
before any client exists**. Global setup provisions the test DB with the **same migrations**
(`migrate deploy`). Hardened through review: canonical identity (percent-decode, loopback
unification, port defaulting), identifier-injection charset guard (+ exact-repro test),
zero-arg-Prisma-client static guard (window-scan, comment-stripped, alias ban — one real
offender fixed in `confluenceQueries.test.ts`), two lock-test timing flakes made
deterministic via gates.
**Gate proof:** full verify (typecheck + 1,290 tests + Next build) EXIT=0 *through the test
DB*, live census **byte-identical** before/after, plus an integration test showing a test
write present in `flowradar_test` and absent in live.

### Task F — Staged observation-universe import ✅ (3 review rounds) — **LIVE DATA LANDED**
The operator-approved 500-wallet CSV (named import-approved by
`docs/WALLET_UNIVERSE_ENRICHMENT_REPORT.md`) was found, versioned into
`data/wallet-universe/`, and imported through the Wave D observation path in stages
**100 → 250 → 500** plus a replay:
- **499 wallets created as `observation_only` + 1 pre-existing wallet (already an
  `observation_only` lineage receiver) preserved, not re-statused.** Post-import
  verification query: all 500 staged addresses are `observation_only`
  (`groupBy status` → `[{count: 500, status: 'observation_only'}]`).
- **500 provider-claimed shadow snapshots** (`ObservationProviderSnapshot`; `WalletStats` count unchanged — FlowScore provably untouched)
- Replay: 0 new wallets, 0 duplicate snapshots (upsert on unique key)
- **Trust invariant at every stage: `signal_eligible` 1 → 1**, proven per-address (staged eligible set identical before/after)
- 0 malformed / 0 EVM / 0 duplicates; RSS ≤ 114 MB; stage durations 1.7–5.6 s
- Review fixes: the old runbook pointing this CSV at the **eligibility-granting** `/api/import` replaced with the observation-only command + explicit prohibition; CLI is fail-closed (dry-run default, `--apply` required, unknown args abort)

### GMGN (Task G policy) ✅ honest status: **blocked_by_auth**
- Official `gmgn-cli@1.5.2` installed (maintainer `infra@gmgn.ai`, GMGNAI org)
- `gmgn-cli config --check` → exit 1 (**no API key configured**)
- Ed25519 keypair prepared at `~/.config/gmgn/keypair.pem` (private half never printed/committed)
- Read-only probe (`market trenches`) confirms: blocked on auth, not on plan/payment. **Nothing purchased.**
- **One-time operator action:** open the key-creation link saved at `~/.config/gmgn-setup-output.txt`, create the API key on gmgn.ai, then run `gmgn-cli config --apply <key>` locally (do NOT paste the key into chat)
- Static guards extended repo-wide: any gmgn-mentioning source file (packages/apps src, Next app/components, scripts ts/js/mjs) is grep-guarded against swap/multi-swap/order/cooking/key-management capabilities, CLI invocations (shell, argv, `.cmd`/`.exe` variants), and execution API paths

### Runner-mining Tasks 1–2 ✅ (4 review rounds)
- **Task 1:** `docs/RUNNER_MINING_DESIGN.md` — data recon (what exists vs what is
  provider-gated), canonical shapes, bias-control checklist, implementation order
- **Task 2:** `packages/core/src/runnermining/` — pure, deterministic engine:
  - `computeTokenOutcome`: evaluation-only labels (`runner_2x/5x/10x/50x`, mcap milestones,
    seven/eight-figure bands, `rug_or_collapse`, `failed_launch`, `illiquid_untradeable`,
    `insufficient_data`; empty = evaluable-but-unremarkable), window-relative baselines
    stated honestly (confidence capped unless launch-anchored)
  - `computeEntryContext`: **structural no-lookahead** (strictly-prior truncation first;
    the entry module *cannot import* the outcome module — static leak-guard), stale/missing
    ⇒ `unavailable`/`unknown` (never $0), no `current_price_estimate` in historical statuses
  - Adversarial hardening: **dual-view conservative tie collapse** (tie ambiguity can only
    UNDERSTATE outcomes — relative and absolute), full-tuple deterministic entry ties,
    NaN normalization, fail-closed config validation
  - 30 focused tests incl. truncation-equivalence property, cross-future prefix identity,
    order-insensitivity, injection-of-ambiguity repros

## Reconciliation vs the queued task list (no duplicated work)
Tasks B (valuation), C (revaluation), D (enrollment/resume), E (monitoring), H (stealth)
were already COMPLETE and Codex-approved in the prior window — the queued note "receiver
enrollment has not fired" predates Wave A/B (131 receivers enrolled in the live smoke).

## Live DB state (census at final gate)
wallets **648** (149 → 648) · observation snapshots **500** · lineage roots **30** ·
money-flow edges **1,621** · relationships **131** · subscriptions **150** ·
expansion nodes **160** · walletStats **1** (unchanged) · `signal_eligible` **1** (unchanged)
· tokens 0 · candidateWallets 0. Dynamic root count (never hardcoded) unchanged at 30.

## Monitoring tiers / migrations / errors
- Monitoring: 150 subscriptions (30 `root_permanent`, 120 receiver tiers from the prior
  window); the 500 universe wallets are pollable/graphable but deliberately NOT
  auto-subscribed (subscription creation stays a lineage/monitoring decision, not an import
  side effect).
- Migrations this window: **none to live schema** (Task A only ADDED the parallel
  `flowradar_test` database; live migrations untouched).
- Provider errors: no live provider calls were needed this window (import is CSV-based;
  GMGN blocked on auth) — 0 × 400, 0 × 429. Helius/pricing untouched tonight.
- Crashes: none. RSS peak (import): 114 MB. Test-suite duration ~90–135 s per full verify.

## Verify / tests
Full `npm run verify` (typecheck + all tests + Next build) green through the isolated test
DB **twice**: Task A gate (**1,290 passed / 1 skipped, EXIT=0**) and the final gate
(**1,320 passed / 1 skipped, EXIT=0**), with the live census **byte-identical** before/after
both runs (12-table `scripts/db-census.ts` output diffed; evidence in the gitignored
overnight ledger + this session's transcripts — the census script itself is committed and
re-runnable). After the walletActivity budget fix, the full verify re-ran clean: **1,322 passed /
1 skipped, EXIT=0**. New tests this window: **14** isolation/client-guard, **2** GMGN
repo-wide guard, **30** runner-mining, **2** walletActivity budget; **2** pre-existing lock
tests deflaked (gate-based); Task F was validated by live staged runs + replay
(script-level invariant checks), not new test files.

## Codex verdicts (this window)
Task A: APPROVE (round 4) · Task F: APPROVE (round 3) · Runner-mining: APPROVE (round 4)
· Final delta review: recorded in the overnight ledger alongside this report.

## EXACT REMAINING BLOCKERS
1. **GMGN auth** — one-time operator action above. Until then Wave E/G stays
   `blocked_by_auth` (honest status; no purchase, no fabricated integration).
2. **Runner-mining bulk history** — Tasks 3–6 need ONE operator-enabled bulk-history
   provider (Dune: add key + a runner-universe/OHLCV query + adapter; or confirm Birdeye
   OHLCV plan). Until then the engine runs only over tokens already in our DB
   (forward-only window) — correct but narrow.
3. **Live polling of the 500-wallet universe** — no worker was started this window, BUT the
   final delta review caught that the baseline `walletActivity` job polls every
   `observation_only` wallet on any worker (re)start — the import would have silently
   committed all ~650 wallets to Helius polling. **Fixed:** the job now has a per-cycle
   wallet budget (`WALLET_ACTIVITY_MAX_WALLETS`, default 200) with deterministic window
   rotation — bounded per cycle, full coverage every ceil(N/200) cycles, pre-import
   behavior unchanged for sets under budget. The operator still decides when to start the
   worker and may tune the budget; projected Helius usage at defaults: ≤200 wallets ×
   ≤5 pages per cycle.

## NEXT RECOMMENDED TASK
Wire `fetchStealthInputs` + a worker job for the Wave F stealth engine over the now-populated
observation universe (shadow-only, read-only UI surface), then runner-mining Task 3
(wallet-token history reconstruction) once a bulk-history provider is enabled.
