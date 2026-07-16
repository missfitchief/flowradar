import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  AUTHORITATIVE_CORE_AUTHORITY,
  DEFAULT_PRIORITY_CORE_SEED_THRESHOLD,
  importPriorityCoreWalletSeeds,
  previewPriorityCoreWalletSeeds,
  prisma,
  type PriorityCoreSeedRow
} from '@flowradar/db';

interface ArtifactSheetJson { sheets: Array<{ name: string; values: unknown[][] }> }

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const authoritative = args.includes('--authoritative');
const authority = authoritative ? AUTHORITATIVE_CORE_AUTHORITY : null;
const threshold = numericArg('--threshold') ?? (authoritative ? 0 : DEFAULT_PRIORITY_CORE_SEED_THRESHOLD);
const sourceArgs = valuesAfter('--source');
const csvArgs = valuesAfter('--csv');
if (!sourceArgs.length && !csvArgs.length) {
  throw new Error('Usage: npm run intelligence:import-core-seeds -- --csv "<wallets.csv>" [--authoritative] [--threshold 0] [--apply]');
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

for (const csvArg of csvArgs) {
  const originalPath = path.resolve(csvArg);
  const original = await readFile(originalPath);
  const sourceHash = createHash('sha256').update(original).digest('hex');
  rows.push(...csvRows(path.basename(originalPath), sourceHash, original.toString('utf8')));
}

const preview = previewPriorityCoreWalletSeeds(rows, threshold, authority);
const summary = {
  mode: apply ? 'apply' : 'dry-run',
  authority,
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
  const report = await importPriorityCoreWalletSeeds(prisma, rows, { threshold, authority });
  console.log(JSON.stringify({ import: report }, null, 2));
}

function csvRows(sourceFile: string, sourceHash: string, text: string): PriorityCoreSeedRow[] {
  const table = parseCsv(text);
  if (!table.length) throw new Error(`CSV '${sourceFile}' is empty`);
  const headers = table[0]!.map(headerKey);
  const required = ['address', 'score', 'label', 'status'];
  const missing = required.filter((header) => !headers.includes(header));
  if (missing.length) throw new Error(`CSV '${sourceFile}' is missing required columns: ${missing.join(', ')}`);
  return table.slice(1).map((values, index) => {
    const raw: Record<string, unknown> = {};
    headers.forEach((header, column) => { if (header) raw[header] = values[column]?.trim() ?? null; });
    const explicitClassifications = [
      ...splitValues(raw.classifications ?? raw.classification ?? raw.tags),
      ...['dormant', 'insider', 'alpha', 'sniper', 'kol'].filter((key) => truthy(raw[key]))
    ];
    return {
      sourceFile,
      sourceHash,
      sourceSheet: 'CSV',
      sourceRow: index + 2,
      address: raw.address ?? raw.walletaddress ?? raw.wallet,
      chain: raw.chain ?? raw.network,
      score: raw.score ?? raw.sourcescore,
      tier: raw.tier,
      status: raw.status ?? raw.corestatus,
      label: raw.label,
      addedAt: raw.addedat ?? raw.dateadded ?? raw.discoveredat,
      lastActiveAt: raw.lastactive ?? raw.lastactivity,
      category: raw.category,
      type: raw.type ?? raw.wallettype,
      reliabilityScore: raw.reliabilityscore ?? raw.reliability,
      classifications: explicitClassifications,
      raw
    };
  });
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
function splitValues(value: unknown) { return String(value ?? '').split(/[|,;]/).map((item) => item.trim().toLowerCase()).filter(Boolean); }
function truthy(value: unknown) { return ['1', 'true', 'yes', 'y'].includes(String(value ?? '').trim().toLowerCase()); }

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const pushField = () => { row.push(field); field = ''; };
  const pushRow = () => { pushField(); rows.push(row); row = []; };
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index]!;
    if (quoted) {
      if (character === '"' && normalized[index + 1] === '"') { field += '"'; index += 1; }
      else if (character === '"') quoted = false;
      else field += character;
    } else if (character === '"') quoted = true;
    else if (character === ',') pushField();
    else if (character === '\n') pushRow();
    else field += character;
  }
  if (field.length || row.length) pushRow();
  return rows.filter((values) => values.some((value) => value.trim()));
}
