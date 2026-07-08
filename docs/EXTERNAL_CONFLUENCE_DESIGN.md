# FlowRadar — External Confluence Modules — Design

**Status:** DESIGN ONLY (no code in this task). Awaiting operator review before implementation.
**Branch:** `feat/external-confluence` (base `main` @ `08fc805`, post social-intel merge).
**Goal:** Add optional, **shadow-only** confluence/evidence modules that enrich a token's picture with holder-risk, liquidity-structure, external provider-claimed intelligence, and paper-trade observations — surfaced as a unified token-detail Confluence panel. **None of this changes FlowScore, the signal rules, wallet scoring, or the candidate pipeline, and none of it trades.**

This layer follows FlowRadar's existing connector conventions verbatim (mirrors `ExternalWalletSource`/`SocialSource`: a DB-managed source registry → config-gated provider adapters → a worker job → point-in-time snapshots → read-only UI cards), so it slots in without new patterns.

---

## Global hard rules (every module inherits these)

1. **Shadow-only confluence/evidence.** Never a primary signal input.
2. **No FlowScore formula changes** (`packages/core/src/scoring/flowScore.ts` untouched).
3. **No signal-threshold changes** (no rule constants / `evaluateAllRules` changes).
4. **No wallet-scoring changes** (`walletScore.ts` untouched).
5. **No CandidateWallet validation/promotion changes.**
6. **External providers never create `Token` rows.** If the token isn't in the DB, store an **unlinked** snapshot keyed by `(chain, tokenAddress)`.
7. **No trading/execution.** No order creation, no swaps, no signing.
8. **GMGN: query-only** — no private key, no swap, no wallet management, no order/execution endpoints.
9. **AG Paper Trading: no automation** — no Telegram button clicking, no bot control.
10. **No BSC** in this track (schema stays chain-aware via `ChainId`, but Solana-only in practice).
11. **No Dune fresh execution.**
12. **`DUNE_EXECUTE_FRESH=false`** stays.
13. **No secrets printed or committed.** `apiKeyEnvName` holds the env-var **name**, never a value; `.env` stays gitignored.
14. **Missing provider keys skip cleanly** (adapter returns `null` → source marked `missing_key`, no crash).
15. **Provider unavailable ⇒ `unknown`/`unavailable`, NEVER `safe`/`clean`.** Absence of data is not a green light.
16. **Provider-claimed metrics are labeled `provider-claimed`** in the UI (distinct from FlowRadar-computed values).

## Non-goals (explicit)

- Any buy/sell recommendation, position sizing advice, or execution.
- Feeding any external metric into FlowScore or the signal engine (a separate, explicitly-approved track later, if ever).
- BSC support; Twitter; Dune fresh queries.
- Scraping private/gated/browser-only content from any provider.
- Requiring a paid API to build or pass the gate — every external provider degrades to `stub`/`missing_key`/`plan_required` and the build stays green with **zero** keys.

---

## Architecture

```
ExternalConfluenceSource (DB registry, operator-managed)
        │  resolve provider by name (MOCK_MODE → mock; live → factory; null → skip)
        ▼
provider adapters (packages/providers/src/confluence/*)      LiquidityRisk (packages/core, PURE, no provider)
  holderscan · clobr · gmgn · agPaper  (config-gated)                │
        │  fetch for KNOWN tokens / operator-supplied addrs only     │ computed from displayed liquidity + mcap
        ▼                                                            ▼
externalConfluence worker job  ──►  TokenConfluenceSnapshot rows (shadow-only; never writes Token/Signal/Candidate)
        │
        ▼
token-detail **Confluence panel** (read-only cards) + source-health surface
```

- **Provider resolution + `MOCK_MODE`**: identical to the social/wallet connectors — `process.env.MOCK_MODE !== 'false'` selects a deterministic mock; live mode resolves per-provider factories that return `null` when their key is absent.
- **LiquidityRisk is internal** (no provider, no key): a pure `@flowradar/core` module fed by the market data FlowRadar already stores (`TokenMarketSnapshot.liquidityUsd` / `marketCapUsd`). It produces an `internal` snapshot.

### Provider status taxonomy (source-level)
`live | mock | missing_key | plan_required | stub | unavailable | rate_limited | error`

### Snapshot status (per fetch)
`ok | unavailable | missing_key | plan_required | rate_limited | error | stub`

**The `unavailable ≠ safe` principle:** every card renders one of `ok` (data present, labeled provider-claimed or internal), `unavailable`/`unknown` (we could not get data), `missing_key`/`plan_required` (operator must configure), or `stub` (no confirmed integration). A card **never** shows a reassuring/"clean" verdict when the underlying data is absent.

---

## Module A — HolderRisk (HolderScan, optional/paid)

**Provider:** HolderScan. Treated as optional and **likely paid/plan-gated** — the build must not depend on it.
**Env:** `HOLDERSCAN_API_KEY` (name stored in `apiKeyEnvName`).
**States:** missing key → `missing_key` (skip); `401/403/402`/quota → `plan_required` (skip, surfaced as "plan required"); `429` → `rate_limited` (backoff/skip); malformed/partial → fields marked `unknown`; **never** infer `safe` from absence.

**`dataJson` fields (all optional / provider-claimed, present only if the plan returns them):**
- `holderCount`
- `holderDelta` — `{ '1h'?, '4h'?, '24h'?, '7d'? }` net holder change
- `topHolderConcentration` — e.g. top-1 / top-5 / top-10 share of supply
- `hhi` / `gini` — concentration indices, if available
- `holderCategories` / `supplyBreakdown` — e.g. exchange / contract / whale / retail buckets, LP-held, locked, team, if available
- `retention` / `medianHoldingDurationDays`, if available
- `providerClaimed: true`, `observedAt`, `sourceName`

**Non-goal:** HolderRisk is confluence only — it does not adjust FlowScore or the token's existing risk penalty. (FlowRadar's own Helius top-holder concentration risk stays as-is; HolderScan is an independent, richer, provider-claimed view shown alongside it.)

---

## Module B — LiquidityRisk (internal, deterministic, NO API key) — implement first

A pure `packages/core/src/confluence/liquidityRisk.ts` module. **Highest value, zero external blockers** → built first (Phase 4).

**Mechanical basis (operator-provided liquidity framework):** constant-product AMM (CPMM) identities. These are **high-confidence for CPMM pools** (Raydium v2 AMM, pump.fun bonding curves, Uniswap-v2-style) and **must be surfaced with explicit caveats** because **concentrated-liquidity pools (Raydium CLMM, Orca Whirlpools, Uni v3) break the simple `L ≈ 2·Q` and `ratio → float` mapping**, and **top-holder concentration / LP lock-or-burn can matter more than the L/MC ratio.**

**Inputs:** `{ displayedLiquidityUsd, marketCapUsd, positionSizeUsd (configurable, default TBD), poolType?: 'constant_product'|'concentrated'|'unknown', poolMeta? }`

**Formulas (CPMM approximations — every output carries the caveat):**
- `liquidityToMcapRatio = L / MC`
- `poolFloatFractionEstimate ≈ ratio / 2` (token value in a 50/50 pool ≈ `L/2` ⇒ float `f ≈ L/(2·MC)`)
- `overhangMultiple = 2/ratio − 1` (non-pool supply vs pool-held supply)
- `estimatedOneWaySlippagePct ≈ 2·S / L` for position `S = positionSizeUsd`
- `dumpToHalveUsd ≈ 0.207 × L` (sell value to halve price in a CPMM pool)
- `positionSizeMaxFor2PctSlippage ≈ 0.01 × L` (i.e. `L ≥ 100 × intended size` for ~2% one-way slippage)

**Qualitative bands (shadow-only DISPLAY heuristics, Settings-configurable defaults, NOT FlowScore):**
- `absoluteLiquidityBand`: micro / thin / moderate / deep (proposed defaults `<$10k / <$50k / <$250k / ≥$250k`).
- `ratioFragilityBand`: very-fragile / fragile / moderate / robust (proposed defaults on `L/MC`: `<2% / <5% / <15% / ≥15%`).

**Outputs:** `{ liquidityToMcapRatio, poolFloatFractionEstimate, overhangMultiple, estimatedOneWaySlippagePct, dumpToHalveUsd, positionSizeMaxFor2PctSlippage, absoluteLiquidityBand, ratioFragilityBand, caveats: string[], confidence: 'high'|'medium'|'low' }`

**Caveat + confidence rules:**
- `poolType === 'constant_product'` (or `unknown` with a stated assumption) → apply the identities; `confidence: 'high'` (single fresh CPMM pool) down to `'medium'` (unknown/aggregated).
- `poolType === 'concentrated'` → **do not** trust the ratio→float / slippage mapping; emit a prominent caveat and `confidence: 'low'`, still showing the numbers but clearly flagged as unreliable for CLMM.
- Always append caveats for: aggregated/multi-pool displayed liquidity, possibly-stale market data, and "holder concentration + LP lock/burn can dominate this ratio."
- **No buy/sell advice.** Bands describe fragility, not action.

---

## Module C — CLOBr (optional / stub)

**Provider:** CLOBr (order-book / liquidity-distribution). **Stub-only unless a confirmed public API + docs exist** (see Open Decisions).
**Env:** `CLOBR_API_KEY` (optional).
**States:** no confirmed API/docs → `stub` (renders "not integrated"); missing key → `missing_key`; endpoint down → `unavailable`; **no scraping** of private/gated/browser-only content.

**`dataJson` fields (design target, if/when an API is confirmed):**
- `depth` around current price at `±1% / ±2% / ±5% / ±10%` (buy-side vs sell-side USD)
- `buySideSupportUsd` vs `sellSideResistanceUsd`
- `liquidityBuckets` (support/resistance clusters)
- `dcaLimitPressure` if available
- `providerClaimed: true`

---

## Module D — GMGN (query-only external intelligence)

**Provider:** GMGN. **Query-only, optional.** **Hard-forbidden:** swap, private key, wallet management, order creation, any execution endpoint.
**Env:** `GMGN_API_KEY` (optional).
**States:** if API/docs unclear → `stub`/`status` only; missing key → `missing_key`; unavailable → `unavailable`.

**`dataJson` fields (all `provider-claimed`, read-only):**
- `trending` / `trenches` discovery signals
- `tokenFundamentals` (provider's view)
- `topHolders` / `topTraders`
- `labels` — smart-money / KOL / bundler / insider-like — **explicitly `provider-claimed`, never asserted as fact** (matches FlowRadar's probabilistic-label ethic).

**Enforcement:** a test asserts the GMGN adapter references **zero** swap/order/execution/private-key endpoints (grep guard).

---

## Module E — AG Paper Trading (manual / stub only)

**Source:** `https://t.me/agPaperTradingBot`, treated as an **optional paper/shadow observation source**. **No automation, no button clicking, no execution, no private keys, no scraping**, and **no assuming an API exists without docs**.
**Env:** none required initially.
**Supported ingestion (only if one exists):** a documented export/API, an operator-provided CSV, a defined manual-import format, or operator-supplied text converted manually **outside** this task.

**Allowed data:** paper journal import — `tokenAddress`, `chain`, `paperEntryAt`, `paperExitAt`, `paperEntryPrice`, `paperExitPrice`, `paperPnlPct` (if provided), `notes` — for **comparison** against FlowRadar / social / wallet signals.
**Not allowed:** clicking bot buttons, executing trades, private-key usage, bypassing Telegram bot limits, or treating paper outcomes as real execution.

---

## Module F — Unified Confluence panel (token detail)

A read-only **Confluence** section on `/tokens/[id]` (fold into the token page, consistent with the social section; an optional `/confluence` overview page is a nice-to-have, see Open Decisions).

**Cards:** Liquidity Risk · Holder Risk · CLOBr liquidity map · GMGN external intel · AG Paper observations · **Social + Wallet + External overlap summary**.

**Every card labels its state clearly:** `shadow-only`, `provider-claimed` (vs internal/computed), `unavailable`, `unknown`, `plan-required`, and **`not part of FlowScore`**.

**Conflict-aware, not confirmation-biased:** the summary must **surface disagreement** between sources (e.g. "smart-money accumulating (wallet signal) but liquidity very fragile + top-holder concentration high" or "GMGN labels bullish while holder count is declining"), not only positive confirmation. Show `⚠ sources disagree` prominently.

---

## Schema plan (lean — proposed, not implemented)

Reuse `ChainId`, cuid ids, `@@map` snake_case, `apiKeyEnvName`-holds-a-name conventions.

### 1. `ExternalConfluenceSource` (registry)
```
id                 String  @id @default(cuid())
name               String  @unique
provider           String              // holderscan | clobr | gmgn | ag_paper | manual
enabled            Boolean @default(true)
apiKeyEnvName      String?             // env var NAME only; null for keyless (manual/internal)
rateLimitPerMinute Int     @default(30)
status             String  @default("idle") // idle|live|missing_key|plan_required|stub|unavailable|rate_limited|error
lastSyncAt         DateTime?
lastError          String?
failCount          Int     @default(0)
metadataJson       Json?
addedAt            DateTime @default(now())
@@map("external_confluence_sources")
```

### 2. `TokenConfluenceSnapshot` (shadow-only point-in-time evidence)
```
id           String  @id @default(cuid())
tokenId      String?             // FK→Token when it exists; null = unlinked (NEVER creates a Token)
chain        ChainId
tokenAddress String
sourceId     String?             // FK→ExternalConfluenceSource; null for the internal LiquidityRisk snapshot
provider     String              // holderscan | clobr | gmgn | ag_paper | manual | internal
snapshotType String              // holder_risk | liquidity_risk | liquidity_map | external_intel | paper_trade
status       String              // ok | unavailable | missing_key | plan_required | rate_limited | error | stub
dataJson     Json                // the computed/provider-claimed metrics — MUST contain no secrets
observedAt   DateTime
ingestedAt   DateTime @default(now())
dedupeKey    String              // NON-NULL, e.g. `${provider}:${snapshotType}:${tokenAddress}:${observedBucket}`
metadataJson Json?
@@unique([sourceId, tokenAddress, snapshotType, dedupeKey])
@@index([tokenId]); @@index([chain, tokenAddress]); @@index([provider, snapshotType]); @@index([observedAt])
@@map("token_confluence_snapshots")
```
> `dataJson` is display-safe only (no secret values). "score/display fields" live inside `dataJson`; there is **no** column that participates in FlowScore.

### 3. `PaperTradeObservation` (OPTIONAL — build only if the AG Paper import is built)
Justification: a paper trade has an entry→exit→PnL shape over time that a point-in-time snapshot models awkwardly; a dedicated table keeps the comparison view clean. **Skip it entirely** if AG Paper stays stub-only.
```
id             String  @id @default(cuid())
tokenAddress   String
chain          ChainId
source         String              // "ag_paper" | "manual"
paperEntryAt   DateTime?
paperExitAt    DateTime?
paperEntryPrice Decimal? @db.Decimal(38,18)
paperExitPrice  Decimal? @db.Decimal(38,18)
paperPnlPct    Float?
notes          String?
dataJson       Json?
observedAt     DateTime
@@index([chain, tokenAddress])
@@map("paper_trade_observations")
```
**Never** an execution record — observation only.

---

## Settings additions (`packages/core/src/settings.ts`)

Add `connectors.externalConfluence` (Zod + defaults), additive:
```
externalConfluence: {
  syncHours: <default>,
  liquidityRisk: {
    positionSizeUsd: <default, e.g. 1000>,     // for slippage estimate
    absoluteLiquidityBandsUsd: [10000, 50000, 250000],
    ratioFragilityBands: [0.02, 0.05, 0.15]
  }
}
```
Per-source `enabled` lives on the `ExternalConfluenceSource` row (UI-managed), not in settings.

---

## Worker integration (`apps/worker/src/jobs/externalConfluence.ts`)

Mirrors `externalWalletSource`/`socialIngest`. Per pass:
1. Load **enabled** `ExternalConfluenceSource` rows.
2. Resolve provider (mock / live factory / `null` → skip with the right status).
3. **Compute LiquidityRisk internally** for tokens that have market data (no source needed).
4. Fetch external data **only for tokens already in the DB or operator-supplied addresses** — never discover-and-create tokens.
5. Upsert `TokenConfluenceSnapshot` (idempotent by `dedupeKey`); update source health.
6. **Never** create `Token` rows, write `Signal`/`Alert`/`CandidateWallet`, or touch FlowScore.
7. Log honest per-provider statuses; **Dune execute count stays 0.**
Registered on `settings.connectors.externalConfluence.syncHours * 3600`. Surface source health on the existing `/sources` (or a dedicated Confluence health card) + the token panel.

---

## Security requirements

- `apiKeyEnvName` stores env-var **names** only (`HOLDERSCAN_API_KEY`, `CLOBR_API_KEY`, `GMGN_API_KEY`) — never values.
- Source APIs/status must **never** return a resolved `process.env` value — presence is derived as a boolean only (same pattern as `getSocialSourceStatuses`).
- `dataJson` / `metadataJson` must never carry a secret.
- Provider absence/unavailability **must not** render as `safe`/`clean` (constraint 15).
- No client component may import a server-only key path; keep any `node:` builtins out of the `@flowradar/core` barrel (the social contentHash/cyrb53 lesson).

---

## Testing strategy (high-level; detailed in the plan)

Formula tests (LiquidityRisk + CLMM caveats); missing-key skip (HolderScan); `plan_required` on 402/403 (HolderScan); CLOBr stub skip; GMGN query-only enforcement (no swap/order/key endpoints referenced); AG Paper manual/stub-only; `unavailable ⇒ unknown, not safe`; external snapshots never create Token rows; no FlowScore/threshold/CandidateWallet changes; source API never leaks `process.env`; Dune execute stays 0; `npm run verify` green.

---

## Open decisions (need operator input before / during implementation)

1. **HolderScan** — do you have an API key + a plan that returns holder deltas/concentration? If unknown, the adapter ships plan-aware and reports `missing_key`/`plan_required`; **not a build blocker**.
2. **CLOBr** — is there a confirmed public API + docs? If not, it stays a **stub** (no scraping). Please confirm before any live adapter.
3. **GMGN** — confirm the available **query-only** endpoints/docs. If unclear, ship a stub/status adapter only.
4. **AG Paper** — likely no public API; default is a **manual CSV import** format. OK to define a CSV schema, or keep it stub-only for now?
5. **LiquidityRisk `positionSizeUsd` default** (proposed $1,000) and the **band thresholds** — confirm or adjust.
6. **UI placement** — token-detail Confluence panel (primary, recommended) plus an optional `/confluence` overview page? Or token-detail only for v1?
7. **`PaperTradeObservation` table** — include now (if building AG Paper import) or defer until an import path is confirmed?

---

## Recommended implementation order

1. **Schema + migration** — `ExternalConfluenceSource` + `TokenConfluenceSnapshot` (+ `PaperTradeObservation` only if AG Paper import is in v1).
2. **LiquidityRisk pure module** (Phase 4) — no key, deterministic, unit-tested incl. CLMM caveats. **Highest value, zero blockers.**
3. **Provider framework** — types, `getConfluenceSourceStatuses`, mock provider, `connectors.externalConfluence` settings.
4. **HolderScan adapter** — config-gated, plan-aware; stub-first if no key.
5. **GMGN query-only adapter** + **CLOBr stub** (status-only unless docs confirmed).
6. **AG Paper manual import** (CSV) — optional, only if a format is agreed.
7. **`externalConfluence` worker job** — internal LiquidityRisk + external fetch for known tokens; never creates Tokens.
8. **Unified Confluence panel** (token detail) + source health.
9. **Tests + final gate** (verify, route smoke, all-keys-missing smoke, mock-provider smoke, scope/secret/Dune scans).

*This document is design-only. No schema, code, or migration has been created. Implementation begins only after operator review, starting with LiquidityRisk (no paid API required).*
