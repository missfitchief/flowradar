// FlowRadar — importWalletsCsv tests (Task 6 brief: "add a unit test for
// importWalletsCsv parsing/validation happy-path + one bad-row case").
//
// Integration test against the real LITE-mode Postgres (same pattern as
// ingest.test.ts — no per-test transaction isolation; every row here uses a
// wallet address prefixed with T6TEST so afterAll() can clean up precisely).

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import net from 'node:net';
import { prisma } from '../src/client.js';
import { importWalletsCsv } from '../src/csv/importWalletsCsv.js';

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

function validCsvFixture(): string {
  return [
    'wallet_address,chain,pnl_30d,realized_pnl_30d,unrealized_pnl_30d,win_rate,trade_count_30d,avg_trade_size_usd,tags,source',
    `${SOLANA_ADDR_A},SOLANA,15000,12000,3000,0.55,20,600,smart_money|human_like,csv`,
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
});
