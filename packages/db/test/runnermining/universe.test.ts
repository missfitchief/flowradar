// FlowRadar — runner-mining universe/cohort/entry builder tests (RM Tasks 1-4 DB).

import { describe, expect, it, afterAll, beforeEach } from 'vitest';
import net from 'node:net';
import { prisma } from '../../src/client';
import { buildTokenUniverse, classifyRunnerCohort, buildControlMatches, extractEarlyBuyers } from '../../src/runnermining/universe';

const PREFIX = 'RM1UN'; // base58-safe (no 0/O/I/l)

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
const T0 = new Date('2026-07-01T00:00:00Z');

// Base58-valid mint bodies (PREFIX itself is base58-safe).
function mint(suffix: string): string {
  return `${PREFIX}${suffix}${'1'.repeat(Math.max(0, 40 - PREFIX.length - suffix.length))}`;
}

async function cleanup() {
  await prisma.earlyBuyerEntry.deleteMany({ where: { mint: { startsWith: PREFIX } } });
  await prisma.cohortMatch.deleteMany({ where: { runnerMint: { startsWith: PREFIX } } });
  await prisma.tokenLifecycle.deleteMany({ where: { mint: { startsWith: PREFIX } } });
  await prisma.tokenMarketSnapshot.deleteMany({ where: { token: { address: { startsWith: PREFIX } } } });
  await prisma.walletTokenTrade.deleteMany({ where: { txHash: { startsWith: PREFIX } } });
  await prisma.wallet.deleteMany({ where: { address: { startsWith: PREFIX } } });
  await prisma.token.deleteMany({ where: { address: { startsWith: PREFIX } } });
}

async function seedToken(suffix: string, opts: { chain?: 'SOLANA' | 'BSC'; mcaps?: [number, number][]; tradeMcaps?: [number, number][]; firstSeenHoursBeforeSeries?: number; launchAnchored?: boolean } = {}) {
  const address = mint(suffix);
  const seriesStart = T0.getTime();
  const firstSeenAt = new Date(seriesStart - (opts.firstSeenHoursBeforeSeries ?? 0) * 3600_000);
  const token = await prisma.token.create({
    data: {
      chain: opts.chain ?? 'SOLANA', address, symbol: suffix.slice(0, 8), name: suffix, decimals: 9, firstSeenAt, riskFlags: [],
      // PROVEN launch time only when the fixture is explicitly launch-anchored
      tokenCreatedAt: opts.launchAnchored ? new Date(seriesStart) : null
    }
  });
  for (const [hours, mcap] of opts.mcaps ?? []) {
    await prisma.tokenMarketSnapshot.create({
      data: {
        tokenId: token.id, ts: new Date(seriesStart + hours * 3600_000), priceUsd: 1, marketCapUsd: mcap,
        fdvUsd: mcap, liquidityUsd: 10_000, vol5m: 0, vol1h: 0, vol6h: 0, vol24h: 0, holderCount: 10, source: 'test'
      }
    });
  }
  if (opts.tradeMcaps && opts.tradeMcaps.length > 0) {
    const wallet = await prisma.wallet.upsert({
      where: { address_chain: { address: `${PREFIX}W1${'1'.repeat(20)}`, chain: 'SOLANA' } },
      create: { address: `${PREFIX}W1${'1'.repeat(20)}`, chain: 'SOLANA', firstSeenAt: T0, lastActiveAt: T0 },
      update: {},
      select: { id: true }
    });
    let i = 0;
    for (const [hours, mcap] of opts.tradeMcaps) {
      i += 1;
      await prisma.walletTokenTrade.create({
        data: {
          walletId: wallet.id, tokenId: token.id, chain: 'SOLANA', action: 'BUY', amountToken: '10', amountUsd: '100',
          txHash: `${PREFIX}TX${suffix}${i}`, blockOrSlot: BigInt(i), ts: new Date(seriesStart + hours * 3600_000),
          priceUsd: '1', marketCapAtTrade: String(mcap), walletScoreAtTime: 50, provider: 'test'
        }
      });
    }
  }
  return token;
}

beforeEach(async () => {
  if (dbReachable) await cleanup();
});

afterAll(async () => {
  if (!dbReachable) return;
  await cleanup();
  await prisma.$disconnect();
});

describe.skipIf(!dbReachable)('runner-mining builders (Tasks 1-4)', () => {
  it('Task 1: builds the universe deterministically + idempotently, with honest coverage + resume cursor', async () => {
    await seedToken('CVRD', { mcaps: [[0, 50_000], [1, 80_000], [2, 60_000]] });
    await seedToken('PART', { mcaps: [[0, 40_000]] });
    await seedToken('NDAT', {});

    const r1 = await buildTokenUniverse(prisma, { batchSize: 500, now: T0, mintPrefix: PREFIX });
    expect(r1.errors).toBe(0);
    const mine = await prisma.tokenLifecycle.findMany({ where: { mint: { startsWith: PREFIX } } });
    expect(mine.length).toBe(3);
    const byMint = Object.fromEntries(mine.map((m) => [m.mint, m]));
    expect(byMint[mint('CVRD')].coverage).toBe('covered');
    expect(byMint[mint('PART')].coverage).toBe('partially_covered');
    expect(byMint[mint('NDAT')].coverage).toBe('unavailable'); // unknown stays unknown, never discarded
    expect((byMint[mint('CVRD')].sourcesJson as { local: { marketSnapshots: number } }).local.marketSnapshots).toBe(3); // provenance queryable

    // idempotent rerun: no duplicates, no new rows for the same mints
    const r2 = await buildTokenUniverse(prisma, { batchSize: 500, now: new Date(T0.getTime() + 1000), mintPrefix: PREFIX });
    const after = await prisma.tokenLifecycle.count({ where: { mint: { startsWith: PREFIX } } });
    expect(after).toBe(3);
    expect(r2.created).toBe(0);

    // bounded resume: batchSize 1 processes exactly one and hands back a cursor
    await cleanup();
    await seedToken('AAA', { mcaps: [[0, 10_000], [1, 12_000], [2, 9_000]] });
    await seedToken('BBB', { mcaps: [[0, 10_000], [1, 12_000], [2, 9_000]] });
    const page1 = await buildTokenUniverse(prisma, { batchSize: 1, mintPrefix: PREFIX });
    expect(page1.scanned).toBe(1);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await buildTokenUniverse(prisma, { batchSize: 1, cursor: page1.nextCursor, mintPrefix: PREFIX });
    expect(page2.scanned).toBe(1);
  });

  it('Task 1: BSC tokens never enter the Solana universe (hard rule 21; also kills cross-chain mint collisions)', async () => {
    await seedToken('EVMSD', { chain: 'BSC', mcaps: [[0, 99_000_000]] });
    const r = await buildTokenUniverse(prisma, { batchSize: 500, mintPrefix: PREFIX });
    expect(r.scanned).toBe(0); // the scan itself is SOLANA-only
    const row = await prisma.tokenLifecycle.findUnique({ where: { mint: mint('EVMSD') } });
    expect(row).toBeNull(); // no lifecycle row for EVM tokens — chain-scoped exclusion, not silent data mixing
  });

  it('Task 2: classifies runners vs non-runners with the anchoring asymmetry + receipts', async () => {
    // runner: observed >= $10M mid-series (not anchored — still verified above)
    await seedToken('RUNNER', { mcaps: [[0, 500_000], [1, 15_000_000], [2, 8_000_000]], firstSeenHoursBeforeSeries: 48 });
    // non-runner: anchored at launch (firstSeen == series start), never above 100k
    await seedToken('CTRL', { mcaps: [[0, 40_000], [1, 90_000], [2, 50_000]], launchAnchored: true });
    // unanchored low series: must be insufficient, NOT below
    await seedToken('WNDW', { mcaps: [[0, 30_000], [1, 35_000], [2, 33_000]], firstSeenHoursBeforeSeries: 72 });

    await buildTokenUniverse(prisma, { batchSize: 500, mintPrefix: PREFIX });
    const rep = await classifyRunnerCohort(prisma, { batchSize: 500, now: T0, mintPrefix: PREFIX });
    expect(rep.errors).toBe(0);

    const rows = Object.fromEntries((await prisma.tokenLifecycle.findMany({ where: { mint: { startsWith: PREFIX } } })).map((r) => [r.mint, r]));
    expect(rows[mint('RUNNER')].runnerClass).toBe('verified_above_10m');
    expect(Number(rows[mint('RUNNER')].athMcapUsd)).toBe(15_000_000);
    expect(rows[mint('RUNNER')].athTs).not.toBeNull();
    expect((rows[mint('RUNNER')].evidenceJson as { reasons: string[] }).reasons.join(' ')).toMatch(/observed historical mcap/);
    expect(rows[mint('CTRL')].runnerClass).toBe('verified_below_10m');
    expect(rows[mint('WNDW')].runnerClass).toBe('insufficient_history'); // survivorship honesty

    // idempotent rerun
    await classifyRunnerCohort(prisma, { batchSize: 500, now: new Date(T0.getTime() + 5000), mintPrefix: PREFIX });
    expect(await prisma.tokenLifecycle.count({ where: { mint: { startsWith: PREFIX } } })).toBe(3);
  });

  it('Tasks 3-4: deterministic control match + early-buyer entries with honest confidence', async () => {
    await seedToken('RUN2', {
      mcaps: [[0, 45_000], [1, 20_000_000], [2, 9_000_000]],
      tradeMcaps: [[0, 44_000], [0.5, 15_000], [1.5, 60_000]], // consistent with snapshots at overlap (conflict detector verified separately)
      launchAnchored: true
    });
    await seedToken('CTL2', {
      mcaps: [[0, 45_000], [1, 70_000], [2, 60_000]], // t0 prior valuation 45k -> in-band
      tradeMcaps: [[0.5, 49_000]], // strictly-prior snapshot exists at t0 (50k) -> band 20k_to_50k
      launchAnchored: true
    });

    await buildTokenUniverse(prisma, { batchSize: 500, mintPrefix: PREFIX });
    await classifyRunnerCohort(prisma, { batchSize: 500, mintPrefix: PREFIX });
    const mrep = await buildControlMatches(prisma, { mintPrefix: PREFIX });
    expect(mrep.runners).toBeGreaterThanOrEqual(1);

    const match = await prisma.cohortMatch.findUnique({ where: { runnerMint: mint('RUN2') } });
    expect(match).not.toBeNull();
    expect(match!.controlMint).toBe(mint('CTL2'));
    expect(match!.status).toBe('matched_tier1');
    expect(match!.confidence).not.toBe('high'); // local features only — bias recorded, never overclaimed

    const erep = await extractEarlyBuyers(prisma, { maxMints: 10 });
    // NO-LOOKAHEAD: bands come from the nearest STRICTLY-PRIOR snapshot, so
    // the t=0 trades (no prior observation) are UNKNOWN and skipped; the
    // 0.5h trades value against the t0 snapshots (45k/50k -> 20k_to_50k);
    // the 1.5h trade values against the 1h snapshot (20M -> out of band).
    expect(erep.entriesPersisted).toBe(2);
    expect(erep.unknownMcapSkipped).toBe(1); // only the t=0 trade lacks a strictly-prior observation
    const entries = await prisma.earlyBuyerEntry.findMany({ where: { mint: mint('RUN2') }, orderBy: { buyerRank: 'asc' } });
    expect(entries.map((e) => e.band)).toEqual(['20k_to_50k']);
    expect(entries[0].buyerRank).toBe(1); // distinct-wallet rank (add-ons reuse it)
    expect((entries[0].sourceJson as { valuationStatus: string }).valuationStatus).toBe('nearest_prior_snapshot');
    expect(entries.every((e) => e.confidence === 'low')).toBe(true); // pre-trade completeness unproven

    // rerun idempotency: unique (mint, tx, wallet) — nothing duplicated
    const erep2 = await extractEarlyBuyers(prisma, { maxMints: 10 });
    expect(erep2.entriesPersisted).toBe(0);
    expect(await prisma.earlyBuyerEntry.count({ where: { mint: { startsWith: PREFIX } } })).toBe(erep.entriesPersisted);
  });
});
