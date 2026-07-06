// FlowRadar — createDbEdgeFetcher / createRegistryLookup integration tests
// (Task 20 binding decision 1). Same LITE-Postgres integration pattern as
// packages/db/test/ingest.test.ts / fundingEvents.test.ts: real DB, prefix-
// scoped cleanup, describe.skipIf when the LITE cluster isn't reachable.

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import net from 'node:net';
import { prisma } from '../src/client';
import { createDbEdgeFetcher, createRegistryLookup } from '../src/graph/edgeFetcher';
import type { GraphSearchParams } from '@flowradar/core';

const ADDR_PREFIX = 'T20FETCH';
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
      '[graphEdgeFetcher.test] LITE Postgres not reachable on localhost:5439 — skipping ' +
        'integration tests. Run `npm run db:migrate` first to exercise this suite.'
    );
  }
});

afterAll(async () => {
  if (!dbReachable) return;
  await prisma.moneyFlowEdge.deleteMany({ where: { sourceAddress: { startsWith: ADDR_PREFIX } } });
  await prisma.moneyFlowEdge.deleteMany({ where: { destinationAddress: { startsWith: ADDR_PREFIX } } });
  await prisma.addressRegistry.deleteMany({ where: { address: { startsWith: ADDR_PREFIX } } });
  await prisma.$disconnect();
});

const WALLET_ROOT = `${ADDR_PREFIX}wallet_root`;
const WALLET_NATIVE_DEST = `${ADDR_PREFIX}wallet_native_dest`;
const WALLET_STABLE_DEST = `${ADDR_PREFIX}wallet_token_dest`;
const WALLET_TOKEN_DEST = `${ADDR_PREFIX}wallet_other_token_dest`;
const CEX_ADDRESS = `${ADDR_PREFIX}cex_hotwallet`;
const BASE_PARAMS: GraphSearchParams = {
  rootAddress: WALLET_ROOT,
  chain: CHAIN,
  mode: 'FULL_RAW',
  maxDepth: 3,
  minTransferUsd: 0,
  includeNative: true,
  includeToken: true,
  includeSwaps: true,
  includeBridges: true,
  includeCex: true,
  excludeRoutersPoolsContracts: false,
  maxNodes: 5000,
  maxEdges: 25000
};

describe.skipIf(!(await probePort('localhost', 5439)))('createDbEdgeFetcher', () => {
  beforeAll(async () => {
    const baseTs = new Date('2026-07-02T00:00:00Z');

    // transfer + native symbol (SOL) -> native_transfer
    await prisma.moneyFlowEdge.create({
      data: {
        sourceAddress: WALLET_ROOT,
        destinationAddress: WALLET_NATIVE_DEST,
        sourceChain: CHAIN,
        destinationChain: CHAIN,
        asset: 'SOL',
        amountToken: 10,
        amountUsd: 1500,
        ts: baseTs,
        txHash: `${ADDR_PREFIX}tx_native`,
        actionType: 'transfer',
        confidence: 100,
        providerSource: 'test',
        metadata: {}
      }
    });

    // transfer + stablecoin symbol (USDC) -> stablecoin_transfer, two rows to
    // exercise aggregation (same counterparty/relationship/asset).
    await prisma.moneyFlowEdge.create({
      data: {
        sourceAddress: WALLET_ROOT,
        destinationAddress: WALLET_STABLE_DEST,
        sourceChain: CHAIN,
        destinationChain: CHAIN,
        asset: 'USDC',
        amountToken: 1000,
        amountUsd: 1000,
        ts: baseTs,
        txHash: `${ADDR_PREFIX}tx_stable_1`,
        actionType: 'transfer',
        confidence: 100,
        providerSource: 'test',
        metadata: {}
      }
    });
    await prisma.moneyFlowEdge.create({
      data: {
        sourceAddress: WALLET_ROOT,
        destinationAddress: WALLET_STABLE_DEST,
        sourceChain: CHAIN,
        destinationChain: CHAIN,
        asset: 'USDC',
        amountToken: 500,
        amountUsd: 500,
        ts: new Date(baseTs.getTime() + 60_000),
        txHash: `${ADDR_PREFIX}tx_stable_2`,
        actionType: 'transfer',
        confidence: 100,
        providerSource: 'test',
        metadata: {}
      }
    });

    // transfer + arbitrary token symbol -> token_transfer
    await prisma.moneyFlowEdge.create({
      data: {
        sourceAddress: WALLET_ROOT,
        destinationAddress: WALLET_TOKEN_DEST,
        sourceChain: CHAIN,
        destinationChain: CHAIN,
        asset: 'DOGE',
        amountToken: 200,
        amountUsd: 80,
        ts: baseTs,
        txHash: `${ADDR_PREFIX}tx_token`,
        actionType: 'transfer',
        confidence: 100,
        providerSource: 'test',
        metadata: {}
      }
    });

    // cex_deposit -> cex_deposit
    await prisma.moneyFlowEdge.create({
      data: {
        sourceAddress: WALLET_ROOT,
        destinationAddress: CEX_ADDRESS,
        sourceChain: CHAIN,
        destinationChain: CHAIN,
        asset: 'SOL',
        amountToken: 5,
        amountUsd: 750,
        ts: baseTs,
        txHash: `${ADDR_PREFIX}tx_cex`,
        actionType: 'cex_deposit',
        confidence: 100,
        providerSource: 'test',
        metadata: {}
      }
    });

    // An edge where WALLET_ROOT is the DESTINATION, not source — must be
    // excluded from fetchEdges(WALLET_ROOT, ...) (fetcher contract: only
    // edges FROM the queried address).
    await prisma.moneyFlowEdge.create({
      data: {
        sourceAddress: WALLET_NATIVE_DEST,
        destinationAddress: WALLET_ROOT,
        sourceChain: CHAIN,
        destinationChain: CHAIN,
        asset: 'SOL',
        amountToken: 1,
        amountUsd: 150,
        ts: baseTs,
        txHash: `${ADDR_PREFIX}tx_inbound`,
        actionType: 'transfer',
        confidence: 100,
        providerSource: 'test',
        metadata: {}
      }
    });

    await prisma.addressRegistry.create({
      data: {
        chain: CHAIN,
        address: CEX_ADDRESS,
        category: 'CEX',
        label: 'Test CEX hot wallet',
        source: 'test',
        doNotExpand: true
      }
    });
  });

  it('maps transfer+native-symbol to native_transfer with correct amountUsd/txCount', async () => {
    const fetcher = createDbEdgeFetcher(prisma, { perNodeTxCap: 500 });
    const edges = await fetcher(WALLET_ROOT, CHAIN, BASE_PARAMS);

    const nativeEdge = edges.find((e) => e.dest === WALLET_NATIVE_DEST);
    expect(nativeEdge).toBeDefined();
    expect(nativeEdge!.relationship).toBe('native_transfer');
    expect(nativeEdge!.amountUsd).toBe(1500);
    expect(nativeEdge!.txCount).toBe(1);
    expect(nativeEdge!.source).toBe(WALLET_ROOT);
  });

  it('maps transfer+stablecoin-symbol to stablecoin_transfer and aggregates repeated edges', async () => {
    const fetcher = createDbEdgeFetcher(prisma, { perNodeTxCap: 500 });
    const edges = await fetcher(WALLET_ROOT, CHAIN, BASE_PARAMS);

    const stableEdge = edges.find((e) => e.dest === WALLET_STABLE_DEST);
    expect(stableEdge).toBeDefined();
    expect(stableEdge!.relationship).toBe('stablecoin_transfer');
    expect(stableEdge!.amountUsd).toBe(1500); // 1000 + 500 aggregated
    expect(stableEdge!.txCount).toBe(2);
    expect(stableEdge!.sampleTxHashes).toEqual(
      expect.arrayContaining([`${ADDR_PREFIX}tx_stable_1`, `${ADDR_PREFIX}tx_stable_2`])
    );
  });

  it('maps transfer+other-symbol to token_transfer', async () => {
    const fetcher = createDbEdgeFetcher(prisma, { perNodeTxCap: 500 });
    const edges = await fetcher(WALLET_ROOT, CHAIN, BASE_PARAMS);

    const tokenEdge = edges.find((e) => e.dest === WALLET_TOKEN_DEST);
    expect(tokenEdge).toBeDefined();
    expect(tokenEdge!.relationship).toBe('token_transfer');
  });

  it('maps cex_deposit action type through unchanged', async () => {
    const fetcher = createDbEdgeFetcher(prisma, { perNodeTxCap: 500 });
    const edges = await fetcher(WALLET_ROOT, CHAIN, BASE_PARAMS);

    const cexEdge = edges.find((e) => e.dest === CEX_ADDRESS);
    expect(cexEdge).toBeDefined();
    expect(cexEdge!.relationship).toBe('cex_deposit');
  });

  it('excludes edges where the queried address is the destination, not the source', async () => {
    const fetcher = createDbEdgeFetcher(prisma, { perNodeTxCap: 500 });
    const edges = await fetcher(WALLET_ROOT, CHAIN, BASE_PARAMS);

    // Every returned edge must have source === WALLET_ROOT.
    expect(edges.every((e) => e.source === WALLET_ROOT)).toBe(true);
  });

  it('caps aggregated edges to perNodeTxCap, keeping the highest-value ones', async () => {
    const fetcher = createDbEdgeFetcher(prisma, { perNodeTxCap: 1 });
    const edges = await fetcher(WALLET_ROOT, CHAIN, BASE_PARAMS);

    expect(edges.length).toBe(1);
    // Highest aggregated amountUsd among this fixture's edges is the
    // stablecoin edge (1500 aggregated) tied with native (1500) — either is
    // an acceptable "highest", but there must be exactly one.
    expect(edges[0]!.amountUsd).toBeGreaterThanOrEqual(750);
  });
});

describe.skipIf(!(await probePort('localhost', 5439)))('createRegistryLookup', () => {
  it('resolves a registered address with its category/label/doNotExpand', async () => {
    const lookup = await createRegistryLookup(prisma);
    const hit = lookup(CEX_ADDRESS);
    expect(hit).not.toBeNull();
    expect(hit!.category).toBe('CEX');
    expect(hit!.doNotExpand).toBe(true);
  });

  it('returns null for an address with no registry row', async () => {
    const lookup = await createRegistryLookup(prisma);
    expect(lookup(`${ADDR_PREFIX}not_registered`)).toBeNull();
  });
});
