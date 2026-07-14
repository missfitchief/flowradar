import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  DEFAULT_PRIORITY_CORE_SEED_THRESHOLD,
  importPriorityCoreWalletSeeds,
  previewPriorityCoreWalletSeeds,
  prisma,
  type PriorityCoreSeedRow
} from '@flowradar/db';

interface ArtifactSheetJson { sheets: Array<{ name: string; values: unknown[][] }> }

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const threshold = numericArg('--threshold') ?? DEFAULT_PRIORITY_CORE_SEED_THRESHOLD;
const sourceArgs = valuesAfter('--source');
if (!sourceArgs.length) {
  throw new Error('Usage: npm run intelligence:import-core-seeds -- --source "<original-file>::<normalized-sheet-json>" [--source ...] [--threshold 85] [--apply]');
}

const rows: PriorityCoreSeedRow[] = [];
for (const sourceArg of sourceArgs) {
  const separator = sourceArg.indexOf('::');
  if (separator < 1) throw new Error(`Invalid --source '${sourceArg}'; expected <original-file>::<normalized-sheet-json>`);
  const originalPath = path.resolve(sourceArg.slice(0, separator));
  const normalizedPath = path.resolve(sourceArg.slice(separator + 2));
  const [original, normalizedText] = await Promise.all([readFile(originalPath), readFile(normalizedPath, 'utf8')]);
  const sourceHash = createHash('sha256').update(original).digest('hex');
  const artifact = JSON.parse(normalizedText) as ArtifactSheetJson;
  if (!Array.isArray(artifact.sheets)) throw new Error(`Normalized file '${normalizedPath}' has no sheets array`);
  for (const sheet of artifact.sheets) rows.push(...sheetRows(path.basename(originalPath), sourceHash, sheet));
}

const preview = previewPriorityCoreWalletSeeds(rows, threshold);
const summary = {
  mode: apply ? 'apply' : 'dry-run',
  threshold,
  sources: preview.sourceFiles,
  sourceHashes: preview.sourceHashes,
  totalRows: preview.totalRows,
  candidateRows: preview.candidateRows,
  acceptedRows: preview.acceptedRows,
  uniqueWallets: preview.uniqueWallets,
  rejectedRows: preview.rejectedRows,
  duplicateRows: preview.duplicateRows,
  decisions: countBy(preview.entries.map((entry) => entry.decision)),
  guardrails: {
    sourceScoreOwnershipEvidence: false,
    sourceScoreSignalEligibility: false,
    sourceScoreBuyCandidateTrigger: false,
    evmAddressWithoutExplicitChain: 'rejected'
  }
};
console.log(JSON.stringify(summary, null, 2));

if (apply) {
  const report = await importPriorityCoreWalletSeeds(prisma, rows, { threshold });
  console.log(JSON.stringify({ import: report }, null, 2));
}

await prisma.$disconnect();

function sheetRows(sourceFile: string, sourceHash: string, sheet: { name: string; values: unknown[][] }): PriorityCoreSeedRow[] {
  if (!Array.isArray(sheet.values) || !sheet.values.length) return [];
  const headers = sheet.values[0]!.map(headerKey);
  return sheet.values.slice(1).map((values, index) => {
    const raw: Record<string, unknown> = {};
    headers.forEach((header, column) => { if (header) raw[header] = values[column] ?? null; });
    return {
      sourceFile,
      sourceHash,
      sourceSheet: sheet.name,
      sourceRow: index + 2,
      address: raw.address ?? raw.walletaddress ?? raw.wallet,
      chain: raw.chain ?? raw.network,
      score: raw.score,
      tier: raw.tier,
      status: raw.status,
      label: raw.label,
      addedAt: raw.addedat ?? raw.dateadded ?? raw.discoveredat,
      lastActiveAt: raw.lastactive ?? raw.lastactivity,
      raw
    };
  });
}

function headerKey(value: unknown) { return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ''); }
function countBy(values: string[]) { const counts: Record<string, number> = {}; for (const value of values) counts[value] = (counts[value] ?? 0) + 1; return counts; }
function valuesAfter(flag: string) { const values: string[] = []; for (let index = 0; index < args.length; index += 1) if (args[index] === flag && args[index + 1]) values.push(args[index + 1]!); return values; }
function numericArg(flag: string) { const index = args.indexOf(flag); if (index < 0) return null; const number = Number(args[index + 1]); if (!Number.isFinite(number)) throw new Error(`${flag} requires a finite number`); return number; }
