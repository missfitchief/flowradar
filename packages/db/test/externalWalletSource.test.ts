// FlowRadar — runExternalWalletSourceSync integration tests (Task 34, Wave
// 4.5, Spec §5b). Same LITE-Postgres integration pattern as
// walletDiscovery.test.ts (prefix-cleanup, describe.skipIf when the embedded
// Postgres isn't reachable).

import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import net from 'node:net';
import { DEFAULT_SETTINGS } from '@flowradar/core';
import type { Chain } from '@flowradar/core';
import type { CandidateSourceProvider, ExternalCandidate } from '@flowradar/providers';
import { prisma } from '../src/client';
import { runExternalWalletSourceSync } from '../src/externalWalletSource';

const ADDR_PREFIX = 'T34EWS';
const SOURCE_PREFIX = 'T34ewsSource';

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
      '[externalWalletSource.test] LITE Postgres not reachable on localhost:5439 — skipping ' +
        'integration tests. Run `npm run db:migrate` first to exercise this suite.'
    );
  }
});

afterAll(async () => {
  if (!dbReachable) return;
  await prisma.candidateWallet.deleteMany({ where: { walletAddress: { startsWith: ADDR_PREFIX } } });
  await prisma.externalWalletSource.deleteMany({ where: { name: { startsWith: SOURCE_PREFIX } } });
  await prisma.wallet.deleteMany({ where: { address: { startsWith: ADDR_PREFIX } } });
  await prisma.$disconnect();
});

beforeEach(async () => {
  if (!dbReachable) return;
  await prisma.candidateWallet.deleteMany({ where: { walletAddress: { startsWith: ADDR_PREFIX } } });
  await prisma.externalWalletSource.deleteMany({ where: { name: { startsWith: SOURCE_PREFIX } } });
});

function makeFakeProvider(candidates: ExternalCandidate[]): CandidateSourceProvider & { callCount: number } {
  return {
    name: 'fake',
    chains: ['SOLANA', 'BSC'],
    callCount: 0,
    async fetchCandidates(chain: Chain) {
      this.callCount += 1;
      return candidates.filter((c) => c.chain === chain);
    }
  };
}

async function makeSourceRow(name: string, overrides: Partial<{ enabled: boolean; chainSupport: string[] }> = {}) {
  return prisma.externalWalletSource.create({
    data: {
      name,
      type: 'test',
      enabled: overrides.enabled ?? true,
      chainSupport: overrides.chainSupport ?? ['SOLANA'],
      apiKeyEnvName: 'TEST_API_KEY',
      rateLimitPerMinute: 60
    }
  });
}

describe.skipIf(!(await probePort('localhost', 5439)))('runExternalWalletSourceSync', () => {
  it('enabled source produces CandidateWallet rows, pending, from claimed figures', async () => {
    const sourceName = `${SOURCE_PREFIX}_basic`;
    await makeSourceRow(sourceName);

    const provider = makeFakeProvider([
      {
        walletAddress: `${ADDR_PREFIX}_cand1`,
        chain: 'SOLANA',
        sourceRank: 1,
        claimedPnlUsd: 12000,
        claimedWinRate: 0.6,
        claimedTradeCount: 20,
        claimedRoi: 2.1
      }
    ]);

    const result = await runExternalWalletSourceSync(prisma, DEFAULT_SETTINGS, () => provider);

    expect(result.errors).toBe(0);
    expect(result.candidatesUpserted).toBeGreaterThanOrEqual(1);

    const candidate = await prisma.candidateWallet.findFirst({
      where: { walletAddress: `${ADDR_PREFIX}_cand1`, chain: 'SOLANA' }
    });
    expect(candidate).not.toBeNull();
    expect(candidate!.validationStatus).toBe('pending');
    expect(Number(candidate!.claimedPnlUsd)).toBe(12000);
    expect(candidate!.claimedWinRate).toBe(0.6);
    expect(candidate!.claimedTradeCount).toBe(20);
    expect(candidate!.claimedRoi).toBe(2.1);

    const sourceRow = await prisma.externalWalletSource.findUnique({ where: { name: sourceName } });
    expect(sourceRow?.lastSyncAt).not.toBeNull();
    expect(sourceRow?.status).toBe('ok');
  });

  it('disabled source is skipped entirely — no candidates, provider never called', async () => {
    const sourceName = `${SOURCE_PREFIX}_disabled`;
    await makeSourceRow(sourceName, { enabled: false });

    const provider = makeFakeProvider([
      { walletAddress: `${ADDR_PREFIX}_should_not_exist`, chain: 'SOLANA', claimedPnlUsd: 9999 }
    ]);

    // Scoped resolver: only ever returns a provider for THIS test's own
    // source row — other (possibly real-seeded) ExternalWalletSource rows in
    // the shared DB resolve to null/no-op, so this test's callCount
    // assertion isn't polluted by unrelated enabled sources.
    const result = await runExternalWalletSourceSync(prisma, DEFAULT_SETTINGS, (source) =>
      source.name === sourceName ? provider : null
    );

    expect(result.sourcesSkippedDisabled).toBeGreaterThanOrEqual(1);
    expect(provider.callCount).toBe(0);

    const candidate = await prisma.candidateWallet.findFirst({ where: { walletAddress: `${ADDR_PREFIX}_should_not_exist` } });
    expect(candidate).toBeNull();
  });

  it('re-sync (second run) updates lastSeenAt + claimed figures but adds zero new rows for the same (address, chain, source)', async () => {
    const sourceName = `${SOURCE_PREFIX}_resync`;
    await makeSourceRow(sourceName);

    const provider = makeFakeProvider([
      { walletAddress: `${ADDR_PREFIX}_resync1`, chain: 'SOLANA', claimedPnlUsd: 5000, claimedWinRate: 0.4 }
    ]);

    await runExternalWalletSourceSync(prisma, DEFAULT_SETTINGS, (source) => (source.name === sourceName ? provider : null));
    const firstRow = await prisma.candidateWallet.findFirst({ where: { walletAddress: `${ADDR_PREFIX}_resync1` } });
    expect(firstRow).not.toBeNull();
    const firstSeenAt = firstRow!.firstSeenAt;

    // Second sync run, updated claimed figures.
    const provider2 = makeFakeProvider([
      { walletAddress: `${ADDR_PREFIX}_resync1`, chain: 'SOLANA', claimedPnlUsd: 8000, claimedWinRate: 0.55 }
    ]);
    await runExternalWalletSourceSync(prisma, DEFAULT_SETTINGS, (source) => (source.name === sourceName ? provider2 : null));

    const allRows = await prisma.candidateWallet.findMany({ where: { walletAddress: `${ADDR_PREFIX}_resync1` } });
    expect(allRows).toHaveLength(1); // deduped on (walletAddress, chain, source) — no new row

    const updatedRow = allRows[0]!;
    expect(Number(updatedRow.claimedPnlUsd)).toBe(8000);
    expect(updatedRow.claimedWinRate).toBe(0.55);
    expect(updatedRow.firstSeenAt.getTime()).toBe(firstSeenAt.getTime()); // firstSeenAt never changes
    expect(updatedRow.lastSeenAt.getTime()).toBeGreaterThanOrEqual(firstSeenAt.getTime());
  });

  it('re-sync NEVER downgrades an already-promoted candidate back to pending', async () => {
    const sourceName = `${SOURCE_PREFIX}_promoted`;
    await makeSourceRow(sourceName);

    const provider = makeFakeProvider([
      { walletAddress: `${ADDR_PREFIX}_promoted1`, chain: 'SOLANA', claimedPnlUsd: 5000 }
    ]);
    await runExternalWalletSourceSync(prisma, DEFAULT_SETTINGS, () => provider);

    const row = await prisma.candidateWallet.findFirst({ where: { walletAddress: `${ADDR_PREFIX}_promoted1` } });
    expect(row).not.toBeNull();

    // Simulate Task 35 promoting this candidate.
    await prisma.candidateWallet.update({
      where: { id: row!.id },
      data: { validationStatus: 'promoted', validationConfidence: 90 }
    });

    // Re-sync with fresh (still-passing) claimed figures.
    const provider2 = makeFakeProvider([
      { walletAddress: `${ADDR_PREFIX}_promoted1`, chain: 'SOLANA', claimedPnlUsd: 6000 }
    ]);
    await runExternalWalletSourceSync(prisma, DEFAULT_SETTINGS, () => provider2);

    const rowAfter = await prisma.candidateWallet.findUnique({ where: { id: row!.id } });
    expect(rowAfter!.validationStatus).toBe('promoted'); // NOT downgraded to pending
    expect(Number(rowAfter!.claimedPnlUsd)).toBe(6000); // claimed figures still refresh
  });

  it('re-sync NEVER downgrades an already-rejected candidate back to pending', async () => {
    const sourceName = `${SOURCE_PREFIX}_rejected`;
    await makeSourceRow(sourceName);

    const provider = makeFakeProvider([
      { walletAddress: `${ADDR_PREFIX}_rejected1`, chain: 'SOLANA', claimedPnlUsd: 5000 }
    ]);
    await runExternalWalletSourceSync(prisma, DEFAULT_SETTINGS, () => provider);

    const row = await prisma.candidateWallet.findFirst({ where: { walletAddress: `${ADDR_PREFIX}_rejected1` } });
    await prisma.candidateWallet.update({
      where: { id: row!.id },
      data: { validationStatus: 'rejected', rejectionReason: 'test: simulated rejection' }
    });

    const provider2 = makeFakeProvider([
      { walletAddress: `${ADDR_PREFIX}_rejected1`, chain: 'SOLANA', claimedPnlUsd: 7000 }
    ]);
    await runExternalWalletSourceSync(prisma, DEFAULT_SETTINGS, () => provider2);

    const rowAfter = await prisma.candidateWallet.findUnique({ where: { id: row!.id } });
    expect(rowAfter!.validationStatus).toBe('rejected'); // NOT downgraded to pending
  });

  it('one source throwing never aborts other enabled sources (per-source try/catch)', async () => {
    const goodSourceName = `${SOURCE_PREFIX}_good`;
    const badSourceName = `${SOURCE_PREFIX}_bad`;
    await makeSourceRow(goodSourceName);
    await makeSourceRow(badSourceName);

    const goodProvider = makeFakeProvider([
      { walletAddress: `${ADDR_PREFIX}_fromgood`, chain: 'SOLANA', claimedPnlUsd: 5000 }
    ]);
    const badProvider: CandidateSourceProvider = {
      name: 'bad',
      chains: ['SOLANA'],
      async fetchCandidates() {
        throw new Error('simulated provider failure');
      }
    };

    const result = await runExternalWalletSourceSync(prisma, DEFAULT_SETTINGS, (source) =>
      source.name === goodSourceName ? goodProvider : badProvider
    );

    expect(result.errors).toBeGreaterThanOrEqual(1);
    expect(result.candidatesUpserted).toBeGreaterThanOrEqual(1);

    const goodCandidate = await prisma.candidateWallet.findFirst({ where: { walletAddress: `${ADDR_PREFIX}_fromgood` } });
    expect(goodCandidate).not.toBeNull();

    const badSourceRow = await prisma.externalWalletSource.findUnique({ where: { name: badSourceName } });
    expect(badSourceRow?.status).toBe('error');
    expect(badSourceRow?.lastError).toContain('simulated provider failure');
    expect(badSourceRow?.failCount).toBeGreaterThanOrEqual(1);

    const goodSourceRow = await prisma.externalWalletSource.findUnique({ where: { name: goodSourceName } });
    expect(goodSourceRow?.status).toBe('ok');
  });

  it('missing resolver (returns null/undefined) is a graceful no-op for that source, never throws', async () => {
    const sourceName = `${SOURCE_PREFIX}_noresolver`;
    await makeSourceRow(sourceName);

    const result = await runExternalWalletSourceSync(prisma, DEFAULT_SETTINGS, () => null);

    expect(result.errors).toBe(0);
    expect(result.candidatesUpserted).toBe(0);
  });
});
