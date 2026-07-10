// FlowRadar — importWalletsCsv tests (Task 6 brief: "add a unit test for
// importWalletsCsv parsing/validation happy-path + one bad-row case").
//
// Integration test against the real LITE-mode Postgres (same pattern as
// ingest.test.ts — no per-test transaction isolation; every row here uses a
// wallet address prefixed with T6TEST so afterAll() can clean up precisely).

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import net from 'node:net';
import { prisma } from '../src/client';
import { importWalletsCsv } from '../src/csv/importWalletsCsv';

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
      '[importWalletsCsv.test] LITE Postgres not reachable on localhost:5439 — skipping ' +
        'integration tests. Run `npm run db:migrate` first to exercise this suite.'
    );
  }
});

afterAll(async () => {
  if (!dbReachable) return;
  await prisma.walletClassification.deleteMany({ where: { wallet: { address: { startsWith: 'T6TEST' } } } });
  await prisma.walletStats.deleteMany({ where: { wallet: { address: { startsWith: 'T6TEST' } } } });
  await prisma.wallet.deleteMany({ where: { address: { startsWith: 'T6TEST' } } });
  await prisma.importJob.deleteMany({ where: { filename: { startsWith: 'T6TEST' } } });
  await prisma.$disconnect();
});

// Base58 excludes 0/O/I/l (visual-ambiguity exclusions) — every synthetic
// address below is built only from base58-safe characters so it passes the
// importer's own base58-charset + [32,44]-length validation (see
// importWalletsCsv.ts's isValidSolanaAddress comment).
const SOLANA_ADDR_A = 'T6TESTwaAetAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; // 43 base58-alphabet chars
const BSC_ADDR = '0x1234567890abcdef1234567890abcdef12345678';

// Row A's `source` column is deliberately free-text provenance ("gmgn list"),
// not the literal "csv" — exercises decision 3's Wallet.notes propagation.
// Row B's `source` column is literal "csv" — exercises the "no note written"
// branch (a CSV author restating "csv" carries no new information).
function validCsvFixture(): string {
  return [
    'wallet_address,chain,pnl_30d,realized_pnl_30d,unrealized_pnl_30d,win_rate,trade_count_30d,avg_trade_size_usd,tags,source',
    `${SOLANA_ADDR_A},SOLANA,15000,12000,3000,0.55,20,600,smart_money|human_like,gmgn list`,
    `${BSC_ADDR},BSC,8000,6000,2000,0.42,12,400,bridge_related,csv`
  ].join('\n');
}

describe.skipIf(!(await probePort('localhost', 5439)))('importWalletsCsv', () => {
  it('happy path: parses valid rows, upserts Wallet + WalletStats(source=csv) + WalletClassification, creates ImportJob with okRows matching', async () => {
    const result = await importWalletsCsv(prisma, validCsvFixture(), 'T6TEST-valid.csv');

    expect(result.totalRows).toBe(2);
    expect(result.okRows).toBe(2);
    expect(result.errorRows).toBe(0);
    expect(result.errors).toEqual([]);

    const importJob = await prisma.importJob.findUnique({ where: { id: result.importJobId } });
    expect(importJob).not.toBeNull();
    expect(importJob!.totalRows).toBe(2);
    expect(importJob!.okRows).toBe(2);
    expect(importJob!.errorRows).toBe(0);
    expect(importJob!.status).toBe('completed');

    const walletA = await prisma.wallet.findUnique({
      where: { address_chain: { address: SOLANA_ADDR_A, chain: 'SOLANA' } }
    });
    expect(walletA).not.toBeNull();

    const stats = await prisma.walletStats.findFirst({
      where: { walletId: walletA!.id },
      orderBy: { computedAt: 'desc' }
    });
    expect(stats).not.toBeNull();
    expect(stats!.source).toBe('csv');
    expect(stats!.window).toBe('30d');
    expect(Number(stats!.pnlUsd)).toBeCloseTo(15000, 4);
    expect(Number(stats!.realizedPnlUsd)).toBeCloseTo(12000, 4);
    expect(Number(stats!.unrealizedPnlUsd)).toBeCloseTo(3000, 4);
    expect(stats!.winRate).toBeCloseTo(0.55, 6);
    expect(stats!.tradeCount).toBe(20);
    expect(Number(stats!.avgTradeSizeUsd)).toBeCloseTo(600, 4);
    expect(stats!.walletScore).toBeGreaterThan(0);
    expect(stats!.walletScore).toBeLessThanOrEqual(100);

    // tags "smart_money|human_like" -> two WalletClassification rows.
    const classifications = await prisma.walletClassification.findMany({ where: { walletId: walletA!.id } });
    const labels = classifications.map((c) => c.label).sort();
    expect(labels).toEqual(['human_like', 'smart_money']);

    // BSC row also lands correctly (chain-specific address validation + tag).
    const walletB = await prisma.wallet.findUnique({
      where: { address_chain: { address: BSC_ADDR, chain: 'BSC' } }
    });
    expect(walletB).not.toBeNull();
    const classificationsB = await prisma.walletClassification.findMany({ where: { walletId: walletB!.id } });
    expect(classificationsB.map((c) => c.label)).toEqual(['bridge_related']);

    // Decision 3: WalletStats.source stays hardcoded 'csv' regardless of the
    // CSV's own free-text source column value (asserted above via
    // stats!.source === 'csv') — the free-text value instead propagates to
    // Wallet.notes. Row A's source ("gmgn list") is non-"csv" free-text, so it
    // is appended as `source: gmgn list`; row B's source is literally "csv",
    // which carries no new information, so no note is written (notes stays
    // null on a brand-new wallet).
    expect(walletA!.notes).toBe('source: gmgn list');
    expect(walletB!.notes).toBeNull();
  });

  it('re-import same file: free-text source note is idempotent — no duplicate line on Wallet.notes', async () => {
    const csv = validCsvFixture();

    const first = await importWalletsCsv(prisma, csv, 'T6TEST-reimport-1.csv');
    expect(first.okRows).toBe(2);

    const walletA = await prisma.wallet.findUnique({
      where: { address_chain: { address: SOLANA_ADDR_A, chain: 'SOLANA' } }
    });
    expect(walletA).not.toBeNull();
    const statsCountAfterFirst = await prisma.walletStats.count({ where: { walletId: walletA!.id } });

    const second = await importWalletsCsv(prisma, csv, 'T6TEST-reimport-2.csv');
    expect(second.okRows).toBe(2);

    const walletAAfterSecond = await prisma.wallet.findUnique({
      where: { address_chain: { address: SOLANA_ADDR_A, chain: 'SOLANA' } }
    });
    expect(walletAAfterSecond).not.toBeNull();
    // Exactly one `source: gmgn list` line, not two, despite two import runs
    // over the identical row (each importWalletsCsv call in this test
    // upserts the SAME already-existing wallet — this DB-integration suite
    // shares one Postgres instance across every `it` block with no
    // per-test transaction isolation, so absolute counts aren't safe
    // assertions here, only before/after deltas and the note's exact value).
    expect(walletAAfterSecond!.notes).toBe('source: gmgn list');

    // Second import still creates a fresh WalletStats row (source=csv) per
    // row — re-import idempotency applies to the *note*, not to WalletStats
    // (every valid row always inserts a new WalletStats row — see file
    // header's "Wallet upsert semantics" comment). Asserted as a +1 delta
    // (this test's own second call only) rather than an absolute count,
    // since walletA may already carry WalletStats rows from earlier tests
    // in this shared-DB suite.
    const statsCountAfterSecond = await prisma.walletStats.count({ where: { walletId: walletA!.id } });
    expect(statsCountAfterSecond).toBe(statsCountAfterFirst + 1);
  });

  it('bad-row case: missing wallet_address, invalid chain, malformed address, and negative trade_count each produce a row-level error (not a throw), valid rows still import', async () => {
    const csv = [
      'wallet_address,chain,pnl_30d,realized_pnl_30d,unrealized_pnl_30d,win_rate,trade_count_30d,avg_trade_size_usd,tags,source',
      `,SOLANA,15000,12000,3000,0.55,20,600,,csv`, // missing wallet_address
      `T6TESTbadchain111111111111111111111111111,ETHEREUM,15000,12000,3000,0.55,20,600,,csv`, // invalid chain
      `not-valid-b58-!!!,SOLANA,15000,12000,3000,0.55,20,600,,csv`, // malformed address (invalid base58 chars)
      `T6TESTnegtradecount11111111111111111111111,SOLANA,15000,12000,3000,0.55,-5,600,,csv`, // negative trade_count
      `T6TESTvaAidrow2222222222222222222222222222,SOLANA,9000,7000,2000,0.4,10,300,,csv` // valid — should still import
    ].join('\n');

    const result = await importWalletsCsv(prisma, csv, 'T6TEST-bad-rows.csv');

    expect(result.totalRows).toBe(5);
    expect(result.okRows).toBe(1);
    expect(result.errorRows).toBe(4);
    expect(result.errors).toHaveLength(4);

    const messages = result.errors.map((e) => e.message);
    expect(messages.some((m) => m.includes('missing wallet_address'))).toBe(true);
    expect(messages.some((m) => m.includes('invalid chain'))).toBe(true);
    expect(messages.some((m) => m.includes('malformed'))).toBe(true);
    expect(messages.some((m) => m.includes('trade_count_30d'))).toBe(true);

    // Row numbers are 1-based data-row indices (header not counted).
    expect(result.errors.map((e) => e.row).sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);

    // The one valid row (row 5) still imported despite 4 bad rows around it.
    const validWallet = await prisma.wallet.findUnique({
      where: {
        address_chain: { address: 'T6TESTvaAidrow2222222222222222222222222222', chain: 'SOLANA' }
      }
    });
    expect(validWallet).not.toBeNull();

    const importJob = await prisma.importJob.findUnique({ where: { id: result.importJobId } });
    expect(importJob!.status).toBe('completed_with_errors');
    expect(importJob!.errorRows).toBe(4);
  });

  // ---------------------------------------------------------------------------
  // Phase 0 status taxonomy (2026-07-10 review — all three import-side
  // status mutations were untested): fresh create mints signal_eligible;
  // re-import upgrades observation_only (and grants isWatched in the same
  // write); classified statuses survive re-import.
  // ---------------------------------------------------------------------------
  // This file cleans up in afterAll only (tests above share upsert
  // semantics); the STATUS tests need a pristine wallet row, so each resets
  // the fixture addresses itself.
  async function resetFixtureWallets() {
    await prisma.walletClassification.deleteMany({ where: { wallet: { address: { in: [SOLANA_ADDR_A, BSC_ADDR] } } } });
    await prisma.walletStats.deleteMany({ where: { wallet: { address: { in: [SOLANA_ADDR_A, BSC_ADDR] } } } });
    await prisma.wallet.deleteMany({ where: { address: { in: [SOLANA_ADDR_A, BSC_ADDR] } } });
  }

  it('STATUS: a freshly created wallet is signal_eligible + isWatched (operator-vouched Layer-1)', async () => {
    await resetFixtureWallets();
    await importWalletsCsv(prisma, validCsvFixture(), 'T6TEST-status-fresh.csv');
    const wallet = await prisma.wallet.findUnique({
      where: { address_chain: { address: SOLANA_ADDR_A, chain: 'SOLANA' } }
    });
    expect(wallet!.status).toBe('signal_eligible');
    expect(wallet!.isWatched).toBe(true);
  });

  it('STATUS: re-importing a pre-existing observation_only wallet upgrades it to signal_eligible + isWatched', async () => {
    await resetFixtureWallets();
    const now = new Date();
    await prisma.wallet.create({
      data: { address: SOLANA_ADDR_A, chain: 'SOLANA', firstSeenAt: now, lastActiveAt: now, isWatched: false, status: 'observation_only' }
    });
    await importWalletsCsv(prisma, validCsvFixture(), 'T6TEST-status-upgrade.csv');
    const wallet = await prisma.wallet.findUnique({
      where: { address_chain: { address: SOLANA_ADDR_A, chain: 'SOLANA' } }
    });
    expect(wallet!.status).toBe('signal_eligible');
    expect(wallet!.isWatched).toBe(true);
  });

  it('STATUS: a classified wallet (public_kol) keeps its status on re-import — import supplies figures, classification decides weight', async () => {
    await resetFixtureWallets();
    const now = new Date();
    await prisma.wallet.create({
      data: { address: SOLANA_ADDR_A, chain: 'SOLANA', firstSeenAt: now, lastActiveAt: now, isWatched: false, status: 'public_kol' }
    });
    const result = await importWalletsCsv(prisma, validCsvFixture(), 'T6TEST-status-kol.csv');
    expect(result.okRows).toBe(2); // the import itself succeeds — stats are written
    const wallet = await prisma.wallet.findUnique({
      where: { address_chain: { address: SOLANA_ADDR_A, chain: 'SOLANA' } }
    });
    expect(wallet!.status).toBe('public_kol'); // classification survives
    const stats = await prisma.walletStats.findFirst({ where: { walletId: wallet!.id } });
    expect(stats).not.toBeNull(); // figures still imported
  });
});
