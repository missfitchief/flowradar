// FlowRadar — full-DB census (overnight Task A). Prints one sorted count per
// key table so two runs can be diffed byte-for-byte to PROVE the live DB was
// untouched by a test run. Read-only; never prints credentials. Targets
// whatever the ambient resolution yields (live outside vitest).
import { prisma, resolveDatabaseUrl } from '../packages/db/src/index';

async function main(): Promise<void> {
  const dbName = new URL(resolveDatabaseUrl()).pathname.replace(/^\//, '');
  const counts: [string, number][] = [
    ['wallets', await prisma.wallet.count()],
    ['walletStats', await prisma.walletStats.count()],
    ['walletClassifications', await prisma.walletClassification.count()],
    ['walletTokenTrades', await prisma.walletTokenTrade.count()],
    ['tokens', await prisma.token.count()],
    ['moneyFlowEdges', await prisma.moneyFlowEdge.count()],
    ['walletRelationships', await prisma.walletRelationship.count()],
    ['monitoringSubscriptions', await prisma.monitoringSubscription.count()],
    ['lineageRoots', await prisma.lineageRoot.count()],
    ['lineageExpansionNodes', await prisma.lineageExpansionNode.count()],
    ['observationProviderSnapshots', await prisma.observationProviderSnapshot.count()],
    ['candidateWallets', await prisma.candidateWallet.count()]
  ];
  console.log(`census database=${dbName}`);
  for (const [table, n] of counts.sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`${table}=${n}`);
  }
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('census failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
