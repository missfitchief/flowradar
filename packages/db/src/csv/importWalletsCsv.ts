// FlowRadar — CSV wallet-stats importer (Task 6 brief decision 5(b) / plan
// Task 12 "columns per Spec Module 1").
//
// This is the standalone core of the real CSV-import feature (Task 12's
// walletImport worker job + /api/import route will call this exact function
// once the upload UI exists) — kept dependency-light (manual parse, no
// papaparse) so it has zero web/worker-framework coupling. Task 12 is
// expected to swap the manual `parseCsv` below for papaparse without changing
// this function's public signature/behavior.
//
// Columns (exact, per Spec Module 1 / plan Task 12): wallet_address, chain,
// pnl_30d, realized_pnl_30d, unrealized_pnl_30d, win_rate, trade_count_30d,
// avg_trade_size_usd, tags, source. `tags` is `|`-delimited (plan Task 12:
// "tags split on |"). Row-level validation (plan Task 12's own test-case
// list): bad chain, malformed address, negative trade_count, missing
// wallet_address each produce a row-level error, never a thrown exception —
// one bad row must never abort the whole import.
//
// Address validation: SOLANA = base58 alphabet + encoded length in [32, 44]
// chars (local check, no @solana/addresses dependency, per plan Task 12's
// "implemented locally (decode+length)" instruction — see the dedicated
// comment above isValidSolanaAddress for exactly why length-range rather than
// a literal decode-to-32-bytes check is the right local/dependency-light
// validator here). BSC = lowercase 0x-prefixed 40-hex-char address (a full
// EIP-55 checksum *validator* needs a keccak256 hash function, which would
// pull in a crypto dependency this intentionally dependency-light module
// shouldn't need yet — accepting lowercase hex covers the schema's own
// storage convention, "BSC addresses stored lowercase" per schema.prisma's
// header comment; a mixed-case address that isn't a valid checksum is
// rejected as malformed rather than silently lowercased, so a typo'd
// checksum never silently passes).
//
// Wallet upsert semantics: every valid row upserts a Wallet stub (if absent)
// and always INSERTS a fresh WalletStats row with source='csv' — never
// updates/overwrites an existing computed-source WalletStats row in place.
// "source=csv wins over computed" (plan Task 12) is a query-time concern
// (whichever consumer reads WalletStats orders by computedAt desc and/or
// prefers source='csv'), not something enforced by deleting prior rows here;
// scoring-pass.ts's buildBasicAggregate already reads "latest WalletStats per
// wallet" (computedAt desc), so a CSV import row with a later computedAt
// naturally wins without any special-casing.
//
// CSV `source` column (Task 12 controller adjudication, superseding the
// Task-6-era plan's now-stale "source=csv" framing above): this column is
// free-text *provenance* the CSV author supplies (e.g. "gmgn list", "manual
// export") — NOT a StatsSource enum value. WalletStats.source stays hard
// -coded 'csv' regardless of this column's content (a CSV row is always
// database-of-record "csv" data — see StatsSource enum, 3 fixed values:
// csv/computed/provider). When the column's value is present and isn't
// literally "csv" (a CSV author writing "csv" in their own source column
// is just restating the obvious and carries no new information), it's
// appended to Wallet.notes as a `source: <value>` line — idempotently, so
// re-importing the same file twice (or two files citing the same source)
// never duplicates the note on that wallet.

import { computeWalletScore } from '@flowradar/core';
import type { Chain } from '@flowradar/core';
import type { Prisma, PrismaClient, WalletLabel } from '@prisma/client';

const EXPECTED_COLUMNS = [
  'wallet_address',
  'chain',
  'pnl_30d',
  'realized_pnl_30d',
  'unrealized_pnl_30d',
  'win_rate',
  'trade_count_30d',
  'avg_trade_size_usd',
  'tags',
  'source'
] as const;

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export interface ImportRowError {
  row: number; // 1-based data-row index (header is row 0, not counted)
  message: string;
  raw: Record<string, string>;
}

export interface ImportWalletsCsvResult {
  importJobId: string;
  totalRows: number;
  okRows: number;
  errorRows: number;
  errors: ImportRowError[];
}

// ---------------------------------------------------------------------------
// Manual CSV parsing (no external lib — see file header)
// ---------------------------------------------------------------------------

/**
 * Minimal CSV parser: comma-delimited, optional double-quote wrapping with
 * `""`-escaped quotes inside a quoted field, `\r\n` or `\n` line endings, no
 * embedded-newline-in-unquoted-field support (not needed for this fixed
 * numeric/tag column set). Returns the header row + every data row as plain
 * string arrays — column mapping happens in importWalletsCsv itself.
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };

  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (normalized[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      pushField();
    } else if (ch === '\n') {
      pushRow();
    } else {
      field += ch;
    }
  }
  // Final field/row if the text doesn't end with a newline (and isn't empty).
  if (field.length > 0 || row.length > 0) {
    pushRow();
  }

  // Drop trailing fully-empty rows (e.g. a trailing blank line).
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

// ---------------------------------------------------------------------------
// Address validation (local, no crypto dependency — see file header)
// ---------------------------------------------------------------------------

function isValidBase58(s: string): boolean {
  if (s.length === 0) return false;
  for (const ch of s) {
    if (!BASE58_ALPHABET.includes(ch)) return false;
  }
  return true;
}

// A real base58-encoded 32-byte ed25519 public key decodes to exactly 32
// bytes, but the *encoded string length* varies with how many leading
// zero-bytes the underlying 32-byte value happens to have (each leading
// zero-byte encodes as a literal '1' rather than compressing the numeric
// magnitude) — in practice this puts every real Solana address's encoded
// length somewhere in [32, 44] chars. Real decode-then-check-32-bytes is the
// stricter validation a live adapter should eventually use (needs a proper
// bigint-base58 decoder, which is straightforward but adds real complexity
// for a "local, no dependency" check); the local/dependency-light validator
// this task calls for instead checks base58 charset + encoded length in
// [32, 44] — cheap, dependency-free, and (per @flowradar/providers's own
// mock/address.ts comment) exactly the contract the mock world's
// fakeSolanaAddress() generator promises to satisfy ("only need to LOOK like
// the right shape: base58 alphabet, 32-44 chars"), which matters concretely
// here since this task's fixture CSV uses real mock-world scenario addresses
// that are shape-realistic strings, not byte-accurate encoded pubkeys.
const SOLANA_ADDRESS_MIN_LEN = 32;
const SOLANA_ADDRESS_MAX_LEN = 44;

/** Solana addresses are base58-encoded ed25519 public keys, encoded length 32-44 chars (see comment above). */
function isValidSolanaAddress(address: string): boolean {
  if (!isValidBase58(address)) return false;
  return address.length >= SOLANA_ADDRESS_MIN_LEN && address.length <= SOLANA_ADDRESS_MAX_LEN;
}

/** BSC (EVM) addresses: 0x + 40 lowercase hex chars (see file header re: EIP-55). */
function isValidBscAddress(address: string): boolean {
  return /^0x[0-9a-f]{40}$/.test(address);
}

function isValidAddressForChain(address: string, chain: Chain): boolean {
  return chain === 'SOLANA' ? isValidSolanaAddress(address) : isValidBscAddress(address);
}

// ---------------------------------------------------------------------------
// Row validation
// ---------------------------------------------------------------------------

interface ParsedRow {
  walletAddress: string;
  chain: Chain;
  pnl30d: number;
  realizedPnl30d: number;
  unrealizedPnl30d: number;
  winRate: number;
  tradeCount30d: number;
  avgTradeSizeUsd: number;
  tags: string[];
  /**
   * Free-text provenance from the CSV's own `source` column (e.g. "gmgn
   * list"), trimmed. `null` when the column is empty or literally "csv" —
   * either way carries nothing worth writing to Wallet.notes (see file
   * header comment). Never used as a StatsSource value.
   */
  sourceNote: string | null;
}

function parseNumberField(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/** Validates+coerces one raw CSV row into a ParsedRow, or returns a row-level error message (never throws). */
function validateRow(raw: Record<string, string>): { ok: true; row: ParsedRow } | { ok: false; message: string } {
  const walletAddress = raw.wallet_address?.trim() ?? '';
  if (walletAddress === '') {
    return { ok: false, message: 'missing wallet_address' };
  }

  const chainRaw = raw.chain?.trim().toUpperCase() ?? '';
  if (chainRaw !== 'SOLANA' && chainRaw !== 'BSC') {
    return { ok: false, message: `invalid chain "${raw.chain ?? ''}" (expected SOLANA or BSC)` };
  }
  const chain = chainRaw as Chain;

  if (!isValidAddressForChain(walletAddress, chain)) {
    return { ok: false, message: `malformed ${chain} address: "${walletAddress}"` };
  }

  const pnl30d = parseNumberField(raw.pnl_30d ?? '');
  if (pnl30d === null) return { ok: false, message: `invalid pnl_30d: "${raw.pnl_30d ?? ''}"` };

  const realizedPnl30d = parseNumberField(raw.realized_pnl_30d ?? '');
  if (realizedPnl30d === null) return { ok: false, message: `invalid realized_pnl_30d: "${raw.realized_pnl_30d ?? ''}"` };

  const unrealizedPnl30d = parseNumberField(raw.unrealized_pnl_30d ?? '');
  if (unrealizedPnl30d === null) return { ok: false, message: `invalid unrealized_pnl_30d: "${raw.unrealized_pnl_30d ?? ''}"` };

  const winRate = parseNumberField(raw.win_rate ?? '');
  if (winRate === null || winRate < 0 || winRate > 1) {
    return { ok: false, message: `invalid win_rate (expected 0..1): "${raw.win_rate ?? ''}"` };
  }

  const tradeCount30d = parseNumberField(raw.trade_count_30d ?? '');
  if (tradeCount30d === null || !Number.isInteger(tradeCount30d) || tradeCount30d < 0) {
    return { ok: false, message: `invalid trade_count_30d (expected non-negative integer): "${raw.trade_count_30d ?? ''}"` };
  }

  const avgTradeSizeUsd = parseNumberField(raw.avg_trade_size_usd ?? '');
  if (avgTradeSizeUsd === null || avgTradeSizeUsd < 0) {
    return { ok: false, message: `invalid avg_trade_size_usd (expected non-negative number): "${raw.avg_trade_size_usd ?? ''}"` };
  }

  const tags = (raw.tags ?? '')
    .split('|')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  const sourceRaw = raw.source?.trim() ?? '';
  const sourceNote = sourceRaw !== '' && sourceRaw.toLowerCase() !== 'csv' ? sourceRaw : null;

  return {
    ok: true,
    row: {
      walletAddress,
      chain,
      pnl30d,
      realizedPnl30d,
      unrealizedPnl30d,
      winRate,
      tradeCount30d,
      avgTradeSizeUsd,
      tags,
      sourceNote
    }
  };
}

// ---------------------------------------------------------------------------
// WalletScore input derivation for a CSV row
// ---------------------------------------------------------------------------

/**
 * The CSV format (Spec Module 1) carries pnl/winRate/tradeCount directly but
 * has no columns for computeWalletScore's remaining inputs (humanLikelihood,
 * entryQuality, holdingQuality, recentPerf, botLikelihood, pnlConfidence) —
 * those describe *how* a wallet trades, which a plain PnL-stats CSV row
 * doesn't capture. Fixed, documented neutral-to-favorable defaults stand in:
 * a CSV-imported row is, by construction, PnL data a human operator trusts
 * enough to import (pnlConfidence 85, matching the "high confidence, CSV is
 * source of truth" framing in spec §6's PnL-layers description), with
 * humanLikelihood/entryQuality/holdingQuality/recentPerf at a neutral 0.6 and
 * zero assumed bot behavior (botLikelihood 0) since the CSV gives no signal
 * either way. `tags` containing "bot"/"possible_bot" nudges botLikelihood up
 * as the one piece of derivable signal actually present in the row.
 */
function deriveWalletScoreInput(row: ParsedRow): Parameters<typeof computeWalletScore>[0] {
  const looksLikeBot = row.tags.some((t) => /bot/i.test(t));
  return {
    pnl30d: row.pnl30d,
    winRate: row.winRate,
    tradeCount: row.tradeCount30d,
    humanLikelihood: looksLikeBot ? 0.2 : 0.6,
    entryQuality: 0.6,
    holdingQuality: 0.6,
    recentPerf: 0.6,
    botLikelihood: looksLikeBot ? 0.5 : 0,
    pnlConfidence: 85
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parses `csvText` (Spec Module 1 wallet-stats CSV format), validates every
 * row (row-level errors collected, never thrown), creates one ImportJob row
 * summarizing the run, and for every valid row upserts a Wallet stub + always
 * inserts a fresh WalletStats row (source='csv') + a WalletClassification row
 * per tag that matches a known WalletLabel. Returns the ImportJob id + counts
 * + the collected row errors (same shape the ImportJob.errors Json column
 * stores, so a caller can read either the return value or the persisted row).
 */
export async function importWalletsCsv(
  prisma: PrismaClient,
  csvText: string,
  filename = 'wallets.csv'
): Promise<ImportWalletsCsvResult> {
  const table = parseCsv(csvText);
  const [headerRow, ...dataRows] = table;

  const errors: ImportRowError[] = [];

  if (!headerRow || headerRow.length === 0) {
    const importJob = await prisma.importJob.create({
      data: {
        filename,
        status: 'failed',
        totalRows: 0,
        okRows: 0,
        errorRows: 0,
        errors: [{ row: 0, message: 'empty CSV — no header row', raw: {} }],
        finishedAt: new Date()
      }
    });
    return { importJobId: importJob.id, totalRows: 0, okRows: 0, errorRows: 0, errors: [] };
  }

  const header = headerRow.map((h) => h.trim());
  const missingColumns = EXPECTED_COLUMNS.filter((c) => !header.includes(c));
  if (missingColumns.length > 0) {
    const importJob = await prisma.importJob.create({
      data: {
        filename,
        status: 'failed',
        totalRows: dataRows.length,
        okRows: 0,
        errorRows: dataRows.length,
        errors: [{ row: 0, message: `missing required column(s): ${missingColumns.join(', ')}`, raw: {} }],
        finishedAt: new Date()
      }
    });
    return { importJobId: importJob.id, totalRows: dataRows.length, okRows: 0, errorRows: dataRows.length, errors: [] };
  }

  let okRows = 0;

  for (let i = 0; i < dataRows.length; i++) {
    const dataRow = dataRows[i]!;
    const raw: Record<string, string> = {};
    header.forEach((col, idx) => {
      raw[col] = dataRow[idx] ?? '';
    });

    const rowNumber = i + 1;
    const validated = validateRow(raw);
    if (!validated.ok) {
      errors.push({ row: rowNumber, message: validated.message, raw });
      continue;
    }

    try {
      await upsertWalletFromCsvRow(prisma, validated.row);
      okRows += 1;
    } catch (err) {
      errors.push({
        row: rowNumber,
        message: `write failed: ${err instanceof Error ? err.message : String(err)}`,
        raw
      });
    }
  }

  const errorRows = errors.length;
  const importJob = await prisma.importJob.create({
    data: {
      filename,
      status: errorRows === 0 ? 'completed' : 'completed_with_errors',
      totalRows: dataRows.length,
      okRows,
      errorRows,
      errors: errors as unknown as Prisma.InputJsonValue,
      finishedAt: new Date()
    }
  });

  return { importJobId: importJob.id, totalRows: dataRows.length, okRows, errorRows, errors };
}

const KNOWN_WALLET_LABELS: ReadonlySet<string> = new Set<WalletLabel>([
  'human_like',
  'smart_money',
  'whale',
  'possible_bot',
  'sniper',
  'mev',
  'deployer_related',
  'copy_trader',
  'cex_related',
  'bridge_related',
  'unknown'
]);

/**
 * Builds the `source: <value>` line this module appends to Wallet.notes for
 * a CSV row's free-text `source` column (see file header + ParsedRow.sourceNote
 * comments). Kept as a named helper so the exact line format is defined once
 * and reused by both the write path below and its idempotency check.
 */
function sourceNoteLine(sourceNote: string): string {
  return `source: ${sourceNote}`;
}

/**
 * Appends `source: <value>` to `currentNotes` unless a line with that exact
 * value is already present (idempotent re-import — decision 3's own
 * requirement) — returns `null` when no update is needed (value already
 * noted), so the caller can skip the write entirely rather than issuing a
 * no-op UPDATE.
 */
function nextNotes(currentNotes: string | null, sourceNote: string | null): string | null {
  if (sourceNote === null) return null;
  const line = sourceNoteLine(sourceNote);
  const existingLines = (currentNotes ?? '').split('\n').filter((l) => l.length > 0);
  if (existingLines.includes(line)) return null; // already noted — idempotent no-op
  return [...existingLines, line].join('\n');
}

async function upsertWalletFromCsvRow(prisma: PrismaClient, row: ParsedRow): Promise<void> {
  const now = new Date();

  const wallet = await prisma.wallet.upsert({
    where: { address_chain: { address: row.walletAddress, chain: row.chain } },
    create: {
      address: row.walletAddress,
      chain: row.chain,
      firstSeenAt: now,
      lastActiveAt: now,
      isWatched: true,
      notes: row.sourceNote !== null ? sourceNoteLine(row.sourceNote) : null
    },
    update: {},
    select: { id: true, notes: true }
  });

  // The `create` branch above already sets notes for a brand-new wallet;
  // this handles the pre-existing-wallet case (upsert's `update: {}` above
  // intentionally never touches notes, so a second pass here decides,
  // per-row, whether an update is actually needed — see nextNotes's
  // idempotency check).
  const updatedNotes = nextNotes(wallet.notes, row.sourceNote);
  if (updatedNotes !== null) {
    await prisma.wallet.update({ where: { id: wallet.id }, data: { notes: updatedNotes } });
  }

  const scoreInput = deriveWalletScoreInput(row);
  const scoreResult = computeWalletScore(scoreInput);

  await prisma.walletStats.create({
    data: {
      walletId: wallet.id,
      window: '30d',
      pnlUsd: row.pnl30d,
      realizedPnlUsd: row.realizedPnl30d,
      unrealizedPnlUsd: row.unrealizedPnl30d,
      winRate: row.winRate,
      tradeCount: row.tradeCount30d,
      avgTradeSizeUsd: row.avgTradeSizeUsd,
      walletScore: scoreResult.score,
      scoreComponents: scoreResult.components,
      pnlConfidence: scoreInput.pnlConfidence,
      source: 'csv',
      computedAt: now
    }
  });

  // Any tag that matches a known WalletLabel becomes a WalletClassification
  // row (source of truth: the CSV's own tags column) — unrecognized tags
  // (free-text notes) are silently not turned into a classification, since
  // WalletLabel is a fixed 11-value enum and an arbitrary tag string can't be
  // coerced into it without guessing.
  for (const tag of row.tags) {
    if (!KNOWN_WALLET_LABELS.has(tag)) continue;
    const label = tag as WalletLabel;
    const alreadyExists = await prisma.walletClassification.findFirst({
      where: { walletId: wallet.id, label }
    });
    if (alreadyExists) continue;
    await prisma.walletClassification.create({
      data: {
        walletId: wallet.id,
        label,
        confidence: 90,
        evidence: { source: 'csv-tag' }
      }
    });
  }
}
