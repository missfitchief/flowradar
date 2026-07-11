// Task 2 — bounded LIVE GMGN → normalize → ingest smoke, into flowradar_test
// ONLY (never the live shadow DB). Read-only GMGN calls (allowlist-gated),
// small limits, paced. Proves the real pipeline end to end.
import { PrismaClient } from '@prisma/client';
import { fetchSmartMoney, fetchKolTrades } from '../packages/providers/src/gmgn/gmgnProvider';
import { normalizeSmartmoneyRow, ingestGmgnObservations } from '../packages/db/src/gmgn/ingest';

// EXPLICIT test-DB client — this smoke must NEVER touch live flowradar.
const prisma = new PrismaClient({ datasources: { db: { url: 'postgresql://flowradar:flowradar@localhost:5439/flowradar_test' } } });
const now = new Date();

async function main() {
  const sm = await fetchSmartMoney({ limit: 8 });
  await new Promise((r) => setTimeout(r, 1500));
  const kol = await fetchKolTrades({ limit: 8 });

  const smObs = sm.map((r) => normalizeSmartmoneyRow(r, { sourceCommand: 'track smartmoney', retrievedAt: now }));
  const kolObs = kol.map((r) => normalizeSmartmoneyRow(r, { sourceCommand: 'track kol', retrievedAt: now }));
  const all = [...smObs, ...kolObs];

  const res1 = await ingestGmgnObservations(prisma, all);
  const res2 = await ingestGmgnObservations(prisma, all); // replay -> all duplicates

  const eligible = await prisma.wallet.count({ where: { status: 'signal_eligible', notes: { startsWith: 'gmgn:' } } });
  const byStatus = await prisma.wallet.groupBy({ by: ['status'], where: { notes: { startsWith: 'gmgn:' } }, _count: true });
  const walletStatsForGmgn = await prisma.walletStats.count({ where: { wallet: { notes: { startsWith: 'gmgn:' } } } });

  console.log(JSON.stringify({
    fetched: { smartmoney: sm.length, kol: kol.length },
    sampleSides: all.slice(0, 6).map((o) => o.side),
    kolTaggedCount: all.filter((o) => o.isKolTagged).length,
    ingestPass1: res1,
    ingestReplay: { observationsCreated: res2.observationsCreated, duplicatesSkipped: res2.duplicatesSkipped },
    walletsByStatus: byStatus.map((b) => ({ status: b.status, n: b._count })),
    INVARIANT_gmgn_eligible: eligible,
    INVARIANT_gmgn_walletStats: walletStatsForGmgn,
    verdict: eligible === 0 && walletStatsForGmgn === 0 && res2.observationsCreated === 0 ? 'HOLDS' : 'CHECK'
  }, null, 2));
  await prisma.$disconnect();
}
main().catch((e) => { console.error('smoke failed:', e instanceof Error ? e.message : e); process.exitCode = 1; });
