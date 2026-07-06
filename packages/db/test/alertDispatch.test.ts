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
const rotationWalletIds: string[] = [];

afterAll(async () => {
  if (!dbReachable) return;
  if (tokenIds.length > 0) {
    await prisma.alert.deleteMany({ where: { tokenId: { in: tokenIds } } });
    await prisma.signal.deleteMany({ where: { tokenId: { in: tokenIds } } });
    await prisma.tokenFlowSnapshot.deleteMany({ where: { tokenId: { in: tokenIds } } });
    await prisma.tokenMarketSnapshot.deleteMany({ where: { tokenId: { in: tokenIds } } });
  }
  if (rotationWalletIds.length > 0) {
    await prisma.alert.deleteMany({ where: { rotationSignal: { sourceWalletId: { in: rotationWalletIds } } } });
    await prisma.profitRotationSignal.deleteMany({ where: { sourceWalletId: { in: rotationWalletIds } } });
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

/** Creates a source wallet + dest wallet + ProfitRotationSignal row directly, bypassing the matcher entirely (this test only exercises dispatchPendingAlerts' ROTATION branch, not matching). */
async function makeRotationSignal(
  sourceTokenId: string,
  destTokenId: string,
  detectedAt: Date
): Promise<{ id: string; sourceWalletId: string; destWalletId: string }> {
  const now = new Date();
  const sourceWallet = await prisma.wallet.upsert({
    where: { address_chain: { address: `${ADDR_PREFIX}_rot_source_${detectedAt.getTime()}`, chain: CHAIN } },
    create: {
      address: `${ADDR_PREFIX}_rot_source_${detectedAt.getTime()}`,
      chain: CHAIN,
      firstSeenAt: now,
      lastActiveAt: now,
      isWatched: true
    },
    update: {}
  });
  const destWallet = await prisma.wallet.upsert({
    where: { address_chain: { address: `${ADDR_PREFIX}_rot_dest_${detectedAt.getTime()}`, chain: CHAIN } },
    create: {
      address: `${ADDR_PREFIX}_rot_dest_${detectedAt.getTime()}`,
      chain: CHAIN,
      firstSeenAt: now,
      lastActiveAt: now,
      isWatched: false
    },
    update: {}
  });
  rotationWalletIds.push(sourceWallet.id);

  const rotation = await prisma.profitRotationSignal.create({
    data: {
      sourceWalletId: sourceWallet.id,
      destWalletId: destWallet.id,
      sourceTokenId,
      destTokenId,
      realizedProfitUsd: 3000,
      transferredValueUsd: 10_000,
      chainPath: ['SOLANA', 'BSC'],
      timeGapMin: 90,
      confidence: 80,
      detectedAt,
      destTokenMcapAtBuy: 800_000,
      currentDestPerfPct: 15
    }
  });
  return { id: rotation.id, sourceWalletId: sourceWallet.id, destWalletId: destWallet.id };
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

  it('SIGNAL: reads live TokenFlowSnapshot counts, not stale Signal.metrics, when they diverge (cross-surface staleness fix)', async () => {
    // Reproduces the exact staleness scenario apps/web/app/page.tsx's
    // buildCard already documents and guards against (NOVA:
    // Signal.metrics.uniqueEntityCount frozen at the pre-clustering raw
    // count 36, while TokenFlowSnapshot.uniqueEntityCount reflects the
    // post-clustering figure 19) — the Telegram alert text must agree with
    // the Signal Feed card, i.e. read the SAME live snapshot source, not the
    // frozen-at-detection Signal row.
    const tokenId = await makeToken('staleness', 'T16STALE');
    const now = new Date();

    // Signal.metrics/columns carry the STALE pre-clustering counts.
    await prisma.signal.create({
      data: {
        tokenId,
        rule: 'A',
        severity: 'HIGH',
        triggeredAt: now,
        reasons: ['test reason for staleness divergence'],
        walletCount: 36,
        uniqueEntityCount: 36,
        netFlowUsd: 10_000,
        mcapAtTrigger: 300_000,
        status: 'active',
        metrics: { rawWalletCount: 36, uniqueEntityCount: 36, largestClusterSize: 3, entityConcentrationRisk: 'medium' }
      }
    });

    // TokenFlowSnapshot carries the FRESH post-clustering counts (19 unique
    // entities, smartWalletCount also diverges from the stale 36).
    await prisma.tokenFlowSnapshot.create({
      data: {
        tokenId,
        ts: now,
        windowMinutes: 60,
        flowScore: 70,
        smartWalletCount: 30,
        humanLikeCount: 20,
        possibleBotCount: 10,
        uniqueEntityCount: 19,
        clusterAdjustedWalletCount: 19,
        entityConcentrationRisk: 0.5,
        trackedBuyVolumeUsd: 50_000,
        trackedSellVolumeUsd: 5_000,
        netFlowUsd: 45_000,
        buySellRatio: 10,
        avgEntryMcap: 250_000,
        currentMcap: 300_000,
        mcapExpansionFromAvgEntry: 0.2,
        holdersGrowth: 0.1,
        liquidityChange: 0.05,
        signalStatus: 'hot',
        componentBreakdown: {}
      }
    });

    const sender = makeFakeSender();
    await dispatchPendingAlerts(prisma, DEFAULT_SETTINGS, sender);

    const alert = await prisma.alert.findFirst({ where: { tokenId } });
    expect(alert).not.toBeNull();
    const payload = alert!.payload as { text: string; dataUsed: { rawWalletCount: number; uniqueEntityCount: number } };

    // The rendered text/dataUsed must carry the SNAPSHOT figures (19 unique
    // entities, 30 smart wallets) — NOT the stale Signal.metrics figures (36).
    expect(payload.dataUsed.uniqueEntityCount).toBe(19);
    expect(payload.dataUsed.rawWalletCount).toBe(30);
    expect(payload.text).toContain('19');
    expect(payload.text).not.toMatch(/\b36\b/);
  });

  it('ROTATION: a pending ProfitRotationSignal gets exactly one Alert row (type ROTATION), then a second run creates zero more', async () => {
    const sourceTokenId = await makeToken('rot_source', 'T16ROTS');
    const destTokenId = await makeToken('rot_dest', 'T16ROTD');
    const rotation = await makeRotationSignal(sourceTokenId, destTokenId, new Date());

    await dispatchPendingAlerts(prisma, DEFAULT_SETTINGS, null);

    const alerts = await prisma.alert.findMany({ where: { rotationSignalId: rotation.id } });
    expect(alerts.length).toBe(1);
    expect(alerts[0]!.type).toBe('ROTATION');
    expect(alerts[0]!.deliveryStatus).toBe('skipped_no_token');
    const payload = alerts[0]!.payload as { text: string };
    expect(payload.text.length).toBeGreaterThan(0);
    expect(payload.text).toContain('$T16ROTS');
    expect(payload.text).toContain('$T16ROTD');

    // Second pass: no longer pending (alerts: none no longer matches) -> zero new rows.
    await dispatchPendingAlerts(prisma, DEFAULT_SETTINGS, null);
    const alertsAfterSecond = await prisma.alert.findMany({ where: { rotationSignalId: rotation.id } });
    expect(alertsAfterSecond.length).toBe(1);
  });

  it('ROTATION: with a real sender, alert lands "sent" and result.rotationAlertsCreated reflects it', async () => {
    const sourceTokenId = await makeToken('rot_source2', 'T16ROTS2');
    const destTokenId = await makeToken('rot_dest2', 'T16ROTD2');
    const rotation = await makeRotationSignal(sourceTokenId, destTokenId, new Date());

    const sender = makeFakeSender();
    const result = await dispatchPendingAlerts(prisma, DEFAULT_SETTINGS, sender);

    const alert = await prisma.alert.findFirst({ where: { rotationSignalId: rotation.id } });
    expect(alert).not.toBeNull();
    expect(alert!.deliveryStatus).toBe('sent');
    expect(result.rotationAlertsCreated).toBeGreaterThanOrEqual(1);
    expect(sender.sentTexts.some((t) => t.includes('$T16ROTS2') && t.includes('$T16ROTD2'))).toBe(true);
  });
});
