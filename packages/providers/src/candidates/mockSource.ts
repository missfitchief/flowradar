// FlowRadar — MockCandidateSource: deterministic leaderboard derived from the
// mock world (Task 34, Wave 4.5, Spec §5b). This is what EVERY
// ExternalWalletSource name resolves to in MOCK_MODE (see
// apps/worker/src/jobs/externalWalletSource.ts) — live per-source adapters
// (Solana Tracker, Birdeye, KOLScan, GMGN, Cielo) are Task 36.
//
// Candidate set, per chain:
//   - ~30 GOOD candidates: the chain's highest-walletScore wallets, excluding
//     any wallet this file also selects as "poisoned" below. Claimed figures
//     are DERIVED deterministically from each wallet's own walletScore (a
//     higher score => higher claimed pnl/winRate/tradeCount/roi), never from
//     Math.random() — same wallet, same score, same claimed figures, always.
//   - 5 POISONED candidates, each shaped so a scammy source's own claim looks
//     good (Task 34 binding decision 2's "the poisoned entries carry
//     plausible claimed figures ... validation, not the claim, must reject
//     them"), while the *reason* it must be rejected lives elsewhere:
//       - 2 router/CEX addresses: the mock world's graph-demo registry-tagged
//         counterparties (cexCounterparty/routerCounterparty) — Task 35's
//         validation rejects these via AddressRegistry lookup, not the claim.
//       - 2 possible_bot wallets: real WalletLabel='possible_bot' wallets
//         from the world's noise cohort — Task 35 rejects these via
//         WalletClassification/bot-label lookup, not the claim.
//       - 1 below-threshold wallet: a real, non-poisoned-by-label wallet
//         whose claimed figures are DELIBERATELY held under the
//         profitableWallet.pnl30d floor (claimedPnlUsd < 4000) — this ONE
//         entry is designed to fail on the claim itself, unlike the other 4.
//
// getPoisonedAddresses(world, chain) exports the exact address sets so Task
// 35's validation-pipeline tests can assert each one is rejected, with the
// correct rejection reason, without re-deriving the selection logic.

import type { Chain, WalletLabel } from '@flowradar/core';
import type { CandidateSourceProvider, ExternalCandidate, FetchCandidatesOpts } from './types';
import type { MockWallet, MockWorld } from '../mock/world';

const GOOD_CANDIDATE_COUNT = 30;
const SMART_LABELS: WalletLabel[] = ['smart_money', 'whale', 'human_like'];

export interface PoisonedAddresses {
  /** 2 addresses tagged ROUTER/CEX via the mock world's registry-tagged counterparties. */
  routerOrCex: string[];
  /** 2 addresses labeled possible_bot in the mock world. */
  possibleBot: string[];
  /** 1 address whose claimed figures are deliberately below the profitableWallet thresholds (claimedPnl < 4000). */
  belowThreshold: string[];
}

/**
 * Deterministic address sets used to build the poisoned entries for `chain`.
 * BSC has no graph-demo cex/router counterparties in the mock world (those
 * are SOLANA-only scenario wallets), so routerOrCex is empty for BSC and the
 * possible_bot/belowThreshold picks fall back to that chain's own noise pool
 * where available. Stable across calls for the same world (no rng draws —
 * pure selection over world.wallets, which is itself already deterministic).
 */
export function getPoisonedAddresses(world: MockWorld, chain: Chain): PoisonedAddresses {
  const chainWallets = world.wallets.filter((w) => w.chain === chain);

  const routerOrCex: string[] = [];
  if (chain === 'SOLANA') {
    routerOrCex.push(world.meta.scenarios.graphDemo.cexCounterparty, world.meta.scenarios.graphDemo.routerCounterparty);
  }

  const possibleBotPool = chainWallets
    .filter((w) => w.labels.includes('possible_bot'))
    .sort((a, b) => a.address.localeCompare(b.address));
  const possibleBot = possibleBotPool.slice(0, 2).map((w) => w.address);

  // The below-threshold pick is a real, otherwise-unremarkable wallet (not
  // smart-labeled, not a router/cex/bot pick above) — sorted deterministically
  // by address so the same world always picks the same one.
  const usedAddresses = new Set([...routerOrCex, ...possibleBot]);
  const belowThresholdPool = chainWallets
    .filter((w) => !usedAddresses.has(w.address) && !w.labels.includes('possible_bot'))
    .sort((a, b) => a.address.localeCompare(b.address));
  const belowThreshold = belowThresholdPool.slice(0, 1).map((w) => w.address);

  return { routerOrCex, possibleBot, belowThreshold };
}

/**
 * Derives plausible-but-fully-deterministic claimed figures from a
 * MockWallet's own walletScore (0-100). Higher score => higher claimed
 * pnl/winRate/tradeCount/roi. No Math.random()/Date.now() — same input,
 * same output, always.
 */
function claimedFiguresFor(wallet: MockWallet): {
  claimedPnlUsd: number;
  claimedWinRate: number;
  claimedTradeCount: number;
  claimedRoi: number;
} {
  const s = wallet.walletScore / 100; // 0..1
  return {
    claimedPnlUsd: Math.round(3000 + s * 97000), // 3k-100k
    claimedWinRate: Math.round((0.3 + s * 0.5) * 1000) / 1000, // 0.30-0.80
    claimedTradeCount: Math.round(8 + s * 92), // 8-100
    claimedRoi: Math.round((0.5 + s * 4.5) * 100) / 100 // 0.5x-5x
  };
}

/** Over-claims a wallet's figures on top of claimedFiguresFor — used for the poisoned router/CEX and possible_bot entries (Task 34 binding decision 2: "a scammy source would over-claim"). */
function overClaimedFiguresFor(wallet: MockWallet): {
  claimedPnlUsd: number;
  claimedWinRate: number;
  claimedTradeCount: number;
  claimedRoi: number;
} {
  return {
    claimedPnlUsd: Math.round(15000 + (wallet.walletScore / 100) * 85000), // 15k-100k, always clears the 4k floor
    claimedWinRate: 0.55,
    claimedTradeCount: 25,
    claimedRoi: 3.2
  };
}

export class MockCandidateSource implements CandidateSourceProvider {
  readonly name = 'mock';
  readonly chains: Chain[] = ['SOLANA', 'BSC'];
  private readonly world: MockWorld;

  constructor(world: MockWorld) {
    this.world = world;
  }

  async fetchCandidates(chain: Chain, opts: FetchCandidatesOpts = {}): Promise<ExternalCandidate[]> {
    const poisoned = getPoisonedAddresses(this.world, chain);
    const poisonedAddresses = new Set([...poisoned.routerOrCex, ...poisoned.possibleBot, ...poisoned.belowThreshold]);

    const chainWallets = this.world.wallets.filter((w) => w.chain === chain);
    const walletsByAddress = new Map(chainWallets.map((w) => [w.address, w]));

    // GOOD candidates: top-N by walletScore, excluding poisoned addresses,
    // stable-sorted (walletScore desc, address asc as a tiebreaker) so
    // ordering never depends on Map/array iteration order alone.
    const goodPool = chainWallets
      .filter((w) => !poisonedAddresses.has(w.address))
      .sort((a, b) => b.walletScore - a.walletScore || a.address.localeCompare(b.address))
      .slice(0, GOOD_CANDIDATE_COUNT);

    const candidates: ExternalCandidate[] = [];
    let rank = 1;

    for (const wallet of goodPool) {
      const claimed = claimedFiguresFor(wallet);
      candidates.push({
        walletAddress: wallet.address,
        chain,
        sourceRank: rank++,
        ...claimed,
        metadata: { poisoned: false, labels: wallet.labels }
      });
    }

    // Poisoned entries appended after the good leaderboard, each carrying a
    // sourceRank continuing the sequence (a real leaderboard would rank them
    // somewhere too — a scammy source doesn't hide them at the bottom).
    for (const address of [...poisoned.routerOrCex, ...poisoned.possibleBot]) {
      const wallet = walletsByAddress.get(address);
      if (!wallet) continue;
      const claimed = overClaimedFiguresFor(wallet);
      candidates.push({
        walletAddress: address,
        chain,
        sourceRank: rank++,
        ...claimed,
        metadata: { poisoned: true, poisonReason: poisoned.routerOrCex.includes(address) ? 'router_or_cex' : 'possible_bot', labels: wallet.labels }
      });
    }

    for (const address of poisoned.belowThreshold) {
      const wallet = walletsByAddress.get(address);
      if (!wallet) continue;
      candidates.push({
        walletAddress: address,
        chain,
        sourceRank: rank++,
        claimedPnlUsd: 1200, // deliberately < profitableWallet.pnl30d (4000)
        claimedWinRate: 0.4,
        claimedTradeCount: 10,
        claimedRoi: 0.3,
        metadata: { poisoned: true, poisonReason: 'below_threshold', labels: wallet.labels }
      });
    }

    const limit = opts.limit ?? candidates.length;
    return candidates.slice(0, limit);
  }
}

// Re-exported so callers importing only mockSource.ts can reference the smart
// label pool this module conceptually aligns "good" candidates with (kept
// for documentation/consistency with MockProvider.getCandidateWallets, which
// filters on the same SMART_LABELS — MockCandidateSource itself ranks by raw
// walletScore rather than label membership, since real external sources rank
// by claimed PnL, not by our own internal label taxonomy).
export { SMART_LABELS };
