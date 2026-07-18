// FlowRadar — funding/reactivation path builder tests (dormancy Task 9).

import { describe, expect, it, afterAll, beforeEach } from 'vitest';
import net from 'node:net';
import { prisma } from '../../src/client';
import { buildAddressDormancyObservations } from '../../src/dormancy/addressDormancy';
import { buildFundingReactivationPaths } from '../../src/dormancy/fundingPaths';

const PREFIX = 'DRMFP'; // base58-safe (no 0/O/I/l)

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
  await prisma.fundingReactivationPath.deleteMany({ where: { walletAddress: { startsWith: PREFIX } } });
  await prisma.addressDormancyObservation.deleteMany({ where: { walletAddress: { startsWith: PREFIX } } });
  await prisma.walletActivityClassification.deleteMany({ where: { walletAddress: { startsWith: PREFIX } } });
  await prisma.walletBehaviorProfile.deleteMany({ where: { walletAddress: { startsWith: PREFIX } } });
  await prisma.walletRelationship.deleteMany({ where: { walletA: { address: { startsWith: PREFIX } } } });
  await prisma.lineageRoot.deleteMany({ where: { wallet: { address: { startsWith: PREFIX } } } });
  await prisma.moneyFlowEdge.deleteMany({
    where: { OR: [{ sourceAddress: { startsWith: PREFIX } }, { destinationAddress: { startsWith: PREFIX } }] }
  });
  await prisma.walletTokenTrade.deleteMany({ where: { txHash: { startsWith: PREFIX } } });
  await prisma.addressRegistry.deleteMany({ where: { address: { startsWith: PREFIX } } });
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

async function seedEdge(from: string, to: string, usd: number | null, ts: Date) {
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

async function seedProfileWithEntry(walletAddress: string, tokenAddress: string) {
  return prisma.walletBehaviorProfile.create({
    data: {
      chain: 'SOLANA', walletAddress, engineVersion: 1, dataQuality: 'local_only', computedAt: ENTRY,
      profileJson: { local: { tokenPositions: [{ tokenAddress, firstBuyTs: ENTRY.toISOString() }] } }
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

describe.skipIf(!dbReachable)('buildFundingReactivationPaths (Task 9 DB builder)', () => {
  it('traces direct + first funders, hop chain, delay and repeat count — strictly pre-event, idempotently', async () => {
    const main = await seedWallet('WA');
    const funder = await seedWallet('FA');
    const grand = addr('GA'); // funder's own funder (no wallet row needed)
    const entryTok = await seedToken();

    await seedEdge(grand, funder.address, 500, daysBefore(30)); // hop 2 (before hop-1 funding)
    await seedEdge(funder.address, main.address, 90, daysBefore(20)); // FIRST funding
    await seedEdge(funder.address, main.address, 120, hoursBefore(24)); // DIRECT (nearest)
    await seedEdge(funder.address, main.address, 999, new Date(ENTRY.getTime() + 1000)); // post-event: invisible
    await seedTrade(main.id, entryTok.id, 'BUY', 200, ENTRY);
    await seedProfileWithEntry(main.address, entryTok.address);

    await buildAddressDormancyObservations(prisma, { chain: 'SOLANA', walletAddresses: [main.address] });
    const r = await buildFundingReactivationPaths(prisma, { chain: 'SOLANA', walletAddresses: [main.address] });
    expect(r.errors).toBe(0);
    expect(r.pathsWritten).toBe(1);
    expect(r.byStatus.funded).toBe(1);

    const row = await prisma.fundingReactivationPath.findFirstOrThrow({ where: { walletAddress: main.address } });
    expect(row.status).toBe('funded');
    expect(row.directFunderAddress).toBe(funder.address);
    expect(row.directFundingTs?.toISOString()).toBe(hoursBefore(24).toISOString());
    expect(Number(row.directFundingValuedUsd)).toBe(120);
    expect(row.firstFunderAddress).toBe(funder.address);
    expect(row.firstFundingTs?.toISOString()).toBe(daysBefore(20).toISOString());
    expect(row.fundingToEventDelaySec).toBe(24 * 3600);
    expect(row.repeatFundingCount).toBe(1); // the daysBefore(20) prior funding
    const path = row.pathJson as { hop: number; address: string; fundedAddress: string }[];
    expect(path.some((h) => h.hop === 1 && h.address === funder.address)).toBe(true);
    expect(path.some((h) => h.hop === 2 && h.address === grand && h.fundedAddress === funder.address)).toBe(true);
    expect(row.pathDepth).toBe(2);

    // Idempotent rerun: no new rows.
    await buildFundingReactivationPaths(prisma, { chain: 'SOLANA', walletAddresses: [main.address] });
    expect(await prisma.fundingReactivationPath.count({ where: { walletAddress: main.address } })).toBe(1);
  });

  it('unknown-value funding is reported but NEVER treated as funding evidence', async () => {
    const main = await seedWallet('WB');
    const funder = await seedWallet('FB');
    const entryTok = await seedToken();

    await seedEdge(funder.address, main.address, null, hoursBefore(12)); // unknown value only
    await seedTrade(main.id, entryTok.id, 'BUY', 200, ENTRY);
    await seedProfileWithEntry(main.address, entryTok.address);

    await buildAddressDormancyObservations(prisma, { chain: 'SOLANA', walletAddresses: [main.address] });
    const r = await buildFundingReactivationPaths(prisma, { chain: 'SOLANA', walletAddresses: [main.address] });
    expect(r.byStatus.unknown_value_funding_only).toBe(1);

    const row = await prisma.fundingReactivationPath.findFirstOrThrow({ where: { walletAddress: main.address } });
    expect(row.status).toBe('unknown_value_funding_only');
    expect(row.directFunderAddress).toBeNull();
    expect(row.caveats.join(' ')).toContain('never treated as funding evidence');
    const receipts = row.receiptsJson as { unknownValueInboundPreEvent: number };
    expect(receipts.unknownValueInboundPreEvent).toBe(1);
  });

  it('dust-only inbound = no_meaningful_pre_event_funding; no history = no_transfer_history', async () => {
    const dusty = await seedWallet('WC');
    const bare = await seedWallet('WD');
    const tok1 = await seedToken();
    const tok2 = await seedToken();

    await seedEdge(addr('SPMR'), dusty.address, 0.5, daysBefore(5)); // dust only
    await seedTrade(dusty.id, tok1.id, 'BUY', 200, ENTRY);
    await seedProfileWithEntry(dusty.address, tok1.address);
    await seedTrade(bare.id, tok2.id, 'BUY', 200, ENTRY); // trades but no edges
    await seedProfileWithEntry(bare.address, tok2.address);

    await buildAddressDormancyObservations(prisma, { chain: 'SOLANA', walletAddresses: [dusty.address, bare.address] });
    const r = await buildFundingReactivationPaths(prisma, {
      chain: 'SOLANA',
      walletAddresses: [dusty.address, bare.address]
    });
    expect(r.byStatus.no_meaningful_pre_event_funding).toBe(1);
    expect(r.byStatus.no_transfer_history).toBe(1);
  });

  it('service funders are path TERMINALS — recorded but never expanded', async () => {
    const main = await seedWallet('WE');
    const entryTok = await seedToken();
    await prisma.addressRegistry.create({
      data: { chain: 'SOLANA', address: addr('CEXE'), category: 'CEX', label: 'test cex', source: 'test' }
    });
    // Capital "behind" the CEX must NOT be traced.
    await seedEdge(addr('BEHND'), addr('CEXE'), 9999, daysBefore(10));
    await seedEdge(addr('CEXE'), main.address, 300, hoursBefore(24));
    await seedTrade(main.id, entryTok.id, 'BUY', 200, ENTRY);
    await seedProfileWithEntry(main.address, entryTok.address);

    await buildAddressDormancyObservations(prisma, { chain: 'SOLANA', walletAddresses: [main.address] });
    await buildFundingReactivationPaths(prisma, { chain: 'SOLANA', walletAddresses: [main.address] });
    const row = await prisma.fundingReactivationPath.findFirstOrThrow({ where: { walletAddress: main.address } });
    expect(row.status).toBe('funded'); // funding through a service is still funding OF the wallet
    const path = row.pathJson as { hop: number; address: string; serviceNode: boolean }[];
    const cexHop = path.find((h) => h.address === addr('CEXE'));
    expect(cexHop?.serviceNode).toBe(true);
    expect(path.some((h) => h.address === addr('BEHND'))).toBe(false); // never expanded past the service
    expect(row.pathDepth).toBe(1);
  });

  it('funder relationship tier uses only pre-anchor relationships (neutral bands)', async () => {
    const main = await seedWallet('WF');
    const funder = await seedWallet('FF');
    const entryTok = await seedToken();
    await seedEdge(funder.address, main.address, 80, hoursBefore(24));
    await seedTrade(main.id, entryTok.id, 'BUY', 200, ENTRY);
    await seedProfileWithEntry(main.address, entryTok.address);
    const root = await prisma.lineageRoot.create({
      data: { walletId: main.id, source: 'test', firstImportedAt: daysBefore(365), lastSeenInImportAt: daysBefore(365) }
    });
    await prisma.walletRelationship.create({
      data: {
        lineageRootId: root.id, walletAId: funder.id, walletBId: main.id, kind: 'direct_funding' as never,
        confidence: 65, firstSeenAt: daysBefore(50), lastSeenAt: daysBefore(1), interactionCount: 2,
        valueTransferredUsd: 100, evidence: {}
      }
    });

    await buildAddressDormancyObservations(prisma, { chain: 'SOLANA', walletAddresses: [main.address] });
    await buildFundingReactivationPaths(prisma, { chain: 'SOLANA', walletAddresses: [main.address] });
    const row = await prisma.fundingReactivationPath.findFirstOrThrow({ where: { walletAddress: main.address } });
    expect(row.funderRelationshipTier).toBe('probable');
    expect(row.funderRelationshipConfidence).toBe(65);
    expect(row.reasonCodes).toContain('funder_has_pre_event_relationship');
  });
});
