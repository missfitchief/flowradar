// FlowRadar — meaningful-activity DB builder tests (dormancy Task 6).

import { describe, expect, it, afterAll, beforeEach } from 'vitest';
import net from 'node:net';
import { prisma } from '../../src/client';
import { classifyWalletActivity, runActivityClassification } from '../../src/dormancy/activity';

const PREFIX = 'DRMAC'; // base58-safe (no 0/O/I/l)

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
const addr = (s: string) => `${PREFIX}${s}`;

async function cleanup() {
  await prisma.walletActivityClassification.deleteMany({ where: { walletAddress: { startsWith: PREFIX } } });
  await prisma.walletBehaviorProfile.deleteMany({ where: { walletAddress: { startsWith: PREFIX } } });
  await prisma.moneyFlowEdge.deleteMany({
    where: { OR: [{ sourceAddress: { startsWith: PREFIX } }, { destinationAddress: { startsWith: PREFIX } }] }
  });
  await prisma.walletTokenTrade.deleteMany({ where: { txHash: { startsWith: PREFIX } } });
  await prisma.addressRegistry.deleteMany({ where: { address: { startsWith: PREFIX } } });
  await prisma.wallet.deleteMany({ where: { address: { startsWith: PREFIX } } });
  await prisma.token.deleteMany({ where: { address: { startsWith: PREFIX } } });
}

async function seedWallet(suffix: string, chain: 'SOLANA' | 'BSC' = 'SOLANA') {
  return prisma.wallet.create({
    data: { address: addr(suffix), chain, firstSeenAt: T0, lastActiveAt: T0 },
    select: { id: true, address: true }
  });
}

async function seedToken(suffix: string) {
  return prisma.token.create({
    data: { chain: 'SOLANA', address: addr(suffix), symbol: suffix.slice(0, 6), name: suffix, decimals: 9, firstSeenAt: T0, riskFlags: [] },
    select: { id: true, address: true }
  });
}

async function seedTrade(
  walletId: string,
  tokenId: string,
  action: 'BUY' | 'SELL' | 'TRANSFER_IN' | 'TRANSFER_OUT' | 'LP_ADD' | 'LP_REMOVE',
  usd: number,
  ts: Date,
  tx: string
) {
  return prisma.walletTokenTrade.create({
    data: {
      walletId, tokenId, chain: 'SOLANA', action, amountToken: '10', amountUsd: String(usd),
      txHash: addr(tx), blockOrSlot: 1n, ts, priceUsd: '1', marketCapAtTrade: '100000', walletScoreAtTime: 50, provider: 'test'
    }
  });
}

async function seedEdge(opts: {
  from: string; to: string; usd: number | null; ts: Date; tx: string;
  chain?: 'SOLANA' | 'BSC'; valuationConfidence?: number;
}) {
  return prisma.moneyFlowEdge.create({
    data: {
      sourceAddress: opts.from, destinationAddress: opts.to,
      sourceChain: opts.chain ?? 'SOLANA', destinationChain: opts.chain ?? 'SOLANA',
      asset: 'SOL', amountToken: 1, amountUsd: 0, ts: opts.ts, txHash: addr(opts.tx),
      actionType: 'transfer', confidence: 100, providerSource: 'test', metadata: {},
      valuedUsd: opts.usd === null ? null : String(opts.usd),
      valuationConfidence: opts.valuationConfidence ?? (opts.usd === null ? null : 90)
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

describe.skipIf(!dbReachable)('classifyWalletActivity (Task 6 DB builder)', () => {
  it('classifies local trades + chain-scoped edges with honest valuation and service registry, idempotently', async () => {
    const w = await seedWallet('WA');
    const tok = await seedToken('TKA');
    await seedTrade(w.id, tok.id, 'BUY', 100, new Date(T0.getTime() + 1000), 'TXBUY');
    await seedTrade(w.id, tok.id, 'SELL', 0.5, new Date(T0.getTime() + 2000), 'TXDUST');
    // TRANSFER rows in the trades table carry no counterparty — never meaningful.
    await seedTrade(w.id, tok.id, 'TRANSFER_IN', 5000, new Date(T0.getTime() + 2100), 'TXTRIN');
    // LP actions are pool interactions — service by construction.
    await seedTrade(w.id, tok.id, 'LP_ADD', 250, new Date(T0.getTime() + 2200), 'TXLP');
    // Legacy 0-for-unpriced trade amount => UNKNOWN value, never $0 dust.
    await seedTrade(w.id, tok.id, 'BUY', 0, new Date(T0.getTime() + 2300), 'TXZERO');

    await prisma.addressRegistry.create({
      data: { chain: 'SOLANA', address: addr('CEX'), category: 'CEX', label: 'test cex', source: 'test' }
    });
    await seedEdge({ from: addr('CPA'), to: w.address, usd: 50, ts: new Date(T0.getTime() + 3000), tx: 'TXIN' });
    await seedEdge({ from: addr('CPB'), to: w.address, usd: null, ts: new Date(T0.getTime() + 4000), tx: 'TXUNK' });
    await seedEdge({ from: w.address, to: addr('CEX'), usd: 5000, ts: new Date(T0.getTime() + 5000), tx: 'TXCEX' });
    await seedEdge({ from: w.address, to: w.address, usd: 10, ts: new Date(T0.getTime() + 6000), tx: 'TXSELF' });
    await seedEdge({ from: addr('CPC'), to: w.address, usd: 0.2, ts: new Date(T0.getTime() + 7000), tx: 'TXSPAM' });
    // BSC edge sharing the textual address must NEVER enter the SOLANA view.
    await seedEdge({ from: w.address, to: addr('CPD'), usd: 9999, ts: new Date(T0.getTime() + 8000), tx: 'TXBSC', chain: 'BSC' });

    const r = await classifyWalletActivity(prisma, { chain: 'SOLANA', address: w.address });
    expect(r.tradesSeen).toBe(5);
    expect(r.transfersSeen).toBe(5); // BSC edge excluded
    expect(r.byClass).toEqual({
      meaningful_trade: 1,
      dust: 2, // dust sell + inbound spam-dust
      meaningful_transfer: 1,
      unknown_value: 2, // unpriced edge + 0-for-unpriced trade
      unknown_counterparty: 1, // TRANSFER_IN trade row — no counterparty named
      service_interaction: 2, // CEX edge + LP_ADD pool action
      non_economic: 1
    });
    expect(r.meaningfulCount).toBe(2);
    expect(r.meaningfulEventTs).toHaveLength(2);
    expect(r.earliestMeaningfulInboundTs?.getTime()).toBe(T0.getTime() + 3000); // the $50 valued inbound

    const rows = await prisma.walletActivityClassification.findMany({ where: { walletAddress: w.address } });
    expect(rows).toHaveLength(10);
    const byTx = new Map(rows.map((x) => [x.txHash, x]));
    expect(byTx.get(addr('TXUNK'))?.classification).toBe('unknown_value');
    expect(byTx.get(addr('TXUNK'))?.usd).toBeNull(); // unknown stays null, never 0
    expect(byTx.get(addr('TXZERO'))?.classification).toBe('unknown_value');
    expect(byTx.get(addr('TXZERO'))?.usd).toBeNull(); // 0-for-unpriced is UNKNOWN, not $0 dust
    expect(byTx.get(addr('TXTRIN'))?.classification).toBe('unknown_counterparty');
    expect(byTx.get(addr('TXLP'))?.classification).toBe('service_interaction');
    expect(byTx.get(addr('TXCEX'))?.classification).toBe('service_interaction');
    expect(byTx.get(addr('TXSPAM'))?.reasonCodes).toContain('inbound_dust_possible_spam');
    expect(byTx.get(addr('TXSELF'))?.classification).toBe('non_economic');
    expect(byTx.has(addr('TXBSC'))).toBe(false);
    expect(rows.every((x) => x.ruleVersion === 2)).toBe(true);

    // Idempotency: rerun updates in place — row count must not grow.
    const again = await classifyWalletActivity(prisma, { chain: 'SOLANA', address: w.address });
    expect(again.rowsWritten).toBe(10);
    expect(await prisma.walletActivityClassification.count({ where: { walletAddress: w.address } })).toBe(10);
  });

  it('excludes unregistered high-fan-out hubs by degree probe (never meaningful)', async () => {
    const w = await seedWallet('WH');
    const hub = addr('HUB');
    // 201 distinct receivers -> degree above serviceDegreeThreshold (200).
    await prisma.moneyFlowEdge.createMany({
      data: Array.from({ length: 201 }, (_, i) => ({
        sourceAddress: hub, destinationAddress: addr(`RC${i}`), sourceChain: 'SOLANA' as const,
        destinationChain: 'SOLANA' as const, asset: 'SOL', amountToken: 1, amountUsd: 0,
        ts: new Date(T0.getTime() + i * 1000), txHash: addr(`TXH${i}`), actionType: 'transfer' as const,
        confidence: 100, providerSource: 'test', metadata: {}
      }))
    });
    await seedEdge({ from: hub, to: w.address, usd: 100, ts: new Date(T0.getTime() + 900_000), tx: 'TXHUB' });

    const r = await classifyWalletActivity(prisma, { chain: 'SOLANA', address: w.address });
    expect(r.byClass.service_interaction).toBe(1);
    expect(r.meaningfulCount).toBe(0);
    const row = await prisma.walletActivityClassification.findFirstOrThrow({
      where: { walletAddress: w.address, txHash: addr('TXHUB') }
    });
    expect(row.classification).toBe('service_interaction');
    expect((row.receiptsJson as { counterpartyServiceBasis: string }).counterpartyServiceBasis).toContain('fanout_degree');
  });

  it('reports truncation when the fetch bound is hit', async () => {
    const w = await seedWallet('WB');
    const tok = await seedToken('TKB');
    for (let i = 1; i <= 3; i++) {
      await seedTrade(w.id, tok.id, 'BUY', 10 + i, new Date(T0.getTime() + i * 1000), `TXB${i}`);
    }
    const r = await classifyWalletActivity(prisma, { chain: 'SOLANA', address: w.address }, { maxTrades: 2 });
    expect(r.tradesSeen).toBe(2);
    expect(r.tradesTruncated).toBe(true);
  });

  it('batch pass runs the behavior-profile cohort; one bad wallet never fails the batch', async () => {
    const w = await seedWallet('WC');
    const tok = await seedToken('TKC');
    await seedTrade(w.id, tok.id, 'BUY', 25, new Date(T0.getTime() + 1000), 'TXC1');
    for (const wa of [w.address, addr('GHQST')]) {
      await prisma.walletBehaviorProfile.create({
        data: {
          chain: 'SOLANA', walletAddress: wa, engineVersion: 1, dataQuality: 'local_only',
          computedAt: T0, profileJson: { local: { tokenPositions: [] } }
        }
      });
    }
    const batch = await runActivityClassification(prisma, {
      chain: 'SOLANA',
      walletAddresses: [w.address, addr('GHQST')]
    });
    expect(batch.walletsConsidered).toBe(2);
    expect(batch.walletsProcessed).toBe(2); // ghost wallet = zero rows, not an error
    expect(batch.errors).toBe(0);
    expect(batch.rowsWritten).toBe(1);
    expect(batch.byClass.meaningful_trade).toBe(1);
  });
});
