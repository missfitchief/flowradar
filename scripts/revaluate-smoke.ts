// FlowRadar — Wave A revaluation smoke. Fetches the current SOL price ONCE
// (DexScreener, keyless) and revalues the existing edge backlog honestly,
// reporting the valuation-status distribution. Bounded; MOCK_MODE respected.

import { prisma, revaluateEdges } from '@flowradar/db';
import { getProvider } from '@flowradar/providers';
import { DEFAULT_SETTINGS, WSOL_MINT } from '@flowradar/core';

function rssMb() { return Math.round(process.memoryUsage().rss / (1024 * 1024)); }

async function main() {
  const settings = { ...(await loadSettings()) };
  // Current SOL price via keyless DexScreener wSOL market (once).
  let solPrice: number | null = null;
  try {
    const market = getProvider('SOLANA', 'marketData');
    const m = await market.getTokenMarket('SOLANA', WSOL_MINT);
    solPrice = m?.priceUsd ?? null;
  } catch (e) {
    console.log('sol price fetch failed:', e instanceof Error ? e.message : String(e));
  }
  console.log(JSON.stringify({ phase: 'start', solPrice, rssStart: rssMb() }));

  const before = await prisma.moneyFlowEdge.groupBy({ by: ['valuationStatus'], _count: true });
  const result = await revaluateEdges(prisma, settings, { maxEdgesPerPass: 2000, solCurrentPriceUsd: solPrice, solCurrentPriceTs: new Date() });
  const after = await prisma.moneyFlowEdge.groupBy({ by: ['valuationStatus'], _count: true });
  const nodes = await prisma.lineageExpansionNode.groupBy({ by: ['status'], _count: true });

  console.log(JSON.stringify({ phase: 'done', result, before, after, nodes, rssEnd: rssMb() }, null, 2));
  await prisma.$disconnect();
}

async function loadSettings() {
  const row = await prisma.settings.findFirst();
  return row ? { ...DEFAULT_SETTINGS, ...(row.values as object) } : DEFAULT_SETTINGS;
}

await main();
