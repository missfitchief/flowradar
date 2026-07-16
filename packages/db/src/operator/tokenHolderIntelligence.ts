import { isValidSolanaAddress } from '@flowradar/core';
import { Prisma, type PrismaClient } from '@prisma/client';
import {
  alchemyRpcRequest,
  alchemyRpcUrl,
  fetchTokenHolders,
  fetchWalletActivity,
  fetchWalletHoldings,
  type AlchemyRpcEnv
} from '@flowradar/providers';

const HOLDER_LIMIT = 50;
const PHASE_TWO_LIMIT = 12;
const PHASE_TWO_CONCURRENCY = 4;
const ENRICHMENT_CACHE_MS = 30 * 60_000;
const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const BURN_ADDRESSES = new Set([SYSTEM_PROGRAM, '1nc1nerator11111111111111111111111111111111']);
const INFRA_PATTERN = /(?:raydium|orca|meteora|jupiter|pump[_ -]?amm|liquidity|\blp\b|vault|router|aggregator|exchange|custod|treasury|distribut|bridge|burn)/i;

export interface TokenHolderDataSource {
  fetchHolders(tokenAddress: string, limit: number): Promise<Record<string, unknown>[]>;
  fetchHoldings(walletAddress: string, limit: number): Promise<Record<string, unknown>[]>;
  fetchActivity(walletAddress: string, limit: number): Promise<Record<string, unknown>[]>;
}

export interface TokenHolderWin {
  symbol: string;
  multiple: number;
}

export interface TokenHolderPosition {
  symbol: string;
  tokenAddress: string | null;
  usdValue: number | null;
  supplyPercentage: number | null;
}

export interface TokenHolderProfile {
  holderRank: number;
  walletAddress: string;
  entityKey: string;
  relatedWalletCount: number;
  tags: string[];
  wins: TokenHolderWin[];
  holdings: TokenHolderPosition[];
  medianHoldMs: number | null;
  reliability: number | null;
  historicalAlpha: number | null;
  rankingScore: number;
  passReasons: string[];
}

export interface TokenHolderIntelligenceReport {
  chain: 'SOLANA';
  tokenAddress: string;
  tokenSymbol: string;
  holdersScanned: number;
  ownersResolved: number;
  uniqueOwnerWallets: number;
  infrastructureExcluded: number;
  csvMatches: number;
  flowradarMatches: number;
  liveEnriched: number;
  smartProfiles: number;
  uniqueEntities: number;
  profiles: TokenHolderProfile[];
  processingTimeMs: number;
  coverageWarnings: string[];
}

export interface NormalizedHolderRow {
  holderRank: number;
  providerOwner: string | null;
  tokenAccount: string | null;
  balance: number | null;
  supplyPercentage: number | null;
  positionUsd: number | null;
  accountOwner: string | null;
  ownerProgram: string | null;
  ownerExecutable: boolean | null;
  ownerAddress: string | null;
  ownerResolution: 'rpc_token_account' | 'provider_owner' | 'unresolved';
  accountType: 'wallet' | 'token_account' | 'program' | 'pda' | 'unknown';
  isOnCurve: boolean | null;
  exchange: string | null;
  providerTags: string[];
  buyCount: number;
  sellCount: number;
  startHoldingAt: Date | null;
  lastActivityAt: Date | null;
}

interface ResolvedHolder extends NormalizedHolderRow {
  ownerAddress: string;
  tokenAccounts: string[];
  rawRanks: number[];
  infrastructureReason: string | null;
}

interface LiveEnrichment {
  fetchedAt: string;
  holdings: TokenHolderPosition[];
  activityCount: number;
  tradeEventCount: number;
  uniqueTradeTokens: number;
  completedProviderPositions: number;
  traderEvidence: boolean;
  recentTxHashes: string[];
  providerErrors: string[];
  cacheHit?: boolean;
}

interface LocalHistory {
  wins: TokenHolderWin[];
  medianHoldMs: number | null;
  completedPositions: number;
  winCount: number;
  lossCount: number;
  buyCount: number;
  sellCount: number;
  firstBuyAt: Date | null;
  lastSellAt: Date | null;
  lastActivityAt: Date | null;
}

interface RankedHolder extends ResolvedHolder {
  seed: SeedMatch | null;
  csvSeed: SeedMatch | null;
  profile: ProfileMatch | null;
  wallet: WalletMatch | null;
  entityKey: string;
  flowradarMatch: boolean;
  flowradarStrong: boolean;
  reliability: number | null;
  live: LiveEnrichment | null;
  local: LocalHistory;
  tags: string[];
  passReasons: string[];
  rankingScore: number;
}

interface SeedMatch {
  sourceFile: string;
  sourceScore: number | null;
  sourceTier: string | null;
  sourceStatus: string | null;
  sourceLabel: string | null;
  sourceLastActiveAt: Date | null;
}

interface ProfileMatch {
  clusterId: string;
  entityKey: string | null;
  role: string;
  evidenceScore: number;
  sourceScore: number | null;
  historicalAlphaScore: number;
  wakeUpPotential: number;
  confidence: number;
  tier: string;
  intelligenceStatus: string;
  monitoringPriority: string;
  evidenceSignals: string[];
  lastActivityAt: Date | null;
}

interface WalletMatch {
  id: string;
  status: string;
  isWatched: boolean;
  hasLineageRoot: boolean;
  classifications: string[];
}

const DEFAULT_SOURCE: TokenHolderDataSource = {
  fetchHolders: (tokenAddress, limit) => fetchTokenHolders(tokenAddress, { limit, timeoutMs: 30_000 }),
  fetchHoldings: async (walletAddress, limit) => (await fetchWalletHoldings(walletAddress, { limit, timeoutMs: 30_000 })).rows,
  fetchActivity: async (walletAddress, limit) => (await fetchWalletActivity(walletAddress, { limit, timeoutMs: 30_000 })).rows
};

export async function runTokenHolderIntelligence(
  prisma: PrismaClient,
  input: {
    tokenAddress: string;
    source?: Partial<TokenHolderDataSource>;
    env?: AlchemyRpcEnv;
    now?: Date;
    phaseTwoLimit?: number;
    cacheTtlMs?: number;
  }
): Promise<TokenHolderIntelligenceReport> {
  const startedAt = Date.now();
  const now = input.now ?? new Date();
  const tokenAddress = input.tokenAddress.trim();
  if (!isValidSolanaAddress(tokenAddress)) throw new Error('Invalid Solana token mint');
  const source: TokenHolderDataSource = { ...DEFAULT_SOURCE, ...input.source };
  const rawRows = (await source.fetchHolders(tokenAddress, HOLDER_LIMIT)).slice(0, HOLDER_LIMIT);
  const normalized = rawRows.map((row, index) => normalizeTokenHolderRow(row, index + 1));
  const coverageWarnings: string[] = [];
  const resolved = await resolveHolderOwners(normalized, input.env ?? process.env as AlchemyRpcEnv).catch((error) => {
    coverageWarnings.push(`Owner resolution degraded: ${safeError(error)}`);
    return normalized.map(providerOwnerFallback);
  });
  const deduped = dedupeResolvedHolders(resolved);
  const addresses = deduped.map((row) => row.ownerAddress);

  const [seedRows, profileRows, walletRows, entityRows, registryRows, existingRows, canonicalToken, metadata] = await Promise.all([
    prisma.coreWalletSeedRecord.findMany({
      where: { chain: 'SOLANA', address: { in: addresses } },
      select: { address: true, sourceFile: true, sourceScore: true, sourceTier: true, sourceStatus: true, sourceLabel: true, sourceLastActiveAt: true }
    }),
    prisma.walletIntelligenceProfile.findMany({
      where: { chain: 'SOLANA', address: { in: addresses } },
      select: {
        address: true, clusterId: true, entityKey: true, role: true, evidenceScore: true, sourceScore: true,
        historicalAlphaScore: true, wakeUpPotential: true, confidence: true, tier: true, intelligenceStatus: true,
        monitoringPriority: true, evidenceSignals: true, lastActivityAt: true
      }
    }),
    prisma.wallet.findMany({
      where: { chain: 'SOLANA', address: { in: addresses } },
      select: { id: true, address: true, status: true, isWatched: true, lineageRoot: { select: { id: true } }, classifications: { select: { label: true } } }
    }),
    prisma.unifiedEntityAddress.findMany({
      where: { chain: 'SOLANA', address: { in: addresses } },
      select: { address: true, entity: { select: { entityKey: true } } }
    }),
    prisma.addressRegistry.findMany({ where: { chain: 'SOLANA', address: { in: addresses } }, select: { address: true, category: true, label: true } }),
    prisma.tokenWalletIntelligence.findMany({ where: { chain: 'SOLANA', tokenAddress, walletAddress: { in: addresses } } }),
    prisma.token.findFirst({ where: { chain: 'SOLANA', address: tokenAddress }, select: { symbol: true, name: true } }),
    prisma.tokenMetadata.findUnique({ where: { chain_mint: { chain: 'SOLANA', mint: tokenAddress } }, select: { symbol: true, name: true } })
  ]);

  const seedsByAddress = groupBy(seedRows, (row) => row.address ?? '');
  const profilesByAddress = new Map(profileRows.map((row) => [row.address, row]));
  const walletsByAddress = new Map(walletRows.map((row) => [row.address, row]));
  const entitiesByAddress = new Map(entityRows.map((row) => [row.address, row.entity.entityKey]));
  const registryByAddress = new Map(registryRows.map((row) => [row.address, row]));
  const existingByAddress = new Map(existingRows.map((row) => [row.walletAddress, row]));

  for (const holder of deduped) {
    holder.infrastructureReason = infrastructureReason(holder, registryByAddress.get(holder.ownerAddress), walletsByAddress.get(holder.ownerAddress));
  }

  const baseCandidates: RankedHolder[] = deduped.map((holder) => {
    const seedRowsForWallet = seedsByAddress.get(holder.ownerAddress) ?? [];
    const seed = bestSeed(seedRowsForWallet);
    const csvSeed = bestSeed(seedRowsForWallet.filter((row) => row.sourceFile.toLowerCase().endsWith('.csv')));
    const profileRow = profilesByAddress.get(holder.ownerAddress);
    const walletRow = walletsByAddress.get(holder.ownerAddress);
    const profile = profileRow ? profileMatch(profileRow) : null;
    const wallet = walletRow ? walletMatch(walletRow) : null;
    const flowradarMatch = Boolean(profile || wallet && (wallet.hasLineageRoot || wallet.status !== 'observation_only' || wallet.classifications.some((label) => ['smart_money', 'sniper', 'whale'].includes(label))));
    const flowradarStrong = strongFlowradarProfile(profile, wallet);
    const reliability = reliabilityScore(seed, profile);
    const entityKey = entitiesByAddress.get(holder.ownerAddress) ?? profile?.entityKey ?? (profile?.clusterId ? `cluster:${profile.clusterId}` : `wallet:${holder.ownerAddress}`);
    return {
      ...holder, seed, csvSeed, profile, wallet, entityKey, flowradarMatch, flowradarStrong, reliability,
      live: null, local: emptyLocalHistory(), tags: [], passReasons: [], rankingScore: preliminaryScore(holder, reliability, profile, wallet)
    };
  });

  const phaseTwoCandidates = baseCandidates
    .filter((row) => !row.infrastructureReason && phaseTwoValue(row))
    .sort((a, b) => b.rankingScore - a.rankingScore || a.holderRank - b.holderRank)
    .slice(0, Math.max(1, Math.min(input.phaseTwoLimit ?? PHASE_TWO_LIMIT, PHASE_TWO_LIMIT)));
  const cacheTtlMs = input.cacheTtlMs ?? ENRICHMENT_CACHE_MS;
  const enriched = await mapConcurrent(phaseTwoCandidates, PHASE_TWO_CONCURRENCY, async (candidate) => {
    const cached = cachedEnrichment(existingByAddress.get(candidate.ownerAddress)?.supportingEvidenceJson, now, cacheTtlMs);
    if (cached) return [candidate.ownerAddress, { ...cached, cacheHit: true }] as const;
    return [candidate.ownerAddress, await enrichWallet(source, candidate.ownerAddress, now)] as const;
  });
  const liveByAddress = new Map(enriched);

  const localHistoryByAddress = await loadLocalHistory(prisma, phaseTwoCandidates.map((row) => walletsByAddress.get(row.ownerAddress)?.id).filter(nonNull));
  const tokenSymbolFromProvider = [...liveByAddress.values()]
    .flatMap((row) => row.holdings)
    .find((row) => row.tokenAddress === tokenAddress)?.symbol;
  const storedSymbol = canonicalToken?.symbol || metadata?.symbol;
  const tokenSymbol = storedSymbol && !placeholderSymbol(storedSymbol, tokenAddress) ? storedSymbol : tokenSymbolFromProvider || storedSymbol || 'TOKEN';

  for (const candidate of baseCandidates) {
    candidate.live = liveByAddress.get(candidate.ownerAddress) ?? null;
    candidate.local = candidate.wallet ? localHistoryByAddress.get(candidate.wallet.id) ?? emptyLocalHistory() : emptyLocalHistory();
    candidate.passReasons = passReasons(candidate);
    candidate.tags = holderTags(candidate, now);
    candidate.rankingScore = finalScore(candidate);
  }

  const accepted = baseCandidates
    .filter((row) => !row.infrastructureReason && row.passReasons.length > 0)
    .sort((a, b) => b.rankingScore - a.rankingScore || a.holderRank - b.holderRank || a.ownerAddress.localeCompare(b.ownerAddress));
  const selected = selectIndependentHolderProfiles(accepted, 5);
  const acceptedEntityCounts = countBy(accepted, (row) => row.entityKey);
  const profiles: TokenHolderProfile[] = selected.map((row) => ({
    holderRank: row.holderRank,
    walletAddress: row.ownerAddress,
    entityKey: row.entityKey,
    relatedWalletCount: Math.max(0, (acceptedEntityCounts.get(row.entityKey) ?? 1) - 1),
    tags: row.tags.slice(0, 3),
    wins: row.local.wins.slice(0, 3),
    holdings: profileHoldings(row, tokenAddress, tokenSymbol),
    medianHoldMs: row.local.medianHoldMs,
    reliability: row.reliability,
    historicalAlpha: meaningfulScore(row.profile?.historicalAlphaScore),
    rankingScore: row.rankingScore,
    passReasons: row.passReasons
  }));

  await persistHolderReceipts(prisma, tokenAddress, baseCandidates, accepted, now);

  return {
    chain: 'SOLANA', tokenAddress, tokenSymbol,
    holdersScanned: rawRows.length,
    ownersResolved: resolved.filter((row) => row.ownerAddress && row.ownerResolution !== 'unresolved').length,
    uniqueOwnerWallets: deduped.length,
    infrastructureExcluded: baseCandidates.filter((row) => Boolean(row.infrastructureReason)).length,
    csvMatches: baseCandidates.filter((row) => Boolean(row.csvSeed)).length,
    flowradarMatches: baseCandidates.filter((row) => row.flowradarMatch).length,
    liveEnriched: baseCandidates.filter((row) => Boolean(row.live)).length,
    smartProfiles: accepted.length,
    uniqueEntities: new Set(accepted.map((row) => row.entityKey)).size,
    profiles,
    processingTimeMs: Date.now() - startedAt,
    coverageWarnings
  };
}

export function normalizeTokenHolderRow(row: Record<string, unknown>, holderRank: number): NormalizedHolderRow {
  const providerOwner = firstAddress(row.address, row.owner, row.wallet_address);
  const tokenAccount = firstAddress(row.account_address, row.token_account, row.associated_token_address);
  const percentage = firstNumber(row.amount_percentage, row.supply_percentage, row.percentage);
  const providerTags = uniqueStrings([
    ...stringArray(row.tags), ...stringArray(row.maker_token_tags), ...stringArray(row.wallet_tag_v2),
    ...stringArray(row.name), ...stringArray(row.exchange)
  ]);
  return {
    holderRank,
    providerOwner,
    tokenAccount,
    balance: firstNumber(row.balance, row.amount_cur, row.amount),
    supplyPercentage: percentage == null ? null : percentage <= 1 ? percentage * 100 : percentage,
    positionUsd: firstNumber(row.usd_value, row.position_usd),
    accountOwner: null,
    ownerProgram: null,
    ownerExecutable: null,
    ownerAddress: null,
    ownerResolution: 'unresolved',
    accountType: 'unknown',
    isOnCurve: typeof row.is_on_curve === 'boolean' ? row.is_on_curve : null,
    exchange: stringValue(row.exchange),
    providerTags,
    buyCount: Math.max(0, Math.trunc(firstNumber(row.buy_tx_count_cur, row.buy_count) ?? 0)),
    sellCount: Math.max(0, Math.trunc(firstNumber(row.sell_tx_count_cur, row.sell_count) ?? 0)),
    startHoldingAt: dateValue(row.start_holding_at),
    lastActivityAt: dateValue(row.last_active_timestamp)
  };
}

export function dedupeResolvedHolders(rows: NormalizedHolderRow[]): ResolvedHolder[] {
  const grouped = new Map<string, ResolvedHolder>();
  for (const row of rows) {
    if (!row.ownerAddress || !isValidSolanaAddress(row.ownerAddress)) continue;
    const existing = grouped.get(row.ownerAddress);
    if (!existing) {
      grouped.set(row.ownerAddress, {
        ...row, ownerAddress: row.ownerAddress,
        tokenAccounts: row.tokenAccount ? [row.tokenAccount] : [], rawRanks: [row.holderRank], infrastructureReason: null
      });
      continue;
    }
    existing.holderRank = Math.min(existing.holderRank, row.holderRank);
    existing.rawRanks.push(row.holderRank);
    if (row.tokenAccount) existing.tokenAccounts = uniqueStrings([...existing.tokenAccounts, row.tokenAccount]);
    existing.balance = addNullable(existing.balance, row.balance);
    existing.supplyPercentage = addNullable(existing.supplyPercentage, row.supplyPercentage);
    existing.positionUsd = addNullable(existing.positionUsd, row.positionUsd);
    existing.buyCount += row.buyCount;
    existing.sellCount += row.sellCount;
    existing.providerTags = uniqueStrings([...existing.providerTags, ...row.providerTags]);
    existing.lastActivityAt = latestDate(existing.lastActivityAt, row.lastActivityAt);
    existing.startHoldingAt = earliestDate(existing.startHoldingAt, row.startHoldingAt);
  }
  return [...grouped.values()].sort((a, b) => a.holderRank - b.holderRank || a.ownerAddress.localeCompare(b.ownerAddress));
}

export function selectIndependentHolderProfiles<T extends { entityKey: string }>(rows: T[], limit: number): T[] {
  const seen = new Set<string>();
  const selected: T[] = [];
  for (const row of rows) {
    if (seen.has(row.entityKey)) continue;
    seen.add(row.entityKey);
    selected.push(row);
    if (selected.length >= limit) break;
  }
  return selected;
}

async function resolveHolderOwners(rows: NormalizedHolderRow[], env: AlchemyRpcEnv): Promise<NormalizedHolderRow[]> {
  const rpcUrl = alchemyRpcUrl('SOLANA', env);
  if (!rpcUrl) throw new Error('Alchemy Solana RPC is not configured');
  const tokenAccounts = uniqueStrings(rows.map((row) => row.tokenAccount).filter(nonNull));
  const tokenAccountInfo = await getMultipleAccounts(rpcUrl, tokenAccounts, 'jsonParsed');
  const ownerAddresses = uniqueStrings(rows.map((row) => parsedTokenOwner(row.tokenAccount ? tokenAccountInfo.get(row.tokenAccount) : null) ?? row.providerOwner).filter(nonNull));
  const ownerInfo = await getMultipleAccounts(rpcUrl, ownerAddresses, 'base64');
  return rows.map((row) => {
    const account = row.tokenAccount ? tokenAccountInfo.get(row.tokenAccount) : null;
    const parsedOwner = parsedTokenOwner(account);
    const ownerAddress = parsedOwner ?? row.providerOwner;
    const ownerAccount = ownerAddress ? ownerInfo.get(ownerAddress) : null;
    const onCurve = ownerAddress ? isEd25519Point(ownerAddress) : null;
    const accountType = !ownerAddress ? 'unknown'
      : ownerAccount?.executable ? 'program'
        : onCurve === false ? (ownerAddress === row.tokenAccount ? 'token_account' : 'pda')
          : 'wallet';
    return {
      ...row,
      accountOwner: stringValue(account?.owner),
      ownerProgram: stringValue(ownerAccount?.owner),
      ownerExecutable: typeof ownerAccount?.executable === 'boolean' ? ownerAccount.executable : null,
      ownerAddress,
      ownerResolution: parsedOwner ? 'rpc_token_account' : ownerAddress ? 'provider_owner' : 'unresolved',
      accountType,
      isOnCurve: onCurve
    };
  });
}

function providerOwnerFallback(row: NormalizedHolderRow): NormalizedHolderRow {
  const ownerAddress = row.providerOwner;
  const onCurve = ownerAddress ? isEd25519Point(ownerAddress) : null;
  return {
    ...row, ownerAddress, ownerResolution: ownerAddress ? 'provider_owner' : 'unresolved', isOnCurve: onCurve,
    accountType: ownerAddress ? onCurve ? 'wallet' : ownerAddress === row.tokenAccount ? 'token_account' : 'pda' : 'unknown'
  };
}

type RpcAccount = { data?: unknown; executable?: boolean; owner?: string } | null;
async function getMultipleAccounts(url: string, addresses: string[], encoding: 'jsonParsed' | 'base64') {
  const output = new Map<string, RpcAccount>();
  for (let index = 0; index < addresses.length; index += 100) {
    const batch = addresses.slice(index, index + 100);
    const result = await alchemyRpcRequest<{ value?: RpcAccount[] }>(url, 'getMultipleAccounts', [batch, { encoding, commitment: 'confirmed' }]);
    const values = result?.value;
    if (!Array.isArray(values) || values.length !== batch.length) throw new Error('Alchemy getMultipleAccounts returned an incomplete response');
    batch.forEach((address, offset) => output.set(address, values[offset] ?? null));
  }
  return output;
}

function parsedTokenOwner(account: RpcAccount | undefined) {
  const data = objectValue(account?.data);
  const parsed = objectValue(data?.parsed);
  const info = objectValue(parsed?.info);
  const owner = stringValue(info?.owner);
  return owner && isValidSolanaAddress(owner) ? owner : null;
}

function infrastructureReason(
  holder: ResolvedHolder,
  registry: { category: string; label: string } | undefined,
  wallet: { status: string; classifications: Array<{ label: string }> } | undefined
) {
  if (BURN_ADDRESSES.has(holder.ownerAddress)) return 'burn_address';
  if (holder.accountType === 'token_account') return 'unresolved_token_account';
  if (holder.accountType === 'program' || holder.ownerExecutable === true) return 'executable_program';
  if (holder.isOnCurve === false || holder.accountType === 'pda') return 'off_curve_pda';
  if (holder.ownerProgram && holder.ownerProgram !== SYSTEM_PROGRAM) return 'program_owned_account';
  if (holder.exchange || holder.providerTags.some((tag) => INFRA_PATTERN.test(tag))) return `provider_infrastructure:${holder.exchange || holder.providerTags.find((tag) => INFRA_PATTERN.test(tag))}`;
  if (registry && ['CEX', 'BRIDGE', 'ROUTER', 'POOL', 'MIXER', 'TOKEN_CONTRACT'].includes(registry.category)) return `registry_${registry.category.toLowerCase()}:${registry.label}`;
  if (wallet?.status === 'excluded' || wallet?.status === 'bot_or_service') return `wallet_status:${wallet.status}`;
  if (wallet?.classifications.some((row) => ['cex_related', 'bridge_related', 'mev'].includes(row.label))) return 'classified_infrastructure';
  return null;
}

async function enrichWallet(source: TokenHolderDataSource, walletAddress: string, now: Date): Promise<LiveEnrichment> {
  const [holdingsResult, activityResult] = await Promise.allSettled([
    source.fetchHoldings(walletAddress, 50),
    source.fetchActivity(walletAddress, 50)
  ]);
  const providerErrors: string[] = [];
  const holdingRows = holdingsResult.status === 'fulfilled' ? holdingsResult.value : (providerErrors.push(`holdings:${safeError(holdingsResult.reason)}`), []);
  const activityRows = activityResult.status === 'fulfilled' ? activityResult.value : (providerErrors.push(`activity:${safeError(activityResult.reason)}`), []);
  const holdings = holdingRows.map(normalizeHolding).filter(nonNull).sort((a, b) => (b.usdValue ?? -1) - (a.usdValue ?? -1)).slice(0, 12);
  const activities = activityRows.map(normalizeActivity).filter(nonNull);
  const tradeActivities = activities.filter((row) => row.side === 'buy' || row.side === 'sell');
  const byToken = groupBy(tradeActivities, (row) => row.tokenAddress);
  const completedProviderPositions = [...byToken.values()].filter((rows) => rows.some((row) => row.side === 'buy') && rows.some((row) => row.side === 'sell')).length;
  const uniqueTradeTokens = byToken.size;
  const traderEvidence = tradeActivities.length >= 4 && uniqueTradeTokens >= 2 || completedProviderPositions >= 1 && tradeActivities.length >= 2;
  return {
    fetchedAt: now.toISOString(), holdings,
    activityCount: activityRows.length,
    tradeEventCount: tradeActivities.length,
    uniqueTradeTokens,
    completedProviderPositions,
    traderEvidence,
    recentTxHashes: uniqueStrings(activities.map((row) => row.txHash).filter(nonNull)).slice(0, 5),
    providerErrors
  };
}

function normalizeHolding(row: Record<string, unknown>): TokenHolderPosition | null {
  const token = objectValue(row.token);
  const tokenAddress = firstAddress(token?.token_address, token?.address, row.token_address);
  const symbol = stringValue(token?.symbol) || (tokenAddress ? tokenAddress.slice(0, 5) : null);
  if (!symbol) return null;
  return { symbol, tokenAddress, usdValue: firstNumber(row.usd_value), supplyPercentage: null };
}

function normalizeActivity(row: Record<string, unknown>) {
  const sideValue = stringValue(row.event_type)?.toLowerCase();
  if (sideValue !== 'buy' && sideValue !== 'sell' && !sideValue?.startsWith('transfer')) return null;
  const token = objectValue(row.token);
  const tokenAddress = firstAddress(token?.address, token?.token_address, row.token_address);
  if (!tokenAddress) return null;
  return {
    side: sideValue === 'buy' || sideValue === 'sell' ? sideValue : 'transfer',
    tokenAddress,
    txHash: stringValue(row.tx_hash),
    timestamp: dateValue(row.timestamp)
  };
}

async function loadLocalHistory(prisma: PrismaClient, walletIds: string[]) {
  if (!walletIds.length) return new Map<string, LocalHistory>();
  const rows = await prisma.walletTokenTrade.findMany({
    where: { walletId: { in: uniqueStrings(walletIds) }, action: { in: ['BUY', 'SELL'] } },
    orderBy: { ts: 'asc' },
    take: 20_000,
    select: {
      walletId: true, action: true, amountUsd: true, valuedUsd: true, ts: true,
      token: { select: { address: true, symbol: true } }
    }
  });
  const byWallet = groupBy(rows, (row) => row.walletId);
  const output = new Map<string, LocalHistory>();
  for (const [walletId, trades] of byWallet) {
    const byToken = groupBy(trades, (row) => row.token.address);
    const completed: Array<{ symbol: string; multiple: number; holdMs: number; won: boolean }> = [];
    let buyCount = 0; let sellCount = 0; let firstBuyAt: Date | null = null; let lastSellAt: Date | null = null; let lastActivityAt: Date | null = null;
    for (const tokenTrades of byToken.values()) {
      const buys = tokenTrades.filter((row) => row.action === 'BUY' && pricedUsd(row) !== null);
      const sells = tokenTrades.filter((row) => row.action === 'SELL' && pricedUsd(row) !== null);
      buyCount += buys.length; sellCount += sells.length;
      for (const row of tokenTrades) lastActivityAt = latestDate(lastActivityAt, row.ts);
      if (!buys.length || !sells.length) continue;
      const firstBuy = buys[0]!.ts;
      const lastSell = sells[sells.length - 1]!.ts;
      if (lastSell <= firstBuy) continue;
      firstBuyAt = earliestDate(firstBuyAt, firstBuy);
      lastSellAt = latestDate(lastSellAt, lastSell);
      const bought = buys.reduce((sum, row) => sum + (pricedUsd(row) ?? 0), 0);
      const sold = sells.reduce((sum, row) => sum + (pricedUsd(row) ?? 0), 0);
      if (bought <= 0 || sold <= 0) continue;
      completed.push({ symbol: tokenTrades[0]!.token.symbol || tokenTrades[0]!.token.address.slice(0, 5), multiple: sold / bought, holdMs: lastSell.getTime() - firstBuy.getTime(), won: sold > bought });
    }
    const wins = completed.filter((row) => row.won).sort((a, b) => b.multiple - a.multiple).slice(0, 3).map(({ symbol, multiple }) => ({ symbol, multiple }));
    output.set(walletId, {
      wins, medianHoldMs: median(completed.map((row) => row.holdMs)), completedPositions: completed.length,
      winCount: completed.filter((row) => row.won).length, lossCount: completed.filter((row) => !row.won).length,
      buyCount, sellCount, firstBuyAt, lastSellAt, lastActivityAt
    });
  }
  return output;
}

function pricedUsd(row: { amountUsd: Prisma.Decimal; valuedUsd: Prisma.Decimal | null }) {
  const value = row.valuedUsd !== null ? Number(row.valuedUsd) : Number(row.amountUsd);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function passReasons(row: RankedHolder) {
  return holderQualificationReasons({
    csvScore: row.csvSeed?.sourceScore,
    seedScore: row.seed?.sourceScore,
    coreWallet: Boolean(row.wallet?.hasLineageRoot),
    flowradarStrong: row.flowradarStrong,
    completedPositions: row.local.completedPositions,
    liveTraderEvidence: row.live?.traderEvidence === true
  });
}

export function holderQualificationReasons(input: {
  csvScore?: number | null;
  seedScore?: number | null;
  coreWallet?: boolean;
  flowradarStrong?: boolean;
  completedPositions?: number;
  liveTraderEvidence?: boolean;
}) {
  const reasons: string[] = [];
  if ((input.csvScore ?? -1) >= 85) reasons.push('csv_high_reliability');
  else if ((input.seedScore ?? -1) >= 85) reasons.push('core_seed_high_reliability');
  if (input.coreWallet) reasons.push('core_wallet');
  if (input.flowradarStrong) reasons.push('persistent_flowradar_intelligence');
  if ((input.completedPositions ?? 0) > 0) reasons.push('locally_validated_history');
  if (input.liveTraderEvidence) reasons.push('live_historical_trader');
  return uniqueStrings(reasons);
}

function holderTags(row: RankedHolder, now: Date) {
  const text = [row.seed?.sourceLabel, row.profile?.role, row.profile?.intelligenceStatus, ...(row.profile?.evidenceSignals ?? []), ...row.providerTags, ...(row.wallet?.classifications ?? [])].filter(nonNull).join(' ');
  const lastActivity = latestDate(row.lastActivityAt, row.profile?.lastActivityAt ?? null, row.local.lastActivityAt);
  const dormant = lastActivity ? now.getTime() - lastActivity.getTime() >= 30 * 86_400_000 : row.seed?.sourceStatus?.toLowerCase() === 'dormant';
  const tags: string[] = [];
  if (dormant) tags.push('Dormant');
  if (/insider/i.test(text)) tags.push('Insider');
  if (/sniper/i.test(text)) tags.push('Sniper');
  if (/(^|\W)kol($|\W)|renowned/i.test(text)) tags.push('KOL');
  if ((row.profile?.historicalAlphaScore ?? 0) >= 65 || /smart_money|high[_ -]?pnl|alpha/i.test(text)) tags.push('Alpha');
  if (row.wallet?.hasLineageRoot) tags.push('Core');
  if ((row.seed?.sourceScore ?? 0) >= 85) tags.push('Seed Match');
  if (row.live?.traderEvidence || row.local.completedPositions > 0) tags.push('Active Trader');
  if ((row.supplyPercentage ?? 0) >= 1 || /whale/i.test(text)) tags.push('Whale');
  return uniqueStrings(tags).slice(0, 3).length ? uniqueStrings(tags).slice(0, 3) : ['Smart Holder'];
}

function finalScore(row: RankedHolder) {
  const reliability = row.reliability ?? 0;
  const holderRankScore = Math.max(0, 102 - row.holderRank * 2);
  const sizeScore = Math.min(100, Math.sqrt(Math.max(0, row.supplyPercentage ?? 0)) * 25);
  const alpha = meaningfulScore(row.profile?.historicalAlphaScore) ?? 0;
  const sample = Math.min(100, row.local.completedPositions * 15 + (row.live?.uniqueTradeTokens ?? 0) * 5);
  const classification = row.flowradarStrong ? 100 : row.live?.traderEvidence ? 75 : (row.seed?.sourceScore ?? 0) >= 85 ? 70 : 0;
  return roundScore(reliability * 0.35 + holderRankScore * 0.15 + sizeScore * 0.10 + alpha * 0.15 + sample * 0.10 + classification * 0.15);
}

function preliminaryScore(holder: ResolvedHolder, reliability: number | null, profile: ProfileMatch | null, wallet: WalletMatch | null) {
  return roundScore((reliability ?? 0) * 0.45 + Math.max(0, 102 - holder.holderRank * 2) * 0.2 + (meaningfulScore(profile?.historicalAlphaScore) ?? 0) * 0.2 + (wallet?.hasLineageRoot ? 100 : 0) * 0.15);
}

function phaseTwoValue(row: RankedHolder) {
  return (row.seed?.sourceScore ?? 0) >= 70 || row.flowradarMatch || row.buyCount + row.sellCount > 0 || row.providerTags.some((tag) => /smart|sniper|whale|kol|top_holder/i.test(tag));
}

function profileHoldings(row: RankedHolder, tokenAddress: string, tokenSymbol: string): TokenHolderPosition[] {
  const analyzed: TokenHolderPosition = { symbol: tokenSymbol, tokenAddress, usdValue: row.positionUsd, supplyPercentage: row.supplyPercentage };
  const additional = (row.live?.holdings ?? [])
    .filter((holding) => holding.tokenAddress !== tokenAddress && (holding.usdValue ?? 0) >= 100)
    .slice(0, 2);
  return [analyzed, ...additional];
}

async function persistHolderReceipts(prisma: PrismaClient, tokenAddress: string, rows: RankedHolder[], accepted: RankedHolder[], now: Date) {
  const acceptedSet = new Set(accepted.map((row) => row.ownerAddress));
  await mapConcurrent(rows, 8, async (row) => {
    const receipt = {
      schemaVersion: 1,
      holderRank: row.holderRank,
      rawRanks: row.rawRanks,
      tokenAccounts: row.tokenAccounts,
      ownerWallet: row.ownerAddress,
      ownerResolution: row.ownerResolution,
      balance: row.balance,
      supplyPercentage: row.supplyPercentage,
      positionUsd: row.positionUsd,
      accountOwner: row.accountOwner,
      ownerProgram: row.ownerProgram,
      accountType: row.accountType,
      isOnCurve: row.isOnCurve,
      infrastructureReason: row.infrastructureReason,
      csvMatch: row.csvSeed,
      seedMatch: row.seed,
      flowradarProfile: row.profile,
      entityKey: row.entityKey,
      liveEnrichment: row.live,
      localHistory: row.local,
      reliability: row.reliability,
      tags: row.tags,
      passReasons: row.passReasons,
      rankingScore: row.rankingScore,
      costBasisStatus: row.local.completedPositions > 0 ? 'locally_validated' : 'unverified_not_displayed',
      computedAt: now.toISOString()
    };
    const coverage = row.infrastructureReason ? 'infrastructure_excluded' : row.local.completedPositions > 0 ? 'local_history' : row.live ? 'provider_history_enriched' : 'holder_only';
    const status = row.infrastructureReason ? 'excluded_infrastructure' : acceptedSet.has(row.ownerAddress) ? 'observation_only' : 'holder_observation';
    const winRate = row.local.completedPositions ? row.local.winCount / row.local.completedPositions : null;
    const create = {
      chain: 'SOLANA' as const,
      tokenAddress,
      walletAddress: row.ownerAddress,
      rank: row.holderRank,
      status,
      role: row.infrastructureReason ? 'infrastructure' : row.tags[0] ?? 'holder',
      entityKey: row.entityKey,
      qualityScore: row.rankingScore,
      evidenceConfidence: row.reliability ?? (row.live?.traderEvidence ? 65 : 25),
      localBuyCount: row.local.buyCount,
      localSellCount: row.local.sellCount,
      localTransferCount: 0,
      entryTs: row.local.firstBuyAt,
      exitTs: row.local.lastSellAt,
      completedPositions: row.local.completedPositions,
      winCount: row.local.winCount,
      lossCount: row.local.lossCount,
      unresolvedPositions: 0,
      winRate,
      coverage,
      supportingEvidenceJson: json(receipt),
      contradictingEvidenceJson: json({ infrastructureReason: row.infrastructureReason, providerErrors: row.live?.providerErrors ?? [], unverifiedCostBasis: row.local.completedPositions === 0 }),
      monitoringEnrolled: false,
      engineVersion: 3,
      computedAt: now
    };
    const { monitoringEnrolled: _monitoringEnrolled, ...update } = create;
    await prisma.tokenWalletIntelligence.upsert({
      where: { chain_tokenAddress_walletAddress: { chain: 'SOLANA', tokenAddress, walletAddress: row.ownerAddress } },
      create,
      update
    });
  });
}

function cachedEnrichment(value: Prisma.JsonValue | undefined, now: Date, ttlMs: number): LiveEnrichment | null {
  const root = objectValue(value);
  const holder = objectValue(root?.holderIntelligence) ?? root;
  const live = objectValue(holder?.liveEnrichment);
  const fetchedAt = dateValue(live?.fetchedAt);
  if (!live || !fetchedAt || now.getTime() - fetchedAt.getTime() > ttlMs) return null;
  const holdings = Array.isArray(live.holdings) ? live.holdings.map((row) => normalizePersistedHolding(row)).filter(nonNull) : [];
  return {
    fetchedAt: fetchedAt.toISOString(), holdings,
    activityCount: integer(live.activityCount), tradeEventCount: integer(live.tradeEventCount),
    uniqueTradeTokens: integer(live.uniqueTradeTokens), completedProviderPositions: integer(live.completedProviderPositions),
    traderEvidence: live.traderEvidence === true,
    recentTxHashes: stringArray(live.recentTxHashes), providerErrors: stringArray(live.providerErrors)
  };
}

function normalizePersistedHolding(value: unknown): TokenHolderPosition | null {
  const row = objectValue(value);
  const symbol = stringValue(row?.symbol);
  if (!symbol) return null;
  return { symbol, tokenAddress: stringValue(row?.tokenAddress), usdValue: firstNumber(row?.usdValue), supplyPercentage: firstNumber(row?.supplyPercentage) };
}

function bestSeed<T extends SeedMatch>(rows: T[]): SeedMatch | null {
  return [...rows].sort((a, b) => (b.sourceScore ?? -1) - (a.sourceScore ?? -1) || a.sourceFile.localeCompare(b.sourceFile))[0] ?? null;
}

function profileMatch(row: ProfileMatch): ProfileMatch { return row; }
function walletMatch(row: { id: string; status: string; isWatched: boolean; lineageRoot: { id: string } | null; classifications: Array<{ label: string }> }): WalletMatch {
  return { id: row.id, status: row.status, isWatched: row.isWatched, hasLineageRoot: Boolean(row.lineageRoot), classifications: row.classifications.map((item) => item.label) };
}
function strongFlowradarProfile(profile: ProfileMatch | null, wallet: WalletMatch | null) {
  return Boolean(
    wallet?.hasLineageRoot || wallet && ['signal_eligible', 'public_kol', 'copytrader'].includes(wallet.status)
    || profile && ((profile.sourceScore ?? 0) >= 85 || profile.evidenceScore >= 50 || profile.historicalAlphaScore >= 65 || ['S', 'A'].includes(profile.tier) || ['root_permanent', 'strong_link'].includes(profile.monitoringPriority))
    || wallet?.classifications.some((label) => ['smart_money', 'sniper', 'whale'].includes(label))
  );
}
function reliabilityScore(seed: SeedMatch | null, profile: ProfileMatch | null) {
  const values = [seed?.sourceScore, profile?.sourceScore, meaningfulScore(profile?.evidenceScore), normalizedConfidence(profile?.confidence)].filter(isNumber).filter((value) => value > 0);
  return values.length ? Math.min(100, Math.max(...values)) : null;
}

function emptyLocalHistory(): LocalHistory { return { wins: [], medianHoldMs: null, completedPositions: 0, winCount: 0, lossCount: 0, buyCount: 0, sellCount: 0, firstBuyAt: null, lastSellAt: null, lastActivityAt: null }; }
function normalizedConfidence(value: number | null | undefined) { if (!isNumber(value) || value <= 0) return null; return value <= 1 ? value * 100 : Math.min(100, value); }
function meaningfulScore(value: number | null | undefined) { return isNumber(value) && value > 0 ? Math.min(100, value) : null; }
function roundScore(value: number) { return Math.round(Math.max(0, Math.min(100, value)) * 10) / 10; }
function placeholderSymbol(symbol: string, tokenAddress: string) { const normalized = symbol.trim().toLowerCase(); return normalized === tokenAddress.slice(0, normalized.length).toLowerCase(); }
function safeError(error: unknown) { return (error instanceof Error ? error.message : String(error)).replace(/https:\/\/\S+/g, '<redacted-url>').slice(0, 240); }
function json(value: unknown) { return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue; }
function objectValue(value: unknown): Record<string, unknown> | null { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function stringValue(value: unknown) { return typeof value === 'string' && value.trim() ? value.trim() : null; }
function firstAddress(...values: unknown[]) { return values.map(stringValue).find((value) => value && isValidSolanaAddress(value)) ?? null; }
function firstNumber(...values: unknown[]) { for (const value of values) { const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN; if (Number.isFinite(parsed)) return parsed; } return null; }
function stringArray(value: unknown) { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => item.trim()) : stringValue(value) ? [stringValue(value)!] : []; }
function uniqueStrings(values: string[]) { return [...new Set(values.filter(Boolean))]; }
function dateValue(value: unknown) { const numeric = typeof value === 'number' || typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : NaN; const date = Number.isFinite(numeric) ? new Date(numeric < 1e12 ? numeric * 1_000 : numeric) : typeof value === 'string' ? new Date(value) : null; return date && Number.isFinite(date.getTime()) && date.getTime() > 0 ? date : null; }
function addNullable(left: number | null, right: number | null) { return left == null ? right : right == null ? left : left + right; }
function latestDate(...values: Array<Date | null>) { return values.filter(nonNull).sort((a, b) => b.getTime() - a.getTime())[0] ?? null; }
function earliestDate(...values: Array<Date | null>) { return values.filter(nonNull).sort((a, b) => a.getTime() - b.getTime())[0] ?? null; }
function median(values: number[]) { if (!values.length) return null; const sorted = [...values].sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2; }
function integer(value: unknown) { const parsed = firstNumber(value); return parsed == null ? 0 : Math.max(0, Math.trunc(parsed)); }
function isNumber(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }
function nonNull<T>(value: T | null | undefined): value is T { return value !== null && value !== undefined; }
function groupBy<T, K>(rows: T[], key: (row: T) => K) { const output = new Map<K, T[]>(); for (const row of rows) { const k = key(row); output.set(k, [...(output.get(k) ?? []), row]); } return output; }
function countBy<T, K>(rows: T[], key: (row: T) => K) { const output = new Map<K, number>(); for (const row of rows) { const k = key(row); output.set(k, (output.get(k) ?? 0) + 1); } return output; }
async function mapConcurrent<T, R>(rows: T[], concurrency: number, worker: (row: T, index: number) => Promise<R>) { const output = new Array<R>(rows.length); let cursor = 0; await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, async () => { while (cursor < rows.length) { const index = cursor++; output[index] = await worker(rows[index]!, index); } })); return output; }

// Same compressed Ed25519 point test used by the Alchemy subscription guard.
// Holder classification keeps it local so no monitoring/subscription code is changed.
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_VALUES = new Map([...BASE58_ALPHABET].map((character, index) => [character, BigInt(index)]));
const ED25519_P = (1n << 255n) - 19n;
function field(value: bigint) { const result = value % ED25519_P; return result < 0n ? result + ED25519_P : result; }
function power(base: bigint, exponent: bigint) { let result = 1n; let value = field(base); let remaining = exponent; while (remaining > 0n) { if (remaining & 1n) result = field(result * value); value = field(value * value); remaining >>= 1n; } return result; }
function inverse(value: bigint) { return power(value, ED25519_P - 2n); }
const ED25519_D = field(-121665n * inverse(121666n));
const ED25519_I = power(2n, (ED25519_P - 1n) / 4n);
function isEd25519Point(address: string) { const bytes = decodeBase58(address); if (!bytes || bytes.length !== 32) return false; const encoded = Uint8Array.from(bytes); const sign = (encoded[31]! >> 7) & 1; encoded[31] = encoded[31]! & 0x7f; let y = 0n; for (let index = 31; index >= 0; index--) y = (y << 8n) + BigInt(encoded[index]!); if (y >= ED25519_P) return false; const ySquared = field(y * y); const xSquared = field((ySquared - 1n) * inverse(field(ED25519_D * ySquared + 1n))); let x = power(xSquared, (ED25519_P + 3n) / 8n); if (field(x * x - xSquared) !== 0n) x = field(x * ED25519_I); return field(x * x - xSquared) === 0n && !(x === 0n && sign === 1); }
function decodeBase58(value: string) { let number = 0n; for (const character of value) { const digit = BASE58_VALUES.get(character); if (digit === undefined) return null; number = number * 58n + digit; } const suffix: number[] = []; while (number > 0n) { suffix.push(Number(number & 0xffn)); number >>= 8n; } suffix.reverse(); let leadingZeroes = 0; while (leadingZeroes < value.length && value[leadingZeroes] === '1') leadingZeroes += 1; return Uint8Array.from([...Array(leadingZeroes).fill(0), ...suffix]); }
