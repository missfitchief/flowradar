// FlowRadar — GET /api/graph/[id]/export (Task 20 binding decision 5).
//
// `?format=nodes.csv|edges.csv|json`. Returns 400 for a missing/unrecognized
// format, 404 if the search id doesn't exist.
//
// nodes.csv columns: address,chain,depth,nodeType,totalSentUsd,
// totalReceivedUsd,netFlowUsd,interactionCount,firstSeen,lastSeen,tags,
// confidence — tags pipe-joined, chain taken from the parent search row
// (WalletGraphNode itself has no chain column). firstSeen/lastSeen are
// ISO-8601 strings.
//
// edges.csv columns: sourceAddress,destAddress,relationship,totalUsd,txCount,
// firstTs,lastTs,sampleTxHashes — sampleTxHashes pipe-joined.
//
// json: { search, nodes, edges, paths } — same shape as GET /api/graph/[id]'s
// body, just served as a downloadable attachment instead of an inline
// fetch response.

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { buildCsv } from '@flowradar/db';

type ExportFormat = 'nodes.csv' | 'edges.csv' | 'json';

function parseFormat(raw: string | null): ExportFormat | null {
  if (raw === 'nodes.csv' || raw === 'edges.csv' || raw === 'json') return raw;
  return null;
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await params;
  const url = new URL(request.url);
  const format = parseFormat(url.searchParams.get('format'));

  if (!format) {
    return NextResponse.json({ error: 'missing or invalid "format" query param — expected nodes.csv, edges.csv, or json' }, { status: 400 });
  }

  const search = await prisma.walletGraphSearch.findUnique({
    where: { id },
    include: { nodes: true, edges: true }
  });

  if (!search) {
    return NextResponse.json({ error: `no WalletGraphSearch found with id "${id}"` }, { status: 404 });
  }

  if (format === 'nodes.csv') {
    const header = [
      'address',
      'chain',
      'depth',
      'nodeType',
      'totalSentUsd',
      'totalReceivedUsd',
      'netFlowUsd',
      'interactionCount',
      'firstSeen',
      'lastSeen',
      'tags',
      'confidence'
    ];
    const rows = search.nodes.map((n) => [
      n.address,
      search.chain,
      n.depth,
      n.nodeType,
      n.totalSentUsd.toString(),
      n.totalReceivedUsd.toString(),
      n.netFlowUsd.toString(),
      n.interactionCount,
      n.firstSeen.toISOString(),
      n.lastSeen.toISOString(),
      n.tags.join('|'),
      n.confidence
    ]);
    const csv = buildCsv(header, rows);
    return new NextResponse(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="flowradar-graph-${id}-nodes.csv"`
      }
    });
  }

  if (format === 'edges.csv') {
    const header = ['sourceAddress', 'destAddress', 'relationship', 'totalUsd', 'txCount', 'firstTs', 'lastTs', 'sampleTxHashes'];
    const rows = search.edges.map((e) => [
      e.sourceAddress,
      e.destAddress,
      e.relationship,
      e.totalUsd.toString(),
      e.txCount,
      e.firstTs.toISOString(),
      e.lastTs.toISOString(),
      e.sampleTxHashes.join('|')
    ]);
    const csv = buildCsv(header, rows);
    return new NextResponse(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="flowradar-graph-${id}-edges.csv"`
      }
    });
  }

  // json
  const { nodes, edges, resultSummary, ...searchFields } = search;
  const summary = (resultSummary ?? { paths: [], counts: { nodeCount: 0, edgeCount: 0, pathCount: 0 } }) as {
    paths: unknown[];
    counts: { nodeCount: number; edgeCount: number; pathCount: number };
  };
  const body = JSON.stringify({ search: searchFields, nodes, edges, paths: summary.paths });

  return new NextResponse(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="flowradar-graph-${id}.json"`
    }
  });
}
