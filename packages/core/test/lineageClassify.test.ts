// FlowRadar — pure lineage classification (Capital Lineage 6b). These
// decisions are the load-bearing rules of the receiver-enrollment engine;
// they take plain data and return verdicts with zero I/O, so every branch of
// the operator's spec is pinned here rather than through the DB worker.

import { describe, expect, it } from 'vitest';
import {
  classifyReceiverEnrollment,
  isServiceNode,
  relationshipConfidence,
  type ReceiverContext
} from '../src/lineage/lineageClassify';
import { DEFAULT_SETTINGS } from '../src/settings';

const L = DEFAULT_SETTINGS.lineage;

function ctx(over: Partial<ReceiverContext> = {}): ReceiverContext {
  return {
    senderTrusted: true,
    transferUsd: 1000,
    isNativeSol: false,
    receiverIsFreshOrInactive: true,
    receiverIsServiceOrProgram: false,
    isReceiverFirstMeaningfulInbound: true,
    receiverBecameActiveWithinWindow: true,
    ...over
  };
}

describe('isServiceNode', () => {
  it('flags registry service categories (never expand)', () => {
    for (const category of ['CEX', 'BRIDGE', 'ROUTER', 'POOL', 'TOKEN_CONTRACT'] as const) {
      expect(isServiceNode({ registryCategory: category, distinctCounterparties: 0 }, L)).toBe(true);
    }
  });

  it('flags a high-degree unregistered address by counterparty count', () => {
    expect(isServiceNode({ registryCategory: null, distinctCounterparties: L.serviceDegreeThreshold + 1 }, L)).toBe(true);
    expect(isServiceNode({ registryCategory: null, distinctCounterparties: L.serviceDegreeThreshold - 1 }, L)).toBe(false);
  });

  it('a normal wallet is not a service node', () => {
    expect(isServiceNode({ registryCategory: null, distinctCounterparties: 3 }, L)).toBe(false);
  });
});

describe('classifyReceiverEnrollment', () => {
  it('enrolls a normal above-threshold funding as first_funder when it is the first meaningful inbound', () => {
    const v = classifyReceiverEnrollment(ctx({ transferUsd: 1000, isReceiverFirstMeaningfulInbound: true }), L);
    expect(v.enroll).toBe(true);
    expect(v.relationshipKind).toBe('first_funder');
    expect(v.hot).toBe(true);
  });

  it('enrolls a later above-threshold funding as direct_funding (not the first inbound)', () => {
    const v = classifyReceiverEnrollment(ctx({ isReceiverFirstMeaningfulInbound: false }), L);
    expect(v.enroll).toBe(true);
    expect(v.relationshipKind).toBe('direct_funding');
  });

  it('does NOT enroll when the sender is untrusted', () => {
    const v = classifyReceiverEnrollment(ctx({ senderTrusted: false }), L);
    expect(v.enroll).toBe(false);
    expect(v.reason).toMatch(/untrusted/i);
  });

  it('does NOT hot-enroll a service/program receiver, but still allows the edge', () => {
    const v = classifyReceiverEnrollment(ctx({ receiverIsServiceOrProgram: true }), L);
    expect(v.enroll).toBe(false);
    expect(v.persistEdge).toBe(true);
    expect(v.reason).toMatch(/service/i);
  });

  it('GAS EXCEPTION: a tiny FIRST native-SOL funding below minTransferUsd enrolls when receiver activates in window', () => {
    const v = classifyReceiverEnrollment(
      ctx({
        transferUsd: L.gasFundingMaxUsd - 1,
        isNativeSol: true,
        isReceiverFirstMeaningfulInbound: true,
        receiverBecameActiveWithinWindow: true
      }),
      L
    );
    expect(v.enroll).toBe(true);
    expect(v.relationshipKind).toBe('first_funder');
    expect(v.viaGasException).toBe(true);
  });

  it('RAW-SOL GAS: an unpriced ($0) first native-SOL funding within SOL bounds enrolls (USD unavailable)', () => {
    const v = classifyReceiverEnrollment(
      ctx({ transferUsd: 0, usdUnavailable: true, isNativeSol: true, rawSolAmount: 0.01, isReceiverFirstMeaningfulInbound: true, receiverBecameActiveWithinWindow: true }),
      L
    );
    expect(v.enroll).toBe(true);
    expect(v.viaGasException).toBe(true);
    expect(v.relationshipKind).toBe('first_funder');
  });

  it('RAW-SOL GAS: below gasFundingMinSol does NOT enroll (dust-scale)', () => {
    const v = classifyReceiverEnrollment(ctx({ transferUsd: 0, usdUnavailable: true, isNativeSol: true, rawSolAmount: L.gasFundingMinSol / 2 }), L);
    expect(v.enroll).toBe(false);
  });

  it('RAW-SOL GAS: above gasFundingMaxSol does NOT enroll on the raw path', () => {
    const v = classifyReceiverEnrollment(ctx({ transferUsd: 0, usdUnavailable: true, isNativeSol: true, rawSolAmount: L.gasFundingMaxSol * 2 }), L);
    expect(v.enroll).toBe(false);
  });

  it('RAW-SOL GAS: requires activation in window', () => {
    const v = classifyReceiverEnrollment(ctx({ transferUsd: 0, usdUnavailable: true, isNativeSol: true, rawSolAmount: 0.01, receiverBecameActiveWithinWindow: false }), L);
    expect(v.enroll).toBe(false);
  });

  it('UNKNOWN not dust: an unavailable-USD non-gas transfer is unknown, never dust (Codex final review)', () => {
    // A large SPL transfer we could not price: usdUnavailable, not native SOL,
    // placeholder transferUsd 0. Must NOT be classified dust (that would treat
    // unknown as benign); it is unknown and deferred to revaluation.
    const v = classifyReceiverEnrollment(
      ctx({ transferUsd: 0, usdUnavailable: true, isNativeSol: false, isReceiverFirstMeaningfulInbound: true, receiverBecameActiveWithinWindow: true }),
      L
    );
    expect(v.enroll).toBe(false);
    expect(v.unknown).toBe(true);
    expect(v.dust).toBe(false);
    expect(v.persistEdge).toBe(true);
  });

  it('UNKNOWN not dust: an out-of-range unavailable native-SOL transfer is unknown, not dust', () => {
    const v = classifyReceiverEnrollment(
      ctx({ transferUsd: 0, usdUnavailable: true, isNativeSol: true, rawSolAmount: L.gasFundingMaxSol * 2 }),
      L
    );
    expect(v.enroll).toBe(false);
    expect(v.unknown).toBe(true);
    expect(v.dust).toBe(false);
  });

  it('GAS EXCEPTION does NOT apply to a non-native-SOL tiny transfer', () => {
    const v = classifyReceiverEnrollment(
      ctx({ transferUsd: L.gasFundingMaxUsd - 1, isNativeSol: false, isReceiverFirstMeaningfulInbound: true }),
      L
    );
    expect(v.enroll).toBe(false);
    expect(v.dust).toBe(false); // below minTransfer but above dustMax — just below-threshold
  });

  it('GAS EXCEPTION does NOT apply if the receiver never becomes active in the window', () => {
    const v = classifyReceiverEnrollment(
      ctx({ transferUsd: L.gasFundingMaxUsd - 1, isNativeSol: true, receiverBecameActiveWithinWindow: false }),
      L
    );
    expect(v.enroll).toBe(false);
  });

  it('DUST: an inbound at/below dustMaxUsd stores the edge but never enrolls or forms a strong relationship', () => {
    const v = classifyReceiverEnrollment(ctx({ transferUsd: L.dustMaxUsd, isNativeSol: false }), L);
    expect(v.enroll).toBe(false);
    expect(v.dust).toBe(true);
    expect(v.persistEdge).toBe(true);
    expect(v.relationshipKind).toBeUndefined();
  });

  it('a non-fresh, non-inactive receiver of a normal transfer is not hot-enrolled (already active wallet)', () => {
    const v = classifyReceiverEnrollment(ctx({ receiverIsFreshOrInactive: false }), L);
    expect(v.enroll).toBe(false);
    expect(v.persistEdge).toBe(true);
  });
});

describe('relationshipConfidence', () => {
  it('first_funder with activation is strong (>=80)', () => {
    expect(relationshipConfidence('first_funder', { activated: true, interactionCount: 1 })).toBeGreaterThanOrEqual(80);
  });

  it('direct_funding is probable band (50-79)', () => {
    const c = relationshipConfidence('direct_funding', { activated: true, interactionCount: 1 });
    expect(c).toBeGreaterThanOrEqual(50);
    expect(c).toBeLessThan(80);
  });

  it('repeated_transfer confidence grows with interaction count but stays capped at 100', () => {
    const low = relationshipConfidence('repeated_transfer', { activated: false, interactionCount: 2 });
    const high = relationshipConfidence('repeated_transfer', { activated: false, interactionCount: 50 });
    expect(high).toBeGreaterThan(low);
    expect(high).toBeLessThanOrEqual(100);
  });

  it('unknown is weak (<50)', () => {
    expect(relationshipConfidence('unknown', { activated: false, interactionCount: 1 })).toBeLessThan(50);
  });
});
