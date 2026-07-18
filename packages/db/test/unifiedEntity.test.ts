import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/client';
import { buildUnifiedEntityGraph } from '../src/discovery/unifiedEntity';

const TOKEN = `0x${'11'.repeat(20)}`;
const A = `0x${'22'.repeat(20)}`;
const B = `0x${'33'.repeat(20)}`;

async function cleanup() {
  await prisma.unifiedEntityAddress.deleteMany({ where: { address: { in: [A, B] } } });
  await prisma.unifiedEntity.deleteMany({ where: { addresses: { none: {} } } });
  await prisma.tokenTopPnlCandidate.deleteMany({ where: { mint: TOKEN } });
}

function candidate(chain: 'BASE' | 'ARBITRUM', walletAddress: string) {
  return {
    chain, mint: TOKEN, walletAddress, source: 'local_reconstruction', providerRank: 1, localBuyCount: 1, localSellCount: 1,
    localBoughtUsd: 100, localSoldUsd: 200, localRealizedProxyUsd: 100, localUnpricedTrades: 0, validation: 'locally_verified',
    coverage: 'local_full', confidence: 80, reasonCodes: ['test'], receiptsJson: {}, caveats: ['observation_only'], engineVersion: 1
  } as const;
}

beforeEach(cleanup);
afterAll(async () => { await cleanup(); await prisma.$disconnect(); });

describe('unified entity safety', () => {
  it('does not merge two wallets merely because they traded the same token', async () => {
    await prisma.tokenTopPnlCandidate.createMany({ data: [candidate('BASE', A), candidate('BASE', B)] });
    await buildUnifiedEntityGraph(prisma);
    const rows = await prisma.unifiedEntityAddress.findMany({ where: { chain: 'BASE', address: { in: [A, B] } } });
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((x) => x.entityId)).size).toBe(2);
  });

  it('links the same observed EVM account across chains without identity wording', async () => {
    await prisma.tokenTopPnlCandidate.createMany({ data: [candidate('BASE', A), candidate('ARBITRUM', A)] });
    await buildUnifiedEntityGraph(prisma);
    const rows = await prisma.unifiedEntityAddress.findMany({ where: { address: A }, include: { entity: true } });
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((x) => x.entityId)).size).toBe(1);
    expect(rows[0].entity.caveats.join(' ')).toMatch(/not a claim|ne.*claim/i);
  });
});
