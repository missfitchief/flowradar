import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, SettingsSchema, parseSettings } from '../src/settings';

describe('SettingsSchema / DEFAULT_SETTINGS / parseSettings', () => {
  it('DEFAULT_SETTINGS parses through SettingsSchema', () => {
    const parsed = SettingsSchema.parse(DEFAULT_SETTINGS);
    expect(parsed).toEqual(DEFAULT_SETTINGS);
  });

  it('parseSettings with a partial override deep-merges and keeps every other default', () => {
    const result = parseSettings({ rules: { A: { minWallets: 25 } } });

    // overridden field
    expect(result.rules.A.minWallets).toBe(25);

    // every other rules.A field retained from defaults
    expect(result.rules.A.watchMinWallets).toBe(DEFAULT_SETTINGS.rules.A.watchMinWallets);
    expect(result.rules.A.windowMin).toBe(DEFAULT_SETTINGS.rules.A.windowMin);
    expect(result.rules.A.minBuyVolumeUsd).toBe(DEFAULT_SETTINGS.rules.A.minBuyVolumeUsd);
    expect(result.rules.A.maxSoldPct).toBe(DEFAULT_SETTINGS.rules.A.maxSoldPct);
    expect(result.rules.A.mcapMin).toBe(DEFAULT_SETTINGS.rules.A.mcapMin);
    expect(result.rules.A.mcapMax).toBe(DEFAULT_SETTINGS.rules.A.mcapMax);
    expect(result.rules.A.minLiquidityUsd).toBe(DEFAULT_SETTINGS.rules.A.minLiquidityUsd);
    expect(result.rules.A.maxTokenAgeDays).toBe(DEFAULT_SETTINGS.rules.A.maxTokenAgeDays);
    expect(result.rules.A.inflowSpikeMult).toBe(DEFAULT_SETTINGS.rules.A.inflowSpikeMult);

    // untouched top-level sections retained wholesale
    expect(result.rules.B).toEqual(DEFAULT_SETTINGS.rules.B);
    expect(result.rules.C).toEqual(DEFAULT_SETTINGS.rules.C);
    expect(result.rules.D).toEqual(DEFAULT_SETTINGS.rules.D);
    expect(result.rules.E).toEqual(DEFAULT_SETTINGS.rules.E);
    expect(result.rules.F).toEqual(DEFAULT_SETTINGS.rules.F);
    expect(result.rules.G).toEqual(DEFAULT_SETTINGS.rules.G);
    expect(result.chainsEnabled).toEqual(DEFAULT_SETTINGS.chainsEnabled);
    expect(result.profitableWallet).toEqual(DEFAULT_SETTINGS.profitableWallet);
    expect(result.graph).toEqual(DEFAULT_SETTINGS.graph);
    expect(result.entityConfidenceThreshold).toBe(DEFAULT_SETTINGS.entityConfidenceThreshold);
    expect(result.alerts).toEqual(DEFAULT_SETTINGS.alerts);
    expect(result.intervals).toEqual(DEFAULT_SETTINGS.intervals);
  });

  it('parseSettings throws when rules.A.mcapMin >= rules.A.mcapMax (refine)', () => {
    expect(() => parseSettings({ rules: { A: { mcapMin: 6_000_000 } } })).toThrow();
  });

  it('parseSettings throws on an invalid type', () => {
    expect(() => parseSettings({ alerts: { cooldownMin: 'x' } })).toThrow();
  });

  it('parseSettings rejects an unknown TOP-LEVEL key (.strict) instead of silently stripping it', () => {
    // A typo'd or stale top-level field must 400 (surface a ZodError) rather
    // than being deep-merged away and saved as if accepted.
    expect(() => parseSettings({ interval: { flowScoringSec: 5 } })).toThrow();
    expect(() => parseSettings({ totallyUnknownKey: true })).toThrow();
  });

  it('DEFAULT_SETTINGS.rules.A.watchMinWallets is 10 (tiered rule A WATCH floor)', () => {
    expect(DEFAULT_SETTINGS.rules.A.watchMinWallets).toBe(10);
  });
});

describe('SettingsSchema.connectors (Task 34 — Wave 4.5 external wallet-source connectors)', () => {
  const EXPECTED_SOURCE_NAMES = [
    'solana_tracker_pnl',
    'birdeye_wallet_pnl',
    'birdeye_top_traders',
    'kolscan',
    'gmgn_smart_money',
    'cielo'
  ];

  it('DEFAULT_SETTINGS.connectors carries all 6 sources enabled=true, plus syncHours/validationBatchSize/topTraderBackfill defaults', () => {
    expect(Object.keys(DEFAULT_SETTINGS.connectors.sourcesEnabled).sort()).toEqual([...EXPECTED_SOURCE_NAMES].sort());
    for (const name of EXPECTED_SOURCE_NAMES) {
      expect(DEFAULT_SETTINGS.connectors.sourcesEnabled[name]).toBe(true);
    }
    expect(DEFAULT_SETTINGS.connectors.syncHours).toBe(6);
    expect(DEFAULT_SETTINGS.connectors.validationBatchSize).toBe(100);
    expect(DEFAULT_SETTINGS.connectors.topTraderBackfill).toEqual({
      mcapExpansionMin: 2,
      lookbackHours: 24,
      topN: 20
    });
  });

  it('DEFAULT_SETTINGS.connectors parses through SettingsSchema', () => {
    const parsed = SettingsSchema.parse(DEFAULT_SETTINGS);
    expect(parsed.connectors).toEqual(DEFAULT_SETTINGS.connectors);
  });

  it('parseSettings with a partial connectors override deep-merges and keeps every other default/source', () => {
    const result = parseSettings({ connectors: { sourcesEnabled: { kolscan: false }, syncHours: 12 } });

    expect(result.connectors.sourcesEnabled.kolscan).toBe(false);
    // every other source retained from defaults
    expect(result.connectors.sourcesEnabled.solana_tracker_pnl).toBe(true);
    expect(result.connectors.sourcesEnabled.birdeye_wallet_pnl).toBe(true);
    expect(result.connectors.sourcesEnabled.birdeye_top_traders).toBe(true);
    expect(result.connectors.sourcesEnabled.gmgn_smart_money).toBe(true);
    expect(result.connectors.sourcesEnabled.cielo).toBe(true);

    expect(result.connectors.syncHours).toBe(12);
    expect(result.connectors.validationBatchSize).toBe(DEFAULT_SETTINGS.connectors.validationBatchSize);
    expect(result.connectors.topTraderBackfill).toEqual(DEFAULT_SETTINGS.connectors.topTraderBackfill);

    // every other top-level section untouched
    expect(result.rules).toEqual(DEFAULT_SETTINGS.rules);
    expect(result.intervals).toEqual(DEFAULT_SETTINGS.intervals);
  });

  it('parseSettings throws on an invalid connectors type', () => {
    expect(() => parseSettings({ connectors: { syncHours: 'x' } })).toThrow();
  });
});

describe('SettingsSchema.connectors.social (Task B — social intelligence config §7)', () => {
  it('DEFAULT_SETTINGS.connectors.social carries the spec §7 defaults', () => {
    expect(DEFAULT_SETTINGS.connectors.social).toEqual({
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
    });
  });

  it('DEFAULT_SETTINGS parses through SettingsSchema with social present', () => {
    const parsed = SettingsSchema.parse(DEFAULT_SETTINGS);
    expect(parsed.connectors.social).toEqual(DEFAULT_SETTINGS.connectors.social);
  });

  it('parseSettings deep-merges a partial social override and keeps other social defaults', () => {
    const result = parseSettings({ connectors: { social: { syncHours: 12, spam: { uiHideThreshold: 60 } } } });
    expect(result.connectors.social.syncHours).toBe(12);
    expect(result.connectors.social.spam.uiHideThreshold).toBe(60);
    // untouched nested spam fields retained
    expect(result.connectors.social.spam.copypastaAuthorMin).toBe(3);
    expect(result.connectors.social.spam.weights).toEqual(DEFAULT_SETTINGS.connectors.social.spam.weights);
    expect(result.connectors.social.velocityWindowsMin).toEqual([60, 360, 1440]);
    // sibling connectors sub-configs untouched
    expect(result.connectors.dune).toEqual(DEFAULT_SETTINGS.connectors.dune);
    expect(result.connectors.sourcesEnabled).toEqual(DEFAULT_SETTINGS.connectors.sourcesEnabled);
  });

  it('parseSettings throws on an invalid social type', () => {
    expect(() => parseSettings({ connectors: { social: { syncHours: 'x' } } })).toThrow();
  });
});
