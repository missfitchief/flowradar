// FlowRadar — staged observation-universe import (overnight Task F).
//
// Imports the first N data rows of an operator-approved wallet-universe CSV
// through importObservationUniverse (Wave D path): every wallet
// observation_only, provider stats -> SHADOW ObservationProviderSnapshot
// (never WalletStats), never signal_eligible, idempotent. Cumulative staging
// (100 -> 250 -> 500) leans on that idempotency: each stage re-presents the
// earlier rows and imports only the new ones.
//
// FAIL-CLOSED CLI (Codex review): DEFAULT IS DRY-RUN. Live writes require the
// explicit --apply flag; any unrecognized argument aborts before any DB work,
// so a typo can never silently perform a live import.
//
// Prints an honest stage report + the TRUST INVARIANT proof:
//   - PER-ADDRESS: the exact set of staged addresses that are signal_eligible
//     is IDENTICAL before and after (none gained or lost eligibility)
//   - global signal_eligible count unchanged
//   - zero WalletStats rows created
// Usage: npx tsx scripts/import-observation-universe.ts <csv> <N-rows> [--apply]
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { prisma, importObservationUniverse, parseObservationUniverse } from '../packages/db/src/index';

async function stagedEligibleSet(addresses: string[]): Promise<Set<string>> {
  const rows = await prisma.wallet.findMany({
    where: { address: { in: addresses }, chain: 'SOLANA', status: 'signal_eligible' },
    select: { address: true }
  });
  return new Set(rows.map((r) => r.address));
}

async function main(): Promise<void> {
  const [, , fileArg, nArg, ...rest] = process.argv;
  if (!fileArg || !nArg) {
    console.error('usage: import-observation-universe.ts <csv> <N-rows> [--apply]');
    process.exitCode = 2;
    return;
  }
  // Fail closed on ANY unrecognized flag — a typo like --dryrun/--aply must
  // abort, never silently choose a mode.
  let apply = false;
  for (const arg of rest) {
    if (arg === '--apply') apply = true;
    else {
      console.error(`unrecognized argument "${arg}" — aborting (nothing touched). Only --apply is accepted.`);
      process.exitCode = 2;
      return;
    }
  }
  const limit = Number(nArg);
  if (!Number.isInteger(limit) || limit <= 0) throw new Error(`bad N: ${nArg}`);

  const raw = readFileSync(fileArg, 'utf-8');
  const lines = raw.split(/\r?\n/).filter((l) => l.trim() !== '');
  const dataRows = lines.slice(1, 1 + limit);
  // Honest stage size: never report a bigger stage than the file supplies.
  const actual = dataRows.length;
  if (actual < limit) console.warn(`file has only ${actual} data rows — staging ${actual}, not ${limit}`);
  const staged = [lines[0]!, ...dataRows].join('\n');
  const parsed = parseObservationUniverse(staged);

  if (!apply) {
    console.log(`DRY-RUN (default; pass --apply to write) stage=${actual} valid=${parsed.rows.length} evmParked=${parsed.evmParked.length} malformed=${parsed.malformed.length} duplicates=${parsed.duplicates}`);
    const withStats = parsed.rows.filter((r) => r.providerStats).length;
    console.log(`rows with complete provider stats: ${withStats}; address-only: ${parsed.rows.length - withStats}`);
    await prisma.$disconnect();
    return;
  }

  const stagedAddresses = parsed.rows.map((r) => r.address);
  const eligibleAddrsBefore = await stagedEligibleSet(stagedAddresses);
  const eligibleBefore = await prisma.wallet.count({ where: { status: 'signal_eligible' } });
  const statsBefore = await prisma.walletStats.count();
  const t0 = Date.now();

  const result = await importObservationUniverse(prisma, staged, {
    provenance: `${path.basename(fileArg)} stage-${actual} overnight-2026-07-11`
  });

  const eligibleAddrsAfter = await stagedEligibleSet(stagedAddresses);
  const eligibleAfter = await prisma.wallet.count({ where: { status: 'signal_eligible' } });
  const statsAfter = await prisma.walletStats.count();
  const obsCount = await prisma.wallet.count({ where: { status: 'observation_only' } });
  const snapCount = await prisma.observationProviderSnapshot.count();
  const rssMb = Math.round(process.memoryUsage().rss / 1024 / 1024);

  // PER-ADDRESS proof: the staged addresses' eligible set must be identical.
  const gained = [...eligibleAddrsAfter].filter((a) => !eligibleAddrsBefore.has(a));
  const lost = [...eligibleAddrsBefore].filter((a) => !eligibleAddrsAfter.has(a));
  const perAddressHolds = gained.length === 0 && lost.length === 0;

  console.log(`STAGE ${actual} RESULT ${JSON.stringify(result)}`);
  console.log(`durationMs=${Date.now() - t0} rssMb=${rssMb}`);
  console.log(`observation_only wallets total=${obsCount} providerSnapshots total=${snapCount}`);
  console.log(`TRUST INVARIANT (per-address): staged eligible set before=${eligibleAddrsBefore.size} after=${eligibleAddrsAfter.size} gained=${gained.length} lost=${lost.length} (${perAddressHolds ? 'HOLDS' : 'VIOLATED'})`);
  console.log(`TRUST INVARIANT (global): signal_eligible before=${eligibleBefore} after=${eligibleAfter} (${eligibleBefore === eligibleAfter ? 'HOLDS' : 'CHANGED — investigate (concurrent activity or violation)'})`);
  console.log(`WALLETSTATS UNTOUCHED: before=${statsBefore} after=${statsAfter} (${statsBefore === statsAfter ? 'HOLDS' : 'CHANGED — investigate'})`);
  if (!perAddressHolds || statsBefore !== statsAfter) process.exitCode = 1;
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('import failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
