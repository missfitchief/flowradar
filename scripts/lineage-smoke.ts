// FlowRadar — bounded live lineage mini-smoke (Capital Lineage 6b).
//
// Runs ONE bounded expansion pass over the imported operator roots against
// the LIVE Helius wallet-activity provider (MOCK_MODE=false), then reports
// metrics and STOPS. Deliberately bounded (small maxNodesPerPass, depth 1)
// per the operator's "do not run indefinitely" directive.
//
// Usage: MOCK_MODE=false npx tsx scripts/lineage-smoke.ts

import { prisma, runLineageExpansion, type LineageProvider } from '@flowradar/db';
import { getProvider } from '@flowradar/providers';
import { DEFAULT_SETTINGS } from '@flowradar/core';

function rssMb(): number {
  return Math.round(process.memoryUsage().rss / (1024 * 1024));
}

async function main(): Promise<void> {
  const mockMode = process.env.MOCK_MODE !== 'false';
  const settings = { ...await loadSettings(), lineage: { ...DEFAULT_SETTINGS.lineage, maxDepth: 1, backfillMaxPagesPerNode: 2 } };

  const roots = await prisma.lineageRoot.count();
  console.log(JSON.stringify({ phase: 'start', mockMode, roots, rssMb: rssMb() }));

  // Live Helius walletActivity provider (or mock fallback when MOCK_MODE).
  const provider = getProvider('SOLANA', 'walletActivity') as unknown as LineageProvider;

  const startedAt = Date.now();
  let result;
  let crashed: string | null = null;
  try {
    // Bounded: at most 8 frontier nodes this pass (the roots + their first
    // direct receivers), depth 1, 2 pages/node.
    result = await runLineageExpansion(prisma, provider, settings, { maxNodesPerPass: 8 });
  } catch (err) {
    crashed = err instanceof Error ? err.message : String(err);
  }
  const durationSec = Math.round((Date.now() - startedAt) / 1000);

  // Post-pass DB tallies.
  const edges = await prisma.moneyFlowEdge.count({ where: { metadata: { path: ['lineage'], equals: true } } });
  const receivers = await prisma.monitoringSubscription.count({ where: { priority: 'fresh_receiver_hot' } });
  const relationships = await prisma.walletRelationship.count();
  const observationWallets = await prisma.wallet.count({ where: { status: 'observation_only' } });
  const eligibleWallets = await prisma.wallet.count({ where: { status: 'signal_eligible' } });
  const frontierNodes = await prisma.lineageExpansionNode.groupBy({ by: ['status'], _count: true });

  console.log(
    JSON.stringify(
      {
        phase: 'done',
        durationSec,
        crashed,
        result,
        db: { lineageEdges: edges, hotReceivers: receivers, relationships, observationWallets, eligibleWallets, frontierNodes },
        rssMb: rssMb(),
        // SMART-COUNT INVARIANT: no lineage wallet is signal_eligible (only
        // the 30 operator roots exist, all observation_only; receivers are
        // observation_only) — the engine never auto-promotes.
        smartCountInvariant: eligibleWallets === 0 ? 'HOLDS (zero signal_eligible)' : `CHECK — ${eligibleWallets} signal_eligible`
      },
      null,
      2
    )
  );
  await prisma.$disconnect();
}

async function loadSettings() {
  const row = await prisma.settings.findFirst();
  // Stored values may predate the lineage block; merge over defaults so
  // settings.lineage always exists.
  return row ? { ...DEFAULT_SETTINGS, ...(row.values as object) } : DEFAULT_SETTINGS;
}

await main();
