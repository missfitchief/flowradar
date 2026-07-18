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
  it('rejects any mint-prefix symbol (regardless of name), accepts real symbols', () => {
    expect(isPlaceholderSymbol('EPjFWdd5AufqSSqe', 'EPjF')).toBe(true);
    expect(isPlaceholderSymbol('EPjFWdd5AufqSSqe', null)).toBe(true);
    // A differing name must NOT launder a prefix symbol: mint starts "ABC",
    // symbol "ABC", real name "Acme Token" -> still a placeholder symbol.
    expect(isPlaceholderSymbol('ABCxyz1234', 'ABC')).toBe(true);
    expect(isPlaceholderSymbol('EPjFWdd5AufqSSqe', 'USDC')).toBe(false);
    expect(isPlaceholderSymbol('BonkkkMint', 'BONK')).toBe(false); // case differs -> not a prefix
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
    // R4: wallet row + a post-receipt transfer EDGE but NO trade poll evidence
    // -> partial_coverage (an edge alone doesn't prove trade history inspected).
    await prisma.wallet.create({ data: { address: addr('R4'), chain: 'SOLANA', firstSeenAt: T0, lastActiveAt: T0 } });
    await prisma.moneyFlowEdge.create({ data: { sourceAddress: addr('R4'), destinationAddress: addr('X4'), sourceChain: 'SOLANA', destinationChain: 'SOLANA', asset: 'SOL', amountToken: 1, amountUsd: 0, ts: at(500), txHash: addr('EDG4'), actionType: 'transfer', confidence: 100, providerSource: 'test', metadata: {}, valuedUsd: '50' } });
    await prisma.receiverEnrollment.create({ data: { chain: 'SOLANA', receiverAddress: addr('R4'), receiverClass: 'fresh_receiver', sourceEntityKeys: [addr('E4')], sourceWallets: [addr('S4')], evidenceTiers: ['direct_transfer'], firstReceiptTs: at(100), deploymentsJson: [], reasonCodes: [], receiptsJson: {}, caveats: [], engineVersion: 1 } });
    // R5: wallet row WITH a clean poll (consecutiveErrors=0) that completed
    // AFTER the receipt (lastPolledAt=at(600) > receipt at(100)) and no
    // post-receipt buy -> covered_no_post_receipt_buy. The completion watermark,
    // not a stray sell, is the absence proof.
    const w5 = await prisma.wallet.create({ data: { address: addr('R5'), chain: 'SOLANA', firstSeenAt: T0, lastActiveAt: T0 }, select: { id: true } });
    await prisma.walletTokenTrade.create({ data: { walletId: w5.id, tokenId: tok.id, chain: 'SOLANA', action: 'SELL', amountToken: '1', amountUsd: '10', txHash: addr('TX5'), blockOrSlot: 1n, ts: at(500), priceUsd: '1', marketCapAtTrade: '1', walletScoreAtTime: 50, provider: 'test' } });
    await prisma.monitoringSubscription.create({ data: { walletId: w5.id, priority: 'standard', reason: 'test', lastPolledAt: at(600), consecutiveErrors: 0, pollCount: 1 } });
    await prisma.receiverEnrollment.create({ data: { chain: 'SOLANA', receiverAddress: addr('R5'), receiverClass: 'active_receiver', sourceEntityKeys: [addr('E5')], sourceWallets: [addr('S5')], evidenceTiers: ['direct_transfer'], firstReceiptTs: at(100), deploymentsJson: [], reasonCodes: [], receiptsJson: {}, caveats: [], engineVersion: 1 } });
    // R6: wallet row + a clean poll that completed BEFORE the receipt
    // (lastPolledAt=at(50) < receipt) — the post-receipt window was NOT
    // provably inspected -> partial_coverage, NOT covered.
    const w6 = await prisma.wallet.create({ data: { address: addr('R6'), chain: 'SOLANA', firstSeenAt: T0, lastActiveAt: T0 }, select: { id: true } });
    await prisma.monitoringSubscription.create({ data: { walletId: w6.id, priority: 'standard', reason: 'test', lastPolledAt: at(50), consecutiveErrors: 0, pollCount: 1 } });
    await prisma.receiverEnrollment.create({ data: { chain: 'SOLANA', receiverAddress: addr('R6'), receiverClass: 'active_receiver', sourceEntityKeys: [addr('E6')], sourceWallets: [addr('S6')], evidenceTiers: ['direct_transfer'], firstReceiptTs: at(100), deploymentsJson: [], reasonCodes: [], receiptsJson: {}, caveats: [], engineVersion: 1 } });
    // R7: wallet row + a clean post-receipt poll watermark — covered when the
    // local source is complete; used below to prove a live-source FAILURE
    // forfeits that negative.
    const w7 = await prisma.wallet.create({ data: { address: addr('R7'), chain: 'SOLANA', firstSeenAt: T0, lastActiveAt: T0 }, select: { id: true } });
    await prisma.monitoringSubscription.create({ data: { walletId: w7.id, priority: 'standard', reason: 'test', lastPolledAt: at(600), consecutiveErrors: 0, pollCount: 1 } });
    await prisma.receiverEnrollment.create({ data: { chain: 'SOLANA', receiverAddress: addr('R7'), receiverClass: 'active_receiver', sourceEntityKeys: [addr('E7')], sourceWallets: [addr('S7')], evidenceTiers: ['direct_transfer'], firstReceiptTs: at(100), deploymentsJson: [], reasonCodes: [], receiptsJson: {}, caveats: [], engineVersion: 1 } });

    // Pass 1 — local source only, complete: classify honestly.
    const r = await buildReceiverActivityBackfill(prisma, { chain: 'SOLANA' });
    expect(r.errors).toBe(0);
    expect(r.written).toBe(7);
    const statusOf = new Map((await prisma.receiverActivityBackfill.findMany({ where: { receiverAddress: { startsWith: PREFIX } } })).map((x) => [x.receiverAddress, x]));
    expect(statusOf.get(addr('R1'))?.status).toBe('deployment_found');
    expect(statusOf.get(addr('R1'))?.firstBuyMint).toBe(tok.address);
    expect(Number(statusOf.get(addr('R1'))?.boughtKnownUsd)).toBe(200);
    expect(statusOf.get(addr('R2'))?.status).toBe('partial_coverage'); // wallet only, no poll watermark
    expect(statusOf.get(addr('R3'))?.status).toBe('retryable_provider_failure'); // no wallet row
    expect(statusOf.get(addr('R4'))?.status).toBe('partial_coverage'); // edge only, no clean poll
    expect(statusOf.get(addr('R5'))?.status).toBe('covered_no_post_receipt_buy'); // clean post-receipt poll watermark
    expect(statusOf.get(addr('R6'))?.status).toBe('partial_coverage'); // poll watermark is PRE-receipt -> cannot claim covered
    expect(statusOf.get(addr('R7'))?.status).toBe('covered_no_post_receipt_buy'); // clean post-receipt poll watermark

    // Pass 2 — a second "live" source whose reads always throw (live-DB outage).
    // A NEGATIVE must be forfeited when ANY configured source fails, and every
    // failure is counted in report.errors (never silently 0).
    const brokenLive = { wallet: { findUnique: async () => { throw new Error('live source down'); } } } as unknown as typeof prisma;
    const r2 = await buildReceiverActivityBackfill(prisma, { chain: 'SOLANA', activityClient: brokenLive });
    expect(r2.written).toBe(7); // idempotent upsert
    expect(r2.errors).toBe(7); // each receiver's live read failed and was counted
    const s2 = new Map((await prisma.receiverActivityBackfill.findMany({ where: { receiverAddress: { startsWith: PREFIX } } })).map((x) => [x.receiverAddress, x]));
    expect(s2.get(addr('R1'))?.status).toBe('deployment_found'); // POSITIVE survives partial failure
    expect(s2.get(addr('R5'))?.status).toBe('retryable_provider_failure'); // negative forfeited: a source failed
    expect(s2.get(addr('R7'))?.status).toBe('retryable_provider_failure'); // negative forfeited: a source failed
  });
});

describe.skipIf(!dbReachable)('buildTokenMetadata', () => {
  it('resolves real names from DAS, records unavailable/retryable honestly, resumes', async () => {
    const A = addr('MTA');
    const B = addr('MTB');
    const C = addr('MTC');
    const F = `${PREFIX}MTFxyz`; // symbol below is a prefix of THIS mint
    const G = `${PREFIX}MTGlogo`; // prefix symbol + name + LOGO -> logo must NOT rescue the prefix symbol
    const fetchImpl = (async () =>
      new Response(JSON.stringify({
        jsonrpc: '2.0', id: 'meta', result: [
          { id: A, content: { metadata: { name: 'Real Alpha', symbol: 'ALPHA' }, links: { image: 'http://logo/a.png' } } },
          { id: B, content: { metadata: { name: '', symbol: '' } } }, // no metadata -> unavailable
          // F: symbol is a mint prefix but name differs -> resolve by NAME only,
          // symbol dropped (never display "$LREC1MTF").
          { id: F, content: { metadata: { name: 'Acme Token', symbol: `${PREFIX}MTF` } } },
          // G: prefix symbol + name === symbol + a logo. The logo must NOT
          // launder the prefix symbol -> placeholder_only (no resolved symbol).
          { id: G, content: { metadata: { name: `${PREFIX}MTG`, symbol: `${PREFIX}MTG` }, links: { image: 'http://logo/g.png' } } }
        ]
      }), { status: 200 })) as unknown as typeof fetch;
    const r = await buildTokenMetadata(prisma, { chain: 'SOLANA', mints: [A, B, C, F, G], heliusApiKey: 'test', fetchImpl });
    expect(r.errors).toBe(0);
    const rows = new Map((await prisma.tokenMetadata.findMany({ where: { mint: { startsWith: PREFIX } } })).map((x) => [x.mint, x]));
    expect(rows.get(A)?.availability).toBe('resolved');
    expect(rows.get(A)?.symbol).toBe('ALPHA');
    expect(rows.get(A)?.logoUri).toBe('http://logo/a.png');
    expect(rows.get(B)?.availability).toBe('unavailable'); // DAS returned no name/symbol
    expect(rows.get(C)?.availability).toBe('unavailable'); // absent from result
    expect(rows.get(F)?.availability).toBe('resolved'); // resolves...
    expect(rows.get(F)?.symbol).toBe(null); // ...by name only — prefix symbol dropped
    expect(rows.get(F)?.name).toBe('Acme Token');
    expect(rows.get(G)?.availability).toBe('placeholder_only'); // logo does not rescue a prefix symbol
    expect(rows.get(G)?.symbol).toBe(null);
    expect(rows.get(G)?.logoUri).toBe('http://logo/g.png'); // logo still persisted for the avatar

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

    // No key -> missing_credential, counted DISTINCTLY (not folded into unavailable).
    const E = addr('MTE');
    const r3 = await buildTokenMetadata(prisma, { chain: 'SOLANA', mints: [E] });
    expect(r3.missingCredential).toBe(1);
    expect(r3.unavailable).toBe(0);
    expect((await prisma.tokenMetadata.findUniqueOrThrow({ where: { chain_mint: { chain: 'SOLANA', mint: E } } })).availability).toBe('missing_credential');
  });
});
