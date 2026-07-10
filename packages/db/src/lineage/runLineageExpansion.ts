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

    const processedRoots = new Set<string>();
    let nodesThisPass = 0;

    // Priority-ordered batch consumption (enum order = priority order).
    for (;;) {
      if (nodesThisPass >= maxNodesPerPass) {
        bump('max_nodes_per_pass');
        break;
      }
      const node = await prisma.lineageExpansionNode.findFirst({
        where: { status: 'pending', ...(opts.rootId ? { lineageRootId: opts.rootId } : {}) },
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
      processedRoots.add(node.lineageRootId);

      try {
        // Per-root cap: stop expanding this root once its frontier is full.
        const rootNodeCount = await prisma.lineageExpansionNode.count({ where: { lineageRootId: node.lineageRootId } });
        // A node AT maxDepth is a terminal leaf: it was already enrolled by
        // its parent, but we do NOT fetch its transactions (that would be one
        // hop too far). maxDepth=1 => only the root's DIRECT receivers exist.
        if (node.depth >= settings.lineage.maxDepth) {
          await prisma.lineageExpansionNode.update({ where: { id: node.id }, data: { status: 'skipped', stopReason: 'max_depth' } });
          result.nodesSkipped += 1;
          bump('max_depth');
          continue;
        }
        if (rootNodeCount > settings.lineage.maxNodesPerRoot) {
          await prisma.lineageExpansionNode.update({ where: { id: node.id }, data: { status: 'skipped', stopReason: 'node_cap' } });
          result.nodesSkipped += 1;
          bump('node_cap');
          continue;
        }

        // Fetch a bounded number of pages for this node, resuming from cursor.
        let cursor = node.cursor ?? undefined;
        let pages = 0;
        let enrolledFromNode = 0;
        while (pages < settings.lineage.backfillMaxPagesPerNode) {
          const { txs, nextCursor } = await provider.getWalletTransactions('SOLANA', node.walletAddress, {
            cursor,
            limit: 100
          });
          for (const tx of txs) {
            for (const observation of outboundTransfers(tx, node.walletAddress)) {
              const res = await enrollReceiverFromTransfer(prisma, observation, node.lineageRootId, node.depth, settings, now);
              if (res.edgePersisted) result.edgesPersisted += 1;
              if (res.enrolled) {
                result.receiversEnrolled += 1;
                enrolledFromNode += 1;
              } else if (res.reason.match(/service/i)) {
                result.serviceNodesSkipped += 1;
              }
              if (enrolledFromNode >= settings.lineage.maxChildrenPerNode) {
                bump('max_children_per_node');
                break;
              }
            }
            if (enrolledFromNode >= settings.lineage.maxChildrenPerNode) break;
          }
          pages += 1;
          cursor = nextCursor;
          // Checkpoint the cursor so an interruption resumes here.
          await prisma.lineageExpansionNode.update({ where: { id: node.id }, data: { cursor: cursor ?? null } });
          if (!nextCursor || enrolledFromNode >= settings.lineage.maxChildrenPerNode) break;
        }

        await prisma.lineageExpansionNode.update({ where: { id: node.id }, data: { status: 'done' } });
        result.nodesExpanded += 1;
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
