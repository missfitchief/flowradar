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
      // Merge LOCAL (main client) + LIVE (activityClient) so a buy present in
      // either is never missed. When activityClient === prisma the two reads
      // are identical (deduped below).
      const clients = activity === prisma ? [prisma] : [prisma, activity];
      let hasLiveWalletRow = false;
      let tradeInspected = false; // any trade row (any time) proves the trade poller ran
      let postTx = 0;
      let postEdges = 0;
      let firstActivityTs: Date | null = null;
      let firstBuyTs: Date | null = null;
      let firstBuyMint: string | null = null;
      let boughtKnownUsd: number | null = null;

      for (const client of clients) {
        const wallet = await client.wallet.findUnique({ where: { address_chain: { address: r.receiverAddress, chain } }, select: { id: true } });
        if (!wallet) continue;
        hasLiveWalletRow = true;
        const [anyTrade, buys, sells, edges] = await Promise.all([
          client.walletTokenTrade.count({ where: { walletId: wallet.id, chain } }),
          client.walletTokenTrade.findMany({ where: { walletId: wallet.id, chain, action: 'BUY', ts: { gt: r.firstReceiptTs } }, orderBy: [{ ts: 'asc' }, { id: 'asc' }], take: 200, select: { ts: true, amountUsd: true, token: { select: { address: true } } } }),
          client.walletTokenTrade.count({ where: { walletId: wallet.id, chain, action: 'SELL', ts: { gt: r.firstReceiptTs } } }),
          client.moneyFlowEdge.count({ where: { OR: [{ sourceAddress: r.receiverAddress, sourceChain: chain }, { destinationAddress: r.receiverAddress, destinationChain: chain }], ts: { gt: r.firstReceiptTs } } })
        ]);
        if (anyTrade > 0) tradeInspected = true;
        postTx = Math.max(postTx, buys.length + sells);
        postEdges = Math.max(postEdges, edges);
        if (buys.length > 0) {
          const b = buys[0];
          if (firstBuyTs === null || b.ts < firstBuyTs) {
            firstBuyTs = b.ts;
            firstBuyMint = b.token.address;
            const usd = Number(b.amountUsd);
            boughtKnownUsd = usd > 0 ? usd : null;
          }
          if (firstActivityTs === null || b.ts < firstActivityTs) firstActivityTs = b.ts;
        }
      }

      // Honest terminal status. A mere wallet row — or a money-flow EDGE alone
      // (edges are ingested by a DIFFERENT path than trade polling) — is NOT
      // proof the trade history was inspected. "covered" therefore requires
      // evidence the trade poller ran (any trade row) AND no post-receipt buy.
      let status: string;
      const reasons: string[] = [];
      if (firstBuyTs !== null) {
        status = 'deployment_found';
        reasons.push('post_receipt_token_buy_observed');
      } else if (tradeInspected) {
        status = 'covered_no_post_receipt_buy';
        reasons.push(postEdges > 0 ? 'trade_history_polled_post_receipt_transfers_but_no_buy' : 'trade_history_polled_no_post_receipt_buy');
      } else if (hasLiveWalletRow) {
        // Wallet row (and maybe edges) but NO trade-poll evidence — cannot
        // rule out an unobserved buy, so not covered.
        status = 'partial_coverage';
        reasons.push(postEdges > 0 ? 'post_receipt_edges_but_trade_history_not_confirmed_polled' : 'wallet_row_only_no_trade_poll_evidence');
      } else {
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
      // A read failure must NOT leave a prior 'covered' row standing as if
      // still valid — write an honest retryable status for this receiver.
      try {
        const fail = {
          chain,
          receiverAddress: r.receiverAddress,
          sourceEntityKey: [...r.sourceEntityKeys].sort()[0] ?? r.receiverAddress,
          sourceWallets: r.sourceWallets.slice(0, 25),
          firstReceiptTs: r.firstReceiptTs,
          backfillStart: r.firstReceiptTs,
          backfillEnd: now,
          status: 'retryable_provider_failure',
          source: opts.activityClient ? 'live_shadow_db + local' : 'local',
          hasLiveWalletRow: false,
          postReceiptTxObserved: 0,
          postReceiptEdges: 0,
          firstActivityTs: null,
          firstBuyTs: null,
          firstBuyMint: null,
          fundingToBuyDelaySec: null,
          boughtKnownUsd: null,
          entryMcapUsd: null,
          receiverClass: r.receiverClass,
          relationshipTier: null,
          reasonCodes: ['activity_read_failed_this_pass'],
          receiptsJson: { error: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200) } as unknown as Prisma.InputJsonValue,
          caveats: ['activity read failed this pass — status reset to retryable so a stale covered result never lingers'],
          engineVersion: LIVE_RECOVERY_ENGINE_VERSION,
          computedAt: now
        };
        await prisma.receiverActivityBackfill.upsert({ where: { chain_receiverAddress: { chain, receiverAddress: r.receiverAddress } }, create: fail, update: fail });
      } catch {
        /* give up on this receiver this pass */
      }
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
    // No provider key — honest 'missing_credential' availability (distinct
    // from quota 'retryable'), per-item isolated.
    for (const mint of todo) {
      try {
        await write(mint, { name: null, symbol: null, logoUri: null, source: 'unavailable', availability: 'missing_credential', reasons: ['no_helius_key_configured'], lastError: 'HELIUS_API_KEY not configured' });
      } catch (err) {
        report.errors += 1;
        if (report.errorReceipts.length < ERROR_RECEIPTS_MAX) report.errorReceipts.push(toErrorReceipt(mint, err));
      }
    }
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
        // Evaluate symbol and name INDEPENDENTLY for placeholder-ness — a
        // real name-only result must still resolve (not be hidden). A DAS
        // result carrying a LOGO is a real project, so trust it even if its
        // (short) symbol coincidentally prefixes the mint.
        const hasLogo = Boolean(logo);
        const symbolReal = symbol !== null && (hasLogo || !isPlaceholderSymbol(mint, symbol, name));
        const nameReal = name !== null && (hasLogo || !isPlaceholderSymbol(mint, name, name));
        if (symbolReal || nameReal) {
          await write(mint, {
            name: nameReal ? name : null,
            symbol: symbolReal ? symbol : null,
            logoUri: logo ?? null,
            source: 'helius_das',
            availability: 'resolved',
            reasons: [symbolReal ? 'das_symbol_resolved' : 'das_name_only_resolved']
          });
        } else if (name || symbol) {
          // Something came back but it is a mint-prefix placeholder.
          await write(mint, { name: null, symbol: null, logoUri: logo ?? null, source: 'helius_das', availability: 'placeholder_only', reasons: ['das_metadata_is_mint_prefix_placeholder'] });
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
