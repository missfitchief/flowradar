// FlowRadar — Capital Lineage Engine (Phase 6a): operator CLI for root imports.
//
// Usage:
//   npm run lineage:import-roots -- <file> [--dry-run]
//
// --dry-run parses + reports (including DB overlap) WITHOUT writing anything.
// A real run imports all valid unique roots (dynamic N — see
// importRootWallets' header for the idempotency/preservation contract) and
// writes any parked EVM addresses to <file>.evm-parked.txt for a future
// EVM-side task.

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { parseRootWalletFile } from '@flowradar/core';
import { prisma, importRootWallets } from '@flowradar/db';

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => a !== '--');
  const dryRun = args.includes('--dry-run');
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) {
    console.error('usage: npm run lineage:import-roots -- <file> [--dry-run]');
    process.exitCode = 1;
    return;
  }

  const content = readFileSync(file, 'utf8');
  const parsed = parseRootWalletFile(content);

  // EVM sidecar is written from the PARSE, before any DB work (2026-07-10
  // Codex review: a safety-limit rejection or DB error must not lose the
  // parked handoff). Deduped; a stale sidecar from an earlier run is removed
  // when this file has no EVM rows.
  const parkedPath = `${file}.evm-parked.txt`;
  const uniqueEvm = [...new Set(parsed.evmParked.map((r) => r.address))];
  if (!dryRun) {
    if (uniqueEvm.length > 0) {
      writeFileSync(parkedPath, uniqueEvm.join('\n') + '\n');
      console.log(`parked ${uniqueEvm.length} unique EVM address(es) -> ${parkedPath}`);
    } else if (existsSync(parkedPath)) {
      unlinkSync(parkedPath);
      console.log(`removed stale ${parkedPath} (no EVM rows in this file)`);
    }
  }

  if (dryRun) {
    const existing = await prisma.wallet.findMany({
      where: { address: { in: parsed.roots.map((r) => r.address) }, chain: 'SOLANA' },
      select: { address: true, status: true, lineageRoot: { select: { id: true } } }
    });
    const maxRootsEnv = process.env.LINEAGE_IMPORT_MAX_ROOTS;
    const safetyLimit = maxRootsEnv !== undefined && maxRootsEnv !== '' ? Number(maxRootsEnv) : 10_000;
    const report = {
      mode: 'dry-run (no writes)',
      file,
      totalLines: parsed.totalLines,
      validRoots: parsed.roots.length,
      evmParked: parsed.evmParked.length,
      duplicates: parsed.duplicates.length,
      malformed: parsed.malformed.length,
      existingWallets: existing.length,
      existingRoots: existing.filter((w) => w.lineageRoot !== null).length,
      newlyImportableRoots: parsed.roots.length - existing.filter((w) => w.lineageRoot !== null).length,
      statusesToPreserve: existing.filter((w) => w.status !== 'observation_only').map((w) => ({ address: w.address, status: w.status })),
      // Surface what the REAL run will enforce, so an over-limit file is
      // visible at dry-run time instead of surprising the import.
      safetyLimit,
      exceedsSafetyLimit: Number.isFinite(safetyLimit) ? parsed.roots.length > safetyLimit : 'INVALID LIMIT — real run will refuse'
    };
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const result = await importRootWallets(prisma, content, { fileProvenance: file.split(/[\\/]/).pop() });
  console.log(JSON.stringify({ mode: 'import', file, ...result, evmParked: result.evmParked.length, malformedRows: result.malformedRows.length }, null, 2));
}

await main();
await prisma.$disconnect();
