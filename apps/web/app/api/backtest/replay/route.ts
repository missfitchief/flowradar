// FlowRadar — POST /api/backtest/replay (Task 42 binding decision 2).
//
// Runs runHistoricalReplay INLINE within the request (no background job
// queue exists in this app — every worker pass is either a setInterval tick
// or, here, a directly-awaited call) over an OPTIONAL { from?, to?,
// stepMinutes? } body, Zod-validated + bounded to a MAX 14-day window via
// @flowradar/core's parseReplayRequest (see that file's header: a wider
// window risks the request itself timing out, since the no-lookahead replay
// walk is synchronous). Returns { runId } — the /backtest page's "Run
// replay" button re-fetches the page (router.refresh()) after this resolves
// rather than this route returning the full summary itself, mirroring
// PUT /api/settings' "return the canonical saved shape, let the page re-read"
// contract.
//
// Malformed/out-of-bounds input -> 400 with a zod issue list (same shape as
// PUT /api/settings' error body: { error, issues: [{ path, message }] }).

import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { parseReplayRequest } from '@flowradar/core';
import { runHistoricalReplay } from '@flowradar/db';
import { prisma } from '@/lib/db';

export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    // An empty body (no Content-Length / no JSON at all) is valid per
    // parseReplayRequest's own "empty body is always valid and maximal"
    // contract — only fall back to {} when there's truly nothing to parse.
    body = {};
  }

  let parsed;
  try {
    parsed = parseReplayRequest(body, new Date());
  } catch (err) {
    if (err instanceof ZodError) {
      return NextResponse.json(
        {
          error: 'invalid replay request',
          issues: err.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
        },
        { status: 400 }
      );
    }
    throw err;
  }

  const { backtestRunId } = await runHistoricalReplay(prisma, {
    from: parsed.from,
    to: parsed.to,
    stepMinutes: parsed.stepMinutes
  });

  return NextResponse.json({ runId: backtestRunId });
}
