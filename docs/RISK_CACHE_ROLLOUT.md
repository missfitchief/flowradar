# Token-Risk Cache — Controller-Safe Rollout (Task 1, Helius 429 fix)

**Branch:** `fix/helius-risk-refresh-budget` (off `feat/pre-public-accumulation`). PR into `feat/pre-public-accumulation`.
**Status:** built + fully tested on `flowradar_test`; the live shadow DB (`flowradar`) is **untouched** (no `token_risk_snapshots` table applied there). **Not deployed to the running shadow process.**

## What this changes
- New canonical cache table `token_risk_snapshots` (one row per token; `{penalty, flags, status, observedAt, nextRefreshAt, failCount, …}`).
- `flowScoring` and `entityClustering` now READ risk from the cache instead of calling Helius per token per pass. `entityClustering` re-scores as a pure cache read (zero risk calls).
- One bounded job `tokenRiskRefresh` (interval `intervals.tokenRiskRefreshSec` = 120s, batch `intervals.tokenRiskRefreshBatch` = 200) is the sole Helius risk caller. In-flight dedup + atomic DB claim/lease + Retry-After-aware bounded backoff.
- Provider (`solana/risk.ts`) now throws a typed `HeliusHttpError{status, retryAfterSec}` so real 429 `Retry-After` drives backoff.

## Invariant (precise)
The FlowScore **formula and risk meaning are unchanged** — `computeFlowScore` reads only `risk.penalty`, and:
- a **fresh** cached read returns the stored `{penalty, flags}` **byte-for-byte** → identical score;
- a **stale** read returns the same last-good `penalty` plus a score-neutral `risk_data_stale` info flag (flags don't affect the score);
- **missing/unknown** stays penalty 0 **plus a warn flag** — unknown, never fabricated as safe or as a penalty.

## Accepted tradeoffs (operator decision — inherent to caching, NOT bugs)
A cache cannot be *both* bounded in provider calls *and* numerically identical to an uncached call at every instant. These are the deliberate, bounded consequences, surfaced here so the rollout is an informed choice:

1. **Cold tokens beyond the per-pass inline budget read as unknown (penalty 0 + warn) until the refresh job warms them.** Bounded by `maxInlineRefreshesPerPass` (= refresh batch, 200). **Mitigation: pre-warm the cache fully before the cutover (step 2), so at switch time every scored token is fresh and the score is unchanged.** Steady-state new-token arrival is far below 200/cycle.
2. **A stale-but-usable token keeps its last-good penalty until the bounded refresh reaches it.** Staleness bound ≈ `freshSec` (10 min) + backlog/throughput. For ~3k tokens at batch 200 / 120s, a full sweep ≈ 30 min worst case. Raise `tokenRiskRefreshBatch` or lower `freshSec` to tighten (trades against call volume).
3. **A never-yet-valued token that is mid-refresh may read unknown(0) for one more cycle** if a refresh claim lands between a consumer's read and its would-be fetch. This is unknown→known progression (no real value is ever erased) and is within the staleness envelope.
4. **Brand-new tokens are deduped best-effort across instances** (same-instance via the in-flight map; two overlapping jobs could each fetch a brand-new token once — bounded, same value written). Existing/steady-state tokens are fully deduped via the atomic claim.
5. **A timed-out provider fetch is abandoned but not AbortSignal-cancelled** (the interface carries no signal). Bounded by the provider's own rate limit + the claim lease (clamped ≥ 2× fetch timeout so a retry can't overlap the original within the lease). A future enhancement can thread an `AbortSignal` through `RiskProvider.getTokenRisk`.

If the operator requires *strict* per-token score identity during warm-up, the alternative is the pure-read consumer with a mandatory full pre-warm gate before cutover (step 2 made blocking) — same code, stricter rollout ordering.

## Rollout (never a silent hot-swap of the running cohort)
0. **Do not deploy mid-cycle.** Wait for the first daily shadow checkpoint (evidence preserved) and an explicit operator go.
1. **Apply the migration to the live DB at a controller-approved window:** `prisma migrate deploy` (additive — creates `token_risk_snapshots` only; verified idempotent and non-destructive on `flowradar_test`). No existing table is altered. Confirm the live `wallets`/`walletStats` counts are unchanged after.
2. **Pre-warm the cache BEFORE consumers read it:** run `tokenRiskRefresh` (or `runTokenRiskRefresh` one-shot) repeatedly until `missingSelected`+`dueSelected` reach 0 — i.e. every traded token has a fresh snapshot. This makes the cutover zero-score-change. Watch: `refreshed` climbs, `throttled` stays low (Retry-After backoff working), `errors` ≈ 0.
3. **Cut consumers over** by resuming the worker from this branch via the shadow controller (not a live process edit). `flowScoring`/`entityClustering` now read the warm cache.
4. **Verify parity for one cycle:** compare `TokenFlowSnapshot.flowScore` for a sample of tokens against the pre-cutover cycle — they should match (fresh reads are exact). Confirm Helius 429 count drops sharply and stays low.
5. **Rollback:** revert the worker to the prior branch (consumers call Helius directly again). The `token_risk_snapshots` table can remain (harmless, unread) or be dropped. No data loss — the cache is derived, not source-of-truth.

## Tuning knobs (`settings.intervals`)
- `tokenRiskRefreshSec` (120): refresh cadence. Lower = fresher, more DB churn (not more Helius — batch-bounded).
- `tokenRiskRefreshBatch` (200): hard cap on Helius risk calls per refresh run AND the per-pass inline-warm budget. Raise to warm faster / shrink staleness; the steady-state cap scales with it.
- Cache internals (defaults, override via `TokenRiskCache` config): `freshSec` 600, `backoff` {30s ×2 → 900s cap}, `claimLeaseSec` 60 (auto-clamped ≥ 2× `fetchTimeoutSec`), `fetchTimeoutSec` 20.

## Guardrails honored
Risk formula / FlowScore / signal + promotion thresholds unchanged. New states are shadow-only cache metadata. Missing data stays unknown, never safe. Tests run only on `flowradar_test`; live DB writes only via the operator-approved steps above. No `WORKER_FAST` on live providers.
