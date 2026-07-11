// FlowRadar — candidate-buffer builder integration tests (directive Task 2).
//
// LITE-Postgres harness (probe :5439, collection-time skipIf, prefix cleanup)
// against flowradar_test. Verifies the directive's hard rules: dedupe by
// chain+wallet with ALL provenance preserved, category taxonomy with
// KOL/promoter separation, bounded buffer with reported (never silent) drops,
// observation_only inviolate, zero WalletStats writes, zero subscriptions,
// chain-specific identity, idempotent monotonic re-runs.

import { describe, expect, it, afterAll, beforeEach } from 'vitest';
import net from 'node:net';
import { prisma } from '../../src/client';
import { buildCandidateBuffer } from '../../src/gmgn/candidateBuffer';
import { gmgnDedupeKey } from '../../src/gmgn/ingest';

const PREFIX = 'T2BUF';

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

const dbReachable = await probePort('localhost', 5439);

function addr(suffix: string): string {
  // Base58-looking Solana-length filler around the prefix (exact validity is
  // not asserted by the buffer — provenance is, so a recognizable prefix wins).
  return `${PREFIX}${suffix}${'1'.repeat(Math.max(0, 32 - PREFIX.length - suffix.length))}`;
}

// Seeds GmgnObservation rows DIRECTLY (the builder's actual input) — the
// ingest path (address validation, wallet materialization) has its own suite.
async function seedObs(over: { walletAddress: string } & Record<string, unknown>) {
  const base = {
    chain: 'SOLANA' as const,
    sourceCommand: 'track smartmoney',
    tokenAddress: null as string | null,
    txHash: null as string | null,
    activityType: null as string | null,
    side: null as string | null,
    amountToken: null,
    amountUsd: null,
    providerPnlUsd: null,
    providerWinRate: null as number | null,
    providerTradeCount: null as number | null,
    rawClassification: null,
    isKolTagged: false,
    isPromoterTagged: false,
    activityTs: new Date('2026-07-10T00:00:00Z') as Date | null,
    retrievedAt: new Date('2026-07-10T00:00:00Z'),
    cursor: null as string | null,
    dataQuality: 'complete',
    ...over
  };
  const dedupeKey = gmgnDedupeKey(base as never);
  await prisma.gmgnObservation.create({
    data: {
      chain: base.chain,
      sourceCommand: base.sourceCommand,
      walletAddress: base.walletAddress as string,
      tokenAddress: base.tokenAddress,
      txHash: base.txHash,
      activityType: base.activityType,
      side: base.side,
      amountToken: base.amountToken as never,
      amountUsd: base.amountUsd as never,
      providerPnlUsd: base.providerPnlUsd as never,
      providerWinRate: base.providerWinRate,
      providerTradeCount: base.providerTradeCount,
      rawClassification: (base.rawClassification ?? undefined) as never,
      isKolTagged: base.isKolTagged,
      isPromoterTagged: base.isPromoterTagged,
      activityTs: base.activityTs,
      retrievedAt: base.retrievedAt,
      cursor: base.cursor,
      dataQuality: base.dataQuality,
      dedupeKey
    }
  });
}

async function cleanup() {
  await prisma.candidateWallet.deleteMany({ where: { walletAddress: { startsWith: PREFIX } } });
  await prisma.gmgnObservation.deleteMany({ where: { walletAddress: { startsWith: PREFIX } } });
  await prisma.observationProviderSnapshot.deleteMany({ where: { wallet: { address: { startsWith: PREFIX } } } });
  await prisma.monitoringSubscription.deleteMany({ where: { wallet: { address: { startsWith: PREFIX } } } });
  await prisma.wallet.deleteMany({ where: { address: { startsWith: PREFIX } } });
}

beforeEach(async () => {
  if (dbReachable) await cleanup();
});

afterAll(async () => {
  if (!dbReachable) return;
  await cleanup();
  await prisma.$disconnect();
});

describe.skipIf(!dbReachable)('buildCandidateBuffer', () => {
  it('dedupes by chain+wallet while preserving ALL provenance rows, with cross-source visibility', async () => {
    const w = addr('A');
    await seedObs({ walletAddress: w, sourceCommand: 'track smartmoney' });
    await seedObs({ walletAddress: w, sourceCommand: 'token traders', tokenAddress: `${PREFIX}TOK1` });

    const report = await buildCandidateBuffer(prisma);
    const rows = await prisma.candidateWallet.findMany({ where: { walletAddress: w } });
    expect(rows.length).toBe(2); // one provenance row PER source — nothing collapsed away
    expect(new Set(rows.map((r) => r.source))).toEqual(new Set(['gmgn:track smartmoney', 'gmgn:token traders']));
    // but the buffer counts it as ONE candidate
    const distinctForW = new Set(rows.map((r) => `${r.chain}|${r.walletAddress}`));
    expect(distinctForW.size).toBe(1);
    expect(report.byCategory.gmgn_smartmoney).toBeGreaterThanOrEqual(1);
    expect(report.byCategory.gmgn_token_top_trader).toBeGreaterThanOrEqual(1);
  });

  it('separates public KOLs/promoters from trader categories', async () => {
    await seedObs({ walletAddress: addr('KOL'), isKolTagged: true });
    await seedObs({ walletAddress: addr('PRO'), isPromoterTagged: true });
    await seedObs({ walletAddress: addr('TRD') });
    const report = await buildCandidateBuffer(prisma);
    expect(report.publicFigures).toBeGreaterThanOrEqual(2);

    const kolRow = await prisma.candidateWallet.findFirst({ where: { walletAddress: addr('KOL') } });
    expect((kolRow?.metadataJson as { category?: string })?.category).toBe('public_kol');
    const trdRow = await prisma.candidateWallet.findFirst({ where: { walletAddress: addr('TRD') } });
    expect((trdRow?.metadataJson as { category?: string })?.category).toBe('gmgn_smartmoney');
  });

  it('ingests active lineage receivers as lineage_receiver provenance', async () => {
    const wallet = await prisma.wallet.create({
      data: { chain: 'SOLANA', address: addr('RCV'), firstSeenAt: new Date(), lastActiveAt: new Date() }
    });
    await prisma.monitoringSubscription.create({
      data: { walletId: wallet.id, priority: 'fresh_receiver_hot', active: true, reason: 'test receiver' }
    });

    const report = await buildCandidateBuffer(prisma);
    expect(report.byCategory.lineage_receiver).toBeGreaterThanOrEqual(1);
    const row = await prisma.candidateWallet.findFirst({ where: { walletAddress: addr('RCV'), source: 'lineage:receiver' } });
    expect(row).not.toBeNull();
  });

  it('enforces the buffer cap deterministically and REPORTS drops (multi-source candidates win)', async () => {
    const multi = addr('M');
    await seedObs({ walletAddress: multi, sourceCommand: 'track smartmoney' });
    await seedObs({ walletAddress: multi, sourceCommand: 'token traders', tokenAddress: `${PREFIX}TOK2` });
    await seedObs({ walletAddress: addr('S1') });
    await seedObs({ walletAddress: addr('S2') });

    // Cap chosen relative to the CURRENT buffer population (shared test DB):
    // admit exactly 2 more candidates than already exist.
    const existing = await prisma.candidateWallet.findMany({ select: { walletAddress: true, chain: true } });
    const existingDistinct = new Set(existing.map((e) => `${e.chain}|${e.walletAddress}`)).size;
    const report = await buildCandidateBuffer(prisma, { maxBufferSize: existingDistinct + 2 });

    expect(report.droppedOverCap).toBe(1); // 3 new candidates, capacity 2 — one dropped, REPORTED
    const multiRows = await prisma.candidateWallet.count({ where: { walletAddress: multi } });
    expect(multiRows).toBe(2); // the cross-source-confirmed candidate was admitted with full provenance
  });

  it('NEVER mutates wallet status, WalletStats, or subscriptions', async () => {
    const w = addr('NOP');
    await prisma.wallet.create({
      data: { chain: 'SOLANA', address: w, status: 'observation_only', firstSeenAt: new Date(), lastActiveAt: new Date() }
    });
    await seedObs({ walletAddress: w, providerPnlUsd: 99999 as never, providerWinRate: 0.99, providerTradeCount: 500 });
    const statsBefore = await prisma.walletStats.count();
    const subsBefore = await prisma.monitoringSubscription.count();

    await buildCandidateBuffer(prisma);

    const wallet = await prisma.wallet.findUnique({ where: { address_chain: { address: w, chain: 'SOLANA' } } });
    expect(wallet?.status).toBe('observation_only'); // stellar claimed stats grant NOTHING
    expect(await prisma.walletStats.count()).toBe(statsBefore); // zero WalletStats fabrication
    expect(await prisma.monitoringSubscription.count()).toBe(subsBefore); // buffer != subscriptions
    const row = await prisma.candidateWallet.findFirst({ where: { walletAddress: w } });
    expect(row?.validationStatus).toBe('pending'); // promotion stays Task-10-gated
    expect(Number(row?.claimedPnlUsd)).toBe(99999); // provider stats stay CLAIMED, on the candidate row only
  });

  it('retains chain-specific identity: same address on SOLANA and BSC = two candidates', async () => {
    const w = addr('X');
    await seedObs({ walletAddress: w, chain: 'SOLANA' });
    await seedObs({ walletAddress: w, chain: 'BSC' });
    await buildCandidateBuffer(prisma);
    const rows = await prisma.candidateWallet.findMany({ where: { walletAddress: w } });
    expect(new Set(rows.map((r) => r.chain))).toEqual(new Set(['SOLANA', 'BSC']));
  });

  it('re-runs are idempotent and monotonic (an older replay never regresses lastSeenAt)', async () => {
    const w = addr('IDM');
    await seedObs({ walletAddress: w, activityTs: new Date('2026-07-10T10:00:00Z'), retrievedAt: new Date('2026-07-10T10:00:00Z') });
    const r1 = await buildCandidateBuffer(prisma);
    expect(r1.provenanceCreated).toBeGreaterThanOrEqual(1);

    const r2 = await buildCandidateBuffer(prisma);
    expect(r2.provenanceCreated).toBe(0); // nothing new
    const after = await prisma.candidateWallet.findFirst({ where: { walletAddress: w } });
    expect(after?.lastSeenAt.toISOString()).toBe('2026-07-10T10:00:00.000Z'); // no regressions, no drift
  });
});
