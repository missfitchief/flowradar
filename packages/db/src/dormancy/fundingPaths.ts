// FlowRadar — funding/reactivation path builder (dormancy Task 9).
//
// For each Task 7 anchor (wallet-token entry), traces the strictly-pre-event
// funding path INTO the wallet over money_flow_edges: the direct (nearest)
// and first (earliest) VALUED funders, then a bounded backward BFS over the
// funders' own funding (depth <= 3, nodes <= 50, at most a few parents per
// node) — service nodes are path TERMINALS, never expanded.
//
// Honesty/safety rules:
//   - NO LOOKAHEAD: every query is anchored ts < eventTs (and each hop is
//     anchored before the funding it explains).
//   - Valuation is HONEST: only VALUED (>dust) transfers are funding
//     evidence; unknown-value inbound is REPORTED (status
//     unknown_value_funding_only) but never treated as funding; dust never
//     counts.
//   - Relationship tier between wallet and direct funder uses only
//     relationships first seen BEFORE the anchor (neutral wording).
//   - Bounded + stable-ordered everywhere; per-wallet error receipts;
//     idempotent unique upserts. SHADOW-ONLY writes.

import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { DEFAULT_SETTINGS, isServiceNode } from '@flowradar/core';
import { toErrorReceipt, ERROR_RECEIPTS_MAX } from './activity';
import type { WalletErrorReceipt } from './activity';
import { relationshipTierOfConfidence } from './entityDormancy';

export const FUNDING_PATH_ENGINE_VERSION = 1;

export type FundingPathStatus =
  | 'funded'
  | 'unknown_value_funding_only'
  | 'no_meaningful_pre_event_funding'
  | 'no_transfer_history';

export interface FundingPathHop {
  hop: number;
  /** The address that SENT the funding at this hop. */
  address: string;
  /** The address it funded (previous path node). */
  fundedAddress: string;
  ts: string;
  txHash: string;
  asset: string | null;
  /** HONEST valuation — null == unknown. */
  valuedUsd: number | null;
  /** Terminal service node (registry/degree) — never expanded further. */
  serviceNode: boolean;
  serviceBasis: string | null;
}

export interface FundingPathBatchReport {
  observationsConsidered: number;
  pathsWritten: number;
  walletsProcessed: number;
  errors: number;
  errorReceipts: WalletErrorReceipt[];
  byStatus: Record<string, number>;
}

const BASE_CAVEATS = [
  'funding paths are bounded local observation over money_flow_edges — unobserved hops cannot be excluded',
  'funder links are probabilistic on-chain relationships — never identity or same-person claims',
  'observation-only: nothing here grants signal eligibility, votes, or promotion'
];

export async function buildFundingReactivationPaths(
  prisma: PrismaClient,
  opts: {
    chain?: 'SOLANA' | 'BSC';
    walletAddresses?: string[];
    /** Bound on anchor observations processed this pass. */
    limit?: number;
    /** Backward BFS depth (hops of funding provenance). */
    maxDepth?: number;
    /** Total path nodes explored per anchor. */
    maxNodes?: number;
    /** Parents fetched per node (nearest-first). */
    maxParentsPerNode?: number;
  } = {}
): Promise<FundingPathBatchReport> {
  const chain = opts.chain ?? 'SOLANA';
  const limit = opts.limit ?? 500;
  const maxDepth = Math.min(opts.maxDepth ?? 3, 3);
  const maxNodes = Math.min(opts.maxNodes ?? 50, 50);
  const maxParents = Math.min(opts.maxParentsPerNode ?? 2, 5);
  const dustMaxUsd = DEFAULT_SETTINGS.lineage.dustMaxUsd;

  const observations = await prisma.addressDormancyObservation.findMany({
    where: {
      chain,
      ...(opts.walletAddresses ? { walletAddress: { in: opts.walletAddresses } } : {})
    },
    orderBy: [{ walletAddress: 'asc' }, { eventKind: 'asc' }, { anchorKey: 'asc' }],
    take: limit,
    select: { walletAddress: true, eventKind: true, anchorKey: true, eventTs: true }
  });

  const report: FundingPathBatchReport = {
    observationsConsidered: observations.length,
    pathsWritten: 0,
    walletsProcessed: 0,
    errors: 0,
    errorReceipts: [],
    byStatus: {}
  };

  const byWallet = new Map<string, typeof observations>();
  for (const o of observations) {
    const list = byWallet.get(o.walletAddress) ?? [];
    list.push(o);
    byWallet.set(o.walletAddress, list);
  }

  for (const [walletAddress, walletObs] of byWallet) {
    try {
      const wallet = await prisma.wallet.findUnique({
        where: { address_chain: { address: walletAddress, chain } },
        select: { id: true }
      });
      // ANCHOR-AWARE service detection: registry categories are timeless
      // evidence, but the fan-out DEGREE is computed over strictly-pre-anchor
      // edges only — an address that became a hub AFTER the event must not be
      // retroactively treated as a service terminal. Cached per (address,
      // anchor) since different anchors see different degrees.
      const serviceCache = new Map<string, string | null>();
      const serviceBasisOf = async (address: string, anchorTs: Date): Promise<string | null> => {
        const key = `${address}|${anchorTs.getTime()}`;
        if (!serviceCache.has(key)) {
          const registry = await prisma.addressRegistry.findFirst({
            where: { chain, address },
            select: { category: true }
          });
          const [outDeg, inDeg] = await Promise.all([
            prisma.moneyFlowEdge.findMany({
              where: { sourceAddress: address, sourceChain: chain, ts: { lt: anchorTs } },
              select: { destinationAddress: true },
              distinct: ['destinationAddress'],
              take: 250
            }),
            prisma.moneyFlowEdge.findMany({
              where: { destinationAddress: address, destinationChain: chain, ts: { lt: anchorTs } },
              select: { sourceAddress: true },
              distinct: ['sourceAddress'],
              take: 250
            })
          ]);
          const degreeSet = new Set<string>();
          for (const e of outDeg) degreeSet.add(e.destinationAddress);
          for (const e of inDeg) degreeSet.add(e.sourceAddress);
          const category = registry?.category ?? null;
          const service = isServiceNode(
            { registryCategory: category as never, distinctCounterparties: degreeSet.size },
            DEFAULT_SETTINGS.lineage
          );
          serviceCache.set(
            key,
            service ? (category !== null ? `address_registry:${category}` : `fanout_degree_pre_anchor:${degreeSet.size}`) : null
          );
        }
        return serviceCache.get(key) as string | null;
      };

      for (const obs of walletObs) {
        const caveats = [...BASE_CAVEATS];
        const reasons: string[] = [];

        // Direct funder: NEAREST valued (>dust) pre-event inbound. SAME-CHAIN
        // sources only — a cross-chain edge's source address lives on the
        // other chain and must never be reinterpreted as a local funder
        // (cross-chain inbound is counted and reported below instead).
        const direct = await prisma.moneyFlowEdge.findFirst({
          where: {
            destinationAddress: walletAddress,
            destinationChain: chain,
            sourceChain: chain,
            ts: { lt: obs.eventTs },
            valuedUsd: { gt: dustMaxUsd }
          },
          orderBy: [{ ts: 'desc' }, { id: 'desc' }],
          select: { sourceAddress: true, ts: true, txHash: true, asset: true, valuedUsd: true }
        });
        // First funder: EARLIEST valued pre-event inbound (same-chain).
        const first = direct
          ? await prisma.moneyFlowEdge.findFirst({
              where: {
                destinationAddress: walletAddress,
                destinationChain: chain,
                sourceChain: chain,
                ts: { lt: obs.eventTs },
                valuedUsd: { gt: dustMaxUsd }
              },
              orderBy: [{ ts: 'asc' }, { id: 'asc' }],
              select: { sourceAddress: true, ts: true, txHash: true }
            })
          : null;
        // Cross-chain valued inbound is REPORTED, never traced as a funder.
        const crossChainInbound = await prisma.moneyFlowEdge.count({
          where: {
            destinationAddress: walletAddress,
            destinationChain: chain,
            sourceChain: { not: chain },
            ts: { lt: obs.eventTs },
            valuedUsd: { gt: dustMaxUsd }
          }
        });

        // Honest status when no valued funding exists.
        let status: FundingPathStatus = 'funded';
        let unknownValueInbound = 0;
        let dustInbound = 0;
        if (!direct) {
          const [unknownCount, dustCount, anyCount] = await Promise.all([
            prisma.moneyFlowEdge.count({
              where: {
                destinationAddress: walletAddress,
                destinationChain: chain,
                ts: { lt: obs.eventTs },
                valuedUsd: null
              }
            }),
            prisma.moneyFlowEdge.count({
              where: {
                destinationAddress: walletAddress,
                destinationChain: chain,
                ts: { lt: obs.eventTs },
                valuedUsd: { lte: dustMaxUsd }
              }
            }),
            prisma.moneyFlowEdge.count({
              where: {
                OR: [
                  { sourceAddress: walletAddress, sourceChain: chain },
                  { destinationAddress: walletAddress, destinationChain: chain }
                ],
                ts: { lt: obs.eventTs }
              }
            })
          ]);
          unknownValueInbound = unknownCount;
          dustInbound = dustCount;
          if (unknownCount > 0) {
            status = 'unknown_value_funding_only';
            reasons.push('only_unknown_value_inbound_pre_event');
            caveats.push('unknown-value inbound exists — unknown is reported, never treated as funding evidence');
          } else if (anyCount > 0) {
            status = 'no_meaningful_pre_event_funding';
            reasons.push(dustCount > 0 ? 'only_dust_inbound_pre_event' : 'no_pre_event_inbound');
          } else {
            status = 'no_transfer_history';
            reasons.push('no_pre_event_transfer_history');
          }
          if (crossChainInbound > 0) {
            reasons.push('cross_chain_inbound_not_traced');
            caveats.push(
              `${crossChainInbound} valued cross-chain inbound transfer(s) exist pre-event — reported only, never traced as same-chain funding`
            );
          }
        } else {
          reasons.push('valued_pre_event_funding_found');
        }

        // Backward BFS from the direct funder (bounded, service-terminal).
        const path: FundingPathHop[] = [];
        let nodesExplored = 0;
        let pathTruncated = false;
        let pathDepth = 0;
        if (direct) {
          const visited = new Set<string>([walletAddress]);
          interface Frontier {
            address: string;
            fundedAddress: string;
            fundingTs: Date;
            hop: number;
            ts: Date;
            txHash: string;
            asset: string | null;
            valuedUsd: number | null;
          }
          let frontier: Frontier[] = [
            {
              address: direct.sourceAddress,
              fundedAddress: walletAddress,
              fundingTs: direct.ts,
              hop: 1,
              ts: direct.ts,
              txHash: direct.txHash,
              asset: direct.asset ?? null,
              valuedUsd: direct.valuedUsd === null ? null : Number(direct.valuedUsd)
            }
          ];
          while (frontier.length > 0) {
            const next: Frontier[] = [];
            for (const node of frontier) {
              if (nodesExplored >= maxNodes) {
                pathTruncated = true;
                break;
              }
              nodesExplored += 1;
              pathDepth = Math.max(pathDepth, node.hop);
              const serviceBasis = await serviceBasisOf(node.address, obs.eventTs);
              path.push({
                hop: node.hop,
                address: node.address,
                fundedAddress: node.fundedAddress,
                ts: node.ts.toISOString(),
                txHash: node.txHash,
                asset: node.asset,
                valuedUsd: node.valuedUsd,
                serviceNode: serviceBasis !== null,
                serviceBasis
              });
              // Service nodes and revisits are terminals; depth bound applies.
              if (serviceBasis !== null || node.hop >= maxDepth || visited.has(node.address)) continue;
              visited.add(node.address);
              // The capital that funded THIS funder must precede the funding
              // it sent (strictly before node.fundingTs — hop-local anchor).
              const parents = await prisma.moneyFlowEdge.findMany({
                where: {
                  destinationAddress: node.address,
                  destinationChain: chain,
                  sourceChain: chain,
                  ts: { lt: node.fundingTs },
                  valuedUsd: { gt: dustMaxUsd }
                },
                orderBy: [{ ts: 'desc' }, { id: 'desc' }],
                take: maxParents + 1,
                select: { sourceAddress: true, ts: true, txHash: true, asset: true, valuedUsd: true }
              });
              if (parents.length > maxParents) pathTruncated = true;
              for (const p of parents.slice(0, maxParents)) {
                next.push({
                  address: p.sourceAddress,
                  fundedAddress: node.address,
                  fundingTs: p.ts,
                  hop: node.hop + 1,
                  ts: p.ts,
                  txHash: p.txHash,
                  asset: p.asset ?? null,
                  valuedUsd: p.valuedUsd === null ? null : Number(p.valuedUsd)
                });
              }
            }
            if (nodesExplored >= maxNodes) {
              if (next.length > 0) pathTruncated = true;
              break;
            }
            frontier = next;
          }
        }

        // Relationship tier wallet<->direct funder — PRE-ANCHOR ONLY, and the
        // relationship's AGGREGATE must be fully pre-anchor (lastSeenAt <
        // anchor): a row whose confidence was strengthened by post-anchor
        // interactions can never be tiered retroactively.
        let funderRelationshipTier: string | null = null;
        let funderRelationshipConfidence: number | null = null;
        let funderRelationshipSpansAnchor = false;
        if (direct && wallet) {
          const funderWallet = await prisma.wallet.findUnique({
            where: { address_chain: { address: direct.sourceAddress, chain } },
            select: { id: true }
          });
          if (funderWallet) {
            const rel = await prisma.walletRelationship.findFirst({
              where: {
                firstSeenAt: { lt: obs.eventTs },
                lastSeenAt: { lt: obs.eventTs },
                OR: [
                  { walletAId: wallet.id, walletBId: funderWallet.id },
                  { walletAId: funderWallet.id, walletBId: wallet.id }
                ]
              },
              orderBy: [{ confidence: 'desc' }, { id: 'asc' }],
              select: { confidence: true }
            });
            if (rel) {
              funderRelationshipTier = relationshipTierOfConfidence(rel.confidence);
              funderRelationshipConfidence = rel.confidence;
              reasons.push('funder_has_pre_event_relationship');
            } else {
              const spanning = await prisma.walletRelationship.findFirst({
                where: {
                  firstSeenAt: { lt: obs.eventTs },
                  lastSeenAt: { gte: obs.eventTs },
                  OR: [
                    { walletAId: wallet.id, walletBId: funderWallet.id },
                    { walletAId: funderWallet.id, walletBId: wallet.id }
                  ]
                },
                select: { id: true }
              });
              if (spanning) {
                funderRelationshipSpansAnchor = true;
                reasons.push('funder_relationship_spans_anchor');
                caveats.push(
                  'a wallet-funder relationship exists but its aggregate confidence spans the anchor — no pre-event tier can be honestly assigned'
                );
              }
            }
          }
        }

        // Repeat pattern: prior VALUED fundings from the same funder (bounded count).
        let repeatFundingCount = 0;
        if (direct) {
          const priors = await prisma.moneyFlowEdge.findMany({
            where: {
              sourceAddress: direct.sourceAddress,
              sourceChain: chain,
              destinationAddress: walletAddress,
              destinationChain: chain,
              ts: { lt: direct.ts },
              valuedUsd: { gt: dustMaxUsd }
            },
            orderBy: [{ ts: 'desc' }, { id: 'desc' }],
            take: 51,
            select: { id: true }
          });
          repeatFundingCount = Math.min(priors.length, 50);
          if (priors.length > 50) caveats.push('repeat-funding count capped at 50');
          if (repeatFundingCount > 0) reasons.push('funder_previously_funded_this_wallet');
        }

        const fundingToEventDelaySec = direct
          ? Math.round((obs.eventTs.getTime() - direct.ts.getTime()) / 1000)
          : null;

        const data = {
          chain,
          walletAddress,
          eventKind: obs.eventKind,
          anchorKey: obs.anchorKey,
          eventTs: obs.eventTs,
          status,
          directFunderAddress: direct?.sourceAddress ?? null,
          directFundingTs: direct?.ts ?? null,
          directFundingAsset: direct?.asset ?? null,
          directFundingValuedUsd: direct?.valuedUsd ?? null,
          directFundingTxHash: direct?.txHash ?? null,
          firstFunderAddress: first?.sourceAddress ?? null,
          firstFundingTs: first?.ts ?? null,
          firstFundingTxHash: first?.txHash ?? null,
          fundingToEventDelaySec,
          pathDepth,
          nodesExplored,
          pathTruncated,
          pathJson: path as unknown as Prisma.InputJsonValue,
          funderRelationshipTier,
          funderRelationshipConfidence,
          repeatFundingCount,
          reasonCodes: reasons,
          receiptsJson: {
            dustMaxUsd,
            maxDepth,
            maxNodes,
            maxParentsPerNode: maxParents,
            unknownValueInboundPreEvent: unknownValueInbound,
            dustInboundPreEvent: dustInbound,
            crossChainValuedInboundPreEvent: crossChainInbound,
            funderRelationshipSpansAnchor,
            serviceDegreeAnchorAware: true
          } as unknown as Prisma.InputJsonValue,
          caveats,
          engineVersion: FUNDING_PATH_ENGINE_VERSION
        };
        await prisma.fundingReactivationPath.upsert({
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
        report.pathsWritten += 1;
        report.byStatus[status] = (report.byStatus[status] ?? 0) + 1;
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
