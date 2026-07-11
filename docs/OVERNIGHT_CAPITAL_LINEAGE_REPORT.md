# Overnight Capital Lineage Build — Report

**Branch:** `feat/pre-public-accumulation` · **Draft PR:** [#3](https://github.com/missfitchief/flowradar/pull/3) (checkpoint, NOT merged)
**Window:** ~12h autonomous · **Start commit:** `3f56c07` · **Head:** `98719f6` · **30 commits**
**Writer:** Claude (sole) · **Reviewer:** Codex `gpt-5.6-sol` xhigh, read-only (adversarial)
**Final whole-branch Codex verdict:** APPROVE — safe overnight checkpoint at `98719f6`.

> Analytics only. No trading, no private keys, no order/swap execution. Every new
> accumulation/lineage metric is **shadow-only** — FlowScore, signal thresholds,
> and candidate-promotion thresholds are byte-for-byte unchanged this run.

---

## TL;DR

Six waves attempted; **A, B, C, D, F complete and Codex-APPROVED**, **E honest-status
(no code needed)**. The overnight KEY BLOCKER — Helius reporting `amountUsd = 0` for
native-SOL transfers, which had starved lineage enrollment — is **resolved** by Wave A's
honest valuation model, which unblocked Wave B (131 receivers enrolled in live smoke,
**0 signal-eligible — the trust-boundary invariant held**). The one deferred item is the
**live staged wallet-universe import** (Wave D), blocked only on an operator-approved CSV
not reachable this session; the importer path is built, hardened, and tested.

---

## DONE

### Wave A — Honest transfer valuation  ✅ Codex APPROVE (4 rounds)
The root unblocker. A pure `computeValuation` (`packages/core/src/lineage/valuation.ts`)
plus DB resolution (`resolveValuation.ts`) values every transfer with an explicit
**status** — `exact_provider_historical` / `nearest_prior_snapshot` (no look-ahead) /
`stablecoin_nominal` / `current_price_estimate` / `unavailable` / `not_applicable` — so a
native-SOL transfer Helius prices at `$0` is valued honestly instead of dropped.
- Bounded, idempotent, id-cursor-paged backfill (`revaluateEdges.ts`); updates ONLY
  valuation fields, **legacy `amountUsd` left untouched** (Codex CRITICAL: it feeds
  Rule E / clustering / FlowScore).
- **Live revaluation smoke over the real 1,621 edges:** 1,126 valued
  (`current_price_estimate`), 495 `unavailable`, **0 null, 0 unknown-coerced-to-zero**.
  Missing price ⇒ `unavailable`, never `$0`.

### Wave B — Receiver enrollment + lineage resume  ✅ Codex APPROVE (2 rounds)
Immediate receiver enrollment off honestly-valued edges, with a gated raw-SOL
gas-funding exception (a first, small, native-SOL funding may enroll without USD).
- Raw-SOL path gated on `usdUnavailable` (Codex P1a: a *valued* sub-threshold transfer
  must not bypass thresholds); first-inbound/freshness use the honest value, not legacy
  `amountUsd` (P1b).
- **Live mini-smoke:** 131 receivers enrolled, 120 hot subscriptions, 42 service legs
  skipped, **0 signal-eligible** — a linked receiver never becomes eligible merely from
  receiving money. Invariant HOLDS.

### Wave C — Monitoring lifecycle scheduler  ✅ Codex APPROVE (3 rounds)
Queue-based tier scheduler (`runMonitoringScheduler.ts` + worker job): reclaim stale
claims → hot-window expiry → bounded cold demotion → due-selection under a request
budget → atomic claim → poll → exponential backoff. Never mutates `Wallet.status`.
- Explicit `tierPriority` Int column (Codex: Postgres enum on-disk order = migration
  order, not tier order); bounded maintenance (`take 500`); error stop-reason clears on
  a successful retry.

### Wave D — Observation-universe importer  ✅ Codex APPROVE
A **separate** path from `importWalletsCsv` (which grants eligibility). This one imports a
wallet universe as pure observation: every wallet `observation_only`, **never eligible,
zero smart vote** — confirmed by Codex. Existing classifications
(`public_kol`/`excluded`/operator-promoted `signal_eligible`) are preserved.
- Hardening from review: blank/negative cells no longer fabricated as zeros
  (`Number('') === 0` trap); canonical label-stripped address + dedupe; `wallet_address`
  header required; **quote-aware RFC-4180 CSV** (spreadsheet exports validate); malformed
  quoting flagged, not silently "repaired" into a valid-looking address; wallet write is an
  atomic upsert (no P2002 vs a concurrent writer, status always preserved).
- **Whole-branch review caught a real FlowScore bug:** writing provider stats into
  `WalletStats` would have corrupted FlowScore — `fetchAggregateInputs` selects the latest
  stats row by `computedAt` regardless of source/status, and `computeFlowScore` averages
  `walletScore` across **all** buyers, so an uncomputed provider row (`walletScore 0`) would
  drag down the FlowScore of any token those wallets trade (a hard-rule-1 violation). Fixed
  by storing provider claims in a **new shadow model** `ObservationProviderSnapshot`
  (nullable fields = honest unknowns, `providerClaimed=true`, no scoring reader), upserted
  on `(walletId, source, window)` — idempotent and race-free. `WalletStats` is never touched.

### Wave F — Shadow stealth accumulation engine v1  ✅ Codex APPROVE (6 rounds)
Pure, deterministic classifier (`packages/core/src/stealth/`) over per-token / per-window
cohort aggregates (5m/15m/30m/1h/4h/24h) → lifecycle **state** + shadow-only **0..100
score** + ~27 structural metrics. States: `WATCHING` → `STEALTH_ACCUMULATION` →
`EARLY_INDEPENDENT_CONFIRMATION` → `PUBLIC_KOL_ARRIVAL` → `CROWD_EXPANSION` →
`DISTRIBUTION_RISK` → `INVALIDATED` (latest lifecycle stage wins).
- **Load-bearing invariant, now PROVABLY airtight:** only the `signal_eligible` cohort
  drives positive score; `observation_only` carries zero weight; `public_kol` /
  `copytrader` activity can only subtract (penalty, 0-floored) or advance state — it can
  **never raise the score**. Codex threw six adversarial CRITICALs at this (observation
  diluting the penalty denominator, nested-window persistence double-count, penalty
  overflow→`Infinity`→`clamp01` wiping, float-ULP non-monotonicity, count-overflow); all
  closed. Final fix removes floats from the ordering decision by clamping cohort counts to
  `[0, 1e7]`, where IEEE-754 division is exactly monotone. Covered by a deterministic
  monotonicity sweep + 5 targeted repro tests.
- Own deep-frozen `DEFAULT_STEALTH_CONFIG` (no FlowScore/threshold touch by
  construction); no profitability/return claims (asserted); passes the repo-wide
  `CandidateWallet` static trust-boundary guard.

---

## IN PROGRESS / DEFERRED (non-blocking)

- **Wave D live staged import (100/250/500).** The importer is built, hardened,
  Codex-approved, and tested — but no **operator-approved** wallet-universe CSV was
  reachable this session, and sourcing a fresh unreviewed batch is out of scope and
  against the hard rules (provider-claimed ≠ verified; unknown ≠ safe). **Path is ready;
  the data file is the only blocker.** Run with `importObservationUniverse(prisma, csv)`.

---

## BLOCKED

- None that halted the run. The two honest limits both have a built, tested path waiting
  on external input: (1) the Wave D operator CSV above; (2) **Wave E GMGN** — see below.

---

## Wave E — GMGN read-only (honest status; no new code)

The trust boundary Wave E asks for **already exists** and passes its guards, so writing a
live integration would have violated the hard rules, not satisfied them:
- `packages/providers/src/confluence/gmgn.ts` is a **query-only, typed STUB**: it makes no
  network call, returns `providerClaimed: true` context only, and **never** returns
  `ok`/`safe`. A present `GMGN_API_KEY` does not make an unverified endpoint real.
- `gmgnQueryOnlyGuard.test.ts` is a static grep guard asserting **zero** references to
  swap / order / execute / private-key / sign-transaction / wallet-management (12 tests, green).
- There is **no `gmgn-cli`** on this machine and **no verified public GMGN query API**
  (a direct fetch this session returned 403). Per the hard rules (no hallucinated
  endpoints; missing ⇒ unknown, never safe), the correct action is the honest status
  stub already in place, not a fabricated CLI/API wrapper. Any GMGN-discovered wallet
  would enter through the Wave D path as `observation_only` + `provider_claimed`.

---

## Trust-boundary invariants — verified this run

| Invariant | Evidence |
|---|---|
| FlowScore / signal / promotion thresholds unchanged | shadow-only modules; repo-wide `CandidateWallet` static guard green |
| A linked receiver never becomes eligible from receiving money | Wave B live smoke: 131 enrolled, **0 eligible** |
| Provider stats never grant a smart vote OR alter FlowScore | Wave D: `observation_only`; provider claims live in shadow `ObservationProviderSnapshot`, never `WalletStats` (the FlowScore-read table) |
| `public_kol` / `copytrader` / `observation` never raise an early signal | Wave F: score monotonicity proven + swept |
| Missing/unavailable data ⇒ unknown, never zero/safe | Wave A: 495 edges `unavailable` (not `$0`); Wave D: blank cells fabricate nothing |
| No private keys / trading / order / swap anywhere | Wave E query-only grep guard; no trading surface added |

---

## Verification

- Per-wave: red tests → implement → focused green → Codex read-only review → fix all
  Critical/Important → re-review to APPROVE → isolated commits → push.
- **Full `npm run verify`** (typecheck + all tests + Next build) at HEAD `98719f6` against
  the shared LITE DB (embedded Postgres, port 5439): **exit 0 — 114 test files passed, 1
  skipped; 1,274 tests passed, 1 skipped; Next build compiled successfully.** (One earlier
  HEAD run flaked once on `globalJobLock`'s two-holder *timing* concurrency assertion under
  full-suite DB load — it passes 4/4 in isolation, did not recur on re-run, and is
  unrelated to any change here.)
- A **final whole-branch Codex review** ran after all waves and found 4 CRITICAL + 1 HIGH
  cross-cutting issues — all fixed and re-verified (see below). The most important: writing
  provider stats into `WalletStats` would have **lowered FlowScores** (it is the
  FlowScore-read table) — moved to a shadow model. Final verdict: **APPROVE**.
- Migration this run is **additive and non-destructive** (a new `observation_provider_snapshot`
  table + a defaulted `wallet_relationships.unknownValueTxCount` column); applied via
  `migrate deploy` (never resets), no live-DB seed/destroy.

### Final whole-branch review — issues found & fixed
1. **(CRITICAL) Provider stats could lower FlowScore** — `WalletStats` is read by the score
   path; moved provider claims to the shadow `ObservationProviderSnapshot`.
2. **(CRITICAL) Unavailable transfer classified as dust** — now an explicit `unknown` verdict,
   deferred to revaluation (never treated as benign).
3. **(CRITICAL) Relationship value used legacy `amountUsd`** — now sums honest `valuedUsd`;
   service legs excluded; unavailable/legacy-$0 legs are `null` + counted in
   `unknownValueTxCount`, never summed as a known zero.
4. **(CRITICAL) Negative stealth penalty weight** could flip a penalty into a bonus — weights
   floored at 0.
5. **(HIGH) Importer wallet create race** — atomic upsert; stats race removed by the shadow
   model's unique key.
- Live smokes ran at **normal worker speed** against the real DB, **read-mostly**; no
  `db:seed` against a clean live DB, no synthetic/live mixing, no threshold weakening to
  force a demo result.

## NEXT (for the operator)

1. Provide an operator-approved wallet-universe CSV → run the Wave D staged import
   (100 → 250 → 500), re-running the census before/after.
2. Wire the Wave F stealth engine to a DB driver (`fetchStealthInputs` producing the
   per-window cohort aggregates) + a worker job; surface state/score read-only in the UI.
3. Review draft PR [#3](https://github.com/missfitchief/flowradar/pull/3); **do not merge**
   until the staged import + a longer live shadow run are reviewed.
