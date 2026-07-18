import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { advanceTimestampCursor, prisma, recordProviderHealth, runProductionIntegrity } from '../src/index';

const provider = 'production_ops_test';
const scope = 'wallet-test-cursor';

describe('production operations', () => {
  beforeEach(async () => {
    await prisma.providerCursorCheckpoint.deleteMany({ where: { provider, scope } });
    await prisma.providerSyncState.deleteMany({ where: { provider, scope } });
    await prisma.providerHealthEvent.deleteMany({ where: { provider } });
  });

  afterAll(async () => {
    await prisma.providerCursorCheckpoint.deleteMany({ where: { provider, scope } });
    await prisma.providerSyncState.deleteMany({ where: { provider, scope } });
    await prisma.providerHealthEvent.deleteMany({ where: { provider } });
    await prisma.$disconnect();
  });

  it('persists a cursor and rejects regression without losing the latest position', async () => {
    const latest = '2026-07-15T12:00:00.000Z';
    const older = '2026-07-15T11:59:59.000Z';
    expect((await advanceTimestampCursor(prisma, { provider, chain: 'SOLANA', scope, nextCursor: latest, eventCount: 3 })).decision).toBe('advanced');
    expect((await advanceTimestampCursor(prisma, { provider, chain: 'SOLANA', scope, nextCursor: older, eventCount: 1 })).decision).toBe('rejected_regression');

    const state = await prisma.providerSyncState.findUnique({ where: { provider_chain_scope: { provider, chain: 'SOLANA', scope } } });
    expect(state?.cursor).toBe(latest);
    const receipts = await prisma.providerCursorCheckpoint.findMany({ where: { provider, scope }, orderBy: { createdAt: 'asc' } });
    expect(receipts.map((receipt) => receipt.decision)).toEqual(['advanced', 'rejected_regression']);
  });

  it('records provider latency, retries and failure classification', async () => {
    await recordProviderHealth(prisma, { provider, chain: 'SOLANA', capability: 'walletActivity', outcome: 'success', latencyMs: 42, retryCount: 1 });
    await recordProviderHealth(prisma, { provider, chain: 'SOLANA', capability: 'walletActivity', outcome: 'rate_limited', latencyMs: 300, retryCount: 2, error: new Error('429 Too Many Requests') });
    const rows = await prisma.providerHealthEvent.findMany({ where: { provider }, orderBy: { occurredAt: 'asc' } });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ outcome: 'success', latencyMs: 42, retryCount: 1, rateLimited: false });
    expect(rows[1]).toMatchObject({ outcome: 'rate_limited', retryCount: 2, rateLimited: true });
  });

  it('persists a machine-readable integrity receipt', async () => {
    const report = await runProductionIntegrity(prisma);
    const row = await prisma.productionIntegrityRun.findUnique({ where: { id: report.id } });
    expect(row?.completedAt).not.toBeNull();
    expect(['passed', 'degraded', 'failed']).toContain(row?.status);
    expect(Array.isArray(row?.checksJson)).toBe(true);
  });
});
