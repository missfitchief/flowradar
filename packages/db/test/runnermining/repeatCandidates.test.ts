// FlowRadar — repeat/dormant-runner candidate builder tests (Tasks 11-12 DB).

import { describe, expect, it, afterAll, beforeEach } from 'vitest';
import net from 'node:net';
import { prisma } from '../../src/client';
import { buildAddressDormancyObservations } from '../../src/dormancy/addressDormancy';
import { buildEntityDormancyObservations } from '../../src/dormancy/entityDormancy';
import {
  groupCohortEntities,
  buildRepeatRunnerCandidates,
  buildDormantRunnerCandidates
} from '../../src/runnermining/repeatCandidates';

const PREFIX = 'DRMRC'; // base58-safe (no 0/O/I/l)

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
const addr = (s: string) => `${PREFIX}${s}`;

async function cleanup() {
  await prisma.dormantRunnerCandidate.deleteMany({ where: { entityKey: { startsWith: PREFIX } } });
  await prisma.repeatRunnerCandidate.deleteMany({ where: { entityKey: { startsWith: PREFIX } } });
  await prisma.entityDormancyObservation.deleteMany({ where: { walletAddress: { startsWith: PREFIX } } });
  await prisma.addressDormancyObservation.deleteMany({ where: { walletAddress: { startsWith: PREFIX } } });
  await prisma.walletActivityClassification.deleteMany({ where: { walletAddress: { startsWith: PREFIX } } });
  await prisma.walletBehaviorProfile.deleteMany({ where: { walletAddress: { startsWith: PREFIX } } });
  await prisma.walletRelationship.deleteMany({ where: { walletA: { address: { startsWith: PREFIX } } } });
  await prisma.lineageRoot.deleteMany({ where: { wallet: { address: { startsWith: PREFIX } } } });
  await prisma.moneyFlowEdge.deleteMany({
    where: { OR: [{ sourceAddress: { startsWith: PREFIX } }, { destinationAddress: { startsWith: PREFIX } }] }
  });
  await prisma.walletTokenTrade.deleteMany({ where: { txHash: { startsWith: PREFIX } } });
  await prisma.tokenLifecycle.deleteMany({ where: { mint: { startsWith: PREFIX } } });
  await prisma.cohortMatch.deleteMany({ where: { runnerMint: { startsWith: PREFIX } } });
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

async function seedRunnerLifecycle(mint: string) {
  return prisma.tokenLifecycle.create({
    data: {
      mint, enteredUniverseAt: daysBefore(365), sourcesJson: {}, coverage: 'covered',
      runnerClass: 'verified_above_10m', confidence: 'high', classifiedAt: daysBefore(1)
    }
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

async function seedProfile(walletAddress: string, entries: { tokenAddress: string; firstBuyTs: string }[]) {
  return prisma.walletBehaviorProfile.create({
    data: {
      chain: 'SOLANA', walletAddress, engineVersion: 1, dataQuality: 'local_only', computedAt: ENTRY,
      profileJson: { local: { tokenPositions: entries } }
    }
  });
}

async function seedRelationship(rootWalletId: string, aId: string, bId: string, confidence: number) {
  const root = await prisma.lineageRoot.upsert({
    where: { walletId: rootWalletId },
    create: { walletId: rootWalletId, source: 'test', firstImportedAt: daysBefore(365), lastSeenInImportAt: daysBefore(365) },
    update: {}
  });
  return prisma.walletRelationship.create({
    data: {
      lineageRootId: root.id, walletAId: aId, walletBId: bId, kind: 'direct_funding' as never, confidence,
      firstSeenAt: daysBefore(200), lastSeenAt: daysBefore(1), interactionCount: 2,
      valueTransferredUsd: 100, evidence: {}
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

describe.skipIf(!dbReachable)('groupCohortEntities (entity adjustment)', () => {
  it('merges probable/strong-linked cohort wallets; possible links never merge', async () => {
    const a = await seedWallet('EA');
    const b = await seedWallet('EB');
    const c = await seedWallet('EC');
    await seedRelationship(a.id, a.id, b.id, 70); // probable: merge
    await seedRelationship(a.id, a.id, c.id, 30); // possible: NO merge

    const r = await groupCohortEntities(prisma, 'SOLANA', [a.address, b.address, c.address]);
    expect(r.allComplete).toBe(true);
    expect(r.groups).toHaveLength(2);
    const merged = r.groups.find((g) => g.members.length === 2);
    expect(merged?.members).toEqual([a.address, b.address].sort());
    expect(merged?.entityKey).toBe([a.address, b.address].sort()[0]);
    expect(merged?.entityAdjusted).toBe(true);
  });

  it('closes the component BEYOND the input batch — canonical keys are batch-independent', async () => {
    const a = await seedWallet('FA');
    const b = await seedWallet('FB'); // NOT in the input batch, linked to A
    await seedRelationship(a.id, a.id, b.id, 80);

    const r = await groupCohortEntities(prisma, 'SOLANA', [a.address]); // batch = A only
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0].members).toEqual([a.address, b.address].sort());
    expect(r.groups[0].entityKey).toBe([a.address, b.address].sort()[0]);

    // The same component from B's side yields the SAME canonical key.
    const r2 = await groupCohortEntities(prisma, 'SOLANA', [b.address]);
    expect(r2.groups[0].entityKey).toBe(r.groups[0].entityKey);
  });

  it('a TRUNCATED component degrades to deterministic singletons — never a batch-dependent merged identity', async () => {
    // A component larger than the member cap: hub H linked to A plus 3 others.
    const a = await seedWallet('HA');
    const hub = await seedWallet('HB');
    await seedRelationship(a.id, a.id, hub.id, 80);
    for (const suffix of ['HC', 'HD', 'HE']) {
      const other = await seedWallet(suffix);
      await seedRelationship(a.id, hub.id, other.id, 80);
    }

    const r = await groupCohortEntities(prisma, 'SOLANA', [a.address], { maxClosureWallets: 3 });
    expect(r.allComplete).toBe(false);
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0].entityKey).toBe(a.address); // singleton keyed by the wallet itself
    expect(r.groups[0].members).toEqual([a.address]);
    expect(r.groups[0].groupingComplete).toBe(false);

    // Deterministic regardless of batch composition.
    const r2 = await groupCohortEntities(prisma, 'SOLANA', [a.address, hub.address], { maxClosureWallets: 3 });
    expect(r2.groups.map((g) => g.entityKey).sort()).toEqual([a.address, hub.address].sort());
    expect(r2.groups.every((g) => g.members.length === 1 && !g.groupingComplete)).toBe(true);
  });
});

describe.skipIf(!dbReachable)('buildRepeatRunnerCandidates (Task 11 DB builder)', () => {
  it('linked wallets NEVER count as independent repeats — entity-adjusted exposure, idempotent', async () => {
    const a = await seedWallet('WA');
    const b = await seedWallet('WB');
    const run1 = await seedToken();
    const run2 = await seedToken();
    await seedRunnerLifecycle(run1.address);
    await seedRunnerLifecycle(run2.address);
    await seedRelationship(a.id, a.id, b.id, 75); // probable link: one entity
    // Wallet A entered runner1, wallet B entered runner2 — as ONE entity this
    // is 2 distinct runners; as independent wallets each would be single-runner.
    await seedTrade(a.id, run1.id, 'BUY', 100, ENTRY);
    await seedTrade(b.id, run2.id, 'BUY', 100, ENTRY);
    await seedProfile(a.address, [{ tokenAddress: run1.address, firstBuyTs: ENTRY.toISOString() }]);
    await seedProfile(b.address, [{ tokenAddress: run2.address, firstBuyTs: ENTRY.toISOString() }]);

    const r = await buildRepeatRunnerCandidates(prisma, {
      chain: 'SOLANA',
      walletAddresses: [a.address, b.address]
    });
    expect(r.errors).toBe(0);
    expect(r.entitiesConsidered).toBe(1); // merged
    expect(r.entityAdjustedCount).toBe(1);
    expect(r.byStatus.candidate).toBe(1);

    const entityKey = [a.address, b.address].sort()[0];
    const row = await prisma.repeatRunnerCandidate.findUniqueOrThrow({
      where: { chain_entityKey: { chain: 'SOLANA', entityKey } }
    });
    expect(row.distinctRunnersEntered).toBe(2);
    expect(row.entityAdjusted).toBe(true);
    expect(row.memberWallets).toEqual([a.address, b.address].sort());
    expect(row.score).not.toBeNull();
    expect(Number(row.score)).toBeLessThanOrEqual(85);
    expect(row.caveats.join(' ')).toContain('grants no votes');

    // Idempotent rerun.
    await buildRepeatRunnerCandidates(prisma, { chain: 'SOLANA', walletAddresses: [a.address, b.address] });
    expect(await prisma.repeatRunnerCandidate.count({ where: { entityKey: { startsWith: PREFIX } } })).toBe(1);
  });

  it('stale rows keyed by non-canonical member addresses are purged after re-grouping', async () => {
    const a = await seedWallet('GA');
    const b = await seedWallet('GB');
    // Simulate an OLD batch that saw B alone (stale row keyed by B).
    await prisma.repeatRunnerCandidate.create({
      data: {
        chain: 'SOLANA', entityKey: b.address, memberWallets: [b.address], entityAdjusted: false,
        status: 'insufficient_evidence', reasonCodes: [], receiptsJson: {}, caveats: [],
        scoreBasis: [], engineVersion: 1, computedAt: daysBefore(1)
      }
    });
    await seedRelationship(a.id, a.id, b.id, 80); // now linked
    await seedProfile(a.address, []);
    await seedProfile(b.address, []);

    await buildRepeatRunnerCandidates(prisma, { chain: 'SOLANA', walletAddresses: [a.address, b.address] });
    const canonical = [a.address, b.address].sort()[0];
    const rows = await prisma.repeatRunnerCandidate.findMany({ where: { entityKey: { startsWith: PREFIX } } });
    expect(rows).toHaveLength(1); // the stale B-keyed row is GONE
    expect(rows[0].entityKey).toBe(canonical);
    expect(rows[0].memberWallets).toEqual([a.address, b.address].sort());
  });

  it('bot cadence and market-maker shapes EXCLUDE the entity (receipts reachable through the builder)', async () => {
    const w = await seedWallet('WBOT');
    const run1 = await seedToken();
    const run2 = await seedToken();
    const mmTok = await seedToken();
    await seedRunnerLifecycle(run1.address);
    await seedRunnerLifecycle(run2.address);
    // 24 alternating trades, constant 120s cadence, one token:
    // bot (cv=0 < 0.25, mean 120 < 600) AND market-maker (12 buys / 12 sells).
    for (let i = 0; i < 24; i++) {
      await seedTrade(w.id, mmTok.id, i % 2 ? 'SELL' : 'BUY', 50, new Date(ENTRY.getTime() - (24 - i) * 120_000));
    }
    // Qualifying runner exposure that WOULD be a candidate without exclusion.
    await seedTrade(w.id, run1.id, 'BUY', 100, ENTRY);
    await seedTrade(w.id, run2.id, 'BUY', 100, ENTRY);
    await seedProfile(w.address, [
      { tokenAddress: run1.address, firstBuyTs: ENTRY.toISOString() },
      { tokenAddress: run2.address, firstBuyTs: ENTRY.toISOString() }
    ]);

    const r = await buildRepeatRunnerCandidates(prisma, { chain: 'SOLANA', walletAddresses: [w.address] });
    expect(r.byStatus.excluded_negative_evidence).toBe(1);
    const row = await prisma.repeatRunnerCandidate.findFirstOrThrow({ where: { entityKey: w.address } });
    expect(row.status).toBe('excluded_negative_evidence');
    const neg = row.negativeEvidenceJson as { classes: string[] };
    expect(neg.classes).toContain('bot_or_arbitrage');
    expect(neg.classes).toContain('market_maker_or_service');
    expect(row.score).toBeNull();
  });

  it('launch-team destructive exits EXCLUDE (cross-wallet receipts over member trades + transfers)', async () => {
    const t1 = await seedWallet('LT1');
    const t2 = await seedWallet('LT2');
    const t3 = await seedWallet('LT3');
    const pump = await seedToken();
    const run1 = await seedToken();
    const run2 = await seedToken();
    await seedRunnerLifecycle(run1.address);
    await seedRunnerLifecycle(run2.address);
    // One entity: probable links among the three.
    await seedRelationship(t1.id, t1.id, t2.id, 75);
    await seedRelationship(t1.id, t1.id, t3.id, 75);
    // Same-block launch cluster on PUMP (slots 100-102) + T1 funded T3 + T3
    // burst-exits >=90% within 60s.
    const launch = daysBefore(2);
    await prisma.walletTokenTrade.createMany({
      data: [
        { walletId: t1.id, tokenId: pump.id, chain: 'SOLANA', action: 'BUY', amountToken: '10', amountUsd: '100', txHash: addr('LTX1'), blockOrSlot: 100n, ts: launch, priceUsd: '1', marketCapAtTrade: '100000', walletScoreAtTime: 50, provider: 'test' },
        { walletId: t2.id, tokenId: pump.id, chain: 'SOLANA', action: 'BUY', amountToken: '10', amountUsd: '100', txHash: addr('LTX2'), blockOrSlot: 101n, ts: new Date(launch.getTime() + 1000), priceUsd: '1', marketCapAtTrade: '100000', walletScoreAtTime: 50, provider: 'test' },
        { walletId: t3.id, tokenId: pump.id, chain: 'SOLANA', action: 'BUY', amountToken: '10', amountUsd: '1000', txHash: addr('LTX3'), blockOrSlot: 102n, ts: new Date(launch.getTime() + 2000), priceUsd: '1', marketCapAtTrade: '100000', walletScoreAtTime: 50, provider: 'test' },
        { walletId: t3.id, tokenId: pump.id, chain: 'SOLANA', action: 'SELL', amountToken: '10', amountUsd: '950', txHash: addr('LTX4'), blockOrSlot: 9000n, ts: daysBefore(1), priceUsd: '1', marketCapAtTrade: '100000', walletScoreAtTime: 50, provider: 'test' },
        { walletId: t3.id, tokenId: pump.id, chain: 'SOLANA', action: 'SELL', amountToken: '10', amountUsd: '40', txHash: addr('LTX5'), blockOrSlot: 9001n, ts: new Date(daysBefore(1).getTime() + 5000), priceUsd: '1', marketCapAtTrade: '100000', walletScoreAtTime: 50, provider: 'test' }
      ]
    });
    await prisma.moneyFlowEdge.create({
      data: {
        sourceAddress: t1.address, destinationAddress: t3.address, sourceChain: 'SOLANA', destinationChain: 'SOLANA',
        asset: 'SOL', amountToken: 1, amountUsd: 0, ts: daysBefore(3), txHash: addr('LTXF'), actionType: 'transfer',
        confidence: 100, providerSource: 'test', metadata: {}, valuedUsd: '500', valuationConfidence: 90
      }
    });
    // Qualifying runner exposure spread across members.
    await seedTrade(t1.id, run1.id, 'BUY', 100, ENTRY);
    await seedTrade(t2.id, run2.id, 'BUY', 100, ENTRY);
    await seedProfile(t1.address, [{ tokenAddress: run1.address, firstBuyTs: ENTRY.toISOString() }]);
    await seedProfile(t2.address, [{ tokenAddress: run2.address, firstBuyTs: ENTRY.toISOString() }]);
    await seedProfile(t3.address, []);

    // Cap-crowding regression: 3 NEWER self-transfers + a tight cap must not
    // displace the older member-to-member funding edge (self-edges are
    // excluded IN-QUERY, before the cap).
    for (let i = 1; i <= 3; i++) {
      await prisma.moneyFlowEdge.create({
        data: {
          sourceAddress: t1.address, destinationAddress: t1.address, sourceChain: 'SOLANA', destinationChain: 'SOLANA',
          asset: 'SOL', amountToken: 1, amountUsd: 0, ts: new Date(ENTRY.getTime() - i * 3600_000),
          txHash: addr(`LTS${i}`), actionType: 'transfer', confidence: 100, providerSource: 'test', metadata: {},
          valuedUsd: '5', valuationConfidence: 90
        }
      });
    }

    const r = await buildRepeatRunnerCandidates(prisma, {
      chain: 'SOLANA',
      walletAddresses: [t1.address, t2.address, t3.address],
      maxMemberTransfers: 2
    });
    expect(r.byStatus.excluded_negative_evidence).toBe(1);
    const row = await prisma.repeatRunnerCandidate.findFirstOrThrow({ where: { entityKey: { startsWith: PREFIX } } });
    const neg = row.negativeEvidenceJson as { classes: string[] };
    expect(neg.classes).toContain('launch_team_linked_destructive_exit');
  });

  it('high rug exposure EXCLUDES — outcomes come from token_lifecycles, never inferred', async () => {
    const w = await seedWallet('WRUG');
    const rug1 = await seedToken();
    const rug2 = await seedToken();
    const flat1 = await seedToken();
    // 2 of 3 known outcomes are rugs (share 0.67 >= 0.5).
    for (const [tok, labels] of [
      [rug1, ['rug_or_collapse']],
      [rug2, ['rug_or_collapse']],
      [flat1, []]
    ] as const) {
      await prisma.tokenLifecycle.create({
        data: {
          mint: tok.address, enteredUniverseAt: daysBefore(365), sourcesJson: {}, coverage: 'covered',
          runnerClass: 'verified_below_10m', outcomeLabels: labels as unknown as object,
          confidence: 'high', classifiedAt: daysBefore(1)
        }
      });
    }
    for (const tok of [rug1, rug2, flat1]) await seedTrade(w.id, tok.id, 'BUY', 100, daysBefore(30));
    await seedProfile(w.address, [{ tokenAddress: rug1.address, firstBuyTs: daysBefore(30).toISOString() }]);

    const r = await buildRepeatRunnerCandidates(prisma, { chain: 'SOLANA', walletAddresses: [w.address] });
    expect(r.byStatus.excluded_negative_evidence).toBe(1);
    const row = await prisma.repeatRunnerCandidate.findFirstOrThrow({ where: { entityKey: w.address } });
    const neg = row.negativeEvidenceJson as { classes: string[] };
    expect(neg.classes).toContain('high_rug_exposure');
    expect(row.status).toBe('excluded_negative_evidence'); // exclusion outranks any exposure math
  });

  it('single-runner exposure stays insufficient_evidence (small-N honesty)', async () => {
    const w = await seedWallet('WC');
    const run1 = await seedToken();
    const other = await seedToken();
    await seedRunnerLifecycle(run1.address);
    await seedTrade(w.id, run1.id, 'BUY', 100, ENTRY);
    await seedTrade(w.id, other.id, 'BUY', 100, ENTRY);
    await seedProfile(w.address, [
      { tokenAddress: run1.address, firstBuyTs: ENTRY.toISOString() },
      { tokenAddress: other.address, firstBuyTs: ENTRY.toISOString() }
    ]);

    const r = await buildRepeatRunnerCandidates(prisma, { chain: 'SOLANA', walletAddresses: [w.address] });
    expect(r.byStatus.insufficient_evidence).toBe(1);
    const row = await prisma.repeatRunnerCandidate.findFirstOrThrow({ where: { entityKey: w.address } });
    expect(row.status).toBe('insufficient_evidence');
    expect(row.score).toBeNull();
    expect(row.otherTokensEntered).toBe(1);
  });
});

describe.skipIf(!dbReachable)('buildDormantRunnerCandidates (Task 12 DB builder)', () => {
  it('one dormant runner entry = one_off; never a pattern from one event', async () => {
    const w = await seedWallet('WD');
    const oldTok = await seedToken();
    const run1 = await seedToken();
    await seedRunnerLifecycle(run1.address);
    await seedTrade(w.id, oldTok.id, 'BUY', 100, daysBefore(200)); // coverage anchor
    await seedTrade(w.id, run1.id, 'BUY', 200, ENTRY);
    await seedProfile(w.address, [{ tokenAddress: run1.address, firstBuyTs: ENTRY.toISOString() }]);

    await buildAddressDormancyObservations(prisma, { chain: 'SOLANA', walletAddresses: [w.address] });
    await buildEntityDormancyObservations(prisma, { chain: 'SOLANA', walletAddresses: [w.address] });
    const r = await buildDormantRunnerCandidates(prisma, { chain: 'SOLANA', walletAddresses: [w.address] });
    expect(r.errors).toBe(0);
    expect(r.byPattern.one_off).toBe(1);

    const row = await prisma.dormantRunnerCandidate.findFirstOrThrow({ where: { entityKey: w.address } });
    expect(row.pattern).toBe('one_off');
    expect(row.dormantEntryEvents).toBe(1);
    expect(row.reasonCodes).toContain('single_qualifying_event_never_a_pattern');

    // Idempotent rerun.
    await buildDormantRunnerCandidates(prisma, { chain: 'SOLANA', walletAddresses: [w.address] });
    expect(await prisma.dormantRunnerCandidate.count({ where: { entityKey: { startsWith: PREFIX } } })).toBe(1);
  });

  it('repeated covered-dormant entries across DISTINCT runners = repeated_independent_dormant', async () => {
    const w = await seedWallet('WE');
    const oldTok = await seedToken();
    const run1 = await seedToken();
    const run2 = await seedToken();
    await seedRunnerLifecycle(run1.address);
    await seedRunnerLifecycle(run2.address);
    const entry2 = new Date(ENTRY.getTime() + 60 * 86_400_000);
    await seedTrade(w.id, oldTok.id, 'BUY', 100, daysBefore(200));
    await seedTrade(w.id, run1.id, 'BUY', 200, ENTRY);
    await seedTrade(w.id, run2.id, 'BUY', 200, entry2);
    await seedProfile(w.address, [
      { tokenAddress: run1.address, firstBuyTs: ENTRY.toISOString() },
      { tokenAddress: run2.address, firstBuyTs: entry2.toISOString() }
    ]);

    await buildAddressDormancyObservations(prisma, { chain: 'SOLANA', walletAddresses: [w.address] });
    await buildEntityDormancyObservations(prisma, { chain: 'SOLANA', walletAddresses: [w.address] });
    const r = await buildDormantRunnerCandidates(prisma, { chain: 'SOLANA', walletAddresses: [w.address] });
    expect(r.byPattern.repeated_independent_dormant).toBe(1);

    const row = await prisma.dormantRunnerCandidate.findFirstOrThrow({ where: { entityKey: w.address } });
    expect(row.pattern).toBe('repeated_independent_dormant');
    expect(row.distinctRunnerTokens).toBe(2);
    expect(row.confidence).toBeLessThanOrEqual(85);
    const events = row.eventsJson as { token: string; addressClass: string }[];
    expect(events).toHaveLength(2);
    expect(row.caveats.join(' ')).toContain('never claimed from one event');
  });

  it('entities without runner entries stay insufficient_evidence with honest zero counts', async () => {
    const w = await seedWallet('WF');
    const other = await seedToken();
    await seedTrade(w.id, other.id, 'BUY', 100, ENTRY);
    await seedProfile(w.address, [{ tokenAddress: other.address, firstBuyTs: ENTRY.toISOString() }]);

    const r = await buildDormantRunnerCandidates(prisma, { chain: 'SOLANA', walletAddresses: [w.address] });
    expect(r.byPattern.insufficient_evidence).toBe(1);
    const row = await prisma.dormantRunnerCandidate.findFirstOrThrow({ where: { entityKey: w.address } });
    expect(row.dormantEntryEvents).toBe(0);
    expect(row.distinctRunnerTokens).toBe(0);
  });
});
