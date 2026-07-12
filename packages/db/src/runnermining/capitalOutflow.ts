// FlowRadar — capital outflow tracking + receiver enrollment (working-loop
// milestone). The FORWARD complement of the T9 funding builder: where does
// capital LEAVE a qualified (DNA-discovered) wallet, and who receives it?
//
// Evidence tiers are ORDERED and binding (strongest first):
//   direct_transfer      — one valued same-chain transfer hop
//   multi_hop_transfer   — bounded forward BFS through transfer hops (<=3)
//   bridge_inference     — a bridge_deposit/withdrawal edge: capital left the
//                          local observability domain; the bridge protocol is
//                          recorded but NO downstream receiver is attributed.
//   cex_correlation      — a cex_deposit edge: correlation-only; a CEX
//                          deposit NEVER attributes any downstream receiver.
//
// Honesty/safety rules (same family as fundingPaths.ts):
//   - only VALUED (> dust) legs are capital-movement evidence; unknown-value
//     legs are counted and reported, never treated as movement;
//   - service nodes are terminals (anchor-aware degree + registry), never
//     expanded and never enrolled;
//   - receivers are enrolled from transfer tiers ONLY, strictly
//     observation_only, in a dedicated shadow table (the live monitoring
//     machinery is never touched);
//   - bounded + stable-ordered everywhere; per-wallet error receipts;
//     idempotent unique upserts. SHADOW-ONLY writes.

import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { DEFAULT_SETTINGS, isServiceNode } from '@flowradar/core';
import { toErrorReceipt, ERROR_RECEIPTS_MAX } from '../dormancy/activity';
import type { WalletErrorReceipt } from '../dormancy/activity';
import { relationshipTierOfConfidence } from '../dormancy/entityDormancy';

export const CAPITAL_OUTFLOW_ENGINE_VERSION = 1;
export const RECEIVER_ENROLLMENT_ENGINE_VERSION = 1;

export type OutflowEvidenceTier =
  | 'direct_transfer'
  | 'multi_hop_transfer'
  | 'bridge_inference'
  | 'cex_correlation';

const OUTFLOW_CAVEATS = [
  'outflow paths are bounded local observation over money_flow_edges — unobserved hops cannot be excluded',
  'receiver links are probabilistic on-chain relationships — never identity or same-person claims',
  'observation-only: nothing here grants signal eligibility, votes, or promotion'
];

const CEX_CAVEAT =
  'cex_correlation is the WEAKEST tier: capital reached an exchange deposit path; no downstream receiver is (or ever will be) attributed from it';
const BRIDGE_CAVEAT =
  'bridge_inference: capital left local observability via a bridge; destination-chain continuation is not attributed';

export interface CapitalOutflowBatchReport {
  walletsConsidered: number;
  walletsProcessed: number;
  pathsWritten: number;
  byTier: Record<string, number>;
  byReceiverClass: Record<string, number>;
  errors: number;
  errorReceipts: WalletErrorReceipt[];
}

interface OutflowHop {
  hop: number;
  fromAddress: string;
  toAddress: string;
  ts: string;
  txHash: string;
  asset: string | null;
  valuedUsd: number | null;
  actionType: string;
}

/** Entity key of each wallet under the repeat-candidate entity adjustment. */
export async function entityKeysFor(
  prisma: PrismaClient,
  chain: 'SOLANA' | 'BSC',
  wallets: string[]
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const w of wallets) map.set(w, w); // default: the address itself
  if (wallets.length === 0) return map;
  const entities = await prisma.repeatRunnerCandidate.findMany({
    where: { chain, memberWallets: { hasSome: wallets } },
    orderBy: { entityKey: 'asc' },
    select: { entityKey: true, memberWallets: true }
  });
  for (const e of entities) {
    for (const m of e.memberWallets) if (map.has(m)) map.set(m, e.entityKey);
  }
  return map;
}

export async function buildCapitalOutflowPaths(
  prisma: PrismaClient,
  opts: {
    chain?: 'SOLANA' | 'BSC';
    /** Qualified source cohort; default = wallet_dna_profiles wallets. */
    walletAddresses?: string[];
    limit?: number;
    /** Forward BFS depth through transfer hops. */
    maxDepth?: number;
    /** Total nodes explored per source wallet. */
    maxNodes?: number;
    /** Outbound valued edges fetched per expanded node (earliest-first). */
    maxChildrenPerNode?: number;
    /** Outbound valued edges fetched from the SOURCE wallet itself — wider
     *  than per-node so discovery covers the wallet's whole observed life. */
    maxChildrenFirstHop?: number;
    /** Only trace outflows at/after this ts (e.g. after the profitable exit). */
    sinceTs?: Date;
  } = {}
): Promise<CapitalOutflowBatchReport> {
  const chain = opts.chain ?? 'SOLANA';
  const limit = opts.limit ?? 300;
  const maxDepth = Math.min(opts.maxDepth ?? 3, 3);
  const maxNodes = Math.min(opts.maxNodes ?? 50, 50);
  const maxChildren = Math.min(opts.maxChildrenPerNode ?? 5, 10);
  const maxChildrenFirstHop = Math.min(opts.maxChildrenFirstHop ?? 25, 50);
  const dustMaxUsd = DEFAULT_SETTINGS.lineage.dustMaxUsd;

  let sources: string[];
  if (opts.walletAddresses) {
    sources = [...new Set(opts.walletAddresses)].sort().slice(0, limit);
  } else {
    const rows = await prisma.walletDnaProfile.findMany({
      where: { chain },
      orderBy: { walletAddress: 'asc' },
      take: limit,
      select: { walletAddress: true }
    });
    sources = rows.map((r) => r.walletAddress);
  }
  const entityOf = await entityKeysFor(prisma, chain, sources);

  const report: CapitalOutflowBatchReport = {
    walletsConsidered: sources.length,
    walletsProcessed: 0,
    pathsWritten: 0,
    byTier: {},
    byReceiverClass: {},
    errors: 0,
    errorReceipts: []
  };

  for (const sourceWallet of sources) {
    try {
      const sourceEntityKey = entityOf.get(sourceWallet) ?? sourceWallet;
      const sinceFilter = opts.sinceTs ? { gte: opts.sinceTs } : undefined;

      // Anchor-aware service detection (degree strictly BEFORE the hop being
      // classified — same convention as fundingPaths.ts, forward direction).
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
          const degree = new Set<string>();
          for (const e of outDeg) degree.add(e.destinationAddress);
          for (const e of inDeg) degree.add(e.sourceAddress);
          const category = registry?.category ?? null;
          const service = isServiceNode(
            { registryCategory: category as never, distinctCounterparties: degree.size },
            DEFAULT_SETTINGS.lineage
          );
          serviceCache.set(
            key,
            service ? (category !== null ? `address_registry:${category}` : `fanout_degree_pre_hop:${degree.size}`) : null
          );
        }
        return serviceCache.get(key) as string | null;
      };

      // Aggregate per (destination, tier) across the walk.
      interface Agg {
        destinationType: string;
        tier: OutflowEvidenceTier;
        hops: number;
        transferCount: number;
        knownValueUsd: number | null;
        unknownValueLegs: number;
        firstTs: Date;
        lastTs: Date;
        bridgeProtocol: string | null;
        path: OutflowHop[];
        reasonCodes: Set<string>;
        caveats: Set<string>;
      }
      const aggs = new Map<string, Agg>();
      const record = (
        dest: string,
        destinationType: string,
        tier: OutflowEvidenceTier,
        hop: OutflowHop,
        bridgeProtocol: string | null
      ) => {
        const key = `${dest}|${tier}`;
        let a = aggs.get(key);
        const ts = new Date(hop.ts);
        if (!a) {
          a = {
            destinationType,
            tier,
            hops: hop.hop,
            transferCount: 0,
            knownValueUsd: null,
            unknownValueLegs: 0,
            firstTs: ts,
            lastTs: ts,
            bridgeProtocol,
            path: [],
            reasonCodes: new Set(),
            caveats: new Set()
          };
          aggs.set(key, a);
        }
        a.hops = Math.min(a.hops, hop.hop);
        a.transferCount += 1;
        if (hop.valuedUsd !== null) a.knownValueUsd = (a.knownValueUsd ?? 0) + hop.valuedUsd;
        else a.unknownValueLegs += 1;
        if (ts < a.firstTs) a.firstTs = ts;
        if (ts > a.lastTs) a.lastTs = ts;
        if (a.path.length < 20) a.path.push(hop);
        else a.caveats.add('path receipt capped at 20 hops');
        if (bridgeProtocol && !a.bridgeProtocol) a.bridgeProtocol = bridgeProtocol;
      };

      // Forward BFS from the source through VALUED transfer hops.
      const visited = new Set<string>([sourceWallet]);
      interface Frontier {
        address: string;
        hop: number;
        /** The transfer that reached this node (hops expand strictly after it). */
        arrivalTs: Date;
      }
      let frontier: Frontier[] = [{ address: sourceWallet, hop: 0, arrivalTs: opts.sinceTs ?? new Date(0) }];
      let nodesExplored = 0;
      let truncated = false;
      while (frontier.length > 0) {
        const next: Frontier[] = [];
        for (const node of frontier) {
          if (nodesExplored >= maxNodes) {
            truncated = true;
            break;
          }
          nodesExplored += 1;
          if (node.hop >= maxDepth) continue;
          const childCap = node.hop === 0 ? maxChildrenFirstHop : maxChildren;
          // Capital can only continue AFTER it arrived at this node. Only
          // VALUED (> dust) outflow-relevant legs are movement evidence —
          // unknown-value legs are COUNTED (receipts) but never traced, and
          // dex/lp/contract legs are deployments, not outflow hops.
          const outbound = await prisma.moneyFlowEdge.findMany({
            where: {
              sourceAddress: node.address,
              sourceChain: chain,
              ts: node.hop === 0 ? (sinceFilter ?? { gt: new Date(0) }) : { gt: node.arrivalTs },
              actionType: { in: ['transfer', 'bridge_deposit', 'bridge_withdrawal', 'cex_deposit'] },
              valuedUsd: { gt: dustMaxUsd }
            },
            orderBy: [{ ts: 'asc' }, { id: 'asc' }],
            take: childCap + 1,
            select: {
              destinationAddress: true,
              destinationChain: true,
              ts: true,
              txHash: true,
              asset: true,
              valuedUsd: true,
              actionType: true,
              bridgeProtocol: true
            }
          });
          if (outbound.length > childCap) truncated = true;
          for (const e of outbound.slice(0, childCap)) {
            const valued = e.valuedUsd === null ? null : Number(e.valuedUsd);
            const hop: OutflowHop = {
              hop: node.hop + 1,
              fromAddress: node.address,
              toAddress: e.destinationAddress,
              ts: e.ts.toISOString(),
              txHash: e.txHash,
              asset: e.asset ?? null,
              valuedUsd: valued,
              actionType: e.actionType
            };
            const isTransfer = e.actionType === 'transfer';
            const isBridge = e.actionType === 'bridge_deposit' || e.actionType === 'bridge_withdrawal';
            const isCex = e.actionType === 'cex_deposit';
            if (isBridge) {
              record(e.destinationAddress, 'bridge', 'bridge_inference', hop, e.bridgeProtocol ?? null);
              continue; // bridges are terminals — never expanded
            }
            if (isCex) {
              record(e.destinationAddress, 'cex', 'cex_correlation', hop, null);
              continue; // CEX deposits are terminals — correlation only
            }
            if (!isTransfer) continue; // any residual non-transfer leg is never an outflow hop
            if (valued === null) continue; // defensive — the query is valued-only
            const service = await serviceBasisOf(e.destinationAddress, e.ts);
            if (service !== null) {
              record(e.destinationAddress, 'service', node.hop === 0 ? 'direct_transfer' : 'multi_hop_transfer', hop, null);
              const a = aggs.get(`${e.destinationAddress}|${node.hop === 0 ? 'direct_transfer' : 'multi_hop_transfer'}`);
              a?.reasonCodes.add(`service_terminal:${service}`);
              continue; // service nodes are terminals — never enrolled
            }
            if (e.destinationChain !== chain) {
              record(e.destinationAddress, 'bridge', 'bridge_inference', hop, e.bridgeProtocol ?? null);
              continue; // cross-chain transfer = bridge-tier evidence at best
            }
            record(
              e.destinationAddress,
              'wallet',
              node.hop === 0 ? 'direct_transfer' : 'multi_hop_transfer',
              hop,
              null
            );
            if (!visited.has(e.destinationAddress)) {
              visited.add(e.destinationAddress);
              next.push({ address: e.destinationAddress, hop: node.hop + 1, arrivalTs: e.ts });
            }
          }
        }
        if (nodesExplored >= maxNodes) {
          if (next.length > 0) truncated = true;
          break;
        }
        frontier = next;
      }

      // Honest reporting: unknown-value outbound transfers exist but are
      // NEVER traced as capital movement (unknown is not evidence).
      const unknownValueOutbound = await prisma.moneyFlowEdge.count({
        where: {
          sourceAddress: sourceWallet,
          sourceChain: chain,
          ...(opts.sinceTs ? { ts: { gte: opts.sinceTs } } : {}),
          actionType: 'transfer',
          valuedUsd: null
        }
      });

      // Persist aggregates.
      const sourceWalletRow = await prisma.wallet.findUnique({
        where: { address_chain: { address: sourceWallet, chain } },
        select: { id: true }
      });
      for (const [key, a] of [...aggs.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
        const destinationAddress = key.slice(0, key.lastIndexOf('|'));
        const caveats = [...OUTFLOW_CAVEATS, ...a.caveats];
        const reasons = [...a.reasonCodes];
        if (a.tier === 'cex_correlation') caveats.push(CEX_CAVEAT);
        if (a.tier === 'bridge_inference') caveats.push(BRIDGE_CAVEAT);
        if (truncated) caveats.push('walk truncated at bounded node/child caps — unexplored outflow cannot be excluded');

        // Receiver classification AT RECEIPT (wallet destinations only).
        let receiverClass = 'unknown';
        let relationshipTier: string | null = null;
        if (a.destinationType === 'wallet') {
          const priorActivity = await prisma.moneyFlowEdge.count({
            where: {
              OR: [
                { sourceAddress: destinationAddress, sourceChain: chain },
                { destinationAddress: destinationAddress, destinationChain: chain }
              ],
              ts: { lt: a.firstTs }
            }
          });
          if (priorActivity === 0) {
            receiverClass = 'fresh_receiver';
            reasons.push('no_prior_local_transfer_history');
            caveats.push('fresh under LOCAL coverage — unobserved earlier history cannot be excluded');
          } else {
            // Meaningful-dormancy check: last VALUED movement before receipt.
            const lastMeaningful = await prisma.moneyFlowEdge.findFirst({
              where: {
                OR: [
                  { sourceAddress: destinationAddress, sourceChain: chain },
                  { destinationAddress: destinationAddress, destinationChain: chain }
                ],
                ts: { lt: a.firstTs },
                valuedUsd: { gt: dustMaxUsd }
              },
              orderBy: [{ ts: 'desc' }, { id: 'desc' }],
              select: { ts: true }
            });
            if (!lastMeaningful) {
              receiverClass = 'unknown';
              reasons.push('prior_history_exists_but_no_valued_movement');
            } else {
              const gapDays = (a.firstTs.getTime() - lastMeaningful.ts.getTime()) / 86_400_000;
              receiverClass = gapDays >= 30 ? 'dormant_receiver' : 'active_receiver';
              reasons.push(gapDays >= 30 ? 'valued_gap_30d_plus_before_receipt' : 'recent_valued_activity_before_receipt');
            }
          }
          // Pre-receipt relationship tier (linked side wallet evidence).
          if (sourceWalletRow) {
            const destWallet = await prisma.wallet.findUnique({
              where: { address_chain: { address: destinationAddress, chain } },
              select: { id: true }
            });
            if (destWallet) {
              const rel = await prisma.walletRelationship.findFirst({
                where: {
                  firstSeenAt: { lt: a.firstTs },
                  lastSeenAt: { lt: a.firstTs },
                  OR: [
                    { walletAId: sourceWalletRow.id, walletBId: destWallet.id },
                    { walletAId: destWallet.id, walletBId: sourceWalletRow.id }
                  ]
                },
                orderBy: [{ confidence: 'desc' }, { id: 'asc' }],
                select: { confidence: true }
              });
              if (rel) {
                relationshipTier = relationshipTierOfConfidence(rel.confidence);
                reasons.push('pre_receipt_relationship_exists');
              }
            }
          }
        } else {
          receiverClass = a.destinationType; // bridge | cex | service — not a receiver
        }

        const data = {
          chain,
          sourceWallet,
          sourceEntityKey,
          destinationAddress,
          destinationType: a.destinationType,
          evidenceTier: a.tier,
          hops: a.hops,
          transferCount: a.transferCount,
          knownValueUsd: a.knownValueUsd,
          unknownValueLegs: a.unknownValueLegs,
          firstTransferTs: a.firstTs,
          lastTransferTs: a.lastTs,
          bridgeProtocol: a.bridgeProtocol,
          receiverRelationshipTier: relationshipTier,
          receiverClassAtReceipt: receiverClass,
          pathJson: a.path as unknown as Prisma.InputJsonValue,
          reasonCodes: reasons,
          receiptsJson: {
            dustMaxUsd,
            maxDepth,
            maxNodes,
            maxChildrenPerNode: maxChildren,
            maxChildrenFirstHop,
            nodesExplored,
            walkTruncated: truncated,
            unknownValueOutboundNotTraced: unknownValueOutbound,
            sinceTs: opts.sinceTs?.toISOString() ?? null
          } as unknown as Prisma.InputJsonValue,
          caveats,
          engineVersion: CAPITAL_OUTFLOW_ENGINE_VERSION
        };
        await prisma.capitalOutflowPath.upsert({
          where: {
            chain_sourceWallet_destinationAddress_evidenceTier: {
              chain,
              sourceWallet,
              destinationAddress,
              evidenceTier: a.tier
            }
          },
          create: data,
          update: data
        });
        report.pathsWritten += 1;
        report.byTier[a.tier] = (report.byTier[a.tier] ?? 0) + 1;
        report.byReceiverClass[receiverClass] = (report.byReceiverClass[receiverClass] ?? 0) + 1;
      }
      report.walletsProcessed += 1;
    } catch (err) {
      report.errors += 1;
      if (report.errorReceipts.length < ERROR_RECEIPTS_MAX) {
        report.errorReceipts.push(toErrorReceipt(sourceWallet, err));
      }
    }
  }
  return report;
}

export interface ReceiverEnrollmentBatchReport {
  receiversConsidered: number;
  enrolled: number;
  byClass: Record<string, number>;
  deploymentsDetected: number;
  errors: number;
  errorReceipts: WalletErrorReceipt[];
}

/**
 * Enroll receivers discovered by buildCapitalOutflowPaths (transfer tiers
 * ONLY) as observation_only rows, and detect their post-receipt token BUY
 * deployments from local trades.
 */
export async function buildReceiverEnrollments(
  prisma: PrismaClient,
  opts: {
    chain?: 'SOLANA' | 'BSC';
    limit?: number;
    /** Max deployments recorded per receiver. */
    maxDeployments?: number;
    /** Max post-receipt trades aggregated per receiver. */
    maxTrades?: number;
  } = {}
): Promise<ReceiverEnrollmentBatchReport> {
  const chain = opts.chain ?? 'SOLANA';
  const limit = opts.limit ?? 500;
  const maxDeployments = Math.min(opts.maxDeployments ?? 25, 100);
  const maxTrades = Math.min(opts.maxTrades ?? 2000, 10_000);

  const paths = await prisma.capitalOutflowPath.findMany({
    where: {
      chain,
      destinationType: 'wallet',
      evidenceTier: { in: ['direct_transfer', 'multi_hop_transfer'] }
    },
    orderBy: [{ destinationAddress: 'asc' }, { sourceWallet: 'asc' }, { evidenceTier: 'asc' }],
    take: limit * 4,
    select: {
      destinationAddress: true,
      sourceWallet: true,
      sourceEntityKey: true,
      evidenceTier: true,
      firstTransferTs: true,
      knownValueUsd: true,
      unknownValueLegs: true,
      receiverClassAtReceipt: true,
      receiverRelationshipTier: true
    }
  });

  const byReceiver = new Map<string, typeof paths>();
  for (const p of paths) {
    // A qualified wallet can itself receive from another qualified wallet —
    // it is already in the DNA cohort, never re-enrolled as a receiver.
    const list = byReceiver.get(p.destinationAddress) ?? [];
    list.push(p);
    byReceiver.set(p.destinationAddress, list);
  }
  const dnaWallets = new Set(
    (
      await prisma.walletDnaProfile.findMany({
        where: { chain },
        select: { walletAddress: true }
      })
    ).map((w) => w.walletAddress)
  );

  const report: ReceiverEnrollmentBatchReport = {
    receiversConsidered: 0,
    enrolled: 0,
    byClass: {},
    deploymentsDetected: 0,
    errors: 0,
    errorReceipts: []
  };

  let processed = 0;
  for (const [receiverAddress, rPaths] of [...byReceiver.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (processed >= limit) break;
    if (dnaWallets.has(receiverAddress)) continue; // already a qualified wallet
    processed += 1;
    report.receiversConsidered += 1;
    try {
      const firstReceiptTs = rPaths.reduce(
        (min, p) => (p.firstTransferTs < min ? p.firstTransferTs : min),
        rPaths[0].firstTransferTs
      );
      const known = rPaths.reduce<number | null>((acc, p) => {
        if (p.knownValueUsd === null) return acc;
        return (acc ?? 0) + Number(p.knownValueUsd);
      }, null);
      const unknownLegs = rPaths.reduce((acc, p) => acc + p.unknownValueLegs, 0);

      // Receiver class: linked evidence dominates, then the strongest
      // at-receipt classification observed across paths.
      let receiverClass = 'unknown';
      if (rPaths.some((p) => p.receiverRelationshipTier === 'probable' || p.receiverRelationshipTier === 'strong')) {
        receiverClass = 'linked_side_wallet';
      } else if (rPaths.some((p) => p.receiverClassAtReceipt === 'fresh_receiver')) {
        receiverClass = 'fresh_receiver';
      } else if (rPaths.some((p) => p.receiverClassAtReceipt === 'dormant_receiver')) {
        receiverClass = 'dormant_reactivated';
      } else if (rPaths.some((p) => p.receiverClassAtReceipt === 'active_receiver')) {
        receiverClass = 'active_receiver';
      }

      // Post-receipt deployments (BUY trades strictly after first receipt).
      const walletRow = await prisma.wallet.findUnique({
        where: { address_chain: { address: receiverAddress, chain } },
        select: { id: true }
      });
      const deployments: {
        mint: string;
        firstBuyTs: string;
        buyCount: number;
        boughtKnownUsd: number | null;
        unpricedBuys: number;
      }[] = [];
      let tradesTruncated = false;
      if (walletRow) {
        const buys = await prisma.walletTokenTrade.findMany({
          where: { walletId: walletRow.id, chain, action: 'BUY', ts: { gt: firstReceiptTs } },
          orderBy: [{ ts: 'asc' }, { id: 'asc' }],
          take: maxTrades + 1,
          select: { ts: true, amountUsd: true, token: { select: { address: true } } }
        });
        tradesTruncated = buys.length > maxTrades;
        const byMint = new Map<string, { firstBuyTs: Date; buyCount: number; known: number | null; unpriced: number }>();
        for (const b of buys.slice(0, maxTrades)) {
          const mint = b.token.address;
          let d = byMint.get(mint);
          if (!d) {
            d = { firstBuyTs: b.ts, buyCount: 0, known: null, unpriced: 0 };
            byMint.set(mint, d);
          }
          d.buyCount += 1;
          const usd = Number(b.amountUsd);
          if (usd > 0) d.known = (d.known ?? 0) + usd;
          else d.unpriced += 1;
        }
        for (const [mint, d] of [...byMint.entries()].sort((a, b) => a[1].firstBuyTs.getTime() - b[1].firstBuyTs.getTime())) {
          if (deployments.length >= maxDeployments) break;
          deployments.push({
            mint,
            firstBuyTs: d.firstBuyTs.toISOString(),
            buyCount: d.buyCount,
            boughtKnownUsd: d.known,
            unpricedBuys: d.unpriced
          });
        }
      }

      const caveats = [...OUTFLOW_CAVEATS];
      if (!walletRow) caveats.push('receiver has no local wallet row — deployments cannot be observed locally');
      if (tradesTruncated) caveats.push(`post-receipt trade aggregation truncated at ${maxTrades}`);

      const data = {
        chain,
        receiverAddress,
        status: 'observation_only',
        receiverClass,
        sourceEntityKeys: [...new Set(rPaths.map((p) => p.sourceEntityKey))].sort().slice(0, 25),
        sourceWallets: [...new Set(rPaths.map((p) => p.sourceWallet))].sort().slice(0, 25),
        evidenceTiers: [...new Set(rPaths.map((p) => p.evidenceTier))].sort(),
        firstReceiptTs,
        totalKnownInflowUsd: known,
        unknownValueLegs: unknownLegs,
        deploymentsJson: deployments as unknown as Prisma.InputJsonValue,
        deployedTokenCount: deployments.length,
        reasonCodes: [
          `receiver_class:${receiverClass}`,
          deployments.length > 0 ? 'post_receipt_deployments_observed' : 'no_post_receipt_deployments_observed'
        ],
        receiptsJson: {
          pathCount: rPaths.length,
          transferTiersOnly: true,
          maxDeployments,
          maxTrades
        } as unknown as Prisma.InputJsonValue,
        caveats,
        engineVersion: RECEIVER_ENROLLMENT_ENGINE_VERSION
      };
      await prisma.receiverEnrollment.upsert({
        where: { chain_receiverAddress: { chain, receiverAddress } },
        create: data,
        update: data
      });
      report.enrolled += 1;
      report.byClass[receiverClass] = (report.byClass[receiverClass] ?? 0) + 1;
      report.deploymentsDetected += deployments.length;
    } catch (err) {
      report.errors += 1;
      if (report.errorReceipts.length < ERROR_RECEIPTS_MAX) {
        report.errorReceipts.push(toErrorReceipt(receiverAddress, err));
      }
    }
  }
  return report;
}
