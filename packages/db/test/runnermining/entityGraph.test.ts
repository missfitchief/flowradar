// FlowRadar — entity graph (roles + entity DNA) tests.

import { describe, expect, it, afterAll, beforeEach } from 'vitest';
import net from 'node:net';
import { prisma } from '../../src/client';
import { buildEntityGraph } from '../../src/runnermining/entityGraph';

const PREFIX = 'EGRPH'; // base58-safe

function probePort(host: string, port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (ok: boolean) => { socket.removeAllListeners(); socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}
const dbReachable = await probePort('localhost', 5439);
const T0 = new Date('2026-06-01T00:00:00Z');
const addr = (s: string) => `${PREFIX}${s}`;

async function cleanup() {
  await prisma.entityDnaProfile.deleteMany({ where: { entityKey: { startsWith: PREFIX } } });
  await prisma.walletRoleAssignment.deleteMany({ where: { walletAddress: { startsWith: PREFIX } } });
  await prisma.receiverEnrollment.deleteMany({ where: { receiverAddress: { startsWith: PREFIX } } });
  await prisma.capitalOutflowPath.deleteMany({ where: { sourceWallet: { startsWith: PREFIX } } });
  await prisma.walletDnaProfile.deleteMany({ where: { walletAddress: { startsWith: PREFIX } } });
  const w = await prisma.wallet.findMany({ where: { address: { startsWith: PREFIX } }, select: { id: true } });
  await prisma.lineageRoot.deleteMany({ where: { walletId: { in: w.map((x) => x.id) } } });
  await prisma.wallet.deleteMany({ where: { address: { startsWith: PREFIX } } });
}

async function seedDna(suffix: string, opts: { completed?: number; wins?: number; losses?: number; pnl?: number } = {}) {
  const address = addr(suffix);
  await prisma.walletDnaProfile.create({
    data: {
      chain: 'SOLANA', walletAddress: address, coverage: 'partial', confidence: 45,
      completedPositions: opts.completed ?? 0, winCount: opts.wins ?? 0, lossCount: opts.losses ?? 0,
      totalRealizedPnlUsd: opts.pnl === undefined ? null : String(opts.pnl),
      reasonCodes: [], receiptsJson: {}, caveats: [], engineVersion: 1, computedAt: T0
    }
  });
  return address;
}

beforeEach(async () => { if (dbReachable) await cleanup(); });
afterAll(async () => { if (!dbReachable) return; await cleanup(); await prisma.$disconnect(); });

describe.skipIf(!dbReachable)('buildEntityGraph', () => {
  it('links receiver to funder, assigns roles, aggregates entity DNA; same-token buys never link', async () => {
    const funder = await seedDna('FNDR', { completed: 3, wins: 2, losses: 1, pnl: 1000 });
    const stranger = await seedDna('STRG', { completed: 2, wins: 1, losses: 1, pnl: 200 });
    const receiver = addr('RCVR');
    await prisma.receiverEnrollment.create({
      data: {
        chain: 'SOLANA', receiverAddress: receiver, receiverClass: 'fresh_receiver',
        sourceEntityKeys: [funder], sourceWallets: [funder], evidenceTiers: ['direct_transfer'],
        firstReceiptTs: T0, totalKnownInflowUsd: '500', deploymentsJson: [{ mint: 'X' }], deployedTokenCount: 1,
        reasonCodes: [], receiptsJson: {}, caveats: [], engineVersion: 1
      }
    });

    const r = await buildEntityGraph(prisma, { chain: 'SOLANA' });
    expect(r.errors).toBe(0);
    expect(r.byRole.fresh_funded_receiver).toBeGreaterThanOrEqual(1);
    expect(r.byRole.execution_wallet).toBeGreaterThanOrEqual(1);
    expect(r.byRole.funding_wallet ?? 0).toBe(0); // funder found via enrollment, not funded paths

    // Receiver and funder share ONE entity; the stranger is separate even
    // though both have DNA (same-token buys never link — no link, no merge).
    const recvRole = await prisma.walletRoleAssignment.findUniqueOrThrow({
      where: { chain_walletAddress_role: { chain: 'SOLANA', walletAddress: receiver, role: 'fresh_funded_receiver' } }
    });
    const funderEntity = recvRole.entityKey;
    expect(funderEntity).not.toBeNull();
    const entity = await prisma.entityDnaProfile.findUniqueOrThrow({
      where: { chain_entityKey: { chain: 'SOLANA', entityKey: funderEntity! } }
    });
    expect(entity.memberWallets).toContain(funder);
    expect(entity.memberWallets).toContain(receiver);
    expect(entity.memberCount).toBe(2);
    expect(entity.completedPositions).toBe(3); // funder's DNA only (receiver has none)
    expect(entity.winRate).toBeCloseTo(2 / 3, 5);
    expect(Number(entity.totalRealizedPnlUsd)).toBe(1000);
    expect(entity.deployedReceivers).toBe(1);
    const strangerEntity = await prisma.entityDnaProfile.findUnique({
      where: { chain_entityKey: { chain: 'SOLANA', entityKey: stranger } }
    });
    expect(strangerEntity).not.toBeNull();
    expect(strangerEntity!.memberCount).toBe(1);

    // Idempotent.
    const r2 = await buildEntityGraph(prisma, { chain: 'SOLANA' });
    expect(r2.errors).toBe(0);
    expect(await prisma.entityDnaProfile.count({ where: { entityKey: funderEntity! } })).toBe(1);
  });

  it('operator roots get the operator_root role and mark their entity', async () => {
    const rootAddr = addr('RQQT');
    const w = await prisma.wallet.create({
      data: { address: rootAddr, chain: 'SOLANA', firstSeenAt: T0, lastActiveAt: T0 },
      select: { id: true }
    });
    await prisma.lineageRoot.create({ data: { walletId: w.id, source: 'operator_import', firstImportedAt: T0, lastSeenInImportAt: T0 } });

    const r = await buildEntityGraph(prisma, { chain: 'SOLANA' });
    expect(r.byRole.operator_root).toBeGreaterThanOrEqual(1);
    const role = await prisma.walletRoleAssignment.findUniqueOrThrow({
      where: { chain_walletAddress_role: { chain: 'SOLANA', walletAddress: rootAddr, role: 'operator_root' } }
    });
    const entity = await prisma.entityDnaProfile.findUniqueOrThrow({
      where: { chain_entityKey: { chain: 'SOLANA', entityKey: role.entityKey! } }
    });
    expect(entity.rootWallet).toBe(rootAddr);
  });
});
