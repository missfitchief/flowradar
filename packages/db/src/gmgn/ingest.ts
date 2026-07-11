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
import { isValidSolanaAddress } from '@flowradar/core';
import type { Prisma, PrismaClient } from '@prisma/client';

export interface GmgnObservationInput {
  // sol-only branch (hard rule 14): chain is fixed SOLANA. The column stays a
  // ChainId enum for forward-compat, but ingest validates Solana addresses.
  chain: 'SOLANA';
  sourceCommand: string;
  walletAddress: string;
  tokenAddress?: string | null;
  txHash?: string | null;
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

/**
 * Stable dedupe key over the full IDENTITY tuple (NOT retrievedAt — re-polling
 * the same activity must dedupe). Includes txHash + exact activityType + chain
 * (Codex Task-2 P1): same-second distinct trades, transferIn vs transferOut,
 * and cross-chain rows never collapse. When txHash is present it is the
 * dominant discriminator; when absent, activityType keeps transferIn/Out
 * distinct and the (source,wallet,token,ts,type,side) tuple stands.
 */
export function gmgnDedupeKey(o: Omit<GmgnObservationInput, 'dedupeKey'> & { dedupeKey?: string }): string {
  const tuple = [
    o.chain,
    o.sourceCommand,
    o.walletAddress,
    o.tokenAddress ?? '',
    o.txHash ?? '',
    o.activityTs ? o.activityTs.toISOString() : '',
    o.activityType ?? '',
    o.side ?? ''
  ].join('|');
  return createHash('sha256').update(tuple).digest('hex').slice(0, 32);
}

// ---------------------------------------------------------------------------
// Pure normalizers (feed row → GmgnObservationInput)
// ---------------------------------------------------------------------------

interface NormCtx { sourceCommand: string; retrievedAt: Date; cursor?: string | null; isKolFeed?: boolean }

const numOrNull = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (s === '') return null; // empty / whitespace-only -> null, never "0"
  const n = Number(s);
  return Number.isFinite(n) ? String(n) : null; // missing/garbage stays null, never 0
};
const tsOrNull = (v: unknown): Date | null => {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date((n < 1e12 ? n * 1000 : n)); // seconds vs millis
};
/** Provider label tokens on a maker/holder row (exact, lowercased). */
function labelTokens(info: unknown): string[] {
  if (!info || typeof info !== 'object') return [];
  const m = info as Record<string, unknown>;
  const raw = [m.tag, m.wallet_tag_v2, ...(Array.isArray(m.tags) ? m.tags : [])].filter((t) => t != null);
  return raw.map((t) => String(t).toLowerCase().trim());
}
/** EXACT-token KOL detection (Codex Task-2 P2): explicit is_kol, or a label
 *  token that IS 'kol'/'renowned'/'kol_wallet' — not any substring containing
 *  those letters. */
function detectKol(info: unknown): boolean {
  if (info && typeof info === 'object' && (info as Record<string, unknown>).is_kol === true) return true;
  const KOL = new Set(['kol', 'renowned', 'renowned_wallet', 'kol_wallet']);
  return labelTokens(info).some((t) => KOL.has(t));
}
/** EXACT-token promoter/influencer detection. */
function detectPromoter(info: unknown): boolean {
  const PROMO = new Set(['promoter', 'influencer', 'ambassador', 'shiller']);
  return labelTokens(info).some((t) => PROMO.has(t));
}

function withKey(o: Omit<GmgnObservationInput, 'dedupeKey'>): GmgnObservationInput {
  return { ...o, dedupeKey: gmgnDedupeKey(o) };
}

/** track smartmoney / track kol row → observation. The KOL feed marks every
 *  row KOL by DEFINITION (ctx.isKolFeed), independent of per-row tags. */
export function normalizeSmartmoneyRow(row: Record<string, unknown>, ctx: NormCtx): GmgnObservationInput {
  const sideRaw = String(row.side ?? '').toLowerCase();
  return withKey({
    chain: 'SOLANA',
    sourceCommand: ctx.sourceCommand,
    walletAddress: String(row.maker ?? ''),
    tokenAddress: row.base_address ? String(row.base_address) : null,
    txHash: row.transaction_hash ? String(row.transaction_hash) : null,
    activityType: sideRaw || null,
    side: sideRaw === 'buy' ? 'buy' : sideRaw === 'sell' ? 'sell' : null,
    amountToken: numOrNull(row.token_amount),
    amountUsd: numOrNull(row.amount_usd),
    rawClassification: (row.maker_info as unknown) ?? null,
    // KOL: explicit provider tag OR this IS the dedicated KOL feed.
    isKolTagged: detectKol(row.maker_info) || ctx.isKolFeed === true,
    isPromoterTagged: detectPromoter(row.maker_info),
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
    chain: 'SOLANA',
    sourceCommand: ctx.sourceCommand,
    walletAddress: String(row.wallet ?? ''),
    tokenAddress: row.token ? String(row.token) : null,
    txHash: row.tx_hash ? String(row.tx_hash) : null,
    activityType: (row.event_type as string) ?? null, // KEEPS transferIn vs transferOut distinct
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
    // Real Solana pubkey check (base58 → 32 bytes), same as root import —
    // not just an alphabet/length regex (Codex Task-2 P2).
    if (!isValidSolanaAddress(row.walletAddress)) { result.invalidSkipped += 1; continue; }

    // FAILURE-IDEMPOTENT ORDERING (Codex Task-2 P1 #3): wallet + snapshot
    // (both idempotent upserts) run FIRST, and the unique-guarded observation
    // insert LAST. A mid-row failure leaves the observation NOT created, so a
    // replay redoes every step; a replay after full success re-runs idempotent
    // upserts and hits P2002 on the observation (counted as duplicate).

    // 1. Wallet materialize (race-safe upsert; existing status preserved).
    const desiredNewStatus = row.isKolTagged ? KOL_STATUS : row.isPromoterTagged ? PROMOTER_STATUS : 'observation_only';
    const before = await prisma.wallet.findUnique({
      where: { address_chain: { address: row.walletAddress, chain: row.chain } },
      select: { id: true }
    });
    const wallet = await prisma.wallet.upsert({
      where: { address_chain: { address: row.walletAddress, chain: row.chain } },
      create: {
        address: row.walletAddress,
        chain: row.chain,
        firstSeenAt: row.activityTs ?? row.retrievedAt,
        lastActiveAt: row.activityTs ?? row.retrievedAt,
        isWatched: false,
        status: desiredNewStatus as never, // observation_only | public_kol | public_promoter — NEVER signal_eligible
        notes: `gmgn:${row.sourceCommand}`
      },
      update: {}, // existing row: never re-status via the upsert path
      select: { id: true }
    });
    const walletId = wallet.id;
    if (before === null) result.walletsMaterialized += 1;
    // CONDITIONAL promote — ONLY observation_only -> public status, atomically
    // (updateMany where status='observation_only'). A concurrent operator
    // promotion to signal_eligible between the upsert and here is NEVER
    // clobbered (Codex P1 #1): the WHERE no longer matches.
    if (desiredNewStatus !== 'observation_only') {
      await prisma.wallet.updateMany({
        where: { id: walletId, status: 'observation_only' },
        data: { status: desiredNewStatus as never }
      });
    }

    // 2. Provider metrics → shadow snapshot (provider_claimed), NEVER WalletStats.
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

    // 3. Append the raw observation LAST (idempotent on dedupeKey).
    try {
      await prisma.gmgnObservation.create({
        data: {
          chain: row.chain,
          sourceCommand: row.sourceCommand,
          walletAddress: row.walletAddress,
          tokenAddress: row.tokenAddress ?? null,
          txHash: row.txHash ?? null,
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
  }
  return result;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';
}
