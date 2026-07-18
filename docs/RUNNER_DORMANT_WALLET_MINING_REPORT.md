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

## Phase A closure + Task 5 pilot (2026-07-11 21:57Z)
- **Controls rebuilt once post-downgrade:** 347 runners → 347 matched (all tier2, unknown-outcome pool, labeled; 0 tier1 pending verified non-runners), 0 unmatched.
- **Task 5 (full wallet-token history, first tranche):** 50 runner/control pairs → **22 unique locally-observed buyer wallets → 22 WalletBehaviorProfile rows persisted** via the approved behavior engine (field-level provenance: 20 local+provider, 2 local-only; 21 with runner-token exposure; 0 truncated; 0 errors; **idempotency proven** 22==22 on rerun). Cohort caveat recorded: these are locally observed buyers whose in-band early-entry status is UNPROVEN (historical entry valuations unavailable) — the tranche is small because local trade coverage only spans the shadow-run window; scaling the cohort requires the historical first-buyer transaction backfill.
- Tasks 6-12 (meaningful activity, dormancy, funding paths, post-entry behavior, repeat mining) NOT started this session — the engines do not exist yet and were not faked.

## Working-loop milestone (2026-07-12, commits a8b95ed..4f5e2fc) — first automatic end-to-end loop
Pipeline now runs end to end on the pilot DB: **347 verified $10M+ runners → top-PnL discovery** (`token_top_pnl_candidates`: 256 local-reconstruction candidates over all 347 mints; Birdeye top_traders fetch attempted for all 347 under a 400-request budget — every call blocked by the plan's compute-unit quota, persisted as retryable `provider_error`; the 24h present-window cap means provider rows are discovery evidence only even when the quota resets) → **52 discovered wallets, all with local evidence → Wallet DNA** (`wallet_dna_profiles`: WR/EV over completed positions only — on this frozen copy all 706 positions carry unpriced legs, so every winRate is honestly NULL) → **dormancy/entity/funding/post-entry chain** (T6-T12 over the cohort: 124,767 activity classifications, 706 address + 706 entity dormancy observations, 706 funding paths, 706 post-entry rows) → **capital outflow** (`capital_outflow_paths`: 32 paths — 31 direct, 1 multi-hop; tiers direct > multi-hop > bridge > CEX, bridge/CEX terminals never attributed) → **receiver enrollment** (`receiver_enrollments`: 27 observation_only — 12 fresh, 1 dormant-reactivated, 7 active, 7 unknown; post-receipt deployment detection) → **automatic token-candidate feed** (`token_candidate_scores`: 310 candidates — 295 WATCHING + 15 INVALIDATED; StealthState vocabulary, mining-derived, live stealth state side-by-side).
Honesty outcome: after the Codex review cycle (2 Critical + 8 Important fixed, final APPROVE), unknown-value evidence can mint NO accumulation state and NO score — on this mostly-unpriced frozen copy every candidate honestly sits at WATCHING/score 0. Richer states require priced trade data (live ingest valuations or a historical valuation backfill).
Dashboard: `/candidates` page renders the persisted feed (real data only). Start: `flowradar-web-pilot` launch config, or manually from `apps/web`: `DATABASE_URL=postgresql://flowradar:flowradar@localhost:5439/flowradar_pilot npx next dev -p 5190` → http://localhost:5190/candidates

## Complete-discovery sprint (2026-07-12, commits ba3016c..ea592be) — roles, entity DNA, operator-root integration
Full historical pipeline over the covered universe on flowradar_pilot:
- **Token universe**: 347 verified_above_10m · 84 conflicting_evidence · 10,058 insufficient_history; enrichment 249 enriched / 679 provider_error (retryable). Every token carries a processing state.
- **Top-PnL extraction** widened to 25 wallets/mint over all 347 runners: 66 unique local-evidence wallets (139 locally_verified + 141 incomplete candidate rows). Birdeye retry probe (12 requests) still quota-blocked — receipted retryable; GMGN remains an honest stub.
- **Address DNA**: 66 wallets, 40 with non-null WR/EV, 159 completed positions (35W/2L), 624 unresolved (honest — open/unpriced never wins/losses).
- **Wallet roles** (`wallet_role_assignments`): 282 evidence-backed rows — profit_collection 151, fresh_funded_receiver 66, service/router/cex node 28, operator_root 30, funding_wallet 3, dormant_funded_receiver 3, probable_side_wallet 1. Ordered evidence tiers; probabilistic, never identity.
- **Entity DNA** (`entity_dna_profiles`): 75 entity-adjusted rows (5 multi-wallet, 13 contain an operator root, 40 with calculable WR, 33 one-winner-dependent ≥80%). Union-find over sufficient links only — same-token buys never link; ten linked side wallets collapse to ONE entity. Realized/EV over known-realized members only; runner involvement is a DISTINCT-mint union; median return null (not derivable); every incompleteness/truncation flagged.
- **Operator roots** (30) folded into the SAME entity graph as historical discovery (additional seeds).
- **Capital**: 281 outflow paths (191 direct, 90 multi-hop), 151 receivers enrolled.
- **Automatic candidates**: 320 WATCHING + 1 STEALTH_ACCUMULATION + 15 INVALIDATED.
Machine-readable: `data/runner-mining/full-coverage-report.json`. Dashboard: Live Opportunities / Capital Staging / Entities / Historical Winners / Watching (raw tools under Advanced) at http://localhost:5190. Codex review (thread 019f57b4): 7 Important + 2 Minor first pass, then 3 more re-review rounds (NULL propagation, cross-wallet runner dedup, weighted returns, stale-row reconciliation, truncation-safe wins) → final APPROVE.

## Finish-pipeline sprint (2026-07-13, commits a3c4121..ffa3371) — per-token extraction status + real capital chains
- **Per-token extraction status** (`top_pnl_extraction_status`) for ALL 347 verified $10M+ runners — an honest outcome, not just a processing state: **113 local_reconstruction_ok** · 99 no_valid_wallets · 49 retryable_provider_failure (Birdeye quota) · 86 incomplete_coverage.
- **Real capital chains** (`capital_chains`) joined from persisted evidence: **233 STAGING** (qualified entity → transfer → fresh/dormant/linked receiver), **2 PROFIT ROTATIONS** (realized runner profit → later buy into another token; e.g. Cqku6…sUpw realized ~$363.5k on 9cRCn…pump then rotated into 4Mrs…, 2gchx…L8Zt ~$1.4k on 9cRCn → FeMb…), **0 DEPLOYMENT** — an HONEST data gap: of 151 receivers only 24 have a local wallet row, 4 have any trades, 0 have a post-receipt buy in the shadow-run window.
- Wiring only (no redesign): `/historical` shows the per-token extraction outcome column + summary line; `/capital` shows the end-to-end chain tables (deployment + profit rotation) with data-driven caveats.
- Codex review (thread 019f5aa0): 3 Critical + 8 Important first pass, then 3 re-review rounds (deployment funding-before-buy timing, truncation/unpriced-safe profit proof + boundary win-eligibility, fully-specified dedupeKey, strict extraction taxonomy, entity-adjusted source keys, nullable unknown entity counts, guarded reconciliation, bounded queries) → final APPROVE.
- OPERATIONAL NOTE: the shared embedded postgres (5439) was briefly stopped and restarted in place during this sprint (clean crash-recovery, all pilot/live data intact). The live shadow run had ALREADY stalled ~8h earlier on its own (last heartbeat 2026-07-13T00:09Z) — a pre-existing condition, not caused by this sprint.
