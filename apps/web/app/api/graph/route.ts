// FlowRadar — POST /api/graph (Task 20 binding decision 4).
//
// Creates a WalletGraphSearch row (status queued, params Json from the
// validated body) then runs it SYNCHRONOUSLY INLINE by calling
// @flowradar/db's runGraphSearch directly, awaited — the web app and the
// worker are separate processes, and this path must work with only
// `npm run dev` running (no worker process required), same reasoning as
// /api/import's direct importWalletsCsv call (see that route's header
// comment). apps/worker's `walletGraph` job (src/jobs/walletGraph.ts) wraps
// the exact same runGraphSearch function for later async/enqueued use (e.g.
// a future "run in background" button), but this route does not depend on it
// or on the worker being up at all.
//
// A large/unbounded graph could make this request slow — maxNodes/maxEdges
// (settings.graph defaults, or the request body's own override) bound the
// worst case, but there is no timeout here beyond Next's own request
// handling; a future task may want to make this genuinely async (enqueue +
// poll) if the caps prove too generous in practice.
//
// Request body (all optional except chain/rootAddress/mode):
//   { chain, rootAddress, mode, maxDepth?, minTransferUsd?, includeNative?,
//     includeToken?, includeSwaps?, includeBridges?, includeCex?,
//     excludeRoutersPoolsContracts?, maxNodes?, maxEdges? }
// Response: { searchId, status, nodeCount, edgeCount }

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { runGraphSearch } from '@flowradar/db';

const GraphSearchRequestSchema = z.object({
  chain: z.enum(['SOLANA', 'BSC']),
  rootAddress: z.string().min(1),
  mode: z.enum(['DIRECT', 'CAPITAL_FLOW', 'ENTITY_DISCOVERY', 'FULL_RAW']),
  maxDepth: z.number().int().positive().optional(),
  minTransferUsd: z.number().nonnegative().optional(),
  timeRange: z
    .object({
      from: z.string().datetime().optional(),
      to: z.string().datetime().optional()
    })
    .optional(),
  includeNative: z.boolean().optional(),
  includeToken: z.boolean().optional(),
  includeSwaps: z.boolean().optional(),
  includeBridges: z.boolean().optional(),
  includeCex: z.boolean().optional(),
  excludeRoutersPoolsContracts: z.boolean().optional(),
  maxNodes: z.number().int().positive().optional(),
  maxEdges: z.number().int().positive().optional()
});

export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'request body is not valid JSON' }, { status: 400 });
  }

  const parsed = GraphSearchRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid request body', issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) },
      { status: 400 }
    );
  }

  const { chain, rootAddress, mode, ...rest } = parsed.data;

  const search = await prisma.walletGraphSearch.create({
    data: {
      rootAddress,
      chain,
      mode,
      params: rest as object,
      status: 'queued',
      nodeCount: 0,
      edgeCount: 0
    }
  });

  const result = await runGraphSearch(prisma, search.id);

  return NextResponse.json({
    searchId: search.id,
    status: result.status,
    nodeCount: result.nodeCount,
    edgeCount: result.edgeCount
  });
}
