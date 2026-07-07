// FlowRadar — walletActivity job (Task 5 brief decision 3).
//
// For every Wallet worth polling (isWatched=true OR it already has at least
// one WalletStats row), fetches new provider activity since the last
// recorded cursor, ingests it via @flowradar/db's ingestNormalizedTxs, and
// advances the cursor. Per-wallet failures are caught and recorded on
// ProviderSyncState (lastError/failCount) rather than rethrown — one
// wallet's provider error never aborts the whole job run or the runner's
// scheduled tick for other wallets.

import { ingestNormalizedTxs } from '@flowradar/db';
import { isRateLimitError } from '@flowradar/providers';
import type { Chain, NormalizedTx } from '@flowradar/core';
import type { JobContext } from '../context';

const PROVIDER_NAME = 'mock';
const PAGE_LIMIT = 500;

export async function run(ctx: JobContext): Promise<void> {
  const { prisma, providers, log } = ctx;

  const wallets = await prisma.wallet.findMany({
    where: {
      OR: [{ isWatched: true }, { stats: { some: {} } }]
    },
    select: { id: true, address: true, chain: true }
  });

  let totalIngestedTxs = 0;
  let walletsWithErrors = 0;
  let walletsRateLimited = 0;

  // Sequential by design: each wallet is awaited before the next, so the
  // provider's shared rate limiter (one instance per cached provider) meters
  // the whole cycle rather than a burst of concurrent calls. A single wallet's
  // provider error — including a provider throttle (429) that survived the
  // adapter's own backoff/retries — is caught and recorded per-wallet, never
  // rethrown, so it can't abort the rest of the cycle.
  for (const wallet of wallets) {
    try {
      const ingestedCount = await pollAndIngestWallet(ctx, wallet.address, wallet.chain);
      totalIngestedTxs += ingestedCount;
    } catch (err) {
      walletsWithErrors += 1;
      const rateLimited = isRateLimitError(err);
      if (rateLimited) walletsRateLimited += 1;
      await recordSyncFailure(prisma, wallet.chain, wallet.address, err);
      log.error(`walletActivity: failed to poll wallet ${wallet.address}`, {
        chain: wallet.chain,
        // Honest classification: a provider throttle is rate_limited, not an
        // auth_error or unknown failure (live-validation finding 2026-07-07).
        kind: rateLimited ? 'rate_limited' : 'provider_error',
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  log.info('walletActivity cycle complete', {
    walletsPolled: wallets.length,
    txsIngested: totalIngestedTxs,
    walletsWithErrors,
    walletsRateLimited
  });
}

async function pollAndIngestWallet(ctx: JobContext, address: string, chain: Chain): Promise<number> {
  const { prisma, providers } = ctx;

  const syncState = await prisma.providerSyncState.findUnique({
    where: { provider_chain_scope: { provider: PROVIDER_NAME, chain, scope: address } }
  });
  const since = syncState?.cursor ? new Date(syncState.cursor) : undefined;

  const activityProvider = providers(chain, 'walletActivity');

  const allTxs: NormalizedTx[] = [];
  let cursor: string | undefined;
  for (;;) {
    const result = await activityProvider.getWalletTransactions(chain, address, {
      since,
      cursor,
      limit: PAGE_LIMIT
    });
    allTxs.push(...result.txs);
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }

  if (allTxs.length > 0) {
    await ingestNormalizedTxs(prisma, chain, address, allTxs);
  }

  const latestTs = allTxs.reduce<Date | null>((latest, tx) => {
    if (!latest || tx.ts.getTime() > latest.getTime()) return tx.ts;
    return latest;
  }, null);

  // MockProvider's `since` filter is inclusive (tx.ts >= since), so storing
  // the latest-seen tx's own timestamp verbatim would re-fetch that exact tx
  // again on the very next poll forever (harmless — ingest dedupes — but
  // wastefully re-processes the same tail of txs every cycle). Advancing by
  // 1ms past the latest-seen timestamp makes the next poll's `since` cleanly
  // exclusive of everything already processed.
  const nextCursor = latestTs ? new Date(latestTs.getTime() + 1).toISOString() : (syncState?.cursor ?? null);

  await prisma.providerSyncState.upsert({
    where: { provider_chain_scope: { provider: PROVIDER_NAME, chain, scope: address } },
    create: {
      provider: PROVIDER_NAME,
      chain,
      scope: address,
      cursor: nextCursor,
      lastSyncAt: new Date(),
      lastError: null,
      failCount: 0
    },
    update: {
      cursor: nextCursor,
      lastSyncAt: new Date(),
      lastError: null,
      failCount: 0
    }
  });

  return allTxs.length;
}

async function recordSyncFailure(prisma: JobContext['prisma'], chain: Chain, address: string, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  await prisma.providerSyncState.upsert({
    where: { provider_chain_scope: { provider: PROVIDER_NAME, chain, scope: address } },
    create: {
      provider: PROVIDER_NAME,
      chain,
      scope: address,
      lastError: message,
      failCount: 1
    },
    update: {
      lastError: message,
      failCount: { increment: 1 }
    }
  });
}
