import Link from 'next/link';
import { prisma } from '@/lib/db';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { GraphExplorer } from '@/components/graph/GraphExplorer';
import type { GraphResultData } from '@/components/graph/GraphExplorer';
import { fmtAge, shortAddr } from '@/lib/format';

// DB-backed dashboard — must render per-request, never freeze at build time
// (same invariant every other DB page in this app follows).
export const dynamic = 'force-dynamic';

interface WalletGraphPageProps {
  searchParams: Promise<{ search?: string }>;
}

const RECENT_SEARCHES_LIMIT = 10;

const STATUS_BADGE_CLASS: Record<string, string> = {
  queued: 'border-transparent bg-zinc-500/15 text-zinc-300',
  running: 'border-transparent bg-sky-500/15 text-sky-300',
  done: 'border-transparent bg-emerald-500/15 text-emerald-300',
  failed: 'border-transparent bg-red-500/15 text-red-400',
  truncated: 'border-transparent bg-amber-500/15 text-amber-300',
};

/**
 * Loads a WalletGraphSearch by id plus its nodes/edges/resultSummary,
 * shaped identically to GET /api/graph/[id]'s response (Decimal->Number,
 * Date->ISO string at this server boundary — binding decision 9 — so the
 * client component tree never sees a Prisma.Decimal or Date).
 */
async function loadGraphResult(searchId: string): Promise<GraphResultData | null> {
  const search = await prisma.walletGraphSearch.findUnique({
    where: { id: searchId },
    include: { nodes: true, edges: true },
  });
  if (!search) return null;

  const summary = (search.resultSummary ?? { paths: [] }) as unknown as { paths: GraphResultData['paths'] };

  return {
    searchId: search.id,
    status: search.status,
    rootAddress: search.rootAddress,
    nodes: search.nodes.map((n) => ({
      address: n.address,
      depth: n.depth,
      nodeType: n.nodeType,
      totalSentUsd: Number(n.totalSentUsd),
      totalReceivedUsd: Number(n.totalReceivedUsd),
      netFlowUsd: Number(n.netFlowUsd),
      interactionCount: n.interactionCount,
      firstSeen: n.firstSeen.toISOString(),
      lastSeen: n.lastSeen.toISOString(),
      tags: n.tags,
      confidence: n.confidence,
    })),
    edges: search.edges.map((e) => ({
      sourceAddress: e.sourceAddress,
      destAddress: e.destAddress,
      relationship: e.relationship,
      totalUsd: Number(e.totalUsd),
      txCount: e.txCount,
    })),
    paths: summary.paths ?? [],
  };
}

/**
 * Wallet Graph Finder (Task 21). Server shell: renders the client
 * GraphExplorer tool plus a "recent searches" list of WalletGraphSearch rows
 * (binding decision 2), each linking to `?search=<id>` so clicking one
 * rehydrates that search's graph/tables without re-running it (binding
 * decision 8).
 */
export default async function WalletGraphPage({ searchParams }: WalletGraphPageProps) {
  const { search: searchIdParam } = await searchParams;

  const [recentSearches, initialResult] = await Promise.all([
    prisma.walletGraphSearch.findMany({
      orderBy: { id: 'desc' },
      take: RECENT_SEARCHES_LIMIT,
    }),
    searchIdParam ? loadGraphResult(searchIdParam) : Promise.resolve(null),
  ]);

  // Explorer URL template for whichever chain the currently-loaded search
  // (or, absent that, the most recent search) belongs to — best-effort only,
  // used purely for the "view on explorer" links in the canvas/table.
  const explorerChainId = initialResult
    ? recentSearches.find((s) => s.id === initialResult.searchId)?.chain
    : recentSearches[0]?.chain;
  const explorerChain = explorerChainId ? await prisma.chain.findUnique({ where: { id: explorerChainId } }) : null;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Wallet Graph</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Trace a wallet&apos;s fund flow across hops — direct transfers, swaps, bridges, and CEX deposits.
        </p>
      </div>

      <GraphExplorer initialResult={initialResult} explorerAddressUrlTemplate={explorerChain?.explorerAddressUrl ?? null} />

      <Card>
        <CardHeader>
          <CardTitle>Recent searches</CardTitle>
        </CardHeader>
        <CardContent>
          {recentSearches.length === 0 ? (
            <p className="text-sm text-muted-foreground">No graph searches yet.</p>
          ) : (
            <div className="flex flex-col divide-y divide-border">
              {recentSearches.map((s) => (
                <Link
                  key={s.id}
                  href={`/graph?search=${s.id}`}
                  className="flex flex-wrap items-center gap-3 py-2 text-sm hover:bg-muted/50"
                >
                  <code className="text-xs text-muted-foreground">{shortAddr(s.rootAddress)}</code>
                  <Badge variant="secondary">{s.chain}</Badge>
                  <Badge variant="outline">{s.mode}</Badge>
                  <Badge className={STATUS_BADGE_CLASS[s.status] ?? STATUS_BADGE_CLASS.queued}>{s.status}</Badge>
                  <span className="text-xs text-muted-foreground">
                    {s.nodeCount} nodes · {s.edgeCount} edges
                  </span>
                  {s.finishedAt && (
                    <span className="ml-auto text-xs text-muted-foreground">{fmtAge(s.finishedAt)} ago</span>
                  )}
                </Link>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
