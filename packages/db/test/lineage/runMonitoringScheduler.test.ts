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

async function makeSub(suffix: string, over: { priority?: string; nextPollAt?: Date | null; claimedAt?: Date | null; hotUntil?: Date | null; consecutiveErrors?: number; active?: boolean } = {}) {
  const w = await prisma.wallet.create({ data: { address: `${PREFIX}_${suffix}`, chain: 'SOLANA', firstSeenAt: NOW, lastActiveAt: NOW, status: 'observation_only' } });
  return prisma.monitoringSubscription.create({
    data: {
      walletId: w.id,
      priority: (over.priority ?? 'probable_link') as never,
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

  it('a THROWN poll error is isolated (does not abort the pass)', async () => {
    await makeSub('throw', { nextPollAt: null });
    await makeSub('ok', { nextPollAt: null });
    const res = await runMonitoringScheduler(prisma, { now: NOW, walletAddressStartsWith: PREFIX, poll: async (c) => { if (c.walletAddress.endsWith('_throw')) throw new Error('boom'); return { ok: true }; } });
    expect(res.polled).toBe(2);
    expect(res.pollErrors).toBe(1);
  });

  it('NEVER mutates wallet status/eligibility', async () => {
    const sub = await makeSub('noelig', { nextPollAt: null });
    await runMonitoringScheduler(prisma, { now: NOW, walletAddressStartsWith: PREFIX, poll: async () => ({ ok: true }) });
    const w = await prisma.wallet.findUnique({ where: { id: sub.walletId } });
    expect(w!.status).toBe('observation_only'); // unchanged
  });
});
