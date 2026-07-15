import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { monitoredAlchemyAddresses, reconcileAlchemyCoreWebhooks, syncAlchemyCoreWalletChange } from '../src/alchemy/subscriptions';
import { prisma } from '../src/client';

const SOL_A = 'AlchemyMonitorSeed111111111111111111111111111';
const SOL_B = 'AlchemyMonitorSeed222222222222222222222222222';
const STALE = 'AlchemyMonitorStale3333333333333333333333333';
const ENV = { ALCHEMY_NOTIFY_AUTH_TOKEN: 'test-notify-token', ALCHEMY_SOLANA_WEBHOOK_ID: 'test-solana-webhook' };
const originalFetch = globalThis.fetch;

async function cleanup() {
  await prisma.monitoringSubscription.deleteMany({ where: { wallet: { address: { in: [SOL_A, SOL_B] } } } });
  await prisma.wallet.deleteMany({ where: { address: { in: [SOL_A, SOL_B] } } });
  await prisma.alchemyWebhookSubscriptionState.deleteMany();
}

beforeEach(cleanup);
afterEach(() => { globalThis.fetch = originalFetch; });
afterAll(async () => { await cleanup(); await prisma.$disconnect(); });

async function monitoredWallet(address: string) {
  const wallet = await prisma.wallet.create({ data: {
    chain: 'SOLANA', address, status: 'observation_only', isWatched: true,
    firstSeenAt: new Date('2026-07-15T00:00:00Z'), lastActiveAt: new Date('2026-07-15T00:00:00Z')
  } });
  await prisma.monitoringSubscription.create({ data: {
    walletId: wallet.id, priority: 'standard', active: true, tierPriority: 4, reason: 'alchemy_subscription_test'
  } });
  return wallet;
}

function remoteApi(initial: string[]) {
  const remote = new Set(initial);
  let firstList = true;
  const patches: Array<{ webhook_id: string; addresses_to_add: string[]; addresses_to_remove: string[] }> = [];
  globalThis.fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    if ((init?.method ?? 'GET') === 'PATCH') {
      const body = JSON.parse(String(init?.body)) as typeof patches[number];
      patches.push(body);
      body.addresses_to_add.forEach((address) => remote.add(address));
      body.addresses_to_remove.forEach((address) => remote.delete(address));
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const data = firstList ? initial : [...remote];
    firstList = false;
    return new Response(JSON.stringify({ data, pagination: { cursors: { after: null }, total_count: data.length } }), {
      status: 200, headers: { 'content-type': 'application/json' }
    });
  }) as typeof fetch;
  return { remote, patches };
}

describe('Alchemy monitoring subscription selection', () => {
  it('selects observation-only wallets with active monitoring and reconciles additions, stale rows, and duplicates', async () => {
    await monitoredWallet(SOL_A);
    await monitoredWallet(SOL_B);
    expect(await monitoredAlchemyAddresses(prisma, 'SOLANA')).toEqual([SOL_A, SOL_B]);

    const api = remoteApi([SOL_A, STALE, STALE]);
    const result = await reconcileAlchemyCoreWebhooks(prisma, ENV);
    const solana = result.find((item) => item.chain === 'SOLANA');
    expect(solana).toMatchObject({ status: 'synced', desiredAddressCount: 2, remoteAddressCount: 2, added: 1, removed: 1, duplicates: 1, failures: 0 });
    expect(api.remote).toEqual(new Set([SOL_A, SOL_B]));
  });

  it('/remove propagation keeps a remotely subscribed wallet while any active monitoring subscription remains', async () => {
    const wallet = await monitoredWallet(SOL_A);
    const api = remoteApi([SOL_A]);
    const kept = await syncAlchemyCoreWalletChange(prisma, [{ chain: 'SOLANA', address: SOL_A }], 'remove', ENV);
    expect(kept[0]).toMatchObject({ removed: 0, remoteAddressCount: 1 });

    await prisma.monitoringSubscription.updateMany({ where: { walletId: wallet.id }, data: { active: false } });
    const removed = await syncAlchemyCoreWalletChange(prisma, [{ chain: 'SOLANA', address: SOL_A }], 'remove', ENV);
    expect(removed[0]).toMatchObject({ removed: 1, remoteAddressCount: 0 });
    expect(api.remote.size).toBe(0);
  });
});
