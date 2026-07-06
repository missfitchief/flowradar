// FlowRadar — runExternalWalletSourceSync: the Wave 4.5 connector sync body
// (Task 34, Spec §5b). Same worker/seed-sharing pattern as every other
// job body in this directory (see walletDiscovery.ts's own header) —
// apps/worker/src/jobs/externalWalletSource.ts is a thin wrapper around this
// function.
//
// For each ENABLED ExternalWalletSource row: resolve a CandidateSourceProvider
// by the row's own `name` (resolveSource(sourceRow) => provider | null |
// undefined — mirrors runWalletDiscovery's WalletDiscoveryProviderResolver
// contract exactly). In MOCK_MODE the caller's resolver returns
// MockCandidateSource for every source name (Task 34 binding decision 3); live
// per-source adapters are Task 36. For each of the source's chainSupport
// entries, calls provider.fetchCandidates(chain) and UPSERTs a CandidateWallet
// row per returned ExternalCandidate, keyed on the (walletAddress, chain,
// source) unique tuple:
//   - INSERT: validationStatus='pending', firstSeenAt=lastSeenAt=now.
//   - UPDATE (re-sync): lastSeenAt/claimed figures always refresh, but
//     validationStatus is NEVER touched here — Task 35's validation pipeline
//     is the only writer of that column past the initial insert, so a
//     candidate already 'promoted'/'rejected'/'validating' is never silently
//     reset to 'pending' just because the source saw it again.
//
// Per-source try/catch: one source's provider resolution/fetch throwing is
// caught, logged into that source's own lastError/status='error'/failCount++
// row, and NEVER aborts the sync pass for any other enabled source (Spec §5b
// "one provider failing never crashes a worker loop").

import type { Prisma, PrismaClient } from '@prisma/client';
import type { Chain, Settings } from '@flowradar/core';
import type { CandidateSourceProvider } from '@flowradar/providers';

export interface ExternalWalletSourceLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/** Row shape this module needs from ExternalWalletSource — narrower than the full Prisma model. */
export interface ExternalWalletSourceRow {
  id: string;
  name: string;
  enabled: boolean;
  chainSupport: string[];
}

/**
 * Resolves a CandidateSourceProvider for a given ExternalWalletSource row.
 * Returns null/undefined, OR throws, to signal "no provider available for
 * this source" — both are handled gracefully (mirrors
 * WalletDiscoveryProviderResolver's contract in walletDiscovery.ts).
 */
export type CandidateSourceResolver = (
  source: ExternalWalletSourceRow
) => CandidateSourceProvider | null | undefined;

export interface ExternalWalletSourceSyncResult {
  sourcesConsidered: number;
  sourcesSynced: number;
  sourcesSkippedDisabled: number;
  candidatesUpserted: number;
  errors: number;
}

const VALID_CHAINS: Chain[] = ['SOLANA', 'BSC'];

export async function runExternalWalletSourceSync(
  prisma: PrismaClient,
  _settings: Settings,
  resolveSource: CandidateSourceResolver,
  log?: ExternalWalletSourceLogger
): Promise<ExternalWalletSourceSyncResult> {
  const allSources = await prisma.externalWalletSource.findMany();

  let sourcesSynced = 0;
  let sourcesSkippedDisabled = 0;
  let candidatesUpserted = 0;
  let errors = 0;

  for (const source of allSources) {
    if (!source.enabled) {
      sourcesSkippedDisabled += 1;
      log?.info('externalWalletSource: source disabled, skipping', { source: source.name });
      continue;
    }

    try {
      const provider = resolveSource({ id: source.id, name: source.name, enabled: source.enabled, chainSupport: source.chainSupport });
      if (!provider) {
        log?.info('externalWalletSource: no provider resolved for source, skipping', { source: source.name });
        continue;
      }

      let sourceCandidateCount = 0;
      for (const chainRaw of source.chainSupport) {
        if (!VALID_CHAINS.includes(chainRaw as Chain)) continue;
        const chain = chainRaw as Chain;

        const candidates = await provider.fetchCandidates(chain);
        for (const candidate of candidates) {
          await upsertCandidateWallet(prisma, source.name, candidate);
          candidatesUpserted += 1;
          sourceCandidateCount += 1;
        }
      }

      await prisma.externalWalletSource.update({
        where: { id: source.id },
        data: { lastSyncAt: new Date(), status: 'ok', lastError: null, failCount: 0 }
      });
      sourcesSynced += 1;
      log?.info('externalWalletSource: source sync complete', { source: source.name, candidatesFound: sourceCandidateCount });
    } catch (err) {
      errors += 1;
      const message = err instanceof Error ? err.message : String(err);
      await prisma.externalWalletSource.update({
        where: { id: source.id },
        data: {
          status: 'error',
          lastError: message,
          failCount: { increment: 1 }
        }
      });
      log?.error(`externalWalletSource: provider error for source ${source.name}`, { source: source.name, error: message });
    }
  }

  const summary: ExternalWalletSourceSyncResult = {
    sourcesConsidered: allSources.length,
    sourcesSynced,
    sourcesSkippedDisabled,
    candidatesUpserted,
    errors
  };
  log?.info('externalWalletSource cycle complete', { ...summary });
  return summary;
}

async function upsertCandidateWallet(
  prisma: PrismaClient,
  sourceName: string,
  candidate: {
    walletAddress: string;
    chain: Chain;
    sourceRank?: number;
    claimedPnlUsd?: number;
    claimedWinRate?: number;
    claimedTradeCount?: number;
    claimedRoi?: number;
    metadata?: Record<string, unknown>;
  }
): Promise<void> {
  const now = new Date();

  await prisma.candidateWallet.upsert({
    where: {
      walletAddress_chain_source: {
        walletAddress: candidate.walletAddress,
        chain: candidate.chain,
        source: sourceName
      }
    },
    create: {
      walletAddress: candidate.walletAddress,
      chain: candidate.chain,
      source: sourceName,
      sourceRank: candidate.sourceRank ?? null,
      claimedPnlUsd: candidate.claimedPnlUsd ?? null,
      claimedWinRate: candidate.claimedWinRate ?? null,
      claimedTradeCount: candidate.claimedTradeCount ?? null,
      claimedRoi: candidate.claimedRoi ?? null,
      firstSeenAt: now,
      lastSeenAt: now,
      validationStatus: 'pending',
      metadataJson: (candidate.metadata as Prisma.InputJsonValue) ?? undefined
    },
    // Re-sync: refresh lastSeenAt + claimed figures ONLY. validationStatus is
    // deliberately absent from this update — never touched on an existing
    // row, so a 'promoted'/'rejected'/'validating' candidate is never reset
    // to 'pending' just because the source saw it again (Task 34 binding
    // decision 3's "re-sync ... NEVER downgrades a 'promoted'/'rejected' back
    // to 'pending'").
    update: {
      sourceRank: candidate.sourceRank ?? null,
      claimedPnlUsd: candidate.claimedPnlUsd ?? null,
      claimedWinRate: candidate.claimedWinRate ?? null,
      claimedTradeCount: candidate.claimedTradeCount ?? null,
      claimedRoi: candidate.claimedRoi ?? null,
      lastSeenAt: now,
      metadataJson: (candidate.metadata as Prisma.InputJsonValue) ?? undefined
    }
  });
}
