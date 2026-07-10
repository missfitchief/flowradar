// FlowRadar — receiver enrollment integration tests (Capital Lineage 6b).
// The operator's load-bearing scenarios, end to end through the DB.

import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import net from 'node:net';
import { DEFAULT_SETTINGS } from '@flowradar/core';
import { prisma } from '../../src/client';
import { enrollReceiverFromTransfer, type TransferObservation } from '../../src/lineage/enrollReceiver';

const PREFIX = 'ENROLLTEST';
const NOW = new Date('2026-07-10T12:00:00Z');

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

let dbReachable = false;
beforeAll(async () => {
  dbReachable = await probePort('localhost', 5439);
});

async function cleanup() {
  await prisma.moneyFlowEdge.deleteMany({ where: { OR: [{ sourceAddress: { startsWith: PREFIX } }, { destinationAddress: { startsWith: PREFIX } }] } });
  await prisma.walletRelationship.deleteMany({ where: { lineageRoot: { wallet: { address: { startsWith: PREFIX } } } } });
  await prisma.lineageExpansionNode.deleteMany({ where: { lineageRoot: { wallet: { address: { startsWith: PREFIX } } } } });
  await prisma.addressRegistry.deleteMany({ where: { address: { startsWith: PREFIX } } });
  await prisma.wallet.deleteMany({ where: { address: { startsWith: PREFIX } } });
}

afterAll(async () => {
  if (!dbReachable) return;
  await cleanup();
  await prisma.$disconnect();
});
beforeEach(async () => {
  if (!dbReachable) return;
  await cleanup();
});

/** Creates a lineage root wallet (the trusted sender) and returns ids. */
async function makeRoot(suffix: string, status = 'observation_only') {
  const wallet = await prisma.wallet.create({
    data: { address: `${PREFIX}_root_${suffix}`, chain: 'SOLANA', firstSeenAt: NOW, lastActiveAt: NOW, status: status as never }
  });
  const root = await prisma.lineageRoot.create({
    data: { walletId: wallet.id, source: 'operator_file', permanent: true, firstImportedAt: NOW, lastSeenInImportAt: NOW }
  });
  return { wallet, root };
}

function transfer(over: Partial<TransferObservation> & { fromAddress: string; toAddress: string }): TransferObservation {
  return {
    txHash: `${PREFIX}_tx_${Math.abs(hashCode(over.toAddress + (over.txHash ?? '')))}`,
    slot: 100n,
    ts: NOW,
    asset: 'SOL',
    amountToken: 5,
    amountUsd: 1000,
    isNativeSol: true,
    provider: 'test',
    ...over
  };
}
function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

describe.skipIf(!(await probePort('localhost', 5439)))('enrollReceiverFromTransfer', () => {
  it('SCENARIO 1: root funds fresh B — edge persisted, B observation_only, fresh_receiver_hot subscription, zero smart weight', async () => {
    const { wallet: rootWallet, root } = await makeRoot('s1');
    const receiver = `${PREFIX}_freshB_s1`;

    const result = await enrollReceiverFromTransfer(
      prisma,
      transfer({ fromAddress: rootWallet.address, toAddress: receiver, amountUsd: 1000 }),
      root.id,
      0,
      DEFAULT_SETTINGS,
      NOW
    );

    expect(result.edgePersisted).toBe(true);
    expect(result.enrolled).toBe(true);
    expect(result.relationshipKind).toBe('first_funder');

    const b = await prisma.wallet.findUnique({
      where: { address_chain: { address: receiver, chain: 'SOLANA' } },
      include: { monitoringSubscriptions: true }
    });
    expect(b!.status).toBe('observation_only'); // never signal_eligible
    expect(b!.isWatched).toBe(false);
    expect(b!.monitoringSubscriptions.some((s) => s.priority === 'fresh_receiver_hot' && s.active)).toBe(true);

    const edge = await prisma.moneyFlowEdge.findFirst({ where: { destinationAddress: receiver } });
    expect(edge).not.toBeNull();
    const rel = await prisma.walletRelationship.findFirst({ where: { walletBId: b!.id } });
    expect(rel!.kind).toBe('first_funder');
    expect(rel!.confidence).toBeGreaterThanOrEqual(50);
  });

  it('SCENARIO 3: tiny FIRST gas funding enrolls only with first-funding + activation evidence', async () => {
    const { wallet: rootWallet, root } = await makeRoot('s3');
    const receiver = `${PREFIX}_gasB_s3`;
    // Pre-create receiver WITH a trade so "became active" is true.
    const b = await prisma.wallet.create({
      data: { address: receiver, chain: 'SOLANA', firstSeenAt: NOW, lastActiveAt: NOW, status: 'observation_only' }
    });
    const tok = await prisma.token.create({
      data: { chain: 'SOLANA', address: `${PREFIX}_tok_s3`, symbol: 'GAS', name: 't', decimals: 9, firstSeenAt: NOW, riskFlags: [] }
    });
    await prisma.walletTokenTrade.create({
      data: { walletId: b.id, tokenId: tok.id, chain: 'SOLANA', action: 'BUY', amountToken: 1, amountUsd: 100, txHash: `${PREFIX}_activetrade`, blockOrSlot: 1n, ts: NOW, priceUsd: 100, marketCapAtTrade: 1000, walletScoreAtTime: 0, provider: 'test' }
    });

    const result = await enrollReceiverFromTransfer(
      prisma,
      transfer({ fromAddress: rootWallet.address, toAddress: receiver, amountUsd: 5, isNativeSol: true }),
      root.id,
      0,
      DEFAULT_SETTINGS,
      NOW
    );
    // freshInactive check: b has a trade + lastActiveAt=NOW so it's not fresh;
    // gas exception still requires fresh/inactive — this proves an ALREADY
    // active wallet is not hot-enrolled by a tiny transfer.
    expect(result.enrolled).toBe(false);

    // Cleanup the token created here (prefix-scoped afterAll won't catch it via wallet).
    await prisma.walletTokenTrade.deleteMany({ where: { tokenId: tok.id } });
    await prisma.token.delete({ where: { id: tok.id } });
  });

  it('SCENARIO 4: unknown inbound dust does not enroll or form a strong relationship, but stores the edge', async () => {
    const { wallet: rootWallet, root } = await makeRoot('s4');
    const receiver = `${PREFIX}_dustB_s4`;

    const result = await enrollReceiverFromTransfer(
      prisma,
      transfer({ fromAddress: rootWallet.address, toAddress: receiver, amountUsd: 0.5, isNativeSol: false }),
      root.id,
      0,
      DEFAULT_SETTINGS,
      NOW
    );
    expect(result.enrolled).toBe(false);
    expect(result.dust).toBe(true);
    expect(result.edgePersisted).toBe(true);
    const rel = await prisma.walletRelationship.count({ where: { lineageRootId: root.id } });
    expect(rel).toBe(0);
  });

  it('SCENARIO 5: router/pool/bridge/CEX receiver — edge stored, node NOT enrolled/expanded', async () => {
    const { wallet: rootWallet, root } = await makeRoot('s5');
    const service = `${PREFIX}_router_s5`;
    await prisma.addressRegistry.create({
      data: { address: service, chain: 'SOLANA', category: 'ROUTER', label: 'test router', doNotExpand: true, source: 'test' }
    });

    const result = await enrollReceiverFromTransfer(
      prisma,
      transfer({ fromAddress: rootWallet.address, toAddress: service, amountUsd: 5000 }),
      root.id,
      0,
      DEFAULT_SETTINGS,
      NOW
    );
    expect(result.enrolled).toBe(false);
    expect(result.reason).toMatch(/service/i);
    expect(result.edgePersisted).toBe(true);
    const node = await prisma.lineageExpansionNode.count({ where: { walletAddress: service } });
    expect(node).toBe(0);
  });

  it('SCENARIO 6: duplicate transaction does not inflate edge or relationship counts', async () => {
    const { wallet: rootWallet, root } = await makeRoot('s6');
    const receiver = `${PREFIX}_dupB_s6`;
    const t = transfer({ fromAddress: rootWallet.address, toAddress: receiver, amountUsd: 1000, txHash: 'FIXED' });

    await enrollReceiverFromTransfer(prisma, t, root.id, 0, DEFAULT_SETTINGS, NOW);
    const second = await enrollReceiverFromTransfer(prisma, t, root.id, 0, DEFAULT_SETTINGS, NOW);

    expect(second.edgePersisted).toBe(false); // edge dedup: no second edge row
    const edges = await prisma.moneyFlowEdge.count({ where: { destinationAddress: receiver } });
    expect(edges).toBe(1);
    // Exactly ONE relationship row AND its interactionCount is NOT inflated by
    // the replay — enforced by TX-IDENTITY idempotency (a txHash already in
    // the relationship's evidence never bumps count/value again), which also
    // means an ingest-preexisting edge cannot suppress a genuinely new
    // transfer's enrollment (Codex round-2).
    const rel = await prisma.walletRelationship.findFirst({ where: { walletB: { address: receiver } } });
    expect(rel!.interactionCount).toBe(1);
    expect(Number(rel!.valueTransferredUsd)).toBe(1000);
  });

  it('IDEMPOTENCY: an edge pre-written by normal ingest does NOT suppress enrollment of a genuinely new transfer', async () => {
    const { wallet: rootWallet, root } = await makeRoot('ingest');
    const receiver = `${PREFIX}_ingestB`;
    const t = transfer({ fromAddress: rootWallet.address, toAddress: receiver, amountUsd: 1000, txHash: 'INGESTED' });
    // Simulate normal wallet-activity ingest writing the edge first.
    await prisma.moneyFlowEdge.create({
      data: {
        sourceAddress: t.fromAddress, destinationAddress: t.toAddress, sourceChain: 'SOLANA', destinationChain: 'SOLANA',
        asset: 'SOL', amountToken: 5, amountUsd: 1000, ts: t.ts, txHash: t.txHash, actionType: 'transfer',
        confidence: 100, providerSource: 'ingest', metadata: {}
      }
    });

    const result = await enrollReceiverFromTransfer(prisma, t, root.id, 0, DEFAULT_SETTINGS, NOW);
    expect(result.edgePersisted).toBe(false); // ingest already wrote it
    expect(result.enrolled).toBe(true); // ...but enrollment still happens
    const b = await prisma.wallet.findUnique({ where: { address_chain: { address: receiver, chain: 'SOLANA' } } });
    expect(b!.status).toBe('observation_only');
    const rel = await prisma.walletRelationship.findFirst({ where: { walletB: { address: receiver } } });
    expect(rel).not.toBeNull();
  });

  it('SCENARIO 11+12: a linked receiver never becomes signal_eligible; an existing public_kol receiver keeps its status', async () => {
    const { wallet: rootWallet, root } = await makeRoot('s11');
    const kolReceiver = `${PREFIX}_kolB_s11`;
    await prisma.wallet.create({
      data: { address: kolReceiver, chain: 'SOLANA', firstSeenAt: NOW, lastActiveAt: new Date(NOW.getTime() - 100 * 864e5), status: 'public_kol' }
    });

    await enrollReceiverFromTransfer(
      prisma,
      transfer({ fromAddress: rootWallet.address, toAddress: kolReceiver, amountUsd: 1000 }),
      root.id,
      0,
      DEFAULT_SETTINGS,
      NOW
    );
    const b = await prisma.wallet.findUnique({ where: { address_chain: { address: kolReceiver, chain: 'SOLANA' } } });
    expect(b!.status).toBe('public_kol'); // classification survives enrollment
    expect(b!.status).not.toBe('signal_eligible');
  });

  it('untrusted sender does not enroll', async () => {
    const sender = await prisma.wallet.create({
      data: { address: `${PREFIX}_untrusted`, chain: 'SOLANA', firstSeenAt: NOW, lastActiveAt: NOW, status: 'observation_only' }
    });
    const { root } = await makeRoot('untrusted_root');
    const receiver = `${PREFIX}_recvU`;
    const result = await enrollReceiverFromTransfer(
      prisma,
      transfer({ fromAddress: sender.address, toAddress: receiver, amountUsd: 1000 }),
      root.id,
      0,
      DEFAULT_SETTINGS,
      NOW
    );
    expect(result.enrolled).toBe(false);
    expect(result.reason).toMatch(/untrusted/i);
  });
});
