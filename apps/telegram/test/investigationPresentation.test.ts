import { describe, expect, it } from 'vitest';
import type { InvestigationPath, WalletInvestigationResult } from '@flowradar/db';
import { buildInvestigationPresentation } from '../src/investigationPresentation';

const SOURCE = '0x0c8300000000000000000000000000000000932d';

function splitFundingInvestigation(): WalletInvestigationResult {
  const paths = Array.from({ length: 12 }, (_, index) => fundingPath(index));
  return {
    id: 'split-investigation', investigationKey: `evm:${SOURCE}`, rootAddress: SOURCE, addressKind: 'evm', maxDepth: 4,
    status: 'completed', entityKey: 'entity:split', coverageStatus: 'complete', activityChains: ['BASE'], completedAt: '2026-07-13T01:10:00.000Z',
    coverage: [{ chain: 'BASE', activityFound: true, firstActivityAt: '2026-07-13T01:00:00.000Z', lastActivityAt: '2026-07-13T01:10:00.000Z', eventsScanned: 12, coverageStatus: 'complete', provider: 'test', warnings: [] }],
    counts: { directReceivers: 0, multiHopWallets: 12, bridgeDestinations: 0, probableAltExecutionWallets: 0, profitCollectors: 0, tokenDeployments: 0, possibleCexLinks: 0, strongLinks: 0, probableLinks: 0, possibleLinks: 12 },
    paths,
    members: [rootMember(), ...paths.map((path) => ({
      chain: 'BASE' as const, address: path.destinationAddress, role: 'fresh_funded_receiver', parentChain: 'BASE' as const, parentAddress: SOURCE,
      entityKey: 'entity:split', relationshipConfidence: 0.3, evidenceTier: 'multi_hop_inference', firstLinkedAt: path.eventTs,
      lastLinkedAt: path.eventTs, observationOnly: true
    }))],
    deployments: [], providerReceipts: {}
  };
}

function fundingPath(index: number): InvestigationPath {
  const destination = `0x${String(index + 1).padStart(40, '0')}`;
  return {
    id: `path-${index}`, routeType: 'multi_hop', sourceChain: 'BASE', sourceAddress: SOURCE, destinationChain: 'BASE', destinationAddress: destination,
    assetAddress: null, assetSymbol: 'USDC', amountToken: '28', amountUsd: 28, valueStatus: 'usd_verified', eventTs: '2026-07-13T01:00:00.000Z',
    txHash: '0xsplit', protocol: null, evidenceTier: 'multi_hop_inference', confidence: 0.3, supportingEvidence: {}, contradictingEvidence: {},
    hops: [{ sourceChain: 'BASE', sourceAddress: SOURCE, destinationChain: 'BASE', destinationAddress: destination, assetAddress: null, assetSymbol: 'USDC', amountToken: '28', amountUsd: 28, valueStatus: 'usd_verified', timestamp: '2026-07-13T01:00:00.000Z', txHash: '0xsplit', routeType: 'multi_hop', protocol: null, evidenceTier: 'multi_hop_inference', confidence: 0.3 }]
  };
}

function rootMember() {
  return {
    chain: 'BASE' as const, address: SOURCE, role: 'root_main', parentChain: null, parentAddress: null, entityKey: 'entity:split',
    relationshipConfidence: 1, evidenceTier: 'investigation_root', firstLinkedAt: '2026-07-13T01:00:00.000Z',
    lastLinkedAt: '2026-07-13T01:10:00.000Z', observationOnly: true
  };
}

describe('wallet investigation presentation filtering', () => {
  it('keeps every relation while grouping repeated $28 funding as one low-priority event', () => {
    const persisted = splitFundingInvestigation();
    const presentation = buildInvestigationPresentation(persisted);

    expect(presentation.totalRelations).toBe(12);
    expect(persisted.paths).toHaveLength(12);
    expect(presentation.relationGroups).toHaveLength(1);
    expect(presentation.relationGroups[0]).toMatchObject({
      label: 'SPLIT FUNDING', relationCount: 12, totalAmountUsd: 336, classification: 'low_priority', deploymentCount: 0
    });
    expect(presentation.relationGroups[0]?.receivers).toHaveLength(12);
    expect(presentation.priorityFindings).toHaveLength(0);
    expect(presentation.hiddenRelations).toBe(12);
  });

  it('deduplicates the same token buy receipt and ranks the deployment first', () => {
    const value = splitFundingInvestigation();
    const receiver = value.paths[0]!.destinationAddress;
    value.deployments = [{
      id: 'deployment-empty-symbol', chain: 'BASE', buyerAddress: receiver, tokenAddress: '0x0000000000000000000000000000000000000999', tokenSymbol: null,
      buyTs: '2026-07-13T01:05:00.000Z', buyTxHash: '0xbuy', amountToken: '50', amountUsd: 100, entryMarketCapUsd: null,
      fundingToBuyDelaySec: 300, sourceEntityKey: 'entity:split', capitalRoute: [], holdingStatus: 'holding_or_unresolved', evidenceTier: 'transaction_verified_buy_after_funding'
    }, {
      id: 'deployment-complete', chain: 'BASE', buyerAddress: receiver, tokenAddress: '0x0000000000000000000000000000000000000999', tokenSymbol: 'NEW',
      buyTs: '2026-07-13T01:05:00.000Z', buyTxHash: '0xbuy', amountToken: '50', amountUsd: 100, entryMarketCapUsd: null,
      fundingToBuyDelaySec: 300, sourceEntityKey: 'entity:split', capitalRoute: [], holdingStatus: 'holding_or_unresolved', evidenceTier: 'transaction_verified_buy_after_funding'
    }];
    const presentation = buildInvestigationPresentation(value);

    expect(presentation.deploymentFindings).toHaveLength(1);
    expect(presentation.deploymentFindings[0]).toMatchObject({ kind: 'deployment', tokenSymbol: 'NEW' });
    expect(presentation.priorityFindings[0]?.kind).toBe('deployment');
  });
});
