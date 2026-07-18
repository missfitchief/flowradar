import 'dotenv/config';
import { buildUnifiedEntityGraph, prisma, runUnifiedProfitableWalletDiscovery, syncHistoricalTokenUniverse, type HistoricalUniverseSeed } from '@flowradar/db';
import { createBirdeyeTokenTopTraders } from '@flowradar/providers';

if (process.env.MOCK_MODE !== 'false') throw new Error('operator discovery requires MOCK_MODE=false');
const operatorCore = parseCore(process.env.FLOWRADAR_CORE_TOKENS_JSON);
const birdeye = createBirdeyeTokenTopTraders(process.env);
const providers = birdeye ? {
  SOLANA: { name: 'birdeye_top_traders', adapter: birdeye, windowsComparable: false, timeFrame: '24h' as const },
  BSC: { name: 'birdeye_top_traders', adapter: birdeye, windowsComparable: false, timeFrame: '24h' as const }
} : {};

try {
  const universe = await syncHistoricalTokenUniverse(prisma, { operatorCore });
  const discovery = await runUnifiedProfitableWalletDiscovery(prisma, { providers, retryUnavailable: process.argv.includes('--retry-unavailable') });
  const entities = await buildUnifiedEntityGraph(prisma);
  console.log(JSON.stringify({ mockMode: false, universe, discovery, entities }, null, 2));
} finally { await prisma.$disconnect(); }

function parseCore(raw: string | undefined): HistoricalUniverseSeed[] {
  const value = JSON.parse(raw || '[]') as unknown;
  if (!Array.isArray(value)) throw new Error('FLOWRADAR_CORE_TOKENS_JSON must be a JSON array');
  return value as HistoricalUniverseSeed[];
}
