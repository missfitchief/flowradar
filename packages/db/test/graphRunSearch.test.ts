// FlowRadar — runGraphSearch integration tests (Task 20 binding decision 2).
// Same LITE-Postgres integration pattern as ingest.test.ts / fundingEvents.test.ts.

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import net from 'node:net';
import { prisma } from '../src/client';
import { runGraphSearch } from '../src/graph/runSearch';

const ADDR_PREFIX = 'T20RUN';
const CHAIN = 'SOLANA' as const;

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
  if (!dbReachable) {
    // eslint-disable-next-line no-console
    console.warn(
      '[graphRunSearch.test] LITE Postgres not reachable on localhost:5439 — skipping ' +
        'integration tests. Run `npm run db:migrate` first to exercise this suite.'
    );
  }
});

let createdSearchIds: string[] = [];

afterAll(async () => {
  if (!dbReachable) return;
  if (createdSearchIds.length > 0) {
    await prisma.walletGraphEdge.deleteMany({ where: { searchId: { in: createdSearchIds } } });
    await prisma.walletGraphNode.deleteMany({ where: { searchId: { in: createdSearchIds } } });
    await prisma.walletGraphSearch.deleteMany({ where: { id: { in: createdSearchIds } } });
  }
  await prisma.moneyFlowEdge.deleteMany({ where: { sourceAddress: { startsWith: ADDR_PREFIX } } });
  await prisma.moneyFlowEdge.deleteMany({ where: { destinationAddress: { startsWith: ADDR_PREFIX } } });
  await prisma.$disconnect();
});

const ROOT = `${ADDR_PREFIX}root`;
const HOP1 = `${ADDR_PREFIX}hop1`;
const HOP2 = `${ADDR_PREFIX}hop2`;

describe.skipIf(!(await probePort('localhost', 5439)))('runGraphSearch', () => {
  beforeAll(async () => {
    // Ensure a Settings row exists (runGraphSearch falls back to
    // DEFAULT_SETTINGS if none is found, but exercising the real read path
    // matches production behavior more closely).
    const existing = await prisma.settings.findFirst();
    if (!existing) {
      const { DEFAULT_SETTINGS } = await import('@flowradar/core');
      await prisma.settings.create({ data: { values: DEFAULT_SETTINGS } });
    }

    const baseTs = new Date('2026-07-03T00:00:00Z');
    await prisma.moneyFlowEdge.create({
      data: {
        sourceAddress: ROOT,
        destinationAddress: HOP1,
        sourceChain: CHAIN,
        destinationChain: CHAIN,
        asset: 'SOL',
        amountToken: 20,
        amountUsd: 3000,
        ts: baseTs,
        txHash: `${ADDR_PREFIX}tx1`,
        actionType: 'transfer',
        confidence: 100,
        providerSource: 'test',
        metadata: {}
      }
    });
    await prisma.moneyFlowEdge.create({
      data: {
        sourceAddress: HOP1,
        destinationAddress: HOP2,
        sourceChain: CHAIN,
        destinationChain: CHAIN,
        asset: 'SOL',
        amountToken: 18,
        amountUsd: 2700,
        ts: new Date(baseTs.getTime() + 60 * 60 * 1000),
        txHash: `${ADDR_PREFIX}tx2`,
        actionType: 'transfer',
        confidence: 100,
        providerSource: 'test',
        metadata: {}
      }
    });
  });

  it('runs a search end-to-end: status done, persisted nodes+edges, counts match', async () => {
    const search = await prisma.walletGraphSearch.create({
      data: {
        rootAddress: ROOT,
        chain: CHAIN,
        mode: 'CAPITAL_FLOW',
        params: { maxDepth: 3 },
        status: 'queued',
        nodeCount: 0,
        edgeCount: 0
      }
    });
    createdSearchIds.push(search.id);

    const result = await runGraphSearch(prisma, search.id);

    expect(result.status === 'done' || result.status === 'truncated').toBe(true);
    expect(result.nodeCount).toBeGreaterThanOrEqual(3); // root + hop1 + hop2

    const updated = await prisma.walletGraphSearch.findUniqueOrThrow({ where: { id: search.id } });
    expect(updated.status === 'done' || updated.status === 'truncated').toBe(true);
    expect(updated.startedAt).not.toBeNull();
    expect(updated.finishedAt).not.toBeNull();
    expect(updated.nodeCount).toBe(result.nodeCount);
    expect(updated.edgeCount).toBe(result.edgeCount);
    expect(updated.resultSummary).not.toBeNull();

    const persistedNodes = await prisma.walletGraphNode.findMany({ where: { searchId: search.id } });
    expect(persistedNodes.length).toBe(result.nodeCount);
    const addresses = persistedNodes.map((n) => n.address);
    expect(addresses).toEqual(expect.arrayContaining([ROOT, HOP1, HOP2]));

    const persistedEdges = await prisma.walletGraphEdge.findMany({ where: { searchId: search.id } });
    expect(persistedEdges.length).toBe(result.edgeCount);
    expect(persistedEdges.length).toBeGreaterThanOrEqual(2);
  });

  it('never leaves a search in "running" status even when it fails (nonexistent search id)', async () => {
    // A search id that doesn't exist should throw when loaded, but that
    // throw happens BEFORE the "set running" write, so there is no row to
    // check here — this test instead documents/asserts the throw itself
    // propagates rather than silently swallowing.
    await expect(runGraphSearch(prisma, 'nonexistent-search-id')).rejects.toThrow();
  });
});
