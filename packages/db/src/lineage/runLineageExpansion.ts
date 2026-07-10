// FlowRadar — Capital Lineage Engine (Phase 6b): bounded expansion driver.
//
// Consumes the LineageExpansionNode frontier in PRIORITY-ORDERED BATCHES (no
// per-wallet timers): each pending node is expanded by fetching the wallet's
// transactions from the provider, persisting outbound transfer edges, and
// enrolling fresh receivers (enrollReceiver). Every cap in settings.lineage
// is enforced with a PERSISTED stop reason. Per-root error isolation: one
// wallet/provider failure marks that node skipped and continues. Resume-safe:
// the provider cursor is checkpointed on the node so an interrupted backfill
// picks up where it left off.
//
// The whole pass holds the global job lock (Prerequisite B) so it never
// interleaves with db:seed / imports / resets.

import type { PrismaClient } from '@prisma/client';
import type { Chain, NormalizedTx, Settings } from '@flowradar/core';
import { enrollReceiverFromTransfer, type TransferObservation } from './enrollReceiver';
import { withGlobalJobLock } from '../locks/globalJobLock';

export interface LineageProvider {
  getWalletTransactions(
    chain: Chain,
    address: string,
    opts?: { since?: Date; cursor?: string; limit?: number }
  ): Promise<{ txs: NormalizedTx[]; nextCursor?: string }>;
}

export interface LineageExpansionResult {
  rootsProcessed: number;
  nodesExpanded: number;
  nodesSkipped: number;
  edgesPersisted: number;
  receiversEnrolled: number;
  serviceNodesSkipped: number;
  errors: number;
  stopReasons: Record<string, number>;
}

const NATIVE_SOL = 'SOL';
const STABLES = new Set(['USDC', 'USDT']);

/**
 * Runs ONE bounded expansion pass across every lineage root (or a single root
 * when rootId is given). maxNodesPerPass bounds total work so a smoke run is
 * genuinely bounded.
 */
export async function runLineageExpansion(
  prisma: PrismaClient,
  provider: LineageProvider,
  settings: Settings,
  opts: { rootId?: string; maxNodesPerPass?: number; now?: Date } = {}
): Promise<LineageExpansionResult> {
  return withGlobalJobLock('lineage-expansion', async () => {
    const now = opts.now ?? new Date();
    const maxNodesPerPass = opts.maxNodesPerPass ?? 100;
    const result: LineageExpansionResult = {
      rootsProcessed: 0,
      nodesExpanded: 0,
      nodesSkipped: 0,
      edgesPersisted: 0,
      receiversEnrolled: 0,
      serviceNodesSkipped: 0,
      errors: 0,
      stopReasons: {}
    };
    const bump = (reason: string) => {
      result.stopReasons[reason] = (result.stopReasons[reason] ?? 0) + 1;
    };

    // Seed the frontier: every root that has no pending expansion node yet
    // gets a depth-0 node (the root itself is the first thing to expand).
    const roots = await prisma.lineageRoot.findMany({
      where: opts.rootId ? { id: opts.rootId } : {},
      include: { wallet: { select: { address: true } } }
    });
    for (const root of roots) {
      const existing = await prisma.lineageExpansionNode.findUnique({
        where: { lineageRootId_walletAddress: { lineageRootId: root.id, walletAddress: root.wallet.address } },
        select: { id: true }
      });
      if (!existing) {
        await prisma.lineageExpansionNode.create({
          data: {
            lineageRootId: root.id,
            walletAddress: root.wallet.address,
            chain: 'SOLANA',
            depth: 0,
            priority: 'first_funder',
            status: 'pending',
            discoveredVia: 'root'
          }
        });
      }
    }

    // Reclaim stale in_progress nodes from a crashed prior pass (2026-07-10
    // Codex review). Safe because the global job lock guarantees no other
    // expansion pass runs concurrently — any in_progress node is orphaned.
    await prisma.lineageExpansionNode.updateMany({
      where: { status: 'in_progress', ...(opts.rootId ? { lineageRootId: opts.rootId } : {}) },
      data: { status: 'pending' }
    });

    const processedRoots = new Set<string>();
    const processedNodeIds: string[] = []; // don't re-pick a resumed node this pass
    // Per-root, per-pass counters for the edge + node caps.
    const edgesByRoot = new Map<string, number>();
    const projectedNodesByRoot = new Map<string, number>();
    let nodesThisPass = 0;
    const utcDayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

    // Priority-ordered batch consumption (enum order = priority order).
    for (;;) {
      if (nodesThisPass >= maxNodesPerPass) {
        bump('max_nodes_per_pass');
        break;
      }
      const node = await prisma.lineageExpansionNode.findFirst({
        where: {
          status: 'pending',
          ...(opts.rootId ? { lineageRootId: opts.rootId } : {}),
          ...(processedNodeIds.length > 0 ? { id: { notIn: processedNodeIds } } : {})
        },
        orderBy: [{ priority: 'asc' }, { depth: 'asc' }, { createdAt: 'asc' }]
      });
      if (!node) break;

      // Atomic claim.
      const claim = await prisma.lineageExpansionNode.updateMany({
        where: { id: node.id, status: 'pending' },
        data: { status: 'in_progress' }
      });
      if (claim.count === 0) continue;

      nodesThisPass += 1;
      processedNodeIds.push(node.id);
      processedRoots.add(node.lineageRootId);

      try {
        // A node AT maxDepth is a terminal leaf: it was already enrolled by
        // its parent, but we do NOT fetch its transactions (that would be one
        // hop too far). maxDepth=1 => only the root's DIRECT receivers exist.
        if (node.depth >= settings.lineage.maxDepth) {
          await prisma.lineageExpansionNode.update({ where: { id: node.id }, data: { status: 'skipped', stopReason: 'max_depth' } });
          result.nodesSkipped += 1;
          bump('max_depth');
          continue;
        }

        // Edge-budget check for this root (per RUN). When exhausted, DEFER
        // this node (leave it pending with its cursor) so a later run — with a
        // fresh per-run budget — resumes it (Codex round-3: marking it skipped
        // permanently lost the unprocessed transfers). processedNodeIds keeps
        // it from being re-picked this pass.
        const rootEdges = edgesByRoot.get(node.lineageRootId) ?? 0;
        if (rootEdges >= settings.lineage.maxEdgesPerRoot) {
          await prisma.lineageExpansionNode.update({
            where: { id: node.id },
            data: { status: 'pending', stopReason: node.stopReason ?? 'edge_cap' }
          });
          bump('edge_cap');
          continue;
        }

        // Node-cap: once a root's frontier is full, still process THIS node's
        // transfers (persist edges/receivers) but forbid enqueuing new nodes.
        // Tracked as a RUNNING projection per root (incremented on each actual
        // enqueue) so a single node's fan-out cannot blow past the cap between
        // count queries (2026-07-10 Codex review Critical).
        if (!projectedNodesByRoot.has(node.lineageRootId)) {
          projectedNodesByRoot.set(
            node.lineageRootId,
            await prisma.lineageExpansionNode.count({ where: { lineageRootId: node.lineageRootId } })
          );
        }

        // Daily receiver budget for this root (UTC day).
        const receiversToday = await prisma.monitoringSubscription.count({
          where: { lineageRootId: node.lineageRootId, priority: 'fresh_receiver_hot', createdAt: { gte: utcDayStart } }
        });
        // CUMULATIVE children of THIS node across passes (Codex round-2:
        // enrolledFromNode reset every resumed pass, defeating the cap). Count
        // distinct receivers already related from this node's wallet.
        const nodeWallet = await prisma.wallet.findUnique({
          where: { address_chain: { address: node.walletAddress, chain: 'SOLANA' } },
          select: { id: true }
        });
        const priorChildren = nodeWallet
          ? (await prisma.walletRelationship.findMany({
              where: { lineageRootId: node.lineageRootId, walletAId: nodeWallet.id },
              distinct: ['walletBId'],
              select: { walletBId: true }
            })).length
          : 0;

        // Fetch a bounded number of pages for this node, resuming from cursor.
        let cursor = node.cursor ?? undefined;
        let pages = 0;
        let childrenEnrolled = priorChildren;
        let dailyReceivers = receiversToday;
        let hitEdgeCap = false;
        let nodeStopReason: string | null = null;
        let lastCursor: string | undefined = cursor;
        while (pages < settings.lineage.backfillMaxPagesPerNode) {
          const { txs, nextCursor } = await provider.getWalletTransactions('SOLANA', node.walletAddress, { cursor, limit: 100 });
          for (const tx of txs) {
            for (const observation of outboundTransfers(tx, node.walletAddress)) {
              if ((edgesByRoot.get(node.lineageRootId) ?? 0) >= settings.lineage.maxEdgesPerRoot) {
                hitEdgeCap = true;
                nodeStopReason = nodeStopReason ?? 'edge_cap';
                bump('edge_cap');
                break;
              }
              const underNodeCap = (projectedNodesByRoot.get(node.lineageRootId) ?? 0) < settings.lineage.maxNodesPerRoot;
              const underChildCap = childrenEnrolled < settings.lineage.maxChildrenPerNode;
              const underDayCap = dailyReceivers < settings.lineage.maxNewReceiversPerRootPerDay;
              // allowEnroll gates receiver/relationship/subscription creation;
              // the edge is ALWAYS persisted (observation) regardless of caps.
              const res = await enrollReceiverFromTransfer(prisma, observation, node.lineageRootId, node.depth, settings, now, {
                allowEnroll: underChildCap && underDayCap,
                allowEnqueue: underNodeCap
              });
              if (res.edgePersisted) {
                result.edgesPersisted += 1;
                edgesByRoot.set(node.lineageRootId, (edgesByRoot.get(node.lineageRootId) ?? 0) + 1);
              }
              if (res.enqueued) {
                projectedNodesByRoot.set(node.lineageRootId, (projectedNodesByRoot.get(node.lineageRootId) ?? 0) + 1);
                if ((projectedNodesByRoot.get(node.lineageRootId) ?? 0) >= settings.lineage.maxNodesPerRoot) {
                  nodeStopReason = nodeStopReason ?? 'node_cap';
                  bump('node_cap');
                }
              }
              if (res.enrolled) {
                result.receiversEnrolled += 1;
                childrenEnrolled += 1;
                dailyReceivers += 1;
                if (childrenEnrolled >= settings.lineage.maxChildrenPerNode) {
                  nodeStopReason = nodeStopReason ?? 'max_children_per_node';
                  bump('max_children_per_node');
                }
                if (dailyReceivers >= settings.lineage.maxNewReceiversPerRootPerDay) {
                  nodeStopReason = nodeStopReason ?? 'receiver_day_cap';
                  bump('receiver_day_cap');
                }
              } else if (res.replay) {
                // A replayed tx creates nothing new — must NOT consume child
                // or daily receiver budget (Codex round-3).
                bump('replay_skipped');
              } else if (res.reason.match(/service/i)) {
                result.serviceNodesSkipped += 1;
              }
              // NB: child/day caps do NOT break the loop — remaining transfers
              // still get their edges persisted (Codex round-2). Only the edge
              // cap stops the scan.
            }
            if (hitEdgeCap) break;
          }
          if (hitEdgeCap) {
            // Do NOT advance the cursor: the current page has unprocessed
            // transfers. Next run re-fetches THIS page from the same cursor
            // and reprocesses idempotently (edge + tx-identity dedupe),
            // continuing past where the budget ran out (Codex round-3).
            break;
          }
          pages += 1;
          lastCursor = nextCursor;
          cursor = nextCursor;
          await prisma.lineageExpansionNode.update({ where: { id: node.id }, data: { cursor: cursor ?? null } });
          if (!nextCursor) break;
        }

        // RESUME (Codex round-1/3): leave the node PENDING when more pages
        // remain OR the edge cap fired mid-page (a fresh per-run budget next
        // pass resumes it) — marking it done would permanently lose later
        // pages/transfers. Stop reason is durable: never overwrite a prior
        // reason with null (Codex round-3), and carry the reason forward on a
        // resumed node. processedNodeIds prevents re-picking within THIS pass.
        const durableStopReason = nodeStopReason ?? node.stopReason ?? null;
        const resumable = (lastCursor !== undefined || hitEdgeCap);
        if (resumable) {
          await prisma.lineageExpansionNode.update({ where: { id: node.id }, data: { status: 'pending', stopReason: durableStopReason } });
        } else {
          await prisma.lineageExpansionNode.update({ where: { id: node.id }, data: { status: 'done', stopReason: durableStopReason } });
          result.nodesExpanded += 1;
        }
      } catch (err) {
        // Per-node error isolation (scenario 7): mark skipped, keep going.
        result.errors += 1;
        await prisma.lineageExpansionNode
          .update({ where: { id: node.id }, data: { status: 'skipped', stopReason: `error: ${err instanceof Error ? err.message.slice(0, 80) : 'unknown'}` } })
          .catch(() => undefined);
        bump('error');
      }
    }

    result.rootsProcessed = processedRoots.size;
    return result;
  });
}

/** Extracts outbound transfer observations (this wallet is the sender). */
function outboundTransfers(tx: NormalizedTx, walletAddress: string): TransferObservation[] {
  const out: TransferObservation[] = [];
  for (const leg of tx.legs) {
    if (leg.from !== walletAddress) continue;
    if (leg.kind !== 'native_transfer' && leg.kind !== 'token_transfer') continue;
    const symbol = leg.asset.symbol;
    out.push({
      txHash: tx.txHash,
      slot: tx.blockOrSlot,
      ts: tx.ts,
      fromAddress: leg.from,
      toAddress: leg.to,
      asset: symbol,
      amountToken: Number(leg.amountToken),
      amountUsd: leg.amountUsd ?? 0,
      isNativeSol: leg.kind === 'native_transfer' && symbol === NATIVE_SOL,
      provider: 'lineage'
    });
  }
  return out;
}

export { STABLES };
