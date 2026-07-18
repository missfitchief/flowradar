import { Prisma, type ChainId, type PrismaClient } from '@prisma/client';

export const TOKEN_CANDIDATE_RANKING_VERSION = 1;
export const MIN_VALID_POSITION_USD = 100;
export const RAW_TOKEN_CANDIDATE_LIMIT = 50;
export const FINAL_TOKEN_WALLET_LIMIT = 5;

export type TokenWalletClassification =
  | 'validated_trader' | 'probable_trader' | 'exchange' | 'dex_pool' | 'dex_router'
  | 'aggregator' | 'liquidity_vault' | 'market_maker_infrastructure' | 'treasury'
  | 'distributor' | 'bridge' | 'custody' | 'program_owned' | 'burn_address' | 'unknown';

export type TokenWalletDisplayStatus = 'Holding' | 'Accumulating' | 'Exited' | 'Active Trader' | 'Dormant' | 'Unknown';

export interface RankingTradeEvidence {
  action: 'BUY' | 'SELL';
  amountUsd: number | null;
  amountToken: number | null;
  ts: string;
  marketCapUsd: number | null;
  txHash: string;
}

export interface TokenCandidateEvaluationInput {
  chain: ChainId;
  tokenAddress: string;
  walletAddress: string;
  providerRank: number | null;
  providerTags: string[];
  rawRoi: number | null;
  registryCategory: string | null;
  walletStatus: string | null;
  walletLabels: Array<{ label: string; confidence: number }>;
  roles: string[];
  candidateValidation: string;
  tokenDecimals: number | null;
  tokenCreatedAt: string | null;
  trades: RankingTradeEvidence[];
  lastRelevantActivityTs: string | null;
  entityKey: string | null;
  rawAlpha: number;
  sampleAdjustedAlpha: number;
  alphaConfidence: number;
  alphaSampleSize: number;
  evidenceScore: number;
  monitoringPriority: string | null;
  historicalMedianRoi: number | null;
  winRate: number | null;
  oneWinnerDependence: number | null;
}

export interface TokenCandidateRankingReceipt {
  engineVersion: number;
  evaluatedAt: string;
  chain: ChainId;
  tokenAddress: string;
  walletAddress: string;
  providerRank: number | null;
  walletClassification: TokenWalletClassification;
  classificationConfidence: number;
  infrastructureExclusionReason: string | null;
  classificationSignals: string[];
  tradeOwnershipResult: 'verified' | 'unverified';
  tradeOwnershipEvidence: string[];
  pnlConfidence: 'high' | 'medium' | 'low' | 'unavailable';
  capitalInUsd: number | null;
  capitalOutUsd: number | null;
  realizedPnlUsd: number | null;
  rawRoi: number | null;
  validatedRoi: number | null;
  medianRoi: number | null;
  sampleSize: number;
  rawAlpha: number;
  sampleAdjustedAlpha: number;
  alphaConfidence: number;
  evidenceScore: number;
  monitoringValue: number;
  oneWinnerDependence: number | null;
  entityKey: string | null;
  relatedWalletCount: number;
  entryQuality: number | null;
  entryPercentile: number | null;
  firstEntryTs: string | null;
  lastRelevantActivityTs: string | null;
  status: TokenWalletDisplayStatus;
  intelligenceReason: string;
  winRate: number | null;
  finalRankingScore: number;
  accepted: boolean;
  selected: boolean;
  finalRank: number | null;
  rejectionReason: string | null;
}

export interface TokenCandidateRankingReport {
  candidatesAnalyzed: number;
  infrastructureExcluded: number;
  exchangeExcluded: number;
  ownershipUnverified: number;
  unreliablePnl: number;
  validatedTraders: number;
  probableTraders: number;
  uniqueEntities: number;
  cohort: {
    medianAlpha: number | null;
    medianRoi: number | null;
    active: number;
    dormant: number;
    holding: number;
  };
  topWallets: TokenCandidateRankingReceipt[];
}

/**
 * Builds the fail-closed intelligence selection for one token and persists the
 * receipt into the existing TokenTopPnlCandidate receipt JSON. Provider rows
 * remain discovery evidence; only canonical local swap-ledger rows can prove
 * trade ownership or cost basis.
 */
export async function refreshTokenCandidateRanking(
  prisma: PrismaClient,
  input: { chain: ChainId; tokenAddress: string; now?: Date }
): Promise<TokenCandidateRankingReport> {
  const now = input.now ?? new Date();
  const allRows = await prisma.tokenTopPnlCandidate.findMany({
    where: { chain: input.chain, mint: input.tokenAddress, validation: { not: 'invalid' } },
    orderBy: [{ updatedAt: 'desc' }, { providerRank: 'asc' }, { walletAddress: 'asc' }],
    take: 5_000
  });
  if (!allRows.length) return emptyReport();

  const providerSource = newestProviderSource(allRows);
  const providerRows = allRows
    .filter((row) => row.source === providerSource && row.providerRank !== null)
    .sort((a, b) => (a.providerRank ?? Number.MAX_SAFE_INTEGER) - (b.providerRank ?? Number.MAX_SAFE_INTEGER) || a.walletAddress.localeCompare(b.walletAddress));
  const selectedWallets = unique(providerRows.map((row) => row.walletAddress)).slice(0, RAW_TOKEN_CANDIDATE_LIMIT);
  if (selectedWallets.length < RAW_TOKEN_CANDIDATE_LIMIT) {
    for (const wallet of unique(allRows.map((row) => row.walletAddress))) {
      if (!selectedWallets.includes(wallet)) selectedWallets.push(wallet);
      if (selectedWallets.length >= RAW_TOKEN_CANDIDATE_LIMIT) break;
    }
  }
  const walletRows = selectedWallets.length ? await prisma.wallet.findMany({
    where: { chain: input.chain, address: { in: selectedWallets } },
    include: {
      classifications: true,
      stats: { orderBy: [{ computedAt: 'desc' }, { id: 'asc' }], take: 10 },
      intelligenceProfile: true
    }
  }) : [];
  const walletBy = new Map(walletRows.map((row) => [row.address, row]));
  const walletIds = walletRows.map((row) => row.id);
  const [token, registries, roles, entities, dnaRows, tokenIntelRows, targetTrades, historicalTrades, relevantEvents] = await Promise.all([
    prisma.token.findUnique({ where: { chain_address: { chain: input.chain, address: input.tokenAddress } } }),
    prisma.addressRegistry.findMany({ where: { chain: input.chain, address: { in: selectedWallets } } }),
    prisma.walletRoleAssignment.findMany({ where: { chain: input.chain, walletAddress: { in: selectedWallets } }, orderBy: [{ confidence: 'desc' }, { computedAt: 'desc' }] }),
    prisma.unifiedEntityAddress.findMany({ where: { chain: input.chain, address: { in: selectedWallets } }, include: { entity: true } }),
    prisma.walletDnaProfile.findMany({ where: { chain: input.chain, walletAddress: { in: selectedWallets } } }),
    prisma.tokenWalletIntelligence.findMany({ where: { chain: input.chain, tokenAddress: input.tokenAddress, walletAddress: { in: selectedWallets } } }),
    walletIds.length ? prisma.walletTokenTrade.findMany({
      where: { chain: input.chain, walletId: { in: walletIds }, token: { address: input.tokenAddress }, action: { in: ['BUY', 'SELL'] } },
      orderBy: [{ ts: 'asc' }, { id: 'asc' }]
    }) : Promise.resolve([]),
    walletIds.length ? prisma.walletTokenTrade.findMany({
      where: { chain: input.chain, walletId: { in: walletIds }, action: { in: ['BUY', 'SELL'] } },
      orderBy: [{ ts: 'desc' }, { id: 'desc' }],
      take: 20_000
    }) : Promise.resolve([]),
    prisma.massTransactionEvent.findMany({
      where: {
        chain: input.chain, status: { not: 'failed' }, amountUsd: { gte: MIN_VALID_POSITION_USD },
        relevanceCategory: { notIn: ['infrastructure_noise', 'contract_noise', 'dust', 'unrelated'] },
        OR: selectedWallets.flatMap((address) => [{ actorAddress: address }, { fromAddress: address }, { toAddress: address }])
      },
      orderBy: [{ ts: 'desc' }, { eventId: 'desc' }],
      take: 5_000
    })
  ]);

  const registryBy = new Map(registries.map((row) => [row.address, row]));
  const rolesBy = groupBy(roles, (row) => row.walletAddress);
  const entityBy = new Map(entities.map((row) => [row.address, row]));
  const dnaBy = new Map(dnaRows.map((row) => [row.walletAddress, row]));
  const tokenIntelBy = new Map(tokenIntelRows.map((row) => [row.walletAddress, row]));
  const targetTradesByWalletId = groupBy(targetTrades, (row) => row.walletId);
  const historicalTradesByWalletId = groupBy(historicalTrades, (row) => row.walletId);
  const eventsByAddress = new Map<string, typeof relevantEvents>();
  for (const event of relevantEvents) {
    for (const address of unique([event.actorAddress, event.fromAddress, event.toAddress].filter(nonNull))) {
      if (!selectedWallets.includes(address)) continue;
      const current = eventsByAddress.get(address) ?? [];
      current.push(event);
      eventsByAddress.set(address, current);
    }
  }
  const candidateRowsByWallet = groupBy(allRows.filter((row) => selectedWallets.includes(row.walletAddress)), (row) => row.walletAddress);
  const receipts: TokenCandidateRankingReceipt[] = [];

  for (const walletAddress of selectedWallets) {
    const candidates = candidateRowsByWallet.get(walletAddress) ?? [];
    const provider = candidates
      .filter((row) => row.source !== 'local_reconstruction')
      .sort((a, b) => (a.providerRank ?? Number.MAX_SAFE_INTEGER) - (b.providerRank ?? Number.MAX_SAFE_INTEGER) || b.updatedAt.getTime() - a.updatedAt.getTime())[0] ?? null;
    const local = candidates
      .filter((row) => row.source === 'local_reconstruction' || row.localBuyCount > 0)
      .sort((a, b) => validationOrder(a.validation) - validationOrder(b.validation) || b.confidence - a.confidence)[0] ?? provider ?? candidates[0]!;
    const wallet = walletBy.get(walletAddress);
    const trades = (wallet ? targetTradesByWalletId.get(wallet.id) ?? [] : []).map((row): RankingTradeEvidence => ({
      action: row.action as 'BUY' | 'SELL', amountUsd: honestTradeUsd(row), amountToken: finite(row.amountToken),
      ts: row.ts.toISOString(), marketCapUsd: positiveOrNull(row.marketCapAtTrade), txHash: row.txHash
    }));
    const history = wallet ? historicalTradesByWalletId.get(wallet.id) ?? [] : [];
    const dna = dnaBy.get(walletAddress);
    const tokenIntel = tokenIntelBy.get(walletAddress);
    const profile = wallet?.intelligenceProfile;
    const alpha = alphaEvidence(profile, dna, tokenIntel, wallet?.stats ?? [], trades);
    const lastTrade = history.find((row) => honestTradeUsd(row) !== null && honestTradeUsd(row)! >= MIN_VALID_POSITION_USD)?.ts ?? null;
    const lastEvent = eventsByAddress.get(walletAddress)?.[0]?.ts ?? null;
    const latest = maxDate(lastTrade, lastEvent);
    const entity = entityBy.get(walletAddress);
    const receipt = evaluateTokenCandidate({
      chain: input.chain,
      tokenAddress: input.tokenAddress,
      walletAddress,
      providerRank: provider?.providerRank ?? local.providerRank,
      providerTags: unique(candidates.flatMap((row) => row.providerTags)),
      rawRoi: finite(provider?.claimedRoi ?? local.claimedRoi),
      registryCategory: registryBy.get(walletAddress)?.category ?? null,
      walletStatus: wallet?.status ?? null,
      walletLabels: wallet?.classifications.map((row) => ({ label: row.label, confidence: row.confidence })) ?? [],
      roles: unique([...(rolesBy.get(walletAddress) ?? []).map((row) => row.role), entity?.role, profile?.role].filter(nonNull)),
      candidateValidation: local.validation,
      tokenDecimals: token?.decimals ?? null,
      tokenCreatedAt: (token?.tokenCreatedAt ?? token?.firstSeenAt)?.toISOString() ?? null,
      trades,
      lastRelevantActivityTs: latest?.toISOString() ?? null,
      entityKey: entity?.entity.entityKey ?? profile?.entityKey ?? tokenIntel?.entityKey ?? null,
      rawAlpha: alpha.raw,
      sampleAdjustedAlpha: alpha.adjusted,
      alphaConfidence: alpha.confidence,
      alphaSampleSize: alpha.sampleSize,
      evidenceScore: alpha.evidenceScore,
      monitoringPriority: profile?.monitoringPriority ?? null,
      historicalMedianRoi: alpha.medianRoi,
      winRate: alpha.winRate,
      oneWinnerDependence: alpha.oneWinnerDependence
    }, now);
    receipts.push(receipt);
  }

  finalizeTokenCandidateRanking(receipts);
  const receiptByWallet = new Map(receipts.map((row) => [row.walletAddress, row]));
  await prisma.$transaction(allRows
    .filter((row) => receiptByWallet.has(row.walletAddress))
    .map((row) => {
      const receipt = receiptByWallet.get(row.walletAddress)!;
      return prisma.tokenTopPnlCandidate.update({
        where: { id: row.id },
        data: {
          receiptsJson: json({ ...jsonObject(row.receiptsJson), tokenCandidateRanking: receipt }),
          reasonCodes: unique([...row.reasonCodes, ...(receipt.rejectionReason ? [receipt.rejectionReason] : [])])
        }
      });
    }));
  return reportFromReceipts(receipts);
}

export function evaluateTokenCandidate(input: TokenCandidateEvaluationInput, now = new Date()): TokenCandidateRankingReceipt {
  const infrastructure = classifyInfrastructure(input);
  const buys = input.trades.filter((row) => row.action === 'BUY');
  const sells = input.trades.filter((row) => row.action === 'SELL');
  const pricedBuys = buys.filter((row) => row.amountUsd !== null && row.amountUsd > 0);
  const pricedSells = sells.filter((row) => row.amountUsd !== null && row.amountUsd >= 0);
  const capitalIn = pricedBuys.length ? sum(pricedBuys.map((row) => row.amountUsd!)) : null;
  const capitalOut = pricedSells.length ? sum(pricedSells.map((row) => row.amountUsd!)) : sells.length ? null : 0;
  const ownershipVerified = buys.length > 0 && pricedBuys.length > 0;
  const costBasisReliable = ownershipVerified && pricedBuys.length === buys.length;
  const decimalsValid = input.tokenDecimals === null || Number.isInteger(input.tokenDecimals) && input.tokenDecimals >= 0 && input.tokenDecimals <= 18;
  const amountsValid = input.trades.every((row) => row.amountToken === null || Number.isFinite(row.amountToken) && row.amountToken > 0);
  const boughtTokens = sum(buys.map((row) => row.amountToken ?? 0));
  const soldTokens = sum(sells.map((row) => row.amountToken ?? 0));
  const exited = boughtTokens > 0 && soldTokens >= boughtTokens * 0.95;
  const validatedRoi = costBasisReliable && exited && capitalIn !== null && capitalOut !== null
    ? (capitalOut - capitalIn) / capitalIn
    : null;
  const rawRoiAnomaly = input.rawRoi !== null && Math.abs(input.rawRoi) > 1_000 && validatedRoi === null;
  const realizedPnl = validatedRoi !== null && capitalIn !== null ? validatedRoi * capitalIn : null;
  const firstEntry = buys[0]?.ts ?? null;
  const entryQuality = baseEntryQuality(firstEntry, input.tokenCreatedAt, buys.map((row) => row.marketCapUsd).filter(nonNull)[0] ?? null);
  const medianRoi = median([input.historicalMedianRoi, validatedRoi].filter(nonNull));
  const status = displayStatus(input.trades, input.lastRelevantActivityTs, now);
  const base: TokenCandidateRankingReceipt = {
    engineVersion: TOKEN_CANDIDATE_RANKING_VERSION, evaluatedAt: now.toISOString(), chain: input.chain,
    tokenAddress: input.tokenAddress, walletAddress: input.walletAddress, providerRank: input.providerRank,
    walletClassification: infrastructure.classification, classificationConfidence: infrastructure.confidence,
    infrastructureExclusionReason: infrastructure.reason, classificationSignals: infrastructure.signals,
    tradeOwnershipResult: ownershipVerified ? 'verified' : 'unverified',
    tradeOwnershipEvidence: ownershipVerified ? ['canonical_swap_leg_owned_by_wallet', ...(sells.length ? ['canonical_swap_exit_owned_by_wallet'] : [])] : [],
    pnlConfidence: !costBasisReliable ? 'unavailable' : exited && pricedSells.length === sells.length ? 'high' : 'medium',
    capitalInUsd: capitalIn, capitalOutUsd: capitalOut, realizedPnlUsd: realizedPnl,
    rawRoi: input.rawRoi, validatedRoi, medianRoi, sampleSize: input.alphaSampleSize,
    rawAlpha: round(input.rawAlpha), sampleAdjustedAlpha: round(input.sampleAdjustedAlpha), alphaConfidence: round01(input.alphaConfidence),
    evidenceScore: round(input.evidenceScore), monitoringValue: monitoringScore(input.monitoringPriority), oneWinnerDependence: input.oneWinnerDependence,
    entityKey: input.entityKey, relatedWalletCount: 0, entryQuality, entryPercentile: null, firstEntryTs: firstEntry,
    lastRelevantActivityTs: input.lastRelevantActivityTs, status,
    intelligenceReason: candidateReason(status, entryQuality, input.sampleAdjustedAlpha, input.alphaSampleSize, input.winRate),
    winRate: input.winRate,
    finalRankingScore: 0, accepted: false, selected: false, finalRank: null, rejectionReason: null
  };
  if (infrastructure.reason) return { ...base, rejectionReason: infrastructure.reason };
  if (!ownershipVerified) return { ...base, rejectionReason: 'trade_ownership_unverified' };
  if (!decimalsValid || !amountsValid || rawRoiAnomaly) return { ...base, pnlConfidence: 'low', rejectionReason: 'pnl_decimal_anomaly' };
  if (!costBasisReliable) return { ...base, rejectionReason: 'cost_basis_unreliable' };
  if (capitalIn === null || capitalIn < MIN_VALID_POSITION_USD) return { ...base, rejectionReason: 'below_minimum_position_size' };
  if (input.alphaSampleSize < 1) return { ...base, rejectionReason: 'insufficient_historical_sample' };
  const classification: TokenWalletClassification = input.alphaSampleSize >= 3 && input.alphaConfidence >= 0.2
    ? 'validated_trader'
    : 'probable_trader';
  const receipt = { ...base, walletClassification: classification, classificationConfidence: classification === 'validated_trader' ? 0.9 : 0.65, accepted: true };
  receipt.finalRankingScore = rankingScore(receipt);
  return receipt;
}

/** Entity-adjusted ordering. Infrastructure and failed ownership/PnL rows are
 * already rejected. One representative remains per entity; probable traders
 * only fill empty slots after every validated trader. */
export function finalizeTokenCandidateRanking(receipts: TokenCandidateRankingReceipt[]) {
  const entryRows = receipts.filter((row) => row.accepted && row.firstEntryTs).sort((a, b) => Date.parse(a.firstEntryTs!) - Date.parse(b.firstEntryTs!) || a.walletAddress.localeCompare(b.walletAddress));
  for (let index = 0; index < entryRows.length; index += 1) {
    const percentile = entryRows.length === 1 ? 100 : 100 * (entryRows.length - index - 1) / (entryRows.length - 1);
    entryRows[index]!.entryPercentile = round(percentile);
    entryRows[index]!.entryQuality = round(entryRows[index]!.entryQuality === null ? percentile : entryRows[index]!.entryQuality! * 0.7 + percentile * 0.3);
  }
  for (const row of receipts) if (row.accepted) row.finalRankingScore = rankingScore(row);
  const ordered = receipts.filter((row) => row.accepted).sort(candidateOrder);
  const representatives: TokenCandidateRankingReceipt[] = [];
  const entityGroups = groupBy(ordered, (row) => row.entityKey ?? `wallet:${row.chain}:${row.walletAddress}`);
  for (const group of entityGroups.values()) {
    const representative = group[0]!;
    representative.relatedWalletCount = Math.max(0, group.length - 1);
    if (representative.relatedWalletCount > 0) representative.intelligenceReason = 'Best wallet in this entity.';
    representatives.push(representative);
    for (const duplicate of group.slice(1)) {
      duplicate.accepted = false;
      duplicate.rejectionReason = 'duplicate_entity';
      duplicate.relatedWalletCount = group.length - 1;
      duplicate.finalRankingScore = 0;
    }
  }
  representatives.sort(candidateOrder);
  const validated = representatives.filter((row) => row.walletClassification === 'validated_trader');
  const probable = representatives.filter((row) => row.walletClassification === 'probable_trader');
  const selected = [...validated, ...probable].slice(0, FINAL_TOKEN_WALLET_LIMIT);
  selected.forEach((row, index) => { row.selected = true; row.finalRank = index + 1; });
}

export function rankingReceiptFromJson(value: Prisma.JsonValue): TokenCandidateRankingReceipt | null {
  const root = jsonObject(value);
  const receipt = root.tokenCandidateRanking;
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return null;
  const row = receipt as Record<string, unknown>;
  if (row.engineVersion !== TOKEN_CANDIDATE_RANKING_VERSION || typeof row.walletAddress !== 'string' || typeof row.accepted !== 'boolean') return null;
  return row as unknown as TokenCandidateRankingReceipt;
}

export function reportFromReceipts(receipts: TokenCandidateRankingReceipt[]): TokenCandidateRankingReport {
  const infrastructure = receipts.filter((row) => Boolean(row.infrastructureExclusionReason));
  const representatives = receipts.filter((row) => row.accepted);
  const uniqueEntities = new Set(representatives.map((row) => row.entityKey ?? `wallet:${row.chain}:${row.walletAddress}`));
  return {
    candidatesAnalyzed: receipts.length,
    infrastructureExcluded: infrastructure.length,
    exchangeExcluded: receipts.filter((row) => row.rejectionReason === 'exchange_wallet').length,
    ownershipUnverified: receipts.filter((row) => row.rejectionReason === 'trade_ownership_unverified').length,
    unreliablePnl: receipts.filter((row) => ['cost_basis_unreliable', 'below_minimum_position_size', 'pnl_decimal_anomaly'].includes(row.rejectionReason ?? '')).length,
    validatedTraders: receipts.filter((row) => row.walletClassification === 'validated_trader' && (!row.rejectionReason || row.rejectionReason === 'duplicate_entity')).length,
    probableTraders: receipts.filter((row) => row.walletClassification === 'probable_trader' && (!row.rejectionReason || row.rejectionReason === 'duplicate_entity')).length,
    uniqueEntities: uniqueEntities.size,
    cohort: {
      medianAlpha: median(representatives.map((row) => row.sampleAdjustedAlpha)),
      medianRoi: median(representatives.map((row) => row.medianRoi).filter(nonNull)),
      active: representatives.filter((row) => row.status === 'Active Trader' || row.status === 'Accumulating').length,
      dormant: representatives.filter((row) => row.status === 'Dormant').length,
      holding: representatives.filter((row) => row.status === 'Holding' || row.status === 'Accumulating').length
    },
    topWallets: receipts.filter((row) => row.selected).sort((a, b) => (a.finalRank ?? 99) - (b.finalRank ?? 99))
  };
}

function classifyInfrastructure(input: TokenCandidateEvaluationInput): { classification: TokenWalletClassification; confidence: number; reason: string | null; signals: string[] } {
  const hard = registryClassification(input.registryCategory);
  if (hard) return hard;
  const textSignals = new Map<TokenWalletClassification, Set<string>>();
  const add = (classification: TokenWalletClassification, signal: string) => {
    const set = textSignals.get(classification) ?? new Set<string>(); set.add(signal); textSignals.set(classification, set);
  };
  const inspect = (value: string, signal: string) => {
    const text = value.toLowerCase();
    if (/\bcex\b|exchange|binance|coinbase|kraken|okx|bybit/.test(text)) add('exchange', signal);
    if (/pool|amm/.test(text)) add('dex_pool', signal);
    if (/vault|liquidity/.test(text)) add('liquidity_vault', signal);
    if (/router/.test(text)) add('dex_router', signal);
    if (/aggregator|jupiter/.test(text)) add('aggregator', signal);
    if (/bridge/.test(text)) add('bridge', signal);
    if (/custody|mixer/.test(text)) add('custody', signal);
    if (/program_owned|token_contract|contract_account/.test(text)) add('program_owned', signal);
    if (/burn|dead_address/.test(text)) add('burn_address', signal);
    if (/treasury/.test(text)) add('treasury', signal);
    if (/distribut|airdrop/.test(text)) add('distributor', signal);
    if (/market_maker|market maker/.test(text)) add('market_maker_infrastructure', signal);
  };
  for (const role of input.roles) inspect(role, `role:${role}`);
  for (const tag of input.providerTags) inspect(tag, `provider_tag:${tag}`);
  for (const label of input.walletLabels.filter((row) => row.confidence >= 0.7)) inspect(label.label, `wallet_label:${label.label}`);
  if (input.walletStatus === 'bot_or_service' || input.walletStatus === 'excluded') inspect('market_maker', `wallet_status:${input.walletStatus}`);
  const ranked = [...textSignals.entries()].sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]));
  const winner = ranked[0];
  if (winner && winner[1].size >= 2) {
    const reason = rejectionFor(winner[0]);
    return { classification: winner[0], confidence: round01(0.55 + winner[1].size * 0.12), reason, signals: [...winner[1]].sort() };
  }
  return { classification: 'unknown', confidence: winner ? 0.4 : 0.2, reason: null, signals: winner ? [...winner[1]].sort() : [] };
}

function registryClassification(category: string | null) {
  const values: Record<string, { classification: TokenWalletClassification; reason: string }> = {
    CEX: { classification: 'exchange', reason: 'exchange_wallet' },
    POOL: { classification: 'dex_pool', reason: 'dex_pool_or_vault' },
    ROUTER: { classification: 'dex_router', reason: 'router_or_aggregator' },
    BRIDGE: { classification: 'bridge', reason: 'infrastructure_wallet' },
    MIXER: { classification: 'custody', reason: 'infrastructure_wallet' },
    TOKEN_CONTRACT: { classification: 'program_owned', reason: 'infrastructure_wallet' }
  };
  const hit = category ? values[category] : null;
  return hit ? { ...hit, confidence: 1, signals: [`address_registry:${category}`] } : null;
}

function rejectionFor(classification: TokenWalletClassification) {
  if (classification === 'exchange') return 'exchange_wallet';
  if (classification === 'dex_pool' || classification === 'liquidity_vault') return 'dex_pool_or_vault';
  if (classification === 'dex_router' || classification === 'aggregator') return 'router_or_aggregator';
  return 'infrastructure_wallet';
}

function displayStatus(trades: RankingTradeEvidence[], lastActivity: string | null, now: Date): TokenWalletDisplayStatus {
  const buys = trades.filter((row) => row.action === 'BUY');
  const sells = trades.filter((row) => row.action === 'SELL');
  const bought = sum(buys.map((row) => row.amountToken ?? 0));
  const sold = sum(sells.map((row) => row.amountToken ?? 0));
  const remaining = bought - sold;
  const latest = [...trades].sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))[0];
  if (bought > 0 && sold >= bought * 0.95) return 'Exited';
  if (remaining > bought * 0.05 && buys.length >= 2 && latest?.action === 'BUY') return 'Accumulating';
  if (remaining > bought * 0.05) return 'Holding';
  const seen = lastActivity ? Date.parse(lastActivity) : Number.NaN;
  if (!Number.isFinite(seen)) return 'Unknown';
  const days = Math.max(0, (now.getTime() - seen) / 86_400_000);
  if (days < 7) return 'Active Trader';
  if (days >= 14) return 'Dormant';
  return 'Unknown';
}

function candidateReason(status: TokenWalletDisplayStatus, entryQuality: number | null, alpha: number, sampleSize: number, winRate: number | null) {
  if (status === 'Dormant' && alpha >= 60) return 'Dormant high-alpha wallet.';
  if (entryQuality !== null && entryQuality >= 80) return 'Repeated early entrant.';
  if (sampleSize >= 10 && winRate !== null && winRate >= 0.6) return 'Consistent historical winner.';
  if (alpha >= 80) return 'High-alpha trader.';
  return 'Locally validated trader.';
}

function rankingScore(row: TokenCandidateRankingReceipt) {
  const alpha = clamp(row.sampleAdjustedAlpha, 0, 100);
  const pnl = row.realizedPnlUsd === null ? 35 : row.realizedPnlUsd <= 0 ? Math.max(0, 30 + row.realizedPnlUsd / 1_000) : Math.min(100, 40 + Math.log10(row.realizedPnlUsd + 1) * 12);
  const roiScore = robustRoiScore(row.medianRoi);
  const entry = row.entryQuality ?? 50;
  const sampleConfidence = 1 - Math.exp(-Math.max(0, row.sampleSize) / 12);
  const consistency = row.winRate === null ? 40 : clamp(row.winRate * 100 * (0.6 + sampleConfidence * 0.4) - (row.oneWinnerDependence ?? 0) * 20, 0, 100);
  const monitoring = row.monitoringValue;
  const evidence = row.evidenceScore || row.classificationConfidence * 100;
  return round(alpha * 0.30 + pnl * 0.20 + roiScore * 0.15 + entry * 0.15 + consistency * 0.10 + monitoring * 0.05 + evidence * 0.05);
}

function robustRoiScore(value: number | null) {
  if (value === null) return 40;
  const capped = clamp(value, -1, 10);
  if (capped < 0) return clamp(40 + capped * 40, 0, 40);
  return clamp(50 + Math.log1p(capped) / Math.log(11) * 50, 0, 100);
}

function baseEntryQuality(entry: string | null, launch: string | null, marketCap: number | null) {
  const parts: number[] = [];
  if (entry && launch) {
    const delay = Math.max(0, Date.parse(entry) - Date.parse(launch));
    if (Number.isFinite(delay)) parts.push(delay <= 5 * 60_000 ? 100 : delay <= 60 * 60_000 ? 90 : delay <= 86_400_000 ? 70 : delay <= 7 * 86_400_000 ? 50 : 25);
  }
  if (marketCap !== null) parts.push(marketCap <= 100_000 ? 100 : marketCap <= 500_000 ? 85 : marketCap <= 2_000_000 ? 65 : marketCap <= 10_000_000 ? 40 : 20);
  return parts.length ? round(sum(parts) / parts.length) : null;
}

function alphaEvidence(
  profile: { rawHistoricalAlphaScore: number; sampleAdjustedAlphaScore: number; alphaConfidence: number; alphaSampleSize: number; evidenceScore: number; alphaCalibrationJson: Prisma.JsonValue } | null | undefined,
  dna: { completedPositions: number; confidence: number; winRate: number | null; medianReturn: number | null; oneWinnerDependence: number | null; repeatRunnerCount: number | null; totalRealizedPnlUsd: Prisma.Decimal | null; medianEntryMcapUsd: Prisma.Decimal | null } | undefined,
  tokenIntel: { qualityScore: number; evidenceConfidence: number; completedPositions: number; winRate: number | null; oneWinnerDependence: number | null } | undefined,
  stats: Array<{ walletScore: number; tradeCount: number; winRate: number; pnlConfidence: number }>,
  trades: RankingTradeEvidence[]
) {
  if (profile) {
    const calibration = jsonObject(profile.alphaCalibrationJson);
    return {
      raw: profile.rawHistoricalAlphaScore, adjusted: profile.sampleAdjustedAlphaScore, confidence: normalizeConfidence(profile.alphaConfidence),
      sampleSize: profile.alphaSampleSize, evidenceScore: profile.evidenceScore,
      medianRoi: finite(calibration.medianReturn), winRate: finite(calibration.hitRate), oneWinnerDependence: finite(calibration.oneWinnerDependence)
    };
  }
  if (dna) {
    const raw = dnaRawAlpha(dna);
    const confidence = dna.completedPositions ? (1 - Math.exp(-dna.completedPositions / 18)) * (0.65 + normalizeConfidence(dna.confidence) * 0.35) : 0;
    return { raw, adjusted: raw * confidence + 35 * (1 - confidence), confidence, sampleSize: dna.completedPositions, evidenceScore: normalizeConfidence(dna.confidence) * 100, medianRoi: dna.medianReturn, winRate: dna.winRate, oneWinnerDependence: dna.oneWinnerDependence };
  }
  if (tokenIntel) {
    const sample = tokenIntel.completedPositions;
    const confidence = sample ? (1 - Math.exp(-sample / 18)) * (0.65 + normalizeConfidence(tokenIntel.evidenceConfidence) * 0.35) : 0;
    return { raw: tokenIntel.qualityScore, adjusted: tokenIntel.qualityScore * confidence + 35 * (1 - confidence), confidence, sampleSize: sample, evidenceScore: normalizeConfidence(tokenIntel.evidenceConfidence) * 100, medianRoi: null, winRate: tokenIntel.winRate, oneWinnerDependence: tokenIntel.oneWinnerDependence };
  }
  const computed = stats.find((row) => row.tradeCount > 0);
  if (computed) {
    const sample = computed.tradeCount;
    const confidence = (1 - Math.exp(-sample / 18)) * normalizeConfidence(computed.pnlConfidence);
    return { raw: computed.walletScore, adjusted: computed.walletScore * confidence + 35 * (1 - confidence), confidence, sampleSize: sample, evidenceScore: normalizeConfidence(computed.pnlConfidence) * 100, medianRoi: null, winRate: computed.winRate, oneWinnerDependence: null };
  }
  const completed = trades.some((row) => row.action === 'SELL') ? 1 : 0;
  return { raw: 35, adjusted: 35, confidence: completed ? 0.08 : 0, sampleSize: completed, evidenceScore: completed ? 30 : 0, medianRoi: null, winRate: null, oneWinnerDependence: null };
}

function dnaRawAlpha(dna: { completedPositions: number; winRate: number | null; medianReturn: number | null; oneWinnerDependence: number | null; repeatRunnerCount: number | null; totalRealizedPnlUsd: Prisma.Decimal | null; medianEntryMcapUsd: Prisma.Decimal | null }) {
  let score = 0;
  const entry = finite(dna.medianEntryMcapUsd);
  if (entry !== null) score += entry <= 100_000 ? 15 : entry <= 500_000 ? 12 : entry <= 2_000_000 ? 8 : entry <= 10_000_000 ? 4 : 0;
  if (dna.medianReturn !== null) score += Math.min(20, Math.max(0, dna.medianReturn) * 10);
  if (dna.winRate !== null && dna.completedPositions >= 3) score += clamp(dna.winRate * 20, 0, 20);
  if (dna.repeatRunnerCount) score += Math.min(15, dna.repeatRunnerCount * 4);
  const pnl = finite(dna.totalRealizedPnlUsd);
  if (pnl !== null && pnl > 0) score += Math.min(10, Math.max(1, Math.log10(pnl + 1) * 2));
  if (dna.oneWinnerDependence !== null) score += clamp((1 - dna.oneWinnerDependence) * 10, 0, 10);
  return clamp(score, 0, 100);
}

function newestProviderSource<T extends { source: string; updatedAt: Date }>(rows: T[]) {
  const provider = rows.filter((row) => row.source !== 'local_reconstruction').sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0];
  return provider?.source ?? 'local_reconstruction';
}
function validationOrder(value: string) { return value === 'locally_verified' ? 0 : value === 'partially_verified' ? 1 : value === 'incomplete' ? 2 : 3; }
function candidateOrder(a: TokenCandidateRankingReceipt, b: TokenCandidateRankingReceipt) { return (a.walletClassification === 'validated_trader' ? 0 : 1) - (b.walletClassification === 'validated_trader' ? 0 : 1) || b.finalRankingScore - a.finalRankingScore || (a.providerRank ?? 999) - (b.providerRank ?? 999) || a.walletAddress.localeCompare(b.walletAddress); }
function monitoringScore(value: string | null) { return value === 'root_permanent' ? 100 : value === 'fresh_receiver_hot' ? 95 : value === 'strong_link' ? 85 : value === 'probable_link' ? 70 : value === 'standard' ? 55 : value === 'weak_cold' ? 35 : value === 'cold_archive' ? 20 : 40; }
function honestTradeUsd(row: { amountUsd: Prisma.Decimal; valuedUsd: Prisma.Decimal | null; valuationConfidence: number | null }) { const original = finite(row.amountUsd); if (original !== null && original > 0) return original; const valued = finite(row.valuedUsd); return valued !== null && valued > 0 && (row.valuationConfidence ?? 0) >= 0.7 ? valued : null; }
function maxDate(...values: Array<Date | null>) { return values.filter(nonNull).sort((a, b) => b.getTime() - a.getTime())[0] ?? null; }
function positiveOrNull(value: unknown) { const result = finite(value); return result !== null && result > 0 ? result : null; }
function normalizeConfidence(value: number) { return clamp(value > 1 ? value / 100 : value, 0, 1); }
function finite(value: unknown): number | null { if (value === null || value === undefined) return null; const result = Number(value); return Number.isFinite(result) ? result : null; }
function median(values: number[]) { if (!values.length) return null; const sorted = [...values].sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2; }
function sum(values: number[]) { return values.reduce((total, value) => total + value, 0); }
function round(value: number) { return Math.round(clamp(value, 0, 100) * 100) / 100; }
function round01(value: number) { return Math.round(clamp(value, 0, 1) * 10_000) / 10_000; }
function clamp(value: number, min: number, max: number) { return Math.max(min, Math.min(max, value)); }
function unique<T>(values: T[]) { return [...new Set(values)]; }
function groupBy<T, K>(values: T[], key: (value: T) => K) { const result = new Map<K, T[]>(); for (const value of values) { const bucket = result.get(key(value)) ?? []; bucket.push(value); result.set(key(value), bucket); } return result; }
function nonNull<T>(value: T | null | undefined): value is T { return value !== null && value !== undefined; }
function jsonObject(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function json(value: unknown): Prisma.InputJsonValue { return value as Prisma.InputJsonValue; }
function emptyReport(): TokenCandidateRankingReport { return { candidatesAnalyzed: 0, infrastructureExcluded: 0, exchangeExcluded: 0, ownershipUnverified: 0, unreliablePnl: 0, validatedTraders: 0, probableTraders: 0, uniqueEntities: 0, cohort: { medianAlpha: null, medianRoi: null, active: 0, dormant: 0, holding: 0 }, topWallets: [] }; }
