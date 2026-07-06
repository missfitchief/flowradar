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
  /** Wallets THIS search actually newly created as candidates (candidatesCreated). */
  candidatesAddedCount: number;
  /** Total overlap wallets from this search that are (now) in the candidate pool, new or pre-existing. */
  candidatesMatchedCount: number;
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
  /** Newly-created-by-this-search candidate count (null for local/rows predating this column). */
  candidatesCreated: number | null;
  /** Total overlap wallets from this search now in the candidate pool (new + pre-existing). */
  candidatesMatched: number;
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

  // Task 38 fix: "added as candidates" must report only wallets THIS search
  // actually newly CREATED (search.candidatesCreated, set at run time by
  // runTokenOverlapSearch) — not every overlap wallet that happens to
  // already be a dune_token_overlap candidate from some earlier search.
  // Local overlap never creates candidates itself (see localOverlap.ts's
  // header), so a local search always reports 0. candidatesMatched (the
  // total pool count) is surfaced separately, never used for "newly added".
  const candidatesAddedCount = source === 'local' ? 0 : (body.search.candidatesCreated ?? 0);
  const candidatesMatchedCount = source === 'local' ? 0 : body.search.candidatesMatched;

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
    candidatesMatchedCount,
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

          {/* TODO(minor, Task 38 review): 'overlap_finder_ad_hoc' duplicates
              packages/db/src/dune/duneOverlap.ts's DEFAULT_QUERY_ID_PLACEHOLDER
              literal. It's genuinely not a per-search value in this codebase
              today (every dune overlap search uses the same ad-hoc query id,
              not a real per-search Dune query id), so threading it through the
              API response would just carry the same constant string — not
              worth a response-shape change for this pass. If a real per-search
              queryId is ever introduced, thread it through instead of
              re-declaring this literal here. */}
          <CoverageBanner
            source={result.source}
            queryId={result.source === 'local' ? null : 'overlap_finder_ad_hoc'}
            lastRunAgeLabel={result.finishedAtIso ? `${fmtAge(new Date(result.finishedAtIso))} ago` : null}
            rowsReturned={result.rowsReturned}
            usedCachedResult={result.usedCachedResult}
            truncated={result.truncated}
            maxResults={result.maxResults}
            candidatesAddedCount={result.candidatesAddedCount}
            candidatesMatchedCount={result.candidatesMatchedCount}
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
