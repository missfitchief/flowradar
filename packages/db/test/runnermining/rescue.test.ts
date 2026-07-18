// FlowRadar — rescue-sprint tests: valuation backfill, golden cohort, replay.

import { describe, expect, it, afterAll, beforeEach } from 'vitest';
import net from 'node:net';
import { prisma } from '../../src/client';
import { backfillTradeValuations } from '../../src/runnermining/valuationBackfill';
import { buildGoldenCohort } from '../../src/runnermining/goldenCohort';
import { runNoLookaheadReplay } from '../../src/runnermining/replay';

const PREFIX = 'RESCU'; // base58-safe (no 0/O/I/l)

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
const T0sec = Math.floor(T0.getTime() / 1000);
const DAY = 86_400;
const at = (sec: number) => new Date(T0.getTime() + sec * 1000);
const addr = (s: string) => `${PREFIX}${s}`;

async function cleanup() {
  await prisma.replaySignalEvent.deleteMany({ where: { mint: { startsWith: PREFIX } } });
  await prisma.goldenCohortMember.deleteMany({ where: { key: { startsWith: PREFIX } } });
  await prisma.tokenTopPnlCandidate.deleteMany({ where: { mint: { startsWith: PREFIX } } });
  await prisma.addressDormancyObservation.deleteMany({ where: { walletAddress: { startsWith: PREFIX } } });
  await prisma.cohortMatch.deleteMany({ where: { runnerMint: { startsWith: PREFIX } } });
  await prisma.walletTokenTrade.deleteMany({ where: { txHash: { startsWith: PREFIX } } });
  await prisma.tokenMarketSnapshot.deleteMany({ where: { token: { address: { startsWith: PREFIX } } } });
  await prisma.tokenEnrichment.deleteMany({ where: { mint: { startsWith: PREFIX } } });
  await prisma.tokenLifecycle.deleteMany({ where: { mint: { startsWith: PREFIX } } });
  await prisma.wallet.deleteMany({ where: { address: { startsWith: PREFIX } } });
  await prisma.token.deleteMany({ where: { address: { startsWith: PREFIX } } });
}

let seq = 0;
async function seedToken(suffix: string, opts: { runner?: boolean; candles?: { t: number; c: number }[]; supply?: number } = {}) {
  const token = await prisma.token.create({
    data: { chain: 'SOLANA', address: addr(suffix), symbol: suffix, name: suffix, decimals: 9, firstSeenAt: T0, riskFlags: [] },
    select: { id: true, address: true }
  });
  if (opts.runner !== undefined) {
    await prisma.tokenLifecycle.create({
      data: {
        mint: token.address, enteredUniverseAt: T0, sourcesJson: {}, coverage: 'covered',
        runnerClass: opts.runner ? 'verified_above_10m' : 'insufficient_history', confidence: 'high', classifiedAt: T0
      }
    });
  }
  if (opts.candles) {
    await prisma.tokenEnrichment.create({
      data: {
        mint: token.address, provider: 'birdeye', status: 'enriched', confidence: 'medium',
        candleCount: opts.candles.length,
        candlesJson: opts.candles.map((c) => ({ t: c.t, o: c.c, h: c.c, l: c.c, c: c.c })),
        supplyJson: { supply: opts.supply ?? 1_000_000, source: 'current_supply_assumption' },
        receiptsJson: {}
      }
    });
  }
  return token;
}

async function seedWallet(suffix: string, status = 'observation_only') {
  const w = await prisma.wallet.create({
    data: { address: addr(suffix), chain: 'SOLANA', firstSeenAt: T0, lastActiveAt: T0, status: status as never },
    select: { id: true, address: true }
  });
  return w;
}

async function seedTrade(walletId: string, tokenId: string, action: 'BUY' | 'SELL', ts: Date, opts: { usd?: number; amountToken?: number } = {}) {
  seq += 1;
  return prisma.walletTokenTrade.create({
    data: {
      walletId, tokenId, chain: 'SOLANA', action, amountToken: String(opts.amountToken ?? 100),
      amountUsd: String(opts.usd ?? 0), txHash: addr(`TX${seq}`), blockOrSlot: 1n, ts,
      priceUsd: '0', marketCapAtTrade: '0', walletScoreAtTime: 50, provider: 'test'
    }
  });
}

beforeEach(async () => { if (dbReachable) await cleanup(); });
afterAll(async () => { if (!dbReachable) return; await cleanup(); await prisma.$disconnect(); });

describe.skipIf(!dbReachable)('backfillTradeValuations', () => {
  it('prices from prior snapshot first, then prior candle CLOSE; future candles never leak; unknown stays null', async () => {
    // Candle day 0 END at T0+1d; candle day 1 END at T0+2d.
    const tok = await seedToken('VTKA', { candles: [{ t: T0sec, c: 2 }, { t: T0sec + DAY, c: 10 }], supply: 1000 });
    const w = await seedWallet('VWA');
    // Trade 1: after candle-0 END -> priced from candle 0 close (2), NOT the
    // day-1 candle (10) even though its window contains the trade (no lookahead).
    const t1 = await seedTrade(w.id, tok.id, 'BUY', at(DAY + 3600), { amountToken: 50 });
    // Trade 2: within 1h after a snapshot -> snapshot price wins (higher fidelity).
    await prisma.tokenMarketSnapshot.create({
      data: {
        tokenId: tok.id, ts: at(DAY + 7000), priceUsd: '3', marketCapUsd: '3000', fdvUsd: '3000',
        liquidityUsd: '0', vol5m: '0', vol1h: '0', vol6h: '0', vol24h: '0', holderCount: 1
      }
    });
    const t2 = await seedTrade(w.id, tok.id, 'BUY', at(DAY + 7100), { amountToken: 10 });
    // Trade 3: BEFORE any candle END or snapshot -> stays unpriced (null).
    const t3 = await seedTrade(w.id, tok.id, 'BUY', at(100), { amountToken: 10 });
    // Trade 4: already priced -> never touched.
    const t4 = await seedTrade(w.id, tok.id, 'SELL', at(DAY + 3600), { usd: 777, amountToken: 1 });

    const r = await backfillTradeValuations(prisma, { chain: 'SOLANA', mints: [tok.address] });
    expect(r.errors).toBe(0);
    expect(r.backfilled).toBe(2);
    expect(r.unpriceable).toBe(1);

    const rows = new Map(
      (await prisma.walletTokenTrade.findMany({ where: { tokenId: tok.id }, select: { id: true, amountUsd: true, valuedUsd: true, valuationSource: true, marketCapAtTrade: true } }))
        .map((x) => [x.id, x])
    );
    expect(Number(rows.get(t1.id)!.amountUsd)).toBe(100); // 50 * candle0 close 2
    expect(rows.get(t1.id)!.valuationSource).toBe('birdeye_1d_prior_close');
    expect(Number(rows.get(t1.id)!.marketCapAtTrade)).toBe(2000); // 2 * supply 1000
    expect(Number(rows.get(t2.id)!.amountUsd)).toBe(30); // 10 * snapshot 3
    expect(rows.get(t2.id)!.valuationSource).toBe('prior_market_snapshot');
    expect(rows.get(t3.id)!.valuationSource).toBeNull();
    expect(Number(rows.get(t3.id)!.amountUsd)).toBe(0); // unknown stays unpriced
    expect(Number(rows.get(t4.id)!.amountUsd)).toBe(777); // untouched
    expect(rows.get(t4.id)!.valuationSource).toBeNull();

    // Idempotent: second run touches nothing.
    const r2 = await backfillTradeValuations(prisma, { chain: 'SOLANA', mints: [tok.address] });
    expect(r2.backfilled).toBe(0);
  });
});

describe.skipIf(!dbReachable)('buildGoldenCohort', () => {
  it('selects enriched runners with trades, local-evidence wallets, matched controls — deterministic with receipts', async () => {
    const runner = await seedToken('GTKA', { runner: true, candles: [{ t: T0sec, c: 1 }], supply: 1000 });
    await seedToken('GTKB', { runner: true }); // runner WITHOUT enrichment -> excluded
    const control = await seedToken('GCTA', {});
    await prisma.cohortMatch.create({
      data: { runnerMint: runner.address, controlMint: control.address, status: 'matched', tier: 'matched_tier2', featuresJson: {}, confidence: 'medium' }
    });
    const w = await seedWallet('GWA');
    await seedTrade(w.id, runner.id, 'BUY', at(10), { usd: 100 });
    await seedTrade(w.id, control.id, 'BUY', at(20), { usd: 100 });
    await prisma.tokenTopPnlCandidate.create({
      data: {
        chain: 'SOLANA', mint: runner.address, walletAddress: w.address, source: 'local_reconstruction',
        validation: 'incomplete', coverage: 'local_partial', confidence: 35, reasonCodes: [], receiptsJson: {}, caveats: [], engineVersion: 1
      }
    });

    const r = await buildGoldenCohort(prisma, { chain: 'SOLANA', tokenCount: 5, walletCount: 5, controlCount: 5 });
    expect(r.tokens).toBeGreaterThanOrEqual(1);
    expect(r.wallets).toBeGreaterThanOrEqual(1);
    expect(r.controls).toBeGreaterThanOrEqual(1);

    const rows = await prisma.goldenCohortMember.findMany({ where: { key: { startsWith: PREFIX } } });
    const kinds = new Map(rows.map((x) => [x.key, x.kind]));
    expect(kinds.get(runner.address)).toBe('token');
    expect(kinds.get(control.address)).toBe('control_token');
    expect(kinds.get(w.address)).toBe('wallet');
    expect(kinds.has(addr('GTKB'))).toBe(false); // unenriched runner excluded
    const tokenRow = rows.find((x) => x.key === runner.address)!;
    expect(tokenRow.reasonCodes.join(' ')).toContain('enriched_price_series');
  });
});

describe.skipIf(!dbReachable)('runNoLookaheadReplay', () => {
  it('signals at the SECOND independent buyer, uses only <=T evidence, records outcome separately', async () => {
    // Price series: day0 close 1 (END T0+1d), day5 close 100 (END T0+6d) -> big later run.
    const runner = await seedToken('RTKA', {
      runner: true,
      candles: [{ t: T0sec, c: 1 }, { t: T0sec + 5 * DAY, c: 100 }],
      supply: 1_000_000
    });
    const w1 = await seedWallet('RWA');
    const w2 = await seedWallet('RWB');
    // Priced buys: w1 joins at +1d2h, w2 at +1d3h (both after candle0 END).
    await seedTrade(w1.id, runner.id, 'BUY', at(DAY + 2 * 3600), { usd: 500 });
    await seedTrade(w2.id, runner.id, 'BUY', at(DAY + 3 * 3600), { usd: 500 });
    // Dormancy evidence for w1 anchored BEFORE its entry (pre-event by construction).
    await prisma.addressDormancyObservation.create({
      data: {
        chain: 'SOLANA', walletAddress: w1.address, eventKind: 'token_entry', anchorKey: runner.address,
        eventTs: at(DAY + 2 * 3600), overallClass: 'covered_dormant', meaningfulEventCount: 0,
        windowsJson: {}, receiptsJson: {}, caveats: [], coverageStartTs: T0, engineVersion: 1
      }
    });
    // Golden cohort rows (replay input).
    await prisma.goldenCohortMember.createMany({
      data: [
        { chain: 'SOLANA', kind: 'token', key: runner.address, rank: 1, selectionMetricsJson: {}, reasonCodes: [], engineVersion: 1, selectedAt: T0 },
        { chain: 'SOLANA', kind: 'wallet', key: w1.address, rank: 1, selectionMetricsJson: {}, reasonCodes: [], engineVersion: 1, selectedAt: T0 },
        { chain: 'SOLANA', kind: 'wallet', key: w2.address, rank: 2, selectionMetricsJson: {}, reasonCodes: [], engineVersion: 1, selectedAt: T0 }
      ]
    });

    const r = await runNoLookaheadReplay(prisma, { chain: 'SOLANA' });
    expect(r.errors).toBe(0);
    expect(r.signals).toBe(1);
    expect(r.byClassification.true_positive).toBe(1);

    const ev = await prisma.replaySignalEvent.findUniqueOrThrow({
      where: { chain_mint_eventKind: { chain: 'SOLANA', mint: runner.address, eventKind: 'signal' } }
    });
    // Signal fires when the SECOND independent entity joins (not the first).
    expect(ev.eventTs.getTime()).toBe(at(DAY + 3 * 3600).getTime());
    expect(ev.stateAtEvent).toBe('STEALTH_ACCUMULATION');
    expect(ev.independentEntitiesAtEvent).toBe(2);
    expect(ev.dormantReactivationsAtEvent).toBe(1);
    expect(ev.scoreAtEvent).toBeGreaterThan(0);
    // Outcome recorded separately: signal mcap = candle0 (1 * 1M), later max = 100 * 1M.
    expect(Number(ev.mcapAtSignalUsd)).toBe(1_000_000);
    expect(Number(ev.maxLaterMcapUsd)).toBe(100_000_000);
    expect(Number(ev.mcapD3Usd)).toBe(100_000_000); // first point >= T+3d is the day-5 candle END
    expect(ev.mcapD7Usd).toBeNull(); // no observation >= T+7d — null, never fabricated
  });

  it('control token with one buyer yields honest no_signal / true_negative', async () => {
    const control = await seedToken('RCTA', { candles: [{ t: T0sec, c: 1 }], supply: 1000 });
    const w1 = await seedWallet('RWC');
    await seedTrade(w1.id, control.id, 'BUY', at(DAY + 3600), { usd: 100 });
    await prisma.goldenCohortMember.createMany({
      data: [
        { chain: 'SOLANA', kind: 'control_token', key: control.address, rank: 1, selectionMetricsJson: {}, reasonCodes: [], engineVersion: 1, selectedAt: T0 },
        { chain: 'SOLANA', kind: 'wallet', key: w1.address, rank: 1, selectionMetricsJson: {}, reasonCodes: [], engineVersion: 1, selectedAt: T0 }
      ]
    });
    const r = await runNoLookaheadReplay(prisma, { chain: 'SOLANA' });
    expect(r.signals).toBe(0);
    expect(r.byClassification.true_negative).toBe(1);
    const ev = await prisma.replaySignalEvent.findUniqueOrThrow({
      where: { chain_mint_eventKind: { chain: 'SOLANA', mint: control.address, eventKind: 'no_signal' } }
    });
    expect(ev.stateAtEvent).toBe('WATCHING');
    expect(ev.classification).toBe('true_negative');
  });
});
