# Runner Mining Pilot Report — 2026-07-11 (local-data pilot, RM Tasks 1-4)

Executed against `flowradar_pilot` (a frozen template copy of the live backup at 19:15Z — the live shadow DB was never touched). Machine-readable output: `data/runner-mining/pilot-report.json` (gitignored run artifact; regenerate with `DATABASE_URL=<pilot> npx tsx scripts/runner-mining-pilot.mts`).

## Real counts (not synthetic)
| Stage | Result |
|---|---|
| Canonical universe (deduped mints) | **10,489** rows persisted, 0 errors, **rerun-identical (idempotent proven: 10,489 == 10,489)** |
| Coverage | covered 3,135 · partially_covered 745 · unavailable 6,609 (unknown kept, never discarded) |
| $10M+ runners (verified from LOCAL historical observations) | **428** `verified_above_10m` |
| Verified non-runners | **1,034** `verified_below_10m` (launch-anchored full-coverage only) |
| Insufficient history | **9,023** — survivorship honesty: most tokens entered observation mid-life, so a below-$10M window can never prove a non-runner |
| Conflicting evidence | 4 (cross-source >3x disagreement — reported, not reconciled) |
| Confidence | high 8,088 · medium 2,397 · low 4 |
| Matched controls | 428 runners → **12 tier1 + 413 tier2 + 3 explicit no_valid_control** (deterministic, pre-outcome features only) |
| Early-buyer band entries | **0 persisted; 539 buys skipped as unknown-mcap** — see limitation 2 |

Sample runner receipts (from `evidenceJson`): JUP (`JUPyiwrY…`, high confidence), `27G8MtK7…` (ATH observed 2026-06-27, high), plus per-row reasons, source counts, observation spans, anchoring flags.

## Honest limitations (what this pilot does NOT prove)
1. **Local-mcap scale for large-supply mints is partially inflated**: of 428 runners, 391 have plausible ATH ($10M–$10B), 27 suspect ($10B–$1T), 10 absurd (≥$1T) — an ingestion-scale artifact on big-supply mints. `verified_above_10m` means "local observations recorded ≥$10M", pending Birdeye cross-checks for the 37 outliers. The conflict detector can't catch same-basis inflation.
2. **Early-buyer bands are empty in the local-only pilot**: the verified runners are mostly majors that were already far above $50k mcap at every locally observed trade; the low-mcap entry window predates our observation. Filling the bands requires the **Birdeye historical first-buyer/OHLCV enrichment step** (documented next task) — not fabricated from current data.
3. Controls match on local pre-outcome features only (launch anchor, baseline mcap, early activity); venue/holder features are unavailable locally, so match confidence is capped at medium and tier2 dominates (413/428).
4. No dormancy/lift claims are made — matched-control lift analysis (P(runner|pattern) vs P(runner|control)) requires the enriched entry data first.

## What IS proven
Deterministic, idempotent, bounded+resumable universe/cohort/match/entry pipeline over real data; the $10M classification asymmetry (observation proves a runner; only launch-anchored coverage proves a non-runner); unknown-honesty end to end; receipts on every classified row; zero errors across 10,489 tokens.
