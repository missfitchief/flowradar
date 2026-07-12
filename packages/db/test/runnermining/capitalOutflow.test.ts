// FlowRadar — capital outflow + receiver enrollment tests (working loop).

import { describe, expect, it, afterAll, beforeEach } from 'vitest';
import net from 'node:net';
import { prisma } from '../../src/client';
import { buildCapitalOutflowPaths, buildReceiverEnrollments } from '../../src/runnermining/capitalOutflow';

const PREFIX = 'CAPFW'; // base58-safe (no 0/O/I/l)

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
  await prisma.capitalOutflowPath.deleteMany({ where: { sourceWallet: { startsWith: PREFIX } } });
  await prisma.receiverEnrollment.deleteMany({ where: { receiverAddress: { startsWith: PREFIX } } });
  await prisma.walletDnaProfile.deleteMany({ where: { walletAddress: { startsWith: PREFIX } } });
  await prisma.walletTokenTrade.deleteMany({ where: { txHash: { startsWith: PREFIX } } });
  await prisma.moneyFlowEdge.deleteMany({ where: { txHash: { startsWith: PREFIX } } });
  await prisma.addressRegistry.deleteMany({ where: { address: { startsWith: PREFIX } } });
  await prisma.wallet.deleteMany({ where: { address: { startsWith: PREFIX } } });
  await prisma.token.deleteMany({ where: { address: { startsWith: PREFIX } } });
}

async function seedDnaWallet(suffix: string) {
  const address = addr(suffix);
  await prisma.wallet.create({
    data: { address, chain: 'SOLANA', firstSeenAt: T0, lastActiveAt: T0 }
  });
  await prisma.walletDnaProfile.create({
    data: {
      chain: 'SOLANA', walletAddress: address, coverage: 'partial', confidence: 45,
      reasonCodes: [], receiptsJson: {}, caveats: [], engineVersion: 1, computedAt: T0
    }
  });
  return address;
}

let txSeq = 0;
async function seedEdge(opts: {
  from: string; to: string; ts: Date; usd: number | null;
  actionType?: 'transfer' | 'bridge_deposit' | 'cex_deposit';
  bridgeProtocol?: string;
}) {
  txSeq += 1;
  return prisma.moneyFlowEdge.create({
    data: {
      sourceAddress: opts.from, destinationAddress: opts.to,
      sourceChain: 'SOLANA', destinationChain: 'SOLANA',
      asset: 'SOL', amountToken: 1, amountUsd: 0, ts: opts.ts, txHash: addr(`TX${txSeq}`),
      actionType: opts.actionType ?? 'transfer', confidence: 100, providerSource: 'test', metadata: {},
      bridgeProtocol: opts.bridgeProtocol ?? null,
      valuedUsd: opts.usd === null ? null : String(opts.usd)
    }
  });
}

beforeEach(async () => { if (dbReachable) await cleanup(); });
afterAll(async () => { if (!dbReachable) return; await cleanup(); await prisma.$disconnect(); });

describe.skipIf(!dbReachable)('buildCapitalOutflowPaths', () => {
  it('tiers evidence: direct transfer, multi-hop, bridge, CEX — CEX/bridge never expanded', async () => {
    const src = await seedDnaWallet('SRC1');
    const hop1 = addr('HP1A');
    const hop2 = addr('HP2A');
    const cex = addr('CEXA');
    const bridge = addr('BRGA');
    await seedEdge({ from: src, to: hop1, ts: at(10), usd: 500 }); // direct
    await seedEdge({ from: hop1, to: hop2, ts: at(20), usd: 400 }); // multi-hop (after arrival)
    await seedEdge({ from: src, to: cex, ts: at(30), usd: 900, actionType: 'cex_deposit' });
    await seedEdge({ from: src, to: bridge, ts: at(40), usd: 800, actionType: 'bridge_deposit', bridgeProtocol: 'wormhole' });
    // Post-CEX edge that must NEVER be attributed (CEX is a terminal).
    await seedEdge({ from: cex, to: addr('LNDR'), ts: at(50), usd: 900 });

    const r = await buildCapitalOutflowPaths(prisma, { chain: 'SOLANA', walletAddresses: [src] });
    expect(r.errors).toBe(0);

    const rows = await prisma.capitalOutflowPath.findMany({
      where: { sourceWallet: src },
      orderBy: [{ destinationAddress: 'asc' }, { evidenceTier: 'asc' }]
    });
    const byDest = new Map(rows.map((x) => [`${x.destinationAddress}|${x.evidenceTier}`, x]));
    expect(byDest.get(`${hop1}|direct_transfer`)?.destinationType).toBe('wallet');
    expect(byDest.get(`${hop2}|multi_hop_transfer`)?.hops).toBe(2);
    const cexRow = byDest.get(`${cex}|cex_correlation`);
    expect(cexRow?.destinationType).toBe('cex');
    expect(cexRow?.caveats.join(' ')).toContain('no downstream receiver');
    const bridgeRow = byDest.get(`${bridge}|bridge_inference`);
    expect(bridgeRow?.bridgeProtocol).toBe('wormhole');
    // The post-CEX receiver must NOT appear anywhere.
    expect(rows.some((x) => x.destinationAddress === addr('LNDR'))).toBe(false);
  });

  it('unknown-value legs are counted, never traced; fresh/dormant receiver classes honest', async () => {
    const src = await seedDnaWallet('SRC2');
    const fresh = addr('FRSH');
    const dormant = addr('DRMT');
    const unknownDest = addr('UNKD');
    // Dormant receiver: valued activity 40 days before receipt.
    await seedEdge({ from: addr('SEED'), to: dormant, ts: at(0), usd: 50 });
    await seedEdge({ from: src, to: fresh, ts: at(3_456_000), usd: 200 }); // day 40
    await seedEdge({ from: src, to: dormant, ts: at(3_456_000), usd: 200 });
    await seedEdge({ from: src, to: unknownDest, ts: at(3_456_000), usd: null }); // unknown value

    const r = await buildCapitalOutflowPaths(prisma, { chain: 'SOLANA', walletAddresses: [src] });
    expect(r.errors).toBe(0);
    const rows = await prisma.capitalOutflowPath.findMany({ where: { sourceWallet: src } });
    expect(rows.find((x) => x.destinationAddress === fresh)?.receiverClassAtReceipt).toBe('fresh_receiver');
    expect(rows.find((x) => x.destinationAddress === dormant)?.receiverClassAtReceipt).toBe('dormant_receiver');
    // Unknown-value-only destination: no valued path row is created.
    expect(rows.some((x) => x.destinationAddress === unknownDest)).toBe(false);
  });

  it('service destinations are terminals via registry and are never receivers', async () => {
    const src = await seedDnaWallet('SRC3');
    const router = addr('RTRA');
    await prisma.addressRegistry.create({
      data: { chain: 'SOLANA', address: router, category: 'ROUTER', label: 'test router', source: 'test' }
    });
    await seedEdge({ from: src, to: router, ts: at(10), usd: 700 });
    await seedEdge({ from: router, to: addr('AFTR'), ts: at(20), usd: 700 }); // must not be traced

    await buildCapitalOutflowPaths(prisma, { chain: 'SOLANA', walletAddresses: [src] });
    const rows = await prisma.capitalOutflowPath.findMany({ where: { sourceWallet: src } });
    expect(rows).toHaveLength(1);
    expect(rows[0].destinationType).toBe('service');
    expect(rows[0].reasonCodes.join(' ')).toContain('service_terminal');
    expect(rows.some((x) => x.destinationAddress === addr('AFTR'))).toBe(false);
  });
});

describe.skipIf(!dbReachable)('buildReceiverEnrollments', () => {
  it('enrolls transfer-tier receivers observation_only with post-receipt deployments; idempotent', async () => {
    const src = await seedDnaWallet('SRC4');
    const recv = addr('RCVA');
    await seedEdge({ from: src, to: recv, ts: at(100), usd: 300 });
    await buildCapitalOutflowPaths(prisma, { chain: 'SOLANA', walletAddresses: [src] });

    // Receiver buys a token AFTER receipt (deployment) and one BEFORE (ignored).
    const recvWallet = await prisma.wallet.create({
      data: { address: recv, chain: 'SOLANA', firstSeenAt: T0, lastActiveAt: T0 },
      select: { id: true }
    });
    const token = await prisma.token.create({
      data: { chain: 'SOLANA', address: addr('TKNA'), symbol: 'TK', name: 'tk', decimals: 9, firstSeenAt: T0, riskFlags: [] },
      select: { id: true }
    });
    for (const [i, ts] of [at(50), at(200)].entries()) {
      await prisma.walletTokenTrade.create({
        data: {
          walletId: recvWallet.id, tokenId: token.id, chain: 'SOLANA', action: 'BUY',
          amountToken: '10', amountUsd: '100', txHash: addr(`DTX${i}`), blockOrSlot: 1n, ts,
          priceUsd: '1', marketCapAtTrade: '100000', walletScoreAtTime: 50, provider: 'test'
        }
      });
    }

    const r1 = await buildReceiverEnrollments(prisma, { chain: 'SOLANA' });
    expect(r1.errors).toBe(0);
    expect(r1.enrolled).toBe(1);
    const row = await prisma.receiverEnrollment.findUniqueOrThrow({
      where: { chain_receiverAddress: { chain: 'SOLANA', receiverAddress: recv } }
    });
    expect(row.status).toBe('observation_only');
    expect(row.sourceWallets).toContain(src);
    expect(row.deployedTokenCount).toBe(1); // only the post-receipt buy counts
    const deployments = row.deploymentsJson as { mint: string; buyCount: number }[];
    expect(deployments[0].mint).toBe(addr('TKNA'));
    expect(deployments[0].buyCount).toBe(1);

    const r2 = await buildReceiverEnrollments(prisma, { chain: 'SOLANA' });
    expect(r2.enrolled).toBe(1); // upsert — no duplicates
    expect(await prisma.receiverEnrollment.count({ where: { receiverAddress: recv } })).toBe(1);
  });

  it('never enrolls qualified DNA wallets as receivers', async () => {
    const src = await seedDnaWallet('SRC5');
    const other = await seedDnaWallet('SRC6'); // also qualified
    await seedEdge({ from: src, to: other, ts: at(10), usd: 500 });
    await buildCapitalOutflowPaths(prisma, { chain: 'SOLANA', walletAddresses: [src] });
    const r = await buildReceiverEnrollments(prisma, { chain: 'SOLANA' });
    expect(r.enrolled).toBe(0);
    expect(await prisma.receiverEnrollment.count({ where: { receiverAddress: other } })).toBe(0);
  });
});
