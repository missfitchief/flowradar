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

  it('CAP: maxNewReceiversPerRootPerDay actually stops enrollment (not just enqueue) — edges still persist', async () => {
    const A = `${PREFIX}_dayRoot`;
    const { root } = await makeRoot(A);
    const legs = Array.from({ length: 6 }, (_, i) => ({
      kind: 'native_transfer' as const,
      from: A,
      to: `${PREFIX}_dayRecv_${i}`,
      asset: { symbol: 'SOL', decimals: 9 },
      amountToken: '5',
      amountUsd: 1000
    }));
    const provider = mapProvider({ [A]: [{ txHash: `${PREFIX}_tx_day`, blockOrSlot: 1n, ts: NOW, legs }] });

    const settings = { ...DEFAULT_SETTINGS, lineage: { ...DEFAULT_SETTINGS.lineage, maxNewReceiversPerRootPerDay: 2, maxChildrenPerNode: 100, maxNodesPerRoot: 100 } };
    const result = await runLineageExpansion(prisma, provider, settings, { rootId: root.id, now: NOW });

    // Only 2 receivers enrolled despite 6 transfers; the day cap is a real
    // enrollment gate now, not just an enqueue gate.
    const enrolled = await prisma.wallet.count({ where: { address: { startsWith: `${PREFIX}_dayRecv_` } } });
    expect(enrolled).toBe(2);
    // ...but all 6 edges are still persisted (observation is not capped).
    expect(result.edgesPersisted).toBe(6);
    expect(result.stopReasons['receiver_day_cap'] ?? 0).toBeGreaterThanOrEqual(1);
  });

  it('SCENARIO 8: an interrupted backfill resumes from the cursor across passes (no lost pages)', async () => {
    const A = `${PREFIX}_resumeRoot`;
    const B1 = `${PREFIX}_resumeB1`;
    const B2 = `${PREFIX}_resumeB2`;
    const { root } = await makeRoot(A);

    // Paginating provider: page 1 -> B1 (nextCursor 'p2'), page 2 -> B2 (end).
    const paging: LineageProvider = {
      async getWalletTransactions(_chain, address, o) {
        if (address !== A) return { txs: [], nextCursor: undefined };
        if (!o?.cursor) return { txs: [nativeTransferTx(`${PREFIX}_tx_r1`, A, B1, 1000)], nextCursor: 'p2' };
        return { txs: [nativeTransferTx(`${PREFIX}_tx_r2`, A, B2, 1000)], nextCursor: undefined };
      }
    };

    // backfillMaxPagesPerNode=1 forces the pass to stop after page 1 with a
    // cursor remaining — the node must stay pending (resumable), not done.
    const settings = { ...DEFAULT_SETTINGS, lineage: { ...DEFAULT_SETTINGS.lineage, backfillMaxPagesPerNode: 1 } };

    await runLineageExpansion(prisma, paging, settings, { rootId: root.id, now: NOW });
    // B1 enrolled from page 1; B2 not yet.
    expect(await prisma.wallet.findUnique({ where: { address_chain: { address: B1, chain: 'SOLANA' } } })).not.toBeNull();
    expect(await prisma.wallet.findUnique({ where: { address_chain: { address: B2, chain: 'SOLANA' } } })).toBeNull();
    const nodeAfter1 = await prisma.lineageExpansionNode.findFirst({ where: { lineageRootId: root.id, walletAddress: A } });
    expect(nodeAfter1!.status).toBe('pending'); // resumable
    expect(nodeAfter1!.cursor).toBe('p2');

    // Second pass resumes from cursor 'p2' -> B2 enrolled, node now done.
    await runLineageExpansion(prisma, paging, settings, { rootId: root.id, now: NOW });
    expect(await prisma.wallet.findUnique({ where: { address_chain: { address: B2, chain: 'SOLANA' } } })).not.toBeNull();
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

    // The node cap is enforced as a running projection: the frontier for this
    // root never exceeds maxNodesPerRoot, and the cap is recorded as a stop
    // reason (10 receivers fan out, but only 3 nodes may exist).
    const rootNodes = await prisma.lineageExpansionNode.count({ where: { lineageRootId: root.id } });
    expect(rootNodes).toBeLessThanOrEqual(settings.lineage.maxNodesPerRoot);
    expect(result.stopReasons['node_cap'] ?? 0).toBeGreaterThanOrEqual(1);
    // Edges for ALL 10 receivers are still persisted (cap gates expansion,
    // not observation).
    expect(result.edgesPersisted).toBe(10);
  });
});
