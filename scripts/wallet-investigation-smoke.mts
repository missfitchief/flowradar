import 'dotenv/config';
import { OperatorService, prisma, type WalletInvestigationResult } from '@flowradar/db';
import { createLiveWalletCapitalScanner, createWormholeWalletBridgeScanner } from '@flowradar/providers';

const targets = process.argv.slice(2).filter((value) => !value.startsWith('-'));
if (!targets.length) throw new Error('Usage: tsx scripts/wallet-investigation-smoke.mts <wallet> [wallet...]');

const service = new OperatorService(prisma, {
  walletCapitalScanner: createLiveWalletCapitalScanner(process.env),
  walletBridgeScanner: createWormholeWalletBridgeScanner()
});

try {
  for (const target of targets) {
    const result = await service.investigateWallet(target, { refresh: true, maxDepth: 4 });
    process.stdout.write(`${JSON.stringify(smokeReceipt(result))}\n`);
  }
} finally {
  await prisma.$disconnect();
}

function smokeReceipt(result: WalletInvestigationResult) {
  const providers = result.providerReceipts as {
    tracker?: { inputEvents?: number; persistedEvents?: number; duplicateEvents?: number; relevantEvents?: number; retryAttempts?: number; providerErrors?: number; peakHeapBytes?: string; throughputPerSec?: number };
    bridge?: { provider?: string; pages?: number; complete?: boolean; events?: number; warnings?: string[] } | null;
  };
  return {
    target: result.rootAddress,
    investigationId: result.id,
    status: result.status,
    coverageStatus: result.coverageStatus,
    coverage: result.coverage.map((row) => ({
      chain: row.chain, status: row.coverageStatus, provider: row.provider, eventsScanned: row.eventsScanned,
      activityFound: row.activityFound, firstActivityAt: row.firstActivityAt, lastActivityAt: row.lastActivityAt,
      warnings: row.warnings
    })),
    counts: result.counts,
    persisted: { paths: result.paths.length, members: result.members.length, deployments: result.deployments.length },
    bridge: providers.bridge ?? null,
    tracker: providers.tracker ?? null,
    completedAt: result.completedAt
  };
}
