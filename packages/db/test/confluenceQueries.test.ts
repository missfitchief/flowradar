// packages/db/test/confluenceQueries.test.ts
// FlowRadar — getTokenConfluence read-helper integration test (Task E).
// SHADOW-ONLY reads over TokenConfluenceSnapshot + ExternalConfluenceSource.
// Requires LITE Postgres on 5439; skips cleanly otherwise (sibling-test convention).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import net from 'node:net';
import { getTokenConfluence } from '../src/confluence/queries';

function probePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1');
    const done = (ok: boolean) => { sock.destroy(); resolve(ok); };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    sock.setTimeout(1000, () => done(false));
  });
}

const HAS_DB = await probePort(5439);
const d = HAS_DB ? describe : describe.skip;

d('getTokenConfluence (Task E)', () => {
  const prisma = new PrismaClient();
  let tokenId = '';
  const addr = 'ConfTestMint1111111111111111111111111111111';

  beforeAll(async () => {
    const chain = await prisma.chain.upsert({
      where: { id: 'SOLANA' },
      update: {},
      create: {
        id: 'SOLANA', name: 'Solana', nativeSymbol: 'SOL',
        explorerTxUrl: 'https://x/{hash}', explorerAddressUrl: 'https://x/{address}',
      },
    });
    const token = await prisma.token.create({
      data: {
        chain: chain.id, address: addr, symbol: 'CONF', name: 'Conf Test',
        decimals: 9, firstSeenAt: new Date(), riskFlags: [],
      },
    });
    tokenId = token.id;

    const src = await prisma.externalConfluenceSource.create({
      data: { name: 'holderscan-test', provider: 'holderscan', enabled: false, apiKeyEnvName: 'HOLDERSCAN_API_KEY', status: 'missing_key' },
    });

    // Two liquidity_risk snapshots for the SAME token: an older one and a newer
    // one. getTokenConfluence must return ONLY the newer (latest per snapshotType).
    await prisma.tokenConfluenceSnapshot.create({
      data: {
        tokenId, chain: chain.id, tokenAddress: addr, sourceId: null,
        provider: 'internal', snapshotType: 'liquidity_risk', status: 'ok',
        dataJson: { ratioFragilityBand: 'fragile', confidence: 'high' },
        observedAt: new Date('2026-07-01T00:00:00Z'),
        dedupeKey: 'internal:liquidity_risk:' + addr + ':2026070100',
      },
    });
    await prisma.tokenConfluenceSnapshot.create({
      data: {
        tokenId, chain: chain.id, tokenAddress: addr, sourceId: null,
        provider: 'internal', snapshotType: 'liquidity_risk', status: 'ok',
        dataJson: { ratioFragilityBand: 'very_fragile', confidence: 'medium' },
        observedAt: new Date('2026-07-05T00:00:00Z'),
        dedupeKey: 'internal:liquidity_risk:' + addr + ':2026070500',
      },
    });
    // A holder_risk snapshot with a NON-ok status (plan_required) → must surface
    // as-is (unavailable/plan-required is NOT "safe").
    await prisma.tokenConfluenceSnapshot.create({
      data: {
        tokenId, chain: chain.id, tokenAddress: addr, sourceId: src.id,
        provider: 'holderscan', snapshotType: 'holder_risk', status: 'plan_required',
        dataJson: {}, observedAt: new Date('2026-07-05T00:00:00Z'),
        dedupeKey: 'holderscan:holder_risk:' + addr + ':2026070500',
      },
    });
  });

  afterAll(async () => {
    await prisma.tokenConfluenceSnapshot.deleteMany({ where: { tokenAddress: addr } });
    await prisma.externalConfluenceSource.deleteMany({ where: { name: 'holderscan-test' } });
    await prisma.token.deleteMany({ where: { address: addr } });
    await prisma.$disconnect();
  });

  it('returns the LATEST liquidity_risk snapshot per snapshotType', async () => {
    const c = await getTokenConfluence(prisma, tokenId);
    expect(c.liquidityRisk).not.toBeNull();
    expect(c.liquidityRisk!.status).toBe('ok');
    expect((c.liquidityRisk!.dataJson as any).ratioFragilityBand).toBe('very_fragile');
    expect(c.liquidityRisk!.provider).toBe('internal');
  });

  it('surfaces a non-ok holder_risk snapshot with its real status (never coerced to safe)', async () => {
    const c = await getTokenConfluence(prisma, tokenId);
    expect(c.holderRisk).not.toBeNull();
    expect(c.holderRisk!.status).toBe('plan_required');
    expect(c.holderRisk!.sourceName).toBe('holderscan-test');
  });

  it('returns null for snapshotTypes with no rows (honest absence, not a stub row)', async () => {
    const c = await getTokenConfluence(prisma, tokenId);
    expect(c.clobr).toBeNull();
    expect(c.gmgn).toBeNull();
    expect(c.agPaper).toBeNull();
  });

  it('includes source statuses (env presence as boolean-derived mode, never a secret)', async () => {
    const c = await getTokenConfluence(prisma, tokenId);
    expect(Array.isArray(c.sourceStatuses)).toBe(true);
    const serialized = JSON.stringify(c.sourceStatuses);
    expect(serialized).not.toMatch(/HOLDERSCAN_API_KEY=/); // a NAME may appear; a value assignment must not
  });
});
