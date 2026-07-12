// FlowRadar — entity-dormancy tests (dormancy Task 8): pure decision branches
// + DB builder integration (links, service exclusion, receipts, idempotency,
// no-lookahead, unknown-never-evidence).

import { describe, expect, it, afterAll, beforeEach } from 'vitest';
import net from 'node:net';
import { prisma } from '../../src/client';
import { buildAddressDormancyObservations } from '../../src/dormancy/addressDormancy';
import {
  buildEntityDormancyObservations,
  classifyEntityDormancyDecision
} from '../../src/dormancy/entityDormancy';
import type { EntityLinkAssessment } from '../../src/dormancy/entityDormancy';

const PREFIX = 'DRMEN'; // base58-safe (no 0/O/I/l)

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

// ---------------------------------------------------------------------------
// Pure decision branches
// ---------------------------------------------------------------------------

function link(over: Partial<EntityLinkAssessment> = {}): EntityLinkAssessment {
  return {
    counterpartyAddress: addr('CP'),
    tier: 'probable',
    kinds: ['direct_funding'],
    confidence: 70,
    linkedActivity: 'active_pre_event',
    linkedMeaningfulPreEventCount: 3,
    fundedTargetNearEvent: false,
    unknownValueFundingNearEvent: false,
    isFunder: false,
    unknownValueTransfers: 0,
    dustTransfers: 0,
    evidence: { txHashes: [], relationshipIds: [], edgeIds: [], receiptClassifications: [] },
    ...over
  };
}

const baseInput = {
  serviceNodesExcluded: 0,
  linkDiscoveryComplete: true,
  addressRecentlyReactivated: false
};

describe('classifyEntityDormancyDecision (pure)', () => {
  it('active address = active_entity; recently-reactivated + funded probable link = probable_side_wallet_reactivation', () => {
    expect(classifyEntityDormancyDecision({ ...baseInput, addressClass: 'active', links: [] }).entityClass)
      .toBe('active_entity');
    const reactivated = classifyEntityDormancyDecision({
      ...baseInput,
      addressClass: 'active',
      addressRecentlyReactivated: true,
      links: [link({ fundedTargetNearEvent: true })]
    });
    expect(reactivated.entityClass).toBe('probable_side_wallet_reactivation');
  });

  it('dormant address + active probable link = address_dormant_entity_active; + near-event VALUED funding = reactivation', () => {
    const active = classifyEntityDormancyDecision({ ...baseInput, addressClass: 'covered_dormant', links: [link()] });
    expect(active.entityClass).toBe('address_dormant_entity_active');
    const funded = classifyEntityDormancyDecision({
      ...baseInput,
      addressClass: 'covered_dormant',
      links: [link({ fundedTargetNearEvent: true })]
    });
    expect(funded.entityClass).toBe('probable_side_wallet_reactivation');
    // Unknown-value near-event funding is NOT reactivation evidence.
    const unknownFunded = classifyEntityDormancyDecision({
      ...baseInput,
      addressClass: 'covered_dormant',
      links: [link({ unknownValueFundingNearEvent: true })]
    });
    expect(unknownFunded.entityClass).toBe('address_dormant_entity_active');
  });

  it('dormant address + all assessable links dormant = independent_dormant_entity (unknown POSSIBLE links weaken it)', () => {
    const clean = classifyEntityDormancyDecision({
      ...baseInput,
      addressClass: 'covered_dormant',
      links: [link({ linkedActivity: 'dormant_covered' })]
    });
    expect(clean.entityClass).toBe('independent_dormant_entity');
    const withUnknownPossible = classifyEntityDormancyDecision({
      ...baseInput,
      addressClass: 'covered_dormant',
      links: [
        link({ linkedActivity: 'dormant_covered' }),
        link({ linkedActivity: 'unknown', tier: 'possible', confidence: 35, counterpartyAddress: addr('CPU') })
      ]
    });
    expect(withUnknownPossible.entityClass).toBe('independent_dormant_entity');
    expect(withUnknownPossible.confidence).toBeLessThan(clean.confidence);
    expect(withUnknownPossible.caveats.join(' ')).toContain('unknown is not dormancy');
  });

  it('an unknown-history PROBABLE link caps independence at insufficient_evidence', () => {
    // The entity's strongest candidate member has no assessable history — the
    // entity might have been active; independence can never be claimed.
    const d = classifyEntityDormancyDecision({
      ...baseInput,
      addressClass: 'covered_dormant',
      links: [
        link({ linkedActivity: 'dormant_covered' }),
        link({ linkedActivity: 'unknown', tier: 'probable', counterpartyAddress: addr('CPP') })
      ]
    });
    expect(d.entityClass).toBe('insufficient_evidence');
    expect(d.reasonCodes).toContain('unknown_history_probable_link');
    expect(d.caveats.join(' ')).toContain('unknown-history probable link');
  });

  it('independence REQUIRES complete link discovery — a truncated view is insufficient_evidence', () => {
    const truncated = classifyEntityDormancyDecision({
      ...baseInput,
      linkDiscoveryComplete: false,
      addressClass: 'covered_dormant',
      links: [link({ linkedActivity: 'dormant_covered' })]
    });
    expect(truncated.entityClass).toBe('insufficient_evidence');
    expect(truncated.reasonCodes).toContain('link_discovery_incomplete');
    expect(truncated.caveats.join(' ')).toContain('truncated');
  });

  it('dormant address: unknown-only links or NO qualifying links stay insufficient_evidence — independence is never claimed from absence', () => {
    const unknownOnly = classifyEntityDormancyDecision({
      ...baseInput,
      addressClass: 'covered_dormant',
      links: [link({ linkedActivity: 'unknown' })]
    });
    expect(unknownOnly.entityClass).toBe('insufficient_evidence');
    const noLinks = classifyEntityDormancyDecision({ ...baseInput, addressClass: 'covered_dormant', links: [] });
    expect(noLinks.entityClass).toBe('insufficient_evidence');
    expect(noLinks.reasonCodes).toContain('no_qualifying_links_in_local_data');
  });

  it('fresh address: active funder = fresh_funded_by_active_entity; dormant probable funder = reactivation; none = insufficient', () => {
    const funded = classifyEntityDormancyDecision({
      ...baseInput,
      addressClass: 'fresh',
      links: [link({ isFunder: true })]
    });
    expect(funded.entityClass).toBe('fresh_funded_by_active_entity');
    const dormantFunder = classifyEntityDormancyDecision({
      ...baseInput,
      addressClass: 'fresh',
      links: [link({ isFunder: true, linkedActivity: 'dormant_covered' })]
    });
    expect(dormantFunder.entityClass).toBe('probable_side_wallet_reactivation');
    const none = classifyEntityDormancyDecision({ ...baseInput, addressClass: 'fresh', links: [] });
    expect(none.entityClass).toBe('insufficient_evidence');
  });

  it('incomplete/unknown address history never upgrades to a dormant-entity claim', () => {
    const incompleteActiveLink = classifyEntityDormancyDecision({
      ...baseInput,
      addressClass: 'apparently_dormant_incomplete_history',
      links: [link()]
    });
    expect(incompleteActiveLink.entityClass).toBe('active_entity');
    expect(incompleteActiveLink.caveats.join(' ')).toContain('NOT established');
    const incompleteNoLinks = classifyEntityDormancyDecision({
      ...baseInput,
      addressClass: 'apparently_dormant_incomplete_history',
      links: []
    });
    expect(incompleteNoLinks.entityClass).toBe('insufficient_evidence');
    const unknown = classifyEntityDormancyDecision({ ...baseInput, addressClass: 'unknown', links: [] });
    expect(unknown.entityClass).toBe('insufficient_evidence');
  });

  it('every decision carries the neutral-wording caveat — never same-person claims', () => {
    for (const addressClass of ['active', 'fresh', 'covered_dormant', 'unknown'] as const) {
      const d = classifyEntityDormancyDecision({ ...baseInput, addressClass, links: [link()] });
      expect(d.caveats.join(' ')).toContain('never identity or same-person claims');
      expect(d.confidence).toBeLessThanOrEqual(85);
    }
  });
});

// ---------------------------------------------------------------------------
// DB builder integration
// ---------------------------------------------------------------------------

async function cleanup() {
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

async function seedRelationship(
  rootWalletId: string,
  aId: string,
  bId: string,
  kind: string,
  confidence: number,
  firstSeenAt: Date = daysBefore(200)
) {
  const root = await prisma.lineageRoot.upsert({
    where: { walletId: rootWalletId },
    create: {
      walletId: rootWalletId, source: 'test', firstImportedAt: daysBefore(365), lastSeenInImportAt: daysBefore(365)
    },
    update: {}
  });
  return prisma.walletRelationship.create({
    data: {
      lineageRootId: root.id, walletAId: aId, walletBId: bId, kind: kind as never, confidence,
      firstSeenAt, lastSeenAt: daysBefore(1), interactionCount: 2,
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

describe.skipIf(!dbReachable)('buildEntityDormancyObservations (Task 8 DB builder)', () => {
  it('dormant address + active linked wallet = address_dormant_entity_active, with per-link receipts and service exclusion', async () => {
    const main = await seedWallet('WMA');
    const side = await seedWallet('WSA');
    const entryTok = await seedToken();
    const oldTok = await seedToken();
    const sideTok = await seedToken();

    // main: old coverage, dormant before entry.
    await seedTrade(main.id, oldTok.id, 'BUY', 100, daysBefore(200));
    await seedTrade(main.id, entryTok.id, 'BUY', 200, ENTRY);
    await seedProfileWithEntry(main.address, entryTok.address);
    // side: meaningfully active 2d before entry, linked via relationship + old VALUED edge.
    await seedTrade(side.id, sideTok.id, 'BUY', 300, daysBefore(2));
    await seedEdge(side.address, main.address, 40, daysBefore(150)); // old funding, NOT near-event
    await seedRelationship(main.id, side.id, main.id, 'direct_funding', 70);
    // service counterparty with heavy recent flows — must be excluded.
    await prisma.addressRegistry.create({
      data: { chain: 'SOLANA', address: addr('CEXA'), category: 'CEX', label: 'test cex', source: 'test' }
    });
    await seedEdge(addr('CEXA'), main.address, 5000, daysBefore(3));

    await buildAddressDormancyObservations(prisma, { chain: 'SOLANA', walletAddresses: [main.address] });
    const r = await buildEntityDormancyObservations(prisma, { chain: 'SOLANA', walletAddresses: [main.address] });
    expect(r.errors).toBe(0);
    expect(r.observationsWritten).toBe(1);

    const obs = await prisma.entityDormancyObservation.findFirstOrThrow({ where: { walletAddress: main.address } });
    expect(obs.addressClass).toBe('covered_dormant');
    expect(obs.entityClass).toBe('address_dormant_entity_active');
    expect(obs.serviceNodesExcluded).toBe(1);
    expect(obs.linkedWalletsActive).toBe(1);
    const links = obs.linksJson as { counterpartyAddress: string; tier: string }[];
    expect(links.some((l) => l.counterpartyAddress === side.address && l.tier === 'probable')).toBe(true);
    expect(links.every((l) => l.counterpartyAddress !== addr('CEXA'))).toBe(true);
    expect(obs.caveats.join(' ')).toContain('never identity or same-person claims');
    const receipts = obs.receiptsJson as { linkDiscoveryComplete: boolean };
    expect(receipts.linkDiscoveryComplete).toBe(true);

    // Idempotent rerun.
    await buildEntityDormancyObservations(prisma, { chain: 'SOLANA', walletAddresses: [main.address] });
    expect(await prisma.entityDormancyObservation.count({ where: { walletAddress: main.address } })).toBe(1);
  });

  it('unknown-value near-event funding is reported but NEVER reactivation evidence (and never resets dormancy)', async () => {
    const main = await seedWallet('WMB');
    const side = await seedWallet('WSB');
    const entryTok = await seedToken();
    const oldTok = await seedToken();
    const sideTok = await seedToken();

    await seedTrade(main.id, oldTok.id, 'BUY', 100, daysBefore(200));
    await seedTrade(main.id, entryTok.id, 'BUY', 200, ENTRY);
    await seedProfileWithEntry(main.address, entryTok.address);
    await seedTrade(side.id, sideTok.id, 'BUY', 300, daysBefore(2));
    // Old VALUED edge establishes the link; the near-event funding is UNKNOWN-value.
    await seedEdge(side.address, main.address, 40, daysBefore(150));
    await seedEdge(side.address, main.address, null, hoursBefore(20));
    await seedRelationship(main.id, side.id, main.id, 'direct_funding', 70);

    await buildAddressDormancyObservations(prisma, { chain: 'SOLANA', walletAddresses: [main.address] });
    const addrObs = await prisma.addressDormancyObservation.findFirstOrThrow({ where: { walletAddress: main.address } });
    expect(addrObs.overallClass).toBe('covered_dormant'); // unknown-value funding did not reset dormancy

    await buildEntityDormancyObservations(prisma, { chain: 'SOLANA', walletAddresses: [main.address] });
    const obs = await prisma.entityDormancyObservation.findFirstOrThrow({ where: { walletAddress: main.address } });
    expect(obs.entityClass).toBe('address_dormant_entity_active'); // NOT reactivation — unknown is not evidence
    const links = obs.linksJson as { counterpartyAddress: string; fundedTargetNearEvent: boolean; unknownValueFundingNearEvent: boolean }[];
    const sideLink = links.find((l) => l.counterpartyAddress === side.address);
    expect(sideLink?.fundedTargetNearEvent).toBe(false);
    expect(sideLink?.unknownValueFundingNearEvent).toBe(true);
  });

  it('dormant-then-woken address with VALUED near-event funding from an active probable link = probable_side_wallet_reactivation', async () => {
    const main = await seedWallet('WMR');
    const side = await seedWallet('WSR');
    const entryTok = await seedToken();
    const oldTok = await seedToken();
    const sideTok = await seedToken();

    // main: meaningful history 100d ago (coverage anchor), then quiet, then a
    // VALUED funding burst 2d before entry -> T7 'active', probe sees the
    // pre-burst covered dormancy.
    await seedTrade(main.id, oldTok.id, 'BUY', 100, daysBefore(100));
    await seedEdge(side.address, main.address, 60, daysBefore(2)); // valued, near-event
    await seedTrade(main.id, entryTok.id, 'BUY', 200, ENTRY);
    await seedProfileWithEntry(main.address, entryTok.address);
    await seedTrade(side.id, sideTok.id, 'BUY', 300, daysBefore(1)); // side active pre-event
    await seedRelationship(main.id, side.id, main.id, 'direct_funding', 70);

    await buildAddressDormancyObservations(prisma, { chain: 'SOLANA', walletAddresses: [main.address] });
    const addrObs = await prisma.addressDormancyObservation.findFirstOrThrow({ where: { walletAddress: main.address } });
    expect(addrObs.overallClass).toBe('active'); // the valued funding IS meaningful

    await buildEntityDormancyObservations(prisma, { chain: 'SOLANA', walletAddresses: [main.address] });
    const obs = await prisma.entityDormancyObservation.findFirstOrThrow({ where: { walletAddress: main.address } });
    expect(obs.entityClass).toBe('probable_side_wallet_reactivation');
    expect(obs.reasonCodes).toContain('address_dormant_before_recent_burst');
    const receipts = obs.receiptsJson as { addressRecentlyReactivated: boolean };
    expect(receipts.addressRecentlyReactivated).toBe(true);
  });

  it('fresh address funded by an active wallet = fresh_funded_by_active_entity', async () => {
    const main = await seedWallet('WMC');
    const funder = await seedWallet('WSC');
    const entryTok = await seedToken();
    const funderTok = await seedToken();

    await seedEdge(funder.address, main.address, 30, hoursBefore(24)); // first observation = VALUED funding
    await seedTrade(main.id, entryTok.id, 'BUY', 200, ENTRY);
    await seedProfileWithEntry(main.address, entryTok.address);
    await seedTrade(funder.id, funderTok.id, 'BUY', 500, daysBefore(2)); // funder active pre-event

    await buildAddressDormancyObservations(prisma, { chain: 'SOLANA', walletAddresses: [main.address] });
    const addrObs = await prisma.addressDormancyObservation.findFirstOrThrow({ where: { walletAddress: main.address } });
    expect(addrObs.overallClass).toBe('fresh');

    await buildEntityDormancyObservations(prisma, { chain: 'SOLANA', walletAddresses: [main.address] });
    const obs = await prisma.entityDormancyObservation.findFirstOrThrow({ where: { walletAddress: main.address } });
    expect(obs.entityClass).toBe('fresh_funded_by_active_entity');
  });

  it('dormant address whose only link is also covered-dormant = independent_dormant_entity', async () => {
    const main = await seedWallet('WMD');
    const peer = await seedWallet('WSD');
    const entryTok = await seedToken();
    const oldTok = await seedToken();
    const peerTok = await seedToken();

    await seedTrade(main.id, oldTok.id, 'BUY', 100, daysBefore(200));
    await seedTrade(main.id, entryTok.id, 'BUY', 200, ENTRY);
    await seedProfileWithEntry(main.address, entryTok.address);
    await seedTrade(peer.id, peerTok.id, 'BUY', 80, daysBefore(200)); // peer coverage old, no pre-event activity
    await seedEdge(peer.address, main.address, 60, daysBefore(180)); // VALUED link evidence

    await buildAddressDormancyObservations(prisma, { chain: 'SOLANA', walletAddresses: [main.address] });
    await buildEntityDormancyObservations(prisma, { chain: 'SOLANA', walletAddresses: [main.address] });
    const obs = await prisma.entityDormancyObservation.findFirstOrThrow({ where: { walletAddress: main.address } });
    expect(obs.entityClass).toBe('independent_dormant_entity');
    expect(obs.linkedWalletsActive).toBe(0);
  });

  it('post-anchor relationships can NEVER crowd a pre-anchor link out of the capped set', async () => {
    const main = await seedWallet('WMF');
    const side = await seedWallet('WSF');
    const entryTok = await seedToken();
    const oldTok = await seedToken();
    const sideTok = await seedToken();

    // main: dormant before entry.
    await seedTrade(main.id, oldTok.id, 'BUY', 100, daysBefore(200));
    await seedTrade(main.id, entryTok.id, 'BUY', 200, ENTRY);
    await seedProfileWithEntry(main.address, entryTok.address);
    // The ONLY pre-anchor link: LOW confidence, side wallet meaningfully active.
    await seedTrade(side.id, sideTok.id, 'BUY', 300, daysBefore(2));
    await seedRelationship(main.id, side.id, main.id, 'direct_funding', 55, daysBefore(100));
    // THREE post-anchor relationships with HIGHER confidence — with an
    // all-time confidence-ordered fetch capped at 2 these would crowd the
    // pre-anchor link out entirely.
    for (const suffix of ['WXF1', 'WXF2', 'WXF3']) {
      const filler = await seedWallet(suffix);
      await seedRelationship(
        main.id, filler.id, main.id, 'direct_funding', 90, new Date(ENTRY.getTime() + 86_400_000)
      );
    }

    await buildAddressDormancyObservations(prisma, { chain: 'SOLANA', walletAddresses: [main.address] });
    const r = await buildEntityDormancyObservations(prisma, {
      chain: 'SOLANA',
      walletAddresses: [main.address],
      maxRelationshipsPerWallet: 2
    });
    expect(r.errors).toBe(0);
    const obs = await prisma.entityDormancyObservation.findFirstOrThrow({ where: { walletAddress: main.address } });
    expect(obs.entityClass).toBe('address_dormant_entity_active'); // pre-anchor link found, not crowded out
    const links = obs.linksJson as { counterpartyAddress: string }[];
    expect(links.some((l) => l.counterpartyAddress === side.address)).toBe(true);
    const receipts = obs.receiptsJson as { relationshipsTruncated: boolean; linkDiscoveryComplete: boolean };
    expect(receipts.relationshipsTruncated).toBe(false); // only 1 pre-anchor relationship exists
    expect(receipts.linkDiscoveryComplete).toBe(true);
  });

  it('over-cap edge and trade volume BETWEEN two anchors leaves the earlier observation unchanged', async () => {
    const main = await seedWallet('WMG');
    const side = await seedWallet('WSG');
    const entryTok = await seedToken();
    const laterTok = await seedToken();
    const oldTok = await seedToken();
    const sideTok = await seedToken();
    const t2 = new Date(ENTRY.getTime() + 30 * 86_400_000);

    // main: dormant before the FIRST entry; second entry 30d later.
    await seedTrade(main.id, oldTok.id, 'BUY', 100, daysBefore(200));
    await seedTrade(main.id, entryTok.id, 'BUY', 200, ENTRY);
    await prisma.walletBehaviorProfile.create({
      data: {
        chain: 'SOLANA', walletAddress: main.address, engineVersion: 1, dataQuality: 'local_only', computedAt: ENTRY,
        profileJson: {
          local: {
            tokenPositions: [
              { tokenAddress: entryTok.address, firstBuyTs: ENTRY.toISOString() },
              { tokenAddress: laterTok.address, firstBuyTs: t2.toISOString() }
            ]
          }
        }
      }
    });
    // Pre-t1 valued link evidence to an active side wallet.
    await seedEdge(side.address, main.address, 60, daysBefore(150));
    await seedTrade(side.id, sideTok.id, 'BUY', 300, daysBefore(2));
    // FOUR valued edges + THREE member trades BETWEEN t1 and t2 — with a
    // shared newest-first cap of 3 edges / 2 trades bounded at the NEWEST
    // anchor these would displace all pre-t1 evidence.
    for (let i = 1; i <= 4; i++) {
      await seedEdge(addr(`CRWD${i}`), main.address, 500 + i, new Date(ENTRY.getTime() + i * 86_400_000));
    }
    for (let i = 1; i <= 3; i++) {
      await seedTrade(side.id, sideTok.id, 'SELL', 50 + i, new Date(ENTRY.getTime() + (i + 10) * 86_400_000));
    }

    await buildAddressDormancyObservations(prisma, { chain: 'SOLANA', walletAddresses: [main.address] });
    const r = await buildEntityDormancyObservations(prisma, {
      chain: 'SOLANA',
      walletAddresses: [main.address],
      maxEdgesPerWallet: 3,
      maxMemberTrades: 2
    });
    expect(r.errors).toBe(0);
    const t1Obs = await prisma.entityDormancyObservation.findUniqueOrThrow({
      where: {
        chain_walletAddress_eventKind_anchorKey: {
          chain: 'SOLANA', walletAddress: main.address, eventKind: 'token_entry', anchorKey: entryTok.address
        }
      }
    });
    expect(t1Obs.addressClass).toBe('covered_dormant');
    expect(t1Obs.entityClass).toBe('address_dormant_entity_active'); // pre-t1 link intact
    const links = t1Obs.linksJson as { counterpartyAddress: string; linkedActivity: string }[];
    expect(links.some((l) => l.counterpartyAddress === side.address && l.linkedActivity === 'active_pre_event')).toBe(true);
    const receipts = t1Obs.receiptsJson as {
      edgesTruncated: boolean; memberTradesTruncated: boolean; linkDiscoveryComplete: boolean;
    };
    // t1's own pre-anchor window is small — no truncation, later volume invisible.
    expect(receipts.edgesTruncated).toBe(false);
    expect(receipts.memberTradesTruncated).toBe(false);
    expect(receipts.linkDiscoveryComplete).toBe(true);
  });

  it('service-only, dust-only and post-anchor counterparties never form links (insufficient_evidence, not independence)', async () => {
    const main = await seedWallet('WME');
    const spammer = await seedWallet('WSE');
    const late = await seedWallet('WLE');
    const entryTok = await seedToken();
    const oldTok = await seedToken();
    const spamTok = await seedToken();

    await seedTrade(main.id, oldTok.id, 'BUY', 100, daysBefore(200));
    await seedTrade(main.id, entryTok.id, 'BUY', 200, ENTRY);
    await seedProfileWithEntry(main.address, entryTok.address);
    // CEX-only "history" + an active wallet sending DUST + an active wallet
    // whose only edge is AFTER the anchor: none of these are links.
    await prisma.addressRegistry.create({
      data: { chain: 'SOLANA', address: addr('CEXE'), category: 'CEX', label: 'test cex', source: 'test' }
    });
    await seedEdge(addr('CEXE'), main.address, 5000, daysBefore(3));
    await seedTrade(spammer.id, spamTok.id, 'BUY', 900, daysBefore(1)); // spammer is active...
    await seedEdge(spammer.address, main.address, 0.01, daysBefore(3)); // ...but only sent dust
    await seedTrade(late.id, spamTok.id, 'BUY', 900, daysBefore(1)); // late wallet is active...
    await seedEdge(late.address, main.address, 700, new Date(ENTRY.getTime() + 86_400_000)); // ...but linked only POST-anchor

    await buildAddressDormancyObservations(prisma, { chain: 'SOLANA', walletAddresses: [main.address] });
    const addrObs = await prisma.addressDormancyObservation.findFirstOrThrow({ where: { walletAddress: main.address } });
    expect(addrObs.overallClass).toBe('covered_dormant'); // dust/service/post-event reset nothing

    await buildEntityDormancyObservations(prisma, { chain: 'SOLANA', walletAddresses: [main.address] });
    const obs = await prisma.entityDormancyObservation.findFirstOrThrow({ where: { walletAddress: main.address } });
    expect(obs.linkedWalletsConsidered).toBe(0);
    expect(obs.entityClass).toBe('insufficient_evidence'); // NOT independent — absence is not evidence
    expect(obs.reasonCodes).toContain('no_qualifying_links_in_local_data');
    expect(obs.serviceNodesExcluded).toBe(1);
  });
});
