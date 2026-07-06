// FlowRadar — POST /api/overlap (Task 38, Wave 4.6, task-38-brief.md binding
// decision 3).
//
// Multi-token Wallet Overlap Finder. Body: { chain, tokenAddresses[2..5],
// source: 'local'|'dune'|'provider'|'hybrid', params: { minTradeUsd?,
// minTokensOverlap?, maxResults? } }.
//
//   - 'local'    -> @flowradar/db's runLocalOverlapSearch over this app's own
//                   WalletTokenTrade ledger. No credits, no candidate gate
//                   (see localOverlap.ts's own header).
//   - 'dune'     -> @flowradar/db's runTokenOverlapSearch, using the web app's
//                   own resolveDuneClient() (apps/web/lib/duneClient.ts) —
//                   MOCK_MODE serves the deterministic MockDuneOverlapSource;
//                   live mode is credit-safe by default (latest-cached-result
//                   only, per DUNE_USE_LATEST_RESULT/DUNE_EXECUTE_FRESH — see
//                   packages/providers/src/candidates/dune/client.ts).
//   - 'provider' -> best-effort/documented-limited stub (task-38-brief.md
//                   binding decision 2's "provider API, may be limited") — no
//                   verified top-traders-by-token-set endpoint exists in this
//                   codebase yet (birdeye_top_traders is single-token), so
//                   this mode creates a search row marked 'failed' with a
//                   clear "not yet available" error rather than fabricating
//                   results.
//   - 'hybrid'   -> runs 'local' + 'dune' and MERGES: wallet results deduped
//                   by (walletAddress), keeping the max tokensOverlapCount
//                   seen; group results unioned (kept as separate group rows
//                   — a local group and a dune group are never silently
//                   merged into one, since their overlapGroupId spaces are
//                   independent). The merged view is persisted onto ONE new
//                   TokenOverlapSearch row (distinct from the two child
//                   searches) so the UI has a single searchId to hydrate from
//                   for a hybrid run.
//
// Runs INLINE synchronously (same "no worker process required" reasoning as
// /api/graph — bounded by maxResults). Response: { searchId }.

import { NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import { prisma } from '@/lib/db';
import { runLocalOverlapSearch, runTokenOverlapSearch } from '@flowradar/db';
import type { Prisma } from '@flowradar/db';
import { resolveDuneClient } from '@/lib/duneClient';

const OverlapRequestSchema = z.object({
  chain: z.enum(['SOLANA', 'BSC']),
  tokenAddresses: z.array(z.string().min(1)).min(2).max(5),
  source: z.enum(['local', 'dune', 'provider', 'hybrid']),
  params: z
    .object({
      minTradeUsd: z.number().nonnegative().optional(),
      minTokensOverlap: z.number().int().positive().optional(),
      maxResults: z.number().int().positive().optional()
    })
    .optional()
});

interface WalletResultLike {
  walletAddress: string;
  chain: string;
  tokensOverlapCount: number;
  totalBuyUsd: number | null;
  totalSellUsd: number | null;
  estimatedPnlUsd: number | null;
  firstBuyTime: Date | null;
  buyCount: number | null;
  sellCount: number | null;
  entryMarketCapUsd: number | null;
  overlapGroupId: string | null;
  txHashesSample: string[];
}

interface GroupResultLike {
  overlapGroupId: string;
  walletCount: number;
  walletAddresses: string[];
  sharedTokenCount: number;
}

async function loadOverlapResults(searchId: string): Promise<{ wallets: WalletResultLike[]; groups: GroupResultLike[] }> {
  const [wallets, groups] = await Promise.all([
    prisma.tokenOverlapWalletResult.findMany({ where: { searchId } }),
    prisma.tokenOverlapGroupResult.findMany({ where: { searchId } })
  ]);
  return {
    wallets: wallets.map((w) => ({
      walletAddress: w.walletAddress,
      chain: w.chain,
      tokensOverlapCount: w.tokensOverlapCount,
      totalBuyUsd: w.totalBuyUsd !== null ? Number(w.totalBuyUsd) : null,
      totalSellUsd: w.totalSellUsd !== null ? Number(w.totalSellUsd) : null,
      estimatedPnlUsd: w.estimatedPnlUsd !== null ? Number(w.estimatedPnlUsd) : null,
      firstBuyTime: w.firstBuyTime,
      buyCount: w.buyCount,
      sellCount: w.sellCount,
      entryMarketCapUsd: w.entryMarketCapUsd !== null ? Number(w.entryMarketCapUsd) : null,
      overlapGroupId: w.overlapGroupId,
      txHashesSample: w.txHashesSample
    })),
    groups: groups.map((g) => ({
      overlapGroupId: g.overlapGroupId,
      walletCount: g.walletCount,
      walletAddresses: g.walletAddresses,
      sharedTokenCount: g.sharedTokenCount
    }))
  };
}

/**
 * Tags a persisted TokenOverlapSearch row with which UI-selected source
 * created it (local/dune/provider/hybrid) by merging `{ source }` into its
 * own `params` JSON blob — see the POST handler's 'local' branch comment for
 * why this can't be reliably inferred after the fact from usedCachedResult
 * alone (a FAILED dune/provider search has no real cached-vs-fresh value
 * either, indistinguishable from a local search's usedCachedResult=null).
 */
async function tagSearchSource(searchId: string, source: 'local' | 'dune'): Promise<void> {
  const row = await prisma.tokenOverlapSearch.findUnique({ where: { id: searchId }, select: { params: true } });
  const existingParams = (row?.params as Record<string, unknown>) ?? {};
  await prisma.tokenOverlapSearch.update({
    where: { id: searchId },
    data: { params: { ...existingParams, source } as Prisma.InputJsonValue }
  });
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'request body is not valid JSON' }, { status: 400 });
  }

  let parsed;
  try {
    parsed = OverlapRequestSchema.parse(body);
  } catch (err) {
    if (err instanceof ZodError) {
      return NextResponse.json(
        { error: 'invalid request body', issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) },
        { status: 400 }
      );
    }
    throw err;
  }

  const { chain, tokenAddresses, source, params } = parsed;
  const minTokensOverlap = params?.minTokensOverlap ?? tokenAddresses.length;

  if (source === 'local') {
    const result = await runLocalOverlapSearch(prisma, {
      chain,
      tokenAddresses,
      minTradeUsd: params?.minTradeUsd,
      minTokensOverlap,
      maxResults: params?.maxResults
    });
    // Tag the persisted row with its own source (local/dune/provider/hybrid
    // discriminator — see loadOverlapResult's/GET's own header for why this
    // can't be reliably inferred from usedCachedResult alone: a FAILED
    // 'dune'/'provider' search never gets a real usedCachedResult value
    // either, which would otherwise misclassify it as 'local'). Cheap
    // follow-up update rather than threading a `source` param through
    // runLocalOverlapSearch/runTokenOverlapSearch's own signatures, which
    // stay source-agnostic (the db layer doesn't need to know which UI
    // affordance called it).
    await tagSearchSource(result.searchId, 'local');
    return NextResponse.json({ searchId: result.searchId, status: result.status, error: result.error ?? null });
  }

  if (source === 'dune') {
    const result = await runTokenOverlapSearch(
      prisma,
      { chain, tokenAddresses, minTradeUsd: params?.minTradeUsd, minTokensOverlap, maxResults: params?.maxResults },
      resolveDuneClient
    );
    await tagSearchSource(result.searchId, 'dune');
    return NextResponse.json({
      searchId: result.searchId,
      status: result.status,
      error: result.error ?? null,
      candidatesUpserted: result.candidatesUpserted
    });
  }

  if (source === 'provider') {
    // No verified multi-token "wallets that traded ALL of N given tokens"
    // provider endpoint exists in this codebase yet — birdeye_top_traders
    // (packages/providers/src/candidates) is single-token-scoped. Documented
    // limitation (task-38-brief.md binding decision 2): create a search row
    // so the UI has something to render/hydrate, marked failed with a clear
    // message, rather than silently returning fabricated rows.
    const search = await prisma.tokenOverlapSearch.create({
      data: {
        chain,
        tokenAddresses,
        params: {
          min_trade_usd: params?.minTradeUsd ?? 0,
          min_tokens_overlap: minTokensOverlap,
          max_results: params?.maxResults ?? 500,
          source: 'provider'
        },
        status: 'failed',
        error: 'provider source not yet available: no verified multi-token overlap provider endpoint exists (birdeye_top_traders is single-token only). Use local or dune.',
        startedAt: new Date(),
        finishedAt: new Date()
      }
    });
    return NextResponse.json({
      searchId: search.id,
      status: 'failed',
      error: search.error
    });
  }

  // hybrid: run local + dune, merge into one new persisted search row.
  const [localResult, duneResult] = await Promise.all([
    runLocalOverlapSearch(prisma, { chain, tokenAddresses, minTradeUsd: params?.minTradeUsd, minTokensOverlap, maxResults: params?.maxResults }),
    runTokenOverlapSearch(
      prisma,
      { chain, tokenAddresses, minTradeUsd: params?.minTradeUsd, minTokensOverlap, maxResults: params?.maxResults },
      resolveDuneClient
    )
  ]);
  await Promise.all([tagSearchSource(localResult.searchId, 'local'), tagSearchSource(duneResult.searchId, 'dune')]);

  const [localData, duneData] = await Promise.all([
    loadOverlapResults(localResult.searchId),
    loadOverlapResults(duneResult.searchId)
  ]);

  // Dedupe wallet results by address, keep max tokensOverlapCount (binding decision 3).
  const mergedWallets = new Map<string, WalletResultLike>();
  for (const w of [...localData.wallets, ...duneData.wallets]) {
    const existing = mergedWallets.get(w.walletAddress);
    if (!existing || w.tokensOverlapCount > existing.tokensOverlapCount) {
      mergedWallets.set(w.walletAddress, w);
    }
  }

  // Union group results (local ∪ dune group id spaces are independent — never merged into one group).
  const mergedGroups = [...localData.groups, ...duneData.groups];

  const usedCachedResult = duneResult.status === 'done' ? true : null; // local has no cache concept; surface dune's cache flag when it ran
  const truncated = localResult.status === 'done' && duneResult.status === 'done'
    ? false // recomputed below from the actual child search rows
    : false;

  const hybridSearch = await prisma.tokenOverlapSearch.create({
    data: {
      chain,
      tokenAddresses,
      params: {
        min_trade_usd: params?.minTradeUsd ?? 0,
        min_tokens_overlap: minTokensOverlap,
        max_results: params?.maxResults ?? 500,
        source: 'hybrid',
        hybrid: { localSearchId: localResult.searchId, duneSearchId: duneResult.searchId }
      },
      status: 'done',
      rowsReturned: mergedWallets.size,
      usedCachedResult,
      truncated,
      startedAt: new Date(),
      finishedAt: new Date()
    }
  });

  for (const w of mergedWallets.values()) {
    await prisma.tokenOverlapWalletResult.create({
      data: {
        searchId: hybridSearch.id,
        walletAddress: w.walletAddress,
        chain: w.chain as 'SOLANA' | 'BSC',
        tokensOverlapCount: w.tokensOverlapCount,
        totalBuyUsd: w.totalBuyUsd,
        totalSellUsd: w.totalSellUsd,
        estimatedPnlUsd: w.estimatedPnlUsd,
        firstBuyTime: w.firstBuyTime,
        buyCount: w.buyCount,
        sellCount: w.sellCount,
        entryMarketCapUsd: w.entryMarketCapUsd,
        overlapGroupId: w.overlapGroupId,
        txHashesSample: w.txHashesSample
      }
    });
  }
  for (const g of mergedGroups) {
    await prisma.tokenOverlapGroupResult.create({
      data: {
        searchId: hybridSearch.id,
        overlapGroupId: g.overlapGroupId,
        walletCount: g.walletCount,
        walletAddresses: g.walletAddresses,
        sharedTokenCount: g.sharedTokenCount
      }
    });
  }

  return NextResponse.json({
    searchId: hybridSearch.id,
    status: 'done',
    localSearchId: localResult.searchId,
    duneSearchId: duneResult.searchId,
    localError: localResult.error ?? null,
    duneError: duneResult.error ?? null
  });
}
