// FlowRadar — live-recovery sprint builders:
//   1. buildReceiverActivityBackfill — per-receiver post-receipt outcome read
//      from local + (optionally) the live shadow DB, honest terminal status.
//   2. buildTokenMetadata — resolve real name/symbol/logo via Helius DAS
//      getAssetBatch (bulk, ONE request per ~1000 mints — does not compete
//      with per-wallet polling); honest availability when quota-exhausted.
//   3. isPlaceholderSymbol — detect the ingest mint-prefix placeholder so the
//      UI never shows a mint substring as a token symbol.
// SHADOW-ONLY, observation_only.

import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { toErrorReceipt, ERROR_RECEIPTS_MAX } from '../dormancy/activity';
import type { WalletErrorReceipt } from '../dormancy/activity';

export const LIVE_RECOVERY_ENGINE_VERSION = 1;

/** The ingest stored `symbol`/`name` as the first ~4 chars of the mint — that
 *  is a placeholder, NOT a real symbol. Detected precisely so a legitimate
 *  short symbol (e.g. "D") that merely coincides with the mint's first letter
 *  is NOT rejected: require a >=3-char prefix match, and — the ingest
 *  signature — name === symbol. */
export function isPlaceholderSymbol(mint: string, symbol: string | null | undefined, name?: string | null): boolean {
  if (!symbol) return true;
  const prefixMatch = symbol.length >= 3 && mint.startsWith(symbol);
  if (!prefixMatch) return false;
  // A real symbol usually differs from the token name; the ingest placeholder
  // set name === symbol === mint prefix.
  return name === undefined || name === null || name === symbol;
}

// ---------------------------------------------------------------------------
// 1. Receiver post-receipt activity backfill
// ---------------------------------------------------------------------------
export interface ReceiverBackfillReport {
  receiversConsidered: number;
  written: number;
  byStatus: Record<string, number>;
  deploymentsFound: number;
  errors: number;
  errorReceipts: WalletErrorReceipt[];
}

export async function buildReceiverActivityBackfill(
  prisma: PrismaClient,
  opts: {
    chain?: 'SOLANA' | 'BSC';
    /** Read-only client for the LIVE shadow DB (richer post-receipt activity);
     *  defaults to the same client when not supplied. */
    activityClient?: PrismaClient;
    limit?: number;
    now?: Date;
  } = {}
): Promise<ReceiverBackfillReport> {
  const chain = opts.chain ?? 'SOLANA';
  const activity = opts.activityClient ?? prisma;
  const limit = opts.limit ?? 1000;
  const now = opts.now ?? new Date();

  const receivers = await prisma.receiverEnrollment.findMany({
    where: { chain },
    orderBy: [{ deployedTokenCount: 'desc' }, { receiverAddress: 'asc' }], // highest-confidence first
    take: limit,
    select: { receiverAddress: true, sourceEntityKeys: true, sourceWallets: true, receiverClass: true, firstReceiptTs: true }
  });

  const report: ReceiverBackfillReport = { receiversConsidered: receivers.length, written: 0, byStatus: {}, deploymentsFound: 0, errors: 0, errorReceipts: [] };

  for (const r of receivers) {
    try {
      const wallet = await activity.wallet.findUnique({
        where: { address_chain: { address: r.receiverAddress, chain } },
        select: { id: true }
      });
      const hasLiveWalletRow = wallet !== null;
      let postTx = 0;
      let postEdges = 0;
      let firstActivityTs: Date | null = null;
      let firstBuyTs: Date | null = null;
      let firstBuyMint: string | null = null;
      let boughtKnownUsd: number | null = null;

      if (wallet) {
        const [buys, sells, edges] = await Promise.all([
          activity.walletTokenTrade.findMany({
            where: { walletId: wallet.id, chain, action: 'BUY', ts: { gt: r.firstReceiptTs } },
            orderBy: [{ ts: 'asc' }, { id: 'asc' }],
            take: 200,
            select: { ts: true, amountUsd: true, token: { select: { address: true } } }
          }),
          activity.walletTokenTrade.count({ where: { walletId: wallet.id, chain, action: 'SELL', ts: { gt: r.firstReceiptTs } } }),
          activity.moneyFlowEdge.findMany({
            where: {
              OR: [
                { sourceAddress: r.receiverAddress, sourceChain: chain },
                { destinationAddress: r.receiverAddress, destinationChain: chain }
              ],
              ts: { gt: r.firstReceiptTs }
            },
            orderBy: [{ ts: 'asc' }, { id: 'asc' }],
            take: 500,
            select: { ts: true }
          })
        ]);
        postTx = buys.length + sells;
        postEdges = edges.length;
        const firstTsCandidates = [buys[0]?.ts, edges[0]?.ts].filter((x): x is Date => x !== undefined);
        firstActivityTs = firstTsCandidates.length ? new Date(Math.min(...firstTsCandidates.map((d) => d.getTime()))) : null;
        if (buys.length > 0) {
          firstBuyTs = buys[0].ts;
          firstBuyMint = buys[0].token.address;
          const usd = Number(buys[0].amountUsd);
          boughtKnownUsd = usd > 0 ? usd : null;
        }
      }

      // Honest terminal status. A mere wallet row is NOT proof the receiver's
      // history was inspected (enrollment can create the row without polling).
      // "covered" therefore requires OBSERVED post-receipt activity.
      let status: string;
      const reasons: string[] = [];
      if (firstBuyTs !== null) {
        status = 'deployment_found';
        reasons.push('post_receipt_token_buy_observed');
      } else if (postEdges > 0 || postTx > 0) {
        // Real post-receipt activity was observed (transfers/sells) but no buy
        // — an honest negative, never unknown.
        status = 'covered_no_post_receipt_buy';
        reasons.push('post_receipt_activity_observed_but_no_token_buy');
      } else if (hasLiveWalletRow) {
        // Wallet row exists but NO post-receipt activity was observed — cannot
        // distinguish "genuinely quiet" from "not yet polled", so not covered.
        status = 'partial_coverage';
        reasons.push('wallet_row_exists_but_no_post_receipt_activity_observed');
      } else {
        // No local/live wallet row: the live run has not yet collected this
        // receiver (Helius rate-limited) — retryable as coverage grows.
        status = 'retryable_provider_failure';
        reasons.push('no_local_or_live_wallet_row_provider_saturated');
      }

      const delay = firstBuyTs !== null ? Math.round((firstBuyTs.getTime() - r.firstReceiptTs.getTime()) / 1000) : null;
      const data = {
        chain,
        receiverAddress: r.receiverAddress,
        sourceEntityKey: [...r.sourceEntityKeys].sort()[0] ?? r.receiverAddress,
        sourceWallets: r.sourceWallets.slice(0, 25),
        firstReceiptTs: r.firstReceiptTs,
        backfillStart: r.firstReceiptTs,
        backfillEnd: now,
        status,
        source: opts.activityClient ? 'live_shadow_db + local' : 'local',
        hasLiveWalletRow,
        postReceiptTxObserved: postTx,
        postReceiptEdges: postEdges,
        firstActivityTs,
        firstBuyTs,
        firstBuyMint,
        fundingToBuyDelaySec: delay,
        boughtKnownUsd,
        entryMcapUsd: null,
        receiverClass: r.receiverClass,
        relationshipTier: null,
        reasonCodes: reasons,
        receiptsJson: { hasLiveWalletRow, postReceiptTxObserved: postTx, postReceiptEdges: postEdges } as unknown as Prisma.InputJsonValue,
        caveats: [
          'coverage is bounded local + live-collected observation; a wallet not yet polled by the live run is retryable, never a proven absence',
          'observation_only: no eligibility, promotion, or identity claims'
        ],
        engineVersion: LIVE_RECOVERY_ENGINE_VERSION,
        computedAt: now
      };
      await prisma.receiverActivityBackfill.upsert({ where: { chain_receiverAddress: { chain, receiverAddress: r.receiverAddress } }, create: data, update: data });
      report.written += 1;
      report.byStatus[status] = (report.byStatus[status] ?? 0) + 1;
      if (status === 'deployment_found') report.deploymentsFound += 1;
    } catch (err) {
      report.errors += 1;
      if (report.errorReceipts.length < ERROR_RECEIPTS_MAX) report.errorReceipts.push(toErrorReceipt(r.receiverAddress, err));
    }
  }
  return report;
}

// ---------------------------------------------------------------------------
// 2. Token metadata backfill (Helius DAS getAssetBatch, bulk + resumable)
// ---------------------------------------------------------------------------
interface DasAsset {
  id?: string;
  content?: { metadata?: { name?: string; symbol?: string }; links?: { image?: string }; files?: { uri?: string }[] };
}

export interface TokenMetadataReport {
  mintsConsidered: number;
  written: number;
  resolved: number;
  placeholderOnly: number;
  retryable: number;
  unavailable: number;
  requestsUsed: number;
  errors: number;
  errorReceipts: WalletErrorReceipt[];
}

export async function buildTokenMetadata(
  prisma: PrismaClient,
  opts: {
    chain?: 'SOLANA' | 'BSC';
    /** Explicit mints; default = the product-relevant set (runners +
     *  candidates + tokens appearing in capital chains). */
    mints?: string[];
    heliusApiKey?: string;
    /** Max getAssetBatch REQUESTS this pass (each covers up to 1000 mints). */
    maxRequests?: number;
    batchSize?: number;
    /** Re-resolve mints already resolved (default false — resume-friendly). */
    reresolve?: boolean;
    fetchImpl?: typeof fetch;
    now?: Date;
  } = {}
): Promise<TokenMetadataReport> {
  const chain = opts.chain ?? 'SOLANA';
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxRequests = opts.maxRequests ?? 5;
  const batchSize = Math.min(opts.batchSize ?? 1000, 1000);
  const now = opts.now ?? new Date();

  // Relevant mints: verified runners + candidate tokens + capital-chain tokens.
  let mints: string[];
  if (opts.mints) {
    mints = [...new Set(opts.mints)].sort();
  } else {
    const [runners, cands, chainToks] = await Promise.all([
      prisma.tokenLifecycle.findMany({ where: { runnerClass: 'verified_above_10m' }, select: { mint: true }, take: 5000 }),
      prisma.tokenCandidateScore.findMany({ where: { chain }, select: { mint: true }, take: 5000 }),
      prisma.capitalChain.findMany({ where: { chain, tokenBought: { not: null } }, select: { tokenBought: true }, take: 5000 })
    ]);
    mints = [...new Set([...runners.map((r) => r.mint), ...cands.map((c) => c.mint), ...chainToks.map((c) => c.tokenBought!).filter(Boolean)])].sort();
  }

  const report: TokenMetadataReport = { mintsConsidered: mints.length, written: 0, resolved: 0, placeholderOnly: 0, retryable: 0, unavailable: 0, requestsUsed: 0, errors: 0, errorReceipts: [] };

  // Skip mints in a TERMINAL state (resolved | unavailable | placeholder_only)
  // — only 'retryable' rows and never-attempted mints are (re)fetched, so a
  // block of unavailable rows never starves later mints of the request budget.
  const already = new Set(
    opts.reresolve
      ? []
      : (await prisma.tokenMetadata.findMany({ where: { chain, mint: { in: mints }, availability: { in: ['resolved', 'unavailable', 'placeholder_only'] } }, select: { mint: true } })).map((m) => m.mint)
  );
  const todo = mints.filter((m) => !already.has(m));

  const write = async (mint: string, fields: { name: string | null; symbol: string | null; logoUri: string | null; source: string; availability: string; lastError?: string | null; reasons: string[] }) => {
    const data = {
      chain,
      mint,
      name: fields.name,
      symbol: fields.symbol,
      logoUri: fields.logoUri,
      source: fields.source,
      availability: fields.availability,
      lastError: fields.lastError ?? null,
      fetchedAt: fields.availability === 'resolved' ? now : null,
      reasonCodes: fields.reasons,
      engineVersion: LIVE_RECOVERY_ENGINE_VERSION,
      computedAt: now
    };
    await prisma.tokenMetadata.upsert({ where: { chain_mint: { chain, mint } }, create: data, update: data });
    report.written += 1;
    if (fields.availability === 'resolved') report.resolved += 1;
    else if (fields.availability === 'retryable') report.retryable += 1;
    else if (fields.availability === 'placeholder_only') report.placeholderOnly += 1;
    else report.unavailable += 1;
  };

  if (!opts.heliusApiKey) {
    // No provider — record honest retryable for everything not yet resolved.
    for (const mint of todo) await write(mint, { name: null, symbol: null, logoUri: null, source: 'unavailable', availability: 'retryable', reasons: ['no_helius_key_configured'], lastError: 'HELIUS_API_KEY not configured' });
    return report;
  }

  for (let i = 0; i < todo.length; i += batchSize) {
    if (report.requestsUsed >= maxRequests) break; // bounded — resume next run
    const batch = todo.slice(i, i + batchSize);
    report.requestsUsed += 1;
    let assets: DasAsset[] | null = null;
    let lastError: string | null = null;
    try {
      const res = await fetchImpl(`https://mainnet.helius-rpc.com/?api-key=${opts.heliusApiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'meta', method: 'getAssetBatch', params: { ids: batch } }),
        signal: AbortSignal.timeout(20_000)
      });
      if (!res.ok) {
        lastError = `http_${res.status}`;
        if (res.status === 429) lastError = 'http_429_rate_limited';
      } else {
        const j = (await res.json()) as { result?: DasAsset[]; error?: { message?: string } };
        if (Array.isArray(j.result)) assets = j.result;
        else lastError = j.error?.message ?? 'no_result';
      }
    } catch (e) {
      lastError = e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200);
    }

    if (assets === null) {
      // Provider failure (quota/rate-limit/network) — retryable for the batch.
      const retryable = /max usage|429|rate|quota/i.test(lastError ?? '');
      for (const mint of batch) {
        try {
          await write(mint, { name: null, symbol: null, logoUri: null, source: 'unavailable', availability: retryable ? 'retryable' : 'unavailable', lastError, reasons: [retryable ? 'provider_quota_or_rate_limited' : 'provider_error'] });
        } catch (err) {
          report.errors += 1;
          if (report.errorReceipts.length < ERROR_RECEIPTS_MAX) report.errorReceipts.push(toErrorReceipt(mint, err));
        }
      }
      continue;
    }
    const byId = new Map(assets.filter((a): a is DasAsset & { id: string } => Boolean(a && a.id)).map((a) => [a.id, a]));
    for (const mint of batch) {
      // Per-ITEM isolation: one bad upsert never aborts the rest of the batch.
      try {
        const a = byId.get(mint);
        const name = a?.content?.metadata?.name?.trim() || null;
        const symbol = a?.content?.metadata?.symbol?.trim() || null;
        const logo = a?.content?.links?.image ?? a?.content?.files?.find((f) => f.uri)?.uri ?? null;
        if (name || symbol) {
          // A DAS symbol/name that is still just the mint prefix is a
          // placeholder, not a real resolution.
          if (isPlaceholderSymbol(mint, symbol, name)) {
            await write(mint, { name: null, symbol: null, logoUri: logo ?? null, source: 'helius_das', availability: 'placeholder_only', reasons: ['das_metadata_is_mint_prefix_placeholder'] });
          } else {
            await write(mint, { name, symbol, logoUri: logo ?? null, source: 'helius_das', availability: 'resolved', reasons: ['das_metadata_resolved'] });
          }
        } else {
          await write(mint, { name: null, symbol: null, logoUri: null, source: 'helius_das', availability: 'unavailable', reasons: ['das_returned_no_name_or_symbol'] });
        }
      } catch (err) {
        report.errors += 1;
        if (report.errorReceipts.length < ERROR_RECEIPTS_MAX) report.errorReceipts.push(toErrorReceipt(mint, err));
      }
    }
  }
  return report;
}
