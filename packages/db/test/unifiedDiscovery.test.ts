import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/client';
import { runUnifiedProfitableWalletDiscovery, syncHistoricalTokenUniverse } from '../src/discovery/unified';

const MINT = '11111111111111111111111111111119';
const WALLET = '11111111111111111111111111111118';
const NOW = new Date('2026-07-13T16:30:00Z');

async function cleanup() {
  await prisma.profitableWalletDiscoveryRun.deleteMany({ where: { metadataJson: { path: ['chains'], array_contains: ['SOLANA'] } } }).catch(() => undefined);
  await prisma.topPnlExtractionStatus.deleteMany({ where: { mint: MINT } });
  await prisma.tokenTopPnlCandidate.deleteMany({ where: { mint: MINT } });
  await prisma.historicalTokenUniverse.deleteMany({ where: { tokenAddress: MINT } });
  await prisma.tokenLifecycle.deleteMany({ where: { mint: MINT } });
  await prisma.token.deleteMany({ where: { chain: 'SOLANA', address: MINT } });
  await prisma.wallet.deleteMany({ where: { chain: 'SOLANA', address: WALLET } });
}

beforeEach(cleanup);
afterAll(async () => { await cleanup(); await prisma.$disconnect(); });

describe('unified profitable-wallet discovery', () => {
  it('reconstructs a local profitable wallet and preserves observation_only', async () => {
    const wallet = await prisma.wallet.create({ data: { chain: 'SOLANA', address: WALLET, firstSeenAt: NOW, lastActiveAt: NOW, status: 'observation_only' } });
    const token = await prisma.token.create({ data: { chain: 'SOLANA', address: MINT, symbol: 'UDT', name: 'Unified discovery test', decimals: 6, firstSeenAt: NOW, riskFlags: {} } });
    await prisma.tokenLifecycle.create({ data: { mint: MINT, tokenId: token.id, enteredUniverseAt: NOW, sourcesJson: {}, coverage: 'covered', runnerClass: 'verified_above_10m', athMcapUsd: 20_000_000, athTs: NOW, confidence: 'high', evidenceJson: {}, classifiedAt: NOW } });
    await prisma.walletTokenTrade.createMany({ data: [
      { walletId: wallet.id, tokenId: token.id, chain: 'SOLANA', action: 'BUY', amountToken: 100, amountUsd: 100, txHash: 'UDT-buy', blockOrSlot: 1n, ts: NOW, priceUsd: 1, marketCapAtTrade: 1_000_000, walletScoreAtTime: 0, provider: 'test' },
      { walletId: wallet.id, tokenId: token.id, chain: 'SOLANA', action: 'SELL', amountToken: 100, amountUsd: 600, txHash: 'UDT-sell', blockOrSlot: 2n, ts: new Date(NOW.getTime() + 1_000), priceUsd: 6, marketCapAtTrade: 10_000_000, walletScoreAtTime: 0, provider: 'test' }
    ] });
    await syncHistoricalTokenUniverse(prisma);
    const report = await runUnifiedProfitableWalletDiscovery(prisma, { chains: ['SOLANA'], limit: 10, buildDna: false, now: NOW });
    expect(report.localCandidates).toBe(1);
    const candidate = await prisma.tokenTopPnlCandidate.findFirstOrThrow({ where: { chain: 'SOLANA', mint: MINT, walletAddress: WALLET } });
    expect(Number(candidate.localRealizedProxyUsd)).toBe(500);
    expect(candidate.validation).toBe('locally_verified');
    expect((await prisma.wallet.findUniqueOrThrow({ where: { address_chain: { address: WALLET, chain: 'SOLANA' } } })).status).toBe('observation_only');
  });
});
