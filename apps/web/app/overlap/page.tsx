import Link from 'next/link';
import { prisma } from '@/lib/db';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { OverlapFinder } from '@/components/overlap/OverlapFinder';
import type { OverlapResultData } from '@/components/overlap/OverlapFinder';
import type { OverlapSourceKind } from '@/components/overlap/CoverageBanner';
import { fmtAge, shortAddr } from '@/lib/format';

// DB-backed dashboard — must render per-request, never freeze at build time
// (same invariant every other DB page in this app follows).
export const dynamic = 'force-dynamic';

interface OverlapPageProps {
  searchParams: Promise<{ search?: string }>;
}

const RECENT_SEARCHES_LIMIT = 10;

const STATUS_BADGE_CLASS: Record<string, string> = {
  queued: 'border-transparent bg-zinc-500/15 text-zinc-300',
  running: 'border-transparent bg-sky-500/15 text-sky-300',
  done: 'border-transparent bg-emerald-500/15 text-emerald-300',
  failed: 'border-transparent bg-red-500/15 text-red-400',
};

/**
 * Reads the explicit `source` tag POST /api/overlap stamps onto every
 * TokenOverlapSearch.params it creates (route.ts's tagSearchSource /
 * inline `source: 'provider'|'hybrid'`). Falls back to the OLD
 * usedCachedResult-based heuristic only for rows that predate this tag
 * (e.g. packages/db/src/seed.ts's own runTokenOverlapSearch call, which
 * goes through @flowradar/db directly, not this route) — that heuristic is
 * unreliable for a FAILED dune/provider search (no real cached-vs-fresh
 * value either, indistinguishable from local's usedCachedResult=null), but
 * every row this route itself creates is now tagged and never needs it.
 */
function inferSourceKind(params: unknown, usedCachedResult: boolean | null): OverlapSourceKind {
  const p = params as { source?: OverlapSourceKind; hybrid?: unknown } | null;
  if (p?.source) return p.source;
  if (p?.hybrid) return 'hybrid';
  return usedCachedResult === null ? 'local' : 'dune';
}

/**
 * Loads a TokenOverlapSearch by id plus its wallet/group results, joined
 * against CandidateWallet for pipeline status — same shape GET
 * /api/overlap/[id] returns, computed directly here for the server-rendered
 * initial load (avoids a self-fetch round-trip, same convention as
 * app/graph/page.tsx's loadGraphResult).
 */
async function loadOverlapResult(searchId: string): Promise<OverlapResultData | null> {
  const search = await prisma.tokenOverlapSearch.findUnique({
    where: { id: searchId },
    include: { walletResults: true, groupResults: true },
  });
  if (!search) return null;

  const walletAddresses = search.walletResults.map((w) => w.walletAddress);
  const candidates = walletAddresses.length
    ? await prisma.candidateWallet.findMany({
        where: { walletAddress: { in: walletAddresses }, chain: search.chain },
        select: { walletAddress: true, validationStatus: true, source: true },
      })
    : [];
  const candidateByAddress = new Map<string, { validationStatus: string; source: string }>();
  for (const c of candidates) {
    const existing = candidateByAddress.get(c.walletAddress);
    if (!existing || c.source === 'dune_token_overlap') {
      candidateByAddress.set(c.walletAddress, { validationStatus: c.validationStatus, source: c.source });
    }
  }

  const params = search.params as { max_results?: number; hybrid?: unknown } | null;
  const source = inferSourceKind(search.params, search.usedCachedResult);

  // Task 38 fix: "added as candidates" must report only wallets THIS search
  // actually newly CREATED — search.candidatesCreated, the additive column
  // runTokenOverlapSearch persists at run time (see duneOverlap.ts's own
  // header) — NOT every wallet that happens to already be a
  // dune_token_overlap CandidateWallet from some earlier, overlapping
  // search. That re-derivation (candidateByAddress here reflects CURRENT
  // pool state, not this search's own creation event) is exactly the bug:
  // a repeat search over the same tokens would re-count the whole existing
  // pool as "added". candidatesMatched (current pool membership) is still
  // surfaced separately.
  const candidatesMatched = [...candidateByAddress.values()].filter((c) => c.source === 'dune_token_overlap').length;

  return {
    searchId: search.id,
    source,
    chain: search.chain,
    tokenAddresses: search.tokenAddresses,
    status: search.status,
    searchError: search.error,
    rowsReturned: search.rowsReturned ?? search.walletResults.length,
    usedCachedResult: search.usedCachedResult,
    truncated: Boolean(search.truncated),
    maxResults: params?.max_results ?? 100,
    finishedAtIso: search.finishedAt ? search.finishedAt.toISOString() : null,
    candidatesAddedCount: source === 'local' ? 0 : (search.candidatesCreated ?? 0),
    candidatesMatchedCount: source === 'local' ? 0 : candidatesMatched,
    walletResults: search.walletResults.map((w) => ({
      walletAddress: w.walletAddress,
      chain: w.chain,
      tokensOverlapCount: w.tokensOverlapCount,
      totalBuyUsd: w.totalBuyUsd !== null ? Number(w.totalBuyUsd) : null,
      totalSellUsd: w.totalSellUsd !== null ? Number(w.totalSellUsd) : null,
      estimatedPnlUsd: w.estimatedPnlUsd !== null ? Number(w.estimatedPnlUsd) : null,
      firstBuyTime: w.firstBuyTime ? w.firstBuyTime.toISOString() : null,
      buyCount: w.buyCount,
      sellCount: w.sellCount,
      entryMarketCapUsd: w.entryMarketCapUsd !== null ? Number(w.entryMarketCapUsd) : null,
      overlapGroupId: w.overlapGroupId,
      candidateStatus: (candidateByAddress.get(w.walletAddress)?.validationStatus ?? null) as OverlapResultData['walletResults'][number]['candidateStatus'],
    })),
    groupResults: search.groupResults.map((g) => ({
      overlapGroupId: g.overlapGroupId,
      walletCount: g.walletCount,
      walletAddresses: g.walletAddresses,
      sharedTokenCount: g.sharedTokenCount,
    })),
  };
}

/**
 * Multi-token Wallet Overlap Finder (Task 38, Wave 4.6). Server shell:
 * renders the client OverlapFinder tool plus a "recent searches" list of
 * TokenOverlapSearch rows, each linking to `?search=<id>` so clicking one
 * rehydrates that search's results without re-running it (same pattern as
 * app/graph/page.tsx).
 */
export default async function OverlapPage({ searchParams }: OverlapPageProps) {
  const { search: searchIdParam } = await searchParams;

  const [recentSearches, initialResult] = await Promise.all([
    prisma.tokenOverlapSearch.findMany({
      orderBy: { createdAt: 'desc' },
      take: RECENT_SEARCHES_LIMIT,
    }),
    searchIdParam ? loadOverlapResult(searchIdParam) : Promise.resolve(null),
  ]);

  const explorerChainId = initialResult
    ? recentSearches.find((s) => s.id === initialResult.searchId)?.chain
    : recentSearches[0]?.chain;
  const explorerChain = explorerChainId ? await prisma.chain.findUnique({ where: { id: explorerChainId } }) : null;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Overlap Finder</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Given 2-5 token contract addresses, find wallets that traded multiple (or all) of them — recurring
          profitable co-traders, early buyers, and possible entity clusters.
        </p>
      </div>

      <OverlapFinder initialResult={initialResult} explorerAddressUrlTemplate={explorerChain?.explorerAddressUrl ?? null} />

      <Card>
        <CardHeader>
          <CardTitle>Recent searches</CardTitle>
        </CardHeader>
        <CardContent>
          {recentSearches.length === 0 ? (
            <p className="text-sm text-muted-foreground">No overlap searches yet.</p>
          ) : (
            <div className="flex flex-col divide-y divide-border">
              {recentSearches.map((s) => (
                <Link
                  key={s.id}
                  href={`/overlap?search=${s.id}`}
                  className="flex flex-wrap items-center gap-3 py-2 text-sm hover:bg-muted/50"
                >
                  <span className="text-xs text-muted-foreground">{s.tokenAddresses.map((a) => shortAddr(a)).join(', ')}</span>
                  <Badge variant="secondary">{s.chain}</Badge>
                  <Badge variant="outline">{inferSourceKind(s.params, s.usedCachedResult)}</Badge>
                  <Badge className={STATUS_BADGE_CLASS[s.status] ?? STATUS_BADGE_CLASS.queued}>{s.status}</Badge>
                  {s.rowsReturned !== null && (
                    <span className="text-xs text-muted-foreground">{s.rowsReturned} wallets</span>
                  )}
                  {s.finishedAt && <span className="ml-auto text-xs text-muted-foreground">{fmtAge(s.finishedAt)} ago</span>}
                </Link>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
