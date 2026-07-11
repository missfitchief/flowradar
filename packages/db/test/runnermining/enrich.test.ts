// FlowRadar — Birdeye enrichment worker tests (mocked fetch — never live).

import { describe, expect, it, afterAll, beforeEach } from 'vitest';
import net from 'node:net';
import { prisma } from '../../src/client';
import { enrichTokenHistory, enrichmentSeriesPoints } from '../../src/runnermining/enrich';

const PREFIX = 'RM2ENR';
const mint = (s: string) => `${PREFIX}${s}${'1'.repeat(Math.max(0, 40 - PREFIX.length - s.length))}`;

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

const DAY = 86_400;
const T0 = 1_750_000_000;

function mockFetch(byMint: Record<string, { candles?: { unixTime: number; o: number; h: number; l: number; c: number }[]; supply?: number | null; ohlcvHttp?: number }>): typeof fetch {
  return (async (url: string) => {
    const u = String(url);
    const address = /address=([^&]+)/.exec(u)?.[1] ?? '';
    const cfg = byMint[address] ?? {};
    if (u.includes('/defi/ohlcv')) {
      const http = cfg.ohlcvHttp ?? 200;
      if (http !== 200) return new Response('err', { status: http });
      return new Response(JSON.stringify({ success: true, data: { items: cfg.candles ?? [] } }), { status: 200 });
    }
    if (u.includes('/defi/token_overview')) {
      return new Response(JSON.stringify({ success: true, data: cfg.supply === null ? {} : { circulatingSupply: cfg.supply ?? 1_000_000 } }), { status: 200 });
    }
    return new Response('nf', { status: 404 });
  }) as typeof fetch;
}

async function cleanup() {
  await prisma.tokenEnrichment.deleteMany({ where: { mint: { startsWith: PREFIX } } });
}
beforeEach(async () => { if (dbReachable) await cleanup(); });
afterAll(async () => { if (!dbReachable) return; await cleanup(); await prisma.$disconnect(); });

describe.skipIf(!dbReachable)('enrichTokenHistory', () => {
  it('persists candles + labeled supply assumption + reconstructed ATH with receipts; resumable + idempotent', async () => {
    const candles = [
      { unixTime: T0, o: 1, h: 2, l: 0.5, c: 1.5 },
      { unixTime: T0 + DAY, o: 1.5, h: 15, l: 1, c: 12 }, // ATH day: 15 * 1M supply = 15M
      { unixTime: T0 + 2 * DAY, o: 12, h: 13, l: 8, c: 9 }
    ];
    const f = mockFetch({ [mint('A')]: { candles, supply: 1_000_000 } });
    const r1 = await enrichTokenHistory(prisma, { mints: [mint('A')], apiKey: 'test', paceMs: 1, fetchImpl: f });
    expect(r1.enriched).toBe(1);

    const row = await prisma.tokenEnrichment.findUnique({ where: { mint: mint('A') } });
    expect(row!.status).toBe('enriched');
    expect(Number(row!.athMcapUsd)).toBe(15_000_000);
    expect(row!.athTs!.getTime()).toBe((T0 + DAY) * 1000);
    expect(row!.confidence).toBe('medium'); // capped by supply assumption
    expect((row!.supplyJson as { source: string }).source).toBe('current_supply_assumption');
    expect((row!.receiptsJson as { requests: unknown[] }).requests.length).toBe(2);
    expect(row!.ohlcvStartTs!.getTime()).toBe(T0 * 1000); // earliest provable market ts

    // resumable/idempotent: second run skips (lastSuccessAt set), zero requests for it
    const r2 = await enrichTokenHistory(prisma, { mints: [mint('A')], apiKey: 'test', paceMs: 1, fetchImpl: f });
    expect(r2.skippedFresh).toBe(1);
    expect(r2.requestsUsed).toBe(0);
  });

  it('missing OHLCV / supply / provider failure are honest states, never zero', async () => {
    const f = mockFetch({
      [mint('NOC')]: { candles: [] },
      [mint('NOS')]: { candles: [{ unixTime: T0, o: 1, h: 2, l: 1, c: 1 }], supply: null },
      [mint('ERR')]: { ohlcvHttp: 500 }
    });
    const r = await enrichTokenHistory(prisma, { mints: [mint('NOC'), mint('NOS'), mint('ERR')], apiKey: 'test', paceMs: 1, fetchImpl: f });
    expect(r.noOhlcv).toBe(1);
    expect(r.noSupply).toBe(1);
    expect(r.providerErrors).toBe(1);
    const nos = await prisma.tokenEnrichment.findUnique({ where: { mint: mint('NOS') } });
    expect(nos!.athMcapUsd).toBeNull(); // no supply -> mcap NOT fabricated
    const err = await prisma.tokenEnrichment.findUnique({ where: { mint: mint('ERR') } });
    expect(err!.lastSuccessAt).toBeNull(); // provider_error is retryable, not success
    expect(err!.retryCount).toBe(1);
  });

  it('request budget is a hard bound (resumable next run)', async () => {
    const f = mockFetch({ [mint('B1')]: { candles: [], supply: 1 }, [mint('B2')]: { candles: [], supply: 1 } });
    const r = await enrichTokenHistory(prisma, { mints: [mint('B1'), mint('B2')], apiKey: 'test', paceMs: 1, maxRequests: 2, fetchImpl: f });
    expect(r.requestsUsed).toBeLessThanOrEqual(2);
    expect(r.attempted).toBe(1); // second mint deferred, not silently dropped
  });

  it('enrichmentSeriesPoints uses candle-END timestamps (no lookahead) and refuses missing supply', () => {
    const row = {
      candlesJson: [{ t: T0, o: 1, h: 2, l: 1, c: 1.5 }],
      supplyJson: { supply: 1000, source: 'current_supply_assumption' }
    };
    const pts = enrichmentSeriesPoints(row);
    expect(pts.length).toBe(1);
    expect(pts[0].ts.getTime()).toBe((T0 + DAY) * 1000); // END of the 1D candle
    expect(pts[0].marketCapUsd).toBe(2000); // HIGH x supply at candle END (conservative for entry bands)
    expect(enrichmentSeriesPoints({ candlesJson: row.candlesJson, supplyJson: { supply: null } })).toEqual([]);
  });
});
