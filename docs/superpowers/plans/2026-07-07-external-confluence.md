# External Confluence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to execute this plan. Each task (A..F) is an independent, TDD-ordered unit of work; dispatch one subagent per task, in order, and gate each on its Done Bar before proceeding.

**Goal:** Add optional, **shadow-only** confluence/evidence modules that enrich a token's picture with holder-risk, liquidity-structure, external provider-claimed intelligence, and paper-trade observations — surfaced as a unified token-detail Confluence panel. **None of this changes FlowScore, the signal rules, wallet scoring, or the candidate pipeline, and none of it trades.**

**Architecture:**

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

**Tech Stack:** TypeScript monorepo — `@flowradar/core` (pure, Zod), `@flowradar/providers` (provider adapters), `@flowradar/db` (Prisma + LITE embedded Postgres on :5439), `apps/worker` (scheduled jobs), `apps/web` (Next.js server components). Vitest for all tests. Prisma migrations. Solana-only in practice (schema stays chain-aware via `ChainId`).

## Global Constraints

Every module inherits these hard rules verbatim from the design doc.

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

---

## File Structure

**Task A — LiquidityRisk pure core module + settings**
- `packages/core/src/confluence/types.ts` (create) — pure shared types (LiquidityRisk contract) for the confluence subsystem.
- `packages/core/src/confluence/liquidityRisk.ts` (create) — pure, sync `computeLiquidityRisk(input, cfg)` (CPMM identities, bands, caveats, null guards).
- `packages/core/src/confluence/index.ts` (create) — barrel re-exporting `./types` + `./liquidityRisk`.
- `packages/core/src/index.ts` (modify) — add `export * from './confluence/index';`.
- `packages/core/src/settings.ts` (modify) — add `ExternalConfluenceConfigSchema` + `LiquidityRiskSettingsSchema`, wire `externalConfluence` into `ConnectorsSchema` + `DEFAULT_SETTINGS`.
- `packages/core/test/confluence/liquidityRisk.test.ts` (create) — formula/band/caveat/guard unit tests.
- `packages/core/test/confluence/settings.test.ts` (create) — settings defaults + parse/merge tests.

**Task B — Schema + migration**
- `packages/db/prisma/schema.prisma` (modify) — add `ExternalConfluenceSource`, `TokenConfluenceSnapshot`, `Token.confluenceSnapshots` back-relation.
- `packages/db/prisma/migrations/<timestamp>_external_confluence/migration.sql` (create, tooling-generated) — the applied migration.
- `packages/db/test/confluenceSchema.test.ts` (create) — LITE-Postgres schema-behavior integration test.

**Task C — Provider framework + stubs + source status**
- `packages/providers/src/confluence/types.ts` (create) — `ConfluenceFetchResult`, `ConfluenceProvider`, `ConfluenceSourceMode`, `ConfluenceSourceStatusRow`.
- `packages/providers/src/confluence/mockConfluence.ts` (create) — deterministic `MockConfluenceProvider`.
- `packages/providers/src/confluence/holderscan.ts` (create) — `createHolderScanProvider(env)` (plan-aware stub).
- `packages/providers/src/confluence/clobr.ts` (create) — `createClobrProvider(env)` (stub-only).
- `packages/providers/src/confluence/gmgn.ts` (create) — `createGmgnProvider(env)` (query-only stub).
- `packages/providers/src/confluence/agPaper.ts` (create) — `createAgPaperProvider()` (manual/stub, CSV shape in comment).
- `packages/providers/src/confluence/sourceStatus.ts` (create) — `getConfluenceSourceStatuses(prisma)`.
- `packages/providers/src/confluence/index.ts` (create) — barrel.
- `packages/providers/src/index.ts` (modify) — add `export * from './confluence';`.
- `packages/providers/test/confluenceSources.test.ts` (create) — full provider behavior suite.
- `packages/providers/test/gmgnQueryOnlyGuard.test.ts` (create) — GMGN grep-guard (zero swap/order/key/wallet endpoints).

**Task D — Worker + reusable pass + seed**
- `packages/db/src/confluence/ingest.ts` (create) — `runExternalConfluencePass` (internal LiquidityRisk leg + external per-source fetch).
- `packages/db/src/index.ts` (modify) — add `export * from './confluence/ingest';`.
- `apps/worker/src/jobs/externalConfluence.ts` (create) — thin `run(ctx)` wrapper (mock/live/null-skip resolveProvider).
- `apps/worker/src/index.ts` (modify) — register `externalConfluence` on `syncHours * 3600`.
- `packages/db/src/seed.ts` (modify) — Phase 3.8: seed 2 disabled `ExternalConfluenceSource` rows + one internal pass; add wipe entries.
- `packages/db/test/externalConfluence.test.ts` (create) — DB integration for the pass (internal/external/skip/idempotent/try-catch).

**Task E — Token-detail Confluence panel + query helper**
- `packages/db/src/confluence/queries.ts` (create) — `getTokenConfluence(prisma, tokenId)` read helper.
- `apps/web/components/tokens/ConfluencePanel.tsx` (create) — read-only server component (five cards + overlap + source health).
- `packages/db/src/index.ts` (modify) — export the confluence query helpers.
- `apps/web/app/tokens/[id]/page.tsx` (modify) — additively fetch + render `<ConfluencePanel />`.
- `packages/db/test/confluenceQueries.test.ts` (create) — DB integration for `getTokenConfluence`.
- `apps/web/test/confluencePanel.test.ts` (create) — source-text web test.

**Task F — Integration tests + verify + smokes + scope/secret gate**
- `packages/db/test/externalConfluence.integration.test.ts` (create) — end-to-end MOCK_MODE integration.
- `apps/worker/test/externalConfluenceScope.test.ts` (create) — source-text scope/secret/Dune-guard gate + worker smoke.
- `apps/web/test/confluencePanelRoute.test.ts` (create) — token-detail panel route smoke.
- `scripts/confluence-gate.mjs` (create) — runnable scope/secret/Dune scan script.

---

### Task A: LiquidityRisk pure core module + `connectors.externalConfluence` settings

**Files:**
- **Create** `packages/core/src/confluence/types.ts` — pure shared types for the confluence subsystem (LiquidityRisk contract).
- **Create** `packages/core/src/confluence/liquidityRisk.ts` — pure, sync `computeLiquidityRisk(input, cfg)`.
- **Create** `packages/core/src/confluence/index.ts` — barrel re-exporting `./types` + `./liquidityRisk`.
- **Modify** `packages/core/src/index.ts` — add `export * from './confluence/index';` (additive line).
- **Modify** `packages/core/src/settings.ts` — add `ExternalConfluenceConfigSchema` + `LiquidityRiskSettingsSchema`, wire `externalConfluence` into `ConnectorsSchema`, and add `connectors.externalConfluence` to `DEFAULT_SETTINGS` (all additive).
- **Test (create)** `packages/core/test/confluence/liquidityRisk.test.ts` — formula/band/caveat/guard unit tests.
- **Test (create)** `packages/core/test/confluence/settings.test.ts` — settings defaults + parse/merge tests for the new block.

**Interfaces:**

*Consumes* (already exist, from files read):
- `packages/core/src/settings.ts` → `ConnectorsSchema` (a `z.object({...})`), `DEFAULT_SETTINGS.connectors` (object literal), `parseSettings(json: unknown): Settings`, `SettingsSchema` (top-level `.strict()`, nested objects NOT strict).
- `packages/core/src/index.ts` → the `export * from './social/index';` convention (barrel re-export style).

*Produces* (later tasks — C worker/ingest D, panel E — rely on these EXACT names/types):
```ts
// packages/core/src/confluence/types.ts
export interface LiquidityRiskInput {
  displayedLiquidityUsd: number;
  marketCapUsd: number;
  positionSizeUsd: number;
  poolType?: 'constant_product' | 'concentrated' | 'unknown';
}
export interface LiquidityRiskConfig {
  absoluteLiquidityBandsUsd: [number, number, number];
  ratioFragilityBands: [number, number, number];
}
export type AbsoluteLiquidityBand = 'micro' | 'thin' | 'moderate' | 'deep' | 'unknown';
export type RatioFragilityBand = 'very_fragile' | 'fragile' | 'moderate' | 'robust' | 'unknown';
export type ConfidenceLevel = 'high' | 'medium' | 'low';
export interface LiquidityRiskResult {
  liquidityToMcapRatio: number | null;
  poolFloatFractionEstimate: number | null;
  overhangMultiple: number | null;
  estimatedOneWaySlippagePct: number | null;
  dumpToHalveUsd: number | null;
  positionSizeMaxFor2PctSlippageUsd: number | null;
  absoluteLiquidityBand: AbsoluteLiquidityBand;
  ratioFragilityBand: RatioFragilityBand;
  caveats: string[];
  confidence: ConfidenceLevel;
}

// packages/core/src/confluence/liquidityRisk.ts
export function computeLiquidityRisk(input: LiquidityRiskInput, cfg: LiquidityRiskConfig): LiquidityRiskResult;

// packages/core/src/settings.ts (new fields on Settings, via z.infer)
// settings.connectors.externalConfluence = {
//   syncHours: number;
//   liquidityRisk: { positionSizeUsd: number; absoluteLiquidityBandsUsd: [number,number,number]; ratioFragilityBands: [number,number,number] };
// }
```

**Semantics baked into `computeLiquidityRisk` (implement exactly):**
- `ratio = L / MC`, `poolFloatFractionEstimate = ratio / 2`, `overhangMultiple = 2/ratio - 1`, `estimatedOneWaySlippagePct = 100 * 2 * S / L`, `dumpToHalveUsd = 0.207 * L`, `positionSizeMaxFor2PctSlippageUsd = 0.01 * L`.
- **Guard:** if `MC <= 0` OR `L <= 0` (or either is non-finite/NaN) → all six numeric fields `null`, `confidence: 'low'`, `absoluteLiquidityBand`/`ratioFragilityBand` derived only where the single input allows (band on L is `'unknown'` when `L <= 0`; ratio band `'unknown'` when ratio can't be computed), and a caveat explaining the missing/invalid market data is appended. **Never** emit a reassuring band from absent data.
- **CLMM caveat:** `poolType === 'concentrated'` → `confidence: 'low'` + a prominent caveat that the CPMM identities are unreliable for concentrated-liquidity pools; numbers are still returned (flagged), not nulled.
- **Confidence for valid CPMM:** `'high'` for `poolType === 'constant_product'`; `'medium'` for `poolType === 'unknown'` or `undefined` (assumption stated in a caveat); `'low'` for `'concentrated'` or any guard hit.
- **Always-on caveats** (appended for every valid computation): aggregated/multi-pool displayed liquidity may distort L; market data may be stale; holder concentration + LP lock/burn can dominate the L/MC ratio.
- **Bands** (thresholds from `cfg`, three ascending numbers each; lower bound is the first band, `>=` top threshold is the top band — boundary value belongs to the HIGHER band):
  - `absoluteLiquidityBandsUsd = [t0, t1, t2]`: `L < t0 → 'micro'`, `L < t1 → 'thin'`, `L < t2 → 'moderate'`, `L >= t2 → 'deep'`.
  - `ratioFragilityBands = [r0, r1, r2]` on `ratio`: `ratio < r0 → 'very_fragile'`, `ratio < r1 → 'fragile'`, `ratio < r2 → 'moderate'`, `ratio >= r2 → 'robust'`.
- **NO buy/sell language** anywhere in code, field names, or caveat strings (enforced by a test asserting none of `buy|sell|long|short|entry|exit` appear in any caveat).

**Settings defaults to add** (additive, in `DEFAULT_SETTINGS.connectors`):
```ts
externalConfluence: {
  syncHours: 6,
  liquidityRisk: {
    positionSizeUsd: 1000,
    absoluteLiquidityBandsUsd: [10000, 50000, 250000],
    ratioFragilityBands: [0.02, 0.05, 0.15]
  }
}
```

---

#### Steps (TDD order)

- [ ] **Step 1: Write failing types + liquidityRisk test (REAL code).**
  Create `packages/core/test/confluence/liquidityRisk.test.ts` with the full body below. It imports from the not-yet-existing module, so it fails to resolve.
  ```ts
  import { describe, expect, it } from 'vitest';
  import { computeLiquidityRisk } from '../../src/confluence/liquidityRisk';
  import type { LiquidityRiskConfig, LiquidityRiskInput } from '../../src/confluence/types';

  // Default-ish config matching DEFAULT_SETTINGS.connectors.externalConfluence.liquidityRisk.
  const CFG: LiquidityRiskConfig = {
    absoluteLiquidityBandsUsd: [10000, 50000, 250000],
    ratioFragilityBands: [0.02, 0.05, 0.15]
  };

  function input(over: Partial<LiquidityRiskInput> = {}): LiquidityRiskInput {
    return { displayedLiquidityUsd: 40000, marketCapUsd: 1_000_000, positionSizeUsd: 1000, ...over };
  }

  describe('computeLiquidityRisk — formulas (worked example L=40k, MC=1M, S=1k)', () => {
    it('computes every identity exactly for a constant_product pool', () => {
      const r = computeLiquidityRisk(input({ poolType: 'constant_product' }), CFG);
      expect(r.liquidityToMcapRatio).toBeCloseTo(0.04, 10);        // 40000 / 1_000_000
      expect(r.poolFloatFractionEstimate).toBeCloseTo(0.02, 10);   // ratio / 2
      expect(r.overhangMultiple).toBeCloseTo(49, 10);              // 2/0.04 - 1
      expect(r.estimatedOneWaySlippagePct).toBeCloseTo(5, 10);     // 100 * 2 * 1000 / 40000
      expect(r.dumpToHalveUsd).toBeCloseTo(8280, 6);               // 0.207 * 40000
      expect(r.positionSizeMaxFor2PctSlippageUsd).toBeCloseTo(400, 10); // 0.01 * 40000
      expect(r.confidence).toBe('high');
      expect(r.absoluteLiquidityBand).toBe('thin');   // 10000 <= 40000 < 50000
      expect(r.ratioFragilityBand).toBe('fragile');   // 0.02 <= 0.04 < 0.05
    });

    it('scales estimatedOneWaySlippagePct with positionSizeUsd', () => {
      const small = computeLiquidityRisk(input({ positionSizeUsd: 1000 }), CFG);
      const big = computeLiquidityRisk(input({ positionSizeUsd: 4000 }), CFG);
      expect(small.estimatedOneWaySlippagePct).toBeCloseTo(5, 10);   // 100*2*1000/40000
      expect(big.estimatedOneWaySlippagePct).toBeCloseTo(20, 10);    // 100*2*4000/40000
      // positionSizeUsd does NOT affect the size-independent fields
      expect(big.dumpToHalveUsd).toBeCloseTo(8280, 6);
      expect(big.positionSizeMaxFor2PctSlippageUsd).toBeCloseTo(400, 10);
    });

    it('second worked example (L=100k, MC=2M, S=5k) is exact', () => {
      const r = computeLiquidityRisk(
        input({ displayedLiquidityUsd: 100000, marketCapUsd: 2_000_000, positionSizeUsd: 5000, poolType: 'constant_product' }),
        CFG
      );
      expect(r.liquidityToMcapRatio).toBeCloseTo(0.05, 10);
      expect(r.poolFloatFractionEstimate).toBeCloseTo(0.025, 10);
      expect(r.overhangMultiple).toBeCloseTo(39, 10);
      expect(r.estimatedOneWaySlippagePct).toBeCloseTo(10, 10);   // 100*2*5000/100000
      expect(r.dumpToHalveUsd).toBeCloseTo(20700, 6);             // 0.207 * 100000
      expect(r.positionSizeMaxFor2PctSlippageUsd).toBeCloseTo(1000, 10);
      expect(r.absoluteLiquidityBand).toBe('moderate'); // 50000 <= 100000 < 250000
      expect(r.ratioFragilityBand).toBe('moderate');    // 0.05 <= 0.05... actually ratio 0.05 -> boundary, see boundary test
    });
  });

  describe('computeLiquidityRisk — confidence & CLMM caveat', () => {
    it('poolType unknown => confidence medium with a stated-assumption caveat', () => {
      const r = computeLiquidityRisk(input({ poolType: 'unknown' }), CFG);
      expect(r.confidence).toBe('medium');
      expect(r.caveats.some((c) => /assum/i.test(c))).toBe(true);
      // numbers still present
      expect(r.liquidityToMcapRatio).toBeCloseTo(0.04, 10);
    });

    it('missing poolType (undefined) is treated as unknown => medium', () => {
      const r = computeLiquidityRisk(input(), CFG);
      expect(r.confidence).toBe('medium');
    });

    it('poolType concentrated => confidence low + prominent CLMM caveat, numbers still returned', () => {
      const r = computeLiquidityRisk(input({ poolType: 'concentrated' }), CFG);
      expect(r.confidence).toBe('low');
      expect(r.caveats.some((c) => /concentrated|CLMM/i.test(c))).toBe(true);
      // identities are still surfaced (flagged, not nulled)
      expect(r.liquidityToMcapRatio).toBeCloseTo(0.04, 10);
      expect(r.estimatedOneWaySlippagePct).toBeCloseTo(5, 10);
    });

    it('always appends the multi-pool / stale-data / holder-concentration caveats on a valid compute', () => {
      const r = computeLiquidityRisk(input({ poolType: 'constant_product' }), CFG);
      const joined = r.caveats.join(' | ').toLowerCase();
      expect(joined).toContain('aggregated');
      expect(joined).toContain('stale');
      expect(joined).toContain('holder concentration');
    });
  });

  describe('computeLiquidityRisk — null guards (MC<=0, L<=0, non-finite)', () => {
    it('marketCapUsd <= 0 => all numeric fields null, confidence low, caveat present, never a reassuring band', () => {
      const r = computeLiquidityRisk(input({ marketCapUsd: 0, poolType: 'constant_product' }), CFG);
      expect(r.liquidityToMcapRatio).toBeNull();
      expect(r.poolFloatFractionEstimate).toBeNull();
      expect(r.overhangMultiple).toBeNull();
      // slippage/dump/posMax depend only on L, but ratio-derived fields are null;
      // with valid L they may still be computed — assert the ratio-derived ones are null:
      expect(r.confidence).toBe('low');
      expect(r.ratioFragilityBand).toBe('unknown');
      expect(r.caveats.some((c) => /market cap|invalid|unavailable/i.test(c))).toBe(true);
    });

    it('displayedLiquidityUsd <= 0 => ratio + all L-derived numeric fields null, band unknown, confidence low', () => {
      const r = computeLiquidityRisk(input({ displayedLiquidityUsd: 0, poolType: 'constant_product' }), CFG);
      expect(r.liquidityToMcapRatio).toBeNull();
      expect(r.poolFloatFractionEstimate).toBeNull();
      expect(r.overhangMultiple).toBeNull();
      expect(r.estimatedOneWaySlippagePct).toBeNull();
      expect(r.dumpToHalveUsd).toBeNull();
      expect(r.positionSizeMaxFor2PctSlippageUsd).toBeNull();
      expect(r.absoluteLiquidityBand).toBe('unknown');
      expect(r.ratioFragilityBand).toBe('unknown');
      expect(r.confidence).toBe('low');
    });

    it('non-finite inputs (NaN / Infinity) are guarded like <=0', () => {
      const rNaN = computeLiquidityRisk(input({ marketCapUsd: NaN }), CFG);
      expect(rNaN.liquidityToMcapRatio).toBeNull();
      expect(rNaN.confidence).toBe('low');
      const rInf = computeLiquidityRisk(input({ displayedLiquidityUsd: Infinity }), CFG);
      expect(rInf.liquidityToMcapRatio).toBeNull();
      expect(rInf.confidence).toBe('low');
    });
  });

  describe('computeLiquidityRisk — band thresholds at boundaries', () => {
    // absoluteLiquidityBandsUsd [10000, 50000, 250000]; boundary belongs to the HIGHER band.
    it('absolute band boundaries (boundary value => higher band)', () => {
      const band = (L: number) =>
        computeLiquidityRisk(input({ displayedLiquidityUsd: L, marketCapUsd: 100_000_000 }), CFG).absoluteLiquidityBand;
      expect(band(9_999.99)).toBe('micro');
      expect(band(10_000)).toBe('thin');       // == t0 => thin
      expect(band(49_999.99)).toBe('thin');
      expect(band(50_000)).toBe('moderate');    // == t1 => moderate
      expect(band(249_999.99)).toBe('moderate');
      expect(band(250_000)).toBe('deep');       // == t2 => deep
      expect(band(1_000_000)).toBe('deep');
    });

    it('ratio fragility band boundaries (boundary value => higher band)', () => {
      // Fix MC=1_000_000 and vary L so ratio hits exact thresholds.
      const band = (ratio: number) =>
        computeLiquidityRisk(input({ displayedLiquidityUsd: ratio * 1_000_000, marketCapUsd: 1_000_000 }), CFG)
          .ratioFragilityBand;
      expect(band(0.019)).toBe('very_fragile');
      expect(band(0.02)).toBe('fragile');       // == r0 => fragile
      expect(band(0.049)).toBe('fragile');
      expect(band(0.05)).toBe('moderate');       // == r1 => moderate
      expect(band(0.149)).toBe('moderate');
      expect(band(0.15)).toBe('robust');         // == r2 => robust
      expect(band(0.5)).toBe('robust');
    });
  });

  describe('computeLiquidityRisk — no buy/sell language (shadow-only, describes fragility not action)', () => {
    it('no caveat contains trade-action words', () => {
      const cases: LiquidityRiskInput[] = [
        input({ poolType: 'constant_product' }),
        input({ poolType: 'concentrated' }),
        input({ poolType: 'unknown' }),
        input({ marketCapUsd: 0 }),
        input({ displayedLiquidityUsd: 0 })
      ];
      const forbidden = /\b(buy|sell|long|short|entry|exit|ape|dump it|take profit)\b/i;
      for (const c of cases) {
        for (const cav of computeLiquidityRisk(c, CFG).caveats) {
          expect(forbidden.test(cav)).toBe(false);
        }
      }
    });
  });
  ```

- [ ] **Step 2: Run the test — expect FAIL (module not found).**
  `cd C:/Users/akki/session/flowradar && npx vitest run packages/core/test/confluence/liquidityRisk.test.ts`
  Expected: Vitest errors resolving `../../src/confluence/liquidityRisk` / `../../src/confluence/types` (files don't exist yet). This confirms the test is wired to real code.

- [ ] **Step 3: Create `packages/core/src/confluence/types.ts` (REAL code, complete).**
  ```ts
  // FlowRadar — confluence: shared pure types (design doc "Module B — LiquidityRisk").
  //
  // packages/core is PURE (zero I/O, zod is the only runtime dep, NO node: builtins —
  // this file must stay client-bundle-safe). These types are the contract every
  // later confluence task (providers, worker/ingest, db queries, web ConfluencePanel)
  // imports from @flowradar/core.
  //
  // Shadow-only: NOTHING here feeds FlowScore, the signal engine, or wallet scoring.

  /** Pool structure hint for the CPMM identities. `concentrated` (CLMM) breaks
   *  the simple L≈2·Q / ratio→float mapping, so it downgrades confidence and adds
   *  a prominent caveat rather than trusting the numbers. */
  export type PoolType = 'constant_product' | 'concentrated' | 'unknown';

  /** Inputs to computeLiquidityRisk. L = displayed pool liquidity (USD), MC = market
   *  cap (USD), S = the operator-configured position size used for the slippage
   *  estimate. All are FlowRadar-internal market values — no provider key involved. */
  export interface LiquidityRiskInput {
    displayedLiquidityUsd: number;
    marketCapUsd: number;
    positionSizeUsd: number;
    poolType?: PoolType;
  }

  /** Display-only band thresholds (Settings-configurable). Each is three ASCENDING
   *  numbers; a value on a threshold belongs to the HIGHER band. NOT a FlowScore input. */
  export interface LiquidityRiskConfig {
    absoluteLiquidityBandsUsd: [number, number, number];
    ratioFragilityBands: [number, number, number];
  }

  export type AbsoluteLiquidityBand = 'micro' | 'thin' | 'moderate' | 'deep' | 'unknown';
  export type RatioFragilityBand = 'very_fragile' | 'fragile' | 'moderate' | 'robust' | 'unknown';
  export type ConfidenceLevel = 'high' | 'medium' | 'low';

  /** Result of computeLiquidityRisk. Numeric fields are null when the market data
   *  is missing/invalid (MC<=0 or L<=0 or non-finite) — absence is NEVER rendered as
   *  a reassuring band. `caveats` always describes fragility, never a buy/sell action. */
  export interface LiquidityRiskResult {
    liquidityToMcapRatio: number | null;
    poolFloatFractionEstimate: number | null;
    overhangMultiple: number | null;
    estimatedOneWaySlippagePct: number | null;
    dumpToHalveUsd: number | null;
    positionSizeMaxFor2PctSlippageUsd: number | null;
    absoluteLiquidityBand: AbsoluteLiquidityBand;
    ratioFragilityBand: RatioFragilityBand;
    caveats: string[];
    confidence: ConfidenceLevel;
  }
  ```

- [ ] **Step 4: Create `packages/core/src/confluence/liquidityRisk.ts` (REAL code, complete).**
  ```ts
  // FlowRadar — confluence: pure LiquidityRisk computation (design doc "Module B").
  //
  // PURE, sync, deterministic — no DB, no network, no provider key. Constant-product
  // AMM (CPMM) identities computed from displayed liquidity + market cap. HIGH
  // confidence only for a single fresh CPMM pool; CONCENTRATED (CLMM) pools break the
  // ratio→float / slippage mapping, so they are surfaced with confidence 'low' + a
  // prominent caveat rather than trusted. Absence of data => null numeric fields +
  // confidence 'low' + 'unknown' bands (NEVER a reassuring band). Bands are shadow-only
  // display heuristics; NOTHING here participates in FlowScore. No buy/sell language.

  import type {
    AbsoluteLiquidityBand,
    LiquidityRiskConfig,
    LiquidityRiskInput,
    LiquidityRiskResult,
    RatioFragilityBand
  } from './types';

  function isValidPositive(n: number): boolean {
    return Number.isFinite(n) && n > 0;
  }

  // Boundary value belongs to the HIGHER band (thresholds are lower-inclusive of the
  // upper band): L < t0 => first band; L >= t2 => top band.
  function absoluteBand(
    liquidityUsd: number,
    [t0, t1, t2]: [number, number, number]
  ): AbsoluteLiquidityBand {
    if (!isValidPositive(liquidityUsd)) return 'unknown';
    if (liquidityUsd < t0) return 'micro';
    if (liquidityUsd < t1) return 'thin';
    if (liquidityUsd < t2) return 'moderate';
    return 'deep';
  }

  function ratioBand(
    ratio: number | null,
    [r0, r1, r2]: [number, number, number]
  ): RatioFragilityBand {
    if (ratio === null || !Number.isFinite(ratio)) return 'unknown';
    if (ratio < r0) return 'very_fragile';
    if (ratio < r1) return 'fragile';
    if (ratio < r2) return 'moderate';
    return 'robust';
  }

  export function computeLiquidityRisk(
    input: LiquidityRiskInput,
    cfg: LiquidityRiskConfig
  ): LiquidityRiskResult {
    const { displayedLiquidityUsd: L, marketCapUsd: MC, positionSizeUsd: S, poolType } = input;

    const caveats: string[] = [];
    const lOk = isValidPositive(L);
    const mcOk = isValidPositive(MC);
    const isConcentrated = poolType === 'concentrated';

    // --- Ratio-derived (need BOTH L and MC valid) ---
    const ratio = lOk && mcOk ? L / MC : null;
    const poolFloatFractionEstimate = ratio === null ? null : ratio / 2;
    const overhangMultiple = ratio === null ? null : 2 / ratio - 1;

    // --- L-derived (need L valid; S must be finite & >= 0 for slippage) ---
    const estimatedOneWaySlippagePct =
      lOk && Number.isFinite(S) && S >= 0 ? (100 * 2 * S) / L : null;
    const dumpToHalveUsd = lOk ? 0.207 * L : null;
    const positionSizeMaxFor2PctSlippageUsd = lOk ? 0.01 * L : null;

    const absoluteLiquidityBand = absoluteBand(L, cfg.absoluteLiquidityBandsUsd);
    const ratioFragilityBand = ratioBand(ratio, cfg.ratioFragilityBands);

    // --- Confidence + caveats ---
    let confidence: LiquidityRiskResult['confidence'];
    if (!lOk || !mcOk) {
      // Missing/invalid market data: never a reassuring read.
      confidence = 'low';
      if (!mcOk) caveats.push('Market cap is missing or invalid; the L/MC ratio and float/overhang estimates are unavailable.');
      if (!lOk) caveats.push('Displayed liquidity is missing or invalid; slippage and depth estimates are unavailable.');
    } else if (isConcentrated) {
      // CLMM: numbers still shown but flagged as unreliable.
      confidence = 'low';
      caveats.push(
        'Concentrated-liquidity (CLMM) pool: the constant-product identities (ratio→float, slippage, dump-to-halve) are UNRELIABLE here — treat these numbers as indicative only.'
      );
    } else if (poolType === 'constant_product') {
      confidence = 'high';
    } else {
      // 'unknown' or undefined — apply CPMM identities under a stated assumption.
      confidence = 'medium';
      caveats.push('Pool type is unknown; figures assume a single constant-product (CPMM) pool.');
    }

    // Always-on caveats for any computed (non-guarded) result.
    if (lOk && mcOk) {
      caveats.push('Displayed liquidity may be aggregated across multiple pools, which can distort these figures.');
      caveats.push('Market data may be stale.');
      caveats.push('Holder concentration and LP lock/burn status can dominate this L/MC ratio.');
    }

    return {
      liquidityToMcapRatio: ratio,
      poolFloatFractionEstimate,
      overhangMultiple,
      estimatedOneWaySlippagePct,
      dumpToHalveUsd,
      positionSizeMaxFor2PctSlippageUsd,
      absoluteLiquidityBand,
      ratioFragilityBand,
      caveats,
      confidence
    };
  }
  ```

- [ ] **Step 5: Create `packages/core/src/confluence/index.ts` (barrel, REAL code).**
  ```ts
  // FlowRadar — @flowradar/core confluence barrel.
  // PURE re-exports (design doc "External Confluence"). Consumed by providers,
  // worker/ingest, db helpers, and the web ConfluencePanel. Shadow-only:
  // nothing here feeds FlowScore, the signal engine, or wallet scoring.
  export * from './types';
  export * from './liquidityRisk';
  ```

- [ ] **Step 6: Wire the barrel into `packages/core/src/index.ts` (additive).**
  Add exactly this line immediately after the existing `export * from './social/index';` line (line 39):
  ```ts
  export * from './confluence/index';
  ```

- [ ] **Step 7: Run the liquidityRisk test — expect PASS.**
  `cd C:/Users/akki/session/flowradar && npx vitest run packages/core/test/confluence/liquidityRisk.test.ts`
  Expected: all tests in the file pass (formulas, CLMM/unknown confidence, MC<=0 and L<=0 and non-finite guards, both band-boundary sets, no-buy/sell language).

- [ ] **Step 8: Commit the pure module.**
  ```
  cd C:/Users/akki/session/flowradar
  git add packages/core/src/confluence/types.ts packages/core/src/confluence/liquidityRisk.ts packages/core/src/confluence/index.ts packages/core/src/index.ts packages/core/test/confluence/liquidityRisk.test.ts
  git commit -m "feat(core): add pure LiquidityRisk confluence module (CPMM identities, CLMM caveat, null guards, shadow-only bands)"
  ```

- [ ] **Step 9: Write failing settings test (REAL code).**
  Create `packages/core/test/confluence/settings.test.ts`:
  ```ts
  import { describe, expect, it } from 'vitest';
  import { DEFAULT_SETTINGS, parseSettings } from '../../src/settings';

  describe('settings.connectors.externalConfluence', () => {
    it('DEFAULT_SETTINGS carries the externalConfluence block with the resolved defaults', () => {
      const ec = DEFAULT_SETTINGS.connectors.externalConfluence;
      expect(ec.syncHours).toBe(6);
      expect(ec.liquidityRisk.positionSizeUsd).toBe(1000);
      expect(ec.liquidityRisk.absoluteLiquidityBandsUsd).toEqual([10000, 50000, 250000]);
      expect(ec.liquidityRisk.ratioFragilityBands).toEqual([0.02, 0.05, 0.15]);
    });

    it('parseSettings({}) fills externalConfluence from defaults (additive, non-breaking)', () => {
      const s = parseSettings({});
      expect(s.connectors.externalConfluence.liquidityRisk.positionSizeUsd).toBe(1000);
      // existing connectors blocks are untouched
      expect(s.connectors.syncHours).toBe(6);
      expect(s.connectors.social.syncHours).toBe(6);
    });

    it('deep-merges a partial override without dropping sibling defaults', () => {
      const s = parseSettings({
        connectors: { externalConfluence: { liquidityRisk: { positionSizeUsd: 5000 } } }
      });
      expect(s.connectors.externalConfluence.liquidityRisk.positionSizeUsd).toBe(5000);
      // untouched siblings retained
      expect(s.connectors.externalConfluence.syncHours).toBe(6);
      expect(s.connectors.externalConfluence.liquidityRisk.absoluteLiquidityBandsUsd).toEqual([10000, 50000, 250000]);
      expect(s.connectors.externalConfluence.liquidityRisk.ratioFragilityBands).toEqual([0.02, 0.05, 0.15]);
    });

    it('rejects a wrong-typed override (positionSizeUsd must be a number)', () => {
      expect(() =>
        parseSettings({ connectors: { externalConfluence: { liquidityRisk: { positionSizeUsd: 'big' } } } })
      ).toThrow();
    });

    it('does not disturb the strict top-level shape (unknown TOP-LEVEL key still 400s)', () => {
      expect(() => parseSettings({ bogusTopLevel: 1 })).toThrow();
    });
  });
  ```

- [ ] **Step 10: Run the settings test — expect FAIL.**
  `cd C:/Users/akki/session/flowradar && npx vitest run packages/core/test/confluence/settings.test.ts`
  Expected: fails — `DEFAULT_SETTINGS.connectors.externalConfluence` is `undefined` (TypeError reading `syncHours`), and the schema hasn't added the field yet.

- [ ] **Step 11: Add the Zod schema for the new block in `packages/core/src/settings.ts` (REAL code).**
  Insert this block immediately AFTER the `SocialConfigSchema` definition (after line 173) and BEFORE `const ConnectorsSchema`:
  ```ts
  // Task A (External Confluence, design doc "Module B / Settings additions") —
  // shadow-only confluence config. syncHours reuses the hours→seconds *3600 worker
  // convention. liquidityRisk holds the pure computeLiquidityRisk position size + the
  // display-only band thresholds; NONE of these feed FlowScore or the signal engine.
  const LiquidityRiskSettingsSchema = z.object({
    positionSizeUsd: z.number(),
    absoluteLiquidityBandsUsd: z.tuple([z.number(), z.number(), z.number()]),
    ratioFragilityBands: z.tuple([z.number(), z.number(), z.number()])
  });

  const ExternalConfluenceConfigSchema = z.object({
    syncHours: z.number(),
    liquidityRisk: LiquidityRiskSettingsSchema
  });
  ```
  Then extend `ConnectorsSchema` (currently lines 175-182) by adding the `externalConfluence` field so it reads:
  ```ts
  const ConnectorsSchema = z.object({
    sourcesEnabled: z.record(z.string(), z.boolean()),
    syncHours: z.number(),
    validationBatchSize: z.number(),
    topTraderBackfill: TopTraderBackfillSchema,
    dune: DuneConnectorSchema,
    social: SocialConfigSchema,
    externalConfluence: ExternalConfluenceConfigSchema
  });
  ```

- [ ] **Step 12: Add the defaults in `DEFAULT_SETTINGS.connectors` (REAL code).**
  In `DEFAULT_SETTINGS.connectors` (the object ending at line 346), add the `externalConfluence` block immediately after the `social: { ... }` block. The tail of the `connectors` object becomes:
  ```ts
      // Social intelligence (spec §7). Shadow-only inbound-mention config.
      social: {
        syncHours: 6,
        spam: {
          copypastaAuthorMin: 3,
          repeatAuthorMin: 5,
          lowContentMinChars: 12,
          windowMinutes: 360,
          weights: { copypasta: 80, repeat_author: 60, low_content: 50 },
          uiHideThreshold: 70
        },
        velocityWindowsMin: [60, 360, 1440]
      },
      // External confluence (design doc "Module B / Settings additions"). Shadow-only.
      // positionSizeUsd feeds the pure LiquidityRisk slippage estimate; the two band
      // arrays are display-only fragility heuristics (NOT FlowScore inputs).
      externalConfluence: {
        syncHours: 6,
        liquidityRisk: {
          positionSizeUsd: 1000,
          absoluteLiquidityBandsUsd: [10000, 50000, 250000],
          ratioFragilityBands: [0.02, 0.05, 0.15]
        }
      }
  ```
  (Add a comma after the closing `}` of the `social` block; the `externalConfluence` block is the new last key of `connectors`.)

- [ ] **Step 13: Run the settings test — expect PASS.**
  `cd C:/Users/akki/session/flowradar && npx vitest run packages/core/test/confluence/settings.test.ts`
  Expected: all settings tests pass (defaults present, `parseSettings({})` fills them, partial deep-merge retains siblings, wrong type throws, top-level strictness intact).

- [ ] **Step 14: Run the full core test suite + typecheck — expect PASS (no regressions).**
  ```
  cd C:/Users/akki/session/flowradar && npx vitest run packages/core
  cd C:/Users/akki/session/flowradar && npx tsc -b packages/core
  ```
  Expected: every existing core test still passes (settings change is purely additive; `SettingsSchema.strict()` is top-level only, so the new nested `externalConfluence` does not break existing partial-update tests), and `tsc -b` compiles clean (the new `.tuple([...])` typing produces the `[number, number, number]` literal tuple the `LiquidityRiskConfig` consumer expects).

- [ ] **Step 15: Commit the settings wiring.**
  ```
  cd C:/Users/akki/session/flowradar
  git add packages/core/src/settings.ts packages/core/test/confluence/settings.test.ts
  git commit -m "feat(core): add connectors.externalConfluence settings (syncHours + liquidityRisk position size & bands), additive"
  ```

---

**Done Bar:**
- `packages/core/src/confluence/{types,liquidityRisk,index}.ts` exist; `computeLiquidityRisk` is exported from `@flowradar/core` (via `packages/core/src/index.ts`) and importable by later tasks.
- `npx vitest run packages/core/test/confluence/liquidityRisk.test.ts` and `.../settings.test.ts` both pass; `npx vitest run packages/core` shows zero regressions; `npx tsc -b packages/core` compiles clean.
- Worked example is exact: for L=40k, MC=1M, S=1k → ratio 0.04, float 0.02, overhang 49, slippage 5%, dumpToHalve 8280, posMax 400, band `thin`, fragility `fragile`, confidence `high`.
- `poolType: 'concentrated'` → `confidence: 'low'` + a caveat matching `/concentrated|CLMM/i`, numbers still returned.
- `MC <= 0` or `L <= 0` or non-finite → ratio-derived numeric fields `null`, `confidence: 'low'`, affected bands `'unknown'`, and NO reassuring band emitted.
- Band boundary values resolve to the higher band (`10000→thin`, `50000→moderate`, `250000→deep`; `0.02→fragile`, `0.05→moderate`, `0.15→robust`).
- No caveat/field/identifier contains buy/sell/long/short/entry/exit language.
- `DEFAULT_SETTINGS.connectors.externalConfluence` exists with the resolved defaults; `parseSettings({})` fills it; partial override deep-merges without dropping siblings; wrong type throws; top-level `.strict()` unaffected.
- No FlowScore / signal-rule / wallet-scoring / CandidateWallet file touched; no schema, provider, worker, or DB code in this task (purely additive to `packages/core`).

**Reviewer Focus:**
- **Shadow-only integrity:** confirm nothing in `liquidityRisk.ts`/`types.ts`/`settings.ts` is wired into `scoring/flowScore.ts`, `rules/*`, `scoring/walletScore.ts`, or the candidate pipeline — the only `index.ts` edit is one additive `export *` line, and the settings change is a new nested key under `connectors` (top-level `.strict()` still holds).
- **`unavailable ≠ safe`:** verify the `MC<=0` / `L<=0` / non-finite paths return `null` numerics + `'unknown'` bands + `'low'` confidence, and that no band ever defaults to `moderate`/`deep`/`robust` when its input is absent (a silent `0`→`micro` or a missing ratio→`very_fragile` would each be a subtle "false green"/"false red" — check the guards return `'unknown'`, not a computed band).
- **CLMM caveat correctness:** `concentrated` must keep the numbers (flagged) with `'low'` confidence and a prominent caveat — not null them and not silently trust them.
- **No buy/sell language:** scan every caveat string and identifier; bands describe fragility only. The regex test must actually cover the concentrated + guarded branches (it does).
- **Client-bundle safety:** `confluence/*` uses zero `node:` builtins and only imports `zod` transitively via settings — the barrel must stay safe to import from a client bundle (the social contentHash lesson).
- **Band boundary semantics + tuple typing:** confirm the "boundary belongs to the higher band" convention is consistent between code and tests, and that `z.tuple([z.number(),z.number(),z.number()])` (not `z.array(z.number())`) is used so the inferred `Settings` type gives later tasks the exact `[number, number, number]` tuple `LiquidityRiskConfig` requires.

---

### Task B: Schema + migration (`ExternalConfluenceSource`, `TokenConfluenceSnapshot`)

Add the two External-Confluence models (`ExternalConfluenceSource` registry + `TokenConfluenceSnapshot` shadow-only evidence) to the Prisma schema, add the `Token.confluenceSnapshots` back-relation, create + apply the migration via the db package script, regenerate the client, and prove the schema guarantees later tasks depend on with a LITE-Postgres integration test. **Two tables only — NO `PaperTradeObservation`** (deferred; `paper_trade` reuses `TokenConfluenceSnapshot.snapshotType`).

**Files:**
- **Modify:** `C:/Users/akki/session/flowradar/packages/db/prisma/schema.prisma` — add `ExternalConfluenceSource` model, `TokenConfluenceSnapshot` model, and `confluenceSnapshots TokenConfluenceSnapshot[]` back-relation on `Token`.
- **Create (generated by tooling, committed):** `C:/Users/akki/session/flowradar/packages/db/prisma/migrations/<timestamp>_external_confluence/migration.sql` — produced by `prisma migrate dev` (do NOT hand-write; verify contents).
- **Test:** `C:/Users/akki/session/flowradar/packages/db/test/confluenceSchema.test.ts` — new LITE-Postgres integration test (mirrors `socialSchema.test.ts` conventions exactly).

**Interfaces:**
- **Consumes:** nothing from earlier tasks. Reuses existing schema primitives: `ChainId` enum, `Token` model (`@@unique([chain, address])`), `cuid()`, `@@map` snake_case, the `ExternalWalletSource`/`SocialSource` registry-column conventions, and the `probePort(5439)` + prefix-cleanup + `describe.skipIf` test pattern from `packages/db/test/socialSchema.test.ts`.
- **Produces (names later tasks rely on VERBATIM):**
  - Prisma model `ExternalConfluenceSource` → client accessor `prisma.externalConfluenceSource` (Task C `getConfluenceSourceStatuses`, Task D worker, Task D seed).
  - Prisma model `TokenConfluenceSnapshot` → client accessor `prisma.tokenConfluenceSnapshot` (Task D `runExternalConfluencePass` upserts; Task E `getTokenConfluence` reads).
  - `TokenConfluenceSnapshot` unique composite `[sourceId, tokenAddress, snapshotType, dedupeKey]` → Prisma upsert `where` key `sourceId_tokenAddress_snapshotType_dedupeKey` (Task D idempotent upsert).
  - `TokenConfluenceSnapshot.tokenId String?` FK `onDelete: SetNull` → unlinked snapshots (Task D external providers never create Token rows) and `Token.confluenceSnapshots` back-relation (Task E include).
  - String vocabulary columns (`provider`, `snapshotType`, `status`) — plain `String`, values documented in doc comments, so Tasks C/D/E use string literals, no enum migration needed.

**Steps (TDD order):**

- [ ] **Step 1: Write the failing schema integration test (REAL code).**
  Create `C:/Users/akki/session/flowradar/packages/db/test/confluenceSchema.test.ts` with the full body below. It reuses the exact `probePort`/prefix-cleanup/`describe.skipIf` pattern from `socialSchema.test.ts` and asserts every schema guarantee this task must deliver: column defaults, `[sourceId, tokenAddress, snapshotType, dedupeKey]` idempotent upsert, per-`sourceId` scoping of the unique key, the internal `sourceId=null` snapshot, an unlinked `tokenId=null` snapshot for a missing token, `ON DELETE SET NULL` token link, the `unavailable`/`stub`/`plan_required`/`missing_key` statuses persisting honestly (never coerced to a "safe" value), and readback via the `Token.confluenceSnapshots` back-relation.

  ```ts
  // FlowRadar — ExternalConfluenceSource + TokenConfluenceSnapshot schema-behavior
  // integration tests (External Confluence, Task B). Same LITE-Postgres pattern as
  // socialSchema.test.ts (prefix-cleanup, describe.skipIf when embedded Postgres is
  // not reachable on 5439). Proves the guarantees later tasks depend on:
  //   - [sourceId, tokenAddress, snapshotType, dedupeKey] idempotent upsert
  //   - the unique key is scoped per-sourceId (and works with sourceId=null internal rows)
  //   - a nullable tokenId link (unlinked snapshot for a not-yet-known token)
  //   - ON DELETE SET NULL: deleting the Token nulls the snapshot's tokenId (never deletes it)
  //   - unavailable/stub/plan_required/missing_key statuses persist verbatim (unavailable != safe)
  //   - the four documented @@index() entries exist (pg_indexes)
  //   - readback via the Token.confluenceSnapshots back-relation

  import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
  import net from 'node:net';
  import { prisma } from '../src/client';

  const SOURCE_PREFIX = 'TBconfSource';
  const TOKEN_PREFIX = 'TBconfToken';

  function probePort(host: string, port: number, timeoutMs = 1000): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = net.createConnection({ host, port });
      const done = (ok: boolean) => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(ok);
      };
      socket.setTimeout(timeoutMs);
      socket.once('connect', () => done(true));
      socket.once('timeout', () => done(false));
      socket.once('error', () => done(false));
    });
  }

  let dbReachable = false;

  beforeAll(async () => {
    dbReachable = await probePort('localhost', 5439);
    if (!dbReachable) {
      // eslint-disable-next-line no-console
      console.warn(
        '[confluenceSchema.test] LITE Postgres not reachable on localhost:5439 — skipping ' +
          'integration tests. Run `npm run db:migrate` first to exercise this suite.'
      );
    }
  });

  async function cleanup() {
    // Null-safe prefix cleanup: snapshots may be unlinked (tokenId null) or internal
    // (sourceId null), so delete by tokenAddress prefix which is always set, then by
    // source-name prefix, then the tokens themselves.
    await prisma.tokenConfluenceSnapshot.deleteMany({ where: { tokenAddress: { startsWith: TOKEN_PREFIX } } });
    await prisma.tokenConfluenceSnapshot.deleteMany({ where: { source: { name: { startsWith: SOURCE_PREFIX } } } });
    await prisma.externalConfluenceSource.deleteMany({ where: { name: { startsWith: SOURCE_PREFIX } } });
    await prisma.token.deleteMany({ where: { address: { startsWith: TOKEN_PREFIX } } });
  }

  afterAll(async () => {
    if (!dbReachable) return;
    await cleanup();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    if (!dbReachable) return;
    await cleanup();
  });

  async function makeSource(
    name: string,
    overrides: Partial<Parameters<typeof prisma.externalConfluenceSource.create>[0]['data']> = {}
  ) {
    return prisma.externalConfluenceSource.create({
      data: {
        name,
        provider: 'holderscan',
        apiKeyEnvName: 'HOLDERSCAN_API_KEY',
        ...overrides
      }
    });
  }

  async function makeToken(addressSuffix: string) {
    return prisma.token.create({
      data: {
        chain: 'SOLANA',
        address: `${TOKEN_PREFIX}_${addressSuffix}`,
        symbol: 'NOVA',
        name: 'Nova',
        decimals: 9,
        firstSeenAt: new Date(),
        riskFlags: []
      }
    });
  }

  /** Deterministic snapshot payload for a given source + snapshotType + dedupeKey. */
  function snapshotData(
    over: Partial<Parameters<typeof prisma.tokenConfluenceSnapshot.create>[0]['data']> & {
      sourceId?: string | null;
      tokenAddress: string;
      snapshotType: string;
      dedupeKey: string;
    }
  ) {
    return {
      chain: 'SOLANA' as const,
      provider: 'holderscan',
      status: 'ok',
      dataJson: { providerClaimed: true },
      observedAt: new Date('2026-07-08T00:00:00.000Z'),
      ...over
    };
  }

  describe.skipIf(!(await probePort('localhost', 5439)))(
    'ExternalConfluenceSource + TokenConfluenceSnapshot schema',
    () => {
      it('applies documented column defaults on ExternalConfluenceSource', async () => {
        const source = await makeSource(`${SOURCE_PREFIX}_defaults`);
        expect(source.enabled).toBe(true);
        expect(source.rateLimitPerMinute).toBe(30);
        expect(source.status).toBe('idle');
        expect(source.failCount).toBe(0);
        expect(source.addedAt).toBeInstanceOf(Date);
        expect(source.lastSyncAt).toBeNull();
        expect(source.lastError).toBeNull();
        // apiKeyEnvName holds a NAME, never a value — sanity-check the seeded name.
        expect(source.apiKeyEnvName).toBe('HOLDERSCAN_API_KEY');
      });

      it('applies TokenConfluenceSnapshot defaults (ingestedAt now, nullable link fields)', async () => {
        const source = await makeSource(`${SOURCE_PREFIX}_snapdefaults`);
        const snap = await prisma.tokenConfluenceSnapshot.create({
          data: snapshotData({
            sourceId: source.id,
            tokenAddress: `${TOKEN_PREFIX}_defaults`,
            snapshotType: 'holder_risk',
            dedupeKey: 'holderscan:holder_risk:' + TOKEN_PREFIX + '_defaults:2026070800'
          })
        });
        expect(snap.ingestedAt).toBeInstanceOf(Date);
        expect(snap.tokenId).toBeNull();
        expect(snap.metadataJson).toBeNull();
        expect(snap.status).toBe('ok');
      });

      it('[sourceId, tokenAddress, snapshotType, dedupeKey] upsert is idempotent — re-upsert yields exactly 1 row', async () => {
        const source = await makeSource(`${SOURCE_PREFIX}_idem`);
        const tokenAddress = `${TOKEN_PREFIX}_idem`;
        const dedupeKey = 'holderscan:holder_risk:' + tokenAddress + ':2026070800';
        const where = {
          sourceId_tokenAddress_snapshotType_dedupeKey: {
            sourceId: source.id,
            tokenAddress,
            snapshotType: 'holder_risk',
            dedupeKey
          }
        };

        await prisma.tokenConfluenceSnapshot.upsert({
          where,
          create: snapshotData({ sourceId: source.id, tokenAddress, snapshotType: 'holder_risk', dedupeKey }),
          update: {}
        });
        // Second upsert of the SAME key with a different status/dataJson must UPDATE, never insert.
        const second = await prisma.tokenConfluenceSnapshot.upsert({
          where,
          create: snapshotData({ sourceId: source.id, tokenAddress, snapshotType: 'holder_risk', dedupeKey }),
          update: { status: 'plan_required', dataJson: { note: 'quota exhausted' } }
        });

        const rows = await prisma.tokenConfluenceSnapshot.findMany({
          where: { sourceId: source.id, tokenAddress, snapshotType: 'holder_risk', dedupeKey }
        });
        expect(rows).toHaveLength(1);
        expect(second.status).toBe('plan_required');
        expect(second.dataJson).toEqual({ note: 'quota exhausted' });
      });

      it('same (tokenAddress, snapshotType, dedupeKey) under a DIFFERENT sourceId is a distinct row', async () => {
        const s1 = await makeSource(`${SOURCE_PREFIX}_scopeA`);
        const s2 = await makeSource(`${SOURCE_PREFIX}_scopeB`, { provider: 'gmgn', apiKeyEnvName: 'GMGN_API_KEY' });
        const tokenAddress = `${TOKEN_PREFIX}_scope`;
        const dedupeKey = 'x:external_intel:' + tokenAddress + ':2026070800';
        await prisma.tokenConfluenceSnapshot.create({
          data: snapshotData({ sourceId: s1.id, tokenAddress, snapshotType: 'external_intel', dedupeKey, provider: 'holderscan' })
        });
        await prisma.tokenConfluenceSnapshot.create({
          data: snapshotData({ sourceId: s2.id, tokenAddress, snapshotType: 'external_intel', dedupeKey, provider: 'gmgn' })
        });

        const all = await prisma.tokenConfluenceSnapshot.findMany({ where: { tokenAddress, dedupeKey } });
        expect(all).toHaveLength(2);
      });

      it('stores the INTERNAL LiquidityRisk snapshot with sourceId=null (no source row) and provider="internal"', async () => {
        const tokenAddress = `${TOKEN_PREFIX}_internal`;
        const dedupeKey = 'internal:liquidity_risk:' + tokenAddress + ':2026070800';
        const internal = await prisma.tokenConfluenceSnapshot.create({
          data: snapshotData({
            sourceId: null,
            tokenAddress,
            snapshotType: 'liquidity_risk',
            provider: 'internal',
            dedupeKey,
            dataJson: { liquidityToMcapRatio: 0.03, ratioFragilityBand: 'fragile', confidence: 'high' }
          })
        });
        expect(internal.sourceId).toBeNull();
        expect(internal.provider).toBe('internal');
        expect(internal.snapshotType).toBe('liquidity_risk');
        // A second create of the SAME internal key must fail the unique constraint
        // (Postgres treats NULL sourceId + identical rest as a single logical key here
        // because the other three columns are non-null and identical).
        await expect(
          prisma.tokenConfluenceSnapshot.create({
            data: snapshotData({ sourceId: null, tokenAddress, snapshotType: 'liquidity_risk', provider: 'internal', dedupeKey })
          })
        ).rejects.toThrow();
      });

      it('unlinked snapshot: a missing token yields tokenId=null and persists cleanly (external providers never create Token rows)', async () => {
        const source = await makeSource(`${SOURCE_PREFIX}_unlinked`);
        const tokenAddress = `${TOKEN_PREFIX}_ghost`;
        const unlinked = await prisma.tokenConfluenceSnapshot.create({
          data: snapshotData({
            sourceId: source.id,
            tokenAddress,
            snapshotType: 'external_intel',
            provider: 'gmgn',
            dedupeKey: 'gmgn:external_intel:' + tokenAddress + ':2026070800',
            tokenId: null
          })
        });
        expect(unlinked.tokenId).toBeNull();

        const readBack = await prisma.tokenConfluenceSnapshot.findUnique({
          where: { id: unlinked.id },
          include: { token: true }
        });
        expect(readBack!.token).toBeNull();
        // And the token was NOT created as a side effect.
        const token = await prisma.token.findUnique({ where: { chain_address: { chain: 'SOLANA', address: tokenAddress } } });
        expect(token).toBeNull();
      });

      it('links a snapshot to a Token and reads it back via Token.confluenceSnapshots back-relation', async () => {
        const source = await makeSource(`${SOURCE_PREFIX}_linked`);
        const token = await makeToken('linked');
        const tokenAddress = token.address;
        const linked = await prisma.tokenConfluenceSnapshot.create({
          data: snapshotData({
            sourceId: source.id,
            tokenAddress,
            snapshotType: 'holder_risk',
            dedupeKey: 'holderscan:holder_risk:' + tokenAddress + ':2026070800',
            tokenId: token.id
          })
        });
        expect(linked.tokenId).toBe(token.id);

        const tokenWithSnaps = await prisma.token.findUnique({
          where: { id: token.id },
          include: { confluenceSnapshots: true }
        });
        expect(tokenWithSnaps!.confluenceSnapshots).toHaveLength(1);
        expect(tokenWithSnaps!.confluenceSnapshots[0]!.snapshotType).toBe('holder_risk');
      });

      it('ON DELETE SET NULL: deleting the linked Token nulls the snapshot tokenId (snapshot survives)', async () => {
        const source = await makeSource(`${SOURCE_PREFIX}_setnull`);
        const token = await makeToken('setnull');
        const tokenAddress = token.address;
        const snap = await prisma.tokenConfluenceSnapshot.create({
          data: snapshotData({
            sourceId: source.id,
            tokenAddress,
            snapshotType: 'liquidity_map',
            provider: 'clobr',
            dedupeKey: 'clobr:liquidity_map:' + tokenAddress + ':2026070800',
            tokenId: token.id
          })
        });

        await prisma.token.delete({ where: { id: token.id } });

        const after = await prisma.tokenConfluenceSnapshot.findUnique({ where: { id: snap.id } });
        expect(after).not.toBeNull();
        expect(after!.tokenId).toBeNull();
        // tokenAddress is retained so the row is still keyed to the (chain,address) pair.
        expect(after!.tokenAddress).toBe(tokenAddress);
      });

      it('unavailable != safe: a provider that could not return data persists status="unavailable" verbatim, no coercion', async () => {
        const source = await makeSource(`${SOURCE_PREFIX}_unavail`);
        const tokenAddress = `${TOKEN_PREFIX}_unavail`;
        const snap = await prisma.tokenConfluenceSnapshot.create({
          data: snapshotData({
            sourceId: source.id,
            tokenAddress,
            snapshotType: 'external_intel',
            provider: 'gmgn',
            status: 'unavailable',
            dataJson: {},
            dedupeKey: 'gmgn:external_intel:' + tokenAddress + ':2026070800'
          })
        });
        const readBack = await prisma.tokenConfluenceSnapshot.findUnique({ where: { id: snap.id } });
        expect(readBack!.status).toBe('unavailable');
        expect(readBack!.status).not.toBe('ok');
        expect(readBack!.dataJson).toEqual({});
      });

      it('persists every honest degraded status (missing_key, plan_required, rate_limited, stub, error) unchanged', async () => {
        const source = await makeSource(`${SOURCE_PREFIX}_statuses`);
        const statuses = ['missing_key', 'plan_required', 'rate_limited', 'stub', 'error'] as const;
        for (const status of statuses) {
          const tokenAddress = `${TOKEN_PREFIX}_st_${status}`;
          const snap = await prisma.tokenConfluenceSnapshot.create({
            data: snapshotData({
              sourceId: source.id,
              tokenAddress,
              snapshotType: 'holder_risk',
              status,
              dataJson: {},
              dedupeKey: 'holderscan:holder_risk:' + tokenAddress + ':2026070800'
            })
          });
          expect(snap.status).toBe(status);
        }
      });

      it('paper_trade snapshotType is a valid value on TokenConfluenceSnapshot (no separate PaperTradeObservation table)', async () => {
        const tokenAddress = `${TOKEN_PREFIX}_paper`;
        const snap = await prisma.tokenConfluenceSnapshot.create({
          data: snapshotData({
            sourceId: null,
            tokenAddress,
            snapshotType: 'paper_trade',
            provider: 'manual',
            status: 'stub',
            dataJson: { note: 'manual CSV import only; stub for now' },
            dedupeKey: 'manual:paper_trade:' + tokenAddress + ':2026070800'
          })
        });
        expect(snap.snapshotType).toBe('paper_trade');
      });

      it('all four documented indexes exist on token_confluence_snapshots', async () => {
        const rows = await prisma.$queryRawUnsafe<{ indexdef: string }[]>(
          `SELECT indexdef FROM pg_indexes WHERE tablename = 'token_confluence_snapshots'`
        );
        const defs = rows.map((r) => r.indexdef).join('\n');
        // @@index([tokenId])
        expect(defs).toMatch(/\("?tokenId"?\)/);
        // @@index([chain, tokenAddress])
        expect(defs).toMatch(/\("?chain"?, "?tokenAddress"?\)/);
        // @@index([provider, snapshotType])
        expect(defs).toMatch(/\("?provider"?, "?snapshotType"?\)/);
        // @@index([observedAt])
        expect(defs).toMatch(/\("?observedAt"?\)/);
      });
    }
  );
  ```

- [ ] **Step 2: Run the test — expect FAIL (models do not exist yet).**
  Command:
  ```
  cd C:/Users/akki/session/flowradar/packages/db && npx vitest run test/confluenceSchema.test.ts
  ```
  Expected: compile/type error — `Property 'externalConfluenceSource' does not exist on type 'PrismaClient'` (and `tokenConfluenceSnapshot`, `confluenceSnapshots`). This confirms the test targets real, not-yet-existing schema.

- [ ] **Step 3: Add the two models + the `Token` back-relation to `schema.prisma` (REAL code).**
  Edit `C:/Users/akki/session/flowradar/packages/db/prisma/schema.prisma`.

  First, add the back-relation to the `Token` model. Insert `confluenceSnapshots` immediately after the existing `socialMentions` relation line (line 313, `socialMentions    SocialMention[]`):
  ```prisma
    socialMentions    SocialMention[]
    /// Task B (External Confluence) — reverse side of TokenConfluenceSnapshot.token.
    /// Shadow-only evidence rows; nullable FK with onDelete: SetNull, so deleting a
    /// Token orphans (never deletes) its confluence snapshots — they keep pointing at
    /// the (chain, tokenAddress) pair. NEVER feeds FlowScore / signals / wallet scoring.
    confluenceSnapshots TokenConfluenceSnapshot[]
  ```

  Then append the two new models at the END of the file (after model `SocialMention`, i.e. after line 1086). Use these EXACT definitions:
  ```prisma
  // ---------------------------------------------------------------------------
  // 28. ExternalConfluenceSource (External Confluence — Task B; operator-managed registry)
  // ---------------------------------------------------------------------------

  /// One operator-registered external confluence/evidence provider (holderscan,
  /// clobr, gmgn, ag_paper) or a keyless `manual` entry. Mirrors
  /// ExternalWalletSource/SocialSource's registry role but is ENTIRELY SEPARATE:
  /// confluence data is SHADOW-ONLY and never feeds FlowScore, signal rules,
  /// wallet scoring, the candidate pipeline, or production alerts. `apiKeyEnvName`
  /// stores the env VAR NAME of the provider credential (e.g. "HOLDERSCAN_API_KEY")
  /// — NEVER a value; null for keyless (manual/internal) providers. The internal
  /// LiquidityRisk snapshot has NO source row (TokenConfluenceSnapshot.sourceId is
  /// null for it). `status` uses the source-level taxonomy
  /// idle|live|mock|missing_key|plan_required|stub|unavailable|rate_limited|error.
  model ExternalConfluenceSource {
    id                 String    @id @default(cuid())
    name               String    @unique
    provider           String    // holderscan | clobr | gmgn | ag_paper | manual
    enabled            Boolean   @default(true)
    apiKeyEnvName      String?   // env var NAME only; null for keyless (manual/internal)
    rateLimitPerMinute Int       @default(30)
    status             String    @default("idle") // idle|live|mock|missing_key|plan_required|stub|unavailable|rate_limited|error
    lastSyncAt         DateTime?
    lastError          String?
    failCount          Int       @default(0)
    metadataJson       Json?
    addedAt            DateTime  @default(now())

    snapshots          TokenConfluenceSnapshot[]

    @@map("external_confluence_sources")
  }

  // ---------------------------------------------------------------------------
  // 29. TokenConfluenceSnapshot (External Confluence — Task B; shadow-only point-in-time evidence)
  // ---------------------------------------------------------------------------

  /// One point-in-time confluence/evidence observation for a token, from either an
  /// external provider (sourceId set) or the INTERNAL LiquidityRisk computation
  /// (sourceId null, provider "internal"). SHADOW-ONLY: there is NO column that
  /// participates in FlowScore — all metrics live in `dataJson`, which is
  /// DISPLAY-SAFE ONLY and MUST contain no secret values. `tokenId` is nullable
  /// with onDelete: SetNull: external providers NEVER create Token rows, so a
  /// not-yet-known token yields an "unlinked" snapshot keyed to (chain,
  /// tokenAddress); deleting a Token nulls (never deletes) its snapshots. `status`
  /// is honest per-fetch state — ok | unavailable | missing_key | plan_required |
  /// rate_limited | error | stub — and is NEVER coerced to a reassuring value when
  /// data is absent (unavailable != safe). `dedupeKey` is NON-NULL
  /// (`${provider}:${snapshotType}:${tokenAddress}:${observedHourBucket}`), so
  /// @@unique([sourceId, tokenAddress, snapshotType, dedupeKey]) makes re-ingest
  /// idempotent. `snapshotType` includes `paper_trade` (AG Paper is manual/stub
  /// only — there is deliberately NO separate PaperTradeObservation table).
  model TokenConfluenceSnapshot {
    id           String    @id @default(cuid())
    tokenId      String?
    chain        ChainId
    tokenAddress String
    sourceId     String?
    provider     String    // holderscan | clobr | gmgn | ag_paper | manual | internal
    snapshotType String    // holder_risk | liquidity_risk | liquidity_map | external_intel | paper_trade
    status       String    // ok | unavailable | missing_key | plan_required | rate_limited | error | stub
    dataJson     Json      // computed/provider-claimed metrics — DISPLAY-SAFE, no secrets
    observedAt   DateTime
    ingestedAt   DateTime  @default(now())
    dedupeKey    String
    metadataJson Json?

    token        Token?                    @relation(fields: [tokenId], references: [id], onDelete: SetNull)
    source       ExternalConfluenceSource? @relation(fields: [sourceId], references: [id], onDelete: SetNull)

    @@unique([sourceId, tokenAddress, snapshotType, dedupeKey])
    @@index([tokenId])
    @@index([chain, tokenAddress])
    @@index([provider, snapshotType])
    @@index([observedAt])
    @@map("token_confluence_snapshots")
  }
  ```
  Note: the `source` relation FK uses `onDelete: SetNull` (matching `sourceId String?`) so deleting a source row leaves its snapshots as archival, unlinked-from-source evidence rather than cascade-deleting historical observations — consistent with the shadow-only, never-destroy-evidence intent. Task D's cleanup deletes snapshots explicitly by prefix, not via source cascade.

- [ ] **Step 4: Create + apply the migration and regenerate the client.**
  Command (single invocation — `db:migrate:new` ensures LITE Postgres is up on 5439, then runs `prisma migrate dev`):
  ```
  cd C:/Users/akki/session/flowradar/packages/db && npm run db:migrate:new -- --name external_confluence
  ```
  Expected: a new folder `prisma/migrations/<timestamp>_external_confluence/migration.sql` is created and applied, and the Prisma client is regenerated (so `prisma.externalConfluenceSource` / `prisma.tokenConfluenceSnapshot` become available). If the client is not regenerated automatically in this environment, follow with:
  ```
  cd C:/Users/akki/session/flowradar/packages/db && npm run generate
  ```

- [ ] **Step 5: Verify the generated migration SQL matches the design (read-only check).**
  Read `C:/Users/akki/session/flowradar/packages/db/prisma/migrations/<timestamp>_external_confluence/migration.sql`. Confirm ALL of:
  - `CREATE TABLE "external_confluence_sources"` with `enabled BOOLEAN NOT NULL DEFAULT true`, `rateLimitPerMinute INTEGER NOT NULL DEFAULT 30`, `status TEXT NOT NULL DEFAULT 'idle'`, `failCount INTEGER NOT NULL DEFAULT 0`, `apiKeyEnvName TEXT` (nullable).
  - `CREATE TABLE "token_confluence_snapshots"` with `tokenId TEXT` (nullable), `sourceId TEXT` (nullable), `dedupeKey TEXT NOT NULL`, `dataJson JSONB NOT NULL`.
  - `CREATE UNIQUE INDEX ... ON "token_confluence_snapshots"("sourceId", "tokenAddress", "snapshotType", "dedupeKey")`.
  - Four non-unique indexes on `("tokenId")`, `("chain", "tokenAddress")`, `("provider", "snapshotType")`, `("observedAt")`.
  - Two `ADD CONSTRAINT ... FOREIGN KEY ("tokenId") ... ON DELETE SET NULL` and `... FOREIGN KEY ("sourceId") ... ON DELETE SET NULL` (NOT `ON DELETE CASCADE`).
  If any `ON DELETE` clause reads `CASCADE` or `RESTRICT`, the `onDelete: SetNull` in Step 3 was mis-entered — fix the schema and re-run Step 4.

- [ ] **Step 6: Run the test — expect PASS.**
  Command:
  ```
  cd C:/Users/akki/session/flowradar/packages/db && npx vitest run test/confluenceSchema.test.ts
  ```
  Expected: all tests pass (the LITE Postgres started by Step 4 is still on 5439, so `describe.skipIf` does NOT skip). Confirm the run reports the suite as executed (not skipped) — the ON DELETE SET NULL test and the pg_indexes test in particular prove the migration, not just the schema, is correct.

- [ ] **Step 7: Commit.**
  ```
  cd C:/Users/akki/session/flowradar && git add packages/db/prisma/schema.prisma packages/db/prisma/migrations packages/db/test/confluenceSchema.test.ts
  git commit -m "Task B: ExternalConfluenceSource + TokenConfluenceSnapshot schema + migration

Two-table shadow-only confluence schema (no PaperTradeObservation): registry +
point-in-time evidence with nullable tokenId (ON DELETE SET NULL, unlinked
snapshots), nullable sourceId (internal LiquidityRisk rows), idempotent upsert by
[sourceId, tokenAddress, snapshotType, dedupeKey], and honest per-fetch status
(unavailable != safe). Token.confluenceSnapshots back-relation. LITE-Postgres
integration test on 5439.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

**Done Bar:**
- `schema.prisma` contains `ExternalConfluenceSource`, `TokenConfluenceSnapshot`, and `Token.confluenceSnapshots` exactly as specified; `prisma validate` (run implicitly by `migrate dev`) passes.
- A committed migration `<timestamp>_external_confluence/migration.sql` exists, applies cleanly on a fresh DB, and its SQL shows both FKs as `ON DELETE SET NULL`, the composite `UNIQUE` index, and all four `@@index` indexes.
- `prisma.externalConfluenceSource` and `prisma.tokenConfluenceSnapshot` are available on the generated client; upsert `where` key `sourceId_tokenAddress_snapshotType_dedupeKey` type-checks.
- `npx vitest run test/confluenceSchema.test.ts` runs (not skipped) and every case passes, including: idempotent upsert (exactly 1 row), per-`sourceId` scoping, internal `sourceId=null` row, unlinked `tokenId=null` (and the Token was not created), ON DELETE SET NULL, `unavailable`/`stub`/`plan_required`/`missing_key`/`rate_limited`/`error` persisted verbatim, `paper_trade` snapshotType accepted, and all four indexes present.
- NO `PaperTradeObservation` model or `paper_trade_observations` table exists anywhere in the schema or migration.

**Reviewer Focus:**
- **Shadow-only integrity:** confirm NO column on either model participates in FlowScore/signals — all metrics live in `dataJson` only. No touch to `flowScore.ts`, rule constants, `walletScore.ts`, or `CandidateWallet`. This task is schema-only; grep the diff to ensure nothing outside `schema.prisma`, the migration dir, and the new test was changed.
- **`onDelete: SetNull` on BOTH FKs (not Cascade):** the `tokenId` FK must be SetNull so external providers' evidence survives Token deletion as an unlinked row (constraint 6 — never destroy the (chain,address)-keyed observation). Verify in the generated SQL, not just the schema — Prisma silently defaults an optional relation to `SetNull`, but a stray `onDelete: Cascade` would delete evidence.
- **`tokenId` and `sourceId` both nullable:** unlinked snapshots (missing token) and internal LiquidityRisk snapshots (no source) both depend on this. A non-null constraint on either would break Task D's "never create Token rows" and "internal `sourceId=null`" flows.
- **Composite unique key name + column order:** later tasks upsert via `sourceId_tokenAddress_snapshotType_dedupeKey` — the `@@unique` column order must be exactly `[sourceId, tokenAddress, snapshotType, dedupeKey]` or Task D's upsert key breaks. Confirm the per-`sourceId` scoping test proves two sources can share the other three columns.
- **`unavailable != safe` at the data layer:** the schema must accept and return every degraded status verbatim (no enum coercion, no default that masks absence). `status` is a plain `String` with no default — a snapshot with absent data carries `unavailable`/`stub`/etc., never silently `ok`. Confirm the status tests assert `.not.toBe('ok')` where data is absent.
- **No secrets / no `PaperTradeObservation`:** `apiKeyEnvName` is a NAME (`String?`), `dataJson` is display-safe; confirm the doc comments state this. Confirm the two-tables-only rule held — no `paper_trade_observations` table crept in, and `paper_trade` is exercised as a `snapshotType` value instead.

---

### Task C: Provider framework + HolderScan/CLOBr/GMGN/AG-Paper stubs + source status

**Depends on:** Task A (`@flowradar/core` exports `Chain`; `connectors.externalConfluence` settings shape) is referenced only for the `Chain` type here — no runtime coupling. This task is otherwise self-contained and builds green with **zero** provider keys.

**Files:**

- **Create** `packages/providers/src/confluence/types.ts` — `ConfluenceFetchResult`, `ConfluenceProvider`, `ConfluenceSourceMode`, `ConfluenceSourceStatusRow`.
- **Create** `packages/providers/src/confluence/mockConfluence.ts` — `MockConfluenceProvider` (deterministic `ok`).
- **Create** `packages/providers/src/confluence/holderscan.ts` — `createHolderScanProvider(env)`.
- **Create** `packages/providers/src/confluence/clobr.ts` — `createClobrProvider(env)`.
- **Create** `packages/providers/src/confluence/gmgn.ts` — `createGmgnProvider(env)` (query-only).
- **Create** `packages/providers/src/confluence/agPaper.ts` — `createAgPaperProvider()`.
- **Create** `packages/providers/src/confluence/sourceStatus.ts` — `getConfluenceSourceStatuses(prisma)`.
- **Create** `packages/providers/src/confluence/index.ts` — barrel.
- **Modify** `packages/providers/src/index.ts` — add `export * from './confluence';`.
- **Test** `packages/providers/test/confluenceSources.test.ts` — full behavior suite.
- **Test** `packages/providers/test/gmgnQueryOnlyGuard.test.ts` — grep-guard: GMGN adapter references zero swap/order/private-key/wallet endpoints.

**Interfaces:**

Consumes (from `@flowradar/core`, Task-independent — already exported at `packages/core/src/types.ts:18`):
```ts
export type Chain = 'SOLANA' | 'BSC';
```

Produces (Task D `runExternalConfluencePass` and Task E `ConfluencePanel`/`getConfluenceSourceStatuses` consumers rely on these EXACT names/types):
```ts
export interface ConfluenceFetchResult {
  status: 'ok' | 'unavailable' | 'missing_key' | 'plan_required' | 'rate_limited' | 'error' | 'stub';
  dataJson: Record<string, unknown>;
  observedAt: Date;
}
export interface ConfluenceProvider {
  name: string;
  provider: string;
  snapshotType: string;
  chains: Chain[];
  fetchForToken(chain: Chain, tokenAddress: string): Promise<ConfluenceFetchResult>;
}
export type ConfluenceSourceMode = 'live' | 'mock' | 'missing_key' | 'plan_required' | 'stub' | 'unavailable' | 'error';
export interface ConfluenceSourceStatusRow {
  sourceName: string;
  provider: string;
  mode: ConfluenceSourceMode;
  note: string;
  apiKeyEnvName: string | null;
}
export class MockConfluenceProvider implements ConfluenceProvider { /* ... */ }
export function createHolderScanProvider(env: HolderScanEnv): ConfluenceProvider | null;
export function createClobrProvider(env: ClobrEnv): ConfluenceProvider | null;
export function createGmgnProvider(env: GmgnConfluenceEnv): ConfluenceProvider | null;
export function createAgPaperProvider(): ConfluenceProvider | null;
export function getConfluenceSourceStatuses(prisma: ConfluenceSourceStatusClient): Promise<ConfluenceSourceStatusRow[]>;
```

Steps run from the repo root (`C:/Users/akki/session/flowradar`). Test command is `npx vitest run <path>` (root `test` script is `vitest run`; no DB needed — this task is pure/parallel-safe, fetch stubbed, env restored per test).

---

- [ ] **Step 1: Write failing test for the `confluence` types + mock provider (deterministic `ok`).**

  Create `packages/providers/test/confluenceSources.test.ts` with the header block and the first two describe blocks:

  ```ts
  // FlowRadar — external-confluence provider unit tests (Task C): MockConfluenceProvider
  // deterministic ok results; holderscan/clobr/gmgn/agPaper config-gated stubs
  // (null on missing required key, honest stub/plan_required/unavailable statuses,
  // NEVER 'ok', NEVER 'safe'); getConfluenceSourceStatuses mode mapping; no secret
  // value ever echoed (env NAME only). Parallel-safe: no DB, fetch stubbed, env
  // restored per test. Mirrors socialSources.test.ts conventions.
  import { afterEach, describe, expect, it, vi } from 'vitest';
  import {
    MockConfluenceProvider,
    createHolderScanProvider,
    createClobrProvider,
    createGmgnProvider,
    createAgPaperProvider,
    getConfluenceSourceStatuses
  } from '../src/confluence';
  import type { ConfluenceFetchResult } from '../src/confluence';

  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // A fetch result must never claim a reassuring/"clean"/"safe" verdict — global
  // constraint 15 (unavailable !== safe). This asserts on the shape a shadow-only
  // provider is allowed to return: no key named 'safe'/'clean'/'verdict' in dataJson.
  function assertNoSafeVerdict(r: ConfluenceFetchResult) {
    const keys = Object.keys(r.dataJson).map((k) => k.toLowerCase());
    expect(keys).not.toContain('safe');
    expect(keys).not.toContain('clean');
    expect(keys).not.toContain('verdict');
  }

  describe('MockConfluenceProvider', () => {
    it('implements ConfluenceProvider with a holderscan-shaped default identity', () => {
      const p = new MockConfluenceProvider();
      expect(p.name).toBe('mock-confluence');
      expect(p.provider).toBe('mock');
      expect(p.snapshotType).toBe('holder_risk');
      expect(p.chains).toEqual(['SOLANA']);
      expect(typeof p.fetchForToken).toBe('function');
    });

    it('honours name/provider/snapshotType overrides so one class can back any source', () => {
      const p = new MockConfluenceProvider({
        name: 'mock-gmgn',
        provider: 'gmgn',
        snapshotType: 'external_intel'
      });
      expect(p.name).toBe('mock-gmgn');
      expect(p.provider).toBe('gmgn');
      expect(p.snapshotType).toBe('external_intel');
    });

    it('fetchForToken returns a deterministic ok result: same inputs => byte-identical dataJson', async () => {
      const p = new MockConfluenceProvider();
      const a = await p.fetchForToken('SOLANA', 'MockTokenAddr1111111111111111111111111111111');
      const b = await p.fetchForToken('SOLANA', 'MockTokenAddr1111111111111111111111111111111');
      expect(a.status).toBe('ok');
      expect(a.dataJson).toEqual(b.dataJson);
      expect(a.observedAt.getTime()).toBe(b.observedAt.getTime());
    });

    it('different addresses => different deterministic dataJson (address-seeded)', async () => {
      const p = new MockConfluenceProvider();
      const a = await p.fetchForToken('SOLANA', 'AddrAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
      const b = await p.fetchForToken('SOLANA', 'AddrBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB');
      expect(a.dataJson).not.toEqual(b.dataJson);
    });

    it('labels its ok payload provider-claimed and never asserts a safe/clean verdict', async () => {
      const p = new MockConfluenceProvider();
      const r = await p.fetchForToken('SOLANA', 'MockTokenAddr1111111111111111111111111111111');
      expect(r.dataJson.providerClaimed).toBe(true);
      assertNoSafeVerdict(r);
    });

    it('returns unavailable (never ok) for a non-SOLANA chain — Solana-only in practice, no BSC', async () => {
      const p = new MockConfluenceProvider();
      const r = await p.fetchForToken('BSC', 'MockTokenAddr1111111111111111111111111111111');
      expect(r.status).toBe('unavailable');
      expect(r.dataJson.providerClaimed).toBeUndefined();
    });
  });
  ```

- [ ] **Step 2: Run — expect FAIL (module not found).**

  ```
  npx vitest run packages/providers/test/confluenceSources.test.ts
  ```
  Expected: FAIL — `Failed to resolve import "../src/confluence"` (the `confluence` folder does not exist yet).

- [ ] **Step 3: Implement `types.ts` and `mockConfluence.ts` + minimal barrel.**

  Create `packages/providers/src/confluence/types.ts`:
  ```ts
  // FlowRadar — external-confluence provider interfaces (External Confluence
  // subsystem; design doc §Architecture / §"Provider status taxonomy").
  // Mirrors social/types.ts's SocialSourceProvider but for SHADOW-ONLY evidence:
  // a ConfluenceProvider READS holder/liquidity/external-intel for a KNOWN token
  // and hands back a ConfluenceFetchResult; it NEVER trades, NEVER creates Token
  // rows, and NEVER asserts a "safe"/"clean" verdict. The externalConfluence job
  // (packages/db + apps/worker, Task D) turns these into TokenConfluenceSnapshot
  // rows. Solana-only this build (chains=['SOLANA']); schema stays chain-aware.
  import type { Chain } from '@flowradar/core';

  /**
   * One point-in-time fetch result for a token. `status` is the honest outcome:
   * 'ok' (data present, provider-claimed) | 'unavailable'/'unknown' (could not
   * get data) | 'missing_key'/'plan_required' (operator must configure) | 'stub'
   * (no confirmed integration) | 'rate_limited' | 'error'. `dataJson` is
   * display-safe ONLY — it must contain NO secret values (design doc §Security).
   */
  export interface ConfluenceFetchResult {
    status: 'ok' | 'unavailable' | 'missing_key' | 'plan_required' | 'rate_limited' | 'error' | 'stub';
    dataJson: Record<string, unknown>;
    observedAt: Date;
  }

  /**
   * A shadow-only evidence reader for one or more chains. `name` should match the
   * ExternalConfluenceSource.name row so Task D's resolver can look providers up
   * by name. `provider`/`snapshotType` map onto the TokenConfluenceSnapshot
   * columns (design doc §Schema plan #2).
   */
  export interface ConfluenceProvider {
    name: string;
    provider: string;
    snapshotType: string;
    chains: Chain[];
    fetchForToken(chain: Chain, tokenAddress: string): Promise<ConfluenceFetchResult>;
  }

  /** Per-source effective mode for the token-detail Confluence panel's source-health row. */
  export type ConfluenceSourceMode =
    | 'live'
    | 'mock'
    | 'missing_key'
    | 'plan_required'
    | 'stub'
    | 'unavailable'
    | 'error';

  /**
   * Per-source status row. Never echoes a secret VALUE — only the configured env
   * var NAME and whether it is present (design doc §Security; constraint 13).
   */
  export interface ConfluenceSourceStatusRow {
    sourceName: string;
    provider: string;
    mode: ConfluenceSourceMode;
    note: string;
    /** The env VAR NAME the operator configured — a NAME only, never a value. null for keyless (ag_paper/internal). */
    apiKeyEnvName: string | null;
  }
  ```

  Create `packages/providers/src/confluence/mockConfluence.ts`:
  ```ts
  // FlowRadar — MockConfluenceProvider: deterministic 'ok' confluence results
  // for the demo/mock world (design doc §Architecture — MOCK_MODE selects the
  // mock, same one-switch convention as MockSocialSource/MockCandidateSource).
  // Fully deterministic: dataJson is a pure function of (provider, snapshotType,
  // chain, tokenAddress) via a small string hash — same inputs => byte-identical
  // output, always. No Math.random()/Date.now(). SHADOW-ONLY: every payload is
  // labeled providerClaimed and NEVER asserts a safe/clean verdict (constraint
  // 15,16). Non-SOLANA chain => 'unavailable' (Solana-only in practice, no BSC).
  import type { Chain } from '@flowradar/core';
  import type { ConfluenceFetchResult, ConfluenceProvider } from './types';

  // Fixed genesis so observedAt is deterministic across runs (mirrors the mock
  // world's genesis-derived timestamps; no Date.now()).
  const MOCK_GENESIS = new Date('2026-07-05T00:00:00.000Z');

  export interface MockConfluenceProviderOpts {
    name?: string;
    provider?: string;
    snapshotType?: string;
  }

  /** Small deterministic non-negative 32-bit string hash (cyrb53-lite; pure, no node: builtin). */
  function hash32(s: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  export class MockConfluenceProvider implements ConfluenceProvider {
    readonly name: string;
    readonly provider: string;
    readonly snapshotType: string;
    readonly chains: Chain[] = ['SOLANA'];

    constructor(opts: MockConfluenceProviderOpts = {}) {
      this.name = opts.name ?? 'mock-confluence';
      this.provider = opts.provider ?? 'mock';
      this.snapshotType = opts.snapshotType ?? 'holder_risk';
    }

    async fetchForToken(chain: Chain, tokenAddress: string): Promise<ConfluenceFetchResult> {
      // Solana-only in practice; a non-SOLANA chain yields honest 'unavailable',
      // NEVER 'ok' and NEVER a green verdict (constraint 15).
      if (chain !== 'SOLANA') {
        return {
          status: 'unavailable',
          dataJson: { note: 'mock confluence is SOLANA-only; no data for this chain' },
          observedAt: MOCK_GENESIS
        };
      }

      const seed = hash32(`${this.provider}:${this.snapshotType}:${chain}:${tokenAddress}`);
      // Deterministic pseudo-metrics derived from the seed — clearly demo values,
      // labeled provider-claimed, with NO safe/clean/verdict key.
      const holderCount = 200 + (seed % 4800);
      const topHolderConcentrationPct = Number((5 + (seed % 45)).toFixed(2));
      const holderDelta24h = ((seed % 401) - 200); // -200..+200, can be negative
      const observedAt = new Date(MOCK_GENESIS.getTime() + (seed % 3600) * 1000);

      return {
        status: 'ok',
        dataJson: {
          providerClaimed: true,
          holderCount,
          topHolderConcentrationPct,
          holderDelta: { '24h': holderDelta24h },
          sourceName: this.name,
          note: 'MOCK_MODE deterministic confluence — demo values, not real provider data'
        },
        observedAt
      };
    }
  }
  ```

  Create `packages/providers/src/confluence/index.ts` (barrel — grows over the following steps):
  ```ts
  // FlowRadar — external-confluence provider public API (design doc §Architecture).
  // Re-exported from @flowradar/providers's top-level index.ts.
  export * from './types';
  export * from './mockConfluence';
  ```

- [ ] **Step 4: Run — expect PASS.**

  ```
  npx vitest run packages/providers/test/confluenceSources.test.ts
  ```
  Expected: PASS (both `MockConfluenceProvider` describe blocks green).

- [ ] **Step 5: Commit.**

  ```
  git add packages/providers/src/confluence/types.ts packages/providers/src/confluence/mockConfluence.ts packages/providers/src/confluence/index.ts packages/providers/test/confluenceSources.test.ts
  git commit -m "feat(providers): confluence provider types + deterministic MockConfluenceProvider

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

- [ ] **Step 6: Write failing test for `createHolderScanProvider` (missing key => null; keyed => documented STUB returning plan_required/unavailable, NEVER ok, NEVER a safe verdict, NO network call).**

  Append this describe block to `packages/providers/test/confluenceSources.test.ts`:
  ```ts
  describe('createHolderScanProvider (optional/paid, config-gated, plan-aware STUB)', () => {
    it('returns null when HOLDERSCAN_API_KEY is absent (graceful missing-key skip)', () => {
      expect(createHolderScanProvider({})).toBeNull();
    });

    it('keyed => a provider whose fetchForToken is a documented STUB with NO network call', async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
      const p = createHolderScanProvider({ HOLDERSCAN_API_KEY: 'k' })!;
      expect(p.provider).toBe('holderscan');
      expect(p.snapshotType).toBe('holder_risk');
      expect(p.chains).toEqual(['SOLANA']);
      const r = await p.fetchForToken('SOLANA', 'AddrAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
      // Plan-gated / no verified endpoint yet => plan_required or unavailable,
      // NEVER 'ok' (no hallucinated endpoint), NEVER a safe/clean verdict.
      expect(['plan_required', 'unavailable']).toContain(r.status);
      expect(r.status).not.toBe('ok');
      assertNoSafeVerdict(r);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('does NOT infer safe from absence — dataJson carries a plan/unavailable note, no green fields', async () => {
      const p = createHolderScanProvider({ HOLDERSCAN_API_KEY: 'k' })!;
      const r = await p.fetchForToken('SOLANA', 'AddrAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
      expect(typeof r.dataJson.note).toBe('string');
      expect(r.dataJson.holderCount).toBeUndefined();
    });
  });
  ```

- [ ] **Step 7: Run — expect FAIL (`createHolderScanProvider` not exported).**

  ```
  npx vitest run packages/providers/test/confluenceSources.test.ts
  ```
  Expected: FAIL — `createHolderScanProvider is not a function` / import binding undefined.

- [ ] **Step 8: Implement `holderscan.ts` and export it.**

  Create `packages/providers/src/confluence/holderscan.ts`:
  ```ts
  // FlowRadar — HolderScan HolderRisk provider (design doc §Module A). OPTIONAL
  // and likely PAID/plan-gated — the build must NOT depend on it. Config-gated:
  // returns null when HOLDERSCAN_API_KEY is absent (graceful missing-key skip,
  // mirrors createTelegramSocialSource's null contract). When keyed it is a
  // DOCUMENTED STUB: there is no verified public endpoint wired here, so
  // fetchForToken resolves to status 'plan_required' (a key alone does not make
  // an unverified paid integration real) and makes NO network call. It NEVER
  // returns 'ok' and NEVER infers a 'safe'/'clean' verdict from absence
  // (constraint 15). NO hallucinated endpoint.
  //
  // TODO(provider): once a real HolderScan plan + docs exist, replace the stub
  // body with a fetch() against the documented base URL, mapping the plan's
  // holder-delta/concentration fields into dataJson (all provider-claimed);
  // 401/403/402/quota => 'plan_required', 429 => 'rate_limited', endpoint down
  // => 'unavailable', malformed => fields marked unknown. Never infer 'safe'.
  import type { Chain } from '@flowradar/core';
  import type { ConfluenceFetchResult, ConfluenceProvider } from './types';

  export interface HolderScanEnv {
    HOLDERSCAN_API_KEY?: string;
  }

  export function createHolderScanProvider(env: HolderScanEnv): ConfluenceProvider | null {
    if (!env.HOLDERSCAN_API_KEY) return null; // missing key => graceful skip (source marked missing_key)
    return {
      name: 'holderscan',
      provider: 'holderscan',
      snapshotType: 'holder_risk',
      chains: ['SOLANA'],
      async fetchForToken(_chain: Chain, _tokenAddress: string): Promise<ConfluenceFetchResult> {
        // Documented stub: no verified endpoint wired. A present key does not make
        // an unverified paid plan real, so we report plan_required honestly and
        // never fabricate data or a safe verdict.
        return {
          status: 'plan_required',
          dataJson: {
            providerClaimed: false,
            note: 'HolderScan plan/integration not verified — no data fetched. See file header TODO(provider). Absence of data is NOT a safe signal.'
          },
          observedAt: new Date(0)
        };
      }
    };
  }
  ```

  Update `packages/providers/src/confluence/index.ts` to add:
  ```ts
  export * from './holderscan';
  ```

- [ ] **Step 9: Run — expect PASS.**

  ```
  npx vitest run packages/providers/test/confluenceSources.test.ts
  ```
  Expected: PASS (HolderScan describe block green).

- [ ] **Step 10: Commit.**

  ```
  git add packages/providers/src/confluence/holderscan.ts packages/providers/src/confluence/index.ts packages/providers/test/confluenceSources.test.ts
  git commit -m "feat(providers): HolderScan holder-risk provider (null on missing key, plan_required stub)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

- [ ] **Step 11: Write failing test for `createClobrProvider` (optional key; STUB fetch returns status 'stub'; never null even without key — a stub still registers; NEVER ok/safe; no network call).**

  Append this describe block to `packages/providers/test/confluenceSources.test.ts`:
  ```ts
  describe('createClobrProvider (optional, stub-only — no confirmed public API)', () => {
    it('returns a provider even with no key (stub registers regardless), fetch => "stub", NO network call', async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
      const p = createClobrProvider({})!;
      expect(p).not.toBeNull();
      expect(p.provider).toBe('clobr');
      expect(p.snapshotType).toBe('liquidity_map');
      expect(p.chains).toEqual(['SOLANA']);
      const r = await p.fetchForToken('SOLANA', 'AddrAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
      expect(r.status).toBe('stub');
      expect(r.status).not.toBe('ok');
      assertNoSafeVerdict(r);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('a present CLOBR_API_KEY does NOT upgrade the stub to ok (unverified endpoint stays a stub)', async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
      const p = createClobrProvider({ CLOBR_API_KEY: 'k' })!;
      const r = await p.fetchForToken('SOLANA', 'AddrAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
      expect(r.status).toBe('stub');
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });
  ```

- [ ] **Step 12: Run — expect FAIL (`createClobrProvider` not exported).**

  ```
  npx vitest run packages/providers/test/confluenceSources.test.ts
  ```
  Expected: FAIL — `createClobrProvider is not a function`.

- [ ] **Step 13: Implement `clobr.ts` and export it.**

  Create `packages/providers/src/confluence/clobr.ts`:
  ```ts
  // FlowRadar — CLOBr liquidity-map provider (design doc §Module C). STUB-ONLY:
  // no confirmed public API + docs exist (design doc Open Decision 2), so this
  // adapter is a typed stub that makes NO network call and never scrapes
  // private/gated/browser-only content. Unlike the key-gated holderscan factory,
  // a liquidity-map stub still REGISTERS (returns non-null) so the source appears
  // honestly as 'stub' in the panel; a present CLOBR_API_KEY does NOT make an
  // unverified endpoint real. fetchForToken always resolves status 'stub' and
  // NEVER 'ok'/'safe' (constraint 15). NO hallucinated endpoint.
  //
  // TODO(provider): if CLOBr publishes a confirmed public order-book/depth API,
  // replace the stub body with a fetch() mapping depth/support/resistance buckets
  // into dataJson (all provider-claimed); endpoint down => 'unavailable',
  // 401/403 => 'plan_required', 429 => 'rate_limited'.
  import type { Chain } from '@flowradar/core';
  import type { ConfluenceFetchResult, ConfluenceProvider } from './types';

  export interface ClobrEnv {
    CLOBR_API_KEY?: string;
  }

  export function createClobrProvider(_env: ClobrEnv): ConfluenceProvider | null {
    return {
      name: 'clobr',
      provider: 'clobr',
      snapshotType: 'liquidity_map',
      chains: ['SOLANA'],
      async fetchForToken(_chain: Chain, _tokenAddress: string): Promise<ConfluenceFetchResult> {
        return {
          status: 'stub',
          dataJson: {
            providerClaimed: false,
            note: 'CLOBr has no confirmed public API — typed stub, no liquidity map fetched. See file header TODO(provider). Not integrated is NOT a safe signal.'
          },
          observedAt: new Date(0)
        };
      }
    };
  }
  ```

  Update `packages/providers/src/confluence/index.ts` to add:
  ```ts
  export * from './clobr';
  ```

- [ ] **Step 14: Run — expect PASS.**

  ```
  npx vitest run packages/providers/test/confluenceSources.test.ts
  ```
  Expected: PASS (CLOBr describe block green).

- [ ] **Step 15: Commit.**

  ```
  git add packages/providers/src/confluence/clobr.ts packages/providers/src/confluence/index.ts packages/providers/test/confluenceSources.test.ts
  git commit -m "feat(providers): CLOBr liquidity-map stub provider (status 'stub', no API)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

- [ ] **Step 16: Write failing test for `createGmgnProvider` (QUERY-ONLY stub — status 'stub'/'unavailable', NEVER ok/safe; no network call).**

  Append this describe block to `packages/providers/test/confluenceSources.test.ts`:
  ```ts
  describe('createGmgnProvider (query-only external intel, stub — no verified public API)', () => {
    it('returns a query-only provider, fetch => "stub", labeled provider-claimed context, NO network call', async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
      const p = createGmgnProvider({})!;
      expect(p).not.toBeNull();
      expect(p.provider).toBe('gmgn');
      expect(p.snapshotType).toBe('external_intel');
      expect(p.chains).toEqual(['SOLANA']);
      const r = await p.fetchForToken('SOLANA', 'AddrAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
      expect(['stub', 'unavailable']).toContain(r.status);
      expect(r.status).not.toBe('ok');
      assertNoSafeVerdict(r);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('a present GMGN_API_KEY does NOT upgrade the query-only stub to ok', async () => {
      const p = createGmgnProvider({ GMGN_API_KEY: 'k' })!;
      const r = await p.fetchForToken('SOLANA', 'AddrAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
      expect(r.status).not.toBe('ok');
    });
  });
  ```

- [ ] **Step 17: Run — expect FAIL (`createGmgnProvider` not exported).**

  ```
  npx vitest run packages/providers/test/confluenceSources.test.ts
  ```
  Expected: FAIL — `createGmgnProvider is not a function`.

- [ ] **Step 18: Implement `gmgn.ts` (query-only) and export it.**

  Create `packages/providers/src/confluence/gmgn.ts`. The file body must contain **zero** swap/order/private-key/wallet-management strings — the grep-guard test in Step 22 enforces this. Comments in this file must NOT use the forbidden words except within the single explicit "Hard-forbidden:" negation sentence — to keep the grep-guard simple and robust, the guard scans for the substrings and this file must avoid them entirely, so the negation is phrased WITHOUT the literal forbidden tokens (see the comment below):
  ```ts
  // FlowRadar — GMGN query-only external-intel provider (design doc §Module D).
  // QUERY-ONLY and optional. This adapter reads discovery/labels/holders context
  // only. It performs NO execution of any kind and references NONE of the
  // forbidden capability endpoints (enforced by test/gmgnQueryOnlyGuard.test.ts,
  // which greps this file for those capability substrings and asserts zero hits).
  //
  // No verified public GMGN API/docs exist (a direct fetch this session returned
  // 403; see candidates/gmgnStub.ts's doc-verification note), so this is a typed
  // STUB: fetchForToken makes NO network call and resolves status 'stub'. A
  // present GMGN_API_KEY does NOT make an unverified endpoint real. It NEVER
  // returns 'ok'/'safe'. NO hallucinated endpoint.
  //
  // TODO(provider): if GMGN ever publishes an official QUERY-ONLY intel API,
  // replace the stub body with a fetch() mapping trending/labels/holders context
  // into dataJson — every field explicitly providerClaimed:true (never asserted
  // as fact). Do NOT add any capability beyond read-only queries.
  import type { Chain } from '@flowradar/core';
  import type { ConfluenceFetchResult, ConfluenceProvider } from './types';

  export interface GmgnConfluenceEnv {
    GMGN_API_KEY?: string;
  }

  export function createGmgnProvider(_env: GmgnConfluenceEnv): ConfluenceProvider | null {
    return {
      name: 'gmgn',
      provider: 'gmgn',
      snapshotType: 'external_intel',
      chains: ['SOLANA'],
      async fetchForToken(_chain: Chain, _tokenAddress: string): Promise<ConfluenceFetchResult> {
        return {
          status: 'stub',
          dataJson: {
            providerClaimed: true,
            note: 'GMGN has no verified public query API — typed query-only stub, no intel fetched. Labels/discovery would be provider-claimed, never fact. Not integrated is NOT a safe signal.'
          },
          observedAt: new Date(0)
        };
      }
    };
  }
  ```

  Update `packages/providers/src/confluence/index.ts` to add:
  ```ts
  export * from './gmgn';
  ```

- [ ] **Step 19: Run — expect PASS.**

  ```
  npx vitest run packages/providers/test/confluenceSources.test.ts
  ```
  Expected: PASS (GMGN describe block green).

- [ ] **Step 20: Commit.**

  ```
  git add packages/providers/src/confluence/gmgn.ts packages/providers/src/confluence/index.ts packages/providers/test/confluenceSources.test.ts
  git commit -m "feat(providers): GMGN query-only external-intel stub (status 'stub', zero execution endpoints)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

- [ ] **Step 21: Write failing grep-guard test — GMGN adapter references ZERO swap/order/private-key/wallet-management endpoints.**

  Create `packages/providers/test/gmgnQueryOnlyGuard.test.ts`:
  ```ts
  // FlowRadar — GMGN query-only enforcement (design doc §Module D "Enforcement",
  // global constraint 8/20). This is a source-text grep guard: the GMGN
  // confluence adapter must reference ZERO swap/order/execution/private-key/
  // wallet-management endpoints. If a future edit adds any such capability, this
  // test fails loudly. Reads the actual file off disk (not the compiled module).
  import { readFileSync } from 'node:fs';
  import { fileURLToPath } from 'node:url';
  import { dirname, join } from 'node:path';
  import { describe, expect, it } from 'vitest';

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const GMGN_SRC = join(__dirname, '..', 'src', 'confluence', 'gmgn.ts');

  // Forbidden capability substrings (case-insensitive). Kept as split fragments
  // in some entries so this guard file itself does not contain a full forbidden
  // token that would false-positive a naive scan of the test dir.
  const FORBIDDEN = [
    'swap',
    'order',
    'execute',
    'execution',
    'private' + 'key',
    'privatekey',
    'private_key',
    'wallet' + 'management',
    'signtransaction',
    'sign_transaction',
    'sendtransaction'
  ];

  describe('GMGN confluence adapter — query-only enforcement (grep guard)', () => {
    const src = readFileSync(GMGN_SRC, 'utf8').toLowerCase();

    for (const term of FORBIDDEN) {
      it(`references zero "${term}" endpoints/capabilities`, () => {
        expect(src.includes(term)).toBe(false);
      });
    }

    it('the file actually exists and defines createGmgnProvider (guard is not vacuous)', () => {
      expect(src).toContain('creategmgnprovider');
    });
  });
  ```

- [ ] **Step 22: Run — expect PASS (the GMGN file was authored clean in Step 18).**

  ```
  npx vitest run packages/providers/test/gmgnQueryOnlyGuard.test.ts
  ```
  Expected: PASS. If it FAILS on any forbidden term, edit `packages/providers/src/confluence/gmgn.ts` to remove that literal substring from BOTH code and comments (rephrase the comment) until green — do not weaken the guard.

- [ ] **Step 23: Commit.**

  ```
  git add packages/providers/test/gmgnQueryOnlyGuard.test.ts
  git commit -m "test(providers): GMGN query-only grep guard (zero swap/order/key/wallet endpoints)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

- [ ] **Step 24: Write failing test for `createAgPaperProvider` (manual/stub only — status 'stub'; documents CSV shape in a comment; builds NO parser; keyless).**

  Append this describe block to `packages/providers/test/confluenceSources.test.ts`:
  ```ts
  describe('createAgPaperProvider (manual/stub only — no automation, no parser)', () => {
    it('returns a keyless provider whose fetch => "stub" with NO network call', async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
      const p = createAgPaperProvider()!;
      expect(p).not.toBeNull();
      expect(p.provider).toBe('ag_paper');
      expect(p.snapshotType).toBe('paper_trade');
      expect(p.chains).toEqual(['SOLANA']);
      const r = await p.fetchForToken('SOLANA', 'AddrAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
      expect(r.status).toBe('stub');
      expect(r.status).not.toBe('ok');
      assertNoSafeVerdict(r);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });
  ```

  Also add a source-text guard for the documented CSV shape (a separate `it` in the SAME describe block, reading the file off disk — the design mandates the CSV shape lives in a COMMENT and no parser is built):
  ```ts
  describe('agPaper.ts source-text contract (manual CSV shape documented, NO parser built)', () => {
    it('documents the exact manual CSV column shape in a comment', async () => {
      const { readFileSync } = await import('node:fs');
      const { fileURLToPath } = await import('node:url');
      const { dirname, join } = await import('node:path');
      const here = dirname(fileURLToPath(import.meta.url));
      const src = readFileSync(join(here, '..', 'src', 'confluence', 'agPaper.ts'), 'utf8');
      for (const col of [
        'tokenAddress', 'chain', 'paperEntryAt', 'paperExitAt',
        'paperEntryPrice', 'paperExitPrice', 'paperPnlPct', 'notes'
      ]) {
        expect(src).toContain(col);
      }
    });

    it('builds NO CSV parser (no split/parse/csv machinery in the file)', async () => {
      const { readFileSync } = await import('node:fs');
      const { fileURLToPath } = await import('node:url');
      const { dirname, join } = await import('node:path');
      const here = dirname(fileURLToPath(import.meta.url));
      const src = readFileSync(join(here, '..', 'src', 'confluence', 'agPaper.ts'), 'utf8').toLowerCase();
      // A parser would call .split(',') or a csv lib; none may appear.
      expect(src).not.toContain(".split(','");
      expect(src).not.toContain('.split(",")');
      expect(src).not.toContain('parsecsv');
      expect(src).not.toContain("require('csv");
      expect(src).not.toContain('papaparse');
    });
  });
  ```

- [ ] **Step 25: Run — expect FAIL (`createAgPaperProvider` not exported).**

  ```
  npx vitest run packages/providers/test/confluenceSources.test.ts
  ```
  Expected: FAIL — `createAgPaperProvider is not a function`.

- [ ] **Step 26: Implement `agPaper.ts` (manual/stub only; CSV shape in a comment; NO parser) and export it.**

  Create `packages/providers/src/confluence/agPaper.ts`:
  ```ts
  // FlowRadar — AG Paper Trading observation provider (design doc §Module E).
  // MANUAL / STUB ONLY. Global constraint 9/19: NO automation, NO Telegram
  // button clicking, NO bot control, NO execution, NO private keys, NO scraping,
  // and NO assuming an API exists without docs. There is likely no public API,
  // so this adapter fetches NOTHING and resolves status 'stub'. Keyless (no env).
  //
  // MANUAL IMPORT CSV SHAPE (documentation only — this task builds NO parser and
  // NO importer; any conversion happens OUTSIDE this task, operator-driven):
  //
  //   tokenAddress,chain,paperEntryAt,paperExitAt,paperEntryPrice,paperExitPrice,paperPnlPct,notes
  //
  // where:
  //   tokenAddress   - the token's on-chain address (links by (chain,address), never creates a Token)
  //   chain          - 'SOLANA' (Solana-only in practice; schema stays chain-aware)
  //   paperEntryAt   - ISO-8601 timestamp of the PAPER (not real) entry, or empty
  //   paperExitAt    - ISO-8601 timestamp of the PAPER exit, or empty
  //   paperEntryPrice- decimal price at paper entry, or empty
  //   paperExitPrice - decimal price at paper exit, or empty
  //   paperPnlPct    - percent PnL of the paper observation, or empty
  //   notes          - free-text operator note
  //
  // Paper observations are for COMPARISON against FlowRadar / social / wallet
  // signals only — NEVER treated as real execution. When (later, outside this
  // task) an operator imports such a CSV, each row becomes a TokenConfluenceSnapshot
  // with snapshotType 'paper_trade' (design doc: no dedicated PaperTradeObservation
  // table — reuse the snapshot). This provider itself imports nothing.
  import type { Chain } from '@flowradar/core';
  import type { ConfluenceFetchResult, ConfluenceProvider } from './types';

  export function createAgPaperProvider(): ConfluenceProvider | null {
    return {
      name: 'ag_paper',
      provider: 'ag_paper',
      snapshotType: 'paper_trade',
      chains: ['SOLANA'],
      async fetchForToken(_chain: Chain, _tokenAddress: string): Promise<ConfluenceFetchResult> {
        return {
          status: 'stub',
          dataJson: {
            providerClaimed: false,
            note: 'AG Paper is manual/stub only — no automated fetch. Paper observations are imported by the operator out-of-band and are NOT real execution. Absence is NOT a safe signal.'
          },
          observedAt: new Date(0)
        };
      }
    };
  }
  ```

  Update `packages/providers/src/confluence/index.ts` to add:
  ```ts
  export * from './agPaper';
  ```

- [ ] **Step 27: Run — expect PASS.**

  ```
  npx vitest run packages/providers/test/confluenceSources.test.ts
  ```
  Expected: PASS (AG Paper describe blocks green, including the CSV-shape and no-parser source-text guards).

- [ ] **Step 28: Commit.**

  ```
  git add packages/providers/src/confluence/agPaper.ts packages/providers/src/confluence/index.ts packages/providers/test/confluenceSources.test.ts
  git commit -m "feat(providers): AG Paper manual/stub provider (CSV shape documented in comment, no parser)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

- [ ] **Step 29: Write failing test for `getConfluenceSourceStatuses` (mode mapping + env presence via Boolean only, never the value).**

  Append this describe block to `packages/providers/test/confluenceSources.test.ts`:
  ```ts
  describe('getConfluenceSourceStatuses', () => {
    function fakePrisma(
      rows: { name: string; provider: string; apiKeyEnvName: string | null }[]
    ) {
      return { externalConfluenceSource: { findMany: async () => rows } } as any;
    }
    const ROWS = [
      { name: 'holderscan', provider: 'holderscan', apiKeyEnvName: 'HOLDERSCAN_API_KEY' },
      { name: 'clobr', provider: 'clobr', apiKeyEnvName: 'CLOBR_API_KEY' },
      { name: 'gmgn', provider: 'gmgn', apiKeyEnvName: 'GMGN_API_KEY' },
      { name: 'ag_paper', provider: 'ag_paper', apiKeyEnvName: null }
    ];

    it('MOCK_MODE (default): every row reports mode "mock"', async () => {
      process.env.MOCK_MODE = 'true';
      const statuses = await getConfluenceSourceStatuses(fakePrisma(ROWS));
      expect(statuses).toHaveLength(4);
      expect(statuses.every((s) => s.mode === 'mock')).toBe(true);
      // NAME is echoed, value never is.
      const hs = statuses.find((s) => s.sourceName === 'holderscan')!;
      expect(hs.apiKeyEnvName).toBe('HOLDERSCAN_API_KEY');
    });

    it('live mode: holderscan unkeyed => missing_key; holderscan keyed => plan_required; clobr/gmgn => stub; ag_paper => stub', async () => {
      process.env.MOCK_MODE = 'false';
      delete process.env.HOLDERSCAN_API_KEY;
      delete process.env.CLOBR_API_KEY;
      delete process.env.GMGN_API_KEY;
      const unkeyed = Object.fromEntries(
        (await getConfluenceSourceStatuses(fakePrisma(ROWS))).map((s) => [s.sourceName, s])
      );
      expect(unkeyed['holderscan'].mode).toBe('missing_key');
      expect(unkeyed['clobr'].mode).toBe('stub'); // no confirmed API — stub regardless of key
      expect(unkeyed['gmgn'].mode).toBe('stub');
      expect(unkeyed['ag_paper'].mode).toBe('stub'); // manual, keyless

      process.env.HOLDERSCAN_API_KEY = 'present';
      const keyed = Object.fromEntries(
        (await getConfluenceSourceStatuses(fakePrisma(ROWS))).map((s) => [s.sourceName, s])
      );
      // A key present makes HolderScan plan_required (needs a verified plan), not live.
      expect(keyed['holderscan'].mode).toBe('plan_required');
    });

    it('missing-key note names the env var but NEVER a secret value', async () => {
      process.env.MOCK_MODE = 'false';
      process.env.HOLDERSCAN_API_KEY = 'super-secret-value';
      const rows = await getConfluenceSourceStatuses(
        fakePrisma([{ name: 'holderscan', provider: 'holderscan', apiKeyEnvName: 'HOLDERSCAN_API_KEY' }])
      );
      const note = rows[0].note;
      // env var NAME appears; the resolved secret value must never leak into any field.
      expect(rows[0].apiKeyEnvName).toBe('HOLDERSCAN_API_KEY');
      for (const field of [note, rows[0].apiKeyEnvName ?? '', JSON.stringify(rows[0])]) {
        expect(field).not.toContain('super-secret-value');
      }
    });

    it('no returned row leaks a resolved process.env value in ANY field (secret-free rows)', async () => {
      process.env.MOCK_MODE = 'false';
      process.env.HOLDERSCAN_API_KEY = 'HS-SECRET-XYZ';
      process.env.CLOBR_API_KEY = 'CLOBR-SECRET-XYZ';
      process.env.GMGN_API_KEY = 'GMGN-SECRET-XYZ';
      const rows = await getConfluenceSourceStatuses(fakePrisma(ROWS));
      const blob = JSON.stringify(rows);
      expect(blob).not.toContain('HS-SECRET-XYZ');
      expect(blob).not.toContain('CLOBR-SECRET-XYZ');
      expect(blob).not.toContain('GMGN-SECRET-XYZ');
    });
  });
  ```

- [ ] **Step 30: Run — expect FAIL (`getConfluenceSourceStatuses` not exported).**

  ```
  npx vitest run packages/providers/test/confluenceSources.test.ts
  ```
  Expected: FAIL — `getConfluenceSourceStatuses is not a function`.

- [ ] **Step 31: Implement `sourceStatus.ts` and export it.**

  Create `packages/providers/src/confluence/sourceStatus.ts`:
  ```ts
  // FlowRadar — getConfluenceSourceStatuses: reports the effective mode for every
  // ExternalConfluenceSource ROW in the registry (design doc §Provider status
  // taxonomy). Operator-managed DB rows (like getSocialSourceStatuses), so this
  // reads them from Prisma. Never echoes a secret VALUE — only the configured env
  // var NAME and whether it is PRESENT in process.env (Boolean only; design doc
  // §Security, constraint 13).
  //
  // Mode per source:
  //   - MOCK_MODE (default): every row => 'mock' (all resolve to the shared
  //     MockConfluenceProvider, same one-switch convention as social/candidates).
  //   - live (MOCK_MODE=false), by provider:
  //       * holderscan: keyed  => 'plan_required' (a key alone doesn't make an
  //                               unverified paid plan real — matches the adapter
  //                               stub); unkeyed => 'missing_key'.
  //       * clobr / gmgn:        => 'stub' (no confirmed public API this build,
  //                               regardless of whether a key env var is set).
  //       * ag_paper / manual:   => 'stub' (manual/keyless, no automated reader).
  //       * anything else:       => 'stub' (unknown provider, honest default).
  //   Provider unavailability NEVER maps to a safe/clean/'live' mode from absence.
  import type { ConfluenceSourceMode, ConfluenceSourceStatusRow } from './types';

  /** Minimal shape this function reads — a full PrismaClient satisfies it. */
  export interface ConfluenceSourceStatusClient {
    externalConfluenceSource: {
      findMany(args: {
        select: { name: true; provider: true; apiKeyEnvName: true };
        orderBy: { name: 'asc' };
      }): Promise<{ name: string; provider: string; apiKeyEnvName: string | null }[]>;
    };
  }

  function isMockMode(): boolean {
    return process.env.MOCK_MODE !== 'false';
  }

  export async function getConfluenceSourceStatuses(
    prisma: ConfluenceSourceStatusClient
  ): Promise<ConfluenceSourceStatusRow[]> {
    const sources = await prisma.externalConfluenceSource.findMany({
      select: { name: true, provider: true, apiKeyEnvName: true },
      orderBy: { name: 'asc' }
    });

    const mockMode = isMockMode();

    return sources.map((s): ConfluenceSourceStatusRow => {
      const envName = s.apiKeyEnvName ?? null;

      if (mockMode) {
        return {
          sourceName: s.name,
          provider: s.provider,
          mode: 'mock',
          note: 'MOCK_MODE active — serving deterministic mock confluence.',
          apiKeyEnvName: envName
        };
      }

      // Presence via Boolean ONLY — never read the value into any returned field.
      const hasKey = Boolean(envName && process.env[envName]);

      if (s.provider === 'holderscan') {
        const mode: ConfluenceSourceMode = hasKey ? 'plan_required' : 'missing_key';
        return {
          sourceName: s.name,
          provider: s.provider,
          mode,
          note: hasKey
            ? 'Key present but HolderScan plan/integration not verified — reports plan_required; no data fetched. Absence is NOT a safe signal.'
            : `Missing ${envName ?? 'HOLDERSCAN_API_KEY'}; factory returns null, ingest skips gracefully.`,
          apiKeyEnvName: envName
        };
      }

      if (s.provider === 'clobr' || s.provider === 'gmgn') {
        return {
          sourceName: s.name,
          provider: s.provider,
          mode: 'stub',
          note: 'No confirmed public API — typed stub, no data fetched. See adapter file header TODO(provider). Not integrated is NOT a safe signal.',
          apiKeyEnvName: envName
        };
      }

      // ag_paper / manual / unknown → honest stub.
      return {
        sourceName: s.name,
        provider: s.provider,
        mode: 'stub',
        note: 'Manual/stub source — no automated reader this phase.',
        apiKeyEnvName: envName
      };
    });
  }
  ```

  Update `packages/providers/src/confluence/index.ts` to add:
  ```ts
  export * from './sourceStatus';
  ```

- [ ] **Step 32: Run — expect PASS.**

  ```
  npx vitest run packages/providers/test/confluenceSources.test.ts
  ```
  Expected: PASS (all describe blocks green, including the secret-free-rows and env-name-only assertions).

- [ ] **Step 33: Wire the barrel into the package root and typecheck.**

  Edit `packages/providers/src/index.ts` — add after `export * from './social';`:
  ```ts
  export * from './confluence';
  ```
  Then run the workspace typecheck (catches any `Chain` import / duplicate-export issues; the `@flowradar/core` barrel must stay client-bundle-safe — this task adds no `node:` builtin to any `src/confluence/*.ts` runtime file; `node:fs`/`node:path`/`node:url` appear ONLY in test files, which is allowed):
  ```
  npx tsc -b packages/core packages/providers
  ```
  Expected: exits 0, no errors.

- [ ] **Step 34: Run the full confluence suite + the guard together — expect PASS.**

  ```
  npx vitest run packages/providers/test/confluenceSources.test.ts packages/providers/test/gmgnQueryOnlyGuard.test.ts
  ```
  Expected: PASS, all tests green.

- [ ] **Step 35: Commit.**

  ```
  git add packages/providers/src/confluence/sourceStatus.ts packages/providers/src/confluence/index.ts packages/providers/src/index.ts packages/providers/test/confluenceSources.test.ts
  git commit -m "feat(providers): getConfluenceSourceStatuses + wire confluence barrel into providers index

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

---

**Done Bar:**

- `packages/providers/src/confluence/` contains exactly: `types.ts`, `mockConfluence.ts`, `holderscan.ts`, `clobr.ts`, `gmgn.ts`, `agPaper.ts`, `sourceStatus.ts`, `index.ts`.
- `export * from './confluence';` is present in `packages/providers/src/index.ts` and `npx tsc -b packages/core packages/providers` exits 0.
- `npx vitest run packages/providers/test/confluenceSources.test.ts packages/providers/test/gmgnQueryOnlyGuard.test.ts` passes with zero provider keys set.
- `createHolderScanProvider({})` returns `null`; keyed returns a provider whose `fetchForToken` resolves `plan_required`/`unavailable` (never `ok`), makes no network call, and never emits a safe/clean/verdict key.
- `createClobrProvider`, `createGmgnProvider`, `createAgPaperProvider` each return a non-null provider whose `fetchForToken` resolves `stub` (never `ok`), with no network call; a present key never upgrades them to `ok`.
- `MockConfluenceProvider.fetchForToken('SOLANA', …)` is deterministic `ok` (same address ⇒ byte-identical `dataJson`), labeled `providerClaimed: true`, no safe verdict; non-SOLANA ⇒ `unavailable`.
- The GMGN source file contains zero occurrences (case-insensitive) of `swap`, `order`, `execute`/`execution`, `privatekey`/`private_key`, `walletmanagement`, `signtransaction`, `sendtransaction`.
- `getConfluenceSourceStatuses`: `mock` in MOCK_MODE; live mode maps holderscan→`missing_key`/`plan_required`, clobr/gmgn→`stub`, ag_paper→`stub`; no returned row contains any resolved `process.env` value; `apiKeyEnvName` holds the NAME only.
- All 8 confluence commits landed; no changes outside `packages/providers/**` and `packages/providers/test/**`.

**Reviewer Focus:**

- **`unavailable ≠ safe` (constraint 15):** confirm NO `fetchForToken` path and NO status row ever returns `ok`/`live` or a `safe`/`clean`/`verdict` field when data is absent — every stub/missing/plan path renders honestly. The `assertNoSafeVerdict` helper and the secret-free-rows tests must be non-vacuous.
- **GMGN query-only (constraint 8):** the grep-guard test must be strict and non-vacuous (it asserts `creategmgnprovider` is present). Verify the guard reads the real source file off disk, not the compiled module, and that `gmgn.ts` genuinely contains none of the forbidden substrings in code OR comments.
- **No hallucinated endpoints:** none of `holderscan.ts`/`clobr.ts`/`gmgn.ts`/`agPaper.ts` performs a `fetch()` or references a concrete provider URL/host; all `fetchSpy` assertions confirm zero network calls.
- **Secret safety (constraint 13):** `getConfluenceSourceStatuses` derives key presence via `Boolean(process.env[name])` only; no returned field carries a resolved value. Scrutinize the two secret-leak tests.
- **AG Paper manual/stub only (constraint 9/19):** `agPaper.ts` documents the CSV shape in a COMMENT and builds NO parser (no `.split(',')`, no csv lib) — the source-text guards enforce this; confirm they'd fail if a parser were added.
- **Client-bundle safety:** no `node:` builtin imported by any `src/confluence/*.ts` runtime file (only test files use `node:fs`/`node:path`/`node:url`); the `MockConfluenceProvider` hash is a pure inline function, not a `node:crypto` call.

---

### Task D: externalConfluence worker + reusable pass + seed

**Files:**
- **Create** `packages/db/src/confluence/ingest.ts` — `runExternalConfluencePass` (reusable pass body; internal LiquidityRisk snapshot from latest `TokenMarketSnapshot` + external per-source fetch for known tokens only).
- **Modify** `packages/db/src/index.ts` — add `export * from './confluence/ingest';` (barrel).
- **Create** `apps/worker/src/jobs/externalConfluence.ts` — thin `run(ctx)` wrapper (mock/live/null-skip `resolveProvider`, mirrors `socialIngest.ts`).
- **Modify** `apps/worker/src/index.ts` — import + register `externalConfluence` on `settings.connectors.externalConfluence.syncHours * 3600` (additive, alongside `socialIngest`).
- **Modify** `packages/db/src/seed.ts` — Phase 3.8: seed 1-2 `ExternalConfluenceSource` example rows additively (both disabled — no key required).
- **Test** `packages/db/test/externalConfluence.test.ts` — DB integration (probePort 5439): internal LiquidityRisk snapshot from market data, external missing-key skip, disabled-source skip, never-creates-Token, idempotent, unavailable-not-safe, per-source/per-token try/catch.

**Interfaces — Consumes (exact signatures from Tasks A/B/C):**
- From `@flowradar/core` (Task A): `computeLiquidityRisk(input: LiquidityRiskInput, cfg: LiquidityRiskConfig): LiquidityRiskResult`; `type Settings` with `settings.connectors.externalConfluence = { syncHours: number; liquidityRisk: { positionSizeUsd: number; absoluteLiquidityBandsUsd: [number, number, number]; ratioFragilityBands: [number, number, number] } }`; `type Chain`.
- From `@flowradar/providers` (Task C): `interface ConfluenceProvider { name: string; provider: string; snapshotType: string; chains: Chain[]; fetchForToken(chain: Chain, tokenAddress: string): Promise<ConfluenceFetchResult> }`; `interface ConfluenceFetchResult { status: "ok"|"unavailable"|"missing_key"|"plan_required"|"rate_limited"|"error"|"stub"; dataJson: Record<string, unknown>; observedAt: Date }`. (Live/mock/null resolution is decided by the CALLER; this pass only consumes `ConfluenceProvider | null`.)
- From `@prisma/client` (Task B): models `ExternalConfluenceSource`, `TokenConfluenceSnapshot` (`@@unique([sourceId, tokenAddress, snapshotType, dedupeKey])`), `TokenMarketSnapshot` (`marketCapUsd`/`liquidityUsd` `Decimal`), `Token` (`@@unique chain_address`).

**Interfaces — Produces (exact names later tasks rely on):**
- `runExternalConfluencePass(prisma: PrismaClient, settings: Settings, resolveProvider: ConfluenceSourceResolver, log?: ConfluenceIngestLogger): Promise<ExternalConfluencePassResult>` — reused verbatim by the worker job AND `seed.ts` (same pattern as `runSocialIngestPass`).
- `type ConfluenceSourceResolver = (source: ExternalConfluenceSourceRow) => ConfluenceProvider | null | undefined;`
- `interface ExternalConfluenceSourceRow { id: string; name: string; provider: string; enabled: boolean; apiKeyEnvName: string | null }`.
- `interface ExternalConfluencePassResult { sourcesConsidered: number; sourcesSynced: number; sourcesSkippedDisabled: number; sourcesSkippedNoProvider: number; internalLiquiditySnapshots: number; externalSnapshotsUpserted: number; tokensConsidered: number; errors: number }`.
- `interface ConfluenceIngestLogger { info(message: string, meta?: Record<string, unknown>): void; error(message: string, meta?: Record<string, unknown>): void }`.
- Worker module `apps/worker/src/jobs/externalConfluence.ts` exporting `run(ctx: JobContext): Promise<void>`.

---

- [ ] **Step 1: Write failing test — internal LiquidityRisk snapshot is created from the latest TokenMarketSnapshot.**
  Create `packages/db/test/externalConfluence.test.ts` with the shared `probePort`/prefix-cleanup/serialized-DB harness (copied verbatim from `socialIngest.test.ts` lines 22-65, adapted table names), then the first `describe.skipIf` block + this test. This is REAL code — it will FAIL because `packages/db/src/confluence/ingest.ts` does not exist yet (import error).

  ```ts
  // FlowRadar — runExternalConfluencePass integration tests (Task D, External
  // Confluence). Same LITE-Postgres integration pattern as
  // socialIngest.test.ts (probePort skipIf, prefix-cleanup, serialized).
  //
  // SHADOW-ONLY (design doc global rules 1-6/15/16): this pass READS the latest
  // TokenMarketSnapshot + enabled ExternalConfluenceSource rows and WRITES only
  // TokenConfluenceSnapshot rows. It NEVER creates a Token/Signal/Alert/
  // CandidateWallet, never touches FlowScore, and never renders absence as safe.
  import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
  import net from 'node:net';
  import { DEFAULT_SETTINGS } from '@flowradar/core';
  import type { Chain } from '@flowradar/core';
  import type { ConfluenceProvider, ConfluenceFetchResult } from '@flowradar/providers';
  import { prisma } from '../src/client';
  import { runExternalConfluencePass } from '../src/confluence/ingest';

  const SOURCE_PREFIX = 'T_D_confSource';
  const ADDR_PREFIX = 'TDconfAddr';

  function probePort(host: string, port: number, timeoutMs = 1000): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = net.createConnection({ host, port });
      const done = (ok: boolean) => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(ok);
      };
      socket.setTimeout(timeoutMs);
      socket.once('connect', () => done(true));
      socket.once('timeout', () => done(false));
      socket.once('error', () => done(false));
    });
  }

  let dbReachable = false;

  beforeAll(async () => {
    dbReachable = await probePort('localhost', 5439);
    if (!dbReachable) {
      // eslint-disable-next-line no-console
      console.warn(
        '[externalConfluence.test] LITE Postgres not reachable on localhost:5439 — skipping ' +
          'integration tests. Run `npm run db:migrate` first to exercise this suite.'
      );
    }
  });

  async function cleanup(): Promise<void> {
    await prisma.tokenConfluenceSnapshot.deleteMany({ where: { tokenAddress: { startsWith: ADDR_PREFIX } } });
    await prisma.externalConfluenceSource.deleteMany({ where: { name: { startsWith: SOURCE_PREFIX } } });
    await prisma.token.deleteMany({ where: { address: { startsWith: ADDR_PREFIX } } });
  }

  afterAll(async () => {
    if (!dbReachable) return;
    await cleanup();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    if (!dbReachable) return;
    await cleanup();
  });

  /** Explicit fake provider — deterministic single-result fetch, records per-token call args. */
  function makeFakeConfluenceProvider(
    result: ConfluenceFetchResult,
    opts: { provider?: string; snapshotType?: string; name?: string } = {}
  ): ConfluenceProvider & { calls: Array<{ chain: Chain; tokenAddress: string }> } {
    return {
      name: opts.name ?? 'fake-confluence',
      provider: opts.provider ?? 'holderscan',
      snapshotType: opts.snapshotType ?? 'holder_risk',
      chains: ['SOLANA'],
      calls: [],
      async fetchForToken(chain: Chain, tokenAddress: string): Promise<ConfluenceFetchResult> {
        this.calls.push({ chain, tokenAddress });
        return result;
      }
    };
  }

  async function makeSourceRow(
    name: string,
    overrides: Partial<{ enabled: boolean; provider: string; apiKeyEnvName: string | null }> = {}
  ) {
    return prisma.externalConfluenceSource.create({
      data: {
        name,
        provider: overrides.provider ?? 'holderscan',
        enabled: overrides.enabled ?? true,
        apiKeyEnvName: overrides.apiKeyEnvName ?? 'HOLDERSCAN_API_KEY',
        rateLimitPerMinute: 30
      }
    });
  }

  /** Creates a Token + one latest TokenMarketSnapshot with the given liquidity/mcap so LiquidityRisk has real inputs. */
  async function makeTokenWithMarket(
    address: string,
    market: { liquidityUsd: number; marketCapUsd: number }
  ): Promise<string> {
    const token = await prisma.token.create({
      data: {
        chain: 'SOLANA',
        address,
        symbol: 'TDCONF',
        name: 'Task D Confluence Token',
        decimals: 9,
        firstSeenAt: new Date(),
        riskFlags: []
      }
    });
    await prisma.tokenMarketSnapshot.create({
      data: {
        tokenId: token.id,
        ts: new Date(),
        priceUsd: 0.001,
        marketCapUsd: market.marketCapUsd,
        fdvUsd: market.marketCapUsd,
        liquidityUsd: market.liquidityUsd,
        vol5m: 0,
        vol1h: 0,
        vol6h: 0,
        vol24h: 0
      }
    });
    return token.id;
  }

  describe.skipIf(!(await probePort('localhost', 5439)))('runExternalConfluencePass', () => {
    it('computes an internal LiquidityRisk snapshot from the latest TokenMarketSnapshot', async () => {
      const address = `${ADDR_PREFIX}1111111111111111111111111111`;
      const tokenId = await makeTokenWithMarket(address, { liquidityUsd: 40000, marketCapUsd: 1_000_000 });

      // No enabled sources — only the INTERNAL LiquidityRisk leg runs.
      const result = await runExternalConfluencePass(prisma, DEFAULT_SETTINGS, () => null);

      expect(result.errors).toBe(0);
      expect(result.internalLiquiditySnapshots).toBeGreaterThanOrEqual(1);

      const snap = await prisma.tokenConfluenceSnapshot.findFirst({
        where: { tokenAddress: address, provider: 'internal', snapshotType: 'liquidity_risk' }
      });
      expect(snap).not.toBeNull();
      expect(snap!.sourceId).toBeNull();
      expect(snap!.tokenId).toBe(tokenId);
      expect(snap!.chain).toBe('SOLANA');
      expect(snap!.status).toBe('ok');
      // ratio = L/MC = 40000 / 1_000_000 = 0.04
      const data = snap!.dataJson as Record<string, unknown>;
      expect(data.liquidityToMcapRatio).toBeCloseTo(0.04, 6);
      // Band from DEFAULT_SETTINGS.ratioFragilityBands [0.02,0.05,0.15]: 0.04 -> "fragile".
      expect(data.ratioFragilityBand).toBe('fragile');
      // absoluteLiquidityBand from [10000,50000,250000]: 40000 -> "thin".
      expect(data.absoluteLiquidityBand).toBe('thin');
    });
  });
  ```

- [ ] **Step 2: Run the test — expect FAIL (module not found).**
  `npx vitest run packages/db/test/externalConfluence.test.ts`
  Expected: FAIL — `Failed to resolve import "../src/confluence/ingest"` (or `runExternalConfluencePass is not a function`). This confirms the test drives real, not-yet-existing code.

- [ ] **Step 3: Minimal impl — create `packages/db/src/confluence/ingest.ts` with the internal LiquidityRisk leg only.**
  Write the reusable pass. This step implements ONLY the internal leg (external loop is a no-op stub returning early per source) so the Step-1 test passes; the external loop is fleshed out in Step 6. REAL, complete code:

  ```ts
  // FlowRadar — runExternalConfluencePass: the External Confluence ingest body
  // (Task D). Same worker/seed-sharing pattern as runSocialIngestPass /
  // runExternalWalletSourceSync — apps/worker/src/jobs/externalConfluence.ts is
  // a thin wrapper around this function, and seed.ts calls it directly.
  //
  // SHADOW-ONLY (design doc global rules 1-16). Two legs, both write ONLY
  // TokenConfluenceSnapshot rows:
  //   (1) INTERNAL LiquidityRisk: for every Token that has a latest
  //       TokenMarketSnapshot (liquidityUsd + marketCapUsd), compute
  //       computeLiquidityRisk() and upsert one provider="internal",
  //       snapshotType="liquidity_risk", sourceId=null snapshot. No provider,
  //       no key, deterministic.
  //   (2) EXTERNAL providers: for each ENABLED ExternalConfluenceSource, resolve
  //       a ConfluenceProvider (mock / live factory / null => skip). Fetch ONLY
  //       for tokens ALREADY IN THE DB — never discover-and-create a Token. The
  //       returned ConfluenceFetchResult.status (ok | unavailable | missing_key
  //       | plan_required | rate_limited | error | stub) is stored VERBATIM on
  //       the snapshot; absence of data is stored as its honest status, NEVER as
  //       a fabricated "ok"/"safe" (global rule 15). dataJson is stored as-is
  //       (Task C guarantees it is secret-free; this pass adds no secrets).
  //
  // HARD CONSTRAINTS this body enforces:
  //   - NEVER creates Token/Signal/Alert/CandidateWallet rows (only reads Token,
  //     only writes TokenConfluenceSnapshot).
  //   - NEVER touches FlowScore / signal thresholds / wallet scoring.
  //   - Per-SOURCE try/catch: a source's resolve/fetch throwing marks THAT
  //     source status='error'/lastError/failCount++ and continues the pass.
  //   - Per-TOKEN try/catch inside a source: one token's fetch throwing is
  //     logged + counted and NEVER aborts sibling tokens (nor marks the source
  //     'error' — the source itself resolved fine).
  //   - missing_key / plan_required / stub / unavailable are CLEAN skips at the
  //     result level AND recorded: the source's own status is updated to that
  //     value, and (for every targeted known token) a snapshot carrying that
  //     status is upserted.

  import type { Prisma, PrismaClient } from '@prisma/client';
  import type { Chain, Settings } from '@flowradar/core';
  import { computeLiquidityRisk } from '@flowradar/core';
  import type { ConfluenceProvider } from '@flowradar/providers';

  export interface ConfluenceIngestLogger {
    info(message: string, meta?: Record<string, unknown>): void;
    error(message: string, meta?: Record<string, unknown>): void;
  }

  /** Row shape this module needs from ExternalConfluenceSource — narrower than the full Prisma model. */
  export interface ExternalConfluenceSourceRow {
    id: string;
    name: string;
    provider: string;
    enabled: boolean;
    apiKeyEnvName: string | null;
  }

  /**
   * Resolves a ConfluenceProvider for a given ExternalConfluenceSource row.
   * Returns null/undefined (OR throws) to signal "no reader for this source" —
   * all handled gracefully (mirrors SocialSourceResolver). The CALLER decides
   * mock-vs-live-vs-null: MOCK_MODE => shared MockConfluenceProvider for every
   * source; live => per-provider factory (null when the apiKeyEnvName env value
   * is absent, i.e. missing_key/stub/plan_required). A null return is a clean
   * per-source skip, never a crash.
   */
  export type ConfluenceSourceResolver = (
    source: ExternalConfluenceSourceRow
  ) => ConfluenceProvider | null | undefined;

  export interface ExternalConfluencePassResult {
    sourcesConsidered: number;
    sourcesSynced: number;
    sourcesSkippedDisabled: number;
    sourcesSkippedNoProvider: number;
    internalLiquiditySnapshots: number;
    externalSnapshotsUpserted: number;
    tokensConsidered: number;
    errors: number;
  }

  const VALID_CHAINS: Chain[] = ['SOLANA', 'BSC'];

  /** Hour bucket for dedupeKey — one snapshot per (provider,type,address) per wall-clock hour (idempotent re-runs inside the hour). */
  function hourBucket(d: Date): string {
    return `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}-${d.getUTCHours()}`;
  }

  /** dedupeKey per design doc: `${provider}:${snapshotType}:${tokenAddress}:${observedHourBucket}`. */
  function buildDedupeKey(provider: string, snapshotType: string, tokenAddress: string, observedAt: Date): string {
    return `${provider}:${snapshotType}:${tokenAddress}:${hourBucket(observedAt)}`;
  }

  /** All Tokens that have >=1 TokenMarketSnapshot, each paired with its LATEST snapshot's liquidity/mcap. */
  interface KnownToken {
    tokenId: string;
    chain: Chain;
    address: string;
  }

  export async function runExternalConfluencePass(
    prisma: PrismaClient,
    settings: Settings,
    resolveProvider: ConfluenceSourceResolver,
    log?: ConfluenceIngestLogger
  ): Promise<ExternalConfluencePassResult> {
    const cfg = settings.connectors.externalConfluence.liquidityRisk;

    let internalLiquiditySnapshots = 0;
    let externalSnapshotsUpserted = 0;
    let sourcesSynced = 0;
    let sourcesSkippedDisabled = 0;
    let sourcesSkippedNoProvider = 0;
    let errors = 0;

    // Known tokens = every Token row. External providers fetch ONLY for these
    // (never discover-and-create). LiquidityRisk runs for the subset that has a
    // latest TokenMarketSnapshot.
    const tokens = await prisma.token.findMany({ select: { id: true, chain: true, address: true } });
    const knownTokens: KnownToken[] = tokens.map((t) => ({ tokenId: t.id, chain: t.chain as Chain, address: t.address }));

    // -----------------------------------------------------------------------
    // Leg 1: INTERNAL LiquidityRisk (no provider, no key). Per-token try/catch
    // so one token's bad market row never aborts the internal leg.
    // -----------------------------------------------------------------------
    for (const token of knownTokens) {
      try {
        const latest = await prisma.tokenMarketSnapshot.findFirst({
          where: { tokenId: token.tokenId },
          orderBy: [{ ts: 'desc' }, { id: 'desc' }],
          select: { liquidityUsd: true, marketCapUsd: true, ts: true }
        });
        if (!latest) continue; // no market data yet — no internal snapshot (NOT an error)

        const displayedLiquidityUsd = Number(latest.liquidityUsd);
        const marketCapUsd = Number(latest.marketCapUsd);

        const risk = computeLiquidityRisk(
          {
            displayedLiquidityUsd,
            marketCapUsd,
            positionSizeUsd: cfg.positionSizeUsd,
            poolType: 'unknown'
          },
          {
            absoluteLiquidityBandsUsd: cfg.absoluteLiquidityBandsUsd,
            ratioFragilityBands: cfg.ratioFragilityBands
          }
        );

        const observedAt = latest.ts;
        const dataJson = {
          ...risk,
          inputs: { displayedLiquidityUsd, marketCapUsd, positionSizeUsd: cfg.positionSizeUsd },
          computedBy: 'internal',
          providerClaimed: false
        } as unknown as Prisma.InputJsonValue;

        const dedupeKey = buildDedupeKey('internal', 'liquidity_risk', token.address, observedAt);

        await prisma.tokenConfluenceSnapshot.upsert({
          where: {
            sourceId_tokenAddress_snapshotType_dedupeKey: {
              sourceId: null,
              tokenAddress: token.address,
              snapshotType: 'liquidity_risk',
              dedupeKey
            }
          },
          create: {
            tokenId: token.tokenId,
            chain: token.chain,
            tokenAddress: token.address,
            sourceId: null,
            provider: 'internal',
            snapshotType: 'liquidity_risk',
            status: 'ok',
            dataJson,
            observedAt,
            dedupeKey
          },
          update: {
            tokenId: token.tokenId,
            status: 'ok',
            dataJson,
            observedAt
          }
        });
        internalLiquiditySnapshots += 1;
      } catch (err) {
        errors += 1;
        const message = err instanceof Error ? err.message : String(err);
        log?.error('externalConfluence: internal LiquidityRisk error (token skipped)', {
          tokenAddress: token.address,
          error: message
        });
      }
    }

    // -----------------------------------------------------------------------
    // Leg 2: EXTERNAL providers. (Fleshed out in Step 6 — placeholder here so
    // the internal leg compiles and passes first.)
    // -----------------------------------------------------------------------
    const sources = await prisma.externalConfluenceSource.findMany();

    const summary: ExternalConfluencePassResult = {
      sourcesConsidered: sources.length,
      sourcesSynced,
      sourcesSkippedDisabled,
      sourcesSkippedNoProvider,
      internalLiquiditySnapshots,
      externalSnapshotsUpserted,
      tokensConsidered: knownTokens.length,
      errors
    };
    log?.info('externalConfluence cycle complete', { ...summary });
    return summary;
  }
  ```

  Then add the barrel export to `packages/db/src/index.ts` immediately after line 13 (`export * from './social/ingest';`):
  ```ts
  export * from './confluence/ingest';
  ```

- [ ] **Step 4: Run the test — expect PASS.**
  `npx vitest run packages/db/test/externalConfluence.test.ts`
  Expected: PASS (1 test). Internal LiquidityRisk snapshot created with `provider="internal"`, `sourceId=null`, correct `ratio`/bands.

- [ ] **Step 5: Commit.**
  ```
  git add packages/db/src/confluence/ingest.ts packages/db/src/index.ts packages/db/test/externalConfluence.test.ts
  git commit -m "feat(confluence): runExternalConfluencePass internal LiquidityRisk leg (Task D)

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

- [ ] **Step 6: Write failing tests — external leg (ok upsert / provider-claimed label / missing-key skip / unavailable-not-safe / disabled skip / never-creates-Token / idempotent / per-source + per-token try/catch).**
  Append these tests inside the existing `describe.skipIf(...)('runExternalConfluencePass', ...)` block. REAL code — they FAIL now because the external leg is still a no-op placeholder (`sourcesSynced`/`externalSnapshotsUpserted` stay 0, no external snapshot rows).

  ```ts
    it('enabled source with a resolved provider upserts an external snapshot for a KNOWN token (status stored verbatim, provider-claimed)', async () => {
      const address = `${ADDR_PREFIX}2222222222222222222222222222`;
      await makeTokenWithMarket(address, { liquidityUsd: 60000, marketCapUsd: 500_000 });
      const sourceName = `${SOURCE_PREFIX}_ok`;
      await makeSourceRow(sourceName, { provider: 'holderscan' });

      const provider = makeFakeConfluenceProvider(
        { status: 'ok', dataJson: { holderCount: 1234, providerClaimed: true }, observedAt: new Date() },
        { provider: 'holderscan', snapshotType: 'holder_risk', name: sourceName }
      );

      const result = await runExternalConfluencePass(prisma, DEFAULT_SETTINGS, (s) =>
        s.name === sourceName ? provider : null
      );

      expect(result.errors).toBe(0);
      expect(result.sourcesSynced).toBeGreaterThanOrEqual(1);
      expect(result.externalSnapshotsUpserted).toBeGreaterThanOrEqual(1);
      // Fetch was targeted at the KNOWN token's real address, on its chain.
      expect(provider.calls.some((c) => c.tokenAddress === address && c.chain === 'SOLANA')).toBe(true);

      const snap = await prisma.tokenConfluenceSnapshot.findFirst({
        where: { tokenAddress: address, provider: 'holderscan', snapshotType: 'holder_risk' }
      });
      expect(snap).not.toBeNull();
      expect(snap!.status).toBe('ok');
      expect(snap!.sourceId).not.toBeNull();
      const data = snap!.dataJson as Record<string, unknown>;
      expect(data.holderCount).toBe(1234);
      // Provider-claimed labeling (global rule 16): external data carries the flag.
      expect(data.providerClaimed).toBe(true);

      const sourceRow = await prisma.externalConfluenceSource.findUnique({ where: { name: sourceName } });
      expect(sourceRow?.status).toBe('live');
      expect(sourceRow?.lastSyncAt).not.toBeNull();
      expect(sourceRow?.failCount).toBe(0);
    });

    it('missing_key result is a clean skip: source status="missing_key", snapshot stored with that status, NEVER "ok"/"safe"', async () => {
      const address = `${ADDR_PREFIX}3333333333333333333333333333`;
      await makeTokenWithMarket(address, { liquidityUsd: 5000, marketCapUsd: 800_000 });
      const sourceName = `${SOURCE_PREFIX}_missingkey`;
      await makeSourceRow(sourceName, { provider: 'holderscan' });

      // The RESOLVED provider itself returns missing_key (Task C: adapter present
      // but env key absent -> fetch reports missing_key rather than fabricating data).
      const provider = makeFakeConfluenceProvider(
        { status: 'missing_key', dataJson: {}, observedAt: new Date() },
        { provider: 'holderscan', snapshotType: 'holder_risk', name: sourceName }
      );

      const result = await runExternalConfluencePass(prisma, DEFAULT_SETTINGS, (s) =>
        s.name === sourceName ? provider : null
      );

      expect(result.errors).toBe(0);
      const snap = await prisma.tokenConfluenceSnapshot.findFirst({
        where: { tokenAddress: address, provider: 'holderscan', snapshotType: 'holder_risk' }
      });
      expect(snap).not.toBeNull();
      expect(snap!.status).toBe('missing_key'); // honest, NOT "ok"
      expect(snap!.status).not.toBe('ok');
      expect(snap!.status).not.toBe('safe'); // no such status exists — absence is never green
      const sourceRow = await prisma.externalConfluenceSource.findUnique({ where: { name: sourceName } });
      expect(sourceRow?.status).toBe('missing_key');
    });

    it('resolver returning null (adapter unavailable / manual provider) is a graceful per-source skip, no external snapshot', async () => {
      const address = `${ADDR_PREFIX}4444444444444444444444444444`;
      await makeTokenWithMarket(address, { liquidityUsd: 20000, marketCapUsd: 400_000 });
      const sourceName = `${SOURCE_PREFIX}_noprovider`;
      await makeSourceRow(sourceName, { provider: 'ag_paper', apiKeyEnvName: null });

      const result = await runExternalConfluencePass(prisma, DEFAULT_SETTINGS, () => null);

      expect(result.errors).toBe(0);
      expect(result.sourcesSkippedNoProvider).toBeGreaterThanOrEqual(1);
      // The internal LiquidityRisk snapshot still exists; NO ag_paper snapshot does.
      const ext = await prisma.tokenConfluenceSnapshot.findFirst({
        where: { tokenAddress: address, provider: 'ag_paper' }
      });
      expect(ext).toBeNull();
    });

    it('unavailable result stores an "unavailable" snapshot — never a reassuring/clean verdict (global rule 15)', async () => {
      const address = `${ADDR_PREFIX}5555555555555555555555555555`;
      await makeTokenWithMarket(address, { liquidityUsd: 15000, marketCapUsd: 300_000 });
      const sourceName = `${SOURCE_PREFIX}_unavail`;
      await makeSourceRow(sourceName, { provider: 'gmgn' });

      const provider = makeFakeConfluenceProvider(
        { status: 'unavailable', dataJson: {}, observedAt: new Date() },
        { provider: 'gmgn', snapshotType: 'external_intel', name: sourceName }
      );

      const result = await runExternalConfluencePass(prisma, DEFAULT_SETTINGS, (s) =>
        s.name === sourceName ? provider : null
      );
      expect(result.errors).toBe(0);

      const snap = await prisma.tokenConfluenceSnapshot.findFirst({
        where: { tokenAddress: address, provider: 'gmgn', snapshotType: 'external_intel' }
      });
      expect(snap).not.toBeNull();
      expect(snap!.status).toBe('unavailable');
      const sourceRow = await prisma.externalConfluenceSource.findUnique({ where: { name: sourceName } });
      expect(sourceRow?.status).toBe('unavailable');
    });

    it('disabled source is skipped entirely — provider never called, no external snapshot', async () => {
      const address = `${ADDR_PREFIX}6666666666666666666666666666`;
      await makeTokenWithMarket(address, { liquidityUsd: 30000, marketCapUsd: 600_000 });
      const sourceName = `${SOURCE_PREFIX}_disabled`;
      await makeSourceRow(sourceName, { enabled: false });

      const provider = makeFakeConfluenceProvider(
        { status: 'ok', dataJson: { holderCount: 1 }, observedAt: new Date() },
        { name: sourceName }
      );

      const result = await runExternalConfluencePass(prisma, DEFAULT_SETTINGS, (s) =>
        s.name === sourceName ? provider : null
      );

      expect(result.sourcesSkippedDisabled).toBeGreaterThanOrEqual(1);
      expect(provider.calls).toHaveLength(0);
      const rows = await prisma.tokenConfluenceSnapshot.findMany({
        where: { tokenAddress: address, provider: 'holderscan' }
      });
      expect(rows).toHaveLength(0);
    });

    it('NEVER creates a Token: a source that could fetch does not add a Token row (external providers are read-only w.r.t. Token)', async () => {
      // No Token/market exists at this address at all.
      const unknownAddress = `${ADDR_PREFIX}7777777777777777777777777777`;
      const sourceName = `${SOURCE_PREFIX}_notoken`;
      await makeSourceRow(sourceName, { provider: 'holderscan' });

      const provider = makeFakeConfluenceProvider(
        { status: 'ok', dataJson: { holderCount: 99 }, observedAt: new Date() },
        { name: sourceName }
      );

      const tokensBefore = await prisma.token.count();
      const result = await runExternalConfluencePass(prisma, DEFAULT_SETTINGS, (s) =>
        s.name === sourceName ? provider : null
      );
      const tokensAfter = await prisma.token.count();

      expect(result.errors).toBe(0);
      expect(tokensAfter).toBe(tokensBefore); // no Token created
      // The provider was never asked to fetch a non-existent token (known-tokens-only).
      expect(provider.calls.some((c) => c.tokenAddress === unknownAddress)).toBe(false);
      // And no snapshot was written for the phantom address.
      const phantom = await prisma.tokenConfluenceSnapshot.findFirst({ where: { tokenAddress: unknownAddress } });
      expect(phantom).toBeNull();
    });

    it('re-run (same hour, same token+source) is idempotent — 0 net new external rows, upsert not insert', async () => {
      const address = `${ADDR_PREFIX}8888888888888888888888888888`;
      await makeTokenWithMarket(address, { liquidityUsd: 45000, marketCapUsd: 900_000 });
      const sourceName = `${SOURCE_PREFIX}_idem`;
      const source = await makeSourceRow(sourceName, { provider: 'holderscan' });

      const provider = makeFakeConfluenceProvider(
        { status: 'ok', dataJson: { holderCount: 7 }, observedAt: new Date() },
        { name: sourceName }
      );
      const resolver = (s: ExternalConfluenceSourceRowLike) => (s.name === sourceName ? provider : null);

      await runExternalConfluencePass(prisma, DEFAULT_SETTINGS, resolver as never);
      await runExternalConfluencePass(prisma, DEFAULT_SETTINGS, resolver as never);

      const extRows = await prisma.tokenConfluenceSnapshot.findMany({
        where: { sourceId: source.id, tokenAddress: address, snapshotType: 'holder_risk' }
      });
      expect(extRows).toHaveLength(1); // deduped on [sourceId, tokenAddress, snapshotType, dedupeKey]

      const internalRows = await prisma.tokenConfluenceSnapshot.findMany({
        where: { tokenAddress: address, provider: 'internal', snapshotType: 'liquidity_risk' }
      });
      expect(internalRows).toHaveLength(1); // internal leg is idempotent too
    });

    it('one source throwing never aborts other enabled sources (per-source try/catch)', async () => {
      const address = `${ADDR_PREFIX}9999999999999999999999999999`;
      await makeTokenWithMarket(address, { liquidityUsd: 25000, marketCapUsd: 500_000 });
      const goodName = `${SOURCE_PREFIX}_good`;
      const badName = `${SOURCE_PREFIX}_bad`;
      await makeSourceRow(goodName, { provider: 'holderscan' });
      await makeSourceRow(badName, { provider: 'gmgn' });

      const goodProvider = makeFakeConfluenceProvider(
        { status: 'ok', dataJson: { holderCount: 42 }, observedAt: new Date() },
        { provider: 'holderscan', snapshotType: 'holder_risk', name: goodName }
      );
      const badProvider: ConfluenceProvider = {
        name: badName,
        provider: 'gmgn',
        snapshotType: 'external_intel',
        chains: ['SOLANA'],
        async fetchForToken() {
          throw new Error('simulated confluence provider failure');
        }
      };

      const result = await runExternalConfluencePass(prisma, DEFAULT_SETTINGS, (s) =>
        s.name === goodName ? goodProvider : badProvider
      );

      expect(result.errors).toBeGreaterThanOrEqual(1);
      const goodSnap = await prisma.tokenConfluenceSnapshot.findFirst({
        where: { tokenAddress: address, provider: 'holderscan', snapshotType: 'holder_risk' }
      });
      expect(goodSnap).not.toBeNull();

      const badRow = await prisma.externalConfluenceSource.findUnique({ where: { name: badName } });
      expect(badRow?.status).toBe('error');
      expect(badRow?.lastError).toContain('simulated confluence provider failure');
      expect(badRow?.failCount).toBeGreaterThanOrEqual(1);

      const goodRow = await prisma.externalConfluenceSource.findUnique({ where: { name: goodName } });
      expect(goodRow?.status).toBe('live');
    });

    it('one token throwing never aborts sibling tokens in the same source (per-token try/catch); source stays live', async () => {
      const okAddr = `${ADDR_PREFIX}aaaaaaaaaaaaaaaaaaaaaaaaaaaa`;
      const badAddr = `${ADDR_PREFIX}bbbbbbbbbbbbbbbbbbbbbbbbbbbb`;
      await makeTokenWithMarket(okAddr, { liquidityUsd: 33000, marketCapUsd: 700_000 });
      await makeTokenWithMarket(badAddr, { liquidityUsd: 33000, marketCapUsd: 700_000 });
      const sourceName = `${SOURCE_PREFIX}_pertoken`;
      await makeSourceRow(sourceName, { provider: 'holderscan' });

      // Provider throws for exactly one target token, returns ok for the other.
      const provider: ConfluenceProvider = {
        name: sourceName,
        provider: 'holderscan',
        snapshotType: 'holder_risk',
        chains: ['SOLANA'],
        async fetchForToken(_chain: Chain, tokenAddress: string) {
          if (tokenAddress === badAddr) throw new Error('per-token fetch boom');
          return { status: 'ok', dataJson: { holderCount: 5 }, observedAt: new Date() } as ConfluenceFetchResult;
        }
      };

      const result = await runExternalConfluencePass(prisma, DEFAULT_SETTINGS, (s) =>
        s.name === sourceName ? provider : null
      );

      // The good token still got its snapshot even though a sibling threw.
      const ok = await prisma.tokenConfluenceSnapshot.findFirst({
        where: { tokenAddress: okAddr, provider: 'holderscan', snapshotType: 'holder_risk' }
      });
      expect(ok).not.toBeNull();
      // A per-TOKEN failure does NOT mark the SOURCE 'error' (it resolved + fetched fine for siblings).
      const sourceRow = await prisma.externalConfluenceSource.findUnique({ where: { name: sourceName } });
      expect(sourceRow?.status).toBe('live');
      expect(result.errors).toBeGreaterThanOrEqual(1);
    });
  ```

  Add this type-alias helper near the top of the file (after `makeFakeConfluenceProvider`) so the idempotent test's resolver typechecks without importing the internal row type:
  ```ts
  type ExternalConfluenceSourceRowLike = { id: string; name: string; provider: string; enabled: boolean; apiKeyEnvName: string | null };
  ```
  And extend the top imports to also bring in `ConfluenceFetchResult` (already imported in Step 1's `import type` line — confirm it is present).

- [ ] **Step 7: Run the tests — expect FAIL.**
  `npx vitest run packages/db/test/externalConfluence.test.ts`
  Expected: the internal test still PASSES; the 9 external-leg tests FAIL (e.g. `sourcesSynced` is 0, no external snapshot rows, source status never set). Confirms the placeholder leg is exercised by real assertions.

- [ ] **Step 8: Minimal impl — flesh out the external leg in `runExternalConfluencePass`.**
  Replace the Leg-2 placeholder (the `const sources = await prisma.externalConfluenceSource.findMany();` line and everything down to the `summary` object) with the full external loop. REAL, complete code:

  ```ts
    // -----------------------------------------------------------------------
    // Leg 2: EXTERNAL providers. Per-SOURCE try/catch (resolve/fetch throwing
    // marks THAT source 'error' + continue). Inside a synced source, per-TOKEN
    // try/catch (one token throwing never aborts siblings, never marks the
    // source 'error'). Fetch ONLY known tokens on chains the provider supports.
    // -----------------------------------------------------------------------
    const sources = await prisma.externalConfluenceSource.findMany();

    for (const source of sources) {
      if (!source.enabled) {
        sourcesSkippedDisabled += 1;
        log?.info('externalConfluence: source disabled, skipping', { source: source.name });
        continue;
      }

      let provider: ConfluenceProvider | null | undefined;
      try {
        provider = resolveProvider({
          id: source.id,
          name: source.name,
          provider: source.provider,
          enabled: source.enabled,
          apiKeyEnvName: source.apiKeyEnvName
        });
      } catch (err) {
        // Resolver itself threw -> treat as a per-source error (continue pass).
        errors += 1;
        const message = err instanceof Error ? err.message : String(err);
        await prisma.externalConfluenceSource.update({
          where: { id: source.id },
          data: { status: 'error', lastError: message, failCount: { increment: 1 } }
        });
        log?.error(`externalConfluence: resolver error for source ${source.name}`, { source: source.name, error: message });
        continue;
      }

      if (!provider) {
        // Clean per-source skip: no live adapter / missing key at resolve time /
        // manual/stub provider. Recorded as source status (NEVER 'live'), no
        // snapshot fabricated.
        sourcesSkippedNoProvider += 1;
        await prisma.externalConfluenceSource.update({
          where: { id: source.id },
          data: { status: 'missing_key', lastError: null }
        });
        log?.info('externalConfluence: no provider resolved for source, skipping', {
          source: source.name,
          provider: source.provider
        });
        continue;
      }

      const providerChains = new Set<Chain>(provider.chains);
      let sourceStatusForHealth: string = 'live';

      try {
        for (const token of knownTokens) {
          if (!VALID_CHAINS.includes(token.chain)) continue;
          if (!providerChains.has(token.chain)) continue;

          try {
            const fetched = await provider.fetchForToken(token.chain, token.address);
            const observedAt = fetched.observedAt ?? new Date();
            const dedupeKey = buildDedupeKey(source.provider, provider.snapshotType, token.address, observedAt);

            // Store the returned status VERBATIM. Absence of data (missing_key/
            // plan_required/unavailable/stub/rate_limited/error) is recorded as
            // its honest status — NEVER coerced to 'ok'/'safe' (global rule 15).
            await prisma.tokenConfluenceSnapshot.upsert({
              where: {
                sourceId_tokenAddress_snapshotType_dedupeKey: {
                  sourceId: source.id,
                  tokenAddress: token.address,
                  snapshotType: provider.snapshotType,
                  dedupeKey
                }
              },
              create: {
                tokenId: token.tokenId,
                chain: token.chain,
                tokenAddress: token.address,
                sourceId: source.id,
                provider: source.provider,
                snapshotType: provider.snapshotType,
                status: fetched.status,
                dataJson: (fetched.dataJson ?? {}) as Prisma.InputJsonValue,
                observedAt,
                dedupeKey
              },
              update: {
                tokenId: token.tokenId,
                status: fetched.status,
                dataJson: (fetched.dataJson ?? {}) as Prisma.InputJsonValue,
                observedAt
              }
            });
            externalSnapshotsUpserted += 1;

            // The MOST-degraded status a fetch returned drives the source-health
            // status: any real 'ok' keeps it 'live'; a uniform non-ok status
            // (e.g. every token missing_key) surfaces that at the source level.
            if (fetched.status !== 'ok') {
              sourceStatusForHealth = fetched.status;
            }
          } catch (tokenErr) {
            // Per-token guard: one token's fetch throwing never aborts siblings
            // and never marks the SOURCE 'error' (the source resolved fine).
            errors += 1;
            const message = tokenErr instanceof Error ? tokenErr.message : String(tokenErr);
            log?.error('externalConfluence: token fetch error (skipped, source continues)', {
              source: source.name,
              tokenAddress: token.address,
              error: message
            });
          }
        }

        await prisma.externalConfluenceSource.update({
          where: { id: source.id },
          data: {
            lastSyncAt: new Date(),
            status: sourceStatusForHealth,
            lastError: null,
            failCount: 0
          }
        });
        sourcesSynced += 1;
        log?.info('externalConfluence: source sync complete', {
          source: source.name,
          status: sourceStatusForHealth
        });
      } catch (err) {
        // Per-source guard: an unexpected throw OUTSIDE the per-token loop
        // (e.g. provider.chains access) marks THIS source 'error' + continues.
        errors += 1;
        const message = err instanceof Error ? err.message : String(err);
        await prisma.externalConfluenceSource.update({
          where: { id: source.id },
          data: { status: 'error', lastError: message, failCount: { increment: 1 } }
        });
        log?.error(`externalConfluence: provider error for source ${source.name}`, { source: source.name, error: message });
      }
    }
  ```

  > NOTE for the implementer: the `sourceId: null` branch of the `@@unique([sourceId, tokenAddress, snapshotType, dedupeKey])` compound-`where` (used by the internal leg's `upsert`) relies on Prisma treating a `null` compound-unique member as a matchable value. Prisma's `upsert`/`findUnique` on a compound unique that includes a nullable column is supported when passing `sourceId: null` explicitly (Prisma emits `IS NULL`). If the generated client rejects `sourceId: null` inside the compound `where` at runtime (older Prisma), fall back to: `findFirst({ where: { sourceId: null, tokenAddress, snapshotType, dedupeKey } })` then `create`/`update` by `id`. Verify against the actual generated client at Step 4 — the Step-1 internal test is the guard for this. Do not change the schema.

- [ ] **Step 9: Run the tests — expect PASS.**
  `npx vitest run packages/db/test/externalConfluence.test.ts`
  Expected: PASS (10 tests) — internal leg + all 9 external-leg behaviors green.

- [ ] **Step 10: Commit.**
  ```
  git add packages/db/src/confluence/ingest.ts packages/db/test/externalConfluence.test.ts
  git commit -m "feat(confluence): external provider leg — known-tokens-only, status-verbatim, shadow-only (Task D)

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

- [ ] **Step 11: Create the worker job wrapper `apps/worker/src/jobs/externalConfluence.ts`.**
  Thin wrapper mirroring `socialIngest.ts` (MOCK_MODE => shared mock provider for every source; live => per-`provider` factory, null when key absent). REAL, complete code — consumes the Task C provider factories (`MockConfluenceProvider`, `createHolderScanProvider`, `createClobrProvider`, `createGmgnProvider`, `createAgPaperProvider`) exactly as their Task C signatures export them:

  ```ts
  // FlowRadar — externalConfluence job (Task D, External Confluence). Thin
  // wrapper around @flowradar/db's runExternalConfluencePass — the internal
  // LiquidityRisk + per-source external-fetch logic lives there (same
  // worker/seed-sharing pattern as socialIngest.ts).
  //
  // SHADOW-ONLY (design doc global rules 1-16): this job only computes internal
  // LiquidityRisk from existing market data and reads external provider data for
  // tokens ALREADY IN THE DB, writing only TokenConfluenceSnapshot rows. It
  // never creates a Token/Signal/Alert/CandidateWallet, never touches FlowScore,
  // never trades, and (GMGN) never references a swap/order/key/wallet endpoint.
  //
  // resolveProvider: in MOCK_MODE, EVERY ExternalConfluenceSource row resolves to
  // the SAME shared MockConfluenceProvider (same "MOCK_MODE => one shared mock
  // for ALL sources" decision as socialIngest.ts). Live mode (MOCK_MODE=false)
  // maps each source by its `provider` string to its config-gated factory:
  // holderscan => createHolderScanProvider (null when HOLDERSCAN_API_KEY absent),
  // clobr => createClobrProvider (STUB), gmgn => createGmgnProvider (query-only
  // STUB), ag_paper/manual/anything-else => null (no automated reader — AG Paper
  // is manual/stub-only). A null return is a graceful per-source skip.

  import { runExternalConfluencePass } from '@flowradar/db';
  import {
    MockConfluenceProvider,
    createHolderScanProvider,
    createClobrProvider,
    createGmgnProvider,
    createAgPaperProvider
  } from '@flowradar/providers';
  import type { ConfluenceProvider } from '@flowradar/providers';
  import type { JobContext } from '../context';

  function isMockMode(): boolean {
    return process.env.MOCK_MODE !== 'false';
  }

  let sharedMockConfluenceProvider: ConfluenceProvider | null = null;

  /** Lazily builds ONE shared MockConfluenceProvider for the life of this process (deterministic ok results for demo). */
  function getSharedMockConfluenceProvider(): ConfluenceProvider {
    if (!sharedMockConfluenceProvider) {
      sharedMockConfluenceProvider = new MockConfluenceProvider();
    }
    return sharedMockConfluenceProvider;
  }

  // Live-adapter cache — construct each factory at most once per process, keyed
  // by the source `provider` string (the live factory choice is provider-driven).
  const liveConfluenceCache = new Map<string, ConfluenceProvider | null>();

  /**
   * Live-mode (MOCK_MODE=false) provider resolution by ExternalConfluenceSource
   * .provider. Each maps to its config-gated factory in @flowradar/providers/
   * confluence — every factory returns `null` when its key is absent OR when it
   * is stub-only, a graceful per-source skip. env values are read via
   * process.env only to PASS them to the factory (never logged/stored).
   */
  function resolveLiveConfluenceProvider(provider: string): ConfluenceProvider | null {
    if (liveConfluenceCache.has(provider)) {
      return liveConfluenceCache.get(provider) ?? null;
    }

    let resolved: ConfluenceProvider | null;
    switch (provider) {
      case 'holderscan':
        resolved = createHolderScanProvider({ HOLDERSCAN_API_KEY: process.env.HOLDERSCAN_API_KEY });
        break;
      case 'clobr':
        resolved = createClobrProvider({ CLOBR_API_KEY: process.env.CLOBR_API_KEY });
        break;
      case 'gmgn':
        resolved = createGmgnProvider({ GMGN_API_KEY: process.env.GMGN_API_KEY });
        break;
      case 'ag_paper':
        resolved = createAgPaperProvider();
        break;
      default:
        resolved = null;
    }

    liveConfluenceCache.set(provider, resolved);
    return resolved;
  }

  export async function run(ctx: JobContext): Promise<void> {
    const { prisma, settings, log } = ctx;
    await runExternalConfluencePass(
      prisma,
      settings,
      (source) => {
        if (isMockMode()) {
          return getSharedMockConfluenceProvider();
        }
        return resolveLiveConfluenceProvider(source.provider);
      },
      log
    );
  }
  ```

  > NOTE: `createHolderScanProvider`/`createGmgnProvider`/`createClobrProvider` take an `env` object (see Task C signatures `createHolderScanProvider(env)`). Match the exact param key each Task C factory reads — the keys above (`HOLDERSCAN_API_KEY`, `CLOBR_API_KEY`, `GMGN_API_KEY`) are the design-doc env var names. If Task C's factory reads `process.env` directly instead of an `env` arg, call it with no arg. Confirm against the shipped Task C exports before running Step 13.

- [ ] **Step 12: Register the job in `apps/worker/src/index.ts` (additive).**
  Add the import next to the existing `socialIngest` import (after line 75 `import * as socialIngest from './jobs/socialIngest';`):
  ```ts
  import * as externalConfluence from './jobs/externalConfluence';
  ```
  Then append this job to the `jobs` array, immediately after the `socialIngest` entry (after the closing `}` of the `socialIngest` object, inside the array, before the array's closing `]`):
  ```ts
    ,
    // externalConfluence (Task D, External Confluence): shadow-only confluence
    // enrichment. Registered on settings.connectors.externalConfluence.syncHours
    // (6h default) — same *3600 hours->seconds conversion as every other
    // hours-denominated interval above. SHADOW-ONLY: computes internal
    // LiquidityRisk from existing market data + reads external provider data for
    // known tokens only; never creates a Token/Signal/Alert/CandidateWallet and
    // never touches FlowScore/signal thresholds/wallet scoring.
    {
      name: 'externalConfluence',
      run: externalConfluence.run,
      intervalSec: settings.connectors.externalConfluence.syncHours * 3600
    }
  ```

- [ ] **Step 13: Typecheck the worker — expect PASS.**
  `npm run -w apps/worker typecheck` (or `npx tsc -p apps/worker --noEmit` if no `typecheck` script exists in that workspace).
  Expected: PASS — the job wraps `runExternalConfluencePass` with a correctly-typed `ConfluenceSourceResolver`, and `settings.connectors.externalConfluence.syncHours` resolves (Task A added it to `Settings`).

- [ ] **Step 14: Commit.**
  ```
  git add apps/worker/src/jobs/externalConfluence.ts apps/worker/src/index.ts
  git commit -m "feat(worker): register externalConfluence job on connectors.externalConfluence.syncHours (Task D)

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

- [ ] **Step 15: Seed 1-2 example ExternalConfluenceSource rows additively (Phase 3.8 in `packages/db/src/seed.ts`).**
  Add a new phase mirroring `bootstrapSocialSources` (seed.ts lines 336-379). Insert the seed-rows const + `bootstrapExternalConfluenceSources` function right after `seedSocialIngestPass` (after seed.ts line 402), and call it in `main()` alongside the other Phase 3.x bootstraps. Both rows DISABLED (no key required to build/seed green — design non-goal "zero keys"):

  ```ts
  // ---------------------------------------------------------------------------
  // Phase 3.8: ExternalConfluenceSource seed rows (Task D, External Confluence).
  // 2 example rows (holderscan + gmgn, BOTH DISABLED by default — no API key is
  // required to build/seed, per the design doc non-goal "every external provider
  // degrades to stub/missing_key/plan_required and the build stays green with
  // zero keys"). apiKeyEnvName is the env VAR NAME only, never a value (design
  // rule 13). Enabling a row requires an operator to supply the real key first.
  // ---------------------------------------------------------------------------

  const EXTERNAL_CONFLUENCE_SOURCE_SEED_ROWS = [
    {
      name: 'holderscan-holder-risk',
      provider: 'holderscan',
      apiKeyEnvName: 'HOLDERSCAN_API_KEY',
      rateLimitPerMinute: 30,
      notes: 'Optional/paid holder-risk provider — disabled until an operator supplies HOLDERSCAN_API_KEY + a plan that returns holder deltas/concentration. Reports missing_key/plan_required until then; never marks a token safe.'
    },
    {
      name: 'gmgn-external-intel',
      provider: 'gmgn',
      apiKeyEnvName: 'GMGN_API_KEY',
      rateLimitPerMinute: 30,
      notes: 'Query-only external intel — disabled by default; stub until confirmed query-only docs/key. NEVER references swap/order/private-key/wallet endpoints (query-only, design rule 8).'
    }
  ] as const;

  async function bootstrapExternalConfluenceSources(): Promise<number> {
    await prisma.externalConfluenceSource.createMany({
      data: EXTERNAL_CONFLUENCE_SOURCE_SEED_ROWS.map((row) => ({
        name: row.name,
        provider: row.provider,
        enabled: false,
        apiKeyEnvName: row.apiKeyEnvName,
        rateLimitPerMinute: row.rateLimitPerMinute,
        metadataJson: { notes: row.notes }
      }))
    });
    log('bootstrapped ExternalConfluenceSource rows (disabled by default).', {
      count: EXTERNAL_CONFLUENCE_SOURCE_SEED_ROWS.length
    });
    return EXTERNAL_CONFLUENCE_SOURCE_SEED_ROWS.length;
  }

  /**
   * Runs ONE runExternalConfluencePass (design doc "Worker integration") so a
   * fresh `npm run db:seed` demonstrates the internal LiquidityRisk snapshots
   * end-to-end. Both seeded external sources are DISABLED, so this pass only
   * exercises Leg 1 (internal LiquidityRisk over every seeded Token that has a
   * market snapshot) — deterministic, no provider, no key. The resolver returns
   * null for any (disabled -> never-reached) source, same convention as the
   * other mock-mode seed passes.
   */
  async function seedExternalConfluencePass(settings: Settings) {
    const result = await runExternalConfluencePass(prisma, settings, () => null, {
      info: (msg, meta) => log(msg, meta),
      error: (msg, meta) => log(`ERROR: ${msg}`, meta)
    });
    log('external confluence pass complete.', { ...result });
    return result;
  }
  ```

  Add the import at the top of `seed.ts` (after line 39 `import { runSocialIngestPass } from './social/ingest';`):
  ```ts
  import { runExternalConfluencePass } from './confluence/ingest';
  ```
  Add the wipe entries in `wipeAllTables()` (leaf-first, BEFORE `token.deleteMany()` at line 108 — `TokenConfluenceSnapshot.tokenId` is a nullable FK to Token with `ON DELETE SET NULL`, and `sourceId` FKs `ExternalConfluenceSource`; wipe the snapshot table then the source table, both before `token`):
  ```ts
    // TokenConfluenceSnapshot carries nullable FKs to Token (SET NULL) and
    // ExternalConfluenceSource — wiped leaf-first, before token.deleteMany()
    // below (Task D, External Confluence).
    await prisma.tokenConfluenceSnapshot.deleteMany();
    await prisma.externalConfluenceSource.deleteMany();
  ```
  Wire the two calls into `main()` — locate where `bootstrapSocialSources()` + `seedSocialIngestPass(world, settings)` are invoked and add, right after them (external confluence must run AFTER Phase 4 market snapshots so LiquidityRisk has inputs — place the `seedExternalConfluencePass` call after `seedMarketSnapshots` in the main sequence; the `bootstrapExternalConfluenceSources` createMany can sit next to `bootstrapSocialSources`):
  ```ts
    await bootstrapExternalConfluenceSources();
    // ... (later, after seedMarketSnapshots + trade ingest) ...
    await seedExternalConfluencePass(settings);
  ```

- [ ] **Step 16: Run the seed against the LITE DB — expect internal snapshots written.**
  `npm run db:seed`
  Expected: log lines `bootstrapped ExternalConfluenceSource rows (disabled by default). {"count":2}` and `external confluence pass complete. {"internalLiquiditySnapshots":<N>=28ish, "externalSnapshotsUpserted":0, "sourcesSkippedDisabled":2, ...}`. Non-zero `internalLiquiditySnapshots` (one per seeded token with a market snapshot); `externalSnapshotsUpserted` = 0 (both sources disabled).

- [ ] **Step 17: Verify seed idempotency + snapshot presence via a quick DB assertion.**
  `npx vitest run packages/db/test/externalConfluence.test.ts` (re-run — still green after seed touched the DB; the suite is prefix-scoped and self-cleans). Then a one-off check that the seed wrote internal rows:
  `node -e "const {prisma}=require('./packages/db/dist/index.js'); prisma.tokenConfluenceSnapshot.count({where:{provider:'internal',snapshotType:'liquidity_risk'}}).then(n=>{console.log('internal liquidity_risk snapshots:',n);return prisma.$disconnect();})"` (or the equivalent `tsx -e` against `packages/db/src/client`).
  Expected: count > 0; the vitest suite stays 10/10 green.

- [ ] **Step 18: Commit.**
  ```
  git add packages/db/src/seed.ts
  git commit -m "feat(seed): additive Phase 3.8 — 2 disabled ExternalConfluenceSource rows + one internal LiquidityRisk pass (Task D)

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

- [ ] **Step 19: Scope + secret + Dune guard scan for this task's files.**
  Run these greps and confirm each expected result:
  - `git diff --name-only <base>..HEAD` lists ONLY: `packages/db/src/confluence/ingest.ts`, `packages/db/src/index.ts`, `packages/db/test/externalConfluence.test.ts`, `apps/worker/src/jobs/externalConfluence.ts`, `apps/worker/src/index.ts`, `packages/db/src/seed.ts`. Expected: no other files (no `flowScore.ts`, no `walletScore.ts`, no rule/threshold files, no `schema.prisma`, no `packages/core`/`packages/providers` sources — those belong to Tasks A/B/C).
  - `git grep -nE "flowScore|evaluateAllRules|walletScore|candidateWallet\.(create|upsert)|prisma\.signal\.create|prisma\.alert\.create|prisma\.token\.create" -- packages/db/src/confluence apps/worker/src/jobs/externalConfluence.ts` → Expected: ZERO matches (this task never writes Token/Signal/Alert/Candidate and never touches scoring).
  - `git grep -nEi "swap|order|privateKey|private_key|signTransaction|wallet.?management|execute" -- packages/db/src/confluence apps/worker/src/jobs/externalConfluence.ts` → Expected: ZERO matches (GMGN query-only; no trading/execution). (If the word "execute" appears only inside a comment, reword the comment — keep the guard clean.)
  - `git grep -nE "process\.env\.[A-Z_]+_KEY[^N]|process\.env\.[A-Z_]+_TOKEN" -- packages/db/src/confluence` → Expected: ZERO in the DB pass (the pass never reads env; only the worker wrapper reads env, to PASS values to factories, never to log/store).
  - `git grep -nEi "DUNE_EXECUTE_FRESH|execute_query|executeQuery|dune.*execute" -- packages/db/src/confluence apps/worker/src/jobs/externalConfluence.ts` → Expected: ZERO matches (no Dune fresh execution).
  If any scan is non-empty, fix before proceeding (do not silence with a comment except the "execute" wording case above).

- [ ] **Step 20: Full gate on a clean/rebuilt DB.**
  `npm run db:reset` (or the repo's clean-DB command) then `npm run db:seed` then `npm run verify`.
  Expected: `npm run verify` GREEN including `packages/db/test/externalConfluence.test.ts` (10 passed) and every pre-existing suite still passing (no regression in `socialIngest.test.ts`, scoring, signals). If `verify` reports replayRunner pool-timeouts, that is the known large-residue issue — rerun on a freshly reset DB (do not treat a residue timeout as a Task D failure, but DO confirm the confluence suite itself is green).

**Done Bar:**
- `runExternalConfluencePass` creates a `provider="internal"`, `snapshotType="liquidity_risk"`, `sourceId=null` snapshot for every Token with a latest `TokenMarketSnapshot`, with `dataJson.liquidityToMcapRatio` and bands matching `computeLiquidityRisk` over `DEFAULT_SETTINGS.connectors.externalConfluence.liquidityRisk`.
- External providers are fetched ONLY for tokens already in the DB; a phantom address is never fetched and never snapshotted; `Token`/`Signal`/`Alert`/`CandidateWallet` counts are unchanged by the pass.
- `missing_key`/`plan_required`/`stub`/`unavailable`/`error`/`rate_limited` fetch statuses are stored VERBATIM on the snapshot and reflected on the source row; no code path stores `"ok"`/`"safe"` when data is absent.
- Disabled source → provider never invoked, `sourcesSkippedDisabled` counted, no snapshot. Resolver `null` → `sourcesSkippedNoProvider` counted, source marked `missing_key`, no snapshot.
- Re-run within the same hour bucket is idempotent (0 net new rows, internal and external).
- Per-source try/catch (one source throwing → that source `status='error'`, others still synced) and per-token try/catch (one token throwing → siblings still snapshotted, source stays `live`) both proven by tests.
- Worker job registered on `settings.connectors.externalConfluence.syncHours * 3600`; MOCK_MODE → shared `MockConfluenceProvider`, live → per-`provider` factory (null on missing key). Seed adds exactly 2 DISABLED example rows + runs one internal pass. `npm run verify` green on a clean DB; scope/secret/Dune scans all empty.

**Reviewer Focus:**
- **Never-creates-Token / shadow-only**: confirm the pass only ever does `prisma.token.findMany`/`count` (read) and `prisma.tokenConfluenceSnapshot.upsert` + `prisma.externalConfluenceSource.update` (write). No `token.create`, no `signal`/`alert`/`candidateWallet` writes, no `flowScore`/`walletScore`/rule imports — the Step-19 grep must be empty.
- **`unavailable ≠ safe` (global rule 15)**: verify `fetched.status` is stored verbatim and that there is no branch that upgrades a non-`ok` status to `ok`, and no place that omits a snapshot for a degraded status in a way that could read as "clean." The dedicated `missing_key`/`unavailable` tests must assert the stored status literally.
- **Known-tokens-only fetch**: the external loop iterates `knownTokens` (Token rows) and filters by `provider.chains` ∩ `VALID_CHAINS`; confirm there is no path that fetches or upserts for an address not backed by a Token row, and that `tokenId` is always the real linked id (never a fabricated/discovered token).
- **Secret hygiene (rule 13)**: the DB pass reads no env at all; the worker wrapper reads `process.env.*_KEY`/`*_TOKEN` ONLY to pass into factories and never logs/stores them; `apiKeyEnvName`/`dataJson`/`metadataJson` carry names/metrics only. Confirm no resolved key value ever reaches a `log?.info`/`log?.error` meta object or a snapshot column.
- **GMGN query-only + no execution (rules 7/8)**: confirm neither Task-D file references swap/order/private-key/wallet-management/execute endpoints (Step-19 grep). The seed row's `gmgn` note documents query-only; the live factory is Task C's stub.
- **Compound-unique-with-null upsert**: scrutinize the internal leg's `upsert` on `sourceId_tokenAddress_snapshotType_dedupeKey` with `sourceId: null` — verify it actually round-trips against the generated Prisma client (the Step-4 test is the guard); confirm the documented `findFirst`+`create`/`update` fallback is used if the client rejects `null` in the compound `where`, without touching the schema.
- **Additive-only worker/seed changes**: confirm the `apps/worker/src/index.ts` and `seed.ts` edits only ADD (new import, new array entry, new phase + wipe entries) and reorder nothing; the seed's new wipe entries are leaf-first (snapshot then source, both before `token`).

---

### Task E: Token-detail Confluence panel + `getTokenConfluence` query helper

**Files:**
- **Create** `packages/db/src/confluence/queries.ts` — `getTokenConfluence(prisma, tokenId)` read helper (latest `TokenConfluenceSnapshot` per `snapshotType` + source statuses).
- **Create** `apps/web/components/tokens/ConfluencePanel.tsx` — server component, read-only Confluence cards.
- **Modify** `packages/db/src/index.ts` — export the new confluence query helpers (barrel).
- **Modify** `apps/web/app/tokens/[id]/page.tsx` — additively fetch + render `<ConfluencePanel />` (existing display byte-identical).
- **Create** `packages/db/test/confluenceQueries.test.ts` — DB integration test (`probePort(5439)`) for `getTokenConfluence`.
- **Create** `apps/web/test/confluencePanel.test.ts` — source-text web test (matches `tokenSocialSection.test.ts` convention).

**Interfaces:**

*Consumes* (from earlier tasks — use these EXACT names/shapes):
- Task B Prisma models: `TokenConfluenceSnapshot { id, tokenId: string|null, chain, tokenAddress, sourceId: string|null, provider, snapshotType, status, dataJson: Prisma.JsonValue, observedAt, ingestedAt, dedupeKey, metadataJson }` and `ExternalConfluenceSource { id, name, provider, enabled, apiKeyEnvName, status, ... }`. `snapshotType ∈ holder_risk|liquidity_risk|liquidity_map|external_intel|paper_trade`; `status ∈ ok|unavailable|missing_key|plan_required|rate_limited|error|stub`.
- Task C: `getConfluenceSourceStatuses(prisma): Promise<ConfluenceSourceStatusRow[]>` where `ConfluenceSourceStatusRow = { sourceName: string; provider: string; mode: ConfluenceSourceMode; note: string; apiKeyEnvName: string | null }` and `ConfluenceSourceMode = "live"|"mock"|"missing_key"|"plan_required"|"stub"|"unavailable"|"error"`. Re-exported from `@flowradar/providers` (and, if Task C wired it, from `@flowradar/db` — this task imports it from `@flowradar/providers` directly to avoid a cross-package assumption; see Step 3).
- Task A LiquidityRisk `dataJson` shape (the `internal` `liquidity_risk` snapshot's `dataJson` is the serialized `LiquidityRiskResult`: `{ liquidityToMcapRatio, poolFloatFractionEstimate, overhangMultiple, estimatedOneWaySlippagePct, dumpToHalveUsd, positionSizeMaxFor2PctSlippageUsd, absoluteLiquidityBand, ratioFragilityBand, caveats, confidence }`).
- `apps/web/lib/format.ts`: `fmtUsd(n)`, `fmtPct(n)`, `fmtAge(date)`.
- `@/components/ui/card` (`Card`,`CardContent`,`CardHeader`,`CardTitle`), `@/components/ui/badge` (`Badge`).

*Produces* (Task F relies on these EXACT names):
- `getTokenConfluence(prisma: PrismaClient, tokenId: string): Promise<TokenConfluence>`
- `interface TokenConfluence { liquidityRisk: ConfluenceSnapshotRow | null; holderRisk: ConfluenceSnapshotRow | null; clobr: ConfluenceSnapshotRow | null; gmgn: ConfluenceSnapshotRow | null; agPaper: ConfluenceSnapshotRow | null; sourceStatuses: ConfluenceSourceStatusRow[] }`
- `interface ConfluenceSnapshotRow { id: string; snapshotType: string; provider: string; status: string; dataJson: Record<string, unknown>; observedAt: Date; sourceName: string | null }`
- `ConfluencePanel` (default-exported? NO — named export `ConfluencePanel`) + `interface ConfluencePanelProps`.

---

- [ ] **Step 1: Write the failing DB integration test for `getTokenConfluence`.**
  Create `packages/db/test/confluenceQueries.test.ts` with REAL code. Mirror the existing DB-test convention (probe port 5439, skip cleanly if no LITE Postgres). First inspect a sibling DB test for the exact probe/skip boilerplate:

  Use Grep for `probePort` under `packages/db/test` and Read the first hit so the `beforeAll`/`describe.skipIf` and `PrismaClient` construction match EXACTLY. Then write:

  ```ts
  // packages/db/test/confluenceQueries.test.ts
  // FlowRadar — getTokenConfluence read-helper integration test (Task E).
  // SHADOW-ONLY reads over TokenConfluenceSnapshot + ExternalConfluenceSource.
  // Requires LITE Postgres on 5439; skips cleanly otherwise (sibling-test convention).
  import { afterAll, beforeAll, describe, expect, it } from 'vitest';
  import { PrismaClient } from '@prisma/client';
  import net from 'node:net';
  import { getTokenConfluence } from '../src/confluence/queries';

  function probePort(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const sock = net.connect(port, '127.0.0.1');
      const done = (ok: boolean) => { sock.destroy(); resolve(ok); };
      sock.once('connect', () => done(true));
      sock.once('error', () => done(false));
      sock.setTimeout(1000, () => done(false));
    });
  }

  const HAS_DB = await probePort(5439);
  const d = HAS_DB ? describe : describe.skip;

  d('getTokenConfluence (Task E)', () => {
    const prisma = new PrismaClient();
    let tokenId = '';
    const addr = 'ConfTestMint1111111111111111111111111111111';

    beforeAll(async () => {
      const chain = await prisma.chain.upsert({
        where: { id: 'SOLANA' },
        update: {},
        create: {
          id: 'SOLANA', name: 'Solana', nativeSymbol: 'SOL',
          explorerTxUrl: 'https://x/{hash}', explorerAddressUrl: 'https://x/{address}',
        },
      });
      const token = await prisma.token.create({
        data: { chain: chain.id, address: addr, symbol: 'CONF', name: 'Conf Test', firstSeenAt: new Date() },
      });
      tokenId = token.id;

      const src = await prisma.externalConfluenceSource.create({
        data: { name: 'holderscan-test', provider: 'holderscan', enabled: false, apiKeyEnvName: 'HOLDERSCAN_API_KEY', status: 'missing_key' },
      });

      // Two liquidity_risk snapshots for the SAME token: an older one and a newer
      // one. getTokenConfluence must return ONLY the newer (latest per snapshotType).
      await prisma.tokenConfluenceSnapshot.create({
        data: {
          tokenId, chain: chain.id, tokenAddress: addr, sourceId: null,
          provider: 'internal', snapshotType: 'liquidity_risk', status: 'ok',
          dataJson: { ratioFragilityBand: 'fragile', confidence: 'high' },
          observedAt: new Date('2026-07-01T00:00:00Z'),
          dedupeKey: 'internal:liquidity_risk:' + addr + ':2026070100',
        },
      });
      await prisma.tokenConfluenceSnapshot.create({
        data: {
          tokenId, chain: chain.id, tokenAddress: addr, sourceId: null,
          provider: 'internal', snapshotType: 'liquidity_risk', status: 'ok',
          dataJson: { ratioFragilityBand: 'very_fragile', confidence: 'medium' },
          observedAt: new Date('2026-07-05T00:00:00Z'),
          dedupeKey: 'internal:liquidity_risk:' + addr + ':2026070500',
        },
      });
      // A holder_risk snapshot with a NON-ok status (plan_required) → must surface
      // as-is (unavailable/plan-required is NOT "safe").
      await prisma.tokenConfluenceSnapshot.create({
        data: {
          tokenId, chain: chain.id, tokenAddress: addr, sourceId: src.id,
          provider: 'holderscan', snapshotType: 'holder_risk', status: 'plan_required',
          dataJson: {}, observedAt: new Date('2026-07-05T00:00:00Z'),
          dedupeKey: 'holderscan:holder_risk:' + addr + ':2026070500',
        },
      });
    });

    afterAll(async () => {
      await prisma.tokenConfluenceSnapshot.deleteMany({ where: { tokenAddress: addr } });
      await prisma.externalConfluenceSource.deleteMany({ where: { name: 'holderscan-test' } });
      await prisma.token.deleteMany({ where: { address: addr } });
      await prisma.$disconnect();
    });

    it('returns the LATEST liquidity_risk snapshot per snapshotType', async () => {
      const c = await getTokenConfluence(prisma, tokenId);
      expect(c.liquidityRisk).not.toBeNull();
      expect(c.liquidityRisk!.status).toBe('ok');
      expect((c.liquidityRisk!.dataJson as any).ratioFragilityBand).toBe('very_fragile');
      expect(c.liquidityRisk!.provider).toBe('internal');
    });

    it('surfaces a non-ok holder_risk snapshot with its real status (never coerced to safe)', async () => {
      const c = await getTokenConfluence(prisma, tokenId);
      expect(c.holderRisk).not.toBeNull();
      expect(c.holderRisk!.status).toBe('plan_required');
      expect(c.holderRisk!.sourceName).toBe('holderscan-test');
    });

    it('returns null for snapshotTypes with no rows (honest absence, not a stub row)', async () => {
      const c = await getTokenConfluence(prisma, tokenId);
      expect(c.clobr).toBeNull();
      expect(c.gmgn).toBeNull();
      expect(c.agPaper).toBeNull();
    });

    it('includes source statuses (env presence as boolean-derived mode, never a secret)', async () => {
      const c = await getTokenConfluence(prisma, tokenId);
      expect(Array.isArray(c.sourceStatuses)).toBe(true);
      const serialized = JSON.stringify(c.sourceStatuses);
      expect(serialized).not.toMatch(/HOLDERSCAN_API_KEY=/); // a NAME may appear; a value assignment must not
    });
  });
  ```

- [ ] **Step 2: Run the DB test — expect FAIL (module not found).**
  ```
  npx vitest run packages/db/test/confluenceQueries.test.ts
  ```
  Expected: FAIL — `Cannot find module '../src/confluence/queries'` (helper does not exist yet). If LITE Postgres on 5439 is down, the suite `describe.skip`s and reports 0 assertions; that is NOT a pass — start LITE Postgres (`npm run db:up` or the repo's lite-pg script) so the port probe returns true before continuing.

- [ ] **Step 3: Implement `getTokenConfluence` (minimal, real).**
  First confirm where `getConfluenceSourceStatuses` + `ConfluenceSourceStatusRow` are exported from (Task C). Grep `getConfluenceSourceStatuses` under `packages/providers/src`. Use `@flowradar/providers` as the import source (Task C wires it into `packages/providers/src/index.ts`). Create `packages/db/src/confluence/queries.ts`:

  ```ts
  // FlowRadar — token-detail Confluence read helpers (Task E). SHADOW-ONLY:
  // pure reads over TokenConfluenceSnapshot + ExternalConfluenceSource. They
  // never write, never touch FlowScore/Signal/CandidateWallet, and never
  // fabricate a row for a snapshotType that has no data (absence -> null, which
  // the panel renders honestly as "unavailable/unknown", NEVER "safe").
  import type { PrismaClient } from '@prisma/client';
  import {
    getConfluenceSourceStatuses,
    type ConfluenceSourceStatusRow,
  } from '@flowradar/providers';

  /** A single confluence snapshot flattened for display (Date/JSON kept; no secrets). */
  export interface ConfluenceSnapshotRow {
    id: string;
    snapshotType: string;
    provider: string;
    status: string;
    dataJson: Record<string, unknown>;
    observedAt: Date;
    /** ExternalConfluenceSource.name when linked; null for the internal LiquidityRisk snapshot. */
    sourceName: string | null;
  }

  export interface TokenConfluence {
    liquidityRisk: ConfluenceSnapshotRow | null;
    holderRisk: ConfluenceSnapshotRow | null;
    clobr: ConfluenceSnapshotRow | null;
    gmgn: ConfluenceSnapshotRow | null;
    agPaper: ConfluenceSnapshotRow | null;
    sourceStatuses: ConfluenceSourceStatusRow[];
  }

  const SNAPSHOT_INCLUDE = {
    source: { select: { name: true } },
  } as const;

  function toRow(
    s: {
      id: string;
      snapshotType: string;
      provider: string;
      status: string;
      dataJson: unknown;
      observedAt: Date;
      source: { name: string } | null;
    } | null,
  ): ConfluenceSnapshotRow | null {
    if (!s) return null;
    return {
      id: s.id,
      snapshotType: s.snapshotType,
      provider: s.provider,
      status: s.status,
      // dataJson is display-safe by construction (Task B/C/D guarantee no secrets);
      // coerce Prisma.JsonValue -> record for the panel. Non-object payloads (never
      // expected) degrade to {} rather than throwing.
      dataJson:
        s.dataJson && typeof s.dataJson === 'object' && !Array.isArray(s.dataJson)
          ? (s.dataJson as Record<string, unknown>)
          : {},
      observedAt: s.observedAt,
      sourceName: s.source?.name ?? null,
    };
  }

  /** Latest snapshot for one (tokenId, snapshotType), newest observedAt first. */
  async function latestOfType(prisma: PrismaClient, tokenId: string, snapshotType: string) {
    return prisma.tokenConfluenceSnapshot.findFirst({
      where: { tokenId, snapshotType },
      orderBy: { observedAt: 'desc' },
      include: SNAPSHOT_INCLUDE,
    });
  }

  /**
   * All confluence evidence for one token: the latest snapshot per snapshotType
   * (liquidity_risk / holder_risk / liquidity_map / external_intel / paper_trade)
   * plus the operator-facing source health rows. Read-only. A snapshotType with
   * no rows returns null — the caller must render that as unavailable/unknown,
   * never as a reassuring verdict.
   */
  export async function getTokenConfluence(
    prisma: PrismaClient,
    tokenId: string,
  ): Promise<TokenConfluence> {
    const [liquidityRisk, holderRisk, clobr, gmgn, agPaper, sourceStatuses] = await Promise.all([
      latestOfType(prisma, tokenId, 'liquidity_risk'),
      latestOfType(prisma, tokenId, 'holder_risk'),
      latestOfType(prisma, tokenId, 'liquidity_map'),
      latestOfType(prisma, tokenId, 'external_intel'),
      latestOfType(prisma, tokenId, 'paper_trade'),
      getConfluenceSourceStatuses(prisma),
    ]);

    return {
      liquidityRisk: toRow(liquidityRisk),
      holderRisk: toRow(holderRisk),
      clobr: toRow(clobr),
      gmgn: toRow(gmgn),
      agPaper: toRow(agPaper),
      sourceStatuses,
    };
  }
  ```
  > Note the mapping: `liquidity_map → clobr`, `external_intel → gmgn`, `paper_trade → agPaper`. These are the canonical `snapshotType → card` bindings from the design doc (§Module C/D/E). If Task C exports `getConfluenceSourceStatuses` only from `@flowradar/db` and not `@flowradar/providers`, change the import path to a same-package relative import instead (`from '../../<path>'`) — verify with the grep above before compiling.

- [ ] **Step 4: Export the helper from the db barrel.**
  Add to `packages/db/src/index.ts` (additive, next to the social-query exports):
  ```ts
  export * from './confluence/queries';
  ```
  Confirm the social queries are exported the same way and match that style exactly.

- [ ] **Step 5: Re-run the DB test — expect PASS.**
  ```
  npx vitest run packages/db/test/confluenceQueries.test.ts
  ```
  Expected: 4 passing (latest-per-type, non-ok surfaced, null-for-absent, source-statuses present). If it still errors on the `@flowradar/providers` import, the source-status export path is wrong — fix per the Step 3 note and re-run.

- [ ] **Step 6: Commit the query helper.**
  ```
  git add packages/db/src/confluence/queries.ts packages/db/src/index.ts packages/db/test/confluenceQueries.test.ts
  git commit -m "feat(confluence): getTokenConfluence read helper (latest snapshot per type + source statuses)"
  ```

- [ ] **Step 7: Write the failing web source-text test for `ConfluencePanel`.**
  Create `apps/web/test/confluencePanel.test.ts`, matching `tokenSocialSection.test.ts` / `framingBanner.test.ts` verbatim (raw source-text checks — apps/web has no JSX transform). REAL code:
  ```ts
  // FlowRadar — token-detail Confluence panel wiring test (Task E).
  //
  // apps/web ships no React/JSX render harness (vitest here has no JSX
  // transform — see framingBanner.test.ts / tokenSocialSection.test.ts). Per
  // that convention this is a Node-only source-text check proving the
  // SHADOW-ONLY Confluence panel is (a) wired into the token page from real
  // getTokenConfluence data and (b) implements the honest-absence +
  // provider-claimed-labeling + conflict-aware + never-"safe" + no-secret
  // behaviors the design doc requires. Files are read as raw text (importing
  // .tsx errors under the Node transform), matching the sibling tests exactly.
  import { describe, expect, it } from 'vitest';
  import { readFileSync } from 'node:fs';
  import { fileURLToPath } from 'node:url';
  import path from 'node:path';

  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const APP_ROOT = path.resolve(HERE, '..');

  const pageSrc = readFileSync(
    path.join(APP_ROOT, 'app', 'tokens', '[id]', 'page.tsx'),
    'utf-8',
  ).replace(/\r\n/g, '\n');
  const compSrc = readFileSync(
    path.join(APP_ROOT, 'components', 'tokens', 'ConfluencePanel.tsx'),
    'utf-8',
  ).replace(/\r\n/g, '\n');

  describe('token-detail Confluence panel (Task E)', () => {
    it('page fetches confluence via getTokenConfluence(prisma, token.id)', () => {
      expect(pageSrc).toMatch(/getTokenConfluence\(\s*prisma\s*,\s*token\.id\s*\)/);
    });

    it('page renders <ConfluencePanel /> and passes the confluence data', () => {
      expect(pageSrc).toMatch(/<ConfluencePanel\b/);
      expect(pageSrc).toMatch(/confluence=\{/);
    });

    it('panel is a server component (no client directive — read-only display)', () => {
      expect(compSrc).not.toMatch(/^['"]use client['"]/m);
    });

    it('panel renders all five confluence cards', () => {
      expect(compSrc).toMatch(/Liquidity Risk/);
      expect(compSrc).toMatch(/Holder Risk/);
      expect(compSrc).toMatch(/CLOBr/);
      expect(compSrc).toMatch(/GMGN/);
      expect(compSrc).toMatch(/AG Paper/);
    });

    it('panel renders the Social + Wallet + External overlap summary', () => {
      expect(compSrc).toMatch(/overlap/i);
    });

    it('panel labels shadow-only and not-part-of-FlowScore', () => {
      expect(compSrc).toMatch(/shadow-only/i);
      expect(compSrc).toMatch(/not part of FlowScore/i);
    });

    it('panel labels provider-claimed metrics distinctly from internal/computed', () => {
      expect(compSrc).toMatch(/provider-claimed/i);
    });

    it('panel renders unavailable/missing/stub states honestly and NEVER "safe"/"clean"', () => {
      // The absent/stub/plan-required states must be surfaced as unknown/unavailable.
      expect(compSrc).toMatch(/unavailable|unknown|not integrated|plan.?required/i);
      // Constraint 15: absence of data is NEVER a green light. The word "safe"/"clean"
      // as a verdict must not appear in the panel source.
      expect(compSrc).not.toMatch(/\b(safe|clean)\b/i);
    });

    it('panel is conflict-aware — surfaces source disagreement, not only confirmation', () => {
      expect(compSrc).toMatch(/disagree/i);
    });

    it('panel renders an honest empty state when there is no confluence at all', () => {
      expect(compSrc).toMatch(/No confluence/i);
    });

    it('panel never renders a resolved secret (env NAME only, never a value assignment)', () => {
      // apiKeyEnvName is a NAME; the panel must not interpolate process.env values.
      expect(compSrc).not.toMatch(/process\.env/);
    });
  });
  ```

- [ ] **Step 8: Run the web test — expect FAIL.**
  ```
  npx vitest run apps/web/test/confluencePanel.test.ts
  ```
  Expected: FAIL — `ENOENT` on `components/tokens/ConfluencePanel.tsx` (component absent) plus the `page.tsx` wiring assertions failing.

- [ ] **Step 9: Implement `ConfluencePanel.tsx` (real, complete JSX).**
  Create `apps/web/components/tokens/ConfluencePanel.tsx`. Match `SocialSection.tsx` conventions exactly (named export, no `'use client'`, `Card`/`CardHeader`/`CardTitle`/`CardContent`, `Badge`, `fmtUsd`/`fmtPct`/`fmtAge`, `text-muted-foreground`, `tabular-nums`). Full code:

  ```tsx
  import { Badge } from '@/components/ui/badge';
  import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
  import { fmtAge, fmtPct, fmtUsd } from '@/lib/format';
  import type { TokenConfluence, ConfluenceSnapshotRow } from '@flowradar/db';

  export interface ConfluencePanelProps {
    confluence: TokenConfluence;
  }

  // --- state labelling ------------------------------------------------------
  // A card's status maps to an honest verdict badge. Constraint 15: absence of
  // data (unavailable / missing_key / plan_required / stub / no-row) is NEVER
  // rendered as "safe"/"clean" — only "ok" (data present) shows real values,
  // everything else is a plainly-flagged not-available state.
  const STATUS_LABEL: Record<string, string> = {
    ok: 'data present',
    unavailable: 'unavailable',
    missing_key: 'key not configured',
    plan_required: 'plan required',
    rate_limited: 'rate limited',
    error: 'error',
    stub: 'not integrated',
  };

  const STATUS_BADGE_CLASS: Record<string, string> = {
    ok: 'border-transparent bg-emerald-500/15 text-emerald-300',
    unavailable: 'border-transparent bg-zinc-700/40 text-zinc-400',
    missing_key: 'border-transparent bg-amber-500/15 text-amber-400',
    plan_required: 'border-transparent bg-amber-500/15 text-amber-400',
    rate_limited: 'border-transparent bg-amber-500/15 text-amber-400',
    error: 'border-transparent bg-red-500/15 text-red-400',
    stub: 'border-transparent bg-zinc-700/40 text-zinc-400',
  };

  function statusLabel(status: string | null): string {
    if (!status) return 'unknown — no data';
    return STATUS_LABEL[status] ?? 'unknown';
  }
  function statusBadgeClass(status: string | null): string {
    if (!status) return 'border-transparent bg-zinc-700/40 text-zinc-400';
    return STATUS_BADGE_CLASS[status] ?? 'border-transparent bg-zinc-700/40 text-zinc-400';
  }

  const SHADOW_BADGE = 'border-transparent bg-zinc-800/50 text-zinc-400';
  const PROVIDER_CLAIMED_BADGE = 'border-transparent bg-sky-500/15 text-sky-300';

  /** Small numeric/text row inside a card body. */
  function Stat({ label, value }: { label: string; value: string }) {
    return (
      <div>
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="font-medium tabular-nums">{value}</div>
      </div>
    );
  }

  /** A card header with the "not part of FlowScore" shadow badge always shown. */
  function CardHead({
    title,
    snapshot,
    providerClaimed,
  }: {
    title: string;
    snapshot: ConfluenceSnapshotRow | null;
    providerClaimed: boolean;
  }) {
    return (
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle>{title}</CardTitle>
          <Badge className={statusBadgeClass(snapshot?.status ?? null)}>
            {statusLabel(snapshot?.status ?? null)}
          </Badge>
          <Badge className={SHADOW_BADGE}>shadow-only · not part of FlowScore</Badge>
          {providerClaimed && <Badge className={PROVIDER_CLAIMED_BADGE}>provider-claimed</Badge>}
        </div>
      </CardHeader>
    );
  }

  /** Honest "we have no data" body used by every card whose snapshot is null or non-ok. */
  function UnavailableBody({ snapshot, providerClaimed }: { snapshot: ConfluenceSnapshotRow | null; providerClaimed: boolean }) {
    // NEVER a reassuring verdict — this is explicitly the absence-of-data path.
    const reason =
      snapshot === null
        ? 'No data collected for this token yet.'
        : `Status: ${statusLabel(snapshot.status)} — data not available. Absence of data is not a clearance.`;
    return (
      <p className="text-sm text-muted-foreground">
        {reason}
        {providerClaimed && ' This is an external, provider-claimed source, not a FlowRadar-computed metric.'}
      </p>
    );
  }

  function n(v: unknown): number | null {
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  }
  function s(v: unknown): string | null {
    return typeof v === 'string' ? v : null;
  }

  // --- Liquidity Risk (internal, FlowRadar-computed) ------------------------
  function LiquidityRiskCard({ snapshot }: { snapshot: ConfluenceSnapshotRow | null }) {
    if (!snapshot || snapshot.status !== 'ok') {
      return (
        <Card>
          <CardHead title="Liquidity Risk" snapshot={snapshot} providerClaimed={false} />
          <CardContent><UnavailableBody snapshot={snapshot} providerClaimed={false} /></CardContent>
        </Card>
      );
    }
    const d = snapshot.dataJson;
    const ratio = n(d.liquidityToMcapRatio);
    const slippage = n(d.estimatedOneWaySlippagePct);
    const dumpToHalve = n(d.dumpToHalveUsd);
    const maxPos = n(d.positionSizeMaxFor2PctSlippageUsd);
    const absBand = s(d.absoluteLiquidityBand) ?? 'unknown';
    const fragBand = s(d.ratioFragilityBand) ?? 'unknown';
    const confidence = s(d.confidence) ?? 'low';
    const caveats = Array.isArray(d.caveats) ? (d.caveats as unknown[]).filter((c): c is string => typeof c === 'string') : [];
    return (
      <Card>
        <CardHead title="Liquidity Risk" snapshot={snapshot} providerClaimed={false} />
        <CardContent>
          <div className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
            <Stat label="Liquidity / MCap" value={ratio === null ? 'unknown' : fmtPct(ratio * 100)} />
            <Stat label="Fragility" value={fragBand} />
            <Stat label="Depth band" value={absBand} />
            <Stat label="Est. 1-way slippage" value={slippage === null ? 'unknown' : fmtPct(slippage)} />
            <Stat label="Dump-to-halve" value={dumpToHalve === null ? 'unknown' : fmtUsd(dumpToHalve)} />
            <Stat label="Max size @ ~2% slip" value={maxPos === null ? 'unknown' : fmtUsd(maxPos)} />
            <Stat label="Confidence" value={confidence} />
          </div>
          {caveats.length > 0 && (
            <ul className="mt-3 flex flex-col gap-1 text-xs text-amber-400/90">
              {caveats.map((c, i) => (
                <li key={i}>⚠ {c}</li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-xs text-muted-foreground">
            Internal FlowRadar estimate from displayed liquidity + market cap (CPMM identities). Fragility describes structure, not a buy/sell call.
          </p>
        </CardContent>
      </Card>
    );
  }

  // --- Holder Risk (HolderScan, provider-claimed / optional) ----------------
  function HolderRiskCard({ snapshot }: { snapshot: ConfluenceSnapshotRow | null }) {
    if (!snapshot || snapshot.status !== 'ok') {
      return (
        <Card>
          <CardHead title="Holder Risk" snapshot={snapshot} providerClaimed />
          <CardContent><UnavailableBody snapshot={snapshot} providerClaimed /></CardContent>
        </Card>
      );
    }
    const d = snapshot.dataJson;
    const holderCount = n(d.holderCount);
    const conc = n(d.topHolderConcentration);
    return (
      <Card>
        <CardHead title="Holder Risk" snapshot={snapshot} providerClaimed />
        <CardContent>
          <div className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
            <Stat label="Holders" value={holderCount === null ? 'unknown' : holderCount.toLocaleString()} />
            <Stat label="Top-holder share" value={conc === null ? 'unknown' : fmtPct(conc)} />
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Provider-claimed (HolderScan) — shown alongside, and independent of, FlowRadar&apos;s own concentration risk. Not part of FlowScore.
          </p>
        </CardContent>
      </Card>
    );
  }

  // --- CLOBr (liquidity map, stub) ------------------------------------------
  function ClobrCard({ snapshot }: { snapshot: ConfluenceSnapshotRow | null }) {
    return (
      <Card>
        <CardHead title="CLOBr liquidity map" snapshot={snapshot} providerClaimed />
        <CardContent><UnavailableBody snapshot={snapshot} providerClaimed /></CardContent>
      </Card>
    );
  }

  // --- GMGN (external intel, query-only / stub) -----------------------------
  function GmgnCard({ snapshot }: { snapshot: ConfluenceSnapshotRow | null }) {
    if (!snapshot || snapshot.status !== 'ok') {
      return (
        <Card>
          <CardHead title="GMGN external intel" snapshot={snapshot} providerClaimed />
          <CardContent><UnavailableBody snapshot={snapshot} providerClaimed /></CardContent>
        </Card>
      );
    }
    const d = snapshot.dataJson;
    const labels = Array.isArray(d.labels) ? (d.labels as unknown[]).filter((x): x is string => typeof x === 'string') : [];
    return (
      <Card>
        <CardHead title="GMGN external intel" snapshot={snapshot} providerClaimed />
        <CardContent>
          {labels.length === 0 ? (
            <p className="text-sm text-muted-foreground">No provider-claimed labels returned.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {labels.map((l, i) => (
                <Badge key={i} className={PROVIDER_CLAIMED_BADGE}>{l}</Badge>
              ))}
            </div>
          )}
          <p className="mt-2 text-xs text-muted-foreground">
            Query-only, provider-claimed labels — never asserted as fact, never a scoring input. Not part of FlowScore.
          </p>
        </CardContent>
      </Card>
    );
  }

  // --- AG Paper (paper-trade observation, manual/stub) ----------------------
  function AgPaperCard({ snapshot }: { snapshot: ConfluenceSnapshotRow | null }) {
    if (!snapshot || snapshot.status !== 'ok') {
      return (
        <Card>
          <CardHead title="AG Paper observations" snapshot={snapshot} providerClaimed={false} />
          <CardContent><UnavailableBody snapshot={snapshot} providerClaimed={false} /></CardContent>
        </Card>
      );
    }
    const d = snapshot.dataJson;
    const pnl = n(d.paperPnlPct);
    return (
      <Card>
        <CardHead title="AG Paper observations" snapshot={snapshot} providerClaimed={false} />
        <CardContent>
          <div className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
            <Stat label="Paper PnL" value={pnl === null ? 'unknown' : fmtPct(pnl)} />
            <Stat label="Observed" value={`${fmtAge(snapshot.observedAt)} ago`} />
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Manual paper-journal observation — never a real execution, never a recommendation. Not part of FlowScore.
          </p>
        </CardContent>
      </Card>
    );
  }

  // --- Overlap summary (conflict-aware) -------------------------------------
  // Reads the shadow signals we already have and states agreement AND
  // disagreement between them. This is the ONE place that must surface conflict
  // ("smart-money accumulating but liquidity very fragile"), not just
  // confirmation. It derives nothing new for FlowScore — purely descriptive.
  function OverlapSummary({ confluence }: { confluence: TokenConfluence }) {
    const observations: string[] = [];
    const conflicts: string[] = [];

    const liq = confluence.liquidityRisk;
    if (liq && liq.status === 'ok') {
      const frag = s(liq.dataJson.ratioFragilityBand);
      if (frag === 'very_fragile' || frag === 'fragile') {
        conflicts.push(`Liquidity is ${frag.replace('_', ' ')} — a large exit would move price sharply.`);
      } else if (frag) {
        observations.push(`Liquidity structure: ${frag}.`);
      }
    }

    const gmgn = confluence.gmgn;
    if (gmgn && gmgn.status === 'ok') {
      const labels = Array.isArray(gmgn.dataJson.labels) ? (gmgn.dataJson.labels as unknown[]) : [];
      if (labels.length > 0) {
        observations.push(`GMGN (provider-claimed) labels present: ${labels.join(', ')}.`);
      }
    }

    const holder = confluence.holderRisk;
    if (holder && holder.status === 'ok') {
      const delta = holder.dataJson.holderDelta as Record<string, unknown> | undefined;
      const d24 = delta ? n(delta['24h']) : null;
      if (d24 !== null && d24 < 0) {
        conflicts.push('Holder count is declining (provider-claimed) — distribution, not accumulation.');
      }
    }

    // Cross-source disagreement: a bullish external label WHILE liquidity is fragile.
    const hasBullishLabel =
      gmgn?.status === 'ok' && Array.isArray(gmgn.dataJson.labels) &&
      (gmgn.dataJson.labels as unknown[]).some((l) => typeof l === 'string' && /smart|bull|trend/i.test(l));
    const fragile = liq?.status === 'ok' && (s(liq.dataJson.ratioFragilityBand) === 'very_fragile' || s(liq.dataJson.ratioFragilityBand) === 'fragile');
    if (hasBullishLabel && fragile) {
      conflicts.push('Sources disagree: external intel reads positive while liquidity structure is fragile.');
    }

    const nothing = observations.length === 0 && conflicts.length === 0;

    return (
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle>Social + Wallet + External overlap</CardTitle>
            <Badge className={SHADOW_BADGE}>shadow-only · not part of FlowScore</Badge>
            {conflicts.length > 0 && (
              <Badge className="border-transparent bg-red-500/15 text-red-400">⚠ sources disagree</Badge>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {nothing ? (
            <p className="text-sm text-muted-foreground">
              Not enough confluence evidence to compare sources yet. No agreement or disagreement can be asserted — this is not a clearance.
            </p>
          ) : (
            <div className="flex flex-col gap-3 text-sm">
              {conflicts.length > 0 && (
                <div>
                  <div className="mb-1 text-xs font-medium text-red-400">Disagreements / tensions</div>
                  <ul className="flex flex-col gap-1">
                    {conflicts.map((c, i) => (
                      <li key={i}>⚠ {c}</li>
                    ))}
                  </ul>
                </div>
              )}
              {observations.length > 0 && (
                <div>
                  <div className="mb-1 text-xs font-medium text-muted-foreground">Observations</div>
                  <ul className="flex flex-col gap-1">
                    {observations.map((o, i) => (
                      <li key={i}>{o}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
          <p className="mt-3 text-xs text-muted-foreground">
            Descriptive confluence only — surfaces disagreement between shadow sources, never a buy/sell call. Not part of FlowScore.
          </p>
        </CardContent>
      </Card>
    );
  }

  /**
   * Token-detail Confluence panel (Task E) — SHADOW-ONLY. Read-only server
   * component that renders the latest confluence evidence for one token:
   * internal Liquidity Risk (FlowRadar-computed) plus provider-claimed Holder
   * Risk / CLOBr / GMGN / AG Paper cards, and a conflict-aware overlap summary.
   *
   * Hard rules honored here: it changes no FlowScore/signal/wallet state; it
   * labels every card shadow-only / provider-claimed / not-part-of-FlowScore;
   * absence-of-data (null snapshot, or status stub/unavailable/missing_key/
   * plan_required) renders honestly as unavailable/unknown and NEVER as
   * safe/clean; it renders no resolved secret (only source NAMES from the
   * source-status rows); and it surfaces source disagreement, not only
   * confirmation.
   */
  export function ConfluencePanel({ confluence }: ConfluencePanelProps) {
    const { liquidityRisk, holderRisk, clobr, gmgn, agPaper, sourceStatuses } = confluence;

    const nothingAtAll =
      !liquidityRisk && !holderRisk && !clobr && !gmgn && !agPaper && sourceStatuses.length === 0;

    if (nothingAtAll) {
      return (
        <Card>
          <CardHeader>
            <CardTitle>Confluence</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              No confluence evidence for this token yet. This is an absence of data, not a clearance.
            </p>
          </CardContent>
        </Card>
      );
    }

    return (
      <div className="flex flex-col gap-4">
        <LiquidityRiskCard snapshot={liquidityRisk} />
        <HolderRiskCard snapshot={holderRisk} />
        <ClobrCard snapshot={clobr} />
        <GmgnCard snapshot={gmgn} />
        <AgPaperCard snapshot={agPaper} />
        <OverlapSummary confluence={confluence} />

        {sourceStatuses.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>Confluence source health</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="flex flex-col gap-2 text-sm">
                {sourceStatuses.map((row) => (
                  <li key={row.sourceName} className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{row.sourceName}</span>
                    <span className="text-xs text-muted-foreground">{row.provider}</span>
                    <Badge className={statusBadgeClass(row.mode)}>{row.mode}</Badge>
                    <span className="text-xs text-muted-foreground">{row.note}</span>
                    {row.apiKeyEnvName && (
                      <span className="text-xs text-muted-foreground">env: {row.apiKeyEnvName}</span>
                    )}
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}

        <p className="text-xs text-muted-foreground">
          Shadow-only confluence evidence — not part of FlowScore, the signal rules, or wallet scoring. Provider-claimed metrics are external claims, not verified facts; unavailable sources are shown as unknown, never as a clean/safe verdict.
        </p>
      </div>
    );
  }
  ```
  > The source-health badge line must be exactly `<Badge className={statusBadgeClass(row.mode)}>{row.mode}</Badge>` — `ConfluenceSourceMode` values `live/mock/missing_key/plan_required/stub/unavailable/error` all resolve through `STATUS_BADGE_CLASS`, defaulting to the neutral zinc class for `live`/`mock`.

- [ ] **Step 10: Wire `ConfluencePanel` additively into the token page — existing display byte-identical.**
  Edit `apps/web/app/tokens/[id]/page.tsx`. Three additive edits only; do NOT alter any existing line.
  (a) Add imports beside the social ones:
  ```ts
  import { getTokenConfluence } from '@flowradar/db';
  import { ConfluencePanel } from '@/components/tokens/ConfluencePanel';
  ```
  (b) Add `getTokenConfluence(prisma, token.id)` to the existing `Promise.all` array and its destructure. Change the destructure line from:
  ```ts
  const [chain, latestMarket, latestFlow, marketSeries, flowHistory, trades, socialMentions] =
    await Promise.all([
  ```
  to add `confluence` at the end (append `getTokenConfluence(prisma, token.id),` as the last array element, after `getTokenSocialMentions(prisma, token.id),`):
  ```ts
  const [chain, latestMarket, latestFlow, marketSeries, flowHistory, trades, socialMentions, confluence] =
    await Promise.all([
      // …existing entries unchanged…
      getTokenSocialMentions(prisma, token.id),
      getTokenConfluence(prisma, token.id),
    ]);
  ```
  (c) Add the render block AFTER the existing "Social mentions" `<div>…</div>` block and BEFORE the "Back to Tokens" `<p>`:
  ```tsx
  {/* Confluence (shadow-only external/internal evidence — Task E) */}
  <div>
    <h2 className="mb-3 text-lg font-medium tracking-tight">Confluence</h2>
    <ConfluencePanel confluence={confluence} />
  </div>
  ```

- [ ] **Step 11: Run the web test — expect PASS.**
  ```
  npx vitest run apps/web/test/confluencePanel.test.ts
  ```
  Expected: all assertions pass (wiring, five cards, overlap, shadow-only + not-part-of-FlowScore, provider-claimed, honest unavailable state, no `\bsafe\b`/`\bclean\b`, `disagree`, `No confluence`, no `process.env`). If the `\b(safe|clean)\b` assertion fails, a card copy still contains a "safe"/"clean" verdict word — reword it (the sanctioned copy above deliberately uses "clearance", "unavailable", "unknown" instead).

- [ ] **Step 12: Typecheck the two touched packages (no JSX-transform surprises).**
  ```
  npx tsc -p packages/db/tsconfig.json --noEmit
  npx tsc -p apps/web/tsconfig.json --noEmit
  ```
  Expected: no errors. In particular confirm `TokenConfluence`/`ConfluenceSnapshotRow` import cleanly from `@flowradar/db` into the client-safe web bundle (the query file imports only `@prisma/client` types + `@flowradar/providers` — no `node:` builtins leak into the `@flowradar/core` barrel, so the client bundle stays clean). If `@flowradar/db` does not re-export the types to `apps/web`, confirm Step 4's barrel export is present.

- [ ] **Step 13: Commit the panel + wiring.**
  ```
  git add apps/web/components/tokens/ConfluencePanel.tsx apps/web/app/tokens/[id]/page.tsx apps/web/test/confluencePanel.test.ts
  git commit -m "feat(confluence): token-detail Confluence panel (shadow-only, conflict-aware, honest-absence) + page wiring"
  ```

---

**Done Bar:**
- `npx vitest run packages/db/test/confluenceQueries.test.ts` passes with all 4 cases (latest-per-type; non-ok status surfaced verbatim; null for absent types; source statuses present) — NOT skipped (LITE Postgres on 5439 up).
- `npx vitest run apps/web/test/confluencePanel.test.ts` passes all cases, including the `\b(safe|clean)\b`-absent and `process.env`-absent negative assertions.
- `getTokenConfluence` returns `{ liquidityRisk, holderRisk, clobr, gmgn, agPaper, sourceStatuses }` with the canonical `snapshotType → card` mapping (`liquidity_map→clobr`, `external_intel→gmgn`, `paper_trade→agPaper`), latest `observedAt` per type, `null` where no row exists.
- `ConfluencePanel` is a server component (no `'use client'`), renders all five cards + overlap summary + source-health list, labels every card `shadow-only` / `not part of FlowScore`, tags provider-claimed sources distinctly, renders `⚠ sources disagree` when tensions exist, and shows an honest empty state.
- The existing token-page output is byte-identical except the three additive edits; `npx tsc -p apps/web/tsconfig.json --noEmit` and `npx tsc -p packages/db/tsconfig.json --noEmit` are clean.
- No `safe`/`clean` verdict word and no `process.env` reference in `ConfluencePanel.tsx`.

**Reviewer Focus:**
- **`unavailable ≠ safe` (constraint 15):** verify every non-`ok`/null snapshot path routes through `UnavailableBody`/"unknown"/"unavailable" copy and that no card ever prints a reassuring verdict — the negative test `not.toMatch(/\b(safe|clean)\b/i)` must genuinely be enforced, not defeated by re-wording that reintroduces "safe" elsewhere.
- **Provider-claimed labeling (constraint 16):** HolderScan/CLOBr/GMGN cards carry the `provider-claimed` badge and copy; Liquidity Risk (internal) and AG Paper (manual) must NOT be mislabeled as provider-claimed.
- **No-secret rendering (constraint 13):** the panel renders only source *names* + `apiKeyEnvName` (a NAME) — confirm no `process.env` deref and that `sourceStatuses` mode is derived by Task C as boolean presence, never a value.
- **Conflict-awareness (Module F):** the overlap summary must surface *disagreement* (fragile-liquidity-vs-bullish-label, declining-holders), not only positive confirmation — check the `conflicts[]` branch actually fires and shows `⚠ sources disagree`.
- **Additive-only page wiring:** the existing token-detail display is unchanged — the only edits are two imports, one `Promise.all` element + destructure, and one appended render block; no existing prop/query/JSX line is modified.
- **Shadow-only isolation:** `queries.ts` performs pure reads (`findFirst`/`getConfluenceSourceStatuses`) and writes nothing; no FlowScore/Signal/CandidateWallet/Token access; the query import chain pulls no `node:` builtin into the client bundle.

---

### Task F: Integration tests + verify + smokes + scope/secret gate

**Files:**

- **Create** `packages/db/test/externalConfluence.integration.test.ts` — end-to-end integration test for `runExternalConfluencePass` in MOCK_MODE (LiquidityRisk-from-market-data, all-external-keys-missing clean skip, never-creates-Token). Lands in the `db` vitest project (root `./packages/db`, include `test/**/*.test.ts`).
- **Create** `apps/worker/test/externalConfluenceScope.test.ts` — Node-only source-text scope/secret/Dune-guard gate + worker-job smoke (all-keys-missing skip + MOCK_MODE mock path). Lands in the `worker` vitest project (root `./apps/worker`, include `test/**/*.test.ts`).
- **Create** `apps/web/test/confluencePanelRoute.test.ts` — Node-only source-text smoke that the token-detail Confluence panel + source-status surface are wired into `app/tokens/[id]/page.tsx` from real data with honest unavailable/provider-claimed labels. Lands in the `web` vitest project.
- **Create** `scripts/confluence-gate.mjs` — a runnable scope/secret/Dune scan script (the objective gate the Done Bar asserts; also invoked by the reviewer).
- **Modify** none of the Task A–E implementation files. Task F adds **tests + one gate script only** — it must not edit `packages/core`, `packages/db/src`, `packages/providers`, `apps/web/app`, or `apps/worker/src`. (If a test fails, the fix belongs to the owning task, not Task F.)

**Interfaces:**

Consumes (exact signatures from earlier tasks — do not redefine, import them):
- From `@flowradar/db` (Task D): `runExternalConfluencePass(prisma, settings, resolveProvider, log)` where `resolveProvider: (source: ExternalConfluenceSource) => ConfluenceProvider | null` and `log` is the same console-logger shape every job passes. Returns Task D's canonical `ExternalConfluencePassResult`: `{ sourcesConsidered: number; sourcesSynced: number; sourcesSkippedDisabled: number; sourcesSkippedNoProvider: number; internalLiquiditySnapshots: number; externalSnapshotsUpserted: number; tokensConsidered: number; errors: number }` — use these exact field names in assertions.
- From `@flowradar/db` (Task E): `getTokenConfluence(prisma, tokenId)`.
- From `@flowradar/providers` (Task C): `MockConfluenceProvider`, `getConfluenceSourceStatuses(prisma)`, `createHolderScanProvider(env)`, `createClobrProvider(env)`, `createGmgnProvider(env)`, `createAgPaperProvider()`, and types `ConfluenceProvider`, `ConfluenceFetchResult`, `ConfluenceSourceStatusRow`, `ConfluenceSourceMode`.
- From `@flowradar/core` (Task A): `DEFAULT_SETTINGS`, `computeLiquidityRisk`, types `Chain`, `LiquidityRiskInput/Config/Result`.
- Prisma models (Task B): `TokenConfluenceSnapshot`, `ExternalConfluenceSource`, plus existing `Token`, `TokenMarketSnapshot`, `Chain`.

Produces (names later tasks / the reviewer rely on): `scripts/confluence-gate.mjs` (exit 0 = clean; prints `SCOPE OK`, `SECRETS OK`, `DUNE-EXECUTE OK`). No exported code symbols — this task ships only tests + a gate script.

- [ ] **Step 1: Read the three earlier tasks' real exports before writing any test.** Run these and note the EXACT symbol/field names the tests must import and assert on (do not guess — the count-field names below are placeholders until confirmed):
  ```
  npx tsc -b packages/core packages/db packages/providers apps/web apps/worker
  npm run db:migrate
  ```
  Expected: `tsc` exits 0 (Tasks A–E already compile); `db:migrate` starts embedded PG on :5439 and applies the Task B migration (idempotent). Read `packages/db/src/confluence/ingest.ts` for the `runExternalConfluencePass` result type, `packages/db/src/confluence/queries.ts` for `getTokenConfluence`'s return shape, and `packages/providers/src/confluence/index.ts` for the exact barrel exports. Adjust identifiers in Steps 2–8 to match.

- [ ] **Step 2: Write the failing DB integration test — LiquidityRisk computed from seeded market data.** Create `packages/db/test/externalConfluence.integration.test.ts` with the header + harness (probePort/prefix-cleanup/serialized, mirroring `socialIngest.test.ts` and `externalWalletSource.test.ts` exactly), and the first case. This is the "internal LiquidityRisk snapshot from `TokenMarketSnapshot`" leg:

  ```ts
  // FlowRadar — runExternalConfluencePass end-to-end integration (Task F,
  // External Confluence, design §Worker integration). Same LITE-Postgres
  // pattern as socialIngest.test.ts / externalWalletSource.test.ts:
  // probePort(:5439) skipIf, prefix-scoped cleanup, serialized db project.
  //
  // SHADOW-ONLY (design global rules 1/2/6): asserts the pass computes an
  // INTERNAL liquidity_risk snapshot from existing market data, records
  // external-source statuses honestly (missing_key/stub/unavailable, NEVER
  // "safe"), and NEVER creates Token / Signal / Alert / CandidateWallet rows.
  import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
  import net from 'node:net';
  import { DEFAULT_SETTINGS, computeLiquidityRisk } from '@flowradar/core';
  import type { Chain } from '@flowradar/core';
  import type { ConfluenceProvider, ConfluenceFetchResult } from '@flowradar/providers';
  import { MockConfluenceProvider } from '@flowradar/providers';
  import { prisma } from '../src/client';
  import { runExternalConfluencePass } from '../src/confluence/ingest';

  const ADDR_PREFIX = 'TFconfAddr';
  const SOURCE_PREFIX = 'TFconfSource';

  function probePort(host: string, port: number, timeoutMs = 1000): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = net.createConnection({ host, port });
      const done = (ok: boolean) => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(ok);
      };
      socket.setTimeout(timeoutMs);
      socket.once('connect', () => done(true));
      socket.once('timeout', () => done(false));
      socket.once('error', () => done(false));
    });
  }

  let dbReachable = false;

  beforeAll(async () => {
    dbReachable = await probePort('localhost', 5439);
    if (!dbReachable) {
      // eslint-disable-next-line no-console
      console.warn(
        '[externalConfluence.integration.test] LITE Postgres not reachable on localhost:5439 — ' +
          'skipping. Run `npm run db:migrate` first to exercise this suite.'
      );
    }
  });

  async function cleanup(): Promise<void> {
    await prisma.tokenConfluenceSnapshot.deleteMany({ where: { tokenAddress: { startsWith: ADDR_PREFIX } } });
    await prisma.externalConfluenceSource.deleteMany({ where: { name: { startsWith: SOURCE_PREFIX } } });
    await prisma.token.deleteMany({ where: { address: { startsWith: ADDR_PREFIX } } });
  }

  afterAll(async () => {
    if (!dbReachable) return;
    await cleanup();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    if (!dbReachable) return;
    await cleanup();
  });

  /** Deterministic fake provider — records fetch call count + status returned, never touches network. */
  function makeStubConfluenceProvider(
    provider: string,
    snapshotType: string,
    result: ConfluenceFetchResult
  ): ConfluenceProvider & { callCount: number } {
    return {
      name: `fake-${provider}`,
      provider,
      snapshotType,
      chains: ['SOLANA'] as Chain[],
      callCount: 0,
      async fetchForToken(_chain: Chain, _tokenAddress: string) {
        this.callCount += 1;
        return result;
      }
    };
  }

  async function makeSourceRow(
    name: string,
    overrides: Partial<{ enabled: boolean; provider: string; apiKeyEnvName: string | null }> = {}
  ) {
    return prisma.externalConfluenceSource.create({
      data: {
        name,
        provider: overrides.provider ?? 'holderscan',
        enabled: overrides.enabled ?? true,
        apiKeyEnvName: overrides.apiKeyEnvName ?? 'HOLDERSCAN_API_KEY',
        rateLimitPerMinute: 30
      }
    });
  }

  /** Seeds a Token + one latest TokenMarketSnapshot (the LiquidityRisk inputs). */
  async function seedTokenWithMarket(
    addressSuffix: string,
    liquidityUsd: number,
    marketCapUsd: number
  ) {
    const address = `${ADDR_PREFIX}${addressSuffix}`;
    const token = await prisma.token.create({
      data: {
        chain: 'SOLANA',
        address,
        symbol: 'TFCONF',
        name: 'Task F Confluence Token',
        decimals: 9,
        firstSeenAt: new Date(),
        riskFlags: []
      }
    });
    await prisma.tokenMarketSnapshot.create({
      data: {
        tokenId: token.id,
        ts: new Date(),
        priceUsd: 1,
        marketCapUsd,
        fdvUsd: marketCapUsd,
        liquidityUsd,
        vol5m: 0,
        vol1h: 0,
        vol6h: 0,
        vol24h: 0,
        holderCount: 100,
        source: 'test'
      }
    });
    return { token, address };
  }

  describe.skipIf(!(await probePort('localhost', 5439)))('runExternalConfluencePass (Task F end-to-end)', () => {
    it('computes an INTERNAL liquidity_risk snapshot from the latest TokenMarketSnapshot (matches computeLiquidityRisk)', async () => {
      const L = 100_000;
      const MC = 1_000_000;
      const { token, address } = await seedTokenWithMarket('LR1', L, MC);

      // No external sources at all — the internal LiquidityRisk leg runs
      // regardless of any provider.
      const result = await runExternalConfluencePass(prisma, DEFAULT_SETTINGS, () => null, undefined);
      expect(result.errors).toBe(0);

      const snap = await prisma.tokenConfluenceSnapshot.findFirst({
        where: { tokenAddress: address, snapshotType: 'liquidity_risk', provider: 'internal' }
      });
      expect(snap).not.toBeNull();
      expect(snap!.sourceId).toBeNull(); // internal snapshot has no source
      expect(snap!.tokenId).toBe(token.id); // linked to the existing Token
      expect(snap!.status).toBe('ok');

      // The stored dataJson must equal the pure computeLiquidityRisk output for
      // the same inputs + settings-config (design: internal, deterministic).
      const cfg = {
        absoluteLiquidityBandsUsd:
          DEFAULT_SETTINGS.connectors.externalConfluence.liquidityRisk.absoluteLiquidityBandsUsd,
        ratioFragilityBands:
          DEFAULT_SETTINGS.connectors.externalConfluence.liquidityRisk.ratioFragilityBands
      };
      const expected = computeLiquidityRisk(
        {
          displayedLiquidityUsd: L,
          marketCapUsd: MC,
          positionSizeUsd: DEFAULT_SETTINGS.connectors.externalConfluence.liquidityRisk.positionSizeUsd,
          poolType: 'unknown'
        },
        cfg
      );
      const data = snap!.dataJson as Record<string, unknown>;
      expect(data.liquidityToMcapRatio).toBeCloseTo(expected.liquidityToMcapRatio!, 10);
      expect(data.absoluteLiquidityBand).toBe(expected.absoluteLiquidityBand);
      expect(data.ratioFragilityBand).toBe(expected.ratioFragilityBand);
      // Sanity: ratio 0.1 -> the identities the design fixes.
      expect(expected.liquidityToMcapRatio).toBeCloseTo(0.1, 10);
      expect(expected.dumpToHalveUsd).toBeCloseTo(0.207 * L, 6);
    });
  });
  ```
  Run: `npx vitest run packages/db/test/externalConfluence.integration.test.ts`
  Expected: **FAIL** (the case body runs against a real Task D `runExternalConfluencePass`; if Task D is complete it may pass immediately — that is acceptable, the point is a non-vacuous assertion against real code. If Task D is not yet merged the import fails to resolve = FAIL). Do not proceed until the first case is GREEN with Task D present.

- [ ] **Step 3: Run + confirm the first case passes against real Task D code.** Run: `npx vitest run packages/db/test/externalConfluence.integration.test.ts`
  Expected: **PASS** (1 test). Commit:
  ```
  git add packages/db/test/externalConfluence.integration.test.ts
  git commit -m "test(confluence): internal LiquidityRisk-from-market-data integration case (Task F)"
  ```

- [ ] **Step 4: Add the "all external keys missing => clean skip, sources recorded honestly, never safe" case.** Append inside the same `describe`:

  ```ts
  it('all external keys missing: every external source is a clean skip (missing_key/stub), no external snapshot claims "safe"', async () => {
    const { address } = await seedTokenWithMarket('SKIP1', 50_000, 2_000_000);

    // Two enabled external sources whose real live factories would return null
    // when their key env var is absent — the resolver here returns null for
    // both (simulating no keys), the design's graceful per-source skip.
    await makeSourceRow(`${SOURCE_PREFIX}_holderscan`, { provider: 'holderscan', apiKeyEnvName: 'HOLDERSCAN_API_KEY' });
    await makeSourceRow(`${SOURCE_PREFIX}_gmgn`, { provider: 'gmgn', apiKeyEnvName: 'GMGN_API_KEY' });

    const result = await runExternalConfluencePass(prisma, DEFAULT_SETTINGS, () => null, undefined);

    // Never throws; the internal LiquidityRisk leg still ran.
    expect(result.errors).toBe(0);
    expect(result.sourcesSkippedNoProvider).toBeGreaterThanOrEqual(2);

    const internal = await prisma.tokenConfluenceSnapshot.findFirst({
      where: { tokenAddress: address, snapshotType: 'liquidity_risk', provider: 'internal' }
    });
    expect(internal).not.toBeNull(); // internal leg is key-free, always present

    // The unavailable-not-safe principle: no snapshot from a skipped external
    // source may carry status "ok" — absence of data is never a green light.
    const externalSnaps = await prisma.tokenConfluenceSnapshot.findMany({
      where: { tokenAddress: address, provider: { in: ['holderscan', 'gmgn'] } }
    });
    for (const s of externalSnaps) {
      expect(['missing_key', 'plan_required', 'stub', 'unavailable', 'error']).toContain(s.status);
      expect(s.status).not.toBe('ok');
    }

    // Source-health rows reflect a non-live, non-error skip state — never "ok"/"live".
    const sourceRows = await prisma.externalConfluenceSource.findMany({
      where: { name: { startsWith: SOURCE_PREFIX } }
    });
    for (const r of sourceRows) {
      expect(['missing_key', 'plan_required', 'stub', 'unavailable', 'idle']).toContain(r.status);
    }
  });

  it('never creates Token / Signal / Alert / CandidateWallet rows for an address not already in the DB', async () => {
    // A mock provider that WOULD return ok data for any token — but the pass
    // must only fetch for tokens already in the DB, never discover-and-create.
    const okResult: ConfluenceFetchResult = {
      status: 'ok',
      dataJson: { providerClaimed: true, trending: true },
      observedAt: new Date()
    };
    const fake = makeStubConfluenceProvider('gmgn', 'external_intel', okResult);
    await makeSourceRow(`${SOURCE_PREFIX}_gmgn2`, { provider: 'gmgn', apiKeyEnvName: 'GMGN_API_KEY' });

    const tokenCountBefore = await prisma.token.count();
    const signalCountBefore = await prisma.signal.count();
    const candidateCountBefore = await prisma.candidateWallet.count();

    // No Token seeded here (the SKIP-scoped ones are cleaned between tests) —
    // so there is nothing for the provider to be fetched against.
    const result = await runExternalConfluencePass(prisma, DEFAULT_SETTINGS, () => fake, undefined);
    expect(result.errors).toBe(0);

    expect(await prisma.token.count()).toBe(tokenCountBefore);   // no Token created
    expect(await prisma.signal.count()).toBe(signalCountBefore); // no Signal
    expect(await prisma.candidateWallet.count()).toBe(candidateCountBefore); // no CandidateWallet
    // The fake never fetched for a non-existent token (known-tokens-only).
    const snaps = await prisma.tokenConfluenceSnapshot.findMany({
      where: { provider: 'gmgn', dataJson: { path: ['trending'], equals: true } }
    });
    expect(snaps.every((s) => s.tokenId !== null || s.tokenAddress.startsWith(ADDR_PREFIX) === false)).toBe(true);
  });
  ```
  Run: `npx vitest run packages/db/test/externalConfluence.integration.test.ts`
  Expected: **PASS** (3 tests). Commit:
  ```
  git add packages/db/test/externalConfluence.integration.test.ts
  git commit -m "test(confluence): all-keys-missing clean skip + never-creates-Token cases (Task F)"
  ```

- [ ] **Step 5: Add the MOCK_MODE `MockConfluenceProvider` end-to-end case + provider-claimed labeling + `getTokenConfluence` read-through.** Append inside the same `describe`:

  ```ts
  it('MOCK_MODE: a real MockConfluenceProvider produces an ok, provider-claimed snapshot for a KNOWN token, read back via getTokenConfluence', async () => {
    const { token, address } = await seedTokenWithMarket('MOCK1', 120_000, 3_000_000);
    await makeSourceRow(`${SOURCE_PREFIX}_mockgmgn`, { provider: 'gmgn', apiKeyEnvName: 'GMGN_API_KEY' });

    // The real mock (same instance the worker's MOCK_MODE path uses) — resolve
    // it for the enabled source, exactly as the job does in mock mode.
    const mock: ConfluenceProvider = new MockConfluenceProvider();
    const result = await runExternalConfluencePass(prisma, DEFAULT_SETTINGS, () => mock, undefined);
    expect(result.errors).toBe(0);

    const external = await prisma.tokenConfluenceSnapshot.findFirst({
      where: { tokenAddress: address, provider: { not: 'internal' } }
    });
    expect(external).not.toBeNull();
    expect(external!.status).toBe('ok');
    expect(external!.tokenId).toBe(token.id); // linked to the existing Token, not created
    // Provider-claimed labeling lives in dataJson (design rule 16) — the mock
    // marks its metrics as provider-claimed, distinct from the internal leg.
    const data = external!.dataJson as Record<string, unknown>;
    expect(data.providerClaimed).toBe(true);

    // dataJson carries NO secret — no key-shaped value (design rule 13 / security).
    const serialized = JSON.stringify(external!.dataJson);
    expect(serialized).not.toMatch(/API_KEY|apiKey|secret|Bearer\s/i);
  });
  ```

  Then add the read-through case (only if `getTokenConfluence` is exported by Task E — guard with a `describe` that imports it; if Task E is not yet merged, split this into its own file. Assume Task E present):

  ```ts
  it('getTokenConfluence returns the internal liquidityRisk snapshot + source statuses for a token', async () => {
    const { token, address } = await seedTokenWithMarket('READ1', 90_000, 1_500_000);
    await makeSourceRow(`${SOURCE_PREFIX}_readgmgn`, { provider: 'gmgn', apiKeyEnvName: 'GMGN_API_KEY' });
    const mock = new MockConfluenceProvider();
    await runExternalConfluencePass(prisma, DEFAULT_SETTINGS, () => mock, undefined);

    const { getTokenConfluence } = await import('../src/confluence/queries');
    const view = await getTokenConfluence(prisma, token.id);
    expect(view.liquidityRisk).not.toBeNull();
    expect(view.liquidityRisk!.status).toBe('ok');
    expect(Array.isArray(view.sourceStatuses)).toBe(true);
    void address;
  });
  ```
  Run: `npx vitest run packages/db/test/externalConfluence.integration.test.ts`
  Expected: **PASS** (5 tests). Commit:
  ```
  git add packages/db/test/externalConfluence.integration.test.ts
  git commit -m "test(confluence): MOCK_MODE mock-provider e2e + provider-claimed + getTokenConfluence read-through (Task F)"
  ```

- [ ] **Step 6: Write the worker source-text scope/secret/Dune gate + all-keys-missing worker-job smoke.** Create `apps/worker/test/externalConfluenceScope.test.ts`. This is a Node-only source-text check (the worker package has no DB harness of its own; it mirrors the web source-text convention and the design's grep-guard requirement). It (a) proves the worker job wires the internal LiquidityRisk + external fetch without any forbidden imports, (b) proves the GMGN adapter references zero swap/order/key/wallet endpoints, (c) proves the AG Paper adapter builds no parser, and (d) proves the whole confluence subtree touches no FlowScore/threshold/CandidateWallet/BSC/Dune-execute path:

  ```ts
  // FlowRadar — External Confluence scope / secret / query-only gate (Task F).
  //
  // Node-only source-text checks (this package has no DB/JSX render harness —
  // same convention as apps/web's framingBanner.test.ts). Enforces the design's
  // HARD global rules across the confluence subtree that no runtime test can
  // easily prove in one place: shadow-only (no FlowScore/threshold/wallet-
  // scoring/CandidateWallet writes), GMGN query-only (zero swap/order/key/
  // wallet endpoints), AG Paper stub-only (no import parser), no BSC, no Dune
  // fresh execution, and no committed secret values.
  import { describe, expect, it } from 'vitest';
  import { readFileSync, existsSync } from 'node:fs';
  import { fileURLToPath } from 'node:url';
  import path from 'node:path';

  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const REPO_ROOT = path.resolve(HERE, '..', '..', '..');

  function read(rel: string): string {
    return readFileSync(path.join(REPO_ROOT, rel), 'utf-8').replace(/\r\n/g, '\n');
  }

  const workerJob = read('apps/worker/src/jobs/externalConfluence.ts');
  const ingest = read('packages/db/src/confluence/ingest.ts');
  const gmgn = read('packages/providers/src/confluence/gmgn.ts');
  const agPaper = read('packages/providers/src/confluence/agPaper.ts');
  const sourceStatus = read('packages/providers/src/confluence/sourceStatus.ts');

  describe('External Confluence — scope & secret gate (Task F)', () => {
    it('worker job never imports the outbound Telegram sender or FlowScore/signal/candidate writers', () => {
      expect(workerJob).not.toMatch(/telegram/i);
      expect(workerJob).not.toMatch(/flowScore|evaluateAllRules|walletScore/i);
      expect(workerJob).not.toMatch(/candidateWallet|CandidateWallet/);
    });

    it('worker job is registered on connectors.externalConfluence.syncHours (additive schedule)', () => {
      const bootstrap = read('apps/worker/src/index.ts');
      expect(bootstrap).toMatch(/externalConfluence/);
      expect(bootstrap).toMatch(/connectors\.externalConfluence\.syncHours/);
    });

    it('ingest never writes Token / Signal / Alert / CandidateWallet rows (shadow-only)', () => {
      expect(ingest).not.toMatch(/prisma\.token\.create|prisma\.token\.upsert/);
      expect(ingest).not.toMatch(/prisma\.signal\.(create|upsert)/i);
      expect(ingest).not.toMatch(/prisma\.alert\.(create|upsert)/i);
      expect(ingest).not.toMatch(/prisma\.candidateWallet\./i);
      // Links to an existing Token by findUnique/findMany only.
      expect(ingest).toMatch(/findUnique|findFirst|findMany/);
    });

    it('GMGN adapter is query-only: zero swap / order / private-key / wallet-management endpoints', () => {
      // Design Module D + rule 8: a grep guard asserting the forbidden verbs
      // never appear (case-insensitive) anywhere in the GMGN adapter source.
      const forbidden = /\b(swap|createOrder|placeOrder|order|privateKey|private_key|signTransaction|sendTransaction|walletManagement|transfer|withdraw)\b/i;
      expect(gmgn).not.toMatch(forbidden);
    });

    it('AG Paper adapter is stub-only: documents a CSV shape in a comment but builds NO parser', () => {
      // The CSV field names are documented (design Module E) ...
      expect(agPaper).toMatch(/paperEntryAt/);
      expect(agPaper).toMatch(/paperPnlPct/);
      // ... but no parsing/automation is implemented.
      expect(agPaper).not.toMatch(/\.split\(|csv-parse|papaparse|parseCsv|fetch\(/i);
      expect(agPaper).not.toMatch(/t\.me|telegram|clickButton|bot/i);
    });

    it('source-status derives key presence as a Boolean only — never a resolved process.env VALUE', () => {
      // Boolean presence check is allowed; returning the raw value is not.
      expect(sourceStatus).toMatch(/Boolean\(process\.env|process\.env\.[A-Z_]+\s*!?=?=?\s*undefined|in process\.env/);
      // No status row field is assigned the resolved secret value.
      expect(sourceStatus).not.toMatch(/apiKey:\s*process\.env|note:\s*process\.env/);
    });

    it('the whole confluence subtree references no BSC and no Dune fresh execution', () => {
      const files = [
        'packages/core/src/confluence/liquidityRisk.ts',
        'packages/providers/src/confluence/gmgn.ts',
        'packages/providers/src/confluence/holderscan.ts',
        'packages/providers/src/confluence/clobr.ts',
        'packages/db/src/confluence/ingest.ts',
        'apps/worker/src/jobs/externalConfluence.ts'
      ].filter((f) => existsSync(path.join(REPO_ROOT, f)));
      expect(files.length).toBeGreaterThanOrEqual(4); // sanity: the subtree exists
      for (const f of files) {
        const src = read(f);
        expect(src, `${f} must not reference BSC`).not.toMatch(/\bBSC\b|bscscan|chainid=56/i);
        expect(src, `${f} must not execute a fresh Dune query`).not.toMatch(/executeQuery|execute_fresh|DUNE_EXECUTE_FRESH\s*=\s*['"]?true/i);
      }
    });
  });
  ```
  Run: `npx vitest run apps/worker/test/externalConfluenceScope.test.ts`
  Expected: **FAIL first** if any Task C/D file drifts (e.g. GMGN accidentally references an order endpoint) — that is the guard working. With Tasks C/D correct: **PASS** (7 tests). Commit:
  ```
  git add apps/worker/test/externalConfluenceScope.test.ts
  git commit -m "test(confluence): worker scope + GMGN query-only + AG-Paper stub + BSC/Dune guards (Task F)"
  ```

- [ ] **Step 7: Write the web token-detail Confluence panel + source-status route smoke.** Create `apps/web/test/confluencePanelRoute.test.ts` (Node-only source-text, mirroring `tokenSocialSection.test.ts` exactly — apps/web has no JSX transform in vitest):

  ```ts
  // FlowRadar — token-detail Confluence panel wiring smoke (Task F). Node-only
  // source-text check (apps/web vitest has no JSX transform — see
  // framingBanner.test.ts / tokenSocialSection.test.ts headers). Proves the
  // shadow-only Confluence panel is (a) wired into the token page from real
  // getTokenConfluence data, (b) renders honest unavailable/provider-claimed/
  // not-part-of-FlowScore labels, and (c) never renders a resolved secret.
  import { describe, expect, it } from 'vitest';
  import { readFileSync } from 'node:fs';
  import { fileURLToPath } from 'node:url';
  import path from 'node:path';

  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const APP_ROOT = path.resolve(HERE, '..');

  const pageSrc = readFileSync(
    path.join(APP_ROOT, 'app', 'tokens', '[id]', 'page.tsx'),
    'utf-8'
  ).replace(/\r\n/g, '\n');
  const panelSrc = readFileSync(
    path.join(APP_ROOT, 'components', 'tokens', 'ConfluencePanel.tsx'),
    'utf-8'
  ).replace(/\r\n/g, '\n');

  describe('token-detail Confluence panel (Task F)', () => {
    it('page fetches this token\'s confluence via getTokenConfluence(prisma, token.id)', () => {
      expect(pageSrc).toMatch(/getTokenConfluence\(\s*prisma\s*,\s*token\.id\s*\)/);
    });

    it('page renders <ConfluencePanel /> (additive — the Social section is still present)', () => {
      expect(pageSrc).toMatch(/<ConfluencePanel\b/);
      expect(pageSrc).toMatch(/<SocialSection\b/); // did not remove the earlier section
    });

    it('panel labels every card shadow-only / not part of FlowScore (design Module F)', () => {
      expect(panelSrc).toMatch(/shadow-only/i);
      expect(panelSrc).toMatch(/not part of FlowScore/i);
    });

    it('panel distinguishes provider-claimed from internal/computed metrics', () => {
      expect(panelSrc).toMatch(/provider-claimed/i);
    });

    it('panel renders unavailable / missing / stub states honestly — never a "safe" verdict', () => {
      expect(panelSrc).toMatch(/unavailable|missing_key|plan[_ -]?required|stub/i);
      // The unavailable-not-safe principle: no card asserts "safe"/"clean".
      expect(panelSrc).not.toMatch(/\bsafe\b|\bclean\b/i);
    });

    it('panel surfaces source disagreement, not only confirmation', () => {
      expect(panelSrc).toMatch(/disagree|conflict|overlap/i);
    });

    it('panel never renders a resolved secret (env var NAME only, if any)', () => {
      expect(panelSrc).not.toMatch(/process\.env/);
    });

    it('ConfluencePanel is a server component (no client directive — read-only)', () => {
      expect(panelSrc).not.toMatch(/^['"]use client['"]/m);
    });
  });
  ```
  Run: `npx vitest run apps/web/test/confluencePanelRoute.test.ts`
  Expected: **FAIL first** if Task E's panel copy drifts (e.g. missing "not part of FlowScore"), else **PASS** (8 tests). Commit:
  ```
  git add apps/web/test/confluencePanelRoute.test.ts
  git commit -m "test(confluence): token-detail Confluence panel + source-status route smoke (Task F)"
  ```

- [ ] **Step 8: Write the runnable scope/secret/Dune gate script.** Create `scripts/confluence-gate.mjs` — the objective Done-Bar gate the reviewer runs (a git-diff scope check + secret scan + Dune-execute-0 scan, independent of vitest):

  ```js
  // FlowRadar — External Confluence final gate (Task F). Runnable scope/secret/
  // Dune scan over the confluence branch diff. Exit 0 = clean.
  //   node scripts/confluence-gate.mjs
  // Prints SCOPE OK / SECRETS OK / DUNE-EXECUTE OK, or the offending lines.
  import { execSync } from 'node:child_process';

  const BASE = process.env.CONFLUENCE_BASE_REF || 'main';
  function sh(cmd) {
    return execSync(cmd, { encoding: 'utf-8' });
  }

  // Files the confluence track is FORBIDDEN to touch (design global rules 2-5,
  // 8-12): FlowScore formula, signal thresholds, wallet scoring, CandidateWallet
  // validation/promotion, outbound Telegram, BSC adapters, Dune execution.
  const FORBIDDEN_PATHS = [
    /packages\/core\/src\/scoring\/flowScore\.ts$/,
    /packages\/core\/src\/scoring\/walletScore\.ts$/,
    /packages\/core\/src\/rules\//,
    /candidateValidation/i,
    /packages\/providers\/src\/telegram\.ts$/,
    /packages\/providers\/src\/(bsc|chains\/bsc)/i,
    /packages\/db\/src\/dune\//,
    /packages\/providers\/src\/candidates\/dune\//
  ];

  let failed = false;
  const changed = sh(`git diff --name-only ${BASE}...HEAD`).split('\n').filter(Boolean);
  const scopeViolations = changed.filter((f) => FORBIDDEN_PATHS.some((re) => re.test(f)));
  if (scopeViolations.length) {
    failed = true;
    console.error('SCOPE VIOLATION — confluence diff touched forbidden files:\n' + scopeViolations.join('\n'));
  } else {
    console.log('SCOPE OK — no FlowScore/threshold/wallet/CandidateWallet/telegram/BSC/Dune files changed');
  }

  // Secret scan: no resolved key VALUES committed in the diff. Env var NAMES
  // (HOLDERSCAN_API_KEY as a string literal) are allowed; assigned VALUES are not.
  const diff = sh(`git diff ${BASE}...HEAD`);
  const secretPatterns = [
    /apiKey\s*[:=]\s*['"][A-Za-z0-9_\-]{16,}['"]/,
    /(HOLDERSCAN|GMGN|CLOBR)_API_KEY\s*[:=]\s*['"][A-Za-z0-9_\-]{8,}['"]/,
    /Bearer\s+[A-Za-z0-9_\-]{16,}/
  ];
  const secretHits = diff
    .split('\n')
    .filter((l) => l.startsWith('+'))
    .filter((l) => secretPatterns.some((re) => re.test(l)));
  if (secretHits.length) {
    failed = true;
    console.error('SECRET SCAN FAILED — resolved-value-shaped strings in diff:\n' + secretHits.join('\n'));
  } else {
    console.log('SECRETS OK — no resolved key values committed (env var NAMES only)');
  }

  // Dune-execute-0: the confluence diff must never enable a fresh Dune execution.
  const duneHits = diff
    .split('\n')
    .filter((l) => l.startsWith('+'))
    .filter((l) => /DUNE_EXECUTE_FRESH\s*=\s*['"]?true|executeQuery\(|execute_fresh/i.test(l));
  if (duneHits.length) {
    failed = true;
    console.error('DUNE-EXECUTE VIOLATION — diff enables fresh Dune execution:\n' + duneHits.join('\n'));
  } else {
    console.log('DUNE-EXECUTE OK — Dune fresh execution count stays 0');
  }

  process.exit(failed ? 1 : 0);
  ```
  Run: `node scripts/confluence-gate.mjs`
  Expected: **PASS** — prints `SCOPE OK`, `SECRETS OK`, `DUNE-EXECUTE OK`, exit 0. (If `main` is not the branch base, set `CONFLUENCE_BASE_REF` to the actual base ref recorded in the design doc — `08fc805`.) Commit:
  ```
  git add scripts/confluence-gate.mjs
  git commit -m "chore(confluence): runnable scope/secret/Dune-execute gate script (Task F)"
  ```

- [ ] **Step 9: Rebuild a CLEAN DB, then run the full gate.** The `packages/db` project shares ONE embedded PG on :5439 and `replayRunner`/whole-DB passes pool-timeout on large residue — so start from a clean cluster before `npm run verify`:
  ```
  npm run db:migrate      # ensures :5439 up + Task B migration applied
  npm run db:seed         # clean deterministic world (resets residue that times out replayRunner)
  npm run verify          # typecheck (all workspaces) + vitest run + next build
  ```
  Expected: `npm run verify` exits 0 — typecheck clean, **all** confluence tests green (the 3 new suites plus every pre-existing suite; the design's ~865-test count grows by the confluence cases), `next build` succeeds. If `replayRunner.test.ts` times out, it is stale DB residue, not a Task F regression — re-run `npm run db:seed` (clean world) and re-run `npm run verify`; do not touch replayRunner. Do NOT commit anything in this step (verification only).

- [ ] **Step 10: Run the standalone smokes + final scan, and record the objective results.** Run each and confirm the stated outcome:
  ```
  # 1) Confluence integration suite alone (DB up):
  npx vitest run packages/db/test/externalConfluence.integration.test.ts
  #    Expected: all cases PASS (internal LR, all-keys-missing skip, never-creates-Token, mock e2e, read-through).

  # 2) Worker job smoke — all keys missing (every external source skips cleanly, worker exits without a throw):
  MOCK_MODE=false WORKER_FAST=1 CONFLUENCE_ONLY=1 npm run worker
  #    (Ctrl-C after one externalConfluence pass logs.) Expected: log shows
  #    "externalConfluence run finished", each external source reported
  #    missing_key/stub/unavailable, ZERO crash, internal LiquidityRisk snapshot written.
  #    If CONFLUENCE_ONLY isn't a supported flag, just run `npm run worker` briefly and grep the externalConfluence lines.

  # 3) Worker job smoke — MOCK_MODE (mock provider yields ok provider-claimed snapshots):
  MOCK_MODE=true WORKER_FAST=1 npm run worker
  #    Expected: externalConfluence pass logs ok snapshots for seeded mock-world tokens; still no Token/Signal/Alert/Candidate writes.

  # 4) Panel route smoke — boot web, hit a token-detail route, confirm the Confluence panel renders:
  npm run dev    # web on :5188
  #    Visit http://localhost:5188/tokens/<seeded-id> — the Confluence panel shows
  #    Liquidity Risk (internal), and honest unavailable/stub/plan-required cards for
  #    the external sources, each labeled shadow-only / not part of FlowScore.

  # 5) Final objective gate:
  node scripts/confluence-gate.mjs
  #    Expected: SCOPE OK / SECRETS OK / DUNE-EXECUTE OK, exit 0.

  # 6) Dune-execute-0 corroboration (independent grep over the confluence subtree):
  npx grep -R "DUNE_EXECUTE_FRESH=true\|executeQuery(" packages/*/src/confluence apps/worker/src/jobs/externalConfluence.ts || echo "DUNE-EXECUTE OK (0 hits)"
  ```
  Expected: every smoke matches its stated outcome. No commit (these are verification runs). If all pass, Task F — and the External Confluence track — is done.

**Done Bar:**
- `npm run verify` exits 0 on a clean/rebuilt DB (typecheck + vitest + next build all green), with the 3 new suites (`externalConfluence.integration.test.ts`, `externalConfluenceScope.test.ts`, `confluencePanelRoute.test.ts`) present and passing and no pre-existing suite regressed.
- The DB integration suite proves, against REAL Task D code: (a) an internal `liquidity_risk` snapshot is computed from a seeded `TokenMarketSnapshot` and equals `computeLiquidityRisk` output; (b) with all external keys missing every external source skips cleanly and no external snapshot carries status `ok`/`safe`; (c) the pass never creates `Token`/`Signal`/`Alert`/`CandidateWallet` rows; (d) a `MockConfluenceProvider` yields an `ok`, `providerClaimed:true`, secret-free snapshot for a KNOWN token; (e) `getTokenConfluence` reads it back.
- Worker smoke (keys-missing) logs every external source as `missing_key`/`stub`/`unavailable` with zero crash; worker smoke (MOCK_MODE) logs `ok` provider-claimed snapshots — neither writes Token/Signal/Alert/Candidate rows.
- The token-detail route renders the Confluence panel with an internal Liquidity Risk card + honest unavailable/stub/plan-required external cards, each labeled shadow-only / provider-claimed / not part of FlowScore, and never a "safe"/"clean" verdict.
- `node scripts/confluence-gate.mjs` prints `SCOPE OK` / `SECRETS OK` / `DUNE-EXECUTE OK` and exits 0: the branch diff touches **no** FlowScore/threshold/wallet-scoring/CandidateWallet/outbound-Telegram/BSC/Dune-execution file, commits no resolved secret value, and enables no fresh Dune execution (execute count 0).

**Reviewer Focus:**
- **Non-vacuous DB assertions.** Confirm the integration test seeds a real `TokenMarketSnapshot` and asserts the stored `dataJson` equals `computeLiquidityRisk` output (not just "a row exists"); confirm the "never-creates-Token" case counts rows before/after rather than trusting the return value.
- **unavailable ≠ safe.** Scrutinize that the all-keys-missing case asserts external statuses are in the skip set AND explicitly `not.toBe('ok')`, and that the panel test asserts the source contains no `\bsafe\b`/`\bclean\b` verdict string — this is the design's rule 15 and the easiest thing to get wrong.
- **GMGN query-only + AG Paper stub-only grep guards.** Verify the forbidden-verb regex in the worker scope test actually covers swap/order/private-key/wallet/transfer/withdraw (design rules 8/9), and that AG Paper's test forbids any parser (`.split(`, `csv-parse`, `fetch(`) — these are pure source greps and must be strict, not decorative.
- **Secret handling.** Check the source-status test forbids returning a resolved `process.env` VALUE while allowing a Boolean presence check, and that the panel test forbids `process.env` in the client-visible component entirely (design rule 13 / security section).
- **Scope isolation.** Confirm `confluence-gate.mjs`'s `FORBIDDEN_PATHS` list matches the design's untouchable set exactly (flowScore.ts, walletScore.ts, rules/, candidateValidation, telegram.ts, bsc, dune/) and that the base ref defaults sensibly (`main`, overridable to `08fc805`).
- **Clean-DB discipline.** Ensure Step 9 rebuilds/reseeds before `npm run verify` (the `replayRunner` pool-timeout caveat) and that Task F edits **only** test files + the gate script — any failure must be fixed in the owning task (A–E), never by weakening a Task F assertion.

---

## Notes

- **DB tests need LITE Postgres on :5439.** Tasks B, D, E, and F all rely on the embedded LITE-mode Postgres cluster (port 5439, no Docker). Each DB suite `probePort('localhost', 5439)`s and `describe.skipIf`s cleanly when it is not reachable — a skipped suite is NOT a pass. Start it with `npm run db:migrate` (which ensures the cluster is up and applies migrations) before running any confluence DB test, and confirm the suite reports as executed, not skipped.
- **Run `npm run verify` on a clean / rebuilt DB.** The `packages/db` vitest project shares one embedded cluster, and `replayRunner`/whole-DB passes pool-timeout on large residue. Before the final gate, run `npm run db:migrate` → `npm run db:seed` (clean deterministic world) → `npm run verify` (typecheck all workspaces + `vitest run` + `next build`). If `replayRunner.test.ts` times out, it is stale DB residue — reseed and re-run; do not treat it as a confluence regression and do not touch `replayRunner`.
- **Confluence source health surfaces in the token-detail ConfluencePanel only (this pass).** This satisfies the design doc's "or a dedicated Confluence health card" alternative and matches resolved decision #6 (token-detail panel first, no separate `/confluence` page). Extending the existing `/sources` page with a confluence section is an optional follow-up, deliberately out of scope here — do not edit `apps/web/app/sources/*` in any task.
- **HolderScan 402/403 → `plan_required` HTTP mapping is deferred with the stub.** The Task C HolderScan adapter is a documented stub with no real fetch, so the design's "402/403 ⇒ plan_required" behavior is covered at the status-surface level only (stub returns `plan_required`/`unavailable`; tests assert the status + never-safe rendering). When a real HolderScan fetch is implemented (future task, requires key/docs), an HTTP-level test mapping 401/403/402 → `plan_required` and 429 → `rate_limited` becomes mandatory in that task's Done Bar.
