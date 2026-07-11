// FlowRadar — stealth DB driver + persistence tests (Priority 2).
//
// The PURE engine (packages/core/src/stealth) is already approved; these
// tests cover the DB wiring: fetchStealthInputs cohort mapping over real
// rows, runStealthPass persistence, replay idempotency (same bucket ⇒ upsert,
// never a duplicate row), the engine's KOL-never-raises invariant surviving
// the integration, bounded token selection, and plain-English explanation +
// invalidation reasons. Runs against the ISOLATED test DB (flowradar_test).
import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import net from 'node:net';
import { prisma } from '../../src/client';
import { fetchStealthInputs, runStealthPass } from '../../src/stealth/runStealthPass';

const PREFIX = 'STLTEST';
const NOW = new Date('2026-07-11T12:00:00Z');
const MIN = 60_000;
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function addr(seed: number): string {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = (seed * 131 + i * 17 + 7) % 256;
  if (bytes[0] === 0) bytes[0] = 7;
  let acc = 0n;
  for (const b of bytes) acc = (acc << 8n) | BigInt(b);
  let out = '';
  while (acc > 0n) { out = BASE58[Number(acc % 58n)] + out; acc /= 58n; }
  return out;
}

function probePort(host: string, port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createConnection({ host, port });
    const done = (ok: boolean) => { s.removeAllListeners(); s.destroy(); resolve(ok); };
    s.setTimeout(timeoutMs); s.once('connect', () => done(true)); s.once('timeout', () => done(false)); s.once('error', () => done(false));
  });
}

async function cleanup() {
  await prisma.stealthSnapshot.deleteMany({ where: { token: { symbol: { startsWith: PREFIX } } } });
  await prisma.walletTokenTrade.deleteMany({ where: { token: { symbol: { startsWith: PREFIX } } } });
  await prisma.entityClusterWallet.deleteMany({ where: { wallet: { notes: PREFIX } } });
  await prisma.entityCluster.deleteMany({ where: { mainFundingSource: PREFIX } });
  await prisma.monitoringSubscription.deleteMany({ where: { wallet: { notes: PREFIX } } });
  await prisma.wallet.deleteMany({ where: { notes: PREFIX } });
  await prisma.token.deleteMany({ where: { symbol: { startsWith: PREFIX } } });
}

let seq = 0;
async function mkWallet(status: string, seed: number) {
  return prisma.wallet.create({
    data: { address: addr(seed), chain: 'SOLANA', firstSeenAt: NOW, lastActiveAt: NOW, status: status as never, notes: PREFIX },
    select: { id: true, address: true }
  });
}
async function mkToken(sym: string) {
  await prisma.chain.upsert({
    where: { id: 'SOLANA' },
    update: {},
    create: { id: 'SOLANA', name: 'Solana', nativeSymbol: 'SOL', explorerTxUrl: 'https://x/{hash}', explorerAddressUrl: 'https://x/{address}' }
  });
  return prisma.token.create({
    data: { chain: 'SOLANA', address: addr(9000 + seq), symbol: `${PREFIX}${sym}${seq++}`, name: sym, decimals: 9, firstSeenAt: new Date(NOW.getTime() - 48 * 3600_000), riskFlags: {} },
    select: { id: true }
  });
}
async function mkTrade(walletId: string, tokenId: string, action: 'BUY' | 'SELL', usd: number, minutesAgo: number) {
  return prisma.walletTokenTrade.create({
    data: {
      walletId, tokenId, chain: 'SOLANA', action, amountToken: usd, amountUsd: usd,
      txHash: `${PREFIX}tx${seq++}`, blockOrSlot: BigInt(1000 + seq), ts: new Date(NOW.getTime() - minutesAgo * MIN),
      priceUsd: 0.000001, marketCapAtTrade: 50_000, walletScoreAtTime: 0, provider: 'test'
    }
  });
}

const PORT_OPEN = await probePort('localhost', 5439);
const d = PORT_OPEN ? describe : describe.skip;

d('fetchStealthInputs (cohort mapping over real rows)', () => {
  beforeEach(cleanup);
  afterAll(async () => { await cleanup(); await prisma.$disconnect(); });

  it('maps statuses to cohorts, drops bot/excluded, computes fresh buyers and clusters per window', async () => {
    const token = await mkToken('MAP');
    const eligible = await mkWallet('signal_eligible', 1);
    const obs = await mkWallet('observation_only', 2);
    const kol = await mkWallet('public_kol', 3);
    const promoter = await mkWallet('public_promoter', 4);
    const copy = await mkWallet('copytrader', 5);
    const bot = await mkWallet('bot_or_service', 6);
    // Cluster: eligible + obs share one entity.
    const cluster = await prisma.entityCluster.create({
      data: { confidence: 0.9, walletCount: 2, total30dPnlUsd: 0, chains: ['SOLANA'], evidence: {}, mainFundingSource: PREFIX }
    });
    for (const w of [eligible, obs]) {
      await prisma.entityClusterWallet.create({ data: { clusterId: cluster.id, walletId: w.id, linkConfidence: 0.9, evidence: {} } });
    }
    // Trades: eligible buys 10m ago (first-ever), obs buys 3m ago, kol buys
    // 2m ago, promoter sells 2m ago, copy buys 20m ago, bot buys 1m ago
    // (must be dropped). Eligible also bought 20h ago (so NOT fresh in 1h).
    await mkTrade(eligible.id, token.id, 'BUY', 1000, 20 * 60);
    await mkTrade(eligible.id, token.id, 'BUY', 2000, 10);
    await mkTrade(obs.id, token.id, 'BUY', 500, 3);
    await mkTrade(kol.id, token.id, 'BUY', 900, 2);
    await mkTrade(promoter.id, token.id, 'SELL', 400, 2);
    await mkTrade(copy.id, token.id, 'BUY', 300, 20);
    await mkTrade(bot.id, token.id, 'BUY', 99999, 1);

    const inputs = await fetchStealthInputs(prisma, { now: NOW, tokenLimit: 10 });
    expect(inputs).toHaveLength(1);
    const input = inputs[0]!;
    expect(input.tokenId).toBe(token.id);

    const w24 = input.windows.find((w) => w.window === '24h')!;
    expect(w24.eligible.distinctBuyers).toBe(1);
    expect(w24.eligible.buyUsd).toBe(3000);
    // Eligible's FIRST-EVER buy is 20h ago — inside 24h ⇒ fresh in 24h…
    expect(w24.eligible.freshBuyers).toBe(1);
    expect(w24.observation.distinctBuyers).toBe(1);
    expect(w24.publicKol.distinctBuyers).toBe(1); // kol buy
    expect(w24.publicKol.distinctSellers).toBe(1); // promoter sell (public cohort)
    expect(w24.crowd.distinctBuyers).toBe(1); // copytrader
    // bot_or_service NEVER appears in any cohort.
    const totalBuyUsd = w24.eligible.buyUsd + w24.observation.buyUsd + w24.publicKol.buyUsd + w24.crowd.buyUsd;
    expect(totalBuyUsd).toBe(3000 + 500 + 900 + 300);

    const w1h = input.windows.find((w) => w.window === '1h')!;
    // …but NOT fresh in 1h (first-ever buy was 20h ago).
    expect(w1h.eligible.freshBuyers).toBe(0);
    expect(w1h.eligible.distinctBuyers).toBe(1);
    expect(w1h.crowd.distinctBuyers).toBe(1); // copytrader bought 20m ago — inside 1h
    const w15 = input.windows.find((w) => w.window === '15m')!;
    expect(w15.crowd.distinctBuyers).toBe(0); // …but outside 15m
  });

  it('entity clusters collapse buyers: two clustered eligible buyers = 1 distinct cluster', async () => {
    const token = await mkToken('CLU');
    const a = await mkWallet('signal_eligible', 11);
    const b = await mkWallet('signal_eligible', 12);
    const c = await mkWallet('signal_eligible', 13); // unclustered = own entity
    const cluster = await prisma.entityCluster.create({
      data: { confidence: 0.9, walletCount: 2, total30dPnlUsd: 0, chains: ['SOLANA'], evidence: {}, mainFundingSource: PREFIX }
    });
    for (const w of [a, b]) {
      await prisma.entityClusterWallet.create({ data: { clusterId: cluster.id, walletId: w.id, linkConfidence: 0.9, evidence: {} } });
    }
    for (const w of [a, b, c]) await mkTrade(w.id, token.id, 'BUY', 1000, 5);
    const [input] = await fetchStealthInputs(prisma, { now: NOW, tokenLimit: 10 });
    const w24 = input!.windows.find((w) => w.window === '24h')!;
    expect(w24.eligible.distinctBuyers).toBe(3);
    expect(w24.eligible.distinctClusters).toBe(2); // {a,b} + {c}
  });

  it('is bounded: tokenLimit caps the token set (most-recent activity first)', async () => {
    const t1 = await mkToken('B1');
    const t2 = await mkToken('B2');
    const w = await mkWallet('observation_only', 21);
    await mkTrade(w.id, t1.id, 'BUY', 100, 300); // older activity
    await mkTrade(w.id, t2.id, 'BUY', 100, 1); // newest activity
    const inputs = await fetchStealthInputs(prisma, { now: NOW, tokenLimit: 1 });
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.tokenId).toBe(t2.id);
  });
});

d('runStealthPass (persistence + idempotency + invariants)', () => {
  beforeEach(cleanup);
  afterAll(async () => { await cleanup(); await prisma.$disconnect(); });

  it('persists a snapshot with state, shadow score, metrics, plain-English explanation', async () => {
    const token = await mkToken('PER');
    // 4 independent eligible buyers, net inflow, no public/crowd -> EARLY_INDEPENDENT_CONFIRMATION.
    for (let i = 0; i < 4; i++) {
      const w = await mkWallet('signal_eligible', 30 + i);
      await mkTrade(w.id, token.id, 'BUY', 10_000, 10 + i);
    }
    const res = await runStealthPass(prisma, { now: NOW, tokenLimit: 10, bucketSec: 300 });
    expect(res.tokensEvaluated).toBe(1);
    expect(res.snapshotsWritten).toBe(1);
    const snap = await prisma.stealthSnapshot.findFirst({ where: { tokenId: token.id } });
    expect(snap!.state).toBe('EARLY_INDEPENDENT_CONFIRMATION');
    expect(snap!.stealthScore).toBeGreaterThan(0);
    expect(snap!.explanation.length).toBeGreaterThan(40); // real prose, not a code
    expect(snap!.explanation).not.toMatch(/undefined|NaN/);
    expect((snap!.metrics as { eligibleBuyers24h?: number }).eligibleBuyers24h).toBe(4);
  });

  it('REPLAY IDEMPOTENT: same bucket re-run upserts — exactly one row, no duplicates', async () => {
    const token = await mkToken('IDe');
    const w = await mkWallet('signal_eligible', 40);
    await mkTrade(w.id, token.id, 'BUY', 5000, 5);
    await runStealthPass(prisma, { now: NOW, tokenLimit: 10, bucketSec: 300 });
    await runStealthPass(prisma, { now: NOW, tokenLimit: 10, bucketSec: 300 });
    await runStealthPass(prisma, { now: new Date(NOW.getTime() + 60_000), tokenLimit: 10, bucketSec: 300 }); // same 5m bucket
    expect(await prisma.stealthSnapshot.count({ where: { tokenId: token.id } })).toBe(1);
    // A NEW bucket adds a second row and records the state transition chain.
    const res = await runStealthPass(prisma, { now: new Date(NOW.getTime() + 6 * 60_000), tokenLimit: 10, bucketSec: 300 });
    expect(res.snapshotsWritten).toBe(1);
    expect(await prisma.stealthSnapshot.count({ where: { tokenId: token.id } })).toBe(2);
    const latest = await prisma.stealthSnapshot.findFirst({ where: { tokenId: token.id }, orderBy: { bucketTs: 'desc' } });
    expect(latest!.previousState).not.toBeNull();
  });

  it('INVARIANT: public-KOL arrival flips state but NEVER raises the shadow score', async () => {
    const tokenA = await mkToken('KOLa');
    const tokenB = await mkToken('KOLb');
    // Identical eligible base on both tokens…
    for (let i = 0; i < 3; i++) {
      const w1 = await mkWallet('signal_eligible', 50 + i);
      const w2 = await mkWallet('signal_eligible', 60 + i);
      await mkTrade(w1.id, tokenA.id, 'BUY', 8000, 15 + i);
      await mkTrade(w2.id, tokenB.id, 'BUY', 8000, 15 + i);
    }
    // …tokenB additionally gets heavy public-KOL buying.
    for (let i = 0; i < 3; i++) {
      const k = await mkWallet('public_kol', 70 + i);
      await mkTrade(k.id, tokenB.id, 'BUY', 50_000, 5 + i);
    }
    await runStealthPass(prisma, { now: NOW, tokenLimit: 10, bucketSec: 300 });
    const a = await prisma.stealthSnapshot.findFirst({ where: { tokenId: tokenA.id } });
    const b = await prisma.stealthSnapshot.findFirst({ where: { tokenId: tokenB.id } });
    expect(b!.state).toBe('PUBLIC_KOL_ARRIVAL');
    expect(b!.stealthScore).toBeLessThanOrEqual(a!.stealthScore); // never raised
    expect((b!.invalidationReasons as string[]).length).toBeGreaterThan(0); // arrival carries risk prose
  });

  it('DISTRIBUTION_RISK carries plain-English invalidation reasons', async () => {
    const token = await mkToken('RISK');
    for (let i = 0; i < 3; i++) {
      const w = await mkWallet('signal_eligible', 80 + i);
      await mkTrade(w.id, token.id, 'BUY', 10_000, 60 + i);
      await mkTrade(w.id, token.id, 'SELL', 7_000, 5 + i); // heavy early-cohort selling
    }
    await runStealthPass(prisma, { now: NOW, tokenLimit: 10, bucketSec: 300 });
    const snap = await prisma.stealthSnapshot.findFirst({ where: { tokenId: token.id } });
    expect(snap!.state).toBe('DISTRIBUTION_RISK');
    const reasons = snap!.invalidationReasons as string[];
    expect(reasons.length).toBeGreaterThan(0);
    expect(reasons.join(' ')).toMatch(/sell|distribut/i);
  });

  it('fresh-funded-receiver evidence is persisted when a hot receiver buys', async () => {
    const token = await mkToken('FRSH');
    const receiver = await mkWallet('observation_only', 90);
    const root = await prisma.wallet.create({
      data: { address: addr(91), chain: 'SOLANA', firstSeenAt: NOW, lastActiveAt: NOW, status: 'observation_only', notes: PREFIX },
      select: { id: true }
    });
    const lineageRoot = await prisma.lineageRoot.create({
      data: { walletId: root.id, source: 'test', permanent: true, firstImportedAt: NOW, lastSeenInImportAt: NOW }
    });
    await prisma.monitoringSubscription.create({
      data: { walletId: receiver.id, priority: 'fresh_receiver_hot', reason: 'test', lineageRootId: lineageRoot.id, tierPriority: 0 }
    });
    await mkTrade(receiver.id, token.id, 'BUY', 2000, 5);
    await runStealthPass(prisma, { now: NOW, tokenLimit: 10, bucketSec: 300 });
    const snap = await prisma.stealthSnapshot.findFirst({ where: { tokenId: token.id } });
    expect((snap!.evidence as { freshFundedReceiverBuyers?: number }).freshFundedReceiverBuyers).toBe(1);
    // cleanup lineage extras
    await prisma.monitoringSubscription.deleteMany({ where: { lineageRootId: lineageRoot.id } });
    await prisma.lineageRoot.delete({ where: { id: lineageRoot.id } });
  });

  it('a pass over ZERO active tokens is an honest no-op', async () => {
    const res = await runStealthPass(prisma, { now: NOW, tokenLimit: 10, bucketSec: 300 });
    expect(res.tokensEvaluated).toBe(0);
    expect(res.snapshotsWritten).toBe(0);
  });

  it('SELL-ONLY eligible flow (Infinity ratio) persists cleanly with non-finite -> null (Codex #1)', async () => {
    const token = await mkToken('INF');
    const w = await mkWallet('signal_eligible', 95);
    await mkTrade(w.id, token.id, 'SELL', 5000, 5); // sell with zero buys => ratio Infinity in-memory
    const res = await runStealthPass(prisma, { now: NOW, tokenLimit: 10, bucketSec: 300 });
    expect(res.errors).toBe(0);
    expect(res.snapshotsWritten).toBe(1);
    const snap = await prisma.stealthSnapshot.findFirst({ where: { tokenId: token.id } });
    const m = snap!.metrics as { eligibleSellToBuyRatio24h?: number | null };
    expect(m.eligibleSellToBuyRatio24h).toBeNull(); // honest unknown, never a coerced number
    expect(snap!.explanation).not.toMatch(/Infinity|NaN|undefined/);
  });

  it('OUT-OF-ORDER buckets: writing an earlier bucket repairs the successor transition chain (Codex #4)', async () => {
    const token = await mkToken('OOO');
    const w = await mkWallet('signal_eligible', 96);
    await mkTrade(w.id, token.id, 'BUY', 5000, 2);
    const later = new Date(NOW.getTime() + 10 * 60_000);
    await runStealthPass(prisma, { now: later, tokenLimit: 10, bucketSec: 300 }); // bucket N+2 first
    await runStealthPass(prisma, { now: NOW, tokenLimit: 10, bucketSec: 300 }); // then bucket N
    const rows = await prisma.stealthSnapshot.findMany({ where: { tokenId: token.id }, orderBy: { bucketTs: 'asc' } });
    expect(rows).toHaveLength(2);
    expect(rows[1]!.previousState).toBe(rows[0]!.state); // chain repaired
  });

  it('retention prune: snapshots older than 14 days are removed by the pass', async () => {
    const token = await mkToken('OLD');
    const w = await mkWallet('signal_eligible', 97);
    await mkTrade(w.id, token.id, 'BUY', 5000, 2);
    const ancient = new Date(NOW.getTime() - 20 * 24 * 3600_000);
    await prisma.stealthSnapshot.create({
      data: {
        tokenId: token.id, chain: 'SOLANA', state: 'WATCHING', stateChanged: false, stealthScore: 0,
        metrics: {}, evidence: {}, explanation: 'old', invalidationReasons: [], bucketTs: ancient, computedAt: ancient
      }
    });
    await runStealthPass(prisma, { now: NOW, tokenLimit: 10, bucketSec: 300 });
    expect(await prisma.stealthSnapshot.count({ where: { tokenId: token.id, bucketTs: ancient } })).toBe(0);
  });
});
