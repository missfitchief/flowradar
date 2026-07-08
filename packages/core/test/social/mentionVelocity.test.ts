import { describe, expect, it } from 'vitest';
import { computeMentionVelocity } from '../../src/social/mentionVelocity';
import type { MentionVelocityInput } from '../../src/social/types';

const NOW = new Date('2026-07-07T12:00:00.000Z');
// minutes-ago helper
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000);

const CFG = { windowsMin: [60, 360, 1440], spamMaxScore: 70 };

function row(over: Partial<MentionVelocityInput>): MentionVelocityInput {
  return { tokenId: 't1', tokenAddress: 'A1', authorHash: 'auth1', postedAt: ago(5), spamScore: 0, ...over };
}

describe('computeMentionVelocity', () => {
  it('counts mentions per window (nested windows include shorter-window mentions)', () => {
    const mentions = [
      row({ postedAt: ago(5) }), // in 60 / 360 / 1440
      row({ postedAt: ago(120) }), // in 360 / 1440
      row({ postedAt: ago(1000) }) // in 1440 only
    ];
    const [r] = computeMentionVelocity(mentions, NOW, CFG);
    const byWin = Object.fromEntries(r.windows.map((w) => [w.windowMin, w.count]));
    expect(byWin[60]).toBe(1);
    expect(byWin[360]).toBe(2);
    expect(byWin[1440]).toBe(3);
  });

  it('excludes mentions with spamScore > spamMaxScore', () => {
    const mentions = [
      row({ postedAt: ago(5), spamScore: 0 }),
      row({ postedAt: ago(5), spamScore: 71 }), // > 70 → excluded
      row({ postedAt: ago(5), spamScore: 70 }) // == 70 → kept (not > 70)
    ];
    const [r] = computeMentionVelocity(mentions, NOW, CFG);
    expect(r.windows.find((w) => w.windowMin === 60)!.count).toBe(2);
  });

  it('distinctAuthors is author-dominance aware (10 from 1 author != 10 from 10)', () => {
    const oneAuthor = Array.from({ length: 10 }, () => row({ authorHash: 'solo', postedAt: ago(10) }));
    const tenAuthors = Array.from({ length: 10 }, (_, i) => row({ authorHash: `a${i}`, postedAt: ago(10) }));

    const [rSolo] = computeMentionVelocity(oneAuthor, NOW, CFG);
    const [rMany] = computeMentionVelocity(tenAuthors, NOW, CFG);

    const w60 = (rows: typeof rSolo) => rows.windows.find((w) => w.windowMin === 60)!;
    expect(w60(rSolo).count).toBe(10);
    expect(w60(rSolo).distinctAuthors).toBe(1);
    expect(w60(rMany).count).toBe(10);
    expect(w60(rMany).distinctAuthors).toBe(10);
  });

  it('null authorHash counts toward count but not toward distinctAuthors', () => {
    const mentions = [row({ authorHash: null, postedAt: ago(5) }), row({ authorHash: null, postedAt: ago(5) })];
    const [r] = computeMentionVelocity(mentions, NOW, CFG);
    const w60 = r.windows.find((w) => w.windowMin === 60)!;
    expect(w60.count).toBe(2);
    expect(w60.distinctAuthors).toBe(0);
  });

  it('groups by tokenId when present, else by tokenAddress', () => {
    const mentions = [
      row({ tokenId: 't1', tokenAddress: 'A1' }),
      row({ tokenId: 't1', tokenAddress: 'A1' }),
      row({ tokenId: null, tokenAddress: 'A2' })
    ];
    const rows = computeMentionVelocity(mentions, NOW, CFG);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.tokenId === 't1')!.windows.find((w) => w.windowMin === 60)!.count).toBe(2);
    expect(rows.find((r) => r.tokenAddress === 'A2')!.windows.find((w) => w.windowMin === 60)!.count).toBe(1);
  });

  it('accel = shortest-window rate / longest-window rate (>1 when recent burst)', () => {
    // 3 mentions in last 60m, 3 more between 60m and 1440m ago → 6 total in 1440.
    const mentions = [
      row({ postedAt: ago(5) }),
      row({ postedAt: ago(10) }),
      row({ postedAt: ago(20) }),
      row({ postedAt: ago(600) }),
      row({ postedAt: ago(700) }),
      row({ postedAt: ago(800) })
    ];
    const [r] = computeMentionVelocity(mentions, NOW, CFG);
    // shortRate = 3/60 = 0.05 /min ; longRate = 6/1440 = 0.004166.. /min
    // accel = 0.05 / 0.0041666 = 12
    expect(r.accel).toBeCloseTo(12, 4);
  });

  it('accel is 0 when the longest window has no qualifying mentions', () => {
    // all mentions spam-excluded → no long-window mentions → accel 0, counts 0
    const mentions = [row({ postedAt: ago(5), spamScore: 99 })];
    const [r] = computeMentionVelocity(mentions, NOW, CFG) as [ReturnType<typeof computeMentionVelocity>[number]];
    expect(r?.accel ?? 0).toBe(0);
  });

  it('returns [] for empty input', () => {
    expect(computeMentionVelocity([], NOW, CFG)).toEqual([]);
  });
});
