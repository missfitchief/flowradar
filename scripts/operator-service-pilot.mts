import 'dotenv/config';
import { OperatorService, prisma } from '@flowradar/db';

if (process.env.MOCK_MODE !== 'false') throw new Error('operator pilot requires MOCK_MODE=false');
const service = new OperatorService(prisma);
try {
  const [solWallet, evmWallet, evmEntityAddress, solToken, evmToken, entity, bridge, trace] = await Promise.all([
    prisma.tokenTopPnlCandidate.findFirst({ where: { chain: 'SOLANA' }, orderBy: { confidence: 'desc' } }),
    prisma.tokenTopPnlCandidate.findFirst({ where: { chain: { in: ['ETHEREUM', 'BASE', 'ARBITRUM', 'BSC'] } }, orderBy: { confidence: 'desc' } }),
    prisma.unifiedEntityAddress.findFirst({ where: { chain: { in: ['ETHEREUM', 'BASE', 'ARBITRUM', 'BSC'] }, role: { not: 'service_router_cex_node' } }, orderBy: { confidence: 'desc' } }),
    prisma.tokenTopPnlCandidate.findFirst({ where: { chain: 'SOLANA' }, orderBy: { updatedAt: 'desc' } }),
    prisma.tokenTopPnlCandidate.findFirst({ where: { chain: { in: ['ETHEREUM', 'BASE', 'ARBITRUM', 'BSC'] } }, orderBy: { updatedAt: 'desc' } }),
    prisma.unifiedEntity.findFirst({ orderBy: { memberCount: 'desc' } }),
    prisma.massBridgeCorrelation.findFirst({ where: { status: 'verified' }, orderBy: { correlatedAt: 'desc' } }),
    prisma.massTrackerTrace.findFirst({ orderBy: { computedAt: 'desc' } })
  ]);
  const bridgeSource = bridge ? await prisma.massTransactionEvent.findUnique({ where: { eventId: bridge.sourceEventId } }) : null;
  const solanaWallet = solWallet ? await service.walletSummary(solWallet.walletAddress) : null;
  const evmWalletAddress = evmWallet?.walletAddress ?? evmEntityAddress?.address ?? null;
  const evmWalletResult = evmWalletAddress ? await service.walletSummary(evmWalletAddress) : null;
  const solanaToken = solToken ? await service.tokenSummary(solToken.mint) : null;
  const evmTokenResult = evmToken ? await service.tokenSummary(evmToken.mint) : null;
  const profitableSolana = await service.profitable({ chain: 'SOLANA', pageSize: 5 });
  const profitableEvm = await service.profitable({ chain: evmWallet?.chain ?? evmEntityAddress?.chain ?? 'BSC', pageSize: 5 });
  const entityResult = entity ? await service.entity(entity.entityKey) : null;
  const bridgeResult = bridgeSource ? await service.bridges(bridgeSource.fromAddress) : null;
  const exported = await service.exportWorkflow('profitable', { chain: 'ALL', sort: 'pnl', page: 1, pageSize: 5 }, 'csv');
  const watch = solWallet ? await service.watch('flowradar-local-pilot', 'flowradar-local-pilot', solWallet.walletAddress) : null;
  const watches = await service.listWatches('flowradar-local-pilot', 'flowradar-local-pilot');
  const report = {
    mockMode: false,
    solanaWallet: solanaWallet ? { address: solanaWallet.address, chains: solanaWallet.detectedChains, role: solanaWallet.role, entityKey: solanaWallet.entityKey, events: solanaWallet.eventCounts, positions: solanaWallet.positions.length, winRate: solanaWallet.winRate, coverageWarnings: solanaWallet.coverageWarnings } : { coverageBlocker: 'no Solana top-PnL wallet persisted' },
    evmWallet: evmWalletResult ? { address: evmWalletResult.address, chains: evmWalletResult.detectedChains, role: evmWalletResult.role, entityKey: evmWalletResult.entityKey, events: evmWalletResult.eventCounts, coverageWarnings: evmWalletResult.coverageWarnings } : { coverageBlocker: 'no EVM top-PnL wallet persisted' },
    solanaToken: solanaToken ? { mint: solToken?.mint, tokens: solanaToken.tokens, topPnlTotal: solanaToken.topPnl.total, topPnlReturned: solanaToken.topPnl.items.length, coverageWarnings: solanaToken.coverageWarnings } : { coverageBlocker: 'no Solana top-PnL token persisted' },
    evmToken: evmTokenResult ? { mint: evmToken?.mint, tokens: evmTokenResult.tokens, topPnlTotal: evmTokenResult.topPnl.total, topPnlReturned: evmTokenResult.topPnl.items.length, coverageWarnings: evmTokenResult.coverageWarnings } : { coverageBlocker: 'no EVM top-PnL token persisted' },
    profitableSolana: { total: profitableSolana.total, returned: profitableSolana.items.length, first: profitableSolana.items[0] ?? null },
    profitableEvm: { chain: evmWallet?.chain ?? evmEntityAddress?.chain ?? 'BSC', total: profitableEvm.total, returned: profitableEvm.items.length, first: profitableEvm.items[0] ?? null },
    entity: entityResult ? { entityKey: entityResult.entityKey, addresses: entityResult.addresses.length, chains: [...new Set(entityResult.addresses.map((x) => x.chain))], metrics: entityResult.metrics } : { coverageBlocker: 'no unified entity persisted' },
    bridge: bridgeResult ? { total: bridgeResult.total, returned: bridgeResult.items.length, first: bridgeResult.items[0] ?? null } : { coverageBlocker: 'no verified bridge correlation persisted' },
    capitalTrace: trace ? { traceId: trace.traceId, sourceEntityKey: trace.sourceEntityKey, sourceWallet: trace.sourceWallet, terminalWallet: trace.terminalWallet, tokenBought: trace.tokenBought, route: trace.route, eventCount: trace.eventIds.length, bridgeCorrelationCount: trace.bridgeCorrelationIds.length, confidence: trace.confidence, grantsEligibility: trace.grantsEligibility } : { coverageBlocker: 'no entity-to-token-buy mass tracker trace persisted' },
    watchlist: { createdId: watch?.id ?? null, persistedCount: watches.length },
    export: { filename: exported.filename, mimeType: exported.mimeType, bytes: Buffer.byteLength(exported.content) }
  };
  console.log(JSON.stringify(report, null, 2));
} finally { await prisma.$disconnect(); }
