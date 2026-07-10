// FlowRadar — importRootWallets integration tests (Capital Lineage Engine,
// Phase 6a). Operator contract: dynamic (N from input), idempotent,
// incremental, preservation-first. Every count below is derived from the
// fixture each test builds — no fixed root-count assumption anywhere.

import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import net from 'node:net';
import { prisma } from '../../src/client';
import { importRootWallets } from '../../src/lineage/importRootWallets';

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

// Deterministic synthetic 32-byte pubkeys, seeded per test run family. The
// seed offset keeps this suite's addresses disjoint from any other suite
// using the same generator shape.
function syntheticAddress(seed: number): string {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = (seed * 131 + i * 17 + 3) % 256;
  if (bytes[0] === 0) bytes[0] = 7;
  let acc = 0n;
  for (const b of bytes) acc = (acc << 8n) | BigInt(b);
  let out = '';
  while (acc > 0n) {
    out = BASE58_ALPHABET[Number(acc % 58n)] + out;
    acc /= 58n;
  }
  return out;
}

/** Every address this suite ever creates, for precise cleanup. */
const createdAddresses = new Set<string>();
function addr(seed: number): string {
  const a = syntheticAddress(seed);
  createdAddresses.add(a);
  return a;
}

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
  const addresses = [...createdAddresses];
  if (addresses.length === 0) return;
  // LineageRoot + MonitoringSubscription cascade from wallet deletion.
  await prisma.wallet.deleteMany({ where: { address: { in: addresses }, chain: 'SOLANA' } });
}

afterAll(async () => {
  if (!dbReachable) return;
  await cleanup();
  await prisma.$disconnect();
});
beforeEach(async () => {
  if (!dbReachable) return;
  await cleanup();
});

describe.skipIf(!(await probePort('localhost', 5439)))('importRootWallets', () => {
  it('imports all valid unique roots from an arbitrary-size fixture (N derived from input; 120 here)', async () => {
    const n = 120;
    const addresses = Array.from({ length: n }, (_, i) => addr(1000 + i));
    const result = await importRootWallets(prisma, addresses.join('\n'), { fileProvenance: 'test-120.txt' });

    expect(result.validRoots).toBe(n);
    expect(result.newRoots).toBe(n);
    expect(result.existingRoots).toBe(0);
    expect(result.walletsCreated).toBe(n);

    const rootCount = await prisma.lineageRoot.count({ where: { wallet: { address: { in: addresses } } } });
    const subCount = await prisma.monitoringSubscription.count({
      where: { priority: 'root_permanent', wallet: { address: { in: addresses } } }
    });
    expect(rootCount).toBe(n);
    expect(subCount).toBe(n);
  });

  it('works with exactly 1 root', async () => {
    const a = addr(2000);
    const result = await importRootWallets(prisma, a, { fileProvenance: 'test-1.txt' });
    expect(result.validRoots).toBe(1);
    expect(result.newRoots).toBe(1);

    const wallet = await prisma.wallet.findUnique({
      where: { address_chain: { address: a, chain: 'SOLANA' } },
      include: { lineageRoot: true, monitoringSubscriptions: true }
    });
    expect(wallet!.status).toBe('observation_only'); // NEVER signal_eligible from a root import
    expect(wallet!.isWatched).toBe(false);
    expect(wallet!.lineageRoot).not.toBeNull();
    expect(wallet!.lineageRoot!.permanent).toBe(true);
    expect(wallet!.lineageRoot!.source).toBe('operator_file');
    expect(wallet!.monitoringSubscriptions).toHaveLength(1);
    expect(wallet!.monitoringSubscriptions[0]).toMatchObject({ priority: 'root_permanent', active: true });
    // No stats rows: an address-only import claims nothing.
    const stats = await prisma.walletStats.count({ where: { walletId: wallet!.id } });
    expect(stats).toBe(0);
  });

  it('deduplicates repeated addresses within one file', async () => {
    const a = addr(3000);
    const b = addr(3001);
    const result = await importRootWallets(prisma, [a, b, a, a].join('\n'), { fileProvenance: 'test-dupes.txt' });
    expect(result.validRoots).toBe(2);
    expect(result.duplicateRows).toBe(2);
    expect(await prisma.lineageRoot.count({ where: { wallet: { address: { in: [a, b] } } } })).toBe(2);
  });

  it('incremental second import adds ONLY new roots; removed addresses are never deleted', async () => {
    const first = [addr(4000), addr(4001)];
    const second = [first[0]!, addr(4002)]; // drops first[1], adds one new

    await importRootWallets(prisma, first.join('\n'), { fileProvenance: 'inc-1.txt' });
    const result = await importRootWallets(prisma, second.join('\n'), { fileProvenance: 'inc-2.txt' });

    expect(result.validRoots).toBe(2);
    expect(result.existingRoots).toBe(1);
    expect(result.newRoots).toBe(1);

    // Requirement 8: first[1] is absent from the second file — its root and
    // subscription must still exist.
    const dropped = await prisma.wallet.findUnique({
      where: { address_chain: { address: first[1]!, chain: 'SOLANA' } },
      include: { lineageRoot: true, monitoringSubscriptions: true }
    });
    expect(dropped!.lineageRoot).not.toBeNull();
    expect(dropped!.monitoringSubscriptions).toHaveLength(1);
  });

  it('re-import is idempotent and preserves existing classification AND monitoring state', async () => {
    const kolAddr = addr(5000);
    const coldAddr = addr(5001);
    const now = new Date();

    // Pre-existing classified wallet: import must not touch its status.
    await prisma.wallet.create({
      data: { address: kolAddr, chain: 'SOLANA', firstSeenAt: now, lastActiveAt: now, isWatched: false, status: 'public_kol', notes: 'classified before import' }
    });

    const content = [kolAddr, coldAddr].join('\n');
    await importRootWallets(prisma, content, { fileProvenance: 'pres-1.txt' });

    // Operator deactivates the cold wallet's subscription between imports.
    await prisma.monitoringSubscription.updateMany({
      where: { wallet: { address: coldAddr, chain: 'SOLANA' } },
      data: { active: false }
    });

    const result = await importRootWallets(prisma, content, { fileProvenance: 'pres-2.txt' });
    expect(result.existingRoots).toBe(2);
    expect(result.newRoots).toBe(0);
    expect(result.walletsCreated).toBe(0);

    const kol = await prisma.wallet.findUnique({ where: { address_chain: { address: kolAddr, chain: 'SOLANA' } } });
    expect(kol!.status).toBe('public_kol'); // classification preserved
    expect(kol!.notes).toBe('classified before import'); // notes preserved

    const coldSub = await prisma.monitoringSubscription.findFirst({
      where: { wallet: { address: coldAddr, chain: 'SOLANA' }, priority: 'root_permanent' }
    });
    expect(coldSub!.active).toBe(false); // deactivation preserved — re-import never reactivates

    // No duplicate roots/subscriptions stacked by the re-import.
    expect(await prisma.lineageRoot.count({ where: { wallet: { address: { in: [kolAddr, coldAddr] } } } })).toBe(2);
    expect(
      await prisma.monitoringSubscription.count({ where: { wallet: { address: { in: [kolAddr, coldAddr] } } } })
    ).toBe(2);
  });

  it('enforces the configurable operational safety limit (explicit opt), rejecting rather than partially importing', async () => {
    const addresses = Array.from({ length: 5 }, (_, i) => addr(6000 + i));
    await expect(importRootWallets(prisma, addresses.join('\n'), { maxRoots: 3 })).rejects.toThrow(/safety limit/i);
    expect(await prisma.lineageRoot.count({ where: { wallet: { address: { in: addresses } } } })).toBe(0);
  });

  it('preserves inline labels onto the LineageRoot record', async () => {
    const a = addr(7000);
    await importRootWallets(prisma, `${a} | telegram insider batch 3`, { fileProvenance: 'labels.txt' });
    const root = await prisma.lineageRoot.findFirst({ where: { wallet: { address: a, chain: 'SOLANA' } } });
    expect(root!.label).toBe('telegram insider batch 3');
  });
});
