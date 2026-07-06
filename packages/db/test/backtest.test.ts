// FlowRadar — runBacktestPass / seedBacktestContinuation integration tests
// (Task 40 fix pass: machine-detectable synthetic provenance + defense-in-
// depth seed-only guard + window_incomplete moved into the repeatable gate).
//
// Same LITE-Postgres integration pattern as rotation.test.ts / ingest.test.ts
// (prefix-cleanup, describe.skipIf when the embedded Postgres isn't
// reachable on localhost:5439).

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import net from 'node:net';
import { prisma } from '../src/client';
import { snapshotMarket } from '../src/ingest';
import { runBacktestPass } from '../src/backtest';
import { seedBacktestContinuation } from '../src/seed';
import type { MockWorld } from '@flowradar/providers';

const ADDR_PREFIX = 'T40BACKTEST';
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
      '[backtest.test] LITE Postgres not reachable on localhost:5439 — skipping ' +
        'integration tests. Run `npm run db:migrate` first to exercise this suite.'
    );
  }
});

afterAll(async () => {
  if (!dbReachable) return;
  await prisma.backtestResult.deleteMany({ where: { signal: { token: { address: { startsWith: ADDR_PREFIX } } } } });
  await prisma.signal.deleteMany({ where: { token: { address: { startsWith: ADDR_PREFIX } } } });
  await prisma.tokenMarketSnapshot.deleteMany({ where: { token: { address: { startsWith: ADDR_PREFIX } } } });
  await prisma.token.deleteMany({ where: { address: { startsWith: ADDR_PREFIX } } });
  await prisma.$disconnect();
});

async function makeToken(addressSuffix: string, symbol: string, firstSeenAt: Date): Promise<string> {
  const address = `${ADDR_PREFIX}_token_${addressSuffix}`;
  const token = await prisma.token.upsert({
    where: { chain_address: { chain: CHAIN, address } },
    create: {
      chain: CHAIN,
      address,
      symbol,
      name: symbol,
      decimals: 9,
      firstSeenAt,
      riskFlags: []
    },
    update: {}
  });
  return token.id;
}

async function makeSignal(tokenId: string, triggeredAt: Date, mcapAtTrigger: number): Promise<string> {
  const signal = await prisma.signal.create({
    data: {
      tokenId,
      rule: 'A',
      severity: 'HIGH',
      triggeredAt,
      reasons: ['test reason for backtest integration test'],
      walletCount: 20,
      uniqueEntityCount: 5,
      netFlowUsd: 10_000,
      mcapAtTrigger,
      status: 'active',
      metrics: {}
    }
  });
  return signal.id;
}

describe.skipIf(!(await probePort('localhost', 5439)))('runBacktestPass — synthetic provenance + window_incomplete', () => {
  it(
    'CRITICAL: (a) continuation-style snapshots written with source=seed_synthetic_continuation carry the marker; ' +
      '(b) BacktestResult rows evaluated over a series containing such a snapshot carry notes including ' +
      "'synthetic_continuation'; (c) BacktestResult rows evaluated over a purely-real (source='ingest') series do not",
    async () => {
      const genesis = new Date('2026-06-01T00:00:00Z');

      // --- Signal A: token whose post-trigger series is ENTIRELY real ('ingest' default). ---
      const realTokenId = await makeToken('real', 'T40REAL', genesis);
      const realTriggeredAt = new Date(genesis.getTime() + 60 * 60_000);
      const realSignalId = await makeSignal(realTokenId, realTriggeredAt, 500_000);

      await snapshotMarket(
        prisma,
        realTokenId,
        { priceUsd: 1, marketCapUsd: 500_000, fdvUsd: 500_000, liquidityUsd: 100_000, vol5m: 0, vol1h: 0, vol6h: 0, vol24h: 0, holderCount: 100 },
        realTriggeredAt
      );
      const realLaterTs = new Date(realTriggeredAt.getTime() + 20 * 60_000);
      await snapshotMarket(
        prisma,
        realTokenId,
        { priceUsd: 1.2, marketCapUsd: 600_000, fdvUsd: 600_000, liquidityUsd: 100_000, vol5m: 0, vol1h: 0, vol6h: 0, vol24h: 0, holderCount: 100 },
        realLaterTs
      );

      // --- Signal B: token whose post-trigger series includes >=1 synthetic-continuation row. ---
      const synthTokenId = await makeToken('synth', 'T40SYNTH', genesis);
      const synthTriggeredAt = new Date(genesis.getTime() + 60 * 60_000);
      const synthSignalId = await makeSignal(synthTokenId, synthTriggeredAt, 500_000);

      await snapshotMarket(
        prisma,
        synthTokenId,
        { priceUsd: 1, marketCapUsd: 500_000, fdvUsd: 500_000, liquidityUsd: 100_000, vol5m: 0, vol1h: 0, vol6h: 0, vol24h: 0, holderCount: 100 },
        synthTriggeredAt
      );
      // Written the same way seedBacktestContinuation writes its continuation
      // rows: via snapshotMarket's explicit `source` override.
      const synthContinuationTs = new Date(synthTriggeredAt.getTime() + 20 * 60_000);
      await snapshotMarket(
        prisma,
        synthTokenId,
        { priceUsd: 2.5, marketCapUsd: 1_250_000, fdvUsd: 1_250_000, liquidityUsd: 100_000, vol5m: 0, vol1h: 0, vol6h: 0, vol24h: 0, holderCount: 100 },
        synthContinuationTs,
        'seed_synthetic_continuation'
      );

      // (a) The continuation row itself carries the source marker.
      const persistedContinuationRow = await prisma.tokenMarketSnapshot.findFirst({
        where: { tokenId: synthTokenId, ts: synthContinuationTs }
      });
      expect(persistedContinuationRow?.source).toBe('seed_synthetic_continuation');

      // Run the backtest pass with `now` far enough past both signals'
      // triggeredAt that every horizon is fully elapsed (D7 = 7 days) — this
      // isolates the case under test to the synthetic-provenance marker
      // rather than window_incomplete (covered by the next test).
      const now = new Date(Math.max(realTriggeredAt.getTime(), synthTriggeredAt.getTime()) + (7 * 24 + 1) * 60 * 60_000);
      await runBacktestPass(prisma, {} as never, now);

      // (b) Every BacktestResult row for the synthetic-containing signal
      // carries 'synthetic_continuation' in notes.
      const synthResults = await prisma.backtestResult.findMany({ where: { signalId: synthSignalId } });
      expect(synthResults.length).toBe(6);
      for (const row of synthResults) {
        expect(row.notes).toContain('synthetic_continuation');
      }

      // (c) BacktestResult rows for the purely-real signal do NOT carry the marker.
      const realResults = await prisma.backtestResult.findMany({ where: { signalId: realSignalId } });
      expect(realResults.length).toBe(6);
      for (const row of realResults) {
        expect(row.notes ?? '').not.toContain('synthetic_continuation');
      }
    }
  );

  it(
    'IMPORTANT: window_incomplete — a signal ~2h old with a short real-source series, evaluated with a real `now` ' +
      '(not a far-future one), gets M15/H1 rows finalized (notes null) but H6/H24/D3/D7 rows carry ' +
      "notes containing 'window_incomplete' (their windows have not fully elapsed yet)",
    async () => {
      const now = new Date();
      const triggeredAt = new Date(now.getTime() - 2 * 60 * 60_000); // ~2h old signal

      const tokenId = await makeToken('windowincomplete', 'T40WINC', new Date(triggeredAt.getTime() - 60 * 60_000));
      const signalId = await makeSignal(tokenId, triggeredAt, 400_000);

      await snapshotMarket(
        prisma,
        tokenId,
        { priceUsd: 1, marketCapUsd: 400_000, fdvUsd: 400_000, liquidityUsd: 80_000, vol5m: 0, vol1h: 0, vol6h: 0, vol24h: 0, holderCount: 50 },
        triggeredAt
      );
      await snapshotMarket(
        prisma,
        tokenId,
        { priceUsd: 1.1, marketCapUsd: 440_000, fdvUsd: 440_000, liquidityUsd: 80_000, vol5m: 0, vol1h: 0, vol6h: 0, vol24h: 0, holderCount: 50 },
        new Date(triggeredAt.getTime() + 90 * 60_000) // +90min, past M15/H1, well within H6/H24/D3/D7
      );

      // Real `now` (~2h after triggeredAt) — this is the repeatable-gate case:
      // NOT the seed's far-future pass (see seed.ts's own comment on why the
      // seed intentionally pins `now` past D7's end for every seeded signal;
      // this test instead exercises the genuinely-partial-window path that a
      // real worker tick hits on every backtestHours cadence).
      await runBacktestPass(prisma, {} as never, now);

      const results = await prisma.backtestResult.findMany({ where: { signalId } });
      const byHorizon = new Map(results.map((r) => [r.horizon, r] as const));

      // M15 (15min) and H1 (60min) windows have both fully elapsed as of `now`
      // (triggeredAt + 2h) — their notes should be null (no window_incomplete,
      // no synthetic marker since every snapshot here is source='ingest' default).
      expect(byHorizon.get('M15')?.notes).toBeNull();
      expect(byHorizon.get('H1')?.notes).toBeNull();

      // H6 (6h), H24 (24h), D3 (3d), D7 (7d) windows have NOT fully elapsed
      // yet as of `now` (only ~2h has passed) — each must carry
      // 'window_incomplete'.
      for (const horizon of ['H6', 'H24', 'D3', 'D7'] as const) {
        expect(byHorizon.get(horizon)?.notes).toContain('window_incomplete');
      }
    }
  );
});

describe('seedBacktestContinuation — defense-in-depth seed-only guard', () => {
  // These cases exercise the guard clauses at the TOP of the function body,
  // which throw before touching MockWorld or the database at all — no LITE
  // Postgres dependency, so this describe block is NOT gated by
  // describe.skipIf(dbReachable) like the suite above.

  it('throws when called without { allowSynthetic: true }', async () => {
    await expect(
      seedBacktestContinuation(new Map(), {} as MockWorld, { allowSynthetic: false })
    ).rejects.toThrow(/allowSynthetic/);
  });

  it("throws when process.env.MOCK_MODE === 'false', even with allowSynthetic: true", async () => {
    const original = process.env.MOCK_MODE;
    process.env.MOCK_MODE = 'false';
    try {
      await expect(
        seedBacktestContinuation(new Map(), {} as MockWorld, { allowSynthetic: true })
      ).rejects.toThrow(/MOCK_MODE/);
    } finally {
      if (original === undefined) delete process.env.MOCK_MODE;
      else process.env.MOCK_MODE = original;
    }
  });
});
