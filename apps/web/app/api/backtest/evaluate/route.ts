// FlowRadar — POST /api/backtest/evaluate (Task 42 binding decision 2).
//
// Runs runBacktestPass NOW (same body as apps/worker/src/jobs/backtest.ts's
// 6h-cadence tick — see that file), evaluating every Signal older than 15
// minutes with incomplete BacktestResult coverage against real
// TokenMarketSnapshot data. This is the "Evaluate now" button's target: lets
// an operator force an evaluation pass between worker ticks (e.g. right
// after seeding, or to pick up a signal that just crossed a horizon
// boundary) without waiting up to 6h. No request body — POST-only, no
// input to validate.
//
// Reads the singleton Settings row the same way GET /api/settings does
// (parseSettings deep-merges over DEFAULT_SETTINGS so a partially-populated
// row still yields a fully-shaped Settings object) — runBacktestPass's
// `_settings` param is currently unused internally (see backtest.ts's own
// signature), but is threaded through for forward-compatibility rather than
// passing DEFAULT_SETTINGS directly, matching every other settings-consuming
// route/job in this app.

import { NextResponse } from 'next/server';
import { parseSettings } from '@flowradar/core';
import { prisma } from '@/lib/db';
import { runBacktestPass } from '@flowradar/db';

export async function POST(): Promise<NextResponse> {
  const settingsRow = await prisma.settings.findFirst();
  const settings = parseSettings(settingsRow?.values ?? {});

  const result = await runBacktestPass(prisma, settings, new Date());

  return NextResponse.json({
    signalsConsidered: result.signalsConsidered,
    signalsEvaluated: result.signalsEvaluated,
    rowsUpserted: result.rowsUpserted,
    labelCounts: result.labelCounts
  });
}
