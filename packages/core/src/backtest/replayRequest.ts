// FlowRadar — parseReplayRequest: Zod-validated POST /api/backtest/replay
// body parser (Task 42 binding decision 2).
//
// apps/web's /api/backtest/replay route accepts an OPTIONAL
// { from?, to?, stepMinutes? } JSON body (ISO date strings for from/to) and
// must reject any request whose [from, to] span exceeds
// MAX_REPLAY_WINDOW_DAYS (14) with a 400 — a wider window risks an
// inline-request-lifetime replay pass timing out the HTTP response, since
// runHistoricalReplay does the full no-lookahead walk synchronously within
// the request per this task's binding decision 2 ("inline: bounded, max
// 14-day window, reject otherwise 400"). This module is pure/zero-I/O (no
// Prisma, no Date.now()) so the bound is unit-testable without a DB — the
// route supplies `now` itself (typically `new Date()`), keeping this
// function deterministic for tests.
//
// Defaults (an empty body is always valid and maximal):
//   to   -> `now`
//   from -> `to` - MAX_REPLAY_WINDOW_DAYS days (the widest allowed window)
//   stepMinutes -> 30 (matches replaySignals' own DEFAULT_STEP_MINUTES)
//
// Validation order mirrors parseSettings' contract elsewhere in this
// package: build a schema, `.parse()` it, let ZodError propagate to the
// caller (the API route translates it into a 400 + issue list, matching
// PUT /api/settings' existing pattern).

import { z } from 'zod';

export const MAX_REPLAY_WINDOW_DAYS = 14;
const MAX_REPLAY_WINDOW_MS = MAX_REPLAY_WINDOW_DAYS * 24 * 60 * 60 * 1000;

export interface ReplayRequestInput {
  from?: string;
  to?: string;
  stepMinutes?: number;
}

export interface ParsedReplayRequest {
  from: Date;
  to: Date;
  stepMinutes: number;
}

const RawSchema = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  stepMinutes: z.number().positive().optional()
});

/**
 * Parses+validates a POST /api/backtest/replay request body. `now` is
 * supplied by the caller (not read internally) so this stays a pure,
 * deterministic function. Throws ZodError on any invalid input: malformed
 * body shape, non-ISO date strings, to before from, non-positive
 * stepMinutes, or a [from, to] span wider than MAX_REPLAY_WINDOW_DAYS.
 */
export function parseReplayRequest(body: unknown, now: Date): ParsedReplayRequest {
  const raw = RawSchema.parse(body);

  const to = raw.to ? new Date(raw.to) : now;
  const from = raw.from ? new Date(raw.from) : new Date(to.getTime() - MAX_REPLAY_WINDOW_MS);
  const stepMinutes = raw.stepMinutes ?? 30;

  const BoundsSchema = z
    .object({ from: z.date(), to: z.date(), stepMinutes: z.number().positive() })
    .superRefine((val, ctx) => {
      if (val.to.getTime() < val.from.getTime()) {
        ctx.addIssue({ code: 'custom', message: '`to` must not be before `from`.', path: ['to'] });
      }
      const spanMs = val.to.getTime() - val.from.getTime();
      if (spanMs > MAX_REPLAY_WINDOW_MS) {
        ctx.addIssue({
          code: 'custom',
          message: `Replay window must not exceed ${MAX_REPLAY_WINDOW_DAYS} days (requested ${(spanMs / (24 * 60 * 60 * 1000)).toFixed(2)} days).`,
          path: ['to']
        });
      }
    });

  return BoundsSchema.parse({ from, to, stepMinutes });
}
