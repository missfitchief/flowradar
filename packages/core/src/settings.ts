// FlowRadar — Settings schema (Zod) + DEFAULT_SETTINGS + parseSettings.
//
// Normative sources:
//   - Plan "Shared Contracts": every default value listed verbatim.
//   - Spec §6 "Core engine" (rule defaults table) + §7 "Workers and scheduling" (interval defaults).
//
// packages/core is PURE: zod is the only runtime dependency allowed here.

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const ChainsEnabledSchema = z.object({
  SOLANA: z.boolean(),
  BSC: z.boolean()
});

const ProfitableWalletSchema = z.object({
  pnl30d: z.number(),
  minTrades: z.number(),
  minWinRate: z.number(),
  minRealized: z.number(),
  minAvgTradeSizeUsd: z.number()
});

const RuleASchema = z.object({
  minWallets: z.number(),
  watchMinWallets: z.number(),
  windowMin: z.number(),
  minBuyVolumeUsd: z.number(),
  maxSoldPct: z.number(),
  mcapMin: z.number(),
  mcapMax: z.number(),
  minLiquidityUsd: z.number(),
  maxTokenAgeDays: z.number(),
  inflowSpikeMult: z.number()
});

const RuleBSchema = z.object({
  baseWallets: z.number(),
  targetWallets: z.number(),
  windowMin: z.number(),
  maxMcapExpansion: z.number(),
  maxSellToBuyPct: z.number()
});

const RuleCSchema = z.object({
  minHumanRatio: z.number(),
  maxBotRatio: z.number(),
  maxSingleBlockBuysPct: z.number(),
  minFundingRoots: z.number(),
  minFundingRootsPct: z.number()
});

const RuleDSchema = z.object({
  minWhaleBuyUsd: z.number(),
  minWallets: z.number(),
  minBuySellRatio: z.number()
});

const RuleESchema = z.object({
  minDelayMin: z.number(),
  maxDelayMin: z.number(),
  maxMcap: z.number(),
  minBuyToFundingPct: z.number(),
  maxBuyToFundingPct: z.number()
});

const RuleFSchema = z.object({
  minRealizedProfitUsd: z.number(),
  maxTransferDelayHours: z.number(),
  minValueMatchPct: z.number(),
  maxValueMatchPct: z.number(),
  maxBuyDelayMin: z.number(),
  maxMcap: z.number()
});

const RuleGSchema = z.object({
  minExitedPct: z.number(),
  exitPositionSoldPct: z.number(),
  liquidityDropPct: z.number(),
  liquidityDropWindowMin: z.number(),
  mcapPumpPct: z.number(),
  mcapPumpWindowHours: z.number(),
  maxNewSmartBuyers: z.number()
});

const RulesSchema = z.object({
  A: RuleASchema,
  B: RuleBSchema,
  C: RuleCSchema,
  D: RuleDSchema,
  E: RuleESchema,
  F: RuleFSchema,
  G: RuleGSchema
});

const GraphSchema = z.object({
  maxDepth: z.number(),
  minTransferUsd: z.number(),
  maxNodes: z.number(),
  maxEdges: z.number(),
  perNodeTxCap: z.number()
});

const AlertsSchema = z.object({
  cooldownMin: z.number(),
  telegramEnabled: z.boolean(),
  discordEnabled: z.boolean()
});

const IntervalsSchema = z.object({
  walletActivitySec: z.number(),
  marketDataHotSec: z.number(),
  marketDataNormalSec: z.number(),
  flowScoringSec: z.number(),
  signalDetectionSec: z.number(),
  alertDispatchSec: z.number(),
  moneyFlowSec: z.number(),
  bridgeFlowSec: z.number(),
  entityClusteringSec: z.number(),
  profitRotationSec: z.number(),
  walletStatsRefreshHours: z.number(),
  walletDiscoveryHours: z.number(),
  backtestHours: z.number()
});

// Task 34 (Wave 4.5, Spec §5b) — external smart-wallet source connectors.
// sourcesEnabled is a Record<string, boolean> (not a fixed z.object of the 6
// literal source names) so a future source can be added to DEFAULT_SETTINGS
// without a SettingsSchema change; DEFAULT_SETTINGS below is the source of
// truth for which 6 keys actually exist today.
const TopTraderBackfillSchema = z.object({
  mcapExpansionMin: z.number(),
  lookbackHours: z.number(),
  topN: z.number()
});

// Task 37 (Wave 4.6, dune-feature-wave46.md) — Dune Query Connector refresh
// cadence. syncHours reuses the SAME name/units convention as
// connectors.syncHours (hours, converted to seconds by the worker's own
// *3600 pipeline) but is a DISTINCT field — Dune's credit-safe refresh
// (latest-cached-result only, unless DUNE_EXECUTE_FRESH=true) is intended to
// run independently of the external-wallet-source connectors' own cadence.
const DuneConnectorSchema = z.object({
  syncHours: z.number()
});

const ConnectorsSchema = z.object({
  sourcesEnabled: z.record(z.string(), z.boolean()),
  syncHours: z.number(),
  validationBatchSize: z.number(),
  topTraderBackfill: TopTraderBackfillSchema,
  dune: DuneConnectorSchema
});

export const SettingsSchema = z
  .object({
    chainsEnabled: ChainsEnabledSchema,
    profitableWallet: ProfitableWalletSchema,
    rules: RulesSchema,
    graph: GraphSchema,
    entityConfidenceThreshold: z.number(),
    alerts: AlertsSchema,
    intervals: IntervalsSchema,
    connectors: ConnectorsSchema
  })
  // .strict() on the TOP-LEVEL object: a PUT /api/settings body carrying an
  // unknown top-level key (typo like `interval`, or a stale/removed field) now
  // 400s with a clear "Unrecognized key" issue instead of being silently
  // stripped by the deep-merge and saved as if accepted. Deep-merge still works
  // because parseSettings only ever merges KNOWN keys onto DEFAULT_SETTINGS —
  // an unknown top-level key survives the merge into the parsed object and is
  // exactly what .strict() rejects. Nested objects are intentionally NOT strict
  // (partial nested updates deep-merge over defaults; unknown nested keys stay
  // tolerated) — only the outermost shape is guarded.
  .strict()
  .refine((settings) => settings.rules.A.mcapMin < settings.rules.A.mcapMax, {
    message: 'rules.A.mcapMin must be less than rules.A.mcapMax',
    path: ['rules', 'A', 'mcapMin']
  });

export type Settings = z.infer<typeof SettingsSchema>;

// ---------------------------------------------------------------------------
// Defaults — every value per plan Shared Contracts / Spec §6-§7
// ---------------------------------------------------------------------------

export const DEFAULT_SETTINGS: Settings = {
  chainsEnabled: { SOLANA: true, BSC: true },
  profitableWallet: {
    pnl30d: 4000,
    minTrades: 8,
    minWinRate: 0.35,
    minRealized: 1000,
    minAvgTradeSizeUsd: 50
  },
  rules: {
    A: {
      minWallets: 20,
      watchMinWallets: 10,
      windowMin: 30,
      minBuyVolumeUsd: 25000,
      maxSoldPct: 30,
      mcapMin: 100000,
      mcapMax: 5000000,
      minLiquidityUsd: 20000,
      maxTokenAgeDays: 7,
      inflowSpikeMult: 3
    },
    B: {
      baseWallets: 20,
      targetWallets: 40,
      windowMin: 1440,
      maxMcapExpansion: 2,
      maxSellToBuyPct: 25
    },
    C: {
      minHumanRatio: 0.7,
      maxBotRatio: 0.2,
      maxSingleBlockBuysPct: 30,
      minFundingRoots: 3,
      minFundingRootsPct: 0.3
    },
    D: {
      minWhaleBuyUsd: 10000,
      minWallets: 15,
      minBuySellRatio: 3
    },
    E: {
      minDelayMin: 5,
      maxDelayMin: 120,
      maxMcap: 5000000,
      minBuyToFundingPct: 30,
      maxBuyToFundingPct: 110
    },
    F: {
      minRealizedProfitUsd: 500,
      maxTransferDelayHours: 24,
      minValueMatchPct: 80,
      maxValueMatchPct: 105,
      maxBuyDelayMin: 60,
      maxMcap: 5000000
    },
    G: {
      minExitedPct: 30,
      exitPositionSoldPct: 80,
      liquidityDropPct: 30,
      liquidityDropWindowMin: 60,
      mcapPumpPct: 100,
      mcapPumpWindowHours: 6,
      maxNewSmartBuyers: 3
    }
  },
  graph: {
    maxDepth: 3,
    minTransferUsd: 100,
    maxNodes: 5000,
    maxEdges: 25000,
    perNodeTxCap: 500
  },
  entityConfidenceThreshold: 61,
  alerts: {
    cooldownMin: 30,
    telegramEnabled: true,
    discordEnabled: false
  },
  intervals: {
    walletActivitySec: 45,
    marketDataHotSec: 60,
    marketDataNormalSec: 300,
    flowScoringSec: 60,
    signalDetectionSec: 60,
    alertDispatchSec: 30,
    moneyFlowSec: 60,
    bridgeFlowSec: 120,
    entityClusteringSec: 180,
    profitRotationSec: 120,
    walletStatsRefreshHours: 6,
    walletDiscoveryHours: 24,
    backtestHours: 6
  },
  connectors: {
    // Spec §5b's 6 external candidate-wallet feeders, priority order.
    sourcesEnabled: {
      solana_tracker_pnl: true,
      birdeye_wallet_pnl: true,
      birdeye_top_traders: true,
      kolscan: true,
      gmgn_smart_money: true,
      cielo: true
    },
    syncHours: 6,
    validationBatchSize: 100,
    topTraderBackfill: {
      mcapExpansionMin: 2,
      lookbackHours: 24,
      topN: 20
    },
    dune: {
      // Slower-moving than the wallet-source connectors — Dune refreshes are
      // credit-conscious by design (latest-cached-result only by default), so
      // a daily-ish default cadence (24h) rather than syncHours' 6h.
      syncHours: 24
    }
  }
};

// ---------------------------------------------------------------------------
// Deep merge + parse
// ---------------------------------------------------------------------------

type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

/**
 * Deep-merges `override` onto `base`. Only keys present in `override` are
 * touched; every other key (at any depth) is retained from `base`. Nested
 * plain objects are merged recursively; primitives/arrays in `override`
 * replace the corresponding value in `base` wholesale.
 */
function deepMerge<T>(base: T, override: unknown): T {
  if (!isPlainObject(override)) {
    return base;
  }
  const baseObj = isPlainObject(base) ? (base as PlainObject) : {};
  const result: PlainObject = { ...baseObj };

  for (const key of Object.keys(override)) {
    const overrideValue = override[key];
    const baseValue = baseObj[key];
    if (isPlainObject(baseValue) && isPlainObject(overrideValue)) {
      result[key] = deepMerge(baseValue, overrideValue);
    } else {
      result[key] = overrideValue;
    }
  }

  return result as T;
}

/**
 * Parses a partial/untrusted settings object by deep-merging it over
 * DEFAULT_SETTINGS, then validating the merged result through SettingsSchema.
 * Throws (ZodError) if the merged settings are invalid — including the
 * rules.A.mcapMin < rules.A.mcapMax refinement.
 */
export function parseSettings(json: unknown): Settings {
  const merged = deepMerge(DEFAULT_SETTINGS, json);
  return SettingsSchema.parse(merged);
}
