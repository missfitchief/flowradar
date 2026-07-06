import { describe, expect, it } from 'vitest';
import { calculateWalletLinkConfidence, confidenceBand } from '../src/cluster/linkConfidence';
import type { LinkEvidence } from '../src/types';

// FlowRadar — calculateWalletLinkConfidence / confidenceBand tests (Task 22).
//
// Weight table (spec §6, binding decision 2):
//   directTransfer              +35
//   repeatedDirectTransfers     +20
//   sameFundingSource           +25
//   sameGasFunder               +10
//   bridgeAmountTimeMatch       +30
//   amountSimilarityAbove90     +15
//   destBuysNewTokenWithin60m   +15
//   freshWalletActivated        +15
//   sameTokenRotation           +10
//   repeatedCrossLaunchPattern  +25
//   cexOrMixerInterruption      -30
//   routerOnlyInteraction       -20
//   weakAmountMatch             -15
//   dustOnlyInteraction         -25
// Applied additively, then clamped to [0, 100].

const ALL_FALSE: LinkEvidence = {
  directTransfer: false,
  repeatedDirectTransfers: false,
  sameFundingSource: false,
  sameGasFunder: false,
  bridgeAmountTimeMatch: false,
  amountSimilarityAbove90: false,
  destBuysNewTokenWithin60m: false,
  freshWalletActivated: false,
  sameTokenRotation: false,
  repeatedCrossLaunchPattern: false,
  cexOrMixerInterruption: false,
  routerOnlyInteraction: false,
  weakAmountMatch: false,
  dustOnlyInteraction: false
};

function evidence(overrides: Partial<LinkEvidence>): LinkEvidence {
  return { ...ALL_FALSE, ...overrides };
}

describe('calculateWalletLinkConfidence', () => {
  it('all-false evidence -> 0', () => {
    expect(calculateWalletLinkConfidence(ALL_FALSE)).toBe(0);
  });

  const positiveCases: { field: keyof LinkEvidence; expected: number }[] = [
    { field: 'directTransfer', expected: 35 },
    { field: 'repeatedDirectTransfers', expected: 20 },
    { field: 'sameFundingSource', expected: 25 },
    { field: 'sameGasFunder', expected: 10 },
    { field: 'bridgeAmountTimeMatch', expected: 30 },
    { field: 'amountSimilarityAbove90', expected: 15 },
    { field: 'destBuysNewTokenWithin60m', expected: 15 },
    { field: 'freshWalletActivated', expected: 15 },
    { field: 'sameTokenRotation', expected: 10 },
    { field: 'repeatedCrossLaunchPattern', expected: 25 }
  ];

  for (const { field, expected } of positiveCases) {
    it(`${field} alone contributes exactly +${expected}`, () => {
      expect(calculateWalletLinkConfidence(evidence({ [field]: true }))).toBe(expected);
    });
  }

  const negativeCases: { field: keyof LinkEvidence; delta: number }[] = [
    { field: 'cexOrMixerInterruption', delta: -30 },
    { field: 'routerOnlyInteraction', delta: -20 },
    { field: 'weakAmountMatch', delta: -15 },
    { field: 'dustOnlyInteraction', delta: -25 }
  ];

  for (const { field, delta } of negativeCases) {
    it(`${field} alone is clamped to 0 (base 0 + negative delta ${delta})`, () => {
      expect(calculateWalletLinkConfidence(evidence({ [field]: true }))).toBe(0);
    });

    it(`${field} subtracts exactly ${Math.abs(delta)} from a positive baseline`, () => {
      // directTransfer (+35) as a baseline large enough to reveal the exact delta.
      const withBaseline = calculateWalletLinkConfidence(evidence({ directTransfer: true, [field]: true }));
      expect(withBaseline).toBe(35 + delta);
    });
  }

  it('all-positive evidence -> clamped to 100', () => {
    const allPositive = evidence({
      directTransfer: true,
      repeatedDirectTransfers: true,
      sameFundingSource: true,
      sameGasFunder: true,
      bridgeAmountTimeMatch: true,
      amountSimilarityAbove90: true,
      destBuysNewTokenWithin60m: true,
      freshWalletActivated: true,
      sameTokenRotation: true,
      repeatedCrossLaunchPattern: true
    });
    // Raw sum: 35+20+25+10+30+15+15+15+10+25 = 200 -> clamped to 100.
    expect(calculateWalletLinkConfidence(allPositive)).toBe(100);
  });

  it('mixed pos+neg: directTransfer(+35) + cexOrMixerInterruption(-30) + dustOnlyInteraction(-25) -> floor 0', () => {
    // Raw sum: 35 - 30 - 25 = -20 -> clamped to 0.
    const mixed = evidence({ directTransfer: true, cexOrMixerInterruption: true, dustOnlyInteraction: true });
    expect(calculateWalletLinkConfidence(mixed)).toBe(0);
  });

  it('additive combination without clamping: sameFundingSource(+25) + sameGasFunder(+10) + freshWalletActivated(+15) -> 50', () => {
    const combo = evidence({ sameFundingSource: true, sameGasFunder: true, freshWalletActivated: true });
    expect(calculateWalletLinkConfidence(combo)).toBe(50);
  });
});

describe('confidenceBand', () => {
  it('0 -> weak', () => {
    expect(confidenceBand(0)).toBe('weak');
  });
  it('30 -> weak (boundary)', () => {
    expect(confidenceBand(30)).toBe('weak');
  });
  it('31 -> possible (boundary)', () => {
    expect(confidenceBand(31)).toBe('possible');
  });
  it('60 -> possible (boundary)', () => {
    expect(confidenceBand(60)).toBe('possible');
  });
  it('61 -> probable (boundary)', () => {
    expect(confidenceBand(61)).toBe('probable');
  });
  it('80 -> probable (boundary)', () => {
    expect(confidenceBand(80)).toBe('probable');
  });
  it('81 -> strong (boundary)', () => {
    expect(confidenceBand(81)).toBe('strong');
  });
  it('100 -> strong', () => {
    expect(confidenceBand(100)).toBe('strong');
  });
});
