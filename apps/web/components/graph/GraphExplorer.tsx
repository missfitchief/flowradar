'use client';

// FlowRadar — Wallet Graph Finder client orchestrator (Task 21 binding
// decision 2).
//
// Owns: form state handoff to SearchForm, the POST /api/graph call (which
// runs synchronously inline server-side per Task 20 binding decision 4 — no
// polling loop is needed since the response IS the finished result), a
// second GET /api/graph/[id] to fetch the full nodes/edges/paths payload
// (POST's response is just {searchId, status, nodeCount, edgeCount}), and
// rehydration from an initial search passed in by the server shell
// (app/graph/page.tsx) when the page loads with `?search=<id>` or a recent
// search is clicked (binding decision 8).

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { SearchForm } from '@/components/graph/SearchForm';
import type { GraphSearchFormParams } from '@/components/graph/SearchForm';
import { GraphCanvas } from '@/components/graph/GraphCanvas';
import type { GraphCanvasEdge, GraphCanvasNode } from '@/components/graph/GraphCanvas';
import { ConnectedWalletsTable } from '@/components/graph/ConnectedWalletsTable';
import type { ConnectedWalletRow } from '@/components/graph/ConnectedWalletsTable';
import { PathsTable } from '@/components/graph/PathsTable';
import type { PathRow } from '@/components/graph/PathsTable';

export interface GraphResultData {
  searchId: string;
  status: string;
  rootAddress: string;
  nodes: GraphCanvasNode[];
  edges: GraphCanvasEdge[];
  paths: PathRow[];
}

export interface GraphExplorerProps {
  /** Prefetched by the server shell when the page loads with ?search=<id> or a recent search was clicked. */
  initialResult?: GraphResultData | null;
  explorerAddressUrlTemplate?: string | null;
}

type RunState = { status: 'idle' } | { status: 'running' } | { status: 'error'; message: string };

interface ApiNode {
  address: string;
  depth: number;
  nodeType: GraphCanvasNode['nodeType'];
  totalSentUsd: string | number;
  totalReceivedUsd: string | number;
  netFlowUsd: string | number;
  interactionCount: number;
  firstSeen: string;
  lastSeen: string;
  tags: string[];
  confidence: number;
}

interface ApiEdge {
  sourceAddress: string;
  destAddress: string;
  relationship: string;
  totalUsd: string | number;
  txCount: number;
}

interface ApiPath {
  addresses: string[];
  totalPathValueUsd: number;
  valueRetentionPct: number;
  timeGapMs: number;
  confidence: number;
}

interface GetSearchResponse {
  search: { id: string; status: string; rootAddress: string };
  nodes: ApiNode[];
  edges: ApiEdge[];
  paths: ApiPath[];
}

function toGraphResult(body: GetSearchResponse): GraphResultData {
  return {
    searchId: body.search.id,
    status: body.search.status,
    rootAddress: body.search.rootAddress,
    nodes: body.nodes.map((n) => ({
      address: n.address,
      depth: n.depth,
      nodeType: n.nodeType,
      totalSentUsd: Number(n.totalSentUsd),
      totalReceivedUsd: Number(n.totalReceivedUsd),
      netFlowUsd: Number(n.netFlowUsd),
      interactionCount: n.interactionCount,
      firstSeen: n.firstSeen,
      lastSeen: n.lastSeen,
      tags: n.tags,
      confidence: n.confidence,
    })),
    edges: body.edges.map((e) => ({
      sourceAddress: e.sourceAddress,
      destAddress: e.destAddress,
      relationship: e.relationship,
      totalUsd: Number(e.totalUsd),
      txCount: e.txCount,
    })),
    paths: body.paths.map((p) => ({
      addresses: p.addresses,
      totalPathValueUsd: p.totalPathValueUsd,
      valueRetentionPct: p.valueRetentionPct,
      timeGapMs: p.timeGapMs,
      confidence: p.confidence,
    })),
  };
}

export function GraphExplorer({ initialResult, explorerAddressUrlTemplate }: GraphExplorerProps) {
  const router = useRouter();
  const [result, setResult] = useState<GraphResultData | null>(initialResult ?? null);
  const [runState, setRunState] = useState<RunState>({ status: 'idle' });
  const [formSeed, setFormSeed] = useState(0);

  async function handleSubmit(params: GraphSearchFormParams): Promise<void> {
    setRunState({ status: 'running' });
    try {
      const postResponse = await fetch('/api/graph', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
      const postBody = await postResponse.json();

      if (!postResponse.ok) {
        const message = Array.isArray(postBody.issues)
          ? postBody.issues.map((i: { path: string; message: string }) => (i.path ? `${i.path}: ${i.message}` : i.message)).join('; ')
          : (postBody.error ?? `search failed (HTTP ${postResponse.status})`);
        setRunState({ status: 'error', message });
        return;
      }

      const searchId = postBody.searchId as string;
      const getResponse = await fetch(`/api/graph/${searchId}`);
      const getBody = await getResponse.json();

      if (!getResponse.ok) {
        setRunState({ status: 'error', message: getBody.error ?? `failed to load search result (HTTP ${getResponse.status})` });
        return;
      }

      setResult(toGraphResult(getBody as GetSearchResponse));
      setRunState({ status: 'idle' });
      router.push(`/graph?search=${searchId}`, { scroll: false });
      router.refresh();
    } catch (err) {
      setRunState({ status: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }

  const running = runState.status === 'running';
  const error = runState.status === 'error' ? runState.message : null;

  const initialFormValues: Partial<GraphSearchFormParams> | undefined = initialResult
    ? { rootAddress: initialResult.rootAddress }
    : undefined;

  return (
    <div className="flex flex-col gap-6">
      <SearchForm key={formSeed} initialValues={initialFormValues} running={running} error={error} onSubmit={(p) => void handleSubmit(p)} />

      {result && result.nodes.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">Export:</span>
          <a href={`/api/graph/${result.searchId}/export?format=nodes.csv`} download>
            <Button type="button" variant="outline" size="sm">
              nodes.csv
            </Button>
          </a>
          <a href={`/api/graph/${result.searchId}/export?format=edges.csv`} download>
            <Button type="button" variant="outline" size="sm">
              edges.csv
            </Button>
          </a>
          <a href={`/api/graph/${result.searchId}/export?format=json`} download>
            <Button type="button" variant="outline" size="sm">
              json
            </Button>
          </a>
          <button
            type="button"
            className="ml-auto text-xs text-muted-foreground hover:underline"
            onClick={() => {
              setResult(null);
              setFormSeed((s) => s + 1);
              router.push('/graph', { scroll: false });
            }}
          >
            New search
          </button>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Graph</CardTitle>
        </CardHeader>
        <CardContent>
          <GraphCanvas
            nodes={result?.nodes ?? []}
            edges={result?.edges ?? []}
            rootAddress={result?.rootAddress ?? ''}
            explorerAddressUrlTemplate={explorerAddressUrlTemplate}
          />
        </CardContent>
      </Card>

      <div>
        <h2 className="mb-3 text-lg font-medium tracking-tight">Connected wallets</h2>
        <ConnectedWalletsTable
          rows={(result?.nodes ?? []) as ConnectedWalletRow[]}
          rootAddress={result?.rootAddress ?? ''}
          explorerAddressUrlTemplate={explorerAddressUrlTemplate}
        />
      </div>

      <div>
        <h2 className="mb-3 text-lg font-medium tracking-tight">Transaction paths</h2>
        <PathsTable paths={result?.paths ?? []} />
      </div>
    </div>
  );
}
