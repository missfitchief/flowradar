// FlowRadar — MockTokenTopTradersProvider: deterministic per-token top-trader
// leaderboard derived from the mock world (Task 35, Wave 4.5, Spec §5b). This
// is what `tokenTopTraderBackfill` resolves to in MOCK_MODE — a live Birdeye
// adapter (source name `birdeye_top_traders`) is a later task.
//
// getTopTraders(chain, tokenAddress) scans the mock world's txsByWallet for
// swap_leg BUY transactions on `tokenAddress` (the exact same "to === buyer,
// asset.address === token.address" convention packages/db/src/ingest.ts's
// ingestSwapLeg uses to derive a BUY trade — see that file's header),
// aggregates each buyer's total buy USD, and ranks buyers by that total
// descending (a real top-traders endpoint ranks by realized PnL; this mock
// stands in with total buy volume as a deterministic, derivable proxy — the
// claimed `pnlUsd` field itself is derived from the buyer's own walletScore,
// same "claim is never trusted, only used for ranking/cross-check" contract
// as MockCandidateSource's claimedFiguresFor).

import type { Chain } from '@flowradar/core';
import type { GetTopTradersOpts, TokenTopTrader, TokenTopTradersProvider } from './types';
import type { MockWorld } from '../mock/world';

const DEFAULT_LIMIT = 20;

export class MockTokenTopTradersProvider implements TokenTopTradersProvider {
  private readonly world: MockWorld;

  constructor(world: MockWorld) {
    this.world = world;
  }

  async getTopTraders(chain: Chain, tokenAddress: string, opts: GetTopTradersOpts = {}): Promise<TokenTopTrader[]> {
    const limit = opts.limit ?? DEFAULT_LIMIT;
    const walletsByAddress = new Map(this.world.wallets.filter((w) => w.chain === chain).map((w) => [w.address, w]));

    const buyTotalByWallet = new Map<string, number>();

    for (const [walletAddress, txs] of this.world.txsByWallet) {
      const wallet = walletsByAddress.get(walletAddress);
      if (!wallet) continue; // wrong chain, or not a wallet this provider knows about

      for (const tx of txs) {
        for (const leg of tx.legs) {
          if (leg.kind !== 'swap_leg') continue;
          if (leg.asset.address !== tokenAddress) continue;
          if (leg.to !== walletAddress) continue; // BUY convention: token flows TO the buyer

          const amountUsd = leg.amountUsd ?? 0;
          buyTotalByWallet.set(walletAddress, (buyTotalByWallet.get(walletAddress) ?? 0) + amountUsd);
        }
      }
    }

    const ranked = [...buyTotalByWallet.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, limit);

    return ranked.map(([walletAddress, totalBuyUsd]) => {
      const wallet = walletsByAddress.get(walletAddress)!;
      const s = wallet.walletScore / 100;
      return {
        walletAddress,
        chain,
        pnlUsd: Math.round(totalBuyUsd * (0.1 + s * 0.4)), // plausible-but-derived claim, never trusted at face value
        winRate: Math.round((0.3 + s * 0.5) * 1000) / 1000,
        tradeCount: Math.round(8 + s * 40)
      };
    });
  }
}
