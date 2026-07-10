// FlowRadar — shadow stealth accumulation engine tests (Wave F).
//
// The engine is SHADOW-ONLY: it never touches FlowScore, never claims profit,
// and (the load-bearing invariant) public_kol / public_promoter / copytrader
// activity can NEVER raise the stealth score. Only the signal_eligible cohort
// drives positive score; observation_only wallets carry zero signal weight too.
import { describe, expect, it } from 'vitest';
import {
  computeStealth,
  DEFAULT_STEALTH_CONFIG,
  STEALTH_WINDOWS,
  type CohortFlow,
  type StealthInput,
  type StealthWindow,
  type StealthWindowInput
} from '../src/stealth';

const NOW = new Date('2026-07-10T00:00:00Z');

function flow(p: Partial<CohortFlow> = {}): CohortFlow {
  return {
    distinctBuyers: 0,
    distinctSellers: 0,
    buyUsd: 0,
    sellUsd: 0,
    freshBuyers: 0,
    distinctClusters: 0,
    ...p
  };
}

function win(window: StealthWindow, p: Partial<Omit<StealthWindowInput, 'window'>> = {}): StealthWindowInput {
  return {
    window,
    eligible: p.eligible ?? flow(),
    observation: p.observation ?? flow(),
    publicKol: p.publicKol ?? flow(),
    crowd: p.crowd ?? flow()
  };
}

function input(windows: StealthWindowInput[], p: Partial<StealthInput> = {}): StealthInput {
  return { tokenId: 't1', chain: 'SOLANA', now: NOW, windows, ...p };
}

// A clean stealth-accumulation fixture: several independent eligible buyers,
// net inflow, no public/crowd participation.
function stealthFixture(): StealthInput {
  return input([
    win('24h', {
      eligible: flow({ distinctBuyers: 6, buyUsd: 40000, sellUsd: 1000, freshBuyers: 5, distinctClusters: 5 })
    }),
    win('1h', { eligible: flow({ distinctBuyers: 4, buyUsd: 20000, freshBuyers: 4, distinctClusters: 4 }) }),
    win('15m', { eligible: flow({ distinctBuyers: 2, buyUsd: 8000, freshBuyers: 2, distinctClusters: 2 }) })
  ]);
}

describe('stealth engine — constants & shape', () => {
  it('exposes the six windows and a shadow-only result', () => {
    expect(STEALTH_WINDOWS).toEqual(['5m', '15m', '30m', '1h', '4h', '24h']);
    const r = computeStealth(stealthFixture());
    expect(r.shadowOnly).toBe(true);
    expect(r.tokenId).toBe('t1');
    // ~24 metrics, all finite numbers.
    const keys = Object.keys(r.metrics);
    expect(keys.length).toBeGreaterThanOrEqual(24);
    for (const k of keys) expect(Number.isFinite((r.metrics as Record<string, number>)[k]!)).toBe(true);
    expect(r.stealthScore).toBeGreaterThanOrEqual(0);
    expect(r.stealthScore).toBeLessThanOrEqual(100);
  });

  it('is deterministic — same input yields identical output', () => {
    const a = computeStealth(stealthFixture());
    const b = computeStealth(stealthFixture());
    expect(a).toEqual(b);
  });
});

describe('stealth engine — states', () => {
  it('WATCHING when there is no meaningful eligible accumulation', () => {
    const r = computeStealth(input([win('24h', { eligible: flow({ distinctBuyers: 1, buyUsd: 100 }) })]));
    expect(r.state).toBe('WATCHING');
  });

  it('STEALTH_ACCUMULATION for eligible breadth + net inflow, no public/crowd', () => {
    const r = computeStealth(input([
      win('24h', { eligible: flow({ distinctBuyers: 4, buyUsd: 30000, freshBuyers: 3, distinctClusters: 2 }) })
    ]));
    expect(r.state).toBe('STEALTH_ACCUMULATION');
    expect(r.stealthScore).toBeGreaterThan(0);
  });

  it('EARLY_INDEPENDENT_CONFIRMATION when accumulation spans enough independent clusters', () => {
    const r = computeStealth(stealthFixture());
    expect(r.state).toBe('EARLY_INDEPENDENT_CONFIRMATION');
  });

  it('PUBLIC_KOL_ARRIVAL once public KOLs start buying (stealth window closed)', () => {
    const r = computeStealth(input([
      win('24h', {
        eligible: flow({ distinctBuyers: 4, buyUsd: 30000, freshBuyers: 3, distinctClusters: 3 }),
        publicKol: flow({ distinctBuyers: 3, buyUsd: 50000 })
      })
    ]));
    expect(r.state).toBe('PUBLIC_KOL_ARRIVAL');
  });

  it('CROWD_EXPANSION when copytrader breadth surges (later than KOL arrival)', () => {
    const r = computeStealth(input([
      win('24h', {
        eligible: flow({ distinctBuyers: 4, buyUsd: 30000, distinctClusters: 3 }),
        publicKol: flow({ distinctBuyers: 3, buyUsd: 50000 }),
        crowd: flow({ distinctBuyers: 12, buyUsd: 60000 })
      })
    ]));
    expect(r.state).toBe('CROWD_EXPANSION');
  });

  it('DISTRIBUTION_RISK when the early cohort is heavily selling', () => {
    const r = computeStealth(input([
      win('24h', { eligible: flow({ distinctBuyers: 4, buyUsd: 30000, sellUsd: 20000, distinctSellers: 3, distinctClusters: 3 }) })
    ]));
    expect(r.state).toBe('DISTRIBUTION_RISK');
  });

  it('INVALIDATED when the early cohort has flipped to net distribution', () => {
    const r = computeStealth(input([
      win('24h', { eligible: flow({ distinctBuyers: 4, buyUsd: 10000, sellUsd: 25000, distinctSellers: 4, distinctClusters: 3 }) })
    ]));
    expect(r.state).toBe('INVALIDATED');
  });
});

describe('stealth engine — trust-boundary invariants', () => {
  it('public KOL activity NEVER raises the stealth score', () => {
    const base = input([
      win('24h', { eligible: flow({ distinctBuyers: 4, buyUsd: 30000, freshBuyers: 3, distinctClusters: 3 }) })
    ]);
    const withKol = input([
      win('24h', {
        eligible: flow({ distinctBuyers: 4, buyUsd: 30000, freshBuyers: 3, distinctClusters: 3 }),
        publicKol: flow({ distinctBuyers: 5, buyUsd: 200000 })
      })
    ]);
    const s0 = computeStealth(base).stealthScore;
    const s1 = computeStealth(withKol).stealthScore;
    expect(s1).toBeLessThanOrEqual(s0); // strictly never higher
  });

  it('copytrader/crowd activity NEVER raises the stealth score', () => {
    const base = computeStealth(input([
      win('24h', { eligible: flow({ distinctBuyers: 4, buyUsd: 30000, freshBuyers: 3, distinctClusters: 3 }) })
    ])).stealthScore;
    const withCrowd = computeStealth(input([
      win('24h', {
        eligible: flow({ distinctBuyers: 4, buyUsd: 30000, freshBuyers: 3, distinctClusters: 3 }),
        crowd: flow({ distinctBuyers: 20, buyUsd: 500000 })
      })
    ])).stealthScore;
    expect(withCrowd).toBeLessThanOrEqual(base);
  });

  it('observation_only activity does NOT raise the stealth score (zero signal weight)', () => {
    const base = computeStealth(input([
      win('24h', { eligible: flow({ distinctBuyers: 4, buyUsd: 30000, freshBuyers: 3, distinctClusters: 3 }) })
    ])).stealthScore;
    const withObs = computeStealth(input([
      win('24h', {
        eligible: flow({ distinctBuyers: 4, buyUsd: 30000, freshBuyers: 3, distinctClusters: 3 }),
        observation: flow({ distinctBuyers: 30, buyUsd: 400000, distinctClusters: 25 })
      })
    ])).stealthScore;
    expect(withObs).toBeLessThanOrEqual(base);
  });

  it('a token bought ONLY by public KOLs never reaches a stealth/confirmation state and scores 0', () => {
    const r = computeStealth(input([
      win('24h', { publicKol: flow({ distinctBuyers: 10, buyUsd: 500000, distinctClusters: 8 }) })
    ]));
    expect(['PUBLIC_KOL_ARRIVAL', 'WATCHING']).toContain(r.state);
    expect(r.state).not.toBe('STEALTH_ACCUMULATION');
    expect(r.state).not.toBe('EARLY_INDEPENDENT_CONFIRMATION');
    expect(r.stealthScore).toBe(0);
  });

  it('carries no profitability/return claim in its output surface', () => {
    const r = computeStealth(stealthFixture());
    const json = JSON.stringify(r).toLowerCase();
    for (const banned of ['profit', 'return', 'roi', 'pnl', 'gain']) {
      expect(json).not.toContain(banned);
    }
  });
});

describe('stealth engine — config', () => {
  it('weights and thresholds are operator-overridable (shadow-only)', () => {
    const strict = {
      ...DEFAULT_STEALTH_CONFIG,
      thresholds: { ...DEFAULT_STEALTH_CONFIG.thresholds, minEligibleBuyersStealth: 100 }
    };
    // With an unreachable threshold the same fixture no longer qualifies as stealth.
    const r = computeStealth(input([
      win('24h', { eligible: flow({ distinctBuyers: 4, buyUsd: 30000, freshBuyers: 3, distinctClusters: 3 }) })
    ]), strict);
    expect(r.state).toBe('WATCHING');
  });
});
