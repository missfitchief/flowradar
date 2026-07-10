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
  if (optValue !== undefined) return optValue;
  const raw = process.env.LINEAGE_IMPORT_MAX_ROOTS;
  const parsed = raw !== undefined ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : DEFAULT_MAX_ROOTS;
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

  // Sequential per-root upserts: idempotent, resume-safe (a crash mid-file
  // heals on re-import), and DB-friendly at hundreds of roots. No global
  // transaction by design — partial progress is valid progress here.
  for (const root of parsed.roots) {
    const existingWallet = await prisma.wallet.findUnique({
      where: { address_chain: { address: root.address, chain: 'SOLANA' } },
      select: { id: true }
    });

    let walletId: string;
    if (existingWallet) {
      // PRESERVATION: no field on an existing wallet is touched — not
      // status, not isWatched, not notes.
      walletId = existingWallet.id;
      walletsExisting += 1;
    } else {
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
    }

    const existingRoot = await prisma.lineageRoot.findUnique({ where: { walletId }, select: { id: true } });
    let lineageRootId: string;
    if (existingRoot) {
      // Idempotent re-import: only the telemetry timestamp advances; label,
      // provenance, and permanence are first-import-wins.
      await prisma.lineageRoot.update({ where: { id: existingRoot.id }, data: { lastSeenInImportAt: now } });
      lineageRootId = existingRoot.id;
      existingRoots += 1;
    } else {
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
    }

    const existingSub = await prisma.monitoringSubscription.findUnique({
      where: { walletId_priority: { walletId, priority: 'root_permanent' } },
      select: { id: true }
    });
    if (existingSub) {
      // PRESERVATION: an operator-deactivated subscription stays deactivated.
      subscriptionsExisting += 1;
    } else {
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
    }
  }

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
