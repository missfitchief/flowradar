import { Prisma, type ChainId, type PrismaClient } from '@prisma/client';
import { buildAddressDormancyObservations } from '../dormancy/addressDormancy';
import { buildEntityDormancyObservations } from '../dormancy/entityDormancy';
import { buildFundingReactivationPaths } from '../dormancy/fundingPaths';
import { normalizeAddress, runUnifiedProfitableWalletDiscovery, validAddress } from '../discovery/unified';
import { buildUnifiedEntityGraph } from '../discovery/unifiedEntity';
import { buildCapitalOutflowPaths, buildReceiverEnrollments } from '../runnermining/capitalOutflow';
import { buildEntityGraph } from '../runnermining/entityGraph';
import { buildWalletDnaProfiles } from '../runnermining/walletDna';
import { enrollObservationWallet } from './monitoring';

export const TOKEN_INTELLIGENCE_ENGINE_VERSION = 1;

export interface TokenIntelligenceReport {
  chain: ChainId;
  tokenAddress: string;
  candidatesFound: number;
  intelligenceRows: number;
  monitoringEnrolled: number;
  locallyVerified: number;
  dormantWallets: number;
  entityLinked: number;
  coverage: string;
  sourceTokenLiveOpportunity: false;
  ranked: Array<{ rank: number; walletAddress: string; qualityScore: number; evidenceConfidence: number; role: string; entityKey: string | null }>;
}

export async function analyzeTokenWalletIntelligence(
  prisma: PrismaClient,
  input: { chain: ChainId; tokenAddress: string; topLimit?: number; now?: Date }
): Promise<TokenIntelligenceReport> {
  const now = input.now ?? new Date();
  const tokenAddress = normalizeAddress(input.chain, input.tokenAddress);
  const topLimit = Math.max(1, Math.min(input.topLimit ?? 25, 100));
  if (!validAddress(input.chain, tokenAddress)) throw new Error(`Invalid ${input.chain} token address`);

  const token = await prisma.token.findUnique({
    where: { chain_address: { chain: input.chain, address: tokenAddress } },
    select: { id: true, firstSeenAt: true, tokenCreatedAt: true }
  });
  const existingUniverse = await prisma.historicalTokenUniverse.findUnique({
    where: { chain_tokenAddress: { chain: input.chain, tokenAddress } }
  });
  const universeData = {
    sources: [...new Set([...(existingUniverse?.sources ?? []), 'token_ca_analysis'])],
    historicalWinnerStatus: existingUniverse?.historicalWinnerStatus ?? 'candidate',
    coverage: existingUniverse?.coverage ?? (token ? 'partially_covered' : 'unavailable'),
    processingStatus: 'pending',
    evidenceJson: json({
      priorEvidence: existingUniverse?.evidenceJson ?? null,
      tokenCaAnalysis: { requestedAt: now.toISOString(), sourceTokenLiveOpportunity: false }
    }),
    nextRetryAt: null,
    lastError: null
  };
  await prisma.historicalTokenUniverse.upsert({
    where: { chain_tokenAddress: { chain: input.chain, tokenAddress } },
    create: {
      chain: input.chain,
      tokenAddress,
      athMcapUsd: existingUniverse?.athMcapUsd ?? null,
      athTs: existingUniverse?.athTs ?? null,
      ...universeData
    },
    update: universeData
  });

  await runUnifiedProfitableWalletDiscovery(prisma, {
    chains: [input.chain],
    tokenAddresses: [tokenAddress],
    limit: 1,
    perTokenLocalCap: topLimit,
    maxTradesPerToken: 100_000,
    requestBudget: 0,
    buildDna: false,
    now
  });

  const candidateRows = await prisma.tokenTopPnlCandidate.findMany({
    where: { chain: input.chain, mint: tokenAddress, validation: { not: 'invalid' } },
    orderBy: [{ confidence: 'desc' }, { localRealizedProxyUsd: 'desc' }, { claimedRealizedPnlUsd: 'desc' }, { walletAddress: 'asc' }],
    take: topLimit * 5
  });
  const candidateByWallet = new Map<string, typeof candidateRows[number]>();
  for (const row of candidateRows) if (!candidateByWallet.has(row.walletAddress)) candidateByWallet.set(row.walletAddress, row);
  const walletAddresses = [...candidateByWallet.keys()].slice(0, topLimit);

  if ((input.chain === 'SOLANA' || input.chain === 'BSC') && walletAddresses.length) {
    const chain = input.chain;
    await buildWalletDnaProfiles(prisma, { chain, walletAddresses, limit: walletAddresses.length, reconstructMissing: true, maxTrades: 100_000, now });
    await buildAddressDormancyObservations(prisma, { chain, walletAddresses, limit: walletAddresses.length, maxEntriesPerWallet: 500, maxTrades: 100_000, maxEdges: 100_000 });
    await buildEntityDormancyObservations(prisma, { chain, walletAddresses, limit: walletAddresses.length * 500, maxLinkedWallets: 25, now });
    await buildFundingReactivationPaths(prisma, { chain, walletAddresses, limit: walletAddresses.length * 500, maxDepth: 3, maxNodes: 50 });
    await buildCapitalOutflowPaths(prisma, { chain, walletAddresses, limit: walletAddresses.length, maxDepth: 3, maxNodes: 50, maxChildrenFirstHop: 50 });
    await buildReceiverEnrollments(prisma, { chain, limit: Math.max(100, walletAddresses.length * 20), maxDeployments: 100, maxTrades: 10_000 });
    await buildEntityGraph(prisma, { chain, now });
  }
  await buildUnifiedEntityGraph(prisma, { now });

  const [dnaRows, dormancyRows, fundingRows, roleRows, entityRows] = await Promise.all([
    prisma.walletDnaProfile.findMany({ where: { chain: input.chain, walletAddress: { in: walletAddresses } } }),
    prisma.addressDormancyObservation.findMany({ where: { chain: input.chain, walletAddress: { in: walletAddresses }, eventKind: 'token_entry', anchorKey: tokenAddress } }),
    prisma.fundingReactivationPath.findMany({ where: { chain: input.chain, walletAddress: { in: walletAddresses }, eventKind: 'token_entry', anchorKey: tokenAddress } }),
    prisma.walletRoleAssignment.findMany({ where: { chain: input.chain, walletAddress: { in: walletAddresses } }, orderBy: [{ confidence: 'desc' }, { computedAt: 'desc' }] }),
    prisma.unifiedEntityAddress.findMany({ where: { chain: input.chain, address: { in: walletAddresses } }, include: { entity: { select: { entityKey: true } } } })
  ]);
  const dnaBy = new Map(dnaRows.map((row) => [row.walletAddress, row]));
  const dormancyBy = new Map(dormancyRows.map((row) => [row.walletAddress, row]));
  const fundingBy = new Map(fundingRows.map((row) => [row.walletAddress, row]));
  const roleBy = new Map<string, typeof roleRows[number]>();
  for (const row of roleRows) if (!roleBy.has(row.walletAddress)) roleBy.set(row.walletAddress, row);
  const entityBy = new Map(entityRows.map((row) => [row.address, row.entity.entityKey]));

  const prepared = [] as Array<{
    walletAddress: string;
    qualityScore: number;
    evidenceConfidence: number;
    role: string;
    entityKey: string | null;
    candidate: typeof candidateRows[number];
    dna: typeof dnaRows[number] | undefined;
    dormancy: typeof dormancyRows[number] | undefined;
    funding: typeof fundingRows[number] | undefined;
    windows: Record<number, boolean | null>;
    localTransferCount: number;
    monitoringEnrolled: boolean;
  }>;
  for (const walletAddress of walletAddresses) {
    const candidate = candidateByWallet.get(walletAddress)!;
    const dna = dnaBy.get(walletAddress);
    const dormancy = dormancyBy.get(walletAddress);
    const funding = fundingBy.get(walletAddress);
    const role = roleBy.get(walletAddress)?.role ?? 'execution_wallet';
    const entityKey = entityBy.get(walletAddress) ?? roleBy.get(walletAddress)?.entityKey ?? null;
    const windows = dormancyWindows(dormancy?.windowsJson);
    const localTransferCount = await prisma.massTransactionEvent.count({
      where: { chain: input.chain, OR: [{ fromAddress: walletAddress }, { toAddress: walletAddress }], kind: { in: ['native_transfer', 'token_transfer'] } }
    });
    const candidateConfidence = normalizeConfidence(candidate.confidence);
    const evidenceConfidence = clamp01(
      candidateConfidence * 0.5 + (dna ? normalizeConfidence(dna.confidence) * 0.3 : 0) + (dormancy ? 0.1 : 0) + (funding?.status === 'funded' ? 0.1 : 0)
    );
    const qualityScore = quality(candidate, dna, windows, evidenceConfidence);
    const enrollment = await enrollObservationWallet(prisma, {
      chain: input.chain,
      address: walletAddress,
      role,
      reason: `token_ca:${tokenAddress};observation_only`,
      firstSeenAt: candidate.localFirstBuyTs ?? token?.firstSeenAt ?? now,
      lastActiveAt: candidate.localLastSellTs ?? candidate.localFirstSellTs ?? candidate.localFirstBuyTs ?? now,
      now
    });
    prepared.push({ walletAddress, qualityScore, evidenceConfidence, role, entityKey, candidate, dna, dormancy, funding, windows, localTransferCount, monitoringEnrolled: Boolean(enrollment.subscription.id) });
  }
  prepared.sort((a, b) => b.qualityScore - a.qualityScore || b.evidenceConfidence - a.evidenceConfidence || a.walletAddress.localeCompare(b.walletAddress));

  for (let index = 0; index < prepared.length; index += 1) {
    const row = prepared[index];
    const data = {
      chain: input.chain,
      tokenAddress,
      walletAddress: row.walletAddress,
      rank: index + 1,
      status: 'observation_only',
      role: row.role,
      entityKey: row.entityKey,
      qualityScore: row.qualityScore,
      evidenceConfidence: row.evidenceConfidence,
      localBuyCount: row.candidate.localBuyCount,
      localSellCount: row.candidate.localSellCount,
      localTransferCount: row.localTransferCount,
      localRealizedPnlUsd: row.candidate.localRealizedProxyUsd,
      entryTs: row.candidate.localFirstBuyTs,
      exitTs: row.candidate.localLastSellTs ?? row.candidate.localFirstSellTs,
      dormant7d: row.windows[7], dormant14d: row.windows[14], dormant30d: row.windows[30], dormant90d: row.windows[90],
      funderAddress: row.funding?.directFunderAddress ?? row.funding?.firstFunderAddress ?? null,
      funderTxHash: row.funding?.directFundingTxHash ?? row.funding?.firstFundingTxHash ?? null,
      completedPositions: row.dna?.completedPositions ?? 0,
      winCount: row.dna?.winCount ?? 0,
      lossCount: row.dna?.lossCount ?? 0,
      unresolvedPositions: (row.dna?.openPositions ?? 0) + (row.dna?.unpricedPositions ?? 0),
      winRate: row.dna?.winRate ?? null,
      evUsd: row.dna?.evUsdPerCompletedPosition ?? null,
      repeatRunnerCount: row.dna?.repeatRunnerCount ?? null,
      oneWinnerDependence: row.dna?.oneWinnerDependence ?? null,
      coverage: row.dna?.coverage ?? row.candidate.coverage,
      supportingEvidenceJson: json({
        candidate: { id: row.candidate.id, source: row.candidate.source, validation: row.candidate.validation, receipts: row.candidate.receiptsJson },
        dormancy: row.dormancy ? { class: row.dormancy.overallClass, windows: row.dormancy.windowsJson, receipts: row.dormancy.receiptsJson } : null,
        funding: row.funding ? { status: row.funding.status, path: row.funding.pathJson, receipts: row.funding.receiptsJson } : null,
        dna: row.dna ? { outcomeMix: row.dna.outcomeMixJson, discovery: row.dna.discoveryJson, receipts: row.dna.receiptsJson } : null,
        entityKey: row.entityKey
      }),
      contradictingEvidenceJson: json({
        candidateCaveats: row.candidate.caveats,
        unpricedTrades: row.candidate.localUnpricedTrades,
        dnaNegativeEvidence: row.dna?.negativeEvidenceJson ?? null,
        dnaCaveats: row.dna?.caveats ?? [],
        missingDormancyCoverage: !row.dormancy,
        missingFundingEvidence: !row.funding
      }),
      monitoringEnrolled: row.monitoringEnrolled,
      engineVersion: TOKEN_INTELLIGENCE_ENGINE_VERSION,
      computedAt: now
    };
    await prisma.tokenWalletIntelligence.upsert({
      where: { chain_tokenAddress_walletAddress: { chain: input.chain, tokenAddress, walletAddress: row.walletAddress } },
      create: data,
      update: data
    });
  }
  await prisma.tokenWalletIntelligence.deleteMany({
    where: { chain: input.chain, tokenAddress, walletAddress: { notIn: prepared.map((row) => row.walletAddress) } }
  });

  return {
    chain: input.chain,
    tokenAddress,
    candidatesFound: candidateByWallet.size,
    intelligenceRows: prepared.length,
    monitoringEnrolled: prepared.filter((row) => row.monitoringEnrolled).length,
    locallyVerified: prepared.filter((row) => row.candidate.validation === 'locally_verified').length,
    dormantWallets: prepared.filter((row) => Object.values(row.windows).some((value) => value === true)).length,
    entityLinked: prepared.filter((row) => row.entityKey).length,
    coverage: prepared.length ? (prepared.every((row) => row.dna?.coverage === 'full') ? 'full' : 'partial') : 'unavailable',
    sourceTokenLiveOpportunity: false,
    ranked: prepared.map((row, index) => ({ rank: index + 1, walletAddress: row.walletAddress, qualityScore: row.qualityScore, evidenceConfidence: row.evidenceConfidence, role: row.role, entityKey: row.entityKey }))
  };
}

function dormancyWindows(value: Prisma.JsonValue | undefined): Record<number, boolean | null> {
  const result: Record<number, boolean | null> = { 7: null, 14: null, 30: null, 90: null };
  if (!Array.isArray(value)) return result;
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const window = item as Record<string, unknown>;
    const days = Number(window.windowDays);
    if (![7, 14, 30, 90].includes(days)) continue;
    result[days] = window.class === 'covered_dormant' ? true : window.class === 'active' || window.class === 'fresh' ? false : null;
  }
  return result;
}

function quality(candidate: { validation: string; localRealizedProxyUsd: Prisma.Decimal | null; confidence: number }, dna: { winRate: number | null; repeatRunnerCount: number | null; oneWinnerDependence: number | null; coverage: string } | undefined, windows: Record<number, boolean | null>, confidence: number) {
  const pnl = Number(candidate.localRealizedProxyUsd ?? 0);
  let score = confidence * 20;
  score += candidate.validation === 'locally_verified' ? 20 : candidate.validation === 'partially_verified' ? 10 : 0;
  if (pnl > 0) score += Math.min(20, Math.log10(pnl + 1) * 4);
  if (dna?.winRate != null) score += dna.winRate * 15;
  if (dna?.repeatRunnerCount != null) score += Math.min(15, dna.repeatRunnerCount * 3);
  if (Object.values(windows).some((value) => value === true)) score += 10;
  if (dna?.oneWinnerDependence != null) score -= dna.oneWinnerDependence * 10;
  if (dna?.coverage === 'minimal') score -= 10;
  return Math.round(Math.max(0, Math.min(100, score)) * 100) / 100;
}
function normalizeConfidence(value: number) { return clamp01(value > 1 ? value / 100 : value); }
function clamp01(value: number) { return Math.max(0, Math.min(1, value)); }
function json(value: unknown): Prisma.InputJsonValue { return value as Prisma.InputJsonValue; }
