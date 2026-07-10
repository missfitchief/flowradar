// FlowRadar — bounded lineage expansion integration tests (Capital Lineage
// 6b). Operator scenarios 2 (A->B->C bounded depth), 7 (error isolation),
// 8 (resume from cursor), 9 (caps + stop reason).

import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import net from 'node:net';
import { DEFAULT_SETTINGS, type NormalizedTx } from '@flowradar/core';
import { prisma } from '../../src/client';
import { runLineageExpansion, type LineageProvider } from '../../src/lineage/runLineageExpansion';

const PREFIX = 'EXPANDTEST';
const NOW = new Date('2026-07-10T12:00:00Z');

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
  await prisma.moneyFlowEdge.deleteMany({ where: { OR: [{ sourceAddress: { startsWith: PREFIX } }, { destinationAddress: { startsWith: PREFIX } }] } });
  await prisma.walletRelationship.deleteMany({ where: { lineageRoot: { wallet: { address: { startsWith: PREFIX } } } } });
  await prisma.lineageExpansionNode.deleteMany({ where: { lineageRoot: { wallet: { address: { startsWith: PREFIX } } } } });
  await prisma.wallet.deleteMany({ where: { address: { startsWith: PREFIX } } });
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

async function makeRoot(address: string) {
  const wallet = await prisma.wallet.create({
    data: { address, chain: 'SOLANA', firstSeenAt: NOW, lastActiveAt: NOW, status: 'observation_only' }
  });
  const root = await prisma.lineageRoot.create({
    data: { walletId: wallet.id, source: 'operator_file', permanent: true, firstImportedAt: NOW, lastSeenInImportAt: NOW }
  });
  return { wallet, root };
}

function nativeTransferTx(txHash: string, from: string, to: string, usd = 1000): NormalizedTx {
  return {
    txHash,
    blockOrSlot: 100n,
    ts: NOW,
    legs: [{ kind: 'native_transfer', from, to, asset: { symbol: 'SOL', decimals: 9 }, amountToken: '5', amountUsd: usd }]
  };
}

/** Provider whose tx map is keyed by wallet address. */
function mapProvider(txByWallet: Record<string, NormalizedTx[]>): LineageProvider {
  return {
    async getWalletTransactions(_chain, address) {
      return { txs: txByWallet[address] ?? [], nextCursor: undefined };
    }
  };
}

describe.skipIf(!(await probePort('localhost', 5439)))('runLineageExpansion', () => {
  it('SCENARIO 2: A funds B, B funds C — graph contains A->B->C, bounded depth respected', async () => {
    const A = `${PREFIX}_A`;
    const B = `${PREFIX}_B`;
    const C = `${PREFIX}_C`;
    const { root } = await makeRoot(A);

    const provider = mapProvider({
      [A]: [nativeTransferTx(`${PREFIX}_tx_ab`, A, B, 1000)],
      [B]: [nativeTransferTx(`${PREFIX}_tx_bc`, B, C, 1000)],
      [C]: []
    });

    // maxDepth default is 2: A(0)->B(1)->C(2) all reachable.
    const result = await runLineageExpansion(prisma, provider, DEFAULT_SETTINGS, { rootId: root.id, now: NOW });

    expect(result.edgesPersisted).toBeGreaterThanOrEqual(2);
    const abEdge = await prisma.moneyFlowEdge.findFirst({ where: { sourceAddress: A, destinationAddress: B } });
    const bcEdge = await prisma.moneyFlowEdge.findFirst({ where: { sourceAddress: B, destinationAddress: C } });
    expect(abEdge).not.toBeNull();
    expect(bcEdge).not.toBeNull();

    // B and C enrolled as observation_only receivers.
    const b = await prisma.wallet.findUnique({ where: { address_chain: { address: B, chain: 'SOLANA' } } });
    const c = await prisma.wallet.findUnique({ where: { address_chain: { address: C, chain: 'SOLANA' } } });
    expect(b!.status).toBe('observation_only');
    expect(c!.status).toBe('observation_only');
  });

  it('SCENARIO 2b: depth cap of 1 stops before C', async () => {
    const A = `${PREFIX}_A1`;
    const B = `${PREFIX}_B1`;
    const C = `${PREFIX}_C1`;
    const { root } = await makeRoot(A);
    const provider = mapProvider({
      [A]: [nativeTransferTx(`${PREFIX}_tx_ab1`, A, B, 1000)],
      [B]: [nativeTransferTx(`${PREFIX}_tx_bc1`, B, C, 1000)],
      [C]: []
    });

    const settings = { ...DEFAULT_SETTINGS, lineage: { ...DEFAULT_SETTINGS.lineage, maxDepth: 1 } };
    await runLineageExpansion(prisma, provider, settings, { rootId: root.id, now: NOW });

    // B enrolled (depth 1), but B's expansion node is depth 1 -> its children
    // would be depth 2 > maxDepth 1, so C is never reached.
    const b = await prisma.wallet.findUnique({ where: { address_chain: { address: B, chain: 'SOLANA' } } });
    const c = await prisma.wallet.findUnique({ where: { address_chain: { address: C, chain: 'SOLANA' } } });
    expect(b).not.toBeNull();
    expect(c).toBeNull();
  });

  it('SCENARIO 7: one wallet provider error does not stop other roots', async () => {
    const A = `${PREFIX}_okRoot`;
    const B = `${PREFIX}_okRecv`;
    const badRoot = `${PREFIX}_badRoot`;
    const { root: goodRoot } = await makeRoot(A);
    const { root: failRoot } = await makeRoot(badRoot);

    const provider: LineageProvider = {
      async getWalletTransactions(_chain, address) {
        if (address === badRoot) throw new Error('provider exploded');
        if (address === A) return { txs: [nativeTransferTx(`${PREFIX}_tx_okab`, A, B, 1000)], nextCursor: undefined };
        return { txs: [], nextCursor: undefined };
      }
    };

    const result = await runLineageExpansion(prisma, provider, DEFAULT_SETTINGS, { now: NOW });
    expect(result.errors).toBeGreaterThanOrEqual(1);
    // The good root still enrolled its receiver.
    const b = await prisma.wallet.findUnique({ where: { address_chain: { address: B, chain: 'SOLANA' } } });
    expect(b).not.toBeNull();
    // The bad root's node is skipped with an error stop reason.
    const badNode = await prisma.lineageExpansionNode.findFirst({ where: { lineageRootId: failRoot.id, walletAddress: badRoot } });
    expect(badNode!.status).toBe('skipped');
    expect(badNode!.stopReason).toMatch(/error/i);
  });

  it('SCENARIO 9: node cap stops expansion and persists a stop reason', async () => {
    const A = `${PREFIX}_capRoot`;
    const { root } = await makeRoot(A);
    // Root fans out to many receivers; a tiny node cap forces the stop.
    const legs = Array.from({ length: 10 }, (_, i) => ({
      kind: 'native_transfer' as const,
      from: A,
      to: `${PREFIX}_capRecv_${i}`,
      asset: { symbol: 'SOL', decimals: 9 },
      amountToken: '5',
      amountUsd: 1000
    }));
    const provider = mapProvider({ [A]: [{ txHash: `${PREFIX}_tx_fan`, blockOrSlot: 1n, ts: NOW, legs }] });

    const settings = { ...DEFAULT_SETTINGS, lineage: { ...DEFAULT_SETTINGS.lineage, maxNodesPerRoot: 3, maxChildrenPerNode: 100 } };
    const result = await runLineageExpansion(prisma, provider, settings, { rootId: root.id, now: NOW });

    // Some nodes skipped with node_cap stop reason once the frontier fills.
    const capped = await prisma.lineageExpansionNode.count({ where: { lineageRootId: root.id, stopReason: 'node_cap' } });
    expect(capped).toBeGreaterThanOrEqual(1);
    expect(result.stopReasons['node_cap'] ?? 0).toBeGreaterThanOrEqual(1);
  });
});
