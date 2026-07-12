// FlowRadar — post-entry behavior builder tests (dormancy Task 10 DB).

import { describe, expect, it, afterAll, beforeEach } from 'vitest';
import net from 'node:net';
import { prisma } from '../../src/client';
import { buildPostEntryBehaviors } from '../../src/postentry/postEntry';

const PREFIX = 'DRMPE'; // base58-safe (no 0/O/I/l)

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
const ENTRY = new Date('2026-06-01T00:00:00Z');
const daysBefore = (d: number) => new Date(ENTRY.getTime() - d * 86_400_000);
const after = (sec: number) => new Date(ENTRY.getTime() + sec * 1000);
const addr = (s: string) => `${PREFIX}${s}`;

async function cleanup() {
  await prisma.postEntryBehavior.deleteMany({ where: { walletAddress: { startsWith: PREFIX } } });
  await prisma.walletBehaviorProfile.deleteMany({ where: { walletAddress: { startsWith: PREFIX } } });
  await prisma.walletRelationship.deleteMany({ where: { walletA: { address: { startsWith: PREFIX } } } });
  await prisma.lineageRoot.deleteMany({ where: { wallet: { address: { startsWith: PREFIX } } } });
  await prisma.moneyFlowEdge.deleteMany({
    where: { OR: [{ sourceAddress: { startsWith: PREFIX } }, { destinationAddress: { startsWith: PREFIX } }] }
  });
  await prisma.walletTokenTrade.deleteMany({ where: { txHash: { startsWith: PREFIX } } });
  await prisma.addressRegistry.deleteMany({ where: { address: { startsWith: PREFIX } } });
  await prisma.wallet.deleteMany({ where: { address: { startsWith: PREFIX } } });
  await prisma.token.deleteMany({ where: { address: { startsWith: PREFIX } } });
}

let tokenSeq = 0;
async function seedToken() {
  tokenSeq += 1;
  const a = addr(`TK${tokenSeq}`);
  return prisma.token.create({
    data: { chain: 'SOLANA', address: a, symbol: `T${tokenSeq}`, name: a, decimals: 9, firstSeenAt: daysBefore(365), riskFlags: [] },
    select: { id: true, address: true }
  });
}

async function seedWallet(suffix: string) {
  return prisma.wallet.create({
    data: { address: addr(suffix), chain: 'SOLANA', firstSeenAt: daysBefore(365), lastActiveAt: ENTRY },
    select: { id: true, address: true }
  });
}

let txSeq = 0;
async function seedTrade(walletId: string, tokenId: string, action: 'BUY' | 'SELL', usd: number, ts: Date) {
  txSeq += 1;
  return prisma.walletTokenTrade.create({
    data: {
      walletId, tokenId, chain: 'SOLANA', action, amountToken: '10', amountUsd: String(usd),
      txHash: addr(`TX${txSeq}`), blockOrSlot: 1n, ts, priceUsd: '1', marketCapAtTrade: '100000',
      walletScoreAtTime: 50, provider: 'test'
    }
  });
}

async function seedTokenEdge(from: string, to: string, mint: string, usd: number | null, ts: Date) {
  txSeq += 1;
  return prisma.moneyFlowEdge.create({
    data: {
      sourceAddress: from, destinationAddress: to, sourceChain: 'SOLANA', destinationChain: 'SOLANA',
      asset: 'TOKEN', assetMint: mint, amountToken: 1, amountUsd: 0, ts, txHash: addr(`TX${txSeq}`),
      actionType: 'transfer', confidence: 100, providerSource: 'test', metadata: {},
      valuedUsd: usd === null ? null : String(usd), valuationConfidence: usd === null ? null : 90
    }
  });
}

/** Positions summarized the way the behavior engine would (entry-forward facts). */
async function seedProfile(
  walletAddress: string,
  positions: Record<string, unknown>[],
  localViewTruncated = false
) {
  return prisma.walletBehaviorProfile.create({
    data: {
      chain: 'SOLANA', walletAddress, engineVersion: 1, dataQuality: 'local_only', computedAt: ENTRY,
      profileJson: { localViewTruncated, local: { tokenPositions: positions } }
    }
  });
}

function pos(tokenAddress: string, over: Record<string, unknown> = {}) {
  return {
    tokenAddress,
    buyCount: 1,
    sellCount: 0,
    buyUsd: 100,
    sellUsd: 0,
    firstBuyTs: ENTRY.toISOString(),
    lastSellTs: null,
    timeToFirstSellSec: null,
    exitRatio: null,
    stillHolding: true,
    receivedNotBought: false,
    fullExitSec: null,
    ...over
  };
}

beforeEach(async () => {
  if (dbReachable) await cleanup();
});

afterAll(async () => {
  if (!dbReachable) return;
  await cleanup();
  await prisma.$disconnect();
});

describe.skipIf(!dbReachable)('buildPostEntryBehaviors (Task 10 DB builder)', () => {
  it('classifies fast flips and durable holds from position facts, idempotently', async () => {
    const w = await seedWallet('WA');
    const flipTok = await seedToken();
    const holdTok = await seedToken();
    await seedTrade(w.id, flipTok.id, 'BUY', 100, ENTRY);
    await seedTrade(w.id, flipTok.id, 'SELL', 200, after(1200)); // 20min: flip, not dump
    await seedTrade(w.id, holdTok.id, 'BUY', 100, ENTRY);
    await seedProfile(w.address, [
      pos(flipTok.address, {
        sellCount: 1, sellUsd: 200, exitRatio: 2, stillHolding: false,
        timeToFirstSellSec: 1200, fullExitSec: 1200, lastSellTs: after(1200).toISOString()
      }),
      pos(holdTok.address)
    ]);

    const r = await buildPostEntryBehaviors(prisma, { chain: 'SOLANA', walletAddresses: [w.address] });
    expect(r.errors).toBe(0);
    expect(r.rowsWritten).toBe(2);
    expect(r.byPrimaryClass.fast_flip).toBe(1);
    expect(r.byPrimaryClass.durable_hold).toBe(1);

    const flip = await prisma.postEntryBehavior.findUniqueOrThrow({
      where: {
        chain_walletAddress_tokenAddress: { chain: 'SOLANA', walletAddress: w.address, tokenAddress: flipTok.address }
      }
    });
    expect(flip.labels).toContain('full_exit');
    expect(flip.caveats.join(' ')).toContain('never assumed to be sales');

    // Idempotent rerun.
    await buildPostEntryBehaviors(prisma, { chain: 'SOLANA', walletAddresses: [w.address] });
    expect(await prisma.postEntryBehavior.count({ where: { walletAddress: w.address } })).toBe(2);
  });

  it('labels outbound token transfers by destination evidence — linked / service / unknown, never exits', async () => {
    const w = await seedWallet('WB');
    const side = await seedWallet('WSB');
    const tok = await seedToken();
    await seedTrade(w.id, tok.id, 'BUY', 100, ENTRY);
    await prisma.addressRegistry.create({
      data: { chain: 'SOLANA', address: addr('CEXB'), category: 'CEX', label: 'test cex', source: 'test' }
    });
    // Probable relationship to the side wallet.
    const root = await prisma.lineageRoot.create({
      data: { walletId: w.id, source: 'test', firstImportedAt: daysBefore(365), lastSeenInImportAt: daysBefore(365) }
    });
    await prisma.walletRelationship.create({
      data: {
        lineageRootId: root.id, walletAId: w.id, walletBId: side.id, kind: 'direct_funding' as never,
        confidence: 70, firstSeenAt: daysBefore(50), lastSeenAt: daysBefore(1), interactionCount: 2,
        valueTransferredUsd: 100, evidence: {}
      }
    });
    await seedTokenEdge(w.address, side.address, tok.address, 40, after(3600)); // linked
    await seedTokenEdge(w.address, addr('CEXB'), tok.address, 60, after(7200)); // service
    await seedTokenEdge(w.address, addr('STRGR'), tok.address, null, after(9800)); // unknown dest
    await seedTokenEdge(w.address, addr('PRIOR'), tok.address, 10, daysBefore(1)); // PRE-entry: ignored
    await seedProfile(w.address, [pos(tok.address)]);

    await buildPostEntryBehaviors(prisma, { chain: 'SOLANA', walletAddresses: [w.address] });
    const row = await prisma.postEntryBehavior.findFirstOrThrow({ where: { walletAddress: w.address } });
    expect(row.outboundTokenTransfers).toBe(3); // pre-entry edge excluded
    expect(row.outboundToLinked).toBe(1);
    expect(row.outboundToService).toBe(1);
    expect(row.outboundUnknown).toBe(1);
    expect(row.labels).toContain('transfer_to_linked');
    expect(row.labels).toContain('transfer_to_service');
    expect(row.labels).not.toContain('partial_exit'); // transfers are NOT sales
  });

  it('PRE-entry sales of received inventory never contaminate entry-forward exit metrics', async () => {
    const w = await seedWallet('WD');
    const tok = await seedToken();
    // Received tokens were sold BEFORE the observed entry buy; after the
    // entry there are NO sells — the position is entry-forward still-holding.
    await seedTrade(w.id, tok.id, 'SELL', 500, daysBefore(10)); // pre-entry sale
    await seedTrade(w.id, tok.id, 'BUY', 100, ENTRY);
    // Profile carries the token-wide (contaminated) aggregates on purpose.
    await seedProfile(w.address, [
      pos(tok.address, {
        sellCount: 1, sellUsd: 500, exitRatio: 5, stillHolding: false,
        timeToFirstSellSec: -10 * 86_400, lastSellTs: daysBefore(10).toISOString()
      })
    ]);

    const r = await buildPostEntryBehaviors(prisma, { chain: 'SOLANA', walletAddresses: [w.address] });
    expect(r.errors).toBe(0);
    const row = await prisma.postEntryBehavior.findFirstOrThrow({ where: { walletAddress: w.address } });
    expect(row.sellCount).toBe(0); // the pre-entry sale is invisible
    expect(row.exitRatio).toBe(0); // known entry cost, zero post-entry sells — an honest 0, not unknown
    expect(row.labels).not.toContain('full_exit');
    expect(row.labels).not.toContain('partial_exit');
    expect(row.labels).not.toContain('fast_flip');
    expect(row.labels).toContain('still_holding');
  });

  it('received-not-bought positions (no local entry) are skipped; truncated views degrade dataComplete', async () => {
    const w = await seedWallet('WC');
    const tok = await seedToken();
    await seedTrade(w.id, tok.id, 'BUY', 100, ENTRY);
    await seedProfile(
      w.address,
      [pos(tok.address), pos(addr('GHOST'), { firstBuyTs: null, buyCount: 0 })],
      true // profile flagged truncated
    );

    const r = await buildPostEntryBehaviors(prisma, { chain: 'SOLANA', walletAddresses: [w.address] });
    expect(r.entriesConsidered).toBe(1); // ghost position skipped (no entry)
    expect(r.walletsWithTruncation).toBe(1);
    const row = await prisma.postEntryBehavior.findFirstOrThrow({ where: { walletAddress: w.address } });
    expect(row.dataComplete).toBe(false);
    expect(row.confidence).toBeLessThanOrEqual(45);
  });
});
