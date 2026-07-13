import { randomUUID } from 'node:crypto';
import type { Chain } from '@flowradar/core';
import type { TokenTopTrader, TokenTopTradersProvider } from '@flowradar/providers';
import { Prisma, type ChainId, type PrismaClient } from '@prisma/client';
import { validateProviderClaim, type TopPnlValidation } from '../runnermining/topPnl';
import { buildWalletDnaProfiles } from '../runnermining/walletDna';

export const UNIFIED_DISCOVERY_ENGINE_VERSION = 1;
export const HISTORICAL_WINNER_MCAP_USD = 10_000_000;

export interface HistoricalUniverseSeed {
  chain: ChainId;
  tokenAddress: string;
  source: string;
  historicalWinnerStatus?: 'verified_above_10m' | 'operator_core' | 'candidate';
  athMcapUsd?: number | null;
  athTs?: Date | null;
  coverage?: 'covered' | 'partially_covered' | 'unavailable';
  evidence?: Record<string, unknown>;
}

export interface HistoricalTraderProvider {
  name: string;
  adapter: TokenTopTradersProvider;
  /** Provider claims whose time window does not match local history cannot be
   * promoted to locally_verified or conflicting by a magnitude comparison. */
  windowsComparable?: boolean;
  timeFrame?: '30m' | '1h' | '2h' | '4h' | '6h' | '8h' | '12h' | '24h';
}

export interface UnifiedDiscoveryOptions {
  chains?: ChainId[];
  limit?: number;
  perTokenLocalCap?: number;
  perTokenProviderCap?: number;
  maxTradesPerToken?: number;
  requestBudget?: number;
  retryUnavailable?: boolean;
  providers?: Partial<Record<ChainId, HistoricalTraderProvider>>;
  buildDna?: boolean;
  now?: Date;
}

export interface UnifiedDiscoveryReport {
  runId: string;
  universeConsidered: number;
  tokensProcessed: number;
  tokensPartial: number;
  tokensUnavailable: number;
  localCandidates: number;
  providerCandidates: number;
  walletsObserved: number;
  retryableFailures: number;
  peakHeapBytes: number;
  throughputPerSec: number;
  byChain: Record<string, { processed: number; partial: number; unavailable: number; candidates: number }>;
  errors: Array<{ chain: ChainId; tokenAddress: string; message: string }>;
}

interface LocalView {
  buyCount: number;
  sellCount: number;
  boughtUsd: number | null;
  soldUsd: number | null;
  realizedProxyUsd: number | null;
  firstBuyTs: Date | null;
  firstSellTs: Date | null;
  lastSellTs: Date | null;
  unpricedTrades: number;
  truncated: boolean;
}

/**
 * Imports every locally canonical historical winner plus explicit operator
 * core entries into one persisted universe. Existing sources/evidence are
 * merged; processed rows are not reset by a harmless resync.
 */
export async function syncHistoricalTokenUniverse(
  prisma: PrismaClient,
  options: { operatorCore?: HistoricalUniverseSeed[]; maxLocalTokens?: number; now?: Date } = {}
): Promise<{ upserted: number; bySource: Record<string, number> }> {
  const maxLocalTokens = clamp(options.maxLocalTokens ?? 50_000, 1, 250_000);
  const now = options.now ?? new Date();
  const seeds: HistoricalUniverseSeed[] = [...(options.operatorCore ?? [])];

  const solana = await prisma.tokenLifecycle.findMany({
    where: { runnerClass: 'verified_above_10m' },
    orderBy: { mint: 'asc' },
    take: maxLocalTokens,
    select: { mint: true, athMcapUsd: true, athTs: true, coverage: true, evidenceJson: true }
  });
  for (const row of solana) {
    seeds.push({
      chain: 'SOLANA',
      tokenAddress: row.mint,
      source: 'solana_token_lifecycle',
      historicalWinnerStatus: 'verified_above_10m',
      athMcapUsd: decimalNumber(row.athMcapUsd),
      athTs: row.athTs,
      coverage: row.coverage === 'covered' ? 'covered' : 'partially_covered',
      evidence: { lifecycleEvidence: row.evidenceJson }
    });
  }

  const snapshots = await prisma.tokenMarketSnapshot.findMany({
    where: { marketCapUsd: { gte: HISTORICAL_WINNER_MCAP_USD } },
    orderBy: [{ tokenId: 'asc' }, { marketCapUsd: 'desc' }, { ts: 'asc' }],
    distinct: ['tokenId'],
    take: maxLocalTokens,
    select: { marketCapUsd: true, ts: true, source: true, token: { select: { chain: true, address: true } } }
  });
  for (const row of snapshots) {
    seeds.push({
      chain: row.token.chain,
      tokenAddress: row.token.address,
      source: `local_market_snapshot:${row.source}`,
      historicalWinnerStatus: 'verified_above_10m',
      athMcapUsd: decimalNumber(row.marketCapUsd),
      athTs: row.ts,
      coverage: 'partially_covered',
      evidence: { threshold: HISTORICAL_WINNER_MCAP_USD, snapshotTs: row.ts.toISOString(), snapshotSource: row.source }
    });
  }

  const grouped = new Map<string, HistoricalUniverseSeed[]>();
  for (const seed of seeds) {
    const normalized = normalizeAddress(seed.chain, seed.tokenAddress);
    const key = `${seed.chain}:${normalized}`;
    const bucket = grouped.get(key) ?? [];
    bucket.push({ ...seed, tokenAddress: normalized });
    grouped.set(key, bucket);
  }

  const bySource: Record<string, number> = {};
  let upserted = 0;
  for (const bucket of grouped.values()) {
    const first = bucket[0];
    if (!validAddress(first.chain, first.tokenAddress)) continue;
    const sources = [...new Set(bucket.map((x) => x.source))].sort();
    for (const source of sources) bySource[source] = (bySource[source] ?? 0) + 1;
    const verified = bucket.some((x) => x.historicalWinnerStatus === 'verified_above_10m');
    const operatorCore = bucket.some((x) => x.historicalWinnerStatus === 'operator_core');
    const maxAth = bucket.reduce<number | null>((best, x) => x.athMcapUsd == null ? best : Math.max(best ?? x.athMcapUsd, x.athMcapUsd), null);
    const athSeed = [...bucket].filter((x) => x.athTs).sort((a, b) => (a.athTs!.getTime() - b.athTs!.getTime()))[0];
    const existing = await prisma.historicalTokenUniverse.findUnique({
      where: { chain_tokenAddress: { chain: first.chain, tokenAddress: first.tokenAddress } },
      select: { sources: true, processingStatus: true, evidenceJson: true }
    });
    const mergedSources = [...new Set([...(existing?.sources ?? []), ...sources])].sort();
    const priorObservations = readUniverseObservations(existing?.evidenceJson);
    const currentObservations = bucket.map((x) => ({ source: x.source, coverage: x.coverage ?? null, evidence: x.evidence ?? null }));
    const observations = [...new Map([...priorObservations, ...currentObservations].map((x) => [x.source, x])).values()].slice(-100);
    const evidence = { observations, refreshedAt: now.toISOString() };
    const hasNewSource = sources.some((source) => !(existing?.sources ?? []).includes(source));
    await prisma.historicalTokenUniverse.upsert({
      where: { chain_tokenAddress: { chain: first.chain, tokenAddress: first.tokenAddress } },
      create: {
        chain: first.chain,
        tokenAddress: first.tokenAddress,
        sources: mergedSources,
        historicalWinnerStatus: verified ? 'verified_above_10m' : operatorCore ? 'operator_core' : 'candidate',
        athMcapUsd: maxAth,
        athTs: athSeed?.athTs ?? null,
        coverage: bucket.some((x) => x.coverage === 'covered') ? 'covered' : bucket.some((x) => x.coverage === 'partially_covered') ? 'partially_covered' : 'unavailable',
        processingStatus: 'pending',
        evidenceJson: json(evidence)
      },
      update: {
        sources: mergedSources,
        historicalWinnerStatus: verified ? 'verified_above_10m' : operatorCore ? 'operator_core' : 'candidate',
        athMcapUsd: maxAth,
        athTs: athSeed?.athTs ?? null,
        coverage: bucket.some((x) => x.coverage === 'covered') ? 'covered' : bucket.some((x) => x.coverage === 'partially_covered') ? 'partially_covered' : 'unavailable',
        evidenceJson: json(evidence),
        processingStatus: hasNewSource ? 'pending' : existing?.processingStatus ?? 'pending'
      }
    });
    upserted += 1;
  }
  return { upserted, bySource };
}

/** Unified, persisted and resumable profitable-wallet discovery across every
 * configured chain. Provider adapters are injected and already typed; this
 * function never guesses an endpoint or response shape. */
export async function runUnifiedProfitableWalletDiscovery(
  prisma: PrismaClient,
  options: UnifiedDiscoveryOptions = {}
): Promise<UnifiedDiscoveryReport> {
  const now = options.now ?? new Date();
  const started = Date.now();
  const runId = randomUUID();
  const chains = options.chains ?? ['SOLANA', 'ETHEREUM', 'BASE', 'ARBITRUM', 'BSC'];
  const limit = clamp(options.limit ?? 1_000, 1, 100_000);
  const localCap = clamp(options.perTokenLocalCap ?? 20, 1, 100);
  const providerCap = clamp(options.perTokenProviderCap ?? 20, 1, 100);
  const maxTrades = clamp(options.maxTradesPerToken ?? 10_000, 100, 250_000);
  const requestBudget = clamp(options.requestBudget ?? 500, 0, 50_000);
  let providerRequests = 0;

  const report: UnifiedDiscoveryReport = {
    runId,
    universeConsidered: 0,
    tokensProcessed: 0,
    tokensPartial: 0,
    tokensUnavailable: 0,
    localCandidates: 0,
    providerCandidates: 0,
    walletsObserved: 0,
    retryableFailures: 0,
    peakHeapBytes: process.memoryUsage().heapUsed,
    throughputPerSec: 0,
    byChain: {},
    errors: []
  };
  for (const chain of chains) report.byChain[chain] = { processed: 0, partial: 0, unavailable: 0, candidates: 0 };

  await prisma.profitableWalletDiscoveryRun.create({
    data: { id: runId, startedAt: now, status: 'running', metadataJson: json({ chains, requestBudget, mockMode: process.env.MOCK_MODE }) }
  });

  try {
    const statuses = options.retryUnavailable
      ? ['pending', 'retryable', 'unavailable']
      : ['pending', 'retryable'];
    const universe = await prisma.historicalTokenUniverse.findMany({
      where: {
        chain: { in: chains },
        historicalWinnerStatus: { in: ['verified_above_10m', 'operator_core'] },
        processingStatus: { in: statuses },
        OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }]
      },
      orderBy: [{ chain: 'asc' }, { tokenAddress: 'asc' }],
      take: limit
    });
    report.universeConsidered = universe.length;
    const observed = new Set<string>();
    const dnaByChain = new Map<ChainId, Set<string>>();
    const rootRows = await prisma.lineageRoot.findMany({ select: { wallet: { select: { chain: true, address: true } } }, take: 100_000 });
    const operatorRoots = new Set(rootRows.map((row) => `${row.wallet.chain}:${normalizeAddress(row.wallet.chain, row.wallet.address)}`));

    for (const member of universe) {
      const claimed = await prisma.historicalTokenUniverse.updateMany({
        where: { id: member.id, processingStatus: member.processingStatus },
        data: { processingStatus: 'processing', lastError: null }
      });
      if (claimed.count !== 1) continue;
      try {
        const token = await prisma.token.findUnique({
          where: { chain_address: { chain: member.chain, address: member.tokenAddress } },
          select: { id: true }
        });
        const local = token ? await loadLocalViews(prisma, member.chain, token.id, maxTrades) : { byWallet: new Map<string, LocalView>(), truncated: false };
        const ranked = [...local.byWallet.entries()]
          .sort((a, b) => (b[1].realizedProxyUsd ?? -Infinity) - (a[1].realizedProxyUsd ?? -Infinity) || a[0].localeCompare(b[0]))
          .slice(0, localCap);

        for (let index = 0; index < ranked.length; index += 1) {
          const [wallet, view] = ranked[index];
          if (operatorRoots.has(`${member.chain}:${wallet}`)) continue;
          const validation: TopPnlValidation = view.realizedProxyUsd !== null && !view.truncated && view.unpricedTrades === 0
            ? 'locally_verified'
            : 'incomplete';
          await persistCandidate(prisma, {
            chain: member.chain,
            tokenAddress: member.tokenAddress,
            wallet,
            source: 'local_reconstruction',
            rank: index + 1,
            item: null,
            view,
            validation,
            confidence: validation === 'locally_verified' ? 80 : 35,
            reasonCodes: validation === 'locally_verified' ? ['fully_priced_local_position'] : ['bounded_or_unpriced_local_view'],
            coverage: local.truncated || member.coverage !== 'covered' ? 'local_partial' : 'local_full',
            providerWindow: null,
            now
          });
          await observeWallet(prisma, member.chain, wallet, view.firstBuyTs ?? now, view.lastSellTs ?? view.firstBuyTs ?? now);
          observed.add(`${member.chain}:${wallet}`);
          addToSet(dnaByChain, member.chain, wallet);
          report.localCandidates += 1;
        }

        let providerFailure: string | null = null;
        const provider = options.providers?.[member.chain];
        const providerDeferred = Boolean(provider && providerRequests >= requestBudget);
        if (provider && !providerDeferred) {
          const fetchState = await prisma.topPnlFetchState.findUnique({
            where: { chain_mint_provider: { chain: member.chain, mint: member.tokenAddress, provider: provider.name } }
          });
          if (!fetchState || fetchState.status === 'provider_error') {
            providerRequests += 1;
            try {
              const items = await provider.adapter.getTopTraders(member.chain as Chain, member.tokenAddress, {
                limit: providerCap,
                sortBy: 'realized_pnl',
                timeFrame: provider.timeFrame ?? '24h'
              });
              for (let index = 0; index < items.length; index += 1) {
                const item = items[index];
                if (!validAddress(member.chain, item.walletAddress)) continue;
                const wallet = normalizeAddress(member.chain, item.walletAddress);
                if (operatorRoots.has(`${member.chain}:${wallet}`)) continue;
                const view = local.byWallet.get(wallet) ?? null;
                const verdict = validateProviderClaim({
                  claimedRealizedPnlUsd: finiteOrNull(item.realizedPnlUsd),
                  localRealizedProxyUsd: view?.realizedProxyUsd ?? null,
                  hasLocalTrades: view !== null,
                  localUnpriced: (view?.unpricedTrades ?? 0) > 0,
                  localTruncated: local.truncated || member.coverage !== 'covered',
                  malformed: false,
                  windowsComparable: provider.windowsComparable === true
                });
                await persistCandidate(prisma, {
                  chain: member.chain,
                  tokenAddress: member.tokenAddress,
                  wallet,
                  source: provider.name,
                  rank: index + 1,
                  item,
                  view,
                  validation: verdict.validation,
                  confidence: verdict.confidence,
                  reasonCodes: verdict.reasonCodes,
                  coverage: view ? (local.truncated ? 'local_partial' : 'local_full') : 'none',
                  providerWindow: provider.timeFrame ?? '24h',
                  now
                });
                await observeWallet(prisma, member.chain, wallet, view?.firstBuyTs ?? now, view?.lastSellTs ?? view?.firstBuyTs ?? now);
                observed.add(`${member.chain}:${wallet}`);
                addToSet(dnaByChain, member.chain, wallet);
                report.providerCandidates += 1;
              }
              await prisma.topPnlFetchState.upsert({
                where: { chain_mint_provider: { chain: member.chain, mint: member.tokenAddress, provider: provider.name } },
                create: { chain: member.chain, mint: member.tokenAddress, provider: provider.name, status: items.length ? 'fetched' : 'empty', itemCount: items.length, fetchedAt: now },
                update: { status: items.length ? 'fetched' : 'empty', itemCount: items.length, fetchedAt: now, lastError: null }
              });
            } catch (error) {
              providerFailure = errorMessage(error);
              await prisma.topPnlFetchState.upsert({
                where: { chain_mint_provider: { chain: member.chain, mint: member.tokenAddress, provider: provider.name } },
                create: { chain: member.chain, mint: member.tokenAddress, provider: provider.name, status: 'provider_error', retryCount: 1, lastError: providerFailure },
                update: { status: 'provider_error', retryCount: { increment: 1 }, lastError: providerFailure }
              });
            }
          }
        }

        const candidateCount = await prisma.tokenTopPnlCandidate.count({ where: { chain: member.chain, mint: member.tokenAddress } });
        const noEvidence = candidateCount === 0;
        const status = providerDeferred && noEvidence
          ? 'pending'
          : providerFailure
          ? (ranked.length ? 'partial' : 'retryable')
          : noEvidence
            ? (provider ? 'unavailable' : 'unavailable')
            : local.truncated || member.coverage !== 'covered' ? 'partial' : 'processed';
        await prisma.historicalTokenUniverse.update({
          where: { id: member.id },
          data: {
            processingStatus: status,
            lastProcessedAt: now,
            lastError: providerFailure,
            retryCount: providerFailure ? { increment: 1 } : undefined,
            nextRetryAt: providerFailure ? new Date(now.getTime() + retryDelayMs(member.retryCount + 1)) : null
          }
        });
        await persistExtractionStatus(prisma, member.chain, member.tokenAddress, token !== null, local.byWallet.size > 0, providerFailure, now);
        if (status === 'processed') {
          report.tokensProcessed += 1;
          report.byChain[member.chain].processed += 1;
        } else if (status === 'partial') {
          report.tokensPartial += 1;
          report.byChain[member.chain].partial += 1;
        } else if (status === 'retryable' || status === 'pending') {
          report.retryableFailures += 1;
          report.byChain[member.chain].unavailable += 1;
        } else {
          report.tokensUnavailable += 1;
          report.byChain[member.chain].unavailable += 1;
        }
        report.byChain[member.chain].candidates += candidateCount;
      } catch (error) {
        const message = errorMessage(error);
        report.retryableFailures += 1;
        if (report.errors.length < 100) report.errors.push({ chain: member.chain, tokenAddress: member.tokenAddress, message });
        await prisma.historicalTokenUniverse.update({
          where: { id: member.id },
          data: { processingStatus: 'retryable', retryCount: { increment: 1 }, lastError: message, nextRetryAt: new Date(now.getTime() + retryDelayMs(member.retryCount + 1)) }
        });
      }
      report.peakHeapBytes = Math.max(report.peakHeapBytes, process.memoryUsage().heapUsed);
    }

    if (options.buildDna !== false) {
      for (const chain of ['SOLANA', 'BSC'] as const) {
        const wallets = [...(dnaByChain.get(chain) ?? [])];
        if (wallets.length) await buildWalletDnaProfiles(prisma, { chain, walletAddresses: wallets, limit: wallets.length, now });
      }
    }

    report.walletsObserved = observed.size;
    report.throughputPerSec = report.universeConsidered / Math.max((Date.now() - started) / 1_000, 0.001);
    await prisma.profitableWalletDiscoveryRun.update({
      where: { id: runId },
      data: {
        completedAt: new Date(), status: report.retryableFailures ? 'partial' : 'completed', universeConsidered: report.universeConsidered,
        tokensProcessed: report.tokensProcessed, tokensPartial: report.tokensPartial, tokensUnavailable: report.tokensUnavailable,
        localCandidates: report.localCandidates, providerCandidates: report.providerCandidates, walletsObserved: report.walletsObserved,
        retryableFailures: report.retryableFailures, peakHeapBytes: BigInt(report.peakHeapBytes), throughputPerSec: report.throughputPerSec,
        metadataJson: json({ providerRequests, byChain: report.byChain, errors: report.errors })
      }
    });
    return report;
  } catch (error) {
    await prisma.profitableWalletDiscoveryRun.update({ where: { id: runId }, data: { completedAt: new Date(), status: 'failed', error: errorMessage(error) } });
    throw error;
  }
}

async function loadLocalViews(prisma: PrismaClient, chain: ChainId, tokenId: string, maxTrades: number) {
  const rows = await prisma.walletTokenTrade.findMany({
    where: { tokenId, chain, action: { in: ['BUY', 'SELL'] } },
    orderBy: [{ ts: 'asc' }, { id: 'asc' }],
    take: maxTrades + 1,
    select: { action: true, amountUsd: true, ts: true, wallet: { select: { address: true } } }
  });
  const truncated = rows.length > maxTrades;
  const byWallet = new Map<string, LocalView>();
  for (const row of rows.slice(0, maxTrades)) {
    const wallet = normalizeAddress(chain, row.wallet.address);
    const view = byWallet.get(wallet) ?? { buyCount: 0, sellCount: 0, boughtUsd: null, soldUsd: null, realizedProxyUsd: null, firstBuyTs: null, firstSellTs: null, lastSellTs: null, unpricedTrades: 0, truncated };
    const amount = decimalNumber(row.amountUsd);
    const priced = amount !== null && amount > 0;
    if (!priced) view.unpricedTrades += 1;
    if (row.action === 'BUY') {
      view.buyCount += 1;
      if (priced) view.boughtUsd = (view.boughtUsd ?? 0) + amount;
      view.firstBuyTs ??= row.ts;
    } else {
      view.sellCount += 1;
      if (priced) view.soldUsd = (view.soldUsd ?? 0) + amount;
      view.firstSellTs ??= row.ts;
      view.lastSellTs = row.ts;
    }
    byWallet.set(wallet, view);
  }
  for (const view of byWallet.values()) {
    if (!view.truncated && view.unpricedTrades === 0 && view.buyCount > 0 && view.sellCount > 0 && view.boughtUsd !== null) {
      view.realizedProxyUsd = (view.soldUsd ?? 0) - view.boughtUsd;
    }
  }
  return { byWallet, truncated };
}

async function persistCandidate(prisma: PrismaClient, input: {
  chain: ChainId; tokenAddress: string; wallet: string; source: string; rank: number; item: TokenTopTrader | null; view: LocalView | null;
  validation: TopPnlValidation; confidence: number; reasonCodes: string[]; coverage: string; providerWindow: string | null; now: Date;
}) {
  const item = input.item;
  const view = input.view;
  const claimedRoi = item?.realizedPnlUsd != null && item.volumeBuyUsd != null && item.volumeBuyUsd > 0 ? item.realizedPnlUsd / item.volumeBuyUsd : null;
  const data = {
    chain: input.chain, mint: input.tokenAddress, walletAddress: input.wallet, source: input.source, providerRank: input.rank,
    claimedRealizedPnlUsd: finiteOrNull(item?.realizedPnlUsd), claimedUnrealizedPnlUsd: finiteOrNull(item?.unrealizedPnlUsd),
    claimedTotalPnlUsd: finiteOrNull(item?.totalPnlUsd ?? item?.pnlUsd), claimedBoughtUsd: finiteOrNull(item?.volumeBuyUsd), claimedSoldUsd: finiteOrNull(item?.volumeSellUsd),
    claimedRemainingUsd: null, claimedRoi, claimedTradeCount: item?.tradeCount ?? null, providerTags: item?.tags ?? [], providerTimeFrame: input.providerWindow,
    providerJson: item?.raw == null ? Prisma.JsonNull : json(item.raw), localBuyCount: view?.buyCount ?? 0, localSellCount: view?.sellCount ?? 0,
    localBoughtUsd: view?.boughtUsd ?? null, localSoldUsd: view?.soldUsd ?? null, localRealizedProxyUsd: view?.realizedProxyUsd ?? null,
    localFirstBuyTs: view?.firstBuyTs ?? null, localFirstSellTs: view?.firstSellTs ?? null, localLastSellTs: view?.lastSellTs ?? null,
    localUnpricedTrades: view?.unpricedTrades ?? 0, validation: input.validation, coverage: input.coverage, confidence: input.confidence,
    reasonCodes: input.reasonCodes, receiptsJson: json({ providerWindow: input.providerWindow, observedAt: input.now.toISOString() }),
    caveats: ['provider figures are discovery evidence only', 'observation_only; no signal eligibility is granted'], engineVersion: UNIFIED_DISCOVERY_ENGINE_VERSION
  };
  await prisma.tokenTopPnlCandidate.upsert({
    where: { chain_mint_walletAddress_source: { chain: input.chain, mint: input.tokenAddress, walletAddress: input.wallet, source: input.source } },
    create: data, update: data
  });
}

async function observeWallet(prisma: PrismaClient, chain: ChainId, address: string, firstSeenAt: Date, lastActiveAt: Date) {
  const wallet = await prisma.wallet.upsert({
    where: { address_chain: { address, chain } },
    create: { address, chain, firstSeenAt, lastActiveAt, status: 'observation_only', isWatched: false, notes: 'automatic profitable-wallet discovery; observation_only' },
    update: {}
  });
  await Promise.all([
    prisma.wallet.updateMany({ where: { id: wallet.id, firstSeenAt: { gt: firstSeenAt } }, data: { firstSeenAt } }),
    prisma.wallet.updateMany({ where: { id: wallet.id, lastActiveAt: { lt: lastActiveAt } }, data: { lastActiveAt } })
  ]);
}

async function persistExtractionStatus(prisma: PrismaClient, chain: ChainId, mint: string, hasTokenRow: boolean, hasLocalTrades: boolean, providerError: string | null, now: Date) {
  const counts = await prisma.tokenTopPnlCandidate.groupBy({ by: ['validation'], where: { chain, mint }, _count: { _all: true } });
  const by = Object.fromEntries(counts.map((x) => [x.validation, x._count._all]));
  const walletCount = await prisma.tokenTopPnlCandidate.findMany({ where: { chain, mint }, distinct: ['walletAddress'], select: { walletAddress: true }, take: 1_000 });
  const status = hasLocalTrades ? 'local_reconstruction_ok' : walletCount.length ? 'provider_ok' : providerError ? 'retryable_provider_failure' : 'unavailable';
  const data = {
    chain, mint, status, hasTokenRow, hasLocalTrades, walletCount: walletCount.length, locallyVerified: by.locally_verified ?? 0,
    providerOnly: by.provider_only ?? 0, incomplete: by.incomplete ?? 0, providerFetchState: providerError ? 'provider_error' : null,
    reasonCodes: providerError ? ['provider_retryable_failure'] : walletCount.length ? ['wallet_candidates_persisted'] : ['no_verified_wallet_evidence'],
    receiptsJson: json({ validationCounts: by, providerError }), engineVersion: UNIFIED_DISCOVERY_ENGINE_VERSION, computedAt: now
  };
  await prisma.topPnlExtractionStatus.upsert({ where: { chain_mint: { chain, mint } }, create: data, update: data });
}

function addToSet<K>(map: Map<K, Set<string>>, key: K, value: string) { const set = map.get(key) ?? new Set<string>(); set.add(value); map.set(key, set); }
function readUniverseObservations(value: Prisma.JsonValue | undefined): Array<{ source: string; coverage: unknown; evidence: unknown }> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const observations = (value as Record<string, unknown>).observations;
  if (!Array.isArray(observations)) return [];
  return observations.filter((item): item is { source: string; coverage: unknown; evidence: unknown } => Boolean(item && typeof item === 'object' && typeof (item as Record<string, unknown>).source === 'string'));
}
function retryDelayMs(retryCount: number) { return Math.min(24 * 60 * 60_000, 60_000 * 2 ** Math.min(retryCount, 10)); }
function errorMessage(error: unknown) { return (error instanceof Error ? error.message : String(error)).slice(0, 2_000); }
function decimalNumber(value: Prisma.Decimal | number | string | null | undefined): number | null { if (value == null) return null; const n = Number(value); return Number.isFinite(n) ? n : null; }
function finiteOrNull(value: number | null | undefined): number | null { return value != null && Number.isFinite(value) ? value : null; }
function json(value: unknown): Prisma.InputJsonValue { return value as Prisma.InputJsonValue; }
function clamp(value: number, min: number, max: number) { return Math.max(min, Math.min(max, Math.trunc(value))); }
export function normalizeAddress(chain: ChainId, address: string) { return chain === 'SOLANA' ? address.trim() : address.trim().toLowerCase(); }
export function validAddress(chain: ChainId, address: string) {
  const value = address.trim();
  return chain === 'SOLANA' ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value) : /^0x[0-9a-fA-F]{40}$/.test(value);
}
