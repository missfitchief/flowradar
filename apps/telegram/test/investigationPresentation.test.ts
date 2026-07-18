import { describe, expect, it } from 'vitest';
import type { InvestigationMemberIntelligence, InvestigationPath, WalletInvestigationResult } from '@flowradar/db';
import { buildInvestigationPresentation } from '../src/investigationPresentation';
import { renderInvestigationReport } from '../src/investigationRenderer';

const SOURCE = '0x0c8300000000000000000000000000000000932d';
const EXECUTION = '0x0000000000000000000000000000000000000001';
const TOKEN = '0x0000000000000000000000000000000000000999';

function intel(tier: 'S' | 'A' | 'B' | 'C', evidence: number, alpha: number, wake: number): InvestigationMemberIntelligence {
  return {
    evidenceScore: evidence, sourceScore: 91, rawHistoricalAlphaScore: alpha + 8,
    sampleAdjustedHistoricalAlphaScore: alpha, alphaConfidence: 0.72, alphaSampleSize: 5,
    alphaCalibration: { sampleSize: 5, sampleConfidence: 0.72 }, historicalAlphaScore: alpha,
    wakeUpPotential: wake, status: wake >= 70 ? 'dormant_high_value' : 'inactive_low_value', tier,
    trackingPriority: tier === 'S' || tier === 'A' ? 'track_now' : tier === 'B' ? 'watch' : 'context_only',
    independentSignalCount: 3, clusterConclusion: evidence >= 75 ? 'supported' : evidence >= 60 ? 'probable' : 'possible',
    evidenceSignals: [
      { code: 'direct_funding', label: 'Direct funding', strength: 0.9, weight: 28, receiptCount: 2 },
      { code: 'repeated_funding', label: 'Repeated funding', strength: 0.9, weight: 18, receiptCount: 2 },
      { code: 'execution_pattern', label: 'Execution pattern', strength: 0.9, weight: 14, receiptCount: 2 }
    ],
    whyImportant: ['Repeated funding followed by token execution.'], contradictions: [], historicalCoverage: 'partial',
    metrics: { transferCount: 2, uniqueTokensAfterFunding: 2, completedPositions: 5, winRate: 0.8, repeatRunnerCount: 2, realizedPnlUsd: 50_000, medianEntryMcapUsd: 100_000, maxCoveredDormantDays: 90 },
    scoreVersion: 1
  };
}

function investigation(): WalletInvestigationResult {
  const lowPaths = Array.from({ length: 30 }, (_, index) => path(`low-${index}`, `0x${String(index + 100).padStart(40, '0')}`, 28));
  return {
    id: 'intelligence-investigation', investigationKey: `evm:${SOURCE}`, rootAddress: SOURCE, addressKind: 'evm', maxDepth: 4,
    status: 'completed', entityKey: 'entity:test', coverageStatus: 'complete', activityChains: ['BASE'], completedAt: '2026-07-13T01:10:00.000Z',
    coverage: [{ chain: 'BASE', activityFound: true, firstActivityAt: '2026-07-13T01:00:00.000Z', lastActivityAt: '2026-07-13T01:10:00.000Z', eventsScanned: 100, coverageStatus: 'complete', provider: 'test', warnings: [] }],
    counts: { directReceivers: 31, multiHopWallets: 0, bridgeDestinations: 0, probableAltExecutionWallets: 1, profitCollectors: 0, tokenDeployments: 1, possibleCexLinks: 0, strongLinks: 1, probableLinks: 0, possibleLinks: 30 },
    paths: [path('execution', EXECUTION, 18_400), ...lowPaths],
    members: [
      { chain: 'BASE', address: SOURCE, role: 'root_main', parentChain: null, parentAddress: null, entityKey: 'entity:test', relationshipConfidence: 1, evidenceTier: 'investigation_root', firstLinkedAt: '2026-07-13T01:00:00.000Z', lastLinkedAt: '2026-07-13T01:10:00.000Z', observationOnly: true },
      { chain: 'BASE', address: EXECUTION, role: 'execution_wallet', parentChain: 'BASE', parentAddress: SOURCE, entityKey: 'entity:test', relationshipConfidence: 0.9, evidenceTier: 'repeated_direct_funding', firstLinkedAt: '2026-01-01T00:00:00.000Z', lastLinkedAt: '2026-04-01T00:00:00.000Z', observationOnly: true, intelligence: intel('A', 84, 72, 81) },
      ...lowPaths.map((row, index) => ({ chain: 'BASE' as const, address: row.destinationAddress, role: 'fresh_funded_receiver', parentChain: 'BASE' as const, parentAddress: SOURCE, entityKey: null, relationshipConfidence: 0.2, evidenceTier: 'insufficient_evidence', firstLinkedAt: row.eventTs, lastLinkedAt: row.eventTs, observationOnly: true, intelligence: intel(index < 5 ? 'B' : 'C', 42, 8, 22) }))
    ],
    deployments: [{
      id: 'deployment:1', chain: 'BASE', buyerAddress: EXECUTION, tokenAddress: TOKEN, tokenSymbol: 'ALPHA', buyTs: '2026-07-13T01:05:00.000Z', buyTxHash: '0xbuy', amountToken: '100', amountUsd: 2_000, entryMarketCapUsd: 100_000,
      fundingToBuyDelaySec: 300, sourceEntityKey: 'entity:test', capitalRoute: [], holdingStatus: 'holding_or_unresolved', evidenceTier: 'transaction_verified_buy_after_funding',
      intelligence: { athMcapUsd: 10_000_000, athBasis: 'historical_universe', roi: 99, roiBasis: 'ath_over_entry_potential', importanceScore: 96, whyImportant: ['Bought by Tier A wallet.'] }
    }],
    providerReceipts: {}
  };
}

function path(id: string, destination: string, amountUsd: number): InvestigationPath {
  return {
    id, routeType: 'direct', sourceChain: 'BASE', sourceAddress: SOURCE, destinationChain: 'BASE', destinationAddress: destination,
    assetAddress: null, assetSymbol: 'USDC', amountToken: String(amountUsd), amountUsd, valueStatus: 'usd_verified', eventTs: '2026-07-13T01:00:00.000Z',
    txHash: `0x${id}`, protocol: null, evidenceTier: 'exact_direct_transfer', confidence: 0.9, supportingEvidence: {}, contradictingEvidence: {},
    hops: [{ sourceChain: 'BASE', sourceAddress: SOURCE, destinationChain: 'BASE', destinationAddress: destination, assetAddress: null, assetSymbol: 'USDC', amountToken: String(amountUsd), amountUsd, valueStatus: 'usd_verified', timestamp: '2026-07-13T01:00:00.000Z', txHash: `0x${id}`, routeType: 'direct', protocol: null, evidenceTier: 'exact_direct_transfer', confidence: 0.9 }]
  };
}

describe('wallet intelligence presentation', () => {
  it('shows only Tier S/A by default while keeping every backend wallet untouched', () => {
    const value = investigation();
    const presentation = buildInvestigationPresentation(value);

    expect(value.members).toHaveLength(32);
    expect(presentation.analyzedWallets).toBe(32);
    expect(presentation.topWallets).toHaveLength(1);
    expect(presentation.topWallets[0]?.member.address).toBe(EXECUTION);
    expect(presentation.topDormantWallets[0]?.member.address).toBe(EXECUTION);
    expect(presentation.moreWallets).toHaveLength(20);
    expect(presentation.topWallets.every((row) => row.intelligence.tier === 'S' || row.intelligence.tier === 'A')).toBe(true);
  });

  it('limits paths and deployments to intelligence-ranked top results with honest outcome metrics', () => {
    const presentation = buildInvestigationPresentation(investigation());

    expect(presentation.strongestPaths).toHaveLength(1);
    expect(presentation.strongestPaths[0]).toMatchObject({ receiverAddress: EXECUTION, tokenAddress: TOKEN });
    expect(presentation.topDeployments).toHaveLength(1);
    expect(presentation.topDeployments[0]?.deployment.intelligence).toMatchObject({ athMcapUsd: 10_000_000, roi: 99 });
    expect(presentation.topDeployments.length).toBeLessThanOrEqual(10);
  });

  it('renders a bounded five-second hero with no more than three active wallets', () => {
    const value = investigation();
    for (let index = 0; index < 5; index += 1) {
      value.members.push({
        chain: 'BASE', address: `0x${String(index + 700).padStart(40, '0')}`, role: 'execution_wallet', parentChain: 'BASE',
        parentAddress: SOURCE, entityKey: 'entity:test', relationshipConfidence: 0.86, evidenceTier: 'repeated_direct_funding',
        firstLinkedAt: '2026-06-01T00:00:00.000Z', lastLinkedAt: '2026-07-01T00:00:00.000Z', observationOnly: true,
        intelligence: intel('A', 82 - index, 70 - index, 45)
      });
    }
    const presentation = buildInvestigationPresentation(value);
    const rendered = renderInvestigationReport(value, { target: SOURCE, investigationView: 'summary', page: 1, pageSize: 5 }, 'session1');
    expect(rendered.text).toContain('FLOWRADAR INTELLIGENCE');
    expect(rendered.text).toContain('QUICK VERDICT');
    expect(rendered.text).toContain('TIMELINE');
    expect(rendered.text).toContain('WHY THIS MATTERS');
    expect(rendered.text.length).toBeLessThanOrEqual(4_096);
    for (const wallet of presentation.topActiveWallets.slice(0, 3)) expect(rendered.text).toContain(wallet.member.address.slice(-6));
    expect(rendered.text).not.toContain(presentation.topActiveWallets[3]!.member.address.slice(-6));
  });
});
