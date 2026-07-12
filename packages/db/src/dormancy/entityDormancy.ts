// FlowRadar — entity-dormancy observation builder (dormancy Task 8).
//
// Joins each Task 7 address_dormancy_observations row with PROBABILISTIC
// wallet links (wallet_relationships rows, direct money_flow_edges, and
// @flowradar/core receipts-engine side-wallet tiers) to answer: was the
// ENTITY around this address dormant before the anchor event, or only the
// address?
//
// Vocabulary (observation-only, NEVER identity claims):
//   independent_dormant_entity        — address dormant; every assessable link
//                                       is itself covered-dormant (requires
//                                       COMPLETE link discovery)
//   address_dormant_entity_active     — address dormant; a possible/probable
//                                       linked wallet WAS meaningfully active
//   probable_side_wallet_reactivation — dormant-then-woken or fresh address,
//                                       with VALUED near-event funding from a
//                                       probable/strong linked wallet
//   fresh_funded_by_active_entity     — fresh address whose funder link was
//                                       meaningfully active pre-event
//   active_entity                     — the address itself (or, for unclear
//                                       address history, a linked wallet) was
//                                       meaningfully active pre-event
//   insufficient_evidence             — nothing above can be honestly claimed
//
// Honesty/safety rules:
//   - NO LOOKAHEAD anywhere: link evidence (edges, relationships, receipts-
//     engine inputs) is fetched strictly BEFORE each observation's anchor —
//     per-ANCHOR capped queries, so later-anchor volume can never crowd an
//     earlier anchor's evidence; the near-event funding probe queries
//     [anchor-window, anchor).
//   - Link evidence must be VALUED above dust: dust transfers are never link
//     evidence; unknown-value transfers are counted and reported per link but
//     never establish candidacy or reactivation on their own (unknown != evidence).
//   - Service nodes (registry category on the counterparty's own side-chain +
//     bounded fan-out degree, via core isServiceNode) are EXCLUDED from links.
//   - Truncated discovery (relationship/edge/funding-probe caps, candidate
//     cap, receipts trade window) flags linkDiscoveryComplete=false and
//     BLOCKS independence claims.
//   - Neutral wording only: links are possible/probable/strong on-chain
//     relationships, never same-person claims; entity confidence capped at 85.
//   - Bounded everywhere; per-link receipts; idempotent unique upserts; one
//     wallet's error never fails the batch. SHADOW-ONLY writes.

import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { deriveBehaviorReceipts, DEFAULT_SETTINGS } from '@flowradar/core';
import type { DormancyClass, ReceiptTradeInput, ReceiptTransferInput } from '@flowradar/core';
import { assessFromContext, loadWalletDormancyContext } from './addressDormancy';
import type { WalletDormancyContext } from './addressDormancy';
import { lookupServiceCounterparties, toErrorReceipt, ERROR_RECEIPTS_MAX } from './activity';
import type { WalletErrorReceipt } from './activity';

export const ENTITY_DORMANCY_ENGINE_VERSION = 2;

export type EntityDormancyClass =
  | 'independent_dormant_entity'
  | 'address_dormant_entity_active'
  | 'probable_side_wallet_reactivation'
  | 'fresh_funded_by_active_entity'
  | 'active_entity'
  | 'insufficient_evidence';

export type LinkTier = 'possible' | 'probable' | 'strong';

export type LinkedActivity = 'active_pre_event' | 'dormant_covered' | 'unknown';

export interface EntityLinkAssessment {
  counterpartyAddress: string;
  tier: LinkTier;
  /** Relationship kinds / 'direct_transfer' / receipts-engine classes. */
  kinds: string[];
  /** 0-100 link confidence (probabilistic — NEVER an identity claim). */
  confidence: number;
  linkedActivity: LinkedActivity;
  linkedMeaningfulPreEventCount: number;
  /** counterparty -> target VALUED (>dust) inbound inside the reactivation window, strictly pre-event. */
  fundedTargetNearEvent: boolean;
  /** counterparty -> target UNKNOWN-VALUE inbound in the same window (reported, never evidence). */
  unknownValueFundingNearEvent: boolean;
  /** Funding-kind relationship (first_funder / direct_funding) or observed valued near-event funding. */
  isFunder: boolean;
  /** Unknown-value / dust transfer tallies for this pair (reported, non-evidentiary). */
  unknownValueTransfers: number;
  dustTransfers: number;
  evidence: {
    txHashes: string[];
    relationshipIds: string[];
    edgeIds: string[];
    receiptClassifications: string[];
  };
}

export interface EntityDecisionInput {
  addressClass: DormancyClass;
  /** Non-service, same-chain links only (exclusions counted separately). */
  links: EntityLinkAssessment[];
  serviceNodesExcluded: number;
  /**
   * True only when link discovery hit NO bound (relationships, edges,
   * candidate cap, funding probe, receipts trade window). Independence claims
   * REQUIRE completeness — a truncated view can never prove that no linked
   * wallet was active.
   */
  linkDiscoveryComplete: boolean;
  /**
   * True when the address's pre-event activity is ONLY a recent burst and a
   * re-anchored dormancy assessment (at the burst start) was covered_dormant
   * — the "woke up right before the event" shape.
   */
  addressRecentlyReactivated: boolean;
}

export interface EntityDecision {
  entityClass: EntityDormancyClass;
  confidence: number;
  reasonCodes: string[];
  caveats: string[];
}

const BASE_CAVEATS = [
  'wallet links are probabilistic on-chain relationships (possible/probable/strong) — never identity or same-person claims',
  'link discovery runs over bounded local data — absence of links is not proof of independence',
  'observation-only: nothing here grants signal eligibility, votes, or promotion'
];

const cap = (n: number) => Math.max(0, Math.min(85, Math.round(n)));

/**
 * THE entity decision rule (pure; exported so every branch is unit-pinned).
 */
export function classifyEntityDormancyDecision(input: EntityDecisionInput): EntityDecision {
  const links = input.links;
  const activeLinks = links.filter((l) => l.linkedActivity === 'active_pre_event');
  const probableActive = activeLinks.filter((l) => l.tier === 'probable' || l.tier === 'strong');
  const dormantLinks = links.filter((l) => l.linkedActivity === 'dormant_covered');
  const unknownLinks = links.filter((l) => l.linkedActivity === 'unknown');
  const maxConf = (ls: EntityLinkAssessment[]) => ls.reduce((m, l) => Math.max(m, l.confidence), 0);
  const caveats = [...BASE_CAVEATS];
  if (!input.linkDiscoveryComplete) {
    caveats.push('link discovery was truncated by a bound — no independence claim can be made from this view');
  }

  switch (input.addressClass) {
    case 'active': {
      // Reactivation shape: only-recent activity + probable/strong link that
      // funded the address (valued, near-event) just before the anchor.
      const reactivators = probableActive.filter((l) => l.fundedTargetNearEvent);
      if (input.addressRecentlyReactivated && reactivators.length > 0) {
        return {
          entityClass: 'probable_side_wallet_reactivation',
          confidence: cap(Math.min(75, maxConf(reactivators))),
          reasonCodes: ['address_dormant_before_recent_burst', 'probable_link_funded_address_near_event'],
          caveats
        };
      }
      return {
        entityClass: 'active_entity',
        confidence: cap(80),
        reasonCodes: ['address_meaningfully_active_pre_event'],
        caveats
      };
    }
    case 'fresh': {
      const funders = links.filter((l) => l.isFunder);
      const activeFunders = funders.filter((l) => l.linkedActivity === 'active_pre_event');
      if (activeFunders.length > 0) {
        return {
          entityClass: 'fresh_funded_by_active_entity',
          confidence: cap(Math.min(80, maxConf(activeFunders))),
          reasonCodes: ['fresh_address', 'funder_link_meaningfully_active_pre_event'],
          caveats
        };
      }
      const dormantProbableFunders = funders.filter(
        (l) => l.linkedActivity === 'dormant_covered' && (l.tier === 'probable' || l.tier === 'strong')
      );
      if (dormantProbableFunders.length > 0) {
        return {
          entityClass: 'probable_side_wallet_reactivation',
          confidence: cap(Math.min(70, maxConf(dormantProbableFunders))),
          reasonCodes: ['fresh_address', 'funder_is_probable_link_with_covered_dormancy'],
          caveats
        };
      }
      if (probableActive.length > 0) {
        caveats.push('linked activity observed but a funding path to this fresh address was NOT established');
        return {
          entityClass: 'active_entity',
          confidence: cap(Math.min(55, maxConf(probableActive))),
          reasonCodes: ['fresh_address', 'probable_link_active_pre_event_no_funding_path'],
          caveats
        };
      }
      return {
        entityClass: 'insufficient_evidence',
        confidence: 20,
        reasonCodes: ['fresh_address', 'no_qualifying_funder_evidence'],
        caveats
      };
    }
    case 'covered_dormant': {
      const reactivators = probableActive.filter((l) => l.fundedTargetNearEvent);
      if (reactivators.length > 0) {
        return {
          entityClass: 'probable_side_wallet_reactivation',
          confidence: cap(Math.min(75, maxConf(reactivators))),
          reasonCodes: ['address_covered_dormant', 'probable_link_active_and_funded_address_near_event'],
          caveats
        };
      }
      if (activeLinks.length > 0) {
        const strongSide = probableActive.length > 0;
        return {
          entityClass: 'address_dormant_entity_active',
          confidence: cap(Math.min(strongSide ? 70 : 50, maxConf(activeLinks))),
          reasonCodes: [
            'address_covered_dormant',
            strongSide ? 'probable_link_meaningfully_active_pre_event' : 'possible_link_meaningfully_active_pre_event'
          ],
          caveats
        };
      }
      if (dormantLinks.length > 0 && activeLinks.length === 0) {
        // Independence NEEDS a complete link view: a truncated discovery can
        // never prove that no linked wallet was active.
        if (!input.linkDiscoveryComplete) {
          return {
            entityClass: 'insufficient_evidence',
            confidence: 20,
            reasonCodes: ['address_covered_dormant', 'link_discovery_incomplete'],
            caveats
          };
        }
        // A PROBABLE/STRONG link whose pre-event history is unknown caps the
        // claim at insufficient_evidence: the entity's strongest candidate
        // member might have been active — unknown is never dormancy.
        const unknownProbable = unknownLinks.filter((l) => l.tier === 'probable' || l.tier === 'strong');
        if (unknownProbable.length > 0) {
          caveats.push(
            `${unknownProbable.length} probable/strong link(s) have unknown pre-event activity — independence cannot be claimed over an unknown-history probable link`
          );
          return {
            entityClass: 'insufficient_evidence',
            confidence: 20,
            reasonCodes: ['address_covered_dormant', 'unknown_history_probable_link'],
            caveats
          };
        }
        const conf = unknownLinks.length === 0 ? 60 : 45;
        if (unknownLinks.length > 0) {
          caveats.push(`${unknownLinks.length} link(s) have unknown pre-event activity — unknown is not dormancy`);
        }
        return {
          entityClass: 'independent_dormant_entity',
          confidence: cap(conf),
          reasonCodes: ['address_covered_dormant', 'all_assessable_links_covered_dormant'],
          caveats
        };
      }
      // Only unknown-activity links, or no qualifying links at all: neither
      // independence nor entity activity can be honestly claimed.
      return {
        entityClass: 'insufficient_evidence',
        confidence: 20,
        reasonCodes: [
          'address_covered_dormant',
          links.length > 0 ? 'linked_activity_unknown' : 'no_qualifying_links_in_local_data'
        ],
        caveats
      };
    }
    case 'apparently_dormant_incomplete_history': {
      if (activeLinks.length > 0) {
        caveats.push('address history is incomplete — the address-level dormancy is NOT established');
        return {
          entityClass: 'active_entity',
          confidence: cap(Math.min(60, maxConf(activeLinks))),
          reasonCodes: ['address_history_incomplete', 'linked_wallet_meaningfully_active_pre_event'],
          caveats
        };
      }
      return {
        entityClass: 'insufficient_evidence',
        confidence: 20,
        reasonCodes: ['address_history_incomplete'],
        caveats
      };
    }
    case 'unknown':
    default: {
      if (activeLinks.length > 0) {
        return {
          entityClass: 'active_entity',
          confidence: cap(Math.min(50, maxConf(activeLinks))),
          reasonCodes: ['address_unknown', 'linked_wallet_meaningfully_active_pre_event'],
          caveats
        };
      }
      return {
        entityClass: 'insufficient_evidence',
        confidence: 20,
        reasonCodes: ['address_unknown', 'no_link_evidence'],
        caveats
      };
    }
  }
}

// ---------------------------------------------------------------------------
// DB builder
// ---------------------------------------------------------------------------

export interface EntityDormancyBatchReport {
  observationsConsidered: number;
  observationsWritten: number;
  walletsProcessed: number;
  errors: number;
  /** First ERROR_RECEIPTS_MAX per-wallet failures (receipted, never silent). */
  errorReceipts: WalletErrorReceipt[];
  byEntityClass: Record<string, number>;
  serviceNodesExcludedTotal: number;
  linksConsideredTotal: number;
}

/**
 * Relationship-contract confidence bands (WalletRelationship doc: possible
 * <50, probable 50-79, strong >=80) — NOT cluster confidenceBand, whose
 * boundaries differ (a direct_funding at 60 must band probable here).
 */
function tierOfConfidence(conf: number): LinkTier {
  if (conf >= 80) return 'strong';
  if (conf >= 50) return 'probable';
  return 'possible';
}

const TIER_RANK: Record<LinkTier, number> = { possible: 0, probable: 1, strong: 2 };
const FUNDING_KINDS = new Set(['first_funder', 'direct_funding']);

interface EdgeLite {
  id: string;
  sourceAddress: string;
  destinationAddress: string;
  sourceChain: string;
  destinationChain: string;
  ts: Date;
  txHash: string;
  valuedUsd: Prisma.Decimal | null;
}

interface RelLite {
  id: string;
  kind: string;
  confidence: number;
  cp: string;
}

export async function buildEntityDormancyObservations(
  prisma: PrismaClient,
  opts: {
    chain?: 'SOLANA' | 'BSC';
    walletAddresses?: string[];
    /** Bound on address observations processed this pass. */
    limit?: number;
    maxLinkedWallets?: number;
    /** Per-ANCHOR edge cap (each observation gets its own pre-anchor window). */
    maxEdgesPerWallet?: number;
    /** Per-ANCHOR relationship cap. */
    maxRelationshipsPerWallet?: number;
    /** Per-ANCHOR receipts-engine member-trade cap. */
    maxMemberTrades?: number;
    reactivationWindowDays?: number;
    ensureClassifications?: boolean;
    /** Run the core receipts engine over target+candidates for tier evidence. */
    useReceiptsEngine?: boolean;
    now?: Date;
  } = {}
): Promise<EntityDormancyBatchReport> {
  const chain = opts.chain ?? 'SOLANA';
  const limit = opts.limit ?? 500;
  const maxLinked = opts.maxLinkedWallets ?? 15;
  const maxEdges = opts.maxEdgesPerWallet ?? 500;
  const maxRelationships = opts.maxRelationshipsPerWallet ?? 50;
  const maxMemberTrades = opts.maxMemberTrades ?? 5000;
  const reactivationWindowMs = (opts.reactivationWindowDays ?? 7) * 86_400_000;
  const dustMaxUsd = DEFAULT_SETTINGS.lineage.dustMaxUsd;
  const now = opts.now ?? new Date();

  const observations = await prisma.addressDormancyObservation.findMany({
    where: {
      chain,
      ...(opts.walletAddresses ? { walletAddress: { in: opts.walletAddresses } } : {})
    },
    // Full unique key (chain fixed by the filter) — stable under the cap.
    orderBy: [{ walletAddress: 'asc' }, { eventKind: 'asc' }, { anchorKey: 'asc' }],
    take: limit,
    select: { walletAddress: true, eventKind: true, anchorKey: true, eventTs: true, overallClass: true }
  });

  const report: EntityDormancyBatchReport = {
    observationsConsidered: observations.length,
    observationsWritten: 0,
    walletsProcessed: 0,
    errors: 0,
    errorReceipts: [],
    byEntityClass: {},
    serviceNodesExcludedTotal: 0,
    linksConsideredTotal: 0
  };

  // Group observations per wallet so wallet-level context/caches are shared;
  // EVIDENCE fetches happen per OBSERVATION (each anchor gets its own capped
  // strictly-pre-anchor window — later anchors' volume can never crowd out an
  // earlier anchor's evidence, and future data never changes past results).
  const byWallet = new Map<string, typeof observations>();
  for (const o of observations) {
    const list = byWallet.get(o.walletAddress) ?? [];
    list.push(o);
    byWallet.set(o.walletAddress, list);
  }

  // Cross-wallet cache of linked-wallet dormancy contexts (bounded).
  const cpCtxCache = new Map<string, WalletDormancyContext>();
  const CP_CTX_CACHE_MAX = 500;

  for (const [walletAddress, walletObs] of byWallet) {
    try {
      const wallet = await prisma.wallet.findUnique({
        where: { address_chain: { address: walletAddress, chain } },
        select: { id: true }
      });

      // --- wallet-level caches (service flags are not anchor-scoped: a hub
      // is a hub; degree/registry evidence is conservative TOWARD exclusion).
      const serviceCache = new Map<string, string | null>(); // cp -> basis | null (checked, not service)
      const ensureServiceFlags = async (cps: string[]): Promise<void> => {
        const missing = cps.filter((a) => !serviceCache.has(a));
        if (missing.length === 0) return;
        const flags = await lookupServiceCounterparties(prisma, chain, missing);
        for (const a of missing) serviceCache.set(a, flags.get(a) ?? null);
      };
      const memberIdCache = new Map<string, string | null>(); // address -> wallet id | null (absent)
      const ensureMemberIds = async (addresses: string[]): Promise<void> => {
        const missing = addresses.filter((a) => !memberIdCache.has(a));
        if (missing.length === 0) return;
        const rows = await prisma.wallet.findMany({
          where: { chain, address: { in: missing } },
          select: { id: true, address: true }
        });
        const found = new Map(rows.map((w) => [w.address, w.id]));
        for (const a of missing) memberIdCache.set(a, found.get(a) ?? null);
      };

      const cpChainOf = (e: EdgeLite): { cp: string; cpChain: 'SOLANA' | 'BSC' } => {
        const inbound = e.destinationAddress === walletAddress && e.destinationChain === chain;
        return {
          cp: inbound ? e.sourceAddress : e.destinationAddress,
          cpChain: (inbound ? e.sourceChain : e.destinationChain) as 'SOLANA' | 'BSC'
        };
      };

      // --- linked-wallet dormancy contexts (same-chain candidates only) -----
      const cpContexts = new Map<string, WalletDormancyContext>();
      const contextFor = async (cp: string): Promise<WalletDormancyContext> => {
        let ctx = cpContexts.get(cp);
        if (ctx) return ctx;
        const key = `${chain}|${cp}`;
        ctx = cpCtxCache.get(key);
        if (!ctx) {
          ctx = await loadWalletDormancyContext(
            prisma,
            { chain, address: cp },
            { ensureClassifications: opts.ensureClassifications }
          );
          if (cpCtxCache.size < CP_CTX_CACHE_MAX) cpCtxCache.set(key, ctx);
        }
        cpContexts.set(cp, ctx);
        return ctx;
      };

      // Target's own context — for the reactivation probe.
      const targetCtx = await loadWalletDormancyContext(
        prisma,
        { chain, address: walletAddress },
        { ensureClassifications: opts.ensureClassifications }
      );

      // --- per observation: ALL evidence fetched pre-anchor, capped ----------
      for (const obs of walletObs) {
        const eventMs = obs.eventTs.getTime();

        // Relationships known strictly BEFORE this anchor (in-query, so the
        // cap can never be crowded by post-anchor rows), same-chain far side,
        // self-relationships excluded, strongest-first stable order.
        const relRows = wallet
          ? await prisma.walletRelationship.findMany({
              where: {
                firstSeenAt: { lt: obs.eventTs },
                NOT: { walletAId: wallet.id, walletBId: wallet.id },
                OR: [
                  { walletAId: wallet.id, walletB: { chain } },
                  { walletBId: wallet.id, walletA: { chain } }
                ]
              },
              orderBy: [{ confidence: 'desc' }, { id: 'asc' }],
              take: maxRelationships + 1,
              select: {
                id: true,
                kind: true,
                confidence: true,
                walletA: { select: { address: true } },
                walletB: { select: { address: true } }
              }
            })
          : [];
        const relationshipsTruncated = relRows.length > maxRelationships;
        const relationships: RelLite[] = relRows
          .slice(0, maxRelationships)
          .map((r) => {
            const other = r.walletA.address === walletAddress ? r.walletB.address : r.walletA.address;
            if (other === walletAddress) return null; // defensive: self never links
            return { id: r.id, kind: r.kind as string, confidence: r.confidence, cp: other };
          })
          .filter((r): r is RelLite => r !== null);

        // Edges strictly BEFORE this anchor (in-query), newest-first + id
        // tiebreaker — the cap is a per-anchor window, immune to later volume.
        const edgeRows: EdgeLite[] = await prisma.moneyFlowEdge.findMany({
          where: {
            ts: { lt: obs.eventTs },
            OR: [
              { sourceAddress: walletAddress, sourceChain: chain },
              { destinationAddress: walletAddress, destinationChain: chain }
            ]
          },
          orderBy: [{ ts: 'desc' }, { id: 'desc' }],
          take: maxEdges + 1,
          select: {
            id: true,
            sourceAddress: true,
            destinationAddress: true,
            sourceChain: true,
            destinationChain: true,
            ts: true,
            txHash: true,
            valuedUsd: true
          }
        });
        const edgesTruncated = edgeRows.length > maxEdges;
        const preEdges = edgeRows.slice(0, maxEdges);

        // Per-counterparty evidence, strictly pre-anchor. Candidacy needs a
        // relationship known BEFORE the anchor or >=1 VALUED (>dust) edge —
        // dust and unknown-value transfers are tallied but never evidence.
        interface CandidateData {
          cp: string;
          relationshipIds: string[];
          relationshipKinds: string[];
          relationshipMaxConfidence: number;
          valuedEdgeIds: string[];
          valuedEdgeTxHashes: string[];
          valuedEdgeCount: number;
          unknownValueTransfers: number;
          dustTransfers: number;
        }
        const candidates = new Map<string, CandidateData>();
        const candidateOf = (cp: string): CandidateData => {
          let c = candidates.get(cp);
          if (!c) {
            c = {
              cp,
              relationshipIds: [],
              relationshipKinds: [],
              relationshipMaxConfidence: 0,
              valuedEdgeIds: [],
              valuedEdgeTxHashes: [],
              valuedEdgeCount: 0,
              unknownValueTransfers: 0,
              dustTransfers: 0
            };
            candidates.set(cp, c);
          }
          return c;
        };
        for (const r of relationships) {
          const c = candidateOf(r.cp);
          c.relationshipIds.push(r.id);
          c.relationshipKinds.push(r.kind);
          c.relationshipMaxConfidence = Math.max(c.relationshipMaxConfidence, r.confidence);
        }
        for (const e of preEdges) {
          const { cp, cpChain } = cpChainOf(e);
          if (cp === walletAddress || cpChain !== chain) continue; // self / cross-chain never link
          const c = candidateOf(cp);
          if (e.valuedUsd === null) {
            c.unknownValueTransfers += 1;
          } else if (Number(e.valuedUsd) <= dustMaxUsd) {
            c.dustTransfers += 1;
          } else {
            c.valuedEdgeCount += 1;
            if (c.valuedEdgeIds.length < 10) {
              c.valuedEdgeIds.push(e.id);
              c.valuedEdgeTxHashes.push(e.txHash);
            }
          }
        }

        // Qualify + exclude services (registry + degree, wallet-level cached)
        // + cap deterministically.
        await ensureServiceFlags([...candidates.keys()]);
        let serviceExcluded = 0;
        const qualifying: CandidateData[] = [];
        for (const c of candidates.values()) {
          if (c.relationshipIds.length === 0 && c.valuedEdgeCount === 0) continue; // dust/unknown-only: never a link
          if (serviceCache.get(c.cp) != null) {
            serviceExcluded += 1;
            continue;
          }
          qualifying.push(c);
        }
        qualifying.sort(
          (a, b) =>
            b.relationshipMaxConfidence - a.relationshipMaxConfidence ||
            b.valuedEdgeCount - a.valuedEdgeCount ||
            (a.cp < b.cp ? -1 : 1)
        );
        const kept = qualifying.slice(0, maxLinked);
        const candidatesDropped = qualifying.length - kept.length;
        report.serviceNodesExcludedTotal += serviceExcluded;

        // Receipts-engine tier evidence over strictly-pre-anchor member data
        // (member trades are fetched per anchor with ts < anchor IN-QUERY, so
        // inter-anchor trade volume can never displace older evidence).
        const receiptTierByCp = new Map<string, { tier: LinkTier; classification: string; confidence: number }>();
        let memberTradesTruncated = false;
        let receiptsMembersCapped = false;
        if (opts.useReceiptsEngine !== false && kept.length > 0) {
          const memberAddresses = [walletAddress, ...kept.map((c) => c.cp)].slice(0, 40);
          receiptsMembersCapped = 1 + kept.length > memberAddresses.length;
          await ensureMemberIds(memberAddresses);
          const idToAddress = new Map<string, string>();
          for (const a of memberAddresses) {
            const id = memberIdCache.get(a);
            if (id) idToAddress.set(id, a);
          }
          let trades: ReceiptTradeInput[] = [];
          if (idToAddress.size > 0) {
            const tradeRows = await prisma.walletTokenTrade.findMany({
              where: { walletId: { in: [...idToAddress.keys()] }, chain, ts: { lt: obs.eventTs } },
              orderBy: [{ ts: 'desc' }, { id: 'desc' }],
              take: maxMemberTrades + 1,
              select: {
                walletId: true,
                action: true,
                amountUsd: true,
                ts: true,
                blockOrSlot: true,
                txHash: true,
                marketCapAtTrade: true,
                token: { select: { address: true } }
              }
            });
            memberTradesTruncated = tradeRows.length > maxMemberTrades;
            trades = tradeRows
              .slice(0, maxMemberTrades)
              .filter((t) => t.action === 'BUY' || t.action === 'SELL')
              .map((t) => ({
                walletAddress: idToAddress.get(t.walletId) as string,
                tokenAddress: t.token.address,
                action: t.action as 'BUY' | 'SELL',
                amountUsd: Number(t.amountUsd),
                ts: t.ts,
                blockOrSlot: t.blockOrSlot,
                txHash: t.txHash,
                marketCapAtTrade: t.marketCapAtTrade === null ? null : Number(t.marketCapAtTrade)
              }));
          }
          const memberSet = new Set(memberAddresses);
          const transfers: ReceiptTransferInput[] = preEdges
            .filter((e) => memberSet.has(e.sourceAddress) && memberSet.has(e.destinationAddress))
            .map((e) => ({
              sourceAddress: e.sourceAddress,
              destinationAddress: e.destinationAddress,
              usd: e.valuedUsd === null ? null : Number(e.valuedUsd),
              ts: e.ts,
              txHash: e.txHash
            }));
          const receiptsResult = deriveBehaviorReceipts({ trades, transfers, now });
          for (const r of receiptsResult.receipts) {
            const tier: LinkTier | null =
              r.classification === 'strong_onchain_link'
                ? 'strong'
                : r.classification === 'probable_side_wallet'
                  ? 'probable'
                  : r.classification === 'possible_side_wallet'
                    ? 'possible'
                    : null;
            if (!tier) continue;
            if (!r.wallets.includes(walletAddress)) continue;
            const cp = r.wallets.find((w) => w !== walletAddress);
            if (!cp) continue;
            const prev = receiptTierByCp.get(cp);
            if (!prev || TIER_RANK[tier] > TIER_RANK[prev.tier]) {
              receiptTierByCp.set(cp, { tier, classification: r.classification, confidence: r.confidence });
            }
          }
        }

        // Near-event funding: dedicated bounded strictly-pre-event probe.
        // VALUED (>dust) funders are evidence; unknown-value funders are
        // reported but never evidence; dust is neither.
        const fundingRows = await prisma.moneyFlowEdge.findMany({
          where: {
            destinationAddress: walletAddress,
            destinationChain: chain,
            ts: { gte: new Date(eventMs - reactivationWindowMs), lt: obs.eventTs }
          },
          // Stable order under the cap: closest-to-anchor first, id tiebreaker.
          orderBy: [{ ts: 'desc' }, { id: 'desc' }],
          take: 201,
          select: { sourceAddress: true, valuedUsd: true }
        });
        const fundingProbeTruncated = fundingRows.length > 200;
        const valuedFunders = new Set<string>();
        const unknownValueFunders = new Set<string>();
        for (const f of fundingRows.slice(0, 200)) {
          if (f.valuedUsd === null) unknownValueFunders.add(f.sourceAddress);
          else if (Number(f.valuedUsd) > dustMaxUsd) valuedFunders.add(f.sourceAddress);
        }

        // Independence needs a COMPLETE per-anchor view: any truncation —
        // relationships, edges, candidate cap, funding probe, or the
        // receipts-engine trade window (a missed tier upgrade could hide an
        // unknown-history PROBABLE link) — blocks it.
        const linkDiscoveryComplete =
          !relationshipsTruncated &&
          !edgesTruncated &&
          candidatesDropped === 0 &&
          !fundingProbeTruncated &&
          !memberTradesTruncated;

        // Assemble per-link assessments.
        const links: EntityLinkAssessment[] = [];
        for (const c of kept) {
          const ctx = await contextFor(c.cp);
          const cpResult = assessFromContext(ctx, obs.eventTs);
          const anyWindowActive = cpResult.windows.some((w) => w.class === 'active');
          const linkedActivity: LinkedActivity = anyWindowActive
            ? 'active_pre_event'
            : cpResult.maxCoveredDormantDays !== null
              ? 'dormant_covered'
              : 'unknown';
          const fundedTargetNearEvent = valuedFunders.has(c.cp);
          const receiptTier = receiptTierByCp.get(c.cp) ?? null;
          const relTier: LinkTier | null =
            c.relationshipIds.length > 0 ? tierOfConfidence(c.relationshipMaxConfidence) : null;
          const edgeTier: LinkTier | null = c.valuedEdgeCount > 0 ? 'possible' : null;
          const tiers = [receiptTier?.tier, relTier, edgeTier].filter((t): t is LinkTier => t != null);
          const tier = tiers.sort((a, b) => TIER_RANK[b] - TIER_RANK[a])[0] ?? 'possible';
          const confidence = Math.min(
            100,
            Math.max(
              c.relationshipIds.length > 0 ? c.relationshipMaxConfidence : 0,
              receiptTier?.confidence ?? 0,
              c.valuedEdgeCount > 0 ? 35 : 0
            )
          );
          links.push({
            counterpartyAddress: c.cp,
            tier,
            kinds: [
              ...new Set([
                ...c.relationshipKinds,
                ...(c.valuedEdgeCount > 0 ? ['direct_transfer'] : []),
                ...(receiptTier ? [receiptTier.classification] : [])
              ])
            ],
            confidence,
            linkedActivity,
            linkedMeaningfulPreEventCount: cpResult.receipts.preEventMeaningfulCount,
            fundedTargetNearEvent,
            unknownValueFundingNearEvent: unknownValueFunders.has(c.cp),
            isFunder: c.relationshipKinds.some((k) => FUNDING_KINDS.has(k)) || fundedTargetNearEvent,
            unknownValueTransfers: c.unknownValueTransfers,
            dustTransfers: c.dustTransfers,
            evidence: {
              txHashes: c.valuedEdgeTxHashes.slice(0, 10),
              relationshipIds: c.relationshipIds,
              edgeIds: c.valuedEdgeIds.slice(0, 10),
              receiptClassifications: receiptTier ? [receiptTier.classification] : []
            }
          });
        }
        report.linksConsideredTotal += links.length;

        // Reactivation probe: address 'active' only because of a recent burst —
        // re-anchor dormancy at the burst start (earlier than the anchor, so no
        // lookahead) and ask whether the address was COVERED-dormant before it.
        // The re-anchored assessment itself verifies the pre-burst quiet (any
        // meaningful event inside its windows makes it 'active', not dormant).
        let addressRecentlyReactivated = false;
        if (obs.overallClass === 'active') {
          const recent = targetCtx.meaningfulEvents.filter(
            (e) => e.ts.getTime() < eventMs && eventMs - e.ts.getTime() <= reactivationWindowMs
          );
          if (recent.length > 0) {
            const burstStart = new Date(Math.min(...recent.map((e) => e.ts.getTime())));
            const reanchored = assessFromContext(targetCtx, burstStart);
            addressRecentlyReactivated = reanchored.overallClass === 'covered_dormant';
          }
        }

        const decision = classifyEntityDormancyDecision({
          addressClass: obs.overallClass as DormancyClass,
          links,
          serviceNodesExcluded: serviceExcluded,
          linkDiscoveryComplete,
          addressRecentlyReactivated
        });

        const data = {
          chain,
          walletAddress,
          eventKind: obs.eventKind,
          anchorKey: obs.anchorKey,
          eventTs: obs.eventTs,
          entityClass: decision.entityClass,
          addressClass: obs.overallClass,
          linkedWalletsConsidered: links.length,
          linkedWalletsActive: links.filter((l) => l.linkedActivity === 'active_pre_event').length,
          serviceNodesExcluded: serviceExcluded,
          confidence: decision.confidence,
          reasonCodes: decision.reasonCodes,
          linksJson: links as unknown as Prisma.InputJsonValue,
          receiptsJson: {
            addressRecentlyReactivated,
            reactivationWindowDays: opts.reactivationWindowDays ?? 7,
            linkDiscoveryComplete,
            relationshipsTruncated,
            edgesTruncated,
            fundingProbeTruncated,
            candidatesDropped,
            candidatesQualifying: qualifying.length,
            receiptsEngineUsed: opts.useReceiptsEngine !== false,
            receiptsMembersCapped,
            memberTradesTruncated,
            unknownValueFundersNearEvent: unknownValueFunders.size
          } as unknown as Prisma.InputJsonValue,
          caveats: decision.caveats,
          engineVersion: ENTITY_DORMANCY_ENGINE_VERSION
        };
        await prisma.entityDormancyObservation.upsert({
          where: {
            chain_walletAddress_eventKind_anchorKey: {
              chain,
              walletAddress,
              eventKind: obs.eventKind,
              anchorKey: obs.anchorKey
            }
          },
          create: data,
          update: data
        });
        report.observationsWritten += 1;
        report.byEntityClass[decision.entityClass] = (report.byEntityClass[decision.entityClass] ?? 0) + 1;
      }
      report.walletsProcessed += 1;
    } catch (err) {
      report.errors += 1;
      if (report.errorReceipts.length < ERROR_RECEIPTS_MAX) {
        report.errorReceipts.push(toErrorReceipt(walletAddress, err));
      }
    }
  }
  return report;
}
