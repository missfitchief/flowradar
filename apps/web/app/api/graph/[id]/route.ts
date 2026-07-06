// FlowRadar — GET /api/graph/[id] (Task 20 binding decision 4).
//
// Returns the WalletGraphSearch row plus its persisted nodes/edges/paths.
// Next 15's App Router dynamic route params arrive as a Promise (must be
// awaited) — see apps/web/app/tokens/[id]/page.tsx for the same convention
// already used elsewhere in this app.

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await params;

  const search = await prisma.walletGraphSearch.findUnique({
    where: { id },
    include: {
      nodes: true,
      edges: true
    }
  });

  if (!search) {
    return NextResponse.json({ error: `no WalletGraphSearch found with id "${id}"` }, { status: 404 });
  }

  const { nodes, edges, resultSummary, ...searchFields } = search;
  const summary = (resultSummary ?? { paths: [], counts: { nodeCount: 0, edgeCount: 0, pathCount: 0 } }) as {
    paths: unknown[];
    counts: { nodeCount: number; edgeCount: number; pathCount: number };
  };

  return NextResponse.json({
    search: searchFields,
    nodes,
    edges,
    paths: summary.paths
  });
}
