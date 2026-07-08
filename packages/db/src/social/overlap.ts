// FlowRadar — getSocialSignalOverlap (Task E, spec §9). READ-ONLY, SHADOW-
// ONLY confluence display: joins SocialMention.tokenId to tokens that ALSO
// have recent wallet-driven evidence (Signal rows and/or a latest
// TokenFlowSnapshot) in a window. NO scoring, NO alerts, NO writes, NO
// FlowScore/CandidateWallet interaction (spec constraints 3/4/5/7).
import type { PrismaClient } from '@prisma/client';

export interface SocialSignalOverlapRow {
  tokenId: string;
  tokenSymbol: string;
  tokenAddress: string;
  socialMentionCount: number;
  distinctAuthors: number;
  latestFlowScore: number | null;
  firedSignals: { rule: string; severity: string; triggeredAt: Date }[];
}

const DEFAULT_WINDOW_MIN = 1440; // 24h

export async function getSocialSignalOverlap(
  prisma: PrismaClient,
  opts?: { windowMinutes?: number; limit?: number }
): Promise<SocialSignalOverlapRow[]> {
  const windowMinutes = opts?.windowMinutes ?? DEFAULT_WINDOW_MIN;
  const limit = opts?.limit ?? 25;
  const since = new Date(Date.now() - windowMinutes * 60_000);

  // 1) Tokens with LINKED social mentions in the window (tokenId not null).
  const mentionGroups = await prisma.socialMention.groupBy({
    by: ['tokenId'],
    where: { tokenId: { not: null }, postedAt: { gte: since } },
    _count: { _all: true }
  });
  const tokenIds = mentionGroups
    .map((g) => g.tokenId)
    .filter((id): id is string => id !== null);
  if (tokenIds.length === 0) return [];

  // 2) Which of those tokens ALSO have wallet-driven evidence in the window:
  //    a Signal fired OR a TokenFlowSnapshot exists. Fetch both, then keep
  //    only tokens present in at least one.
  const [tokens, signals, flowSnaps, mentions] = await Promise.all([
    prisma.token.findMany({
      where: { id: { in: tokenIds } },
      select: { id: true, symbol: true, address: true }
    }),
    prisma.signal.findMany({
      where: { tokenId: { in: tokenIds }, triggeredAt: { gte: since } },
      select: { tokenId: true, rule: true, severity: true, triggeredAt: true },
      orderBy: { triggeredAt: 'desc' }
    }),
    prisma.tokenFlowSnapshot.findMany({
      where: { tokenId: { in: tokenIds }, ts: { gte: since } },
      select: { tokenId: true, flowScore: true, ts: true },
      orderBy: { ts: 'desc' }
    }),
    // distinct-author + count per token — pull the linked mentions in-window.
    prisma.socialMention.findMany({
      where: { tokenId: { in: tokenIds }, postedAt: { gte: since } },
      select: { tokenId: true, authorHash: true }
    })
  ]);

  const tokenById = new Map(tokens.map((t) => [t.id, t]));

  const signalsByToken = new Map<string, { rule: string; severity: string; triggeredAt: Date }[]>();
  for (const s of signals) {
    const list = signalsByToken.get(s.tokenId) ?? [];
    list.push({ rule: String(s.rule), severity: String(s.severity), triggeredAt: s.triggeredAt });
    signalsByToken.set(s.tokenId, list);
  }

  // latest flow score per token (list is already ts-desc).
  const latestFlowByToken = new Map<string, number>();
  for (const f of flowSnaps) {
    if (!latestFlowByToken.has(f.tokenId)) latestFlowByToken.set(f.tokenId, f.flowScore);
  }

  const countByToken = new Map<string, number>();
  const authorsByToken = new Map<string, Set<string>>();
  for (const m of mentions) {
    if (!m.tokenId) continue;
    countByToken.set(m.tokenId, (countByToken.get(m.tokenId) ?? 0) + 1);
    const set = authorsByToken.get(m.tokenId) ?? new Set<string>();
    if (m.authorHash) set.add(m.authorHash);
    authorsByToken.set(m.tokenId, set);
  }

  const rows: SocialSignalOverlapRow[] = [];
  for (const tokenId of tokenIds) {
    const token = tokenById.get(tokenId);
    if (!token) continue;
    const firedSignals = signalsByToken.get(tokenId) ?? [];
    const latestFlowScore = latestFlowByToken.get(tokenId) ?? null;
    // "Overlap" = social mention AND at least one wallet-driven evidence leg.
    if (firedSignals.length === 0 && latestFlowScore === null) continue;
    rows.push({
      tokenId,
      tokenSymbol: token.symbol,
      tokenAddress: token.address,
      socialMentionCount: countByToken.get(tokenId) ?? 0,
      distinctAuthors: authorsByToken.get(tokenId)?.size ?? 0,
      latestFlowScore,
      firedSignals
    });
  }

  // Strongest confluence first: most social mentions, then flow score.
  rows.sort((a, b) => b.socialMentionCount - a.socialMentionCount || (b.latestFlowScore ?? 0) - (a.latestFlowScore ?? 0));
  return rows.slice(0, limit);
}
