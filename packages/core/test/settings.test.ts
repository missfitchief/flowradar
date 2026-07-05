import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, SettingsSchema, parseSettings } from '../src/settings.js';

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
});
