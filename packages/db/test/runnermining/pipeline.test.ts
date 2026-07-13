// FlowRadar — finish-pipeline tests: extraction status + capital chains.

import { describe, expect, it, afterAll, beforeEach } from 'vitest';
import net from 'node:net';
import { prisma } from '../../src/client';
import { buildTopPnlExtractionStatus, buildCapitalChains } from '../../src/runnermining/pipeline';

const PREFIX = 'PIPEL'; // base58-safe

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
  await prisma.capitalChain.deleteMany({ where: { sourceWallet: { startsWith: PREFIX } } });
  await prisma.topPnlExtractionStatus.deleteMany({ where: { mint: { startsWith: PREFIX } } });
  await prisma.tokenCandidateScore.deleteMany({ where: { mint: { startsWith: PREFIX } } });
  await prisma.capitalOutflowPath.deleteMany({ where: { sourceWallet: { startsWith: PREFIX } } });
  await prisma.receiverEnrollment.deleteMany({ where: { receiverAddress: { startsWith: PREFIX } } });
  await prisma.walletBehaviorProfile.deleteMany({ where: { walletAddress: { startsWith: PREFIX } } });
  await prisma.walletDnaProfile.deleteMany({ where: { walletAddress: { startsWith: PREFIX } } });
  await prisma.tokenTopPnlCandidate.deleteMany({ where: { mint: { startsWith: PREFIX } } });
  await prisma.topPnlFetchState.deleteMany({ where: { mint: { startsWith: PREFIX } } });
  await prisma.walletTokenTrade.deleteMany({ where: { txHash: { startsWith: PREFIX } } });
  await prisma.tokenLifecycle.deleteMany({ where: { mint: { startsWith: PREFIX } } });
  await prisma.wallet.deleteMany({ where: { address: { startsWith: PREFIX } } });
  await prisma.token.deleteMany({ where: { address: { startsWith: PREFIX } } });
}

let seq = 0;
async function seedRunner(suffix: string, opts: { withTrades?: boolean } = {}) {
  const a = addr(suffix);
  const token = await prisma.token.create({
    data: { chain: 'SOLANA', address: a, symbol: suffix, name: a, decimals: 9, firstSeenAt: T0, riskFlags: [] },
    select: { id: true, address: true }
  });
  await prisma.tokenLifecycle.create({
    data: { mint: a, enteredUniverseAt: T0, sourcesJson: {}, coverage: 'covered', runnerClass: 'verified_above_10m', confidence: 'high', classifiedAt: T0 }
  });
  return token;
}

beforeEach(async () => { if (dbReachable) await cleanup(); });
afterAll(async () => { if (!dbReachable) return; await cleanup(); await prisma.$disconnect(); });

describe.skipIf(!dbReachable)('buildTopPnlExtractionStatus', () => {
  it('classifies per-token extraction outcome honestly', async () => {
    // A: locally-verified candidate -> local_reconstruction_ok
    const A = await seedRunner('TKA');
    const wA = await prisma.wallet.create({ data: { address: addr('WA'), chain: 'SOLANA', firstSeenAt: T0, lastActiveAt: T0 }, select: { id: true } });
    await prisma.tokenTopPnlCandidate.create({
      data: { chain: 'SOLANA', mint: A.address, walletAddress: addr('WA'), source: 'local_reconstruction', validation: 'locally_verified', coverage: 'local_full', confidence: 75, reasonCodes: [], receiptsJson: {}, caveats: [], engineVersion: 1 }
    });
    seq++; await prisma.walletTokenTrade.create({ data: { walletId: wA.id, tokenId: A.id, chain: 'SOLANA', action: 'BUY', amountToken: '1', amountUsd: '100', txHash: addr(`TX${seq}`), blockOrSlot: 1n, ts: T0, priceUsd: '1', marketCapAtTrade: '1', walletScoreAtTime: 50, provider: 'test' } });
    // B: no token row at all -> unavailable
    await prisma.tokenLifecycle.create({ data: { mint: addr('TKB'), enteredUniverseAt: T0, sourcesJson: {}, coverage: 'covered', runnerClass: 'verified_above_10m', confidence: 'high', classifiedAt: T0 } });
    // C: token row, no trades, provider_error -> retryable_provider_failure
    const C = await seedRunner('TKC');
    await prisma.topPnlFetchState.create({ data: { mint: C.address, provider: 'birdeye_top_traders', status: 'provider_error', itemCount: 0, retryCount: 1 } });

    const r = await buildTopPnlExtractionStatus(prisma, { chain: 'SOLANA' });
    expect(r.errors).toBe(0);
    const statusOf = new Map(
      (await prisma.topPnlExtractionStatus.findMany({ where: { mint: { startsWith: PREFIX } } })).map((s) => [s.mint, s.status])
    );
    expect(statusOf.get(A.address)).toBe('local_reconstruction_ok');
    expect(statusOf.get(addr('TKB'))).toBe('unavailable');
    expect(statusOf.get(C.address)).toBe('retryable_provider_failure');

    // idempotent
    const r2 = await buildTopPnlExtractionStatus(prisma, { chain: 'SOLANA' });
    expect(r2.written).toBe(r.written);
  });
});

describe.skipIf(!dbReachable)('buildCapitalChains', () => {
  it('builds staging + deployment + same-wallet profit rotation from real evidence', async () => {
    const runnerA = await seedRunner('RNA');
    const dest = await prisma.token.create({
      data: { chain: 'SOLANA', address: addr('DST'), symbol: 'DST', name: 'dst', decimals: 9, firstSeenAt: T0, riskFlags: [] },
      select: { id: true, address: true }
    });
    // Source qualified wallet with DNA + a behavior profile: profitable runner
    // exit then a buy into DST (rotation).
    const src = addr('SRC');
    await prisma.wallet.create({ data: { address: src, chain: 'SOLANA', firstSeenAt: T0, lastActiveAt: T0 } });
    await prisma.walletDnaProfile.create({
      data: { chain: 'SOLANA', walletAddress: src, coverage: 'partial', confidence: 45, reasonCodes: [], receiptsJson: {}, caveats: [], engineVersion: 1, computedAt: T0 }
    });
    await prisma.walletBehaviorProfile.create({
      data: {
        chain: 'SOLANA', walletAddress: src,
        profileJson: { local: { tokenPositions: [
          { tokenAddress: runnerA.address, buyUsd: 100, sellUsd: 500, firstBuyTs: at(0).toISOString(), lastSellTs: at(100).toISOString(), exitRatio: 1, fullExitSec: 100, timeToFirstSellSec: 100 },
          { tokenAddress: dest.address, buyUsd: 300, sellUsd: 0, firstBuyTs: at(500).toISOString(), lastSellTs: null, exitRatio: null, fullExitSec: null, timeToFirstSellSec: null }
        ] } },
        classifierJson: {}, engineVersion: 1, dataQuality: 'partial', computedAt: T0
      }
    });
    // Capital outflow: src -> fresh receiver (staging), receiver deploys into DST.
    await prisma.capitalOutflowPath.create({
      data: {
        chain: 'SOLANA', sourceWallet: src, sourceEntityKey: src, destinationAddress: addr('RCV'), destinationType: 'wallet',
        evidenceTier: 'direct_transfer', hops: 1, transferCount: 1, knownValueUsd: '250', unknownValueLegs: 0,
        firstTransferTs: at(200), lastTransferTs: at(200), receiverClassAtReceipt: 'fresh_receiver',
        pathJson: [], reasonCodes: [], receiptsJson: {}, caveats: [], engineVersion: 1
      }
    });
    await prisma.receiverEnrollment.create({
      data: {
        chain: 'SOLANA', receiverAddress: addr('RCV'), receiverClass: 'fresh_receiver', sourceEntityKeys: [src], sourceWallets: [src],
        evidenceTiers: ['direct_transfer'], firstReceiptTs: at(200), totalKnownInflowUsd: '250',
        deploymentsJson: [{ mint: dest.address, firstBuyTs: at(400).toISOString(), buyCount: 1, boughtKnownUsd: 250, unpricedBuys: 0 }],
        deployedTokenCount: 1, reasonCodes: [], receiptsJson: {}, caveats: [], engineVersion: 1
      }
    });

    const r = await buildCapitalChains(prisma, { chain: 'SOLANA' });
    expect(r.errors).toBe(0);
    expect(r.staging).toBeGreaterThanOrEqual(1);
    expect(r.deployment).toBeGreaterThanOrEqual(1);
    expect(r.profitRotation).toBeGreaterThanOrEqual(1);
    expect(r.endToEndExamples).toBeGreaterThanOrEqual(2);

    const staging = await prisma.capitalChain.findFirstOrThrow({ where: { kind: 'staging', sourceWallet: src } });
    expect(staging.receiverWallet).toBe(addr('RCV'));
    expect(Number(staging.knownValueUsd)).toBe(250);
    const deployment = await prisma.capitalChain.findFirstOrThrow({ where: { kind: 'deployment', sourceWallet: src } });
    expect(deployment.tokenBought).toBe(dest.address);
    const rotation = await prisma.capitalChain.findFirstOrThrow({ where: { kind: 'profit_rotation', sourceWallet: src } });
    expect(rotation.sourceToken).toBe(runnerA.address);
    expect(rotation.tokenBought).toBe(dest.address);
    expect(Number(rotation.realizedProfitUsd)).toBe(400);

    // idempotent
    const r2 = await buildCapitalChains(prisma, { chain: 'SOLANA' });
    expect(r2.errors).toBe(0);
    expect(await prisma.capitalChain.count({ where: { sourceWallet: src } })).toBe(3);
  });
});
