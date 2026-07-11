// READ-ONLY capability-audit census (Phase 0 + final gates). Prints the full
// distribution set docs/CURRENT_STATE_RECONCILIATION.md reports. Never writes.
import { prisma } from '../packages/db/src/index';
const j = (x: unknown) => JSON.stringify(x, (_k, v) => typeof v === 'bigint' ? Number(v) : v);
async function main() {
  console.log('walletByStatus=' + j(await prisma.wallet.groupBy({ by: ['status'], _count: true })));
  console.log('walletStatsBySource=' + j(await prisma.walletStats.groupBy({ by: ['source'], _count: true })));
  console.log('lineageRoots=' + await prisma.lineageRoot.count());
  console.log('subsByTierActive=' + j(await prisma.monitoringSubscription.groupBy({ by: ['priority', 'active'], _count: true })));
  console.log('edgesByAction=' + j(await prisma.moneyFlowEdge.groupBy({ by: ['actionType'], _count: true })));
  console.log('edgesByValuation=' + j(await prisma.moneyFlowEdge.groupBy({ by: ['valuationStatus'], _count: true })));
  const rels = await prisma.walletRelationship.findMany({ select: { kind: true, confidence: true } });
  const band = (c: number) => (c >= 80 ? 'strong' : c >= 50 ? 'probable' : 'possible');
  const relAgg: Record<string, number> = {};
  for (const r of rels) relAgg[`${r.kind}/${band(r.confidence)}`] = (relAgg[`${r.kind}/${band(r.confidence)}`] ?? 0) + 1;
  console.log('relsByKindBand=' + j(relAgg));
  console.log('frontierByStatus=' + j(await prisma.lineageExpansionNode.groupBy({ by: ['status'], _count: true })));
  console.log('obsProviderSnapshotsBySource=' + j(await prisma.observationProviderSnapshot.groupBy({ by: ['source'], _count: true })));
  console.log('confluenceByProvider=' + j(await prisma.tokenConfluenceSnapshot.groupBy({ by: ['snapshotType'], _count: true })));
  console.log('candidatesByStatus=' + j(await prisma.candidateWallet.groupBy({ by: ['validationStatus'], _count: true })));
  console.log('signals=' + await prisma.signal.count());
  console.log('backtestResults=' + await prisma.backtestResult.count() + ' backtestRuns=' + await prisma.backtestRun.count());
  console.log('profitRotationSignals=' + await prisma.profitRotationSignal.count());
  console.log('socialSources=' + await prisma.socialSource.count() + ' socialMentions=' + await prisma.socialMention.count());
  console.log('tokens=' + await prisma.token.count() + ' trades=' + await prisma.walletTokenTrade.count() + ' marketSnapshots=' + await prisma.tokenMarketSnapshot.count());
  console.log('addressRegistry=' + await prisma.addressRegistry.count());
  // stealth snapshots / runner-mining tables: DO NOT EXIST in schema (verified by model list)
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
