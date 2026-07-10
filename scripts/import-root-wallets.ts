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

import { readFileSync, writeFileSync } from 'node:fs';
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

  if (dryRun) {
    const existing = await prisma.wallet.findMany({
      where: { address: { in: parsed.roots.map((r) => r.address) }, chain: 'SOLANA' },
      select: { address: true, status: true, lineageRoot: { select: { id: true } } }
    });
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
      statusesToPreserve: existing.filter((w) => w.status !== 'observation_only').map((w) => ({ address: w.address, status: w.status }))
    };
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const result = await importRootWallets(prisma, content, { fileProvenance: file.split(/[\\/]/).pop() });
  if (result.evmParked.length > 0) {
    const parkedPath = `${file}.evm-parked.txt`;
    writeFileSync(parkedPath, result.evmParked.map((r) => r.address).join('\n') + '\n');
    console.log(`parked ${result.evmParked.length} EVM address(es) -> ${parkedPath}`);
  }
  console.log(JSON.stringify({ mode: 'import', file, ...result, evmParked: result.evmParked.length, malformedRows: result.malformedRows.length }, null, 2));
}

await main();
await prisma.$disconnect();
