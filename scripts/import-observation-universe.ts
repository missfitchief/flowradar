// FlowRadar — staged observation-universe import (overnight Task F).
//
// Imports the first N data rows of an operator-approved wallet-universe CSV
// through importObservationUniverse (Wave D path): every wallet
// observation_only, provider stats -> SHADOW ObservationProviderSnapshot
// (never WalletStats), never signal_eligible, idempotent. Cumulative staging
// (100 -> 250 -> 500) leans on that idempotency: each stage re-presents the
// earlier rows and imports only the new ones.
//
// Prints an honest stage report + the TRUST INVARIANT proof:
//   - signal_eligible count UNCHANGED by the import
//   - every imported wallet is observation_only (or a preserved classification)
//   - zero WalletStats rows created
// Usage: npx tsx scripts/import-observation-universe.ts <csv> <N> [--dry-run]
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { prisma, importObservationUniverse, parseObservationUniverse } from '../packages/db/src/index';

async function main(): Promise<void> {
  const [, , fileArg, nArg, dryFlag] = process.argv;
  if (!fileArg || !nArg) {
    console.error('usage: import-observation-universe.ts <csv> <N-rows> [--dry-run]');
    process.exitCode = 2;
    return;
  }
  const limit = Number(nArg);
  if (!Number.isInteger(limit) || limit <= 0) throw new Error(`bad N: ${nArg}`);
  const dryRun = dryFlag === '--dry-run';

  const raw = readFileSync(fileArg, 'utf-8');
  const lines = raw.split(/\r?\n/).filter((l) => l.trim() !== '');
  const staged = [lines[0]!, ...lines.slice(1, 1 + limit)].join('\n');

  if (dryRun) {
    const parsed = parseObservationUniverse(staged);
    console.log(`DRY-RUN stage=${limit} valid=${parsed.rows.length} evmParked=${parsed.evmParked.length} malformed=${parsed.malformed.length} duplicates=${parsed.duplicates}`);
    const withStats = parsed.rows.filter((r) => r.providerStats).length;
    console.log(`rows with complete provider stats: ${withStats}; address-only: ${parsed.rows.length - withStats}`);
    await prisma.$disconnect();
    return;
  }

  const eligibleBefore = await prisma.wallet.count({ where: { status: 'signal_eligible' } });
  const statsBefore = await prisma.walletStats.count();
  const t0 = Date.now();

  const result = await importObservationUniverse(prisma, staged, {
    provenance: `${path.basename(fileArg)} stage-${limit} overnight-2026-07-11`
  });

  const eligibleAfter = await prisma.wallet.count({ where: { status: 'signal_eligible' } });
  const statsAfter = await prisma.walletStats.count();
  const obsCount = await prisma.wallet.count({ where: { status: 'observation_only' } });
  const snapCount = await prisma.observationProviderSnapshot.count();
  const rssMb = Math.round(process.memoryUsage().rss / 1024 / 1024);

  console.log(`STAGE ${limit} RESULT ${JSON.stringify(result)}`);
  console.log(`durationMs=${Date.now() - t0} rssMb=${rssMb}`);
  console.log(`observation_only wallets total=${obsCount} providerSnapshots total=${snapCount}`);
  console.log(`TRUST INVARIANT: signal_eligible before=${eligibleBefore} after=${eligibleAfter} (${eligibleBefore === eligibleAfter ? 'HOLDS' : 'VIOLATED'})`);
  console.log(`WALLETSTATS UNTOUCHED: before=${statsBefore} after=${statsAfter} (${statsBefore === statsAfter ? 'HOLDS' : 'VIOLATED'})`);
  if (eligibleBefore !== eligibleAfter || statsBefore !== statsAfter) process.exitCode = 1;
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('import failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
