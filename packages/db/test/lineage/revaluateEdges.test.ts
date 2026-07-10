// FlowRadar — edge revaluation integration tests (Wave A6/A7). Idempotent
// backfill of honest valuation onto existing edges + resolver DB paths.

import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import net from 'node:net';
import { DEFAULT_SETTINGS, WSOL_MINT } from '@flowradar/core';
import { prisma } from '../../src/client';
import { revaluateEdges } from '../../src/lineage/revaluateEdges';
import { resolveTransferValuation } from '../../src/lineage/resolveValuation';

const PREFIX = 'REVALTEST';
const NOW = new Date('2026-07-10T12:00:00Z');
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

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

let dbReachable = false;
beforeAll(async () => { dbReachable = await probePort('localhost', 5439); });

async function cleanup() {
  await prisma.moneyFlowEdge.deleteMany({ where: { OR: [{ sourceAddress: { startsWith: PREFIX } }, { destinationAddress: { startsWith: PREFIX } }] } });
  await prisma.lineageExpansionNode.deleteMany({ where: { walletAddress: { startsWith: PREFIX } } });
  await prisma.lineageRoot.deleteMany({ where: { wallet: { address: { startsWith: PREFIX } } } });
  await prisma.wallet.deleteMany({ where: { address: { startsWith: PREFIX } } });
  await prisma.tokenMarketSnapshot.deleteMany({ where: { token: { address: { in: [WSOL_MINT, USDC_MINT, `${PREFIX}_spl`] } } } });
  await prisma.token.deleteMany({ where: { address: { in: [WSOL_MINT, `${PREFIX}_spl`] } } });
}

afterAll(async () => { if (!dbReachable) return; await cleanup(); await prisma.$disconnect(); });
beforeEach(async () => { if (!dbReachable) return; await cleanup(); });

const settings = { ...DEFAULT_SETTINGS, lineage: { ...DEFAULT_SETTINGS.lineage, priceMaxSnapshotAgeSec: 3600 } };

async function makeEdge(suffix: string, over: { asset?: string; assetMint?: string | null; amountToken?: number; ts?: Date } = {}) {
  return prisma.moneyFlowEdge.create({
    data: {
      sourceAddress: `${PREFIX}_src_${suffix}`,
      destinationAddress: `${PREFIX}_dst_${suffix}`,
      sourceChain: 'SOLANA',
      destinationChain: 'SOLANA',
      asset: over.asset ?? 'SOL',
      assetMint: over.assetMint ?? null,
      amountToken: over.amountToken ?? 2,
      amountUsd: 0,
      ts: over.ts ?? NOW,
      txHash: `${PREFIX}_tx_${suffix}`,
      actionType: 'transfer',
      confidence: 100,
      providerSource: 'test',
      metadata: {}
    }
  });
}

async function seedWsolSnapshot(priceUsd: number, ts: Date) {
  const token = await prisma.token.upsert({
    where: { chain_address: { chain: 'SOLANA', address: WSOL_MINT } },
    create: { chain: 'SOLANA', address: WSOL_MINT, symbol: 'wSOL', name: 'Wrapped SOL', decimals: 9, firstSeenAt: ts, riskFlags: [] },
    update: {}
  });
  await prisma.tokenMarketSnapshot.create({
    data: { tokenId: token.id, ts, priceUsd, marketCapUsd: 0, fdvUsd: 0, liquidityUsd: 0, vol5m: 0, vol1h: 0, vol6h: 0, vol24h: 0, holderCount: 0, source: 'test' }
  });
}

describe.skipIf(!(await probePort('localhost', 5439)))('revaluateEdges + resolveTransferValuation', () => {
  it('native SOL prior snapshot values the edge; unavailable stays null (not zero)', async () => {
    await seedWsolSnapshot(150, new Date(NOW.getTime() - 300_000));
    const edge = await makeEdge('sol', { asset: 'SOL', assetMint: null, amountToken: 2 });
    const noPrice = await makeEdge('nosol', { asset: 'SOL', assetMint: null, amountToken: 1, ts: new Date('2020-01-01T00:00:00Z') });

    const result = await revaluateEdges(prisma, settings, { sourceAddressStartsWith: PREFIX });
    expect(result.edgesExamined).toBeGreaterThanOrEqual(2);

    const valued = await prisma.moneyFlowEdge.findUnique({ where: { id: edge.id } });
    expect(valued!.valuationStatus).toBe('nearest_prior_snapshot');
    expect(Number(valued!.valuedUsd)).toBeCloseTo(300, 4);

    const unavail = await prisma.moneyFlowEdge.findUnique({ where: { id: noPrice.id } });
    expect(unavail!.valuationStatus).toBe('unavailable');
    expect(unavail!.valuedUsd).toBeNull(); // NOT zero
  });

  it('verified stablecoin mint values at nominal $1; a fake-symbol stablecoin does NOT', async () => {
    const usdc = await makeEdge('usdc', { asset: 'USDC', assetMint: USDC_MINT, amountToken: 500 });
    const fake = await makeEdge('fake', { asset: 'USDC', assetMint: `${PREFIX}_notusdc`, amountToken: 500 });

    await revaluateEdges(prisma, settings, { sourceAddressStartsWith: PREFIX });

    const real = await prisma.moneyFlowEdge.findUnique({ where: { id: usdc.id } });
    expect(real!.valuationStatus).toBe('stablecoin_nominal');
    expect(Number(real!.valuedUsd)).toBeCloseTo(500, 4);

    const bad = await prisma.moneyFlowEdge.findUnique({ where: { id: fake.id } });
    expect(bad!.valuationStatus).toBe('unavailable'); // fake mint => SPL with no price
  });

  it('current-price estimate is used only when no snapshot, clearly labeled', async () => {
    const edge = await makeEdge('curr', { asset: 'SOL', assetMint: null, amountToken: 1, ts: new Date('2020-01-01T00:00:00Z') });
    await revaluateEdges(prisma, settings, { solCurrentPriceUsd: 160, solCurrentPriceTs: NOW, sourceAddressStartsWith: PREFIX });
    const valued = await prisma.moneyFlowEdge.findUnique({ where: { id: edge.id } });
    expect(valued!.valuationStatus).toBe('current_price_estimate');
    expect(Number(valued!.valuationConfidence)).toBeLessThan(60);
  });

  it('IDEMPOTENT: a second revaluation produces the same values, no duplicate edges', async () => {
    await seedWsolSnapshot(150, new Date(NOW.getTime() - 60_000));
    const edge = await makeEdge('idem', { asset: 'SOL', assetMint: null, amountToken: 2 });

    await revaluateEdges(prisma, settings, { sourceAddressStartsWith: PREFIX });
    const first = await prisma.moneyFlowEdge.findUnique({ where: { id: edge.id } });
    // Second pass re-selects only null/unavailable; a now-valued edge is skipped.
    const second = await revaluateEdges(prisma, settings, { sourceAddressStartsWith: PREFIX });
    const after = await prisma.moneyFlowEdge.findUnique({ where: { id: edge.id } });

    expect(Number(after!.valuedUsd)).toBe(Number(first!.valuedUsd));
    expect(second.edgesValued).toBe(0); // already-valued edge not re-touched
    const count = await prisma.moneyFlowEdge.count({ where: { txHash: `${PREFIX}_tx_idem` } });
    expect(count).toBe(1);
  });

  it('bounded page resumes safely via id cursor', async () => {
    await seedWsolSnapshot(150, new Date(NOW.getTime() - 60_000));
    for (let i = 0; i < 5; i++) await makeEdge(`page_${i}`, { asset: 'SOL', assetMint: null, amountToken: 1 });

    const p1 = await revaluateEdges(prisma, settings, { maxEdgesPerPass: 2, sourceAddressStartsWith: PREFIX });
    expect(p1.edgesExamined).toBe(2);
    const p2 = await revaluateEdges(prisma, settings, { maxEdgesPerPass: 10, sourceAddressStartsWith: PREFIX });
    // Remaining 3 (the first 2 are now valued, excluded).
    expect(p2.edgesExamined).toBe(3);
    const remaining = await prisma.moneyFlowEdge.count({ where: { txHash: { startsWith: `${PREFIX}_tx_page_` }, valuationStatus: null } });
    expect(remaining).toBe(0);
  });

  it('SERVICE leg is not_applicable via the resolver (never valued as funding)', async () => {
    const v = await resolveTransferValuation(prisma, { asset: 'SOL', assetMint: null, amountToken: 5, transferTs: NOW, isServiceLeg: true }, { solCurrentPriceUsd: 160, solCurrentPriceTs: NOW, maxSnapshotAgeSec: 3600 });
    expect(v.status).toBe('not_applicable');
    expect(v.valuedUsd).toBeNull();
  });

  it('LEGACY amountUsd is NEVER overwritten by revaluation (trust boundary); valuedUsd carries honest value', async () => {
    await seedWsolSnapshot(150, new Date(NOW.getTime() - 60_000));
    const edge = await prisma.moneyFlowEdge.create({
      data: {
        sourceAddress: `${PREFIX}_src_legacy`, destinationAddress: `${PREFIX}_dst_legacy`,
        sourceChain: 'SOLANA', destinationChain: 'SOLANA', asset: 'SOL', assetMint: null,
        amountToken: 2, amountUsd: 0, ts: NOW, txHash: `${PREFIX}_tx_legacy`, actionType: 'transfer',
        confidence: 100, providerSource: 'test', metadata: {}
      }
    });
    await revaluateEdges(prisma, settings, { sourceAddressStartsWith: PREFIX });
    const after = await prisma.moneyFlowEdge.findUnique({ where: { id: edge.id } });
    expect(Number(after!.amountUsd)).toBe(0); // legacy column UNTOUCHED
    expect(Number(after!.valuedUsd)).toBeCloseTo(300, 4); // honest value in the new field
  });

  it('REOPENS a done expansion node when its sender edge newly gains a value (re-enrollment via resume)', async () => {
    await seedWsolSnapshot(150, new Date(NOW.getTime() - 60_000));
    // A root + a completed expansion node for its wallet, plus an unvalued edge.
    const rootWallet = await prisma.wallet.create({ data: { address: `${PREFIX}_src_reopen`, chain: 'SOLANA', firstSeenAt: NOW, lastActiveAt: NOW, status: 'observation_only' } });
    const root = await prisma.lineageRoot.create({ data: { walletId: rootWallet.id, source: 'operator_file', permanent: true, firstImportedAt: NOW, lastSeenInImportAt: NOW } });
    const node = await prisma.lineageExpansionNode.create({ data: { lineageRootId: root.id, walletAddress: rootWallet.address, chain: 'SOLANA', depth: 0, priority: 'first_funder', status: 'done', discoveredVia: 'root', cursor: 'end' } });
    await prisma.moneyFlowEdge.create({
      data: { sourceAddress: rootWallet.address, destinationAddress: `${PREFIX}_dst_reopen`, sourceChain: 'SOLANA', destinationChain: 'SOLANA', asset: 'SOL', assetMint: null, amountToken: 2, amountUsd: 0, ts: NOW, txHash: `${PREFIX}_tx_reopen`, actionType: 'transfer', confidence: 100, providerSource: 'test', metadata: {} }
    });

    const result = await revaluateEdges(prisma, settings, { sourceAddressStartsWith: PREFIX });
    expect(result.newlyValued).toBeGreaterThanOrEqual(1);
    expect(result.nodesReopened).toBeGreaterThanOrEqual(1);
    const after = await prisma.lineageExpansionNode.findUnique({ where: { id: node.id } });
    expect(after!.status).toBe('pending'); // reopened for re-enrollment
    expect(after!.cursor).toBeNull();

    // cleanup this test's extra rows
    await prisma.lineageExpansionNode.deleteMany({ where: { lineageRootId: root.id } });
    await prisma.lineageRoot.delete({ where: { id: root.id } });
  });

  it('startAfterId pages FORWARD across runs (no restart / starvation)', async () => {
    await seedWsolSnapshot(150, new Date(NOW.getTime() - 60_000));
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push((await makeEdge(`fwd_${i}`, { asset: 'SOL', assetMint: null, amountToken: 1 })).id);
    const sorted = [...ids].sort();
    const r1 = await revaluateEdges(prisma, settings, { maxEdgesPerPass: 2, sourceAddressStartsWith: PREFIX });
    expect(r1.lastId).not.toBeNull();
    expect(r1.lastId).toBe(sorted[1]); // examined the two lowest ids
    const r2 = await revaluateEdges(prisma, settings, { maxEdgesPerPass: 2, startAfterId: r1.lastId!, sourceAddressStartsWith: PREFIX });
    // r2 pages FORWARD: only ids > r1.lastId — proves no restart/re-examination.
    expect(r2.lastId).toBe(sorted[3]);
    expect(r2.edgesExamined).toBe(2);
  });

  it('LEGACY positive amountUsd is treated as a provider valuation (exact_provider_historical)', async () => {
    const edge = await prisma.moneyFlowEdge.create({
      data: {
        sourceAddress: `${PREFIX}_src_prov`, destinationAddress: `${PREFIX}_dst_prov`,
        sourceChain: 'SOLANA', destinationChain: 'SOLANA', asset: 'SOL', assetMint: null,
        amountToken: 2, amountUsd: 500, ts: NOW, txHash: `${PREFIX}_tx_prov`, actionType: 'transfer',
        confidence: 100, providerSource: 'test', metadata: {}
      }
    });
    await revaluateEdges(prisma, settings, { sourceAddressStartsWith: PREFIX });
    const after = await prisma.moneyFlowEdge.findUnique({ where: { id: edge.id } });
    expect(after!.valuationStatus).toBe('exact_provider_historical');
    expect(Number(after!.valuedUsd)).toBeCloseTo(500, 4);
    expect(Number(after!.amountUsd)).toBe(500);
  });
});
