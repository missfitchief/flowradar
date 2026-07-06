// FlowRadar — runTokenOverlapSearch / runDuneQuerySync integration tests
// (Task 37, Wave 4.6). Same LITE-Postgres integration pattern as
// externalWalletSource.test.ts (prefix-cleanup, describe.skipIf when the
// embedded Postgres isn't reachable).
//
// Covers: persists search+results+groups+candidates pending; truncated flag
// when capped; re-run dedupes candidates (unique tuple); no-client => failed
// status, never throws.

import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import net from 'node:net';
import { DEFAULT_SETTINGS } from '@flowradar/core';
import type { DuneClient, DuneResultSet } from '@flowradar/providers';
import { prisma } from '../../src/client';
import { runTokenOverlapSearch, runDuneQuerySync } from '../../src/dune/duneOverlap';

const ADDR_PREFIX = 'T37DUNE';
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
      '[duneOverlap.test] LITE Postgres not reachable on localhost:5439 — skipping ' +
        'integration tests. Run `npm run db:migrate` first to exercise this suite.'
    );
  }
});

async function cleanup() {
  await prisma.candidateWallet.deleteMany({ where: { walletAddress: { startsWith: ADDR_PREFIX } } });
  await prisma.tokenOverlapSearch.deleteMany({ where: { tokenAddresses: { hasSome: [`${ADDR_PREFIX}_tokA`] } } });
  await prisma.duneQuerySource.deleteMany({ where: { name: { startsWith: ADDR_PREFIX } } });
}

afterAll(async () => {
  if (!dbReachable) return;
  await cleanup();
  await prisma.$disconnect();
});

beforeEach(async () => {
  if (!dbReachable) return;
  await cleanup();
});

function makeFakeDuneClient(resultSet: DuneResultSet): DuneClient & { callCount: number } {
  return {
    callCount: 0,
    async executeQuery() {
      this.callCount += 1;
      return resultSet;
    }
  };
}

describe.skipIf(!(await probePort('localhost', 5439)))('runTokenOverlapSearch', () => {
  it('persists search + wallet results + group results + pending CandidateWallet rows', async () => {
    const client = makeFakeDuneClient({
      rows: [
        {
          wallet_address: `${ADDR_PREFIX}_w1`,
          chain: CHAIN,
          buy_count: 4,
          sell_count: 1,
          total_buy_usd: 5000,
          total_sell_usd: 6000,
          estimated_pnl_usd: 1000,
          tokens_overlap_count: 2,
          overlap_group_id: `${ADDR_PREFIX}_group1`,
          tx_hashes: ['0xabc']
        },
        {
          wallet_address: `${ADDR_PREFIX}_w2`,
          chain: CHAIN,
          buy_count: 3,
          sell_count: 0,
          total_buy_usd: 3000,
          estimated_pnl_usd: 500,
          tokens_overlap_count: 2,
          overlap_group_id: `${ADDR_PREFIX}_group1`,
          tx_hashes: []
        },
        {
          // Missing wallet_address — must be dropped, never thrown.
          chain: CHAIN,
          buy_count: 1
        }
      ],
      usedCached: true,
      truncated: false,
      rowsReturned: 3
    });

    const result = await runTokenOverlapSearch(
      prisma,
      { chain: CHAIN, tokenAddresses: [`${ADDR_PREFIX}_tokA`, `${ADDR_PREFIX}_tokB`] },
      () => client
    );

    expect(result.status).toBe('done');
    expect(result.rowsDropped).toBe(1);
    expect(result.walletResultsCreated).toBe(2);
    expect(result.candidatesUpserted).toBe(2);
    expect(result.groupResultsCreated).toBe(1); // group1 has 2 distinct wallets

    const search = await prisma.tokenOverlapSearch.findUnique({ where: { id: result.searchId } });
    expect(search?.status).toBe('done');
    expect(search?.rowsReturned).toBe(3);
    expect(search?.usedCachedResult).toBe(true);

    const walletResults = await prisma.tokenOverlapWalletResult.findMany({ where: { searchId: result.searchId } });
    expect(walletResults).toHaveLength(2);

    const groupResults = await prisma.tokenOverlapGroupResult.findMany({ where: { searchId: result.searchId } });
    expect(groupResults).toHaveLength(1);
    expect(groupResults[0]!.walletCount).toBe(2);

    const candidates = await prisma.candidateWallet.findMany({
      where: { walletAddress: { in: [`${ADDR_PREFIX}_w1`, `${ADDR_PREFIX}_w2`] } }
    });
    expect(candidates).toHaveLength(2);
    for (const c of candidates) {
      expect(c.source).toBe('dune_token_overlap');
      expect(c.validationStatus).toBe('pending');
    }
  });

  it('truncated=true when rowsReturned hits max_results cap', async () => {
    const client = makeFakeDuneClient({
      rows: [
        { wallet_address: `${ADDR_PREFIX}_trunc1`, tokens_overlap_count: 2 },
        { wallet_address: `${ADDR_PREFIX}_trunc2`, tokens_overlap_count: 2 }
      ],
      usedCached: true,
      truncated: false, // client itself says not truncated
      rowsReturned: 2
    });

    const result = await runTokenOverlapSearch(
      prisma,
      { chain: CHAIN, tokenAddresses: [`${ADDR_PREFIX}_tokA`, `${ADDR_PREFIX}_tokB`], maxResults: 2 },
      () => client
    );

    // Even though the client reported truncated=false, hitting the caller's
    // own maxResults cap (2 rows returned, cap=2) must still surface as
    // truncated=true on the persisted search row.
    expect(result.truncated).toBe(true);
    const search = await prisma.tokenOverlapSearch.findUnique({ where: { id: result.searchId } });
    expect(search?.truncated).toBe(true);
  });

  it('re-run dedupes candidates on (walletAddress, chain, source) — second import adds 0 new rows for the identical result set', async () => {
    const client = makeFakeDuneClient({
      rows: [{ wallet_address: `${ADDR_PREFIX}_dedupe1`, tokens_overlap_count: 2, estimated_pnl_usd: 100 }],
      usedCached: true,
      truncated: false,
      rowsReturned: 1
    });

    await runTokenOverlapSearch(prisma, { chain: CHAIN, tokenAddresses: [`${ADDR_PREFIX}_tokA`, `${ADDR_PREFIX}_tokB`] }, () => client);
    const firstRow = await prisma.candidateWallet.findFirst({ where: { walletAddress: `${ADDR_PREFIX}_dedupe1` } });
    expect(firstRow).not.toBeNull();

    // Second identical search (a fresh TokenOverlapSearch row, but the SAME
    // wallet address) — must dedupe the CandidateWallet, not create a second row.
    await runTokenOverlapSearch(prisma, { chain: CHAIN, tokenAddresses: [`${ADDR_PREFIX}_tokA`, `${ADDR_PREFIX}_tokB`] }, () => client);

    const allRows = await prisma.candidateWallet.findMany({ where: { walletAddress: `${ADDR_PREFIX}_dedupe1` } });
    expect(allRows).toHaveLength(1);
  });

  it('IMPORTANT: candidatesCreated reflects only THIS search\'s newly-created candidates — a re-run over the same wallets reports candidatesCreated=0, candidatesUpserted unchanged', async () => {
    const client = makeFakeDuneClient({
      rows: [
        { wallet_address: `${ADDR_PREFIX}_added1`, tokens_overlap_count: 2, estimated_pnl_usd: 100 },
        { wallet_address: `${ADDR_PREFIX}_added2`, tokens_overlap_count: 2, estimated_pnl_usd: 200 }
      ],
      usedCached: true,
      truncated: false,
      rowsReturned: 2
    });

    const firstRun = await runTokenOverlapSearch(
      prisma,
      { chain: CHAIN, tokenAddresses: [`${ADDR_PREFIX}_tokA`, `${ADDR_PREFIX}_tokB`] },
      () => client
    );
    // Both wallets are brand new candidates => created === upserted === 2.
    expect(firstRun.candidatesUpserted).toBe(2);
    expect(firstRun.candidatesCreated).toBe(2);

    const firstSearchRow = await prisma.tokenOverlapSearch.findUnique({ where: { id: firstRun.searchId } });
    expect(firstSearchRow?.candidatesCreated).toBe(2);

    // Second run over the exact same tokens/result set (a fresh
    // TokenOverlapSearch row, same overlap wallets) — nothing NEW is
    // created; both wallets already exist as dune_token_overlap candidates.
    const secondRun = await runTokenOverlapSearch(
      prisma,
      { chain: CHAIN, tokenAddresses: [`${ADDR_PREFIX}_tokA`, `${ADDR_PREFIX}_tokB`] },
      () => client
    );
    expect(secondRun.candidatesUpserted).toBe(2); // still matches/re-syncs both
    expect(secondRun.candidatesCreated).toBe(0); // but creates none

    const secondSearchRow = await prisma.tokenOverlapSearch.findUnique({ where: { id: secondRun.searchId } });
    expect(secondSearchRow?.candidatesCreated).toBe(0);

    // Still exactly one CandidateWallet row per address — never duplicated.
    const rowsForAdded1 = await prisma.candidateWallet.findMany({ where: { walletAddress: `${ADDR_PREFIX}_added1` } });
    expect(rowsForAdded1).toHaveLength(1);
  });

  it('no DuneClient available => search marked failed, never throws', async () => {
    const result = await runTokenOverlapSearch(
      prisma,
      { chain: CHAIN, tokenAddresses: [`${ADDR_PREFIX}_tokA`, `${ADDR_PREFIX}_tokB`] },
      () => null
    );

    expect(result.status).toBe('failed');
    expect(result.error).toBeTruthy();

    const search = await prisma.tokenOverlapSearch.findUnique({ where: { id: result.searchId } });
    expect(search?.status).toBe('failed');
  });

  it('re-sync NEVER downgrades an already-promoted dune candidate back to pending', async () => {
    const client = makeFakeDuneClient({
      rows: [{ wallet_address: `${ADDR_PREFIX}_promoted1`, tokens_overlap_count: 2, estimated_pnl_usd: 100 }],
      usedCached: true,
      truncated: false,
      rowsReturned: 1
    });

    await runTokenOverlapSearch(prisma, { chain: CHAIN, tokenAddresses: [`${ADDR_PREFIX}_tokA`, `${ADDR_PREFIX}_tokB`] }, () => client);
    const row = await prisma.candidateWallet.findFirst({ where: { walletAddress: `${ADDR_PREFIX}_promoted1` } });
    await prisma.candidateWallet.update({ where: { id: row!.id }, data: { validationStatus: 'promoted', validationConfidence: 90 } });

    await runTokenOverlapSearch(prisma, { chain: CHAIN, tokenAddresses: [`${ADDR_PREFIX}_tokA`, `${ADDR_PREFIX}_tokB`] }, () => client);

    const rowAfter = await prisma.candidateWallet.findUnique({ where: { id: row!.id } });
    expect(rowAfter!.validationStatus).toBe('promoted');
  });
});

describe.skipIf(!(await probePort('localhost', 5439)))('runDuneQuerySync', () => {
  async function makeSourceRow(name: string, overrides: Partial<{ enabled: boolean }> = {}) {
    return prisma.duneQuerySource.create({
      data: {
        name,
        queryId: '999999',
        purpose: 'token_overlap',
        enabled: overrides.enabled ?? true
      }
    });
  }

  it('refreshes an enabled DuneQuerySource row, sets lastRunAt/lastSuccessAt/status=ok', async () => {
    const sourceName = `${ADDR_PREFIX}_source_ok`;
    await makeSourceRow(sourceName);

    const client = makeFakeDuneClient({ rows: [], usedCached: true, truncated: false, rowsReturned: 0 });
    const result = await runDuneQuerySync(prisma, DEFAULT_SETTINGS, () => client);

    expect(result.errors).toBe(0);
    expect(result.sourcesRefreshed).toBeGreaterThanOrEqual(1);

    const row = await prisma.duneQuerySource.findUnique({ where: { name: sourceName } });
    expect(row?.status).toBe('ok');
    expect(row?.lastRunAt).not.toBeNull();
    expect(row?.lastSuccessAt).not.toBeNull();
  });

  it('disabled source is skipped, client never called for it', async () => {
    const sourceName = `${ADDR_PREFIX}_source_disabled`;
    await makeSourceRow(sourceName, { enabled: false });

    const client = makeFakeDuneClient({ rows: [], usedCached: true, truncated: false, rowsReturned: 0 });
    const result = await runDuneQuerySync(prisma, DEFAULT_SETTINGS, () => client);

    expect(result.sourcesSkippedDisabled).toBeGreaterThanOrEqual(1);

    const row = await prisma.duneQuerySource.findUnique({ where: { name: sourceName } });
    expect(row?.lastRunAt).toBeNull();
  });

  it('client throwing is caught per-row, status=error, never aborts the pass', async () => {
    const sourceName = `${ADDR_PREFIX}_source_error`;
    await makeSourceRow(sourceName);

    const badClient: DuneClient = {
      async executeQuery() {
        throw new Error('simulated Dune API failure');
      }
    };
    const result = await runDuneQuerySync(prisma, DEFAULT_SETTINGS, () => badClient);

    expect(result.errors).toBeGreaterThanOrEqual(1);
    const row = await prisma.duneQuerySource.findUnique({ where: { name: sourceName } });
    expect(row?.status).toBe('error');
    expect(row?.lastError).toContain('simulated Dune API failure');
  });

  // Folded fix (Task 37 review, done as part of Task 38): resolveClient()
  // returning null/undefined for an ENABLED source mid-loop (e.g. the API
  // key disappeared between sources) must be counted distinctly from both
  // sourcesSkippedDisabled (a deliberate enabled=false) and errors (a client
  // that resolved but threw) — and must leave the row's status/lastError set
  // so the pass summary + any UI reading DuneQuerySource rows can see it,
  // not just a log line that silently vanished.
  it('enabled source with no resolvable client is counted (sourcesSkippedNoClient), not silently dropped', async () => {
    const sourceName = `${ADDR_PREFIX}_source_no_client`;
    await makeSourceRow(sourceName);

    const result = await runDuneQuerySync(prisma, DEFAULT_SETTINGS, () => null);

    expect(result.sourcesSkippedNoClient).toBeGreaterThanOrEqual(1);
    expect(result.errors).toBe(0);
    expect(result.sourcesRefreshed).toBe(0);

    const row = await prisma.duneQuerySource.findUnique({ where: { name: sourceName } });
    expect(row?.status).toBe('no_client');
    expect(row?.lastError).toBeTruthy();
    expect(row?.lastRunAt).not.toBeNull();
  });
});
