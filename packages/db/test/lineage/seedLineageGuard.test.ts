// FlowRadar — db:seed lineage-root wipe guard (2026-07-10 Capital Lineage
// review): seeding wipes every wallet, and LineageRoot/MonitoringSubscription
// cascade from Wallet — so seed must REFUSE while permanent operator roots
// exist, unless explicitly overridden.

import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import net from 'node:net';
import { prisma } from '../../src/client';
import { assertNoLineageRootsOrExplicitOverride } from '../../src/seed';

const ADDRESS = 'GuardTestRoot1111111111111111111111111111111'.slice(0, 43);

function probePort(host: string, port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

let dbReachable = false;
beforeAll(async () => {
  dbReachable = await probePort('localhost', 5439);
});

async function cleanup() {
  await prisma.wallet.deleteMany({ where: { address: ADDRESS, chain: 'SOLANA' } });
}

afterAll(async () => {
  if (!dbReachable) return;
  await cleanup();
  await prisma.$disconnect();
});
beforeEach(async () => {
  if (!dbReachable) return;
  await cleanup();
  delete process.env.SEED_WIPE_LINEAGE;
});

describe.skipIf(!(await probePort('localhost', 5439)))('db:seed lineage wipe guard', () => {
  async function createRoot() {
    const now = new Date();
    const wallet = await prisma.wallet.create({
      data: { address: ADDRESS, chain: 'SOLANA', firstSeenAt: now, lastActiveAt: now, status: 'observation_only' }
    });
    await prisma.lineageRoot.create({
      data: { walletId: wallet.id, source: 'operator_file', permanent: true, firstImportedAt: now, lastSeenInImportAt: now }
    });
  }

  it('refuses while permanent lineage roots exist', async () => {
    await createRoot();
    await expect(assertNoLineageRootsOrExplicitOverride()).rejects.toThrow(/lineage root/i);
  });

  it('proceeds with the explicit SEED_WIPE_LINEAGE=true override', async () => {
    await createRoot();
    process.env.SEED_WIPE_LINEAGE = 'true';
    await expect(assertNoLineageRootsOrExplicitOverride()).resolves.toBeUndefined();
  });

  it('proceeds when no roots exist (normal mock-world development flow)', async () => {
    // Shared LITE DB honesty: if real operator roots live in this database
    // (they do after the first production import), the no-roots path cannot
    // be exercised here — assert the guard reads LIVE state and refuses,
    // which is exactly what protects those roots.
    const totalRoots = await prisma.lineageRoot.count();
    if (totalRoots > 0) {
      await expect(assertNoLineageRootsOrExplicitOverride()).rejects.toThrow(/lineage root/i);
      return;
    }
    await expect(assertNoLineageRootsOrExplicitOverride()).resolves.toBeUndefined();
  });
});
