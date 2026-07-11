# GMGN + Behavioral Wallet Intelligence — Implementation Plan

**Branch:** `feat/gmgn-runner-behavior` (stacked on `feat/pre-public-accumulation` @ `a3401fa`; PR base = that branch).
**Scope:** ONLY missing work. Everything below reuses canonical models already proven complete:
`Wallet`/`WalletStatus` gate, `ObservationProviderSnapshot` (shadow provider claims), `MoneyFlowEdge`
(+valuation), `WalletRelationship`, `EntityCluster(Wallet)`, `MonitoringSubscription`, `StealthSnapshot`
(+`runStealthPass`), `runnermining` pure engine (outcome/entry/no-lookahead), `importObservationUniverse`,
`walletActivity` budget, test/live DB isolation, shadow-run controller.
**Protected:** the live shadow run `shadow-20260711105525-9280`. No live-DB writes from this branch
until a task's explicit live-write gate; all tests on `flowradar_test`.
**Shadow-only:** every new metric/classification. No FlowScore/threshold/promotion change. No execution surface.

## Task 1 — GMGN read-only capability probe (auth now configured)
- Inspect `gmgn-cli help` per family BEFORE invoking; tiny probes (limit≤10) for: track smartmoney,
  track kol, track follow-wallet (only if help proves read-only), market trenches, market trending,
  token info/security/pool/holders/traders, portfolio holdings/stats/activity.
- Document per command: exact form, chains, pagination/cursor, max limit, fields, timestamps,
  rate behavior, 30d stats presence, buy/sell/transfer distinction, wallet-address exposure, KOL labels.
- Deliverable: `docs/GMGN_READ_ONLY_CAPABILITY_REPORT.md`. On auth failure: record exit code +
  sanitized stderr, mark GMGN tasks blocked_by_auth, continue Tasks 5–8.
- Guards: extend the existing static grep guard; ADD a runtime allowlist module
  (`packages/providers/src/gmgn/allowlist.ts`) — the ONLY path FlowRadar may exec gmgn-cli through;
  tests prove forbidden families (swap/multi-swap/order/cooking/sign/wallet-mgmt/GMGN_PRIVATE_KEY) throw.

## Task 2 — GMGN provider + raw observation ingest
- New `GmgnObservation` model (append-only raw feed rows): provider/chain/sourceCommand/wallet/token/
  activityType/side/amount/usd/providerPnl/providerWinRate/providerTradeCount/activityTs/retrievedAt/
  rawClassification/kolFlag/cursor/dataQuality. Dedup key (sourceCommand, wallet, token, activityTs, side).
- Provider `packages/providers/src/gmgn/gmgnCli.ts`: spawns gmgn-cli THROUGH the runtime allowlist,
  parses `--raw` JSON, bounded requests, cursor persistence (ProviderSyncState), Retry-After + backoff,
  per-command budgets, per-feed error isolation.
- Wallet materialization: upsert observation_only (preserve existing statuses); provider claims →
  `ObservationProviderSnapshot` (NEVER WalletStats); KOL-tagged → public_kol/public_promoter status
  only with provider evidence recorded; zero smart votes (status gate already enforces).
- Live-write gate: ingest runs against live DB ONLY via an explicit `--apply` script after Codex APPROVE
  (additive rows only: observations/snapshots/wallets).

## Task 3 — Candidate buffer (no blind active import)
- New `CandidateBuffer` model (or extend GmgnObservation aggregation view): deduped cross-source
  candidate records with sourceCategory enum (global_smartmoney/token_top_trader/trenches_early_trader/
  trending_trader/public_kol/public_promoter/probable_copytrader/bot_or_service/lineage_receiver/
  repeat_runner_candidate), cross-source confirmation count, first/last seen.
- Target 2,000–5,000 raw observations quota-permitting; audition promotion (to hot polling) gated by
  Task 10 — buffer alone never touches Helius polling.

## Task 4 — Wallet behavior reconstruction (GMGN + local)
- `packages/db/src/behavior/reconstruct.ts`: per candidate wallet, merge LOCAL truth
  (WalletTokenTrade, MoneyFlowEdge, relationships, entry contexts via runnermining engine where series
  exist) with GMGN provider claims (portfolio stats/activity — provider_claimed provenance per field).
- Output `WalletBehaviorProfile` rows: buys/sells/transfers timelines, holdings, realized/unrealized
  (provider vs local separately), trade count, active days, token diversity, repeat entries,
  partial/full exits, hold durations, KOL/crowd timing, funding paths, entry mcap where local.
  Missing = null, never fabricated.

## Task 5 — Behavior classification engine (independent derivation)
- Pure core `packages/core/src/behavior/`: classifier over reconstructed profiles + lineage/cluster
  evidence. Canonical classifications (multi-label) per the directive list (same_block_launch_cluster …
  rejected_dirty_data). Each: componentMetrics, confidence, independentTokenRepetition, evidence tx refs,
  exampleTokens, first/last observed, caveats, dataQuality, classifierVersion.
- DB `WalletBehaviorClassification` rows; shadow-only; no eligibility path.

## Task 6 — Buy/hold vs fast-dump classifier (subset of Task 5, first)
- Pure metrics: rapid-exit buckets (1m/5m/30m/2h, median first-sell/full-exit, % fast-exit),
  holding buckets (1h/6h/24h/72h, median hold, partial/full ratio, retention after 2x/5x where known),
  exit-into-crowd (KOL arrival vs sell timing, % sold, repetition), position quality (buy evidence,
  exit liquidity, outcome, residue). Labels: durable_holder/selective_swing_trader/fast_flipper/
  probable_distribution_pattern/illiquid_stuck_holder/received_not_bought/worthless_residue.
- Neutral wording; no intent claims; unknown stays unknown.

## Task 7 — Same-block / crew / side-wallet engine
- Reuses MoneyFlowEdge + WalletRelationship + EntityCluster + bridge/rotation matchers.
- same_block_launch_cluster: tight-slot co-entry AND (shared funder | direct transfer | similar funding)
  AND repetition; timing alone never high-confidence. repeated_coordinated_crew: repetition across
  independent tokens (co-entry/exit sync/shared funding/common receiver/bridge/rotation); service nodes
  excluded via AddressRegistry. Side wallets: evidence-weighted possible/probable/strong_onchain_link.
- All outputs observation_only; entity-adjusted.

## Task 8 — Distribution / destructive-exit patterns
- distribution_into_later_buyers (reductions vs rising later-buyer/entity/KOL participation, repetition),
  single_burst_exit (dominant exit in short window; exclude dust/residue/migrations/router legs/illiquid
  artifacts), launch_team_linked_destructive_exit (REQUIRES creator/funding linkage + receipts).
- Same receipts/caveats contract as Task 5.

## Task 9 — Runner mining Tasks 3–6 (Birdeye per completed probe)
- T3 history reconstruction: Helius wallet trades (local ingest) × Birdeye OHLCV series
  (candle-END ts, labeled supply assumption) → entries via `computeEntryContext`; winners+losers+rugs+
  dead+illiquid+incomplete all included; ≤1 rps budget, request accounting.
- T4 mining: repeat-runner/entity aggregation with bias controls + sample-size guards + sensitivity
  (3 threshold sets reported). T5: observation-only candidate output (reuses import path). T6: feed
  qualified wallets into stealth evidence (Task 11).
- Machine-readable outputs: runner universe, wallet-token edges, quality table, candidate batch,
  rejection reasons.

## Task 10 — Active audition universe (gated)
- Stage A: census + shadow health from run heartbeats/checkpoints. KNOWN ISSUE recorded: flowScoring
  Helius RPC risk checks 429-burst in the live run — Stage B/C gates (no sustained 429) will honestly
  FAIL until that path is bounded; the fix is implemented on THIS branch (bounded token risk-check
  budget) but only reaches the live run at a controller-mediated resume the OPERATOR approves.
- Stage B 750 / Stage C 1,000 only after first daily checkpoint passes gates; cold/excluded demotion
  for low-quality candidates (evidence preserved).

## Task 11 — Stealth enrichment (no rebuild)
- Extend `StealthEvidence` (additive fields): repeatEarlyBuyerCount, durableHolderCount,
  fastFlipperCount, probableDistributionCount, sideWalletCrewConcentration, adverseHolderSupplyPct,
  runnerQualifiedCount, dataConfidenceConflicts. Penalize-only or evidence-only (KOL/copytrader still
  never raises score); entity-adjusted; explanations carry receipts.

## Task 12 — Pre-bond token scanner
- `packages/db/src/scanner/tokenBehaviorScan.ts`: for a token → holders (local truth; GMGN token
  holders where probed), entity resolution, behavior profiles, per-class supply %, same-block/crew/
  side-wallet supply, repeat-early-buyer count, KOL/copytrader count, evaluated-vs-unknown coverage,
  conflicts, receipts. Never "safe"/"rug" labels; unknown ≠ safe.

## Task 13 — Scan surfaces (engines first, UI minimal)
- Read-only API routes + minimal pages: wallet scan (history, classifications, links, receipts,
  provider-vs-local provenance) and token scan (holder cohorts, adverse supply, coverage). Styling last.

## Task 14 — Receipts system (cross-cutting, built INTO Tasks 5–8/12)
- Shared `Receipt` JSON contract: token, tx signatures, timestamps, entry/exit mcap, amounts, hold
  duration, liquidity context, counterparties, funding path, cluster evidence, source, confidence,
  caveats, explorer links. Contradiction/missing ⇒ lower confidence or insufficient_history/dirty_data.

## Task 15 — Shadow-run compatibility (continuous)
- No live writes outside gates; additive-only migrations applied to live ONLY when the running worker
  is proven compatible (new tables it never touches) — else deferred to a checkpoint window.
- Per daily checkpoint: report observations/classifications/stealth transitions/edges/errors/RSS/DB
  growth/coverage. No 7-day claims before 2026-07-18.

## Order of execution
1 (probe+guards) → 2 (provider+ingest, test-DB first) → 3 (buffer) → 6 (fast-dump metrics — needed by 5)
→ 5 (classifier core) → 7 → 8 → 4 (full reconstruction w/ GMGN portfolio) → 9 (runner 3–6) → 11 → 12 →
13 → 10 (gated) → 15/final gate. Each unit: red tests → impl → Codex → APPROVE → isolated commit → push.
