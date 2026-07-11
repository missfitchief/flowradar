// FlowRadar — monitoring scheduler integration tests (Wave C).
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import net from 'node:net';
import { runMonitoringScheduler } from '../../src/lineage/runMonitoringScheduler';
import { prisma } from '../../src/client';

const PREFIX = 'SCHEDTEST';
const NOW = new Date('2026-07-10T12:00:00Z');

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
let dbReachable = false;
beforeAll(async () => { dbReachable = await probePort('localhost', 5439); });

async function cleanup() {
  await prisma.monitoringSubscription.deleteMany({ where: { wallet: { address: { startsWith: PREFIX } } } });
  await prisma.wallet.deleteMany({ where: { address: { startsWith: PREFIX } } });
}
afterAll(async () => { if (!dbReachable) return; await cleanup(); await prisma.$disconnect(); });
beforeEach(async () => { if (!dbReachable) return; await cleanup(); });

const RANK: Record<string, number> = { fresh_receiver_hot: 0, root_permanent: 1, strong_link: 2, probable_link: 3, standard: 4, weak_cold: 5, cold_archive: 6 };
async function makeSub(suffix: string, over: { priority?: string; nextPollAt?: Date | null; claimedAt?: Date | null; hotUntil?: Date | null; consecutiveErrors?: number; active?: boolean } = {}) {
  const w = await prisma.wallet.create({ data: { address: `${PREFIX}_${suffix}`, chain: 'SOLANA', firstSeenAt: NOW, lastActiveAt: NOW, status: 'observation_only' } });
  const priority = over.priority ?? 'probable_link';
  return prisma.monitoringSubscription.create({
    data: {
      walletId: w.id,
      priority: priority as never,
      tierPriority: RANK[priority] ?? 99,
      active: over.active ?? true,
      reason: 'test',
      nextPollAt: over.nextPollAt === undefined ? null : over.nextPollAt,
      claimedAt: over.claimedAt ?? null,
      hotUntil: over.hotUntil ?? null,
      consecutiveErrors: over.consecutiveErrors ?? 0
    }
  });
}

describe.skipIf(!(await probePort('localhost', 5439)))('runMonitoringScheduler', () => {
  it('polls DUE subscriptions in priority order and advances nextPollAt', async () => {
    await makeSub('weak', { priority: 'weak_cold', nextPollAt: null });
    await makeSub('root', { priority: 'root_permanent', nextPollAt: null });
    const order: string[] = [];
    const res = await runMonitoringScheduler(prisma, { now: NOW, walletAddressStartsWith: PREFIX, poll: async (c) => { order.push(c.tier); return { ok: true }; } });
    expect(res.polled).toBe(2);
    expect(order[0]).toBe('root_permanent'); // higher priority first
    const subs = await prisma.monitoringSubscription.findMany({ where: { wallet: { address: { startsWith: PREFIX } } } });
    for (const s of subs) expect(s.nextPollAt).not.toBeNull(); // advanced
  });

  it('STRICT tier order across the enum migration-order gap (standard vs strong_link)', async () => {
    // The DB enum on-disk order puts standard/weak_cold BEFORE strong/probable
    // (migration order), so this only passes if ordering uses tierPriority.
    await makeSub('t_standard', { priority: 'standard', nextPollAt: null });
    await makeSub('t_strong', { priority: 'strong_link', nextPollAt: null });
    const order: string[] = [];
    await runMonitoringScheduler(prisma, { now: NOW, walletAddressStartsWith: PREFIX, poll: async (c) => { order.push(c.tier); return { ok: true }; } });
    expect(order.indexOf('strong_link')).toBeLessThan(order.indexOf('standard')); // strong (rank 2) before standard (rank 4)
  });

  it('respects the request BUDGET and reports exhaustion', async () => {
    for (let i = 0; i < 5; i++) await makeSub(`b${i}`, { nextPollAt: null });
    const res = await runMonitoringScheduler(prisma, { now: NOW, requestBudget: 2, walletAddressStartsWith: PREFIX, poll: async () => ({ ok: true }) });
    expect(res.polled).toBe(2);
    expect(res.budgetExhausted).toBe(true);
  });

  it('does NOT poll a subscription whose nextPollAt is in the future', async () => {
    await makeSub('future', { nextPollAt: new Date(NOW.getTime() + 3600_000) });
    const res = await runMonitoringScheduler(prisma, { now: NOW, walletAddressStartsWith: PREFIX, poll: async () => ({ ok: true }) });
    expect(res.polled).toBe(0);
  });

  it('reclaims a STALE claim and re-polls it', async () => {
    await makeSub('stale', { nextPollAt: null, claimedAt: new Date(NOW.getTime() - 3600_000) });
    const res = await runMonitoringScheduler(prisma, { now: NOW, walletAddressStartsWith: PREFIX, poll: async () => ({ ok: true }) });
    expect(res.reclaimed).toBeGreaterThanOrEqual(1);
    expect(res.polled).toBe(1);
  });

  it('does NOT double-claim a freshly-claimed (non-stale) subscription', async () => {
    await makeSub('fresh', { nextPollAt: null, claimedAt: new Date(NOW.getTime() - 10_000) }); // within stale window
    const res = await runMonitoringScheduler(prisma, { now: NOW, walletAddressStartsWith: PREFIX, poll: async () => ({ ok: true }) });
    expect(res.polled).toBe(0); // claimed, not stale => skipped
  });

  it('EXPIRES fresh_receiver_hot past hotUntil to probable_link', async () => {
    const sub = await makeSub('hot', { priority: 'fresh_receiver_hot', hotUntil: new Date(NOW.getTime() - 1000), nextPollAt: null });
    const res = await runMonitoringScheduler(prisma, { now: NOW, walletAddressStartsWith: PREFIX, poll: async () => ({ ok: true }) });
    expect(res.hotExpired).toBeGreaterThanOrEqual(1);
    const after = await prisma.monitoringSubscription.findUnique({ where: { id: sub.id } });
    expect(after!.priority).toBe('probable_link');
  });

  it('applies BACKOFF on a failing poll and isolates one failure', async () => {
    const bad = await makeSub('bad', { nextPollAt: null });
    await makeSub('good', { nextPollAt: null });
    const res = await runMonitoringScheduler(prisma, { now: NOW, walletAddressStartsWith: PREFIX, poll: async (c) => ({ ok: !c.walletAddress.endsWith('_bad') }) });
    expect(res.polled).toBe(2); // both processed despite one failing
    expect(res.pollErrors).toBe(1);
    const after = await prisma.monitoringSubscription.findUnique({ where: { id: bad.id } });
    expect(after!.consecutiveErrors).toBe(1);
  });

  it('a THROWN poll error is isolated, increments consecutiveErrors and advances nextPollAt', async () => {
    const thr = await makeSub('throw', { nextPollAt: null });
    await makeSub('ok', { nextPollAt: null });
    const res = await runMonitoringScheduler(prisma, { now: NOW, walletAddressStartsWith: PREFIX, poll: async (c) => { if (c.walletAddress.endsWith('_throw')) throw new Error('boom'); return { ok: true }; } });
    expect(res.polled).toBe(2);
    expect(res.pollErrors).toBe(1);
    const after = await prisma.monitoringSubscription.findUnique({ where: { id: thr.id } });
    expect(after!.consecutiveErrors).toBe(1);
    expect(after!.nextPollAt).not.toBeNull(); // advanced — no infinite immediate retry
  });

  it('HOT EXPIRY is collision-safe: when the wallet already has a probable_link sub, the expired hot one is DEDUPED not P2002', async () => {
    // One wallet with BOTH a fresh_receiver_hot (expired) and a probable_link.
    const w = await prisma.wallet.create({ data: { address: `${PREFIX}_dual`, chain: 'SOLANA', firstSeenAt: NOW, lastActiveAt: NOW, status: 'observation_only' } });
    const hot = await prisma.monitoringSubscription.create({ data: { walletId: w.id, priority: 'fresh_receiver_hot', tierPriority: 0, active: true, reason: 't', hotUntil: new Date(NOW.getTime() - 1000), nextPollAt: null } });
    await prisma.monitoringSubscription.create({ data: { walletId: w.id, priority: 'probable_link', tierPriority: 3, active: true, reason: 't', nextPollAt: new Date(NOW.getTime() + 3600_000) } });

    const res = await runMonitoringScheduler(prisma, { now: NOW, walletAddressStartsWith: PREFIX, poll: async () => ({ ok: true }) });
    expect(res.hotExpired).toBeGreaterThanOrEqual(1);
    // The hot sub was deleted (deduped); the probable_link survives.
    expect(await prisma.monitoringSubscription.findUnique({ where: { id: hot.id } })).toBeNull();
    expect(await prisma.monitoringSubscription.count({ where: { walletId: w.id } })).toBe(1);
  });

  it('COLD DEMOTION: an idle probable_link demotes to standard', async () => {
    const w = await prisma.wallet.create({ data: { address: `${PREFIX}_cold`, chain: 'SOLANA', firstSeenAt: NOW, lastActiveAt: new Date(NOW.getTime() - 100 * 86_400_000), status: 'observation_only' } });
    const sub = await prisma.monitoringSubscription.create({ data: { walletId: w.id, priority: 'probable_link', tierPriority: 3, active: true, reason: 't', nextPollAt: new Date(NOW.getTime() + 3600_000) } });
    const res = await runMonitoringScheduler(prisma, { now: NOW, walletAddressStartsWith: PREFIX, poll: async () => ({ ok: true }) });
    expect(res.coldDemoted).toBeGreaterThanOrEqual(1);
    const after = await prisma.monitoringSubscription.findUnique({ where: { id: sub.id } });
    expect(after!.priority).toBe('standard');
  });

  it('NEVER mutates wallet status/eligibility', async () => {
    const sub = await makeSub('noelig', { nextPollAt: null });
    await runMonitoringScheduler(prisma, { now: NOW, walletAddressStartsWith: PREFIX, poll: async () => ({ ok: true }) });
    const w = await prisma.wallet.findUnique({ where: { id: sub.walletId } });
    expect(w!.status).toBe('observation_only'); // unchanged
  });
});
