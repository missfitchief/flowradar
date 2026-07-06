// FlowRadar — runWalletDiscovery: exercises the (currently mock-only)
// WalletDiscoveryProvider capability (plan Task 30 binding decision 2).
//
// THIS IS A DELIBERATE PLACEHOLDER — Wave 4.5's real connector pipeline
// supersedes it. Its job today is narrow: (a) exist + register + never
// crash, (b) exercise the mock discovery capability end-to-end so the wiring
// is proven before Wave 4.5 builds the real candidate -> validate -> promote
// pipeline on top of it.
//
// For each enabled chain (settings.chainsEnabled), resolves
// getProvider(chain, 'walletDiscovery'):
//   - Provider present (MOCK_MODE, or a future live connector) => pulls
//     candidate wallets via getCandidateWallets(chain), upserts a Wallet row
//     per candidate (isWatched=false — discovery is NOT promotion; watching a
//     wallet is a separate, deliberate decision left to the real Wave 4.5
//     candidate->validate->promote pipeline) with
//     notes='discovered:<providerName-or-mock>', and inserts a fresh
//     WalletStats row (source='provider') seeded from the candidate's own
//     claimed walletScore (the only figure WalletCandidate actually carries —
//     see packages/providers/src/types.ts's GetCandidateWalletsOpts/
//     WalletCandidate; there is no claimed pnl/winRate/tradeCount to persist,
//     so those columns are written as neutral zeros with a low pnlConfidence,
//     honestly reflecting "we only know a claimed score, nothing else yet").
//   - Provider resolution throws (live mode, no adapter implemented for this
//     capability yet — see packages/providers/src/registry.ts's getProvider,
//     which throws rather than returning a sentinel for unimplemented live
//     capabilities) or getProviderFn itself is missing/returns null/undefined
//     => logged as 'no live discovery provider (Wave 4.5 connectors add real
//     sources)' and treated as a graceful no-op for that chain. Never throws
//     past this module.

import type { PrismaClient } from '@prisma/client';
import type { Chain, Settings } from '@flowradar/core';
import type { WalletDiscoveryProvider } from '@flowradar/providers';

export interface WalletDiscoveryLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/**
 * Minimal provider-resolver shape this module needs — deliberately narrower
 * than apps/worker's full ProviderResolver type (packages/db doesn't depend
 * on apps/worker). Returns null/undefined, OR throws, to signal "no live
 * discovery provider available for this chain" — both are handled
 * gracefully (see runWalletDiscovery's per-chain try/catch below).
 */
export type WalletDiscoveryProviderResolver = (
  chain: Chain
) => WalletDiscoveryProvider | null | undefined;

export interface WalletDiscoveryResult {
  chainsConsidered: number;
  candidatesUpserted: number;
  chainsWithNoProvider: number;
  errors: number;
}

const ALL_CHAINS: Chain[] = ['SOLANA', 'BSC'];

export async function runWalletDiscovery(
  prisma: PrismaClient,
  settings: Settings,
  getProviderFn: WalletDiscoveryProviderResolver,
  log?: WalletDiscoveryLogger
): Promise<WalletDiscoveryResult> {
  const enabledChains = ALL_CHAINS.filter((chain) => settings.chainsEnabled[chain]);

  let candidatesUpserted = 0;
  let chainsWithNoProvider = 0;
  let errors = 0;

  for (const chain of enabledChains) {
    try {
      const provider = getProviderFn(chain);
      if (!provider) {
        chainsWithNoProvider += 1;
        log?.info('walletDiscovery: no live discovery provider (Wave 4.5 connectors add real sources)', { chain });
        continue;
      }

      const candidates = await provider.getCandidateWallets(chain);
      for (const candidate of candidates) {
        await upsertCandidateWallet(prisma, chain, candidate);
        candidatesUpserted += 1;
      }
      log?.info('walletDiscovery: chain pass complete', { chain, candidatesFound: candidates.length });
    } catch (err) {
      errors += 1;
      log?.error('walletDiscovery: no live discovery provider (Wave 4.5 connectors add real sources)', {
        chain,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  const summary: WalletDiscoveryResult = {
    chainsConsidered: enabledChains.length,
    candidatesUpserted,
    chainsWithNoProvider,
    errors
  };
  log?.info('walletDiscovery cycle complete', { ...summary });
  return summary;
}

async function upsertCandidateWallet(
  prisma: PrismaClient,
  chain: Chain,
  candidate: { address: string; walletScore: number }
): Promise<void> {
  const now = new Date();
  const note = 'discovered:mock';

  const wallet = await prisma.wallet.upsert({
    where: { address_chain: { address: candidate.address, chain } },
    create: {
      address: candidate.address,
      chain,
      firstSeenAt: now,
      lastActiveAt: now,
      isWatched: false,
      notes: note
    },
    update: {},
    select: { id: true, notes: true }
  });

  // Idempotent notes append (only when not already present) — same pattern
  // as csv/importWalletsCsv.ts's nextNotes helper.
  const existingLines = (wallet.notes ?? '').split('\n').filter((l) => l.length > 0);
  if (!existingLines.includes(note)) {
    await prisma.wallet.update({ where: { id: wallet.id }, data: { notes: [...existingLines, note].join('\n') } });
  }

  // WalletCandidate (packages/core/src/types.ts) only carries a claimed
  // walletScore — no pnl/winRate/tradeCount figure exists to persist, so
  // those columns are written as honest neutral zeros rather than invented
  // numbers, with a low pnlConfidence (20) reflecting "an unvalidated
  // discovery claim, not a measured PnL". scoreComponents records that this
  // row's walletScore is a passthrough of the provider's own claim, not
  // locally recomputed via computeWalletScore (there is no PnL/behavioral
  // data yet to compute it from).
  await prisma.walletStats.create({
    data: {
      walletId: wallet.id,
      window: '30d',
      pnlUsd: 0,
      realizedPnlUsd: 0,
      unrealizedPnlUsd: 0,
      winRate: 0,
      tradeCount: 0,
      avgTradeSizeUsd: 0,
      walletScore: candidate.walletScore,
      scoreComponents: { source: 'provider_claimed', note: 'discovery candidate — not yet validated/scored locally' },
      pnlConfidence: 20,
      source: 'provider',
      computedAt: now
    }
  });
}
