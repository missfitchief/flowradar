// FlowRadar — address-dormancy DB builder tests (dormancy Task 7).

import { describe, expect, it, afterAll, beforeEach } from 'vitest';
import net from 'node:net';
import { MEANINGFUL_ACTIVITY_RULES_VERSION } from '@flowradar/core';
import { prisma } from '../../src/client';
import { classifyWalletActivity } from '../../src/dormancy/activity';
import { buildAddressDormancyObservations } from '../../src/dormancy/addressDormancy';

const PREFIX = 'DRMAD'; // base58-safe (no 0/O/I/l)

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
const ENTRY = new Date('2026-06-01T00:00:00Z');
const daysBefore = (d: number) => new Date(ENTRY.getTime() - d * 86_400_000);
const hoursBefore = (h: number) => new Date(ENTRY.getTime() - h * 3600_000);
const addr = (s: string) => `${PREFIX}${s}`;

async function cleanup() {
  await prisma.addressDormancyObservation.deleteMany({ where: { walletAddress: { startsWith: PREFIX } } });
  await prisma.walletActivityClassification.deleteMany({ where: { walletAddress: { startsWith: PREFIX } } });
  await prisma.walletBehaviorProfile.deleteMany({ where: { walletAddress: { startsWith: PREFIX } } });
  await prisma.moneyFlowEdge.deleteMany({
    where: { OR: [{ sourceAddress: { startsWith: PREFIX } }, { destinationAddress: { startsWith: PREFIX } }] }
  });
  await prisma.walletTokenTrade.deleteMany({ where: { txHash: { startsWith: PREFIX } } });
  await prisma.wallet.deleteMany({ where: { address: { startsWith: PREFIX } } });
  await prisma.token.deleteMany({ where: { address: { startsWith: PREFIX } } });
}

let tokenSeq = 0;
async function seedToken() {
  tokenSeq += 1;
  const a = addr(`TK${tokenSeq}`);
  return prisma.token.create({
    data: { chain: 'SOLANA', address: a, symbol: `T${tokenSeq}`, name: a, decimals: 9, firstSeenAt: daysBefore(365), riskFlags: [] },
    select: { id: true, address: true }
  });
}

async function seedWallet(suffix: string) {
  return prisma.wallet.create({
    data: { address: addr(suffix), chain: 'SOLANA', firstSeenAt: daysBefore(365), lastActiveAt: ENTRY },
    select: { id: true, address: true }
  });
}

let txSeq = 0;
async function seedTrade(walletId: string, tokenId: string, action: 'BUY' | 'SELL', usd: number, ts: Date) {
  txSeq += 1;
  return prisma.walletTokenTrade.create({
    data: {
      walletId, tokenId, chain: 'SOLANA', action, amountToken: '10', amountUsd: String(usd),
      txHash: addr(`TX${txSeq}`), blockOrSlot: 1n, ts, priceUsd: '1', marketCapAtTrade: '100000',
      walletScoreAtTime: 50, provider: 'test'
    }
  });
}

async function seedProfile(walletAddress: string, entries: { tokenAddress: string; firstBuyTs: string | null }[]) {
  return prisma.walletBehaviorProfile.create({
    data: {
      chain: 'SOLANA', walletAddress, engineVersion: 1, dataQuality: 'local_only', computedAt: ENTRY,
      profileJson: { local: { tokenPositions: entries } }
    }
  });
}

async function seedFundingEdge(from: string, to: string, usd: number | null, ts: Date) {
  txSeq += 1;
  return prisma.moneyFlowEdge.create({
    data: {
      sourceAddress: from, destinationAddress: to, sourceChain: 'SOLANA', destinationChain: 'SOLANA',
      asset: 'SOL', amountToken: 1, amountUsd: 0, ts, txHash: addr(`TX${txSeq}`), actionType: 'transfer',
      confidence: 100, providerSource: 'test', metadata: {},
      valuedUsd: usd === null ? null : String(usd), valuationConfidence: usd === null ? null : 90
    }
  });
}

beforeEach(async () => {
  if (dbReachable) await cleanup();
});

afterAll(async () => {
  if (!dbReachable) return;
  await cleanup();
  await prisma.$disconnect();
});

describe.skipIf(!dbReachable)('buildAddressDormancyObservations (Task 7 DB builder)', () => {
  it('covered dormancy from meaningful events only — dust NEVER resets dormancy; entry buy itself invisible', async () => {
    const w = await seedWallet('WA');
    const entryTok = await seedToken();
    const oldTok = await seedToken();
    // Coverage starts 40d before entry (meaningful trade), a DUST trade 2d
    // before entry must not read as activity, entry buy at ENTRY is future-invisible.
    await seedTrade(w.id, oldTok.id, 'BUY', 100, daysBefore(40));
    await seedTrade(w.id, oldTok.id, 'SELL', 0.5, daysBefore(2)); // dust
    await seedTrade(w.id, entryTok.id, 'BUY', 200, ENTRY);
    await seedProfile(w.address, [{ tokenAddress: entryTok.address, firstBuyTs: ENTRY.toISOString() }]);

    const r = await buildAddressDormancyObservations(prisma, { chain: 'SOLANA', walletAddresses: [w.address] });
    expect(r.errors).toBe(0);
    expect(r.observationsWritten).toBe(1);
    const obs = await prisma.addressDormancyObservation.findUniqueOrThrow({
      where: {
        chain_walletAddress_eventKind_anchorKey: {
          chain: 'SOLANA', walletAddress: w.address, eventKind: 'token_entry', anchorKey: entryTok.address
        }
      }
    });
    expect(obs.overallClass).toBe('covered_dormant');
    expect(obs.maxCoveredDormantDays).toBe(30); // the 40d-old meaningful trade sits inside the 90d window
    const windows = obs.windowsJson as { windowDays: number; class: string }[];
    expect(windows.map((w2) => w2.class)).toEqual([
      'covered_dormant', 'covered_dormant', 'covered_dormant', 'active'
    ]);
    expect(obs.coverageStartTs?.toISOString()).toBe(daysBefore(40).toISOString());

    // Idempotent rerun: no new rows.
    await buildAddressDormancyObservations(prisma, { chain: 'SOLANA', walletAddresses: [w.address] });
    expect(await prisma.addressDormancyObservation.count({ where: { walletAddress: w.address } })).toBe(1);
  });

  it('meaningful activity shortly before entry classifies active', async () => {
    const w = await seedWallet('WB');
    const entryTok = await seedToken();
    const otherTok = await seedToken();
    await seedTrade(w.id, otherTok.id, 'BUY', 100, daysBefore(200)); // old coverage anchor
    await seedTrade(w.id, otherTok.id, 'SELL', 150, daysBefore(1)); // meaningful, in-window
    await seedTrade(w.id, entryTok.id, 'BUY', 200, ENTRY);
    await seedProfile(w.address, [{ tokenAddress: entryTok.address, firstBuyTs: ENTRY.toISOString() }]);

    const r = await buildAddressDormancyObservations(prisma, { chain: 'SOLANA', walletAddresses: [w.address] });
    expect(r.byOverallClass.active).toBe(1);
  });

  it('fresh requires the funding to open the history within the fresh horizon', async () => {
    const w = await seedWallet('WC');
    const entryTok = await seedToken();
    await seedFundingEdge(addr('FUNDR'), w.address, 30, hoursBefore(24)); // first observation = inbound funding
    await seedTrade(w.id, entryTok.id, 'BUY', 200, ENTRY);
    await seedProfile(w.address, [{ tokenAddress: entryTok.address, firstBuyTs: ENTRY.toISOString() }]);

    const r = await buildAddressDormancyObservations(prisma, { chain: 'SOLANA', walletAddresses: [w.address] });
    expect(r.byOverallClass.fresh).toBe(1);
  });

  it('history that begins inside every window is incomplete — NEVER dormant (no funding evidence)', async () => {
    const w = await seedWallet('WD');
    const entryTok = await seedToken();
    const otherTok = await seedToken();
    await seedTrade(w.id, otherTok.id, 'BUY', 100, daysBefore(2)); // coverage starts 2d before entry
    await seedTrade(w.id, entryTok.id, 'BUY', 200, ENTRY);
    await seedProfile(w.address, [{ tokenAddress: entryTok.address, firstBuyTs: ENTRY.toISOString() }]);

    const r = await buildAddressDormancyObservations(prisma, { chain: 'SOLANA', walletAddresses: [w.address] });
    // The 2d-old trade is meaningful and inside the 7d window -> active, not
    // dormant; now shift the anchor: a SECOND entry 3d later with no events in
    // between still must not claim dormancy (coverage began inside its windows).
    expect(r.byOverallClass.active).toBe(1);

    const laterTok = await seedToken();
    await prisma.walletBehaviorProfile.update({
      where: { chain_walletAddress: { chain: 'SOLANA', walletAddress: w.address } },
      data: {
        profileJson: {
          local: {
            tokenPositions: [
              { tokenAddress: entryTok.address, firstBuyTs: ENTRY.toISOString() },
              { tokenAddress: laterTok.address, firstBuyTs: new Date(ENTRY.getTime() + 30 * 86_400_000).toISOString() }
            ]
          }
        }
      }
    });
    const r2 = await buildAddressDormancyObservations(prisma, { chain: 'SOLANA', walletAddresses: [w.address] });
    const later = await prisma.addressDormancyObservation.findUniqueOrThrow({
      where: {
        chain_walletAddress_eventKind_anchorKey: {
          chain: 'SOLANA', walletAddress: w.address, eventKind: 'token_entry', anchorKey: laterTok.address
        }
      }
    });
    // 30d after the last activity (the ENTRY buy lands exactly on the 30d
    // window boundary -> in-window -> that window is active); coverage only
    // reaches ~32d back so the 90d window stays honest-incomplete.
    expect(later.overallClass).toBe('covered_dormant');
    expect(later.maxCoveredDormantDays).toBe(14);
    const laterWindows = later.windowsJson as { class: string }[];
    expect(laterWindows.map((w2) => w2.class)).toEqual([
      'covered_dormant', 'covered_dormant', 'active', 'active' // observed events trump coverage gaps
    ]);
    expect(r2.errors).toBe(0);
  });

  it('a truncated classification pass can never mint covered-dormant claims', async () => {
    const w = await seedWallet('WE');
    const entryTok = await seedToken();
    const otherTok = await seedToken();
    await seedTrade(w.id, otherTok.id, 'BUY', 100, daysBefore(200));
    await seedTrade(w.id, otherTok.id, 'SELL', 120, daysBefore(150));
    await seedTrade(w.id, entryTok.id, 'BUY', 200, ENTRY);
    await seedProfile(w.address, [{ tokenAddress: entryTok.address, firstBuyTs: ENTRY.toISOString() }]);

    // Bounded pass: newest 2 of 3 trades — the oldest is invisible, so no
    // covered-dormant claim is allowed even though the seen windows are empty.
    const r = await buildAddressDormancyObservations(prisma, {
      chain: 'SOLANA',
      walletAddresses: [w.address],
      maxTrades: 2
    });
    expect(r.walletsIncompleteClassification).toBe(1);
    const obs = await prisma.addressDormancyObservation.findFirstOrThrow({ where: { walletAddress: w.address } });
    expect(obs.overallClass).toBe('apparently_dormant_incomplete_history');
    expect(obs.caveats.join(' ')).toContain('no covered-dormant claim');
  });

  it('stale rule-version audit rows are re-persisted at the current version (refresh is ruleVersion-aware)', async () => {
    const w = await seedWallet('WRV');
    const entryTok = await seedToken();
    const oldTok = await seedToken();
    await seedTrade(w.id, oldTok.id, 'BUY', 100, daysBefore(40));
    await seedTrade(w.id, entryTok.id, 'BUY', 200, ENTRY);
    await seedProfile(w.address, [{ tokenAddress: entryTok.address, firstBuyTs: ENTRY.toISOString() }]);

    // First pass persists current-version audit rows; downgrade them to
    // simulate leftovers from an older rule set.
    await classifyWalletActivity(prisma, { chain: 'SOLANA', address: w.address });
    await prisma.walletActivityClassification.updateMany({
      where: { walletAddress: w.address, chain: 'SOLANA' },
      data: { ruleVersion: MEANINGFUL_ACTIVITY_RULES_VERSION - 1 }
    });

    await buildAddressDormancyObservations(prisma, { chain: 'SOLANA', walletAddresses: [w.address] });
    const rows = await prisma.walletActivityClassification.findMany({
      where: { walletAddress: w.address, chain: 'SOLANA' }
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.ruleVersion === MEANINGFUL_ACTIVITY_RULES_VERSION)).toBe(true);
  });

  it('non-meaningful history can neither establish coverage nor freshness (spam / unknown-value only)', async () => {
    // Spam-only pre-history: a $0.2 inbound 100d before entry proves nothing —
    // the wallet must stay UNKNOWN, never covered_dormant.
    const w = await seedWallet('WG');
    const entryTok = await seedToken();
    await seedFundingEdge(addr('SPMR'), w.address, 0.2, daysBefore(100));
    await seedTrade(w.id, entryTok.id, 'BUY', 200, ENTRY);
    await seedProfile(w.address, [{ tokenAddress: entryTok.address, firstBuyTs: ENTRY.toISOString() }]);
    const r = await buildAddressDormancyObservations(prisma, { chain: 'SOLANA', walletAddresses: [w.address] });
    expect(r.byOverallClass.unknown).toBe(1);

    // Unknown-value funding 24h before entry is NOT freshness evidence.
    const w2 = await seedWallet('WGU');
    const entryTok2 = await seedToken();
    await seedFundingEdge(addr('FUNDU'), w2.address, null, hoursBefore(24));
    await seedTrade(w2.id, entryTok2.id, 'BUY', 200, ENTRY);
    await seedProfile(w2.address, [{ tokenAddress: entryTok2.address, firstBuyTs: ENTRY.toISOString() }]);
    const r2 = await buildAddressDormancyObservations(prisma, { chain: 'SOLANA', walletAddresses: [w2.address] });
    expect(r2.byOverallClass.fresh ?? 0).toBe(0);
    expect(r2.byOverallClass.unknown).toBe(1);
  });

  it('activity only AFTER the entry leaves the pre-event view unknown (no lookahead)', async () => {
    const w = await seedWallet('WF');
    const entryTok = await seedToken();
    const otherTok = await seedToken();
    await seedTrade(w.id, entryTok.id, 'BUY', 200, ENTRY);
    await seedTrade(w.id, otherTok.id, 'BUY', 500, new Date(ENTRY.getTime() + 86_400_000)); // post-event only
    await seedProfile(w.address, [{ tokenAddress: entryTok.address, firstBuyTs: ENTRY.toISOString() }]);

    const r = await buildAddressDormancyObservations(prisma, { chain: 'SOLANA', walletAddresses: [w.address] });
    expect(r.byOverallClass.unknown).toBe(1);
    const obs = await prisma.addressDormancyObservation.findFirstOrThrow({ where: { walletAddress: w.address } });
    const receipts = obs.receiptsJson as { futureEventsIgnored: number };
    expect(receipts.futureEventsIgnored).toBeGreaterThanOrEqual(1);
  });
});
