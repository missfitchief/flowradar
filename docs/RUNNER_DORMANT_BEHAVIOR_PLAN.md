# Runner / Dormant / Behavior Sprint — Implementation Checklist

Branch `feat/runner-dormant-behavior` (stacked on `feat/gmgn-runner-behavior` @ 7e4dac4; PR base = that branch). Claude sole writer; Codex adversarial reviewer; shadow run untouched; tests on `flowradar_test`; every hard rule from the directive applies verbatim (FlowScore/thresholds frozen, shadow-only outputs, observation_only, no-lookahead, losers included, no Dune fresh, no BSC, receipts everywhere).

## T0 — TokenFlowSnapshot storage bound (URGENT)
- [ ] Measure on live (read-only): rows/min/hour, rows/token, writer paths, duplicate rate (identical consecutive snapshot per token), consumer needs (stealth/replay/alerts/UI/outcomes), table+index size, 7-day projection.
- [ ] Pure `shouldPersistFlowSnapshot(prev, next, cfg)`: persist iff (a) no prev, (b) material change (score/state/counts delta), (c) state transition or signal linkage, (d) routine-cadence bucket elapsed (`flowSnapshotRoutineSec`, default 900). Metrics: attempted/inserted/dedupSkipped/unchangedSuppressed/transitionsPreserved.
- [ ] Wire into `runFlowScoringPass` (both callers inherit). No schema change; no historical deletion this sprint (retention = documented follow-up needing controller window).
- [ ] Tests: transition always persists; unchanged suppressed within bucket; bucket boundary persists; replay determinism unchanged; metrics honest.
- [ ] Codex review → commit. Rollout note: reaches live only at next approved resume (no hot-swap).

## T1 — Canonical historical token universe (pilot-scale first)
- [ ] `packages/core/src/runnermining/universe.ts` (extend existing runnermining): canonical `TokenLifecycle` (mint, launch/first-trade ts, venue transitions, price/supply/liquidity provenance, ATH mcap + ts, drawdown, outcome labels incl. failed/rug/dead/insufficient, coverage/confidence). Lifecycle canonicalization: bonding→migration→pools = ONE lifecycle.
- [ ] DB: `token_lifecycles` table (test-DB migration only). Builder from LOCAL data first (10,489 tokens, 249k trades, market snapshots) + Birdeye OHLCV enrichment (existing proven client, ~1rps, bounded budget, honest gaps).
- [ ] Outcome labels evaluation-only; no replay/live path may read them (static guard test).

## T2 — $10M+ runner cohort
- [ ] From lifecycles: `verified_above_10m` via historical ATH mcap only (never current); coverage classes verified_below/insufficient/missing_price/missing_supply/ambiguous. Honest coverage report.

## T3 — Matched controls
- [ ] Matcher on launch period/venue/initial mcap+liquidity/age (no future-behavior leakage); control outcome classes; store criteria+confidence.

## T4 — First/early-buyer extraction
- [ ] From LOCAL trades first (entries with entry-mcap buckets under_5k…above_1m, slot, sig, provenance); Birdeye top-traders/first-buyer enrichment where quota permits (probe limits first, no guessed shapes).

## T5 — Full wallet-token history (RM Task 3)
- [ ] Extend existing behavior reconstruction (NOT rebuild): per wallet-token — adds/partials/exits/transfers, avg entry/exit, realized/residue, hold, entry mcap + provenance, KOL/crowd timing where known, funding path, entity link, outcome (evaluation-only), field confidence. received_not_bought / worthless_residue / transfer_not_sale via existing engines + outcome map. No-lookahead: reconstruction inputs carry no outcome fields (type-level separation + runtime guard).

## T6 — Meaningful-activity classifier (pure, versioned)
- [ ] `packages/core/src/dormancy/meaningfulActivity.ts`: DEX trade / meaningful SOL/stable/SPL transfer / bridge / LP / funding = meaningful; dust/spam/airdrop-passive/program-noise/tiny-unknown = not. Config thresholds documented; per-decision receipt {event, verdict, rule version, reason, confidence}.

## T7 — Address dormancy engine (pure)
- [ ] `packages/core/src/dormancy/dormancy.ts`: strictly-pre-entry window; age-at-entry, last meaningful, dormancy duration, counts 1/7/14/30/90d, first-ever-trade, funded-shortly-before, empty-before-funding. Classes fresh/active/dormant_7/14/30/90/reactivated_after_funding/insufficient/ambiguous. Rules: fresh≠dormant; missing≠dormant; future events invisible; dust never resets.

## T8 — Entity-adjusted dormancy
- [ ] Combine with relationships/clusters: address_dormant_entity_active etc.; independent-dormant only when entity evidence supports it; address vs entity evidence kept separate.

## T9 — Dormant funding/lineage analysis
- [ ] Reuse lineage edges: first/direct/gas funder, funding→buy delay, root→dormant→buy patterns, common-funder fanouts. observation_only always.

## T10 — Post-entry hold/exit for dormant cohort
- [ ] Reuse hold/dump classifier over dormant entries; dormant_* labels; holding positive only with buy+liquidity+value+repetition.

## T11 — Repeat-runner mining (RM Task 4)
- [ ] `packages/core/src/runnermining/repeatRunner.ts`: per entity — evaluable entries, win/loss/rug counts, runner_2x/5x/10x + 7/8/9-figure counts, streaks, low-MC buckets + win rate, entry-mcap p25/50/75, lead times, milestone retention, PnL + concentration (top1/top3 share), one-hit score, KOL-follow rate, bot/MM likelihood (existing receipts), entity-adjusted, coverage. Classes per directive with sample guards (1-2 winners never elite). Threshold sensitivity: conservative/balanced/permissive counts from observed distributions.

## T12 — Repeat dormant-runner mining
- [ ] Join T7/T8 with T11: dormant-entry runner stats, runner-vs-control lift, classes elite/strong/promising_dormant etc. with guards.

## T13 — Bullscan-inspired engine: REUSE existing receipts engine (Task 5 prior sprint); extend only where directive adds requirements (funding-corroborated launch clusters, service-node exclusion in crews) — no rebuild.

## T14 — Negative evidence
- [ ] `packages/core/src/runnermining/negativeEvidence.ts`: penalty components (concentration, post-KOL entry, immediate exits, botlike, received-not-bought, residue-as-hold, illiquid PnL, entity collapse, single-regime success, control underperformance) each with receipts; no opaque scores.

## T15 — Wallet DNA integration
- [ ] Extend WalletBehaviorProfile.classifierJson with `runnerDna` components (each linking receipts); shadow-only.

## T16 — Observation-only candidate output (RM Task 5)
- [ ] Machine-readable JSON outputs under `data/runner-mining/` (gitignored) + CandidateWallet rows source `runner_mining:*` (existing buffer taxonomy already supports); rejected table with reasons; zero signal contribution.

## T17 — Live shadow integration (RM Task 6)
- [ ] Shadow evidence rows when qualified entities buy new tokens + stealth-engine SHADOW components (qualified counts, dormant entries, negative burden). No FlowScore/threshold mutation; deploys only at next approved resume.

## T18 — Pre-bond behavior scanner
- [ ] Compose T5-T17 outputs per new token: cohort counts, adverse/sharp supply %, cluster-adjusted, coverage/confidence/conflicts/receipts; neutral verdict vocabulary only.

## T19 — Receipts: enforced via existing receipts engine contract on every new classification (component metrics + txs + provenance + confidence + caveats + version + links).

## T20 — Scan surfaces: engines first; UI deferred (explicitly last, not this sprint unless budget remains).

## Pilot + reports
- [ ] Bounded REAL pilot: local-data-first universe + Birdeye enrichment within quota; runner cohort + controls + dormancy + mining on real rows; `docs/RUNNER_DORMANT_WALLET_MINING_REPORT.md` with actual counts or honest coverage shortfall.
- [ ] Final: verify green on flowradar_test; live DB untouched by tests; Codex whole-branch APPROVE; push; update PR; `docs/RUNNER_DORMANT_BEHAVIOR_FINAL_REPORT.md`; DONE/PARTIAL/BLOCKED.

Execution order: T0 → T6 → T7 → T1(local-first) → T2/T3 → T4/T5 → T11 → T14 → T8/T9/T10/T12 → T15/T16 → T17/T18 → pilot → reports. Each unit: red tests → impl → focused tests → self-review → Codex → fix → commit → push.
