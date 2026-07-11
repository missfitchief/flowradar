// FlowRadar — GMGN raw observation ingest (Task 2).
//
// Normalizes read-only GMGN feed rows into append-only GmgnObservation records
// and materializes wallets SHADOW-ONLY:
//   - every GMGN-discovered wallet → observation_only (existing classified /
//     operator-promoted statuses PRESERVED — never downgraded);
//   - KOL/promoter-tagged NEW wallets → public_kol / public_promoter (crowd-
//     arrival analysis only), NEVER signal_eligible;
//   - provider metrics → ObservationProviderSnapshot (provider_claimed),
//     NEVER WalletStats (the FlowScore-read table);
//   - append-only + dedupeKey → re-polling is idempotent; distinct feeds keep
//     distinct rows so cross-source confirmation is preserved.
// Nothing here grants a smart vote or eligibility (the WalletStatus gate is
// enforced downstream). No FlowScore/threshold touch.

import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';

export interface GmgnObservationInput {
  chain: 'SOLANA' | 'BSC';
  sourceCommand: string;
  walletAddress: string;
  tokenAddress?: string | null;
  activityType?: string | null;
  side?: 'buy' | 'sell' | 'transfer' | null;
  amountToken?: string | null;
  amountUsd?: string | null;
  providerPnlUsd?: string | null;
  providerWinRate?: number | null;
  providerTradeCount?: number | null;
  rawClassification?: unknown;
  isKolTagged?: boolean;
  isPromoterTagged?: boolean;
  activityTs?: Date | null;
  retrievedAt: Date;
  cursor?: string | null;
  dataQuality?: string;
  dedupeKey: string;
}

/** Stable dedupe key over the IDENTITY tuple (NOT retrievedAt — re-polling the
 *  same activity must dedupe). */
export function gmgnDedupeKey(o: Omit<GmgnObservationInput, 'dedupeKey'> & { dedupeKey?: string }): string {
  const tuple = [o.sourceCommand, o.walletAddress, o.tokenAddress ?? '', o.activityTs ? o.activityTs.toISOString() : '', o.side ?? ''].join('|');
  return createHash('sha256').update(tuple).digest('hex').slice(0, 32);
}

// ---------------------------------------------------------------------------
// Pure normalizers (feed row → GmgnObservationInput)
// ---------------------------------------------------------------------------

interface NormCtx { sourceCommand: string; retrievedAt: Date; chain?: 'SOLANA' | 'BSC'; cursor?: string | null }

const numOrNull = (v: unknown): string | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : null; // missing/garbage stays null, never 0
};
const tsOrNull = (v: unknown): Date | null => {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date((n < 1e12 ? n * 1000 : n)); // seconds vs millis
};
function detectKol(makerInfo: unknown): boolean {
  if (!makerInfo || typeof makerInfo !== 'object') return false;
  const m = makerInfo as Record<string, unknown>;
  if (m.is_kol === true) return true;
  const tags = [m.tag, ...(Array.isArray(m.tags) ? m.tags : []), m.wallet_tag_v2].filter(Boolean).map((t) => String(t).toLowerCase());
  return tags.some((t) => t.includes('kol') || t.includes('renowned'));
}

function withKey(o: Omit<GmgnObservationInput, 'dedupeKey'>): GmgnObservationInput {
  return { ...o, dedupeKey: gmgnDedupeKey(o) };
}

/** track smartmoney / track kol row → observation. */
export function normalizeSmartmoneyRow(row: Record<string, unknown>, ctx: NormCtx): GmgnObservationInput {
  const sideRaw = String(row.side ?? '').toLowerCase();
  return withKey({
    chain: ctx.chain ?? 'SOLANA',
    sourceCommand: ctx.sourceCommand,
    walletAddress: String(row.maker ?? ''),
    tokenAddress: row.base_address ? String(row.base_address) : null,
    activityType: sideRaw || null,
    side: sideRaw === 'buy' ? 'buy' : sideRaw === 'sell' ? 'sell' : null,
    amountToken: numOrNull(row.token_amount),
    amountUsd: numOrNull(row.amount_usd),
    rawClassification: (row.maker_info as unknown) ?? null,
    isKolTagged: detectKol(row.maker_info) || /kol/i.test(ctx.sourceCommand),
    isPromoterTagged: false,
    activityTs: tsOrNull(row.timestamp),
    retrievedAt: ctx.retrievedAt,
    cursor: ctx.cursor ?? null,
    dataQuality: row.maker ? 'complete' : 'partial'
  });
}

/** portfolio activity row → observation (buy/sell/transferIn/transferOut). */
export function normalizePortfolioActivityRow(row: Record<string, unknown>, ctx: NormCtx): GmgnObservationInput {
  const ev = String(row.event_type ?? '').toLowerCase();
  const side: GmgnObservationInput['side'] = ev === 'buy' ? 'buy' : ev === 'sell' ? 'sell' : ev.startsWith('transfer') ? 'transfer' : null;
  return withKey({
    chain: ctx.chain ?? 'SOLANA',
    sourceCommand: ctx.sourceCommand,
    walletAddress: String(row.wallet ?? ''),
    tokenAddress: row.token ? String(row.token) : null,
    activityType: (row.event_type as string) ?? null,
    side,
    amountToken: numOrNull(row.token_amount),
    amountUsd: numOrNull(row.cost_usd ?? row.buy_cost_usd),
    activityTs: tsOrNull(row.timestamp),
    retrievedAt: ctx.retrievedAt,
    cursor: ctx.cursor ?? null,
    dataQuality: row.wallet ? 'complete' : 'partial'
  });
}

// ---------------------------------------------------------------------------
// DB ingest
// ---------------------------------------------------------------------------

export interface GmgnIngestResult {
  observationsCreated: number;
  duplicatesSkipped: number;
  walletsMaterialized: number;
  snapshotsWritten: number;
  invalidSkipped: number;
}

// A GMGN feed may only ever set these statuses on a NEW wallet.
const KOL_STATUS = 'public_kol';
const PROMOTER_STATUS = 'public_promoter';

export async function ingestGmgnObservations(prisma: PrismaClient, rows: GmgnObservationInput[]): Promise<GmgnIngestResult> {
  const result: GmgnIngestResult = { observationsCreated: 0, duplicatesSkipped: 0, walletsMaterialized: 0, snapshotsWritten: 0, invalidSkipped: 0 };

  for (const row of rows) {
    if (!row.walletAddress || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(row.walletAddress)) { result.invalidSkipped += 1; continue; }

    // 1. Append the raw observation (idempotent on dedupeKey).
    try {
      await prisma.gmgnObservation.create({
        data: {
          chain: row.chain,
          sourceCommand: row.sourceCommand,
          walletAddress: row.walletAddress,
          tokenAddress: row.tokenAddress ?? null,
          activityType: row.activityType ?? null,
          side: row.side ?? null,
          amountToken: row.amountToken ?? null,
          amountUsd: row.amountUsd ?? null,
          providerPnlUsd: row.providerPnlUsd ?? null,
          providerWinRate: row.providerWinRate ?? null,
          providerTradeCount: row.providerTradeCount ?? null,
          rawClassification: (row.rawClassification ?? undefined) as Prisma.InputJsonValue | undefined,
          isKolTagged: row.isKolTagged ?? false,
          isPromoterTagged: row.isPromoterTagged ?? false,
          activityTs: row.activityTs ?? null,
          retrievedAt: row.retrievedAt,
          cursor: row.cursor ?? null,
          dataQuality: row.dataQuality ?? 'complete',
          dedupeKey: row.dedupeKey
        }
      });
      result.observationsCreated += 1;
    } catch (err) {
      if (isUniqueViolation(err)) { result.duplicatesSkipped += 1; continue; }
      throw err;
    }

    // 2. Materialize the wallet observation_only (preserve any existing status).
    //    New KOL/promoter-tagged wallets take that public status; NEVER eligible.
    const desiredNewStatus = row.isKolTagged ? KOL_STATUS : row.isPromoterTagged ? PROMOTER_STATUS : 'observation_only';
    const existing = await prisma.wallet.findUnique({
      where: { address_chain: { address: row.walletAddress, chain: row.chain } },
      select: { id: true, status: true }
    });
    let walletId: string;
    if (existing) {
      walletId = existing.id;
      // PRESERVE existing classification/eligibility. The ONLY allowed
      // transition is observation_only -> public_kol/public_promoter when a
      // GMGN feed adds public-label evidence (crowd analysis) — an already-
      // classified or operator-promoted wallet is left untouched.
      if (existing.status === 'observation_only' && desiredNewStatus !== 'observation_only') {
        await prisma.wallet.update({ where: { id: walletId }, data: { status: desiredNewStatus as never } });
      }
    } else {
      const created = await prisma.wallet.create({
        data: {
          address: row.walletAddress,
          chain: row.chain,
          firstSeenAt: row.activityTs ?? row.retrievedAt,
          lastActiveAt: row.activityTs ?? row.retrievedAt,
          isWatched: false,
          status: desiredNewStatus as never, // observation_only | public_kol | public_promoter — NEVER signal_eligible
          notes: `gmgn:${row.sourceCommand}`
        },
        select: { id: true }
      });
      walletId = created.id;
      result.walletsMaterialized += 1;
    }

    // 3. Provider metrics → shadow snapshot (provider_claimed), NEVER WalletStats.
    if (row.providerPnlUsd != null || row.providerWinRate != null || row.providerTradeCount != null) {
      await prisma.observationProviderSnapshot.upsert({
        where: { walletId_source_window: { walletId, source: `gmgn:${row.sourceCommand}`, window: '30d' } },
        create: {
          walletId,
          source: `gmgn:${row.sourceCommand}`,
          window: '30d',
          pnlUsd: row.providerPnlUsd ?? null,
          winRate: row.providerWinRate ?? null,
          tradeCount: row.providerTradeCount ?? null,
          providerClaimed: true,
          observedAt: row.retrievedAt
        },
        update: {
          pnlUsd: row.providerPnlUsd ?? null,
          winRate: row.providerWinRate ?? null,
          tradeCount: row.providerTradeCount ?? null,
          observedAt: row.retrievedAt
        }
      });
      result.snapshotsWritten += 1;
    }
  }
  return result;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';
}
