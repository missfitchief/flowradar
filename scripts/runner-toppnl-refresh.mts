// FlowRadar — post-review refresh of top-PnL discovery + Wallet DNA on the
// pilot DB (validation/proxy semantics changed by the Codex-review fixes;
// the dormancy chain is untouched and NOT rerun). PILOT DB ONLY.
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: path.join(HERE, '..', '..', 'flowradar', '.env') });

const url = new URL(process.env.DATABASE_URL ?? 'postgresql://invalid');
if (url.pathname !== '/flowradar_pilot') throw new Error('pilot DB only: ' + url.pathname);

const { prisma, buildTokenTopPnlCandidates, buildWalletDnaProfiles } = await import('@flowradar/db');
import { writeFileSync } from 'node:fs';

const runnersTotal = await prisma.tokenLifecycle.count({ where: { runnerClass: 'verified_above_10m' } });
const discovery = await buildTokenTopPnlCandidates(prisma, { chain: 'SOLANA', limit: runnersTotal, provider: null });
const byValidation = Object.fromEntries(
  (await prisma.tokenTopPnlCandidate.groupBy({ by: ['validation'], where: { chain: 'SOLANA' }, _count: { _all: true } }))
    .map((g) => [g.validation, g._count._all])
);
const allWallets = (
  await prisma.tokenTopPnlCandidate.findMany({
    where: { chain: 'SOLANA' },
    select: { walletAddress: true },
    distinct: ['walletAddress'],
    orderBy: { walletAddress: 'asc' }
  })
).map((w) => w.walletAddress);
const dna = await buildWalletDnaProfiles(prisma, { chain: 'SOLANA', walletAddresses: allWallets, limit: allWallets.length });
const dnaRows = await prisma.walletDnaProfile.findMany({
  where: { chain: 'SOLANA', walletAddress: { in: allWallets } },
  select: { completedPositions: true, winCount: true, lossCount: true, winRate: true, unpricedPositions: true }
});
const withCompleted = dnaRows.filter((d) => d.completedPositions > 0);
const report = {
  ts: new Date().toISOString(),
  reason: 'codex-review fixes: window-incomparable validation, buy-only proxy withheld, mixed-leg positions excluded from W/L',
  discovery: { mintsProcessed: discovery.mintsProcessed, errors: discovery.errors, byValidation },
  dna: {
    written: dna.walletsWritten,
    errors: dna.errors,
    walletsWithCompletedPositions: withCompleted.length,
    totalCompleted: dnaRows.reduce((a, d) => a + d.completedPositions, 0),
    totalWins: dnaRows.reduce((a, d) => a + d.winCount, 0),
    totalLosses: dnaRows.reduce((a, d) => a + d.lossCount, 0),
    totalUnpricedPositions: dnaRows.reduce((a, d) => a + d.unpricedPositions, 0),
    walletsWithNullWinRate: dnaRows.filter((d) => d.winRate === null).length
  }
};
writeFileSync('data/runner-mining/toppnl-refresh-report.json', JSON.stringify(report, null, 2));
console.log('[toppnl-refresh]', JSON.stringify(report));
await prisma.$disconnect();
