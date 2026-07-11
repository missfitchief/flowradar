// FlowRadar — Capital Lineage (Wave D): dedicated observation-universe import.
//
// A SEPARATE path from importWalletsCsv (which grants signal_eligible for
// operator-vouched wallets). This one imports a wallet UNIVERSE as pure
// OBSERVATION: every wallet is observation_only, any provider stats are stored
// in the SHADOW model ObservationProviderSnapshot (provider_claimed, NOT
// locally verified) — NEVER WalletStats, which the FlowScore path reads. So
// NOTHING here ever grants signal eligibility, contributes a smart vote, or can
// perturb a FlowScore. Existing classifications (public_kol/public_promoter/
// copytrader/bot_or_service/excluded) and monitoring/lineage state are
// PRESERVED. Idempotent, deduped. Address-only rows are fine — no stats
// fabricated (hard rule 9); provider fields not supplied stay NULL, never 0.
//
// CSV columns (header row required): wallet_address[,source][,pnl_30d]
// [,win_rate][,trade_count_30d][,avg_trade_size_usd][,tags]. Only
// wallet_address is required; stats are optional and, when present, stored as
// provider_claimed. A win_rate must be a fraction 0..1.

import type { PrismaClient } from '@prisma/client';
import { parseRootWalletFile } from '@flowradar/core';
import { withGlobalJobLock } from '../locks/globalJobLock';

export interface ObservationRow {
  address: string;
  source: string;
  providerStats?: {
    pnl30d: number;
    winRate: number;
    tradeCount: number;
    avgTradeSizeUsd: number;
  };
  tags: string[];
  line: number;
}

export interface ObservationParseResult {
  rows: ObservationRow[];
  evmParked: string[];
  malformed: { line: number; raw: string; reason: string }[];
  duplicates: number;
}

// Quote-aware CSV line split (RFC-4180 subset): honors double-quoted fields
// so a spreadsheet export ("addr","source") validates, and a quoted field
// containing a comma does not shift columns. `""` inside a quoted field is a
// literal quote. Unquoted cells are trimmed; quoted cells keep inner spaces.
// Returns null on malformed quoting (unterminated quote, a quote mid-unquoted
// cell, or characters after a closing quote) — the caller flags such a row
// malformed rather than silently "repairing" it into a valid-looking value.
function splitCsv(line: string): string[] | null {
  const out: string[] = [];
  let cell = '';
  // start: field not yet begun · unquoted: plain field · inquotes: inside "…"
  // · afterquote: closing quote seen, expecting a delimiter
  let state: 'start' | 'unquoted' | 'inquotes' | 'afterquote' = 'start';
  const pushCell = () => out.push(state === 'unquoted' || state === 'start' ? cell.trim() : cell);
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (state === 'inquotes') {
      if (ch === '"') {
        if (line[i + 1] === '"') { cell += '"'; i++; } // escaped quote
        else state = 'afterquote';
      } else cell += ch;
    } else if (ch === ',') {
      pushCell();
      cell = '';
      state = 'start';
    } else if (ch === '"') {
      if (state !== 'start') return null; // quote mid-cell / after a closing quote
      state = 'inquotes';
    } else {
      if (state === 'afterquote') return null; // stray chars after a closing quote
      cell += ch;
      state = 'unquoted';
    }
  }
  if (state === 'inquotes') return null; // unterminated quote
  pushCell();
  return out;
}

export function parseObservationUniverse(csv: string): ObservationParseResult {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim() !== '');
  const rows: ObservationRow[] = [];
  const malformed: ObservationParseResult['malformed'] = [];
  const evmParked: string[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  if (lines.length === 0) return { rows, evmParked, malformed, duplicates };

  const headerCells = splitCsv(lines[0]!);
  if (!headerCells) {
    throw new Error('observation-universe CSV header row has malformed quoting');
  }
  const header = headerCells.map((h) => h.toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const iAddr = col('wallet_address');
  // Hard-require the address header — never silently treat column 0 as the
  // address, which would import garbage from a mis-shaped file.
  if (iAddr < 0) {
    throw new Error('observation-universe CSV requires a "wallet_address" header column');
  }
  const iSource = col('source');
  const iPnl = col('pnl_30d');
  const iWin = col('win_rate');
  const iTrades = col('trade_count_30d');
  const iAvg = col('avg_trade_size_usd');
  const iTags = col('tags');

  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i]!;
    const cells = splitCsv(raw);
    if (!cells) {
      malformed.push({ line: i + 1, raw, reason: 'malformed CSV quoting' });
      continue;
    }
    const rawAddr = (cells[iAddr] ?? '').trim();
    if (/^0x[0-9a-fA-F]{40}$/i.test(rawAddr)) {
      evmParked.push(rawAddr);
      continue;
    }
    // Reuse the canonical Solana base58 32-byte validator. It also strips any
    // inline `addr|label` / `addr#label` decoration; we store the CANONICAL
    // address it returns (never the raw cell), so a label cannot smuggle an
    // unvalidated string past validation or dedupe.
    const check = parseRootWalletFile(rawAddr);
    if (check.roots.length !== 1) {
      malformed.push({ line: i + 1, raw, reason: 'not a valid Solana address' });
      continue;
    }
    const address = check.roots[0]!.address;
    if (seen.has(address)) {
      duplicates += 1;
      continue;
    }
    seen.add(address);

    const num = (idx: number): number | null => {
      if (idx < 0) return null;
      const cell = (cells[idx] ?? '').trim();
      if (cell === '') return null; // blank cell = unknown, NEVER 0 (hard rule 9)
      const v = Number(cell);
      return Number.isFinite(v) ? v : null;
    };
    const pnl = num(iPnl);
    const win = num(iWin);
    const trades = num(iTrades);
    const avg = num(iAvg);
    let providerStats: ObservationRow['providerStats'] | undefined;
    // Only build a provider-stats block when ALL four are present AND sane:
    // win_rate a fraction 0..1, trade_count a non-negative integer, avg a
    // non-negative size. A blank/negative/garbage cell => no stats — never
    // fabricate a zero (hard rule 9: missing means unknown, not zero/safe).
    if (
      pnl !== null && win !== null && trades !== null && avg !== null &&
      win >= 0 && win <= 1 &&
      Number.isInteger(trades) && trades >= 0 &&
      avg >= 0
    ) {
      providerStats = { pnl30d: pnl, winRate: win, tradeCount: trades, avgTradeSizeUsd: avg };
    }
    const tags = iTags >= 0 && cells[iTags] ? cells[iTags]!.split('|').map((t) => t.trim()).filter(Boolean) : [];
    rows.push({ address, source: (iSource >= 0 ? cells[iSource] : '') || 'observation_universe', providerStats, tags, line: i + 1 });
  }
  return { rows, evmParked, malformed, duplicates };
}

export interface ObservationImportResult {
  totalRows: number;
  validRows: number;
  walletsCreated: number;
  walletsExisting: number;
  /** Provider-claimed snapshots upserted into ObservationProviderSnapshot (NOT WalletStats). */
  snapshotsWritten: number;
  classificationsPreserved: number;
  evmParked: number;
  malformed: number;
  duplicates: number;
}

export async function importObservationUniverse(
  prisma: PrismaClient,
  csv: string,
  opts: { now?: Date; provenance?: string } = {}
): Promise<ObservationImportResult> {
  const parsed = parseObservationUniverse(csv);
  const now = opts.now ?? new Date();
  const result: ObservationImportResult = {
    totalRows: parsed.rows.length + parsed.evmParked.length + parsed.malformed.length + parsed.duplicates,
    validRows: parsed.rows.length,
    walletsCreated: 0,
    walletsExisting: 0,
    snapshotsWritten: 0,
    classificationsPreserved: 0,
    evmParked: parsed.evmParked.length,
    malformed: parsed.malformed.length,
    duplicates: parsed.duplicates
  };

  // Hold the global job lock for the whole write phase: serializes concurrent
  // imports (closing the count→create stats race) and against worker jobs.
  await withGlobalJobLock('importObservationUniverse', async () => {
  for (const row of parsed.rows) {
    const existing = await prisma.wallet.findUnique({
      where: { address_chain: { address: row.address, chain: 'SOLANA' } },
      select: { id: true, status: true }
    });

    let walletId: string;
    if (existing) {
      // PRESERVATION: never change an existing wallet's status (a classified
      // public_kol/excluded, or an operator-promoted signal_eligible, survives
      // — the universe import must NOT demote or re-status it).
      walletId = existing.id;
      result.walletsExisting += 1;
      if (existing.status !== 'observation_only') result.classificationsPreserved += 1;
    } else {
      // Atomic create-or-preserve (Codex final review): a non-cooperating writer
      // (candidate promotion, ingestion — none of which take this advisory lock)
      // may create this wallet between the findUnique above and here. upsert with
      // an EMPTY update never P2002s and never re-statuses an existing row, so a
      // concurrently-created public_kol/signal_eligible wallet is preserved. (In
      // that rare race walletsCreated may over-count by 1 — a cosmetic stat; the
      // write and the status-preservation invariant stay correct.)
      const created = await prisma.wallet.upsert({
        where: { address_chain: { address: row.address, chain: 'SOLANA' } },
        create: {
          address: row.address,
          chain: 'SOLANA',
          firstSeenAt: now,
          lastActiveAt: now,
          isWatched: false,
          status: 'observation_only', // NEVER signal_eligible via this path
          notes: `observation-universe:${row.source}${opts.provenance ? ` (${opts.provenance})` : ''}`
        },
        update: {}, // existing row: preserve status/everything — never re-status
        select: { id: true }
      });
      walletId = created.id;
      result.walletsCreated += 1;
    }

    // Store provider-claimed stats in the SHADOW model ObservationProviderSnapshot
    // — NEVER WalletStats. WalletStats is read by the FlowScore path
    // (fetchAggregateInputs picks the latest row by computedAt regardless of
    // source/status, and computeFlowScore averages walletScore across ALL buyers)
    // — so an uncomputed provider row there would DRAG DOWN the FlowScore of any
    // token these wallets trade, violating hard-rule-1. The shadow model has no
    // scoring reader, and fields the provider did not supply stay NULL (honest
    // unknown, never a fabricated 0/computed-score). Upsert on (walletId, source,
    // window) → idempotent re-import + race-free (no duplicate rows). (Codex
    // final review, 2 rounds.)
    if (row.providerStats) {
      await prisma.observationProviderSnapshot.upsert({
        where: { walletId_source_window: { walletId, source: row.source, window: '30d' } },
        create: {
          walletId,
          source: row.source, // provider/source label — provider_claimed, unverified
          window: '30d',
          pnlUsd: row.providerStats.pnl30d,
          winRate: row.providerStats.winRate,
          tradeCount: row.providerStats.tradeCount,
          avgTradeSizeUsd: row.providerStats.avgTradeSizeUsd,
          providerClaimed: true,
          observedAt: now
        },
        update: {
          pnlUsd: row.providerStats.pnl30d,
          winRate: row.providerStats.winRate,
          tradeCount: row.providerStats.tradeCount,
          avgTradeSizeUsd: row.providerStats.avgTradeSizeUsd,
          observedAt: now
        }
      });
      result.snapshotsWritten += 1;
    }
  }
  });

  return result;
}
