import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { parseReplayRequest, MAX_REPLAY_WINDOW_DAYS } from '../src/backtest/replayRequest';

// parseReplayRequest(body): { from, to, stepMinutes } (Task 42 binding
// decision 2).
//
// POST /api/backtest/replay accepts an OPTIONAL { from?, to?, stepMinutes? }
// body (ISO date strings for from/to). Defaults: `to` = now (the route
// supplies this — parseReplayRequest itself takes `now` as an explicit
// parameter so it stays pure/deterministic for tests, no Date.now() inside),
// `from` = to - 14 days (the widest allowed window, so an empty body is
// always valid and maximal). stepMinutes defaults to 30 when omitted.
//
// Bound (BINDING, task brief item 2): (to - from) must be <= 14 days
// (MAX_REPLAY_WINDOW_DAYS). A wider request throws a ZodError (via a
// superRefine on the parsed object) so the route can translate it into a 400
// with a zod issue list, mirroring parseSettings' own
// "merge-then-validate-then-throw-ZodError" contract.

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-07-05T12:00:00Z');

describe('parseReplayRequest — defaults', () => {
  it('empty body defaults to [now - 14d, now], stepMinutes 30', () => {
    const result = parseReplayRequest({}, NOW);
    expect(result.to.getTime()).toBe(NOW.getTime());
    expect(result.from.getTime()).toBe(NOW.getTime() - 14 * DAY_MS);
    expect(result.stepMinutes).toBe(30);
  });

  it('body with only `to` supplied defaults `from` to to - 14d', () => {
    const to = new Date('2026-07-01T00:00:00Z');
    const result = parseReplayRequest({ to: to.toISOString() }, NOW);
    expect(result.to.getTime()).toBe(to.getTime());
    expect(result.from.getTime()).toBe(to.getTime() - 14 * DAY_MS);
  });

  it('body with only `from` supplied defaults `to` to now', () => {
    const from = new Date('2026-07-04T00:00:00Z');
    const result = parseReplayRequest({ from: from.toISOString() }, NOW);
    expect(result.from.getTime()).toBe(from.getTime());
    expect(result.to.getTime()).toBe(NOW.getTime());
  });

  it('custom stepMinutes is passed through', () => {
    const result = parseReplayRequest({ stepMinutes: 15 }, NOW);
    expect(result.stepMinutes).toBe(15);
  });
});

describe('parseReplayRequest — 14-day bound (BINDING)', () => {
  it('accepts a window exactly at the 14-day boundary', () => {
    const to = NOW;
    const from = new Date(to.getTime() - MAX_REPLAY_WINDOW_DAYS * DAY_MS);
    expect(() => parseReplayRequest({ from: from.toISOString(), to: to.toISOString() }, NOW)).not.toThrow();
  });

  it('rejects a window one millisecond wider than 14 days', () => {
    const to = NOW;
    const from = new Date(to.getTime() - MAX_REPLAY_WINDOW_DAYS * DAY_MS - 1);
    expect(() => parseReplayRequest({ from: from.toISOString(), to: to.toISOString() }, NOW)).toThrow(ZodError);
  });

  it('rejects a 30-day window with a ZodError carrying a descriptive issue', () => {
    const to = NOW;
    const from = new Date(to.getTime() - 30 * DAY_MS);
    try {
      parseReplayRequest({ from: from.toISOString(), to: to.toISOString() }, NOW);
      expect.fail('expected parseReplayRequest to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ZodError);
      const zodErr = err as ZodError;
      expect(zodErr.issues.length).toBeGreaterThan(0);
      expect(zodErr.issues[0]!.message).toMatch(/14/);
    }
  });
});

describe('parseReplayRequest — malformed input', () => {
  it('rejects a non-ISO `from` string', () => {
    expect(() => parseReplayRequest({ from: 'not-a-date' }, NOW)).toThrow(ZodError);
  });

  it('rejects `to` before `from`', () => {
    const from = NOW;
    const to = new Date(NOW.getTime() - DAY_MS);
    expect(() => parseReplayRequest({ from: from.toISOString(), to: to.toISOString() }, NOW)).toThrow(ZodError);
  });

  it('rejects a zero/negative stepMinutes', () => {
    expect(() => parseReplayRequest({ stepMinutes: 0 }, NOW)).toThrow(ZodError);
    expect(() => parseReplayRequest({ stepMinutes: -5 }, NOW)).toThrow(ZodError);
  });

  it('rejects a non-object body (e.g. a raw string)', () => {
    expect(() => parseReplayRequest('nope', NOW)).toThrow(ZodError);
  });
});
