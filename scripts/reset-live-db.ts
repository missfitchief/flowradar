// FlowRadar — clean-live-DB reset (Prerequisite A, Capital Lineage 6b).
//
// Purpose-built for the synthetic->live transition: removes every mock-world
// data row while PRESERVING operational configuration (Chain, Settings,
// AddressRegistry, ExternalWalletSource, DuneQuerySource, SocialSource,
// ExternalConfluenceSource). Deliberately NOT db:seed (operator requirement
// 7: seed creates synthetic worlds; this creates an EMPTY live state).
//
// Safety:
//   - refuses without --confirm (prints what it WOULD do)
//   - exports a timestamped JSON backup of every lineage root (wallet
//     address/status/isWatched/notes + root fields + subscription state)
//     BEFORE any delete, to db-backups/ (gitignored) — re-import afterwards
//     with: npm run lineage:import-roots -- <original file>
//   - entire run holds the global job lock (Prerequisite B)
//
// Usage: npx tsx scripts/reset-live-db.ts [--confirm]

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { prisma, withGlobalJobLock } from '@flowradar/db';

const confirm = process.argv.includes('--confirm');

async function exportRootBackup(): Promise<string | null> {
  const roots = await prisma.lineageRoot.findMany({
    include: {
      wallet: { select: { address: true, chain: true, status: true, isWatched: true, notes: true } },
      subscriptions: { select: { priority: true, active: true, reason: true, createdAt: true } }
    }
  });
  if (roots.length === 0) return null;
  const dir = path.resolve('db-backups');
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `lineage-roots-backup-${stamp}.json`);
  writeFileSync(file, JSON.stringify({ exportedAt: new Date().toISOString(), rootCount: roots.length, roots }, null, 2));
  return file;
}

async function wipeSyntheticData(): Promise<void> {
  // FK-safe leaf-to-root order (mirrors seed.ts's wipeAllTables), but STOPS
  // short of configuration tables: Chain, Settings, AddressRegistry,
  // ExternalWalletSource, DuneQuerySource, SocialSource,
  // ExternalConfluenceSource all survive.
  await prisma.backtestRun.deleteMany();
  await prisma.backtestResult.deleteMany();
  await prisma.alert.deleteMany();
  await prisma.signal.deleteMany();
  await prisma.walletGraphEdge.deleteMany();
  await prisma.walletGraphNode.deleteMany();
  await prisma.walletGraphSearch.deleteMany();
  await prisma.profitRotationSignal.deleteMany();
  await prisma.entityClusterWallet.deleteMany();
  await prisma.walletTokenTrade.deleteMany();
  await prisma.tokenFlowSnapshot.deleteMany();
  await prisma.tokenMarketSnapshot.deleteMany();
  await prisma.entityCluster.deleteMany();
  await prisma.walletClassification.deleteMany();
  await prisma.walletStats.deleteMany();
  await prisma.moneyFlowEdge.deleteMany();
  await prisma.candidateWallet.deleteMany();
  await prisma.socialMention.deleteMany(); // data; SocialSource config stays
  await prisma.tokenOverlapWalletResult.deleteMany();
  await prisma.tokenOverlapGroupResult.deleteMany();
  await prisma.tokenOverlapSearch.deleteMany();
  await prisma.tokenConfluenceSnapshot.deleteMany(); // data; source config stays
  // Wallet deletion cascades LineageRoot + MonitoringSubscription — that is
  // WHY the backup above is mandatory and the re-import step follows.
  await prisma.wallet.deleteMany();
  await prisma.token.deleteMany();
  await prisma.importJob.deleteMany();
  await prisma.providerSyncState.deleteMany();
}

async function main(): Promise<void> {
  const rootCount = await prisma.lineageRoot.count();
  const wallets = await prisma.wallet.count();
  const tokens = await prisma.token.count();
  const trades = await prisma.walletTokenTrade.count();

  if (!confirm) {
    console.log(
      JSON.stringify(
        {
          mode: 'REFUSED — pass --confirm to execute',
          wouldDelete: { wallets, tokens, trades, lineageRoots: rootCount },
          wouldPreserve: ['Chain', 'Settings', 'AddressRegistry', 'ExternalWalletSource', 'DuneQuerySource', 'SocialSource', 'ExternalConfluenceSource'],
          note: 'lineage roots are backed up to db-backups/ first; re-import with npm run lineage:import-roots afterwards'
        },
        null,
        2
      )
    );
    return;
  }

  await withGlobalJobLock('live-db-reset', async () => {
    const backupFile = await exportRootBackup();
    console.log(backupFile ? `roots backed up -> ${backupFile}` : 'no lineage roots to back up');
    await wipeSyntheticData();
    console.log(
      JSON.stringify(
        {
          mode: 'RESET COMPLETE',
          deleted: { wallets, tokens, trades, lineageRootsCascaded: rootCount },
          preserved: {
            chains: await prisma.chain.count(),
            settings: await prisma.settings.count(),
            addressRegistry: await prisma.addressRegistry.count(),
            externalWalletSources: await prisma.externalWalletSource.count(),
            duneQuerySources: await prisma.duneQuerySource.count(),
            socialSources: await prisma.socialSource.count(),
            confluenceSources: await prisma.externalConfluenceSource.count()
          },
          nextStep: 'npm run lineage:import-roots -- <original root file>'
        },
        null,
        2
      )
    );
  });
}

await main();
await prisma.$disconnect();
