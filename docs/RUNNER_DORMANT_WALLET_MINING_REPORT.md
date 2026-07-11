# Runner Mining Pilot Report — 2026-07-11 (local-data pilot, RM Tasks 1-4)

Executed against `flowradar_pilot` (a frozen template copy of the live backup at 19:15Z — the live shadow DB was never touched). Machine-readable output: `data/runner-mining/pilot-report.json` (gitignored run artifact; regenerate with `DATABASE_URL=<pilot> npx tsx scripts/runner-mining-pilot.mts`).

## Real counts (definitive run 20:36Z, post-hardening engine — not synthetic)
| Stage | Result |
|---|---|
| Canonical universe (deduped SOLANA mints) | **10,489** rows persisted, 0 errors, **rerun-identical (10,489 == 10,489)** |
| Coverage | covered 3,127 · partially_covered 753 · unavailable 6,609 (unknown kept, never discarded) |
| $10M+ runners (locally observed historical mcap) | **428** `verified_above_10m` |
| Verified non-runners | **0** — no local token carries a populated `tokenCreatedAt`, so NO series can prove launch anchoring; every low-window token is honestly `insufficient_history` (10,057). The below-cohort structurally REQUIRES the launch-time/Birdeye enrichment step. |
| Conflicting evidence | 4 · Confidence: high 7,528 · medium 2,956 · low 5 |
| Matched controls | 428/428 matched, **all tier2** (unknown-outcome controls are tier2-capped by rule), 0 no-control |
| Early-buyer band entries | **0 persisted; 538 buys unknown-skipped** — strictly-prior snapshot valuation (no-lookahead) finds no in-band prior observation for these mints locally; see limitation 2 |

## Honest limitations (what this pilot does NOT prove)
1. **Local-mcap scale for large-supply mints is partially inflated**: of 428 runners, 391 have plausible ATH ($10M–$10B), 27 suspect ($10B–$1T), 10 absurd (≥$1T) — an ingestion-scale artifact on big-supply mints. `verified_above_10m` means "local observations recorded ≥$10M", pending Birdeye cross-checks for the 37 outliers. The conflict detector can't catch same-basis inflation.
2. **Early-buyer bands are empty AND verified-below is empty in the local-only pilot**: the verified runners are mostly majors that were already far above $50k mcap at every locally observed trade; the low-mcap entry window predates our observation. Filling the bands requires the **Birdeye historical first-buyer/OHLCV enrichment step** (documented next task) — not fabricated from current data.
3. Controls match on local pre-outcome features only (launch anchor, baseline mcap, early activity); venue/holder features are unavailable locally, so match confidence is capped at medium and tier2 dominates (413/428).
4. No dormancy/lift claims are made — matched-control lift analysis (P(runner|pattern) vs P(runner|control)) requires the enriched entry data first.

## What IS proven
Deterministic, idempotent, bounded+resumable universe/cohort/match/entry pipeline over real data; the $10M classification asymmetry (observation proves a runner; only launch-anchored coverage proves a non-runner); unknown-honesty end to end; receipts on every classified row; zero errors across 10,489 tokens.

## Enrichment phase 2 (Birdeye, real API — 2026-07-11 21:47Z)
928 targets (428 runners + 500 deterministic control candidates), 1,856 requests at plan pacing: **249 enriched**, 679 provider_error (retryable, persisted with retryCount — resumable; the plan throttles above its ceiling), 0 no_ohlcv/no_supply. Classification rerun ONCE with enrichment precedence + seven Codex-driven no-lookahead/full-life gates:
- **Confirmed runners: 347** (independent Birdeye agreement or plausible local evidence).
- **Downgraded: 81** — 48 caught by >3x cross-provider ATH disagreement + 32 scale-implausible (≥$10B) without successful enrichment, moved out of verified per the no-verified-and-suspect rule (audited UPDATE, receipted in evidenceJson); + the prior 4 = **84 conflicting_evidence** total.
- **Verified non-runners: 0** — fullLifeProven requires tokenCreatedAt anchoring + untruncated + strictly consecutive daily candles + current end; no local token meets it. Honest: the below-cohort needs launch-time backfill (tokenCreatedAt population or a creation-info-capable plan).
- Controls: 379→347 runners all matched tier2 (unknown-outcome pool, capped by rule); 0 tier1 until verified non-runners exist.
- Early buyers: 0 in-band even with candle-END priors (1,815 unknown-skipped) — local trades on runner mints all occurred when those tokens were far above $50k; historical first-buyer *transactions* (not just prices) are the remaining gap (Birdeye token-trades pagination or Helius historical backfill — next increment).
