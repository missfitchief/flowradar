'use client';

// FlowRadar — Multi-token Wallet Overlap Finder client orchestrator (Task 38,
// Wave 4.6, task-38-brief.md binding decision 1).
//
// Owns: form state handoff to OverlapForm, the POST /api/overlap call (runs
// synchronously inline server-side — same "no polling loop needed, the
// response IS the finished result" reasoning as GraphExplorer), a GET
// /api/overlap/[id] to fetch the full wallet/group results (POST's response
// is just {searchId, status, ...}), and rehydration from an initial search
// passed in by the server shell (app/overlap/page.tsx) when the page loads
// with `?search=<id>` or a recent search is clicked.

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { OverlapForm } from '@/components/overlap/OverlapForm';
import type { OverlapFormParams } from '@/components/overlap/OverlapForm';
import { CoverageBanner } from '@/components/overlap/CoverageBanner';
import type { OverlapSourceKind } from '@/components/overlap/CoverageBanner';
import { OverlapResultsTable } from '@/components/overlap/OverlapResultsTable';
import type { OverlapWalletRow } from '@/components/overlap/OverlapResultsTable';
import { OverlapGroupsTable } from '@/components/overlap/OverlapGroupsTable';
import type { OverlapGroupRow } from '@/components/overlap/OverlapGroupsTable';
import { fmtAge } from '@/lib/format';

export interface OverlapResultData {
  searchId: string;
  source: OverlapSourceKind;
  chain: string;
  tokenAddresses: string[];
  status: string;
  searchError: string | null;
  rowsReturned: number;
  usedCachedResult: boolean | null;
  truncated: boolean;
  maxResults: number;
  finishedAtIso: string | null;
  candidatesAddedCount: number;
  walletResults: OverlapWalletRow[];
  groupResults: OverlapGroupRow[];
}

export interface OverlapFinderProps {
  initialResult?: OverlapResultData | null;
  explorerAddressUrlTemplate?: string | null;
}

type RunState = { status: 'idle' } | { status: 'running' } | { status: 'error'; message: string };

interface ApiSearch {
  id: string;
  chain: string;
  tokenAddresses: string[];
  params: { max_results?: number; hybrid?: { localSearchId: string; duneSearchId: string } };
  status: string;
  error: string | null;
  rowsReturned: number | null;
  usedCachedResult: boolean | null;
  truncated: boolean | null;
  finishedAt: string | null;
}

interface ApiWalletResult {
  walletAddress: string;
  chain: string;
  tokensOverlapCount: number;
  totalBuyUsd: number | null;
  totalSellUsd: number | null;
  estimatedPnlUsd: number | null;
  firstBuyTime: string | null;
  buyCount: number | null;
  sellCount: number | null;
  entryMarketCapUsd: number | null;
  overlapGroupId: string | null;
  candidateStatus: string | null;
  isDuneOverlapCandidate: boolean;
}

interface ApiGroupResult {
  overlapGroupId: string;
  walletCount: number;
  walletAddresses: string[];
  sharedTokenCount: number;
}

interface GetOverlapResponse {
  search: ApiSearch;
  walletResults: ApiWalletResult[];
  groupResults: ApiGroupResult[];
}

async function fetchOverlapResult(searchId: string, source: OverlapSourceKind): Promise<OverlapResultData> {
  const response = await fetch(`/api/overlap/${searchId}`);
  const body = (await response.json()) as GetOverlapResponse & { error?: string };
  if (!response.ok) {
    throw new Error(body.error ?? `failed to load search result (HTTP ${response.status})`);
  }

  // "Added as candidates" only counts wallets THIS overlap pipeline's
  // dune_token_overlap source actually created/upserted — local overlap
  // never creates candidates itself (see localOverlap.ts's header), so a
  // local search reports 0 regardless of any pre-existing candidate rows
  // its wallets may happen to already have from an unrelated source.
  const candidatesAddedCount = source === 'local' ? 0 : body.walletResults.filter((w) => w.isDuneOverlapCandidate).length;

  return {
    searchId: body.search.id,
    source,
    chain: body.search.chain,
    tokenAddresses: body.search.tokenAddresses,
    status: body.search.status,
    searchError: body.search.error,
    rowsReturned: body.search.rowsReturned ?? body.walletResults.length,
    usedCachedResult: body.search.usedCachedResult,
    truncated: Boolean(body.search.truncated),
    maxResults: body.search.params?.max_results ?? 100,
    finishedAtIso: body.search.finishedAt,
    candidatesAddedCount,
    walletResults: body.walletResults.map((w) => ({
      walletAddress: w.walletAddress,
      chain: w.chain,
      tokensOverlapCount: w.tokensOverlapCount,
      totalBuyUsd: w.totalBuyUsd,
      totalSellUsd: w.totalSellUsd,
      estimatedPnlUsd: w.estimatedPnlUsd,
      firstBuyTime: w.firstBuyTime,
      buyCount: w.buyCount,
      sellCount: w.sellCount,
      entryMarketCapUsd: w.entryMarketCapUsd,
      overlapGroupId: w.overlapGroupId,
      candidateStatus: w.candidateStatus as OverlapWalletRow['candidateStatus'],
    })),
    groupResults: body.groupResults,
  };
}

export function OverlapFinder({ initialResult, explorerAddressUrlTemplate }: OverlapFinderProps) {
  const router = useRouter();
  const [result, setResult] = useState<OverlapResultData | null>(initialResult ?? null);
  const [runState, setRunState] = useState<RunState>({ status: 'idle' });
  const [formSeed, setFormSeed] = useState(0);

  async function handleSubmit(params: OverlapFormParams): Promise<void> {
    setRunState({ status: 'running' });
    try {
      const postResponse = await fetch('/api/overlap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chain: params.chain,
          tokenAddresses: params.tokenAddresses,
          source: params.source,
          params: {
            minTradeUsd: params.minTradeUsd,
            minTokensOverlap: params.minTokensOverlap,
            maxResults: params.maxResults,
          },
        }),
      });
      const postBody = await postResponse.json();

      if (!postResponse.ok) {
        const message = Array.isArray(postBody.issues)
          ? postBody.issues.map((i: { path: string; message: string }) => (i.path ? `${i.path}: ${i.message}` : i.message)).join('; ')
          : (postBody.error ?? `search failed (HTTP ${postResponse.status})`);
        setRunState({ status: 'error', message });
        return;
      }

      if (postBody.status === 'failed') {
        setRunState({ status: 'error', message: postBody.error ?? 'overlap search failed' });
        // Still load it so a failed search's CoverageBanner/empty state renders (e.g. the 'provider' stub).
      }

      const searchId = postBody.searchId as string;
      const loaded = await fetchOverlapResult(searchId, params.source);
      setResult(loaded);
      if (postBody.status !== 'failed') setRunState({ status: 'idle' });
      router.push(`/overlap?search=${searchId}`, { scroll: false });
      router.refresh();
    } catch (err) {
      setRunState({ status: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }

  const running = runState.status === 'running';
  const error = runState.status === 'error' ? runState.message : null;

  const initialFormValues: Partial<OverlapFormParams> | undefined = initialResult
    ? {
        chain: initialResult.chain as OverlapFormParams['chain'],
        tokenAddresses: initialResult.tokenAddresses,
        source: initialResult.source === 'hybrid' ? 'hybrid' : initialResult.source,
      }
    : undefined;

  return (
    <div className="flex flex-col gap-6">
      <OverlapForm key={formSeed} initialValues={initialFormValues} running={running} error={error} onSubmit={(p) => void handleSubmit(p)} />

      {result && (
        <>
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-medium tracking-tight">Results</h2>
            <button
              type="button"
              className="text-xs text-muted-foreground hover:underline"
              onClick={() => {
                setResult(null);
                setFormSeed((s) => s + 1);
                router.push('/overlap', { scroll: false });
              }}
            >
              New search
            </button>
          </div>

          {result.status === 'failed' && result.searchError && (
            <p className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-sm text-red-400">
              {result.searchError}
            </p>
          )}

          <CoverageBanner
            source={result.source}
            queryId={result.source === 'local' ? null : 'overlap_finder_ad_hoc'}
            lastRunAgeLabel={result.finishedAtIso ? `${fmtAge(new Date(result.finishedAtIso))} ago` : null}
            rowsReturned={result.rowsReturned}
            usedCachedResult={result.usedCachedResult}
            truncated={result.truncated}
            maxResults={result.maxResults}
            candidatesAddedCount={result.candidatesAddedCount}
          />

          <div>
            <h3 className="mb-3 text-base font-medium tracking-tight">Overlapping wallets</h3>
            <OverlapResultsTable
              rows={result.walletResults}
              tokenCount={result.tokenAddresses.length}
              explorerAddressUrlTemplate={explorerAddressUrlTemplate}
            />
          </div>

          <div>
            <h3 className="mb-3 text-base font-medium tracking-tight">Recurring co-trader groups</h3>
            <OverlapGroupsTable rows={result.groupResults} />
          </div>
        </>
      )}

      {!result && (
        <Card>
          <CardHeader>
            <CardTitle>How it works</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Paste 2-5 token contract addresses to find wallets that traded multiple (or all) of them — recurring
            profitable co-traders, early buyers across tokens, and possible entity clusters. Local DB is free and
            uses only already-ingested trade data; Dune discovers new candidate wallets (pending validation) from an
            external query, credit-safe by default.
          </CardContent>
        </Card>
      )}
    </div>
  );
}
