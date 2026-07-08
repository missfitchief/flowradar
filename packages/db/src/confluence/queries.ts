// FlowRadar — token-detail Confluence read helpers (Task E). SHADOW-ONLY:
// pure reads over TokenConfluenceSnapshot + ExternalConfluenceSource. They
// never write, never touch FlowScore/Signal/CandidateWallet, and never
// fabricate a row for a snapshotType that has no data (absence -> null, which
// the panel renders honestly as "unavailable/unknown", NEVER "safe").
import type { PrismaClient } from '@prisma/client';
import {
  getConfluenceSourceStatuses,
  type ConfluenceSourceStatusRow,
} from '@flowradar/providers';

/** A single confluence snapshot flattened for display (Date/JSON kept; no secrets). */
export interface ConfluenceSnapshotRow {
  id: string;
  snapshotType: string;
  provider: string;
  status: string;
  dataJson: Record<string, unknown>;
  observedAt: Date;
  /** ExternalConfluenceSource.name when linked; null for the internal LiquidityRisk snapshot. */
  sourceName: string | null;
}

export interface TokenConfluence {
  liquidityRisk: ConfluenceSnapshotRow | null;
  holderRisk: ConfluenceSnapshotRow | null;
  clobr: ConfluenceSnapshotRow | null;
  gmgn: ConfluenceSnapshotRow | null;
  agPaper: ConfluenceSnapshotRow | null;
  sourceStatuses: ConfluenceSourceStatusRow[];
}

const SNAPSHOT_INCLUDE = {
  source: { select: { name: true } },
} as const;

function toRow(
  s: {
    id: string;
    snapshotType: string;
    provider: string;
    status: string;
    dataJson: unknown;
    observedAt: Date;
    source: { name: string } | null;
  } | null,
): ConfluenceSnapshotRow | null {
  if (!s) return null;
  return {
    id: s.id,
    snapshotType: s.snapshotType,
    provider: s.provider,
    status: s.status,
    // dataJson is display-safe by construction (Task B/C/D guarantee no secrets);
    // coerce Prisma.JsonValue -> record for the panel. Non-object payloads (never
    // expected) degrade to {} rather than throwing.
    dataJson:
      s.dataJson && typeof s.dataJson === 'object' && !Array.isArray(s.dataJson)
        ? (s.dataJson as Record<string, unknown>)
        : {},
    observedAt: s.observedAt,
    sourceName: s.source?.name ?? null,
  };
}

/** Latest snapshot for one (tokenId, snapshotType), newest observedAt first. */
async function latestOfType(prisma: PrismaClient, tokenId: string, snapshotType: string) {
  return prisma.tokenConfluenceSnapshot.findFirst({
    where: { tokenId, snapshotType },
    orderBy: { observedAt: 'desc' },
    include: SNAPSHOT_INCLUDE,
  });
}

/**
 * All confluence evidence for one token: the latest snapshot per snapshotType
 * (liquidity_risk / holder_risk / liquidity_map / external_intel / paper_trade)
 * plus the operator-facing source health rows. Read-only. A snapshotType with
 * no rows returns null — the caller must render that as unavailable/unknown,
 * never as a reassuring verdict.
 */
export async function getTokenConfluence(
  prisma: PrismaClient,
  tokenId: string,
): Promise<TokenConfluence> {
  const [liquidityRisk, holderRisk, clobr, gmgn, agPaper, sourceStatuses] = await Promise.all([
    latestOfType(prisma, tokenId, 'liquidity_risk'),
    latestOfType(prisma, tokenId, 'holder_risk'),
    latestOfType(prisma, tokenId, 'liquidity_map'),
    latestOfType(prisma, tokenId, 'external_intel'),
    latestOfType(prisma, tokenId, 'paper_trade'),
    getConfluenceSourceStatuses(prisma),
  ]);

  return {
    liquidityRisk: toRow(liquidityRisk),
    holderRisk: toRow(holderRisk),
    clobr: toRow(clobr),
    gmgn: toRow(gmgn),
    agPaper: toRow(agPaper),
    sourceStatuses,
  };
}
