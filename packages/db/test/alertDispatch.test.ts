// FlowRadar — dispatchPendingAlerts integration tests (Task 16 TDD
// requirement: "Integration (LITE PG, prefix cleanup): dispatch creates rows
// once, second run creates none (all signals consumed), cooldown row logic
// via two signals same token+rule.").
//
// Same prefix-cleanup pattern as packages/db/test/signalDedupe.test.ts /
// fundingEvents.test.ts: real LITE-mode Postgres (embedded-postgres, port
// 5439), describe.skipIf when unreachable, address-scoped afterAll cleanup.

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import net from 'node:net';
import { DEFAULT_SETTINGS } from '@flowradar/core';
import { prisma } from '../src/client';
import { dispatchPendingAlerts } from '../src/alerts';
import type { AlertSender } from '../src/alerts';

const ADDR_PREFIX = 'T16ALERT';
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

/** In-memory fake sender — records every `send()` call so tests can assert on delivery without touching the real Telegram API. */
function makeFakeSender(): AlertSender & { sentTexts: string[] } {
  const sentTexts: string[] = [];
  return {
    sentTexts,
    async send(text: string): Promise<void> {
      sentTexts.push(text);
    }
  };
}

let dbReachable = false;

beforeAll(async () => {
  dbReachable = await probePort('localhost', 5439);
  if (!dbReachable) {
    // eslint-disable-next-line no-console
    console.warn(
      '[alertDispatch.test] LITE Postgres not reachable on localhost:5439 — skipping ' +
        'integration tests. Run `npm run db:migrate` first to exercise this suite.'
    );
  }
});

const tokenIds: string[] = [];

afterAll(async () => {
  if (!dbReachable) return;
  if (tokenIds.length > 0) {
    await prisma.alert.deleteMany({ where: { tokenId: { in: tokenIds } } });
    await prisma.signal.deleteMany({ where: { tokenId: { in: tokenIds } } });
    await prisma.tokenFlowSnapshot.deleteMany({ where: { tokenId: { in: tokenIds } } });
    await prisma.tokenMarketSnapshot.deleteMany({ where: { tokenId: { in: tokenIds } } });
  }
  await prisma.walletTokenTrade.deleteMany({ where: { wallet: { address: { startsWith: ADDR_PREFIX } } } });
  await prisma.wallet.deleteMany({ where: { address: { startsWith: ADDR_PREFIX } } });
  await prisma.token.deleteMany({ where: { address: { startsWith: ADDR_PREFIX } } });
  await prisma.$disconnect();
});

/** Creates a bare-minimum Token row for this test suite (no trades needed — dispatchPendingAlerts only reads Signal + Token + latest snapshots, all of which gracefully default when absent). */
async function makeToken(addressSuffix: string, symbol: string): Promise<string> {
  const address = `${ADDR_PREFIX}_token_${addressSuffix}`;
  const now = new Date();
  const token = await prisma.token.upsert({
    where: { chain_address: { chain: CHAIN, address } },
    create: {
      chain: CHAIN,
      address,
      symbol,
      name: symbol,
      decimals: 9,
      firstSeenAt: now,
      riskFlags: []
    },
    update: {}
  });
  tokenIds.push(token.id);
  return token.id;
}

async function makeSignal(
  tokenId: string,
  rule: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G',
  severity: 'INFO' | 'WATCH' | 'HIGH' | 'CRITICAL',
  triggeredAt: Date
): Promise<string> {
  const signal = await prisma.signal.create({
    data: {
      tokenId,
      rule,
      severity,
      triggeredAt,
      reasons: ['test reason for dispatch integration test'],
      walletCount: 20,
      uniqueEntityCount: 5,
      netFlowUsd: 10_000,
      mcapAtTrigger: 300_000,
      status: 'active',
      metrics: { rawWalletCount: 20, uniqueEntityCount: 5, largestClusterSize: 3, entityConcentrationRisk: 'medium' }
    }
  });
  return signal.id;
}

// dispatchPendingAlerts is (by design — see file header) a GLOBAL pass over
// every Signal in the table, not scoped to any one test's own rows. This
// database also carries real pre-existing Signal rows from `npm run
// db:seed` (NOVA/QUIET/SEED/DUMP/ALPHA/NOISE* — 12 as of this task, sitting
// unconsumed because dispatchPendingAlerts didn't exist before Task 16).
// Every assertion below is therefore scoped to THIS test's own tokenId(s)
// (querying Alert/Signal rows directly, not the aggregate `result.*`
// counters, which necessarily reflect the WHOLE table's pending backlog) —
// this mirrors real production behavior (one dispatch pass drains
// everything pending, seeded rows included) while keeping each test
// independently verifiable regardless of what else is sitting in the DB.
describe.skipIf(!(await probePort('localhost', 5439)))('dispatchPendingAlerts', () => {
  it('creates exactly one Alert row per pending Signal, then a second run creates zero more', async () => {
    const tokenId = await makeToken('once', 'T16A');
    const now = new Date();
    await makeSignal(tokenId, 'A', 'HIGH', now);

    const sender = makeFakeSender();

    await dispatchPendingAlerts(prisma, DEFAULT_SETTINGS, sender);

    const alertsAfterFirst = await prisma.alert.findMany({ where: { tokenId } });
    expect(alertsAfterFirst.length).toBe(1);
    expect(alertsAfterFirst[0]!.deliveryStatus).toBe('sent');
    expect(sender.sentTexts.some((t) => t.includes('$T16A'))).toBe(true);

    // Second run: the Signal now HAS an Alert row, so it's no longer
    // "pending" (alerts: { none: {} } excludes it) — zero new rows for THIS
    // token, even though the pass itself still runs over the whole table.
    await dispatchPendingAlerts(prisma, DEFAULT_SETTINGS, sender);

    const alertsAfterSecond = await prisma.alert.findMany({ where: { tokenId } });
    expect(alertsAfterSecond.length).toBe(1); // still exactly 1, not 2
  });

  it('null sender -> every alert lands skipped_no_token, with a non-empty rendered payload text', async () => {
    const tokenId = await makeToken('nulls', 'T16B');
    await makeSignal(tokenId, 'C', 'WATCH', new Date());

    await dispatchPendingAlerts(prisma, DEFAULT_SETTINGS, null);

    const alert = await prisma.alert.findFirst({ where: { tokenId } });
    expect(alert).not.toBeNull();
    expect(alert!.deliveryStatus).toBe('skipped_no_token');
    const payload = alert!.payload as { text: string };
    expect(payload.text.length).toBeGreaterThan(0);
    expect(payload.text).toContain('$T16B');
  });

  it('cooldown: two signals, same (tokenId, rule) — second one inside cooldown gets skipped_cooldown, and still gets exactly one Alert row', async () => {
    const tokenId = await makeToken('cooldown', 'T16C');
    const t0 = new Date();

    // First signal fires now; dispatch it -> 'sent'.
    await makeSignal(tokenId, 'D', 'HIGH', t0);
    const sender = makeFakeSender();
    await dispatchPendingAlerts(prisma, DEFAULT_SETTINGS, sender);

    const afterFirst = await prisma.alert.findMany({ where: { tokenId, rule: 'D' } });
    expect(afterFirst.length).toBe(1);
    expect(afterFirst[0]!.deliveryStatus).toBe('sent');

    // Second signal for the SAME (tokenId, rule) fires 10 minutes later — well
    // inside the default 30-minute cooldown (DEFAULT_SETTINGS.alerts.cooldownMin)
    // — same severity (HIGH -> HIGH), so no escalation bypass applies.
    const t1 = new Date(t0.getTime() + 10 * 60 * 1000);
    await makeSignal(tokenId, 'D', 'HIGH', t1);

    await dispatchPendingAlerts(prisma, DEFAULT_SETTINGS, sender);

    const allAlertsForToken = await prisma.alert.findMany({ where: { tokenId, rule: 'D' }, orderBy: { sentAt: 'asc' } });
    expect(allAlertsForToken.length).toBe(2); // one per signal — cooldown-skipped signals still get exactly one row
    expect(allAlertsForToken[0]!.deliveryStatus).toBe('sent');
    expect(allAlertsForToken[1]!.deliveryStatus).toBe('skipped_cooldown');

    // A third pass finds nothing NEW pending for this token (both signals
    // already have an Alert row) — the row count for this token stays at 2.
    await dispatchPendingAlerts(prisma, DEFAULT_SETTINGS, sender);
    const afterThird = await prisma.alert.findMany({ where: { tokenId, rule: 'D' } });
    expect(afterThird.length).toBe(2);
  });

  it('cooldown escalation bypass: HIGH -> CRITICAL inside cooldown still sends', async () => {
    const tokenId = await makeToken('escalate', 'T16D');
    const t0 = new Date();

    await makeSignal(tokenId, 'G', 'HIGH', t0);
    const sender = makeFakeSender();
    await dispatchPendingAlerts(prisma, DEFAULT_SETTINGS, sender);

    // Escalates to CRITICAL only 5 minutes later — well inside cooldown, but
    // the escalation bypass (HIGH -> CRITICAL) should send anyway.
    const t1 = new Date(t0.getTime() + 5 * 60 * 1000);
    await makeSignal(tokenId, 'G', 'CRITICAL', t1);

    await dispatchPendingAlerts(prisma, DEFAULT_SETTINGS, sender);

    const allAlertsForToken = await prisma.alert.findMany({ where: { tokenId, rule: 'G' }, orderBy: { sentAt: 'asc' } });
    expect(allAlertsForToken.length).toBe(2);
    expect(allAlertsForToken.every((a) => a.deliveryStatus === 'sent')).toBe(true);
  });
});
