# Pre-Public Accumulation Refocus — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans, task-by-task. Checkbox (`- [ ]`) steps.
> **Scope note:** user-directed 400-line cap. Phase 0 (built now) is specified to code level; Phases 1-7 are milestone contracts that each get their own full plan at build time (repo SDD pattern). STOP after Phase 0 for operator approval.

**Goal:** Detect hidden/pre-public accumulation FIRST; treat public KOL/copytrader entry as a separate late-stage CROWD ARRIVAL signal. Public on-chain analytics only.

**Architecture:** A wallet-status taxonomy becomes the single structural gate for signal eligibility (replacing scattered isWatched/isExcluded booleans); cohort engines and a shadow-only StealthAccumulationScore build on top; backtest/shadow validate before any threshold changes.

**Tech stack:** existing monorepo (Next 15/React 19, Prisma+PG LITE, Vitest, Zod, tsx). No new deps expected before Phase 4.

## Global Constraints (verbatim from spec)

1. Do not change existing FlowScore yet.
2. New cohort/accumulation metrics start shadow-only.
3. Do not change signal thresholds until backtest/shadow results exist.
4. No execution/trading/private keys. Public on-chain analytics only — no front-running, manipulation, coordinated dumping, identity claims.
5. No Dune fresh execution; DUNE_EXECUTE_FRESH stays false.
6. No BSC or Robinhood in this task.
7. Do not print or commit .env/secrets.
8. Public on-chain + operator-authorized social data only.
9. Never claim linked wallets are the same person (probabilistic labels only).
10. Branch feat/pre-public-accumulation (based on fix/trust-boundary-hardening @ 7ae8cf8, which already delivered: provider-stats meetsProfitable gate, atomic promotion + CAS claim, Dune failed≠empty). Claude sole writer; Codex (gpt-5.6-sol xhigh) read-only adversarial reviewer.

---

## PHASE 0 — TRUST BOUNDARY / TAXONOMY (BUILD NOW)

Design decisions locked by scouting:
- **WalletStatus enum** (new column `Wallet.status`, default `observation_only`): observation_only | signal_eligible | public_kol | public_promoter | copytrader | bot_or_service | excluded. `isWatched` is retained as the operator-watch UI flag but NO LONGER suffices for smartness; `isExcluded` is a dead column (zero code references) superseded by status='excluded' (kept in schema, deprecated in comment — dropping it is a separate cleanup).
- **Eligibility gate is pure + single-point:** `isSignalEligibleStatus(status)` in @flowradar/core; aggregate smartness = eligible AND (isWatched OR meetsProfitable). Nothing else in the codebase may decide eligibility.
- **StatsTrust mapping (pure, no rename migration):** provider→provider_claimed, csv→operator_approved, computed→locally_verified, synthetic→synthetic. StatsSource enum gains additive value `synthetic` (no rows written yet). Storage keeps compact names; taxonomy lives in the mapping fn + docs.
- **Deliberately NOT in Phase 0:** gating stats.walletScore passthrough into aggregates (it feeds existing FlowScore → constraint 1 forbids changing it now; gated in Phase 4 shadow work; recorded in ledger as known minor).
- **Migration authoring:** `npx prisma migrate dev --name wallet_status_taxonomy` inside packages/db (ledger footgun: root db:migrate hardcodes a name). Backfill in the same migration SQL: `UPDATE wallets SET status='excluded' WHERE is_excluded; UPDATE wallets SET status='signal_eligible' WHERE is_watched AND NOT is_excluded;` (rest default observation_only).

### Task 0.1: Schema + migration + backfill
**Files:** Modify `packages/db/prisma/schema.prisma` (WalletStatus enum; `status WalletStatus @default(observation_only)` + `@@index([status])` on Wallet; `synthetic` on StatsSource; deprecation comment on isExcluded). Create migration via prisma migrate dev, then hand-append the two backfill UPDATEs to its migration.sql before applying.
**Produces:** `Wallet.status` readable everywhere; existing DBs backfilled.
- [ ] Write migration, apply to LITE DB, `npx prisma generate`
- [ ] Verify backfill: seeded watched wallets → signal_eligible; count check via psql/prisma
- [ ] Commit `feat(db): wallet status taxonomy schema + backfill`

### Task 0.2: Core eligibility + trust mapping (pure, TDD)
**Files:** Create `packages/core/src/wallets/status.ts` + `packages/core/test/walletStatus.test.ts`; export from core barrel.
**Interfaces (produces):**
```ts
export type WalletStatus = 'observation_only'|'signal_eligible'|'public_kol'|'public_promoter'|'copytrader'|'bot_or_service'|'excluded';
export function isSignalEligibleStatus(status: WalletStatus): boolean; // true ONLY for 'signal_eligible'
export type StatsTrust = 'provider_claimed'|'operator_approved'|'locally_verified'|'synthetic';
export function statsTrustOf(source: 'csv'|'computed'|'provider'|'synthetic'): StatsTrust;
```
- [ ] Failing tests: every status enumerated (only signal_eligible→true); all 4 source→trust mappings — run, expect FAIL
- [ ] Implement; run, expect PASS; commit `feat(core): wallet status eligibility + stats trust mapping`

### Task 0.3: Thread status through aggregate inputs + smartness gate (TDD)
**Files:** Modify `packages/core/src/window/aggregate.ts` (WalletInfoInput gains `status: WalletStatus`; `isSmart = isSignalEligibleStatus(info.status) && (info.isWatched || info.meetsProfitable)`), `packages/db/src/fetchAggregateInputs.ts` (select wallet.status, thread it; meetsProfitable provider-gate from 7ae8cf8 stays). Update every existing WalletInfoInput constructor site (grep `meetsProfitable` in tests/seed) mechanically with an explicit status.
**Tests:** extend `packages/db/test/providerStatsTrustBoundary.test.ts` + new `packages/core/test/aggregateStatusGate.test.ts` — the 5 spec regression cases:
1. provider-claimed excellent stats + observation_only → zero smart contribution
2. observation_only wallet's trades still persisted + present in buyers[], absent from smartWalletCount
3. promoted (signal_eligible) wallet contributes
4. public_kol with excellent stats (even isWatched=true) → NEVER in smart count
5. bot_or_service → never contributes
- [ ] Failing tests first (red run) → implement → green → commit `feat(core,db): status-gated smart-wallet eligibility`

### Task 0.4: Writer sites set status explicitly
**Files:** Modify `packages/db/src/candidateValidation.ts` (promoteCandidate: status='signal_eligible' alongside isWatched=true — create AND update branches), `packages/db/src/csv/importWalletsCsv.ts` (imported wallets → signal_eligible), `packages/db/src/walletDiscovery.ts` (explicit status='observation_only' for provider-discovered), `packages/db/src/seed.ts` (every wallet-create site: watched mock wallets → signal_eligible; discovery mock wallets → observation_only).
**Tests:** extend candidateValidation.test.ts (promotion yields signal_eligible); importer test (csv rows signal_eligible); discovery test (observation_only).
- [ ] Red → green → `MOCK_MODE=true npm run db:seed` must stay 66/66 self-checks → commit `feat(db): writers assign wallet status`

### Task 0.5: Polling respects exclusion; observation persists
**Files:** Modify `apps/worker/src/jobs/walletActivity.ts` wallet query: add `status: { not: 'excluded' }` (observation_only stays polled per spec — activity persisted, zero signal weight). Test in `apps/worker/test/walletActivity.test.ts`: excluded wallet with stats is NOT polled; observation_only IS.
- [ ] Red → green → commit `feat(worker): excluded wallets are never polled`

### Task 0.6: Phase 0 gate
- [ ] Full `npm run verify` green (~1103+ tests) on clean DB; fresh seed 66/66
- [ ] Codex xhigh read-only review of the full branch diff → fix loop until APPROVE
- [ ] Ledger + report to operator. **STOP — no wallet imports until operator approval.**

---

## PHASE 1 — PUBLIC KOL / PROMOTER REGISTRY (milestone contract)
New table `PublicWalletRegistry` (wallet, chain, label public_kol|public_promoter, handle/source, sourceConfidence 0-100, firstSeenAt, lastVerifiedAt, tags[]). Optional connectors: GMGN KOL labels, KOLScan, Cielo labels, Solana Tracker KOL/platform leaderboards (all existing adapter patterns, docs-first, key-gated null→skip), manual CSV/JSON operator list. Registry hits set Wallet.status=public_kol/public_promoter (never signal_eligible; irreversible downgrade wins over promotion). Buys feed crowd-arrival metrics only. Gate: registry rows visible on /sources-style page; status assignment idempotent; tests prove KOL never enters early smart count.

## PHASE 2 — COPYTRADER DETECTOR (milestone contract)
Pure engine in packages/core: for each wallet, across tokens, measure delay-after-public-buy, repeat-follow count, size similarity, same-source grouping, %-of-trades-post-public-entry. Labels possible_copytrader (≥2 follows) / probable_copytrader (≥4 + median delay <30m) / strong_copytrader_pattern (≥6 + delay <10m + size similarity) — thresholds Settings-editable, defaults documented. Worker job assigns status=copytrader (never signal_eligible). Gate: deterministic fixtures prove each label tier + zero contribution to early counts.

## PHASE 3 — PRE-PUBLIC COHORT DETECTION (milestone contract)
Per token, four cohorts: pre_public_cluster (entries before first public_kol/copytrader buy), independent_smart_confirmation (signal_eligible entries, distinct entities, still pre-crowd), public_kol_arrival, copytrader_crowd. New table `TokenCohortSnapshot` (tokenId, cohort, walletCount, uniqueEntities, firstEntryTs, avgEntryPrice/Mcap, buys/sells USD, netPosition, percentSold, realized/unrealizedPnl nullable, fundingSources Json, clusterIds[], publicClassification). Built from existing trades+clusters+funding tables; shadow-only (no FlowScore/Signal reads it). Gate: mock-world cohort snapshots deterministic; NOVA/ALPHA scenarios produce expected cohort splits.

## PHASE 4 — STEALTH ACCUMULATION ENGINE (milestone contract)
Shadow-only StealthAccumulationScore over windows 5m/15m/30m/1h/4h/24h using the spec's 15 metrics (pre-public entity count, add-on buyers, entity growth, net pre-public flow, price-expansion-vs-flow efficiency, %-still-holding, fresh-funded count, linked-receiver activity, rotation count, KOL count, copytrader count, social velocity, raw-vs-unique, concentration). State machine STEALTH_ACCUMULATION → EARLY_INDEPENDENT_CONFIRMATION → PUBLIC_KOL_ARRIVAL → CROWD_EXPANSION → DISTRIBUTION_RISK / INVALIDATED. Also fold in the deferred walletScore trust gate here (shadow side only). Gate: pure engine 100% deterministic fixtures; shadow rows machine-marked; UI page framing-bannered like /shadow.

## PHASE 5 — DISTRIBUTION INTO CROWD (milestone contract)
Shadow warning DISTRIBUTION_INTO_CROWD when: pre-public cohort reduces while KOL/copytrader cohort grows; social rises post-expansion; raw wallets rise but unique entities stall; early-cluster net flow flips negative; CEX/bridge/service transfers rise; early wallets fund fresh sellers. UI must show: early vs crowd cohort behavior, holding-vs-selling of original accumulators, avg early entry mcap vs current, KOL arrival time, social spike time, evidence links. Gate: scripted mock scenario fires the warning end-to-end.

## PHASE 6 — WALLET-FLOW LINKING (milestone contract)
Extend transfer graph to full inbound/outbound: SOL, USDC/USDT, SPL, WSOL, bridge deposits/withdrawals, direct funding, receiver activation, CEX/service labels. Receiver wallets → observation_only automatically, NEVER signal_eligible automatically. Track early→receiver→buy, early→CEX/bridge, profit-A→receiver→B paths (extends Rule F infra). Gate: path fixtures + no-auto-eligibility test.

## PHASE 7 — BACKTEST AND SHADOW (milestone contract)
Extend replay (no-lookahead discipline from T41): compare stealth score with/without public-KOL data; KOL entry timing; social timing; distribution timing; forward returns per stage. Measure lead time STEALTH_ACCUMULATION→+20%/+50%/2x, returns at KOL arrival/crowd expansion, early-cohort sell timing vs KOL entry, false-positive rate, rug rate, unique-entity vs raw-wallet performance. NO profitability claims until a real 7-day+ forward shadow completes. Gate: backtest report artifact + shadow run plan.

---

## Self-review (spec coverage)
Phase 0 requirements → Tasks 0.1-0.6 (side door: 7ae8cf8 + status gate; provider-claimed ≠ eligible: 0.3 test 1; observation persisted: 0.3 test 2 + 0.5; atomic promotion: 7ae8cf8; Dune honesty: 7ae8cf8; statuses: 0.1; trust levels: 0.2; 5 regression tests: 0.3/0.4). Phases 1-7 each map to one milestone section above. Constraint 1 honored by deferring walletScore gate to Phase 4 (documented). Robinhood: nothing to do (never existed in repo).
