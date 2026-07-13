// FlowRadar — live-recovery builder tests: receiver backfill + token metadata.

import { describe, expect, it, afterAll, beforeEach } from 'vitest';
import net from 'node:net';
import { prisma } from '../../src/client';
import { buildReceiverActivityBackfill, buildTokenMetadata, isPlaceholderSymbol } from '../../src/runnermining/liveRecovery';

const PREFIX = 'LREC1'; // base58-safe

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
const at = (sec: number) => new Date(T0.getTime() + sec * 1000);
const addr = (s: string) => `${PREFIX}${s}`;

async function cleanup() {
  await prisma.receiverActivityBackfill.deleteMany({ where: { receiverAddress: { startsWith: PREFIX } } });
  await prisma.tokenMetadata.deleteMany({ where: { mint: { startsWith: PREFIX } } });
  await prisma.receiverEnrollment.deleteMany({ where: { receiverAddress: { startsWith: PREFIX } } });
  await prisma.walletTokenTrade.deleteMany({ where: { txHash: { startsWith: PREFIX } } });
  await prisma.moneyFlowEdge.deleteMany({ where: { txHash: { startsWith: PREFIX } } });
  await prisma.wallet.deleteMany({ where: { address: { startsWith: PREFIX } } });
  await prisma.token.deleteMany({ where: { address: { startsWith: PREFIX } } });
}

beforeEach(async () => { if (dbReachable) await cleanup(); });
afterAll(async () => { if (!dbReachable) return; await cleanup(); await prisma.$disconnect(); });

describe('isPlaceholderSymbol (pure)', () => {
  it('detects ingest mint-prefix placeholders, accepts real symbols', () => {
    expect(isPlaceholderSymbol('EPjFWdd5AufqSSqe', 'EPjF', 'EPjF')).toBe(true);
    expect(isPlaceholderSymbol('EPjFWdd5AufqSSqe', null)).toBe(true);
    expect(isPlaceholderSymbol('EPjFWdd5AufqSSqe', 'USDC', 'USD Coin')).toBe(false);
    expect(isPlaceholderSymbol('BonkkkMint', 'BONK', 'Bonk')).toBe(false);
  });
});

describe.skipIf(!dbReachable)('buildReceiverActivityBackfill', () => {
  it('classifies deployment_found / covered_no_post_receipt_buy / retryable honestly', async () => {
    const tok = await prisma.token.create({ data: { chain: 'SOLANA', address: addr('TKA'), symbol: 'TKA', name: 'tka', decimals: 9, firstSeenAt: T0, riskFlags: [] }, select: { id: true, address: true } });
    // R1: has a wallet row + a post-receipt buy -> deployment_found
    const w1 = await prisma.wallet.create({ data: { address: addr('R1'), chain: 'SOLANA', firstSeenAt: T0, lastActiveAt: T0 }, select: { id: true } });
    await prisma.walletTokenTrade.create({ data: { walletId: w1.id, tokenId: tok.id, chain: 'SOLANA', action: 'BUY', amountToken: '1', amountUsd: '200', txHash: addr('TX1'), blockOrSlot: 1n, ts: at(500), priceUsd: '1', marketCapAtTrade: '1', walletScoreAtTime: 50, provider: 'test' } });
    await prisma.receiverEnrollment.create({ data: { chain: 'SOLANA', receiverAddress: addr('R1'), receiverClass: 'fresh_receiver', sourceEntityKeys: [addr('E1')], sourceWallets: [addr('S1')], evidenceTiers: ['direct_transfer'], firstReceiptTs: at(100), deploymentsJson: [], reasonCodes: [], receiptsJson: {}, caveats: [], engineVersion: 1 } });
    // R2: wallet row but NO observed post-receipt activity -> partial_coverage
    // (a wallet row alone is NOT proof the history was inspected).
    await prisma.wallet.create({ data: { address: addr('R2'), chain: 'SOLANA', firstSeenAt: T0, lastActiveAt: T0 } });
    await prisma.receiverEnrollment.create({ data: { chain: 'SOLANA', receiverAddress: addr('R2'), receiverClass: 'dormant_reactivated', sourceEntityKeys: [addr('E2')], sourceWallets: [addr('S2')], evidenceTiers: ['direct_transfer'], firstReceiptTs: at(100), deploymentsJson: [], reasonCodes: [], receiptsJson: {}, caveats: [], engineVersion: 1 } });
    // R3: no wallet row -> retryable_provider_failure
    await prisma.receiverEnrollment.create({ data: { chain: 'SOLANA', receiverAddress: addr('R3'), receiverClass: 'fresh_receiver', sourceEntityKeys: [addr('E3')], sourceWallets: [addr('S3')], evidenceTiers: ['direct_transfer'], firstReceiptTs: at(100), deploymentsJson: [], reasonCodes: [], receiptsJson: {}, caveats: [], engineVersion: 1 } });
    // R4: wallet row + a post-receipt transfer EDGE but no buy -> covered_no_post_receipt_buy
    await prisma.wallet.create({ data: { address: addr('R4'), chain: 'SOLANA', firstSeenAt: T0, lastActiveAt: T0 } });
    await prisma.moneyFlowEdge.create({ data: { sourceAddress: addr('R4'), destinationAddress: addr('X4'), sourceChain: 'SOLANA', destinationChain: 'SOLANA', asset: 'SOL', amountToken: 1, amountUsd: 0, ts: at(500), txHash: addr('EDG4'), actionType: 'transfer', confidence: 100, providerSource: 'test', metadata: {}, valuedUsd: '50' } });
    await prisma.receiverEnrollment.create({ data: { chain: 'SOLANA', receiverAddress: addr('R4'), receiverClass: 'fresh_receiver', sourceEntityKeys: [addr('E4')], sourceWallets: [addr('S4')], evidenceTiers: ['direct_transfer'], firstReceiptTs: at(100), deploymentsJson: [], reasonCodes: [], receiptsJson: {}, caveats: [], engineVersion: 1 } });

    const r = await buildReceiverActivityBackfill(prisma, { chain: 'SOLANA' });
    expect(r.errors).toBe(0);
    expect(r.written).toBe(4);
    const statusOf = new Map((await prisma.receiverActivityBackfill.findMany({ where: { receiverAddress: { startsWith: PREFIX } } })).map((x) => [x.receiverAddress, x]));
    expect(statusOf.get(addr('R1'))?.status).toBe('deployment_found');
    expect(statusOf.get(addr('R1'))?.firstBuyMint).toBe(tok.address);
    expect(Number(statusOf.get(addr('R1'))?.boughtKnownUsd)).toBe(200);
    expect(statusOf.get(addr('R2'))?.status).toBe('partial_coverage');
    expect(statusOf.get(addr('R3'))?.status).toBe('retryable_provider_failure');
    expect(statusOf.get(addr('R4'))?.status).toBe('covered_no_post_receipt_buy');

    const r2 = await buildReceiverActivityBackfill(prisma, { chain: 'SOLANA' });
    expect(r2.written).toBe(4); // idempotent upsert
  });
});

describe.skipIf(!dbReachable)('buildTokenMetadata', () => {
  it('resolves real names from DAS, records unavailable/retryable honestly, resumes', async () => {
    const A = addr('MTA');
    const B = addr('MTB');
    const C = addr('MTC');
    const fetchImpl = (async () =>
      new Response(JSON.stringify({
        jsonrpc: '2.0', id: 'meta', result: [
          { id: A, content: { metadata: { name: 'Real Alpha', symbol: 'ALPHA' }, links: { image: 'http://logo/a.png' } } },
          { id: B, content: { metadata: { name: '', symbol: '' } } } // no metadata -> unavailable
        ]
      }), { status: 200 })) as unknown as typeof fetch;
    const r = await buildTokenMetadata(prisma, { chain: 'SOLANA', mints: [A, B, C], heliusApiKey: 'test', fetchImpl });
    expect(r.errors).toBe(0);
    const rows = new Map((await prisma.tokenMetadata.findMany({ where: { mint: { startsWith: PREFIX } } })).map((x) => [x.mint, x]));
    expect(rows.get(A)?.availability).toBe('resolved');
    expect(rows.get(A)?.symbol).toBe('ALPHA');
    expect(rows.get(A)?.logoUri).toBe('http://logo/a.png');
    expect(rows.get(B)?.availability).toBe('unavailable'); // DAS returned no name/symbol
    expect(rows.get(C)?.availability).toBe('unavailable'); // absent from result

    // Quota exhaustion -> retryable, never fabricated.
    const D = addr('MTD');
    const quotaFetch = (async () => new Response(JSON.stringify({ error: { message: 'max usage reached' } }), { status: 429 })) as unknown as typeof fetch;
    const r2 = await buildTokenMetadata(prisma, { chain: 'SOLANA', mints: [D], heliusApiKey: 'test', fetchImpl: quotaFetch });
    expect((await prisma.tokenMetadata.findUniqueOrThrow({ where: { chain_mint: { chain: 'SOLANA', mint: D } } })).availability).toBe('retryable');

    // Resume: A already resolved -> skipped (not re-fetched).
    let calls = 0;
    const countFetch = (async () => { calls++; return new Response(JSON.stringify({ result: [] }), { status: 200 }); }) as unknown as typeof fetch;
    await buildTokenMetadata(prisma, { chain: 'SOLANA', mints: [A], heliusApiKey: 'test', fetchImpl: countFetch });
    expect(calls).toBe(0); // A was resolved, nothing to fetch
  });
});
