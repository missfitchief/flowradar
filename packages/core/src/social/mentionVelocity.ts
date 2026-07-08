// FlowRadar — social: pure mention-velocity computation (spec §5).
//
// PURE. Computed on READ, never stored. Excludes mentions with
// spamScore > cfg.spamMaxScore. Groups by tokenId (else tokenAddress). Per
// window: count and distinctAuthors (null authorHash counts toward count but
// not distinct authors — author-dominance aware). accel = the shortest
// window's per-minute rate divided by the longest window's per-minute rate
// (>1 = accelerating), 0 when the longest window has no qualifying mentions.

import type { MentionVelocityInput, MentionVelocityRow } from './types';

const MIN_MS = 60_000;

export function computeMentionVelocity(
  mentions: MentionVelocityInput[],
  now: Date,
  cfg: { windowsMin: number[]; spamMaxScore: number }
): MentionVelocityRow[] {
  const windowsMin = [...cfg.windowsMin].sort((a, b) => a - b);
  if (windowsMin.length === 0) return [];

  const kept = mentions.filter((m) => m.spamScore <= cfg.spamMaxScore);

  // Group by tokenId when present, else by tokenAddress. `none` collects
  // mentions with neither (still surfaced so unlinked tickers aren't dropped).
  interface Group {
    tokenId: string | null;
    tokenAddress: string | null;
    items: MentionVelocityInput[];
  }
  const groups = new Map<string, Group>();
  for (const m of kept) {
    const key = m.tokenId !== null ? `id:${m.tokenId}` : m.tokenAddress !== null ? `addr:${m.tokenAddress}` : 'none';
    let g = groups.get(key);
    if (!g) {
      g = { tokenId: m.tokenId, tokenAddress: m.tokenAddress, items: [] };
      groups.set(key, g);
    }
    g.items.push(m);
  }

  const nowMs = now.getTime();
  const shortMin = windowsMin[0]!;
  const longMin = windowsMin[windowsMin.length - 1]!;

  const rows: MentionVelocityRow[] = [];
  for (const g of groups.values()) {
    const windows = windowsMin.map((windowMin) => {
      const cutoff = nowMs - windowMin * MIN_MS;
      const inWin = g.items.filter((m) => m.postedAt.getTime() >= cutoff && m.postedAt.getTime() <= nowMs);
      const distinctAuthors = new Set(
        inWin.filter((m) => m.authorHash !== null).map((m) => m.authorHash as string)
      ).size;
      return { windowMin, count: inWin.length, distinctAuthors };
    });

    const shortCount = windows.find((w) => w.windowMin === shortMin)!.count;
    const longCount = windows.find((w) => w.windowMin === longMin)!.count;
    const shortRate = shortCount / shortMin;
    const longRate = longCount / longMin;
    const accel = longRate > 0 ? shortRate / longRate : 0;

    rows.push({ tokenId: g.tokenId, tokenAddress: g.tokenAddress, windows, accel });
  }

  return rows;
}
