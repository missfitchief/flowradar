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
