// FlowRadar — Capital Lineage Engine (Phase 6a): dynamic root-wallet importer.
//
// Operator contract (2026-07-10 directive):
//   - DYNAMIC: imports ALL valid unique Solana roots found in the supplied
//     input — N is determined by @flowradar/core's parseRootWalletFile,
//     never hardcoded. No production maximum exists except the explicit,
//     configurable operational safety limit below.
//   - IDEMPOTENT + INCREMENTAL: re-imports and follow-up files upsert; a
//     root/subscription is never duplicated (DB-unique on LineageRoot.walletId
//     and MonitoringSubscription [walletId, priority]).
//   - PRESERVATION-FIRST: existing wallets keep their status, classification,
//     notes, and monitoring state untouched (a deactivated subscription is
//     NOT reactivated; a public_kol/excluded wallet is NOT re-statused —
//     roots track lineage, status governs signal weight, the two are
//     orthogonal). Roots absent from a later file are NEVER deleted
//     (requirement 8) — lastSeenInImportAt simply stops advancing.
//   - NEVER ELIGIBLE: new wallets are minted observation_only with no stats
//     rows (an address-only import claims nothing). Only individual operator
//     approval or local validation can ever make a wallet signal_eligible.
//
// Scheduler contract (documented here because this module creates the work
// items): MonitoringSubscription rows are the queue — consumed in
// priority-ordered batches with cursors under provider rate budgets. NO
// per-root timers. walletActivity remains the baseline poller (Phase 0:
// observation_only is always polled); subscription tiers are the priority
// layer future lineage jobs read.

import type { PrismaClient } from '@prisma/client';
import { parseRootWalletFile } from '@flowradar/core';
import type { ParsedRootWalletFile } from '@flowradar/core';
import { withGlobalJobLock } from '../locks/globalJobLock';

/** Explicit configurable operational safety limit (requirement 10). */
const DEFAULT_MAX_ROOTS = 10_000;

export interface RootImportOptions {
  /** Recorded on LineageRoot.fileProvenance for audit. */
  fileProvenance?: string;
  /** Overrides LINEAGE_IMPORT_MAX_ROOTS / the 10k default. */
  maxRoots?: number;
  /** Injectable clock for deterministic tests. */
  now?: Date;
}

export interface RootImportResult {
  // Parser counts (dynamic, input-derived — mirrors the dry-run report).
  totalLines: number;
  validRoots: number;
  duplicateRows: number;
  evmParked: ParsedRootWalletFile['evmParked'];
  malformedRows: ParsedRootWalletFile['malformed'];
  // Import outcome.
  walletsCreated: number;
  walletsExisting: number;
  newRoots: number;
  existingRoots: number;
  subscriptionsCreated: number;
  subscriptionsExisting: number;
}

function resolveMaxRoots(optValue: number | undefined): number {
  if (optValue !== undefined) {
    // An explicit override must be a real positive number — NaN/Infinity
    // would silently disable the limit (roots.length > NaN is always false).
    if (!Number.isFinite(optValue) || optValue < 1) {
      throw new Error(`importRootWallets: invalid maxRoots override ${optValue} — must be a finite number >= 1`);
    }
    return Math.floor(optValue);
  }
  const raw = process.env.LINEAGE_IMPORT_MAX_ROOTS;
  if (raw === undefined || raw === '') return DEFAULT_MAX_ROOTS;
  const parsed = Number(raw);
  // A SET-but-unparseable env value must FAIL CLOSED (2026-07-10 review):
  // an operator writing LINEAGE_IMPORT_MAX_ROOTS=5,000 to TIGHTEN the limit
  // must not silently get the looser 10k default.
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(
      `importRootWallets: LINEAGE_IMPORT_MAX_ROOTS='${raw}' is not a finite number >= 1 — refusing to guess (fail-closed on a safety limit)`
    );
  }
  return Math.floor(parsed);
}

/** True when err is Prisma's unique-constraint violation (P2002). */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';
}

export async function importRootWallets(
  prisma: PrismaClient,
  content: string,
  opts: RootImportOptions = {}
): Promise<RootImportResult> {
  const parsed = parseRootWalletFile(content);
  const now = opts.now ?? new Date();
  const maxRoots = resolveMaxRoots(opts.maxRoots);

  if (parsed.roots.length > maxRoots) {
    throw new Error(
      `importRootWallets: ${parsed.roots.length} roots exceeds the operational safety limit of ${maxRoots} ` +
        `(configurable via LINEAGE_IMPORT_MAX_ROOTS or opts.maxRoots) — nothing imported`
    );
  }

  let walletsCreated = 0;
  let walletsExisting = 0;
  let newRoots = 0;
  let existingRoots = 0;
  let subscriptionsCreated = 0;
  let subscriptionsExisting = 0;

  // Sequential per-root writes: idempotent, resume-safe (a crash mid-file
  // heals on re-import), and DB-friendly at hundreds of roots. No global
  // transaction by design — partial progress is valid progress here.
  //
  // SERIALIZATION (Prerequisite B): the whole write phase runs under the
  // global job lock so an import can never interleave with db:seed's wipe,
  // a live reset, or a lineage backfill. The create+P2002-fallback logic
  // below stays as belt-and-braces (it also covers non-lock writers like
  // the live ingest pipeline creating the same wallet).
  await withGlobalJobLock(`root-import${opts.fileProvenance ? `:${opts.fileProvenance}` : ''}`, async () => {
  for (const root of parsed.roots) {
    let walletId: string;
    try {
      const created = await prisma.wallet.create({
        data: {
          address: root.address,
          chain: 'SOLANA',
          firstSeenAt: now,
          lastActiveAt: now,
          isWatched: false,
          status: 'observation_only',
          notes: `lineage-root:operator${opts.fileProvenance ? ` (${opts.fileProvenance})` : ''}`
        },
        select: { id: true }
      });
      walletId = created.id;
      walletsCreated += 1;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // PRESERVATION: no field on an existing wallet is touched — not
      // status, not isWatched, not notes.
      const existing = await prisma.wallet.findUniqueOrThrow({
        where: { address_chain: { address: root.address, chain: 'SOLANA' } },
        select: { id: true }
      });
      walletId = existing.id;
      walletsExisting += 1;
    }

    let lineageRootId: string;
    try {
      const createdRoot = await prisma.lineageRoot.create({
        data: {
          walletId,
          source: 'operator_file',
          label: root.label ?? null,
          fileProvenance: opts.fileProvenance ?? null,
          permanent: true,
          firstImportedAt: now,
          lastSeenInImportAt: now
        },
        select: { id: true }
      });
      lineageRootId = createdRoot.id;
      newRoots += 1;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // Idempotent re-import: only the telemetry timestamp advances; label,
      // provenance, and permanence are first-import-wins. The timestamp is
      // monotonic (guarded updateMany) so a delayed older run racing a newer
      // one cannot regress it.
      const existingRoot = await prisma.lineageRoot.findUniqueOrThrow({ where: { walletId }, select: { id: true } });
      await prisma.lineageRoot.updateMany({
        where: { id: existingRoot.id, lastSeenInImportAt: { lt: now } },
        data: { lastSeenInImportAt: now }
      });
      lineageRootId = existingRoot.id;
      existingRoots += 1;
    }

    try {
      await prisma.monitoringSubscription.create({
        data: {
          walletId,
          priority: 'root_permanent',
          active: true,
          reason: 'operator_root_import',
          lineageRootId
        }
      });
      subscriptionsCreated += 1;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // Verify the row the unique violation implies actually exists (2026-07-10
      // Codex re-review: a P2002 from anything else, or a concurrent delete,
      // must surface as an error — not a silent "existing" success without a
      // subscription). PRESERVATION: the found row is never modified, so an
      // operator-deactivated subscription stays deactivated.
      await prisma.monitoringSubscription.findUniqueOrThrow({
        where: { walletId_priority: { walletId, priority: 'root_permanent' } },
        select: { id: true }
      });
      subscriptionsExisting += 1;
    }
  }
  });

  return {
    totalLines: parsed.totalLines,
    validRoots: parsed.roots.length,
    duplicateRows: parsed.duplicates.length,
    evmParked: parsed.evmParked,
    malformedRows: parsed.malformed,
    walletsCreated,
    walletsExisting,
    newRoots,
    existingRoots,
    subscriptionsCreated,
    subscriptionsExisting
  };
}
