import type { ChainId, PrismaClient } from '@prisma/client';
import type {
  InvestigationDeployment,
  InvestigationDeploymentIntelligence,
  InvestigationEvidenceSignal,
  InvestigationMember,
  InvestigationMemberIntelligence,
  WalletInvestigationResult
} from './types';

export const WALLET_INTELLIGENCE_SCORE_VERSION = 1;

interface RelationshipEvidence {
  relatedChain: ChainId;
  relatedWallet: string;
  route: string;
  role: string;
  transferCount: number;
  relationshipConfidence: number;
  safeEntityLink: boolean;
  transferReceiptIds: string[];
  bridgeCorrelationIds: string[];
  supportingEvidence: unknown;
  contradictingEvidence: unknown;
}

interface DnaEvidence {
  coverage: string;
  confidence: number;
  tokensEntered: number;
  runnersEntered: number;
  completedPositions: number;
  winRate: number | null;
  evUsd: number | null;
  oneWinnerDependence: number | null;
  avgReturn: number | null;
  medianReturn: number | null;
  realizedPnlUsd: number | null;
  repeatRunnerCount: number | null;
  medianEntryMcapUsd: number | null;
}

interface WalletScoreContext {
  relationships: RelationshipEvidence[];
  roleReasonCodes: string[];
  dna: DnaEvidence | null;
  stats: { winRate: number; realizedPnlUsd: number; tradeCount: number; confidence: number } | null;
  tokenIntelligence: Array<{
    tokenAddress: string;
    qualityScore: number;
    evidenceConfidence: number;
    localRealizedPnlUsd: number | null;
    completedPositions: number;
    winCount: number;
    lossCount: number;
    winRate: number | null;
    repeatRunnerCount: number | null;
    oneWinnerDependence: number | null;
    coverage: string;
  }>;
  topPnl: Array<{ mint: string; claimedRoi: number | null; validation: string; confidence: number }>;
  dormancyDays: number | null;
  dormancyClasses: string[];
  repeatRunner: { runners: number; score: number | null; oneWinnerDependence: number | null } | null;
  dormantRunner: { pattern: string; events: number; confidence: number } | null;
  deployments: InvestigationDeployment[];
  paths: WalletInvestigationResult['paths'];
}

interface DeploymentOutcome {
  athMcapUsd: number | null;
  athBasis: InvestigationDeploymentIntelligence['athBasis'];
}

export async function enrichWalletInvestigation(prisma: PrismaClient, value: WalletInvestigationResult): Promise<WalletInvestigationResult> {
  const refs = value.members.map((member) => ({ chain: member.chain, address: member.address }));
  const refKeys = new Set(refs.map((ref) => refKey(ref.chain, ref.address)));
  const addresses = unique(refs.map((ref) => ref.address));
  const chains = unique(refs.map((ref) => ref.chain));
  const roots = value.members.filter((member) => member.role === 'root_main').map((member) => member.address);
  const tokenAddresses = unique(value.deployments.map((deployment) => deployment.tokenAddress));

  const [relationships, roleRows, dnaRows, walletRows, dormancyRows, entityDormancyRows, repeatRows, dormantRunnerRows, tokenIntelRows, topPnlRows, tokenRows, universeRows, lifecycleRows, enrichmentRows] = await Promise.all([
    prisma.walletFlowRelationship.findMany({
      where: { sourceWallet: { in: roots } },
      take: 10_000
    }),
    prisma.walletRoleAssignment.findMany({ where: { chain: { in: chains }, walletAddress: { in: addresses } }, take: 10_000 }),
    prisma.walletDnaProfile.findMany({ where: { chain: { in: chains }, walletAddress: { in: addresses } }, take: 5_000 }),
    prisma.wallet.findMany({
      where: { chain: { in: chains }, address: { in: addresses } },
      include: { stats: { orderBy: { computedAt: 'desc' }, take: 1 } },
      take: 5_000
    }),
    prisma.addressDormancyObservation.findMany({
      where: { chain: { in: chains }, walletAddress: { in: addresses } },
      orderBy: { eventTs: 'desc' }, take: 20_000
    }),
    prisma.entityDormancyObservation.findMany({
      where: { chain: { in: chains }, walletAddress: { in: addresses } },
      orderBy: { eventTs: 'desc' }, take: 20_000
    }),
    prisma.repeatRunnerCandidate.findMany({ where: { memberWallets: { hasSome: addresses } }, take: 2_000 }),
    prisma.dormantRunnerCandidate.findMany({ where: { memberWallets: { hasSome: addresses } }, take: 2_000 }),
    prisma.tokenWalletIntelligence.findMany({ where: { chain: { in: chains }, walletAddress: { in: addresses } }, take: 20_000 }),
    prisma.tokenTopPnlCandidate.findMany({ where: { chain: { in: chains }, walletAddress: { in: addresses } }, take: 20_000 }),
    tokenAddresses.length ? prisma.token.findMany({
      where: { chain: { in: chains }, address: { in: tokenAddresses } },
      include: { marketSnapshots: { orderBy: { marketCapUsd: 'desc' }, take: 1 } }, take: 10_000
    }) : Promise.resolve([]),
    tokenAddresses.length ? prisma.historicalTokenUniverse.findMany({ where: { chain: { in: chains }, tokenAddress: { in: tokenAddresses } }, take: 10_000 }) : Promise.resolve([]),
    tokenAddresses.length ? prisma.tokenLifecycle.findMany({ where: { mint: { in: tokenAddresses } }, take: 10_000 }) : Promise.resolve([]),
    tokenAddresses.length ? prisma.tokenEnrichment.findMany({ where: { mint: { in: tokenAddresses } }, take: 10_000 }) : Promise.resolve([])
  ]);

  const relationshipsByWallet = groupBy(relationships
    .filter((row) => refKeys.has(refKey(row.relatedChain, row.relatedWallet)))
    .map((row): RelationshipEvidence => ({
      relatedChain: row.relatedChain, relatedWallet: row.relatedWallet, route: row.route, role: row.role,
      transferCount: row.transferCount, relationshipConfidence: row.relationshipConfidence, safeEntityLink: row.safeEntityLink,
      transferReceiptIds: row.transferReceiptIds, bridgeCorrelationIds: row.bridgeCorrelationIds,
      supportingEvidence: row.supportingEvidenceJson, contradictingEvidence: row.contradictingEvidenceJson
    })), (row) => refKey(row.relatedChain, row.relatedWallet));
  const rolesByWallet = groupBy(roleRows.filter((row) => refKeys.has(refKey(row.chain, row.walletAddress))), (row) => refKey(row.chain, row.walletAddress));
  const dnaByWallet = new Map(dnaRows.filter((row) => refKeys.has(refKey(row.chain, row.walletAddress))).map((row) => [refKey(row.chain, row.walletAddress), dnaEvidence(row)]));
  const statsByWallet = new Map(walletRows.filter((row) => refKeys.has(refKey(row.chain, row.address))).map((row) => {
    const stats = row.stats[0];
    return [refKey(row.chain, row.address), stats ? { winRate: stats.winRate, realizedPnlUsd: decimal(stats.realizedPnlUsd) ?? 0, tradeCount: stats.tradeCount, confidence: stats.pnlConfidence / 100 } : null] as const;
  }));
  const dormancyByWallet = groupBy(dormancyRows.filter((row) => refKeys.has(refKey(row.chain, row.walletAddress))), (row) => refKey(row.chain, row.walletAddress));
  const entityDormancyByWallet = groupBy(entityDormancyRows.filter((row) => refKeys.has(refKey(row.chain, row.walletAddress))), (row) => refKey(row.chain, row.walletAddress));
  const tokenIntelByWallet = groupBy(tokenIntelRows.filter((row) => refKeys.has(refKey(row.chain, row.walletAddress))), (row) => refKey(row.chain, row.walletAddress));
  const topPnlByWallet = groupBy(topPnlRows.filter((row) => refKeys.has(refKey(row.chain, row.walletAddress))), (row) => refKey(row.chain, row.walletAddress));
  const deploymentByWallet = groupBy(value.deployments, (row) => refKey(row.chain, row.buyerAddress));
  const pathsByWallet = groupBy(value.paths.filter((path) => path.routeType !== 'token_deployment'), (path) => refKey(path.destinationChain, path.destinationAddress));
  const repeatByWallet = new Map<string, typeof repeatRows[number]>();
  for (const row of repeatRows) for (const address of row.memberWallets) for (const chain of chains) {
    const key = refKey(chain, address);
    if (refKeys.has(key) && (!repeatByWallet.has(key) || (row.score ?? 0) > (repeatByWallet.get(key)?.score ?? 0))) repeatByWallet.set(key, row);
  }
  const dormantRunnerByWallet = new Map<string, typeof dormantRunnerRows[number]>();
  for (const row of dormantRunnerRows) for (const address of row.memberWallets) for (const chain of chains) {
    const key = refKey(chain, address);
    if (refKeys.has(key) && (!dormantRunnerByWallet.has(key) || row.confidence > (dormantRunnerByWallet.get(key)?.confidence ?? 0))) dormantRunnerByWallet.set(key, row);
  }
  const outcomes = deploymentOutcomes(tokenRows, universeRows, lifecycleRows, enrichmentRows);

  const members = value.members.map((member) => {
    const key = refKey(member.chain, member.address);
    const dormancy = dormancyByWallet.get(key) ?? [];
    const entityDormancy = entityDormancyByWallet.get(key) ?? [];
    const repeat = repeatByWallet.get(key);
    const dormantRunner = dormantRunnerByWallet.get(key);
    const context: WalletScoreContext = {
      relationships: relationshipsByWallet.get(key) ?? [],
      roleReasonCodes: unique((rolesByWallet.get(key) ?? []).flatMap((row) => row.reasonCodes)),
      dna: dnaByWallet.get(key) ?? null,
      stats: statsByWallet.get(key) ?? null,
      tokenIntelligence: (tokenIntelByWallet.get(key) ?? []).map((row) => ({
        tokenAddress: row.tokenAddress, qualityScore: row.qualityScore, evidenceConfidence: row.evidenceConfidence,
        localRealizedPnlUsd: decimal(row.localRealizedPnlUsd), completedPositions: row.completedPositions,
        winCount: row.winCount, lossCount: row.lossCount, winRate: row.winRate, repeatRunnerCount: row.repeatRunnerCount,
        oneWinnerDependence: row.oneWinnerDependence, coverage: row.coverage
      })),
      topPnl: (topPnlByWallet.get(key) ?? []).map((row) => ({ mint: row.mint, claimedRoi: row.claimedRoi, validation: row.validation, confidence: row.confidence })),
      dormancyDays: maxNullable(dormancy.map((row) => row.maxCoveredDormantDays)),
      dormancyClasses: unique([...dormancy.map((row) => row.overallClass), ...entityDormancy.map((row) => row.entityClass)]),
      repeatRunner: repeat ? { runners: repeat.distinctRunnersEntered, score: repeat.score, oneWinnerDependence: repeat.oneWinnerDependence } : null,
      dormantRunner: dormantRunner ? { pattern: dormantRunner.pattern, events: dormantRunner.dormantEntryEvents + dormantRunner.sideWalletActivationEvents + dormantRunner.freshFundingEvents, confidence: dormantRunner.confidence } : null,
      deployments: deploymentByWallet.get(key) ?? [],
      paths: pathsByWallet.get(key) ?? []
    };
    return { ...member, intelligence: scoreMember(member, context, value.completedAt) };
  });
  const intelligenceByWallet = new Map(members.map((member) => [refKey(member.chain, member.address), member.intelligence!]));
  const deployments = value.deployments.map((deployment) => ({
    ...deployment,
    intelligence: scoreDeployment(deployment, outcomes.get(refKey(deployment.chain, deployment.tokenAddress)), intelligenceByWallet.get(refKey(deployment.chain, deployment.buyerAddress)), topPnlByWallet.get(refKey(deployment.chain, deployment.buyerAddress)) ?? [])
  }));
  return { ...value, members, deployments };
}

export function scoreMember(member: InvestigationMember, context: WalletScoreContext, completedAt: string | null): InvestigationMemberIntelligence {
  if (/service|router|cex|infrastructure/i.test(member.role)) return infrastructureScore();
  if (member.role === 'root_main') {
    const alpha = historicalAlpha(context);
    const wake = wakeUpScore(100, alpha.score, context, member, completedAt);
    return {
      evidenceScore: 100, historicalAlphaScore: alpha.score, wakeUpPotential: wake.score, tier: tierFor(100, alpha.score, wake.score, 0, true),
      trackingPriority: 'track_now', independentSignalCount: 0, clusterConclusion: 'supported',
      evidenceSignals: [{ code: 'operator_seed', label: 'Operator investigation seed', strength: 1, weight: 100, receiptCount: 1 }],
      whyImportant: unique(['Investigation root; tracked as a capital source, not assumed to be an execution wallet.', ...alpha.reasons, ...wake.reasons]).slice(0, 4),
      contradictions: [], historicalCoverage: alpha.coverage, metrics: metrics(context), scoreVersion: WALLET_INTELLIGENCE_SCORE_VERSION
    };
  }

  const signals = evidenceSignals(member, context);
  const contradictions = contradictionReasons(context.relationships);
  const contradictionPenalty = Math.min(30, contradictions.reduce((sum, reason) => sum + (/cex|inference/i.test(reason) ? 12 : 6), 0));
  const rawEvidence = signals.reduce((sum, signal) => sum + signal.weight * signal.strength, 0) * (0.75 + 0.25 * clamp01(member.relationshipConfidence));
  const evidenceScore = Math.round(Math.max(0, Math.min(signals.length < 2 ? 49 : 100, rawEvidence - contradictionPenalty)));
  const alpha = historicalAlpha(context);
  const wake = wakeUpScore(evidenceScore, alpha.score, context, member, completedAt);
  const tier = tierFor(evidenceScore, alpha.score, wake.score, signals.length, false);
  const clusterConclusion = signals.length < 2 ? 'unconfirmed' : evidenceScore >= 75 ? 'supported' : evidenceScore >= 60 ? 'probable' : evidenceScore >= 40 ? 'possible' : 'unconfirmed';
  const important = [
    signals.length >= 2 ? `${signals.length} independent on-chain/behavioral signals support this relationship.` : 'Only one independent relationship signal is available; ownership is not concluded.',
    context.deployments.length ? `${unique(context.deployments.map((row) => row.tokenAddress)).length} token buys observed after funding.` : null,
    ...wake.reasons,
    ...alpha.reasons
  ].filter(nonNull);
  return {
    evidenceScore, historicalAlphaScore: alpha.score, wakeUpPotential: wake.score, tier,
    trackingPriority: tier === 'S' || tier === 'A' ? 'track_now' : tier === 'B' ? 'watch' : 'context_only',
    independentSignalCount: signals.length, clusterConclusion, evidenceSignals: signals,
    whyImportant: unique(important).slice(0, 5), contradictions, historicalCoverage: alpha.coverage,
    metrics: metrics(context), scoreVersion: WALLET_INTELLIGENCE_SCORE_VERSION
  };
}

function evidenceSignals(member: InvestigationMember, context: WalletScoreContext) {
  const signals = new Map<string, InvestigationEvidenceSignal>();
  const add = (code: string, label: string, weight: number, strength: number, receipts: number) => {
    const current = signals.get(code);
    const next = { code, label, weight, strength: clamp01(strength), receiptCount: Math.max(1, receipts) };
    if (!current || current.weight * current.strength < next.weight * next.strength) signals.set(code, next);
  };
  for (const relationship of context.relationships) {
    const confidence = clamp01(relationship.relationshipConfidence);
    if (relationship.route === 'direct_transfer') add('direct_funding', 'Direct funding', 28, confidence, relationship.transferReceiptIds.length || relationship.transferCount);
    if (relationship.route === 'multi_hop_transfer') add('multi_hop_funding', 'Multi-hop funding', 16, confidence, relationship.transferReceiptIds.length || relationship.transferCount);
    if (relationship.route === 'exact_bridge') add('exact_bridge', 'Exact bridge source→destination receipt', 26, confidence, relationship.bridgeCorrelationIds.length || 1);
    if (relationship.route === 'bridge_inference') add('bridge_inference', 'Bridge-linked inference', 8, confidence, relationship.bridgeCorrelationIds.length || 1);
    if (relationship.transferCount >= 2) add('repeated_funding', 'Repeated funding pattern', 18, Math.min(1, 0.55 + Math.log10(relationship.transferCount + 1) / 4), relationship.transferCount);
    const evidenceText = flattenEvidence([relationship.supportingEvidence, context.roleReasonCodes]).join(' ');
    if (/shared[_ -]?funder|common[_ -]?funder/i.test(evidenceText)) add('shared_funder', 'Shared funder', 16, confidence, 1);
    if (/shared[_ -]?deployer|common[_ -]?deployer/i.test(evidenceText)) add('shared_deployer', 'Shared deployer', 18, confidence, 1);
    if (/shared[_ -]?(lp|liquidity)/i.test(evidenceText)) add('shared_lp', 'Shared LP wallet', 16, confidence, 1);
    if (/timing[_ -]?(correlation|match)|coordinated[_ -]?timing/i.test(evidenceText)) add('timing_correlation', 'Timing correlation', 10, confidence, 1);
  }
  const uniqueTokens = unique(context.deployments.map((row) => row.tokenAddress)).length;
  const fastDeployments = context.deployments.filter((row) => row.fundingToBuyDelaySec !== null && row.fundingToBuyDelaySec <= 86_400).length;
  if (/execution|side|alt|profit_collector/i.test(member.role) && uniqueTokens > 0) add('execution_pattern', 'Post-funding execution pattern', 14, Math.min(1, 0.65 + uniqueTokens / 20), uniqueTokens);
  if (uniqueTokens >= 2) add('repeated_behavior', 'Repeated post-funding token behavior', 14, Math.min(1, 0.55 + uniqueTokens / 20), uniqueTokens);
  if (fastDeployments > 0) add('funding_buy_timing', 'Funding→buy timing correlation', 12, Math.min(1, 0.65 + fastDeployments / 10), fastDeployments);
  if (context.paths.some((path) => path.routeType === 'profit_return')) add('profit_return', 'Observed profit return path', 14, 0.85, context.paths.filter((path) => path.routeType === 'profit_return').length);
  return [...signals.values()].sort((a, b) => b.weight * b.strength - a.weight * a.strength || a.code.localeCompare(b.code));
}

function historicalAlpha(context: WalletScoreContext) {
  let score = 0;
  const reasons: string[] = [];
  const dna = context.dna;
  const completed = dna?.completedPositions ?? context.tokenIntelligence.reduce((sum, row) => sum + row.completedPositions, 0);
  const winRate = dna?.winRate ?? weightedWinRate(context.tokenIntelligence) ?? context.stats?.winRate ?? null;
  const repeatRunners = dna?.repeatRunnerCount ?? context.repeatRunner?.runners ?? maxNullable(context.tokenIntelligence.map((row) => row.repeatRunnerCount));
  const realizedPnl = dna?.realizedPnlUsd ?? sumNullable(context.tokenIntelligence.map((row) => row.localRealizedPnlUsd)) ?? context.stats?.realizedPnlUsd ?? null;
  const medianEntry = dna?.medianEntryMcapUsd ?? median(context.deployments.map((row) => row.entryMarketCapUsd).filter(nonNull));
  const avgReturn = dna?.avgReturn ?? dna?.medianReturn ?? null;
  const oneWinner = dna?.oneWinnerDependence ?? context.repeatRunner?.oneWinnerDependence ?? minNullable(context.tokenIntelligence.map((row) => row.oneWinnerDependence));

  if (medianEntry !== null) {
    const early = medianEntry <= 100_000 ? 15 : medianEntry <= 500_000 ? 12 : medianEntry <= 2_000_000 ? 8 : medianEntry <= 10_000_000 ? 4 : 0;
    score += early;
    if (early >= 8) reasons.push(`Historically early entries; median entry market cap ${moneyCompact(medianEntry)}.`);
  }
  if (avgReturn !== null) {
    score += Math.min(20, Math.max(0, avgReturn) * 10);
    if (avgReturn > 0) reasons.push(`Observed average/median return ${Math.round(avgReturn * 100)}%.`);
  } else {
    const providerRoi = Math.max(0, ...context.topPnl.filter((row) => row.validation !== 'invalid').map((row) => row.claimedRoi ?? 0));
    if (providerRoi > 0) {
      score += Math.min(10, providerRoi * 4);
      reasons.push('Positive provider ROI exists, but local validation is incomplete.');
    }
  }
  if (winRate !== null && completed >= 3) {
    score += Math.max(0, Math.min(20, winRate * 20));
    reasons.push(`${Math.round(winRate * 100)}% win rate across ${completed} completed positions.`);
  }
  if (repeatRunners !== null && repeatRunners > 0) {
    score += Math.min(15, repeatRunners * 4);
    reasons.push(`${repeatRunners} repeat-runner wins/entries in covered history.`);
  }
  if (realizedPnl !== null && realizedPnl > 0) {
    score += Math.min(10, Math.max(1, Math.log10(realizedPnl + 1) * 2));
    reasons.push(`Positive locally covered realized PnL ${moneyCompact(realizedPnl)}.`);
  }
  if (oneWinner !== null) score += Math.max(0, Math.min(10, (1 - oneWinner) * 10));
  const uniqueDeployments = unique(context.deployments.map((row) => row.tokenAddress)).length;
  if (uniqueDeployments > 0) {
    score += Math.min(5, Math.log2(uniqueDeployments + 1));
    reasons.push(`${uniqueDeployments} distinct post-funding token deployments observed; unresolved outcomes are not counted as wins.`);
  }
  const coverage = dna ? normalizeCoverage(dna.coverage) : context.tokenIntelligence.length || context.stats ? 'partial' : uniqueDeployments ? 'minimal' : 'unavailable';
  const confidence = dna?.confidence ?? maxNullable(context.tokenIntelligence.map((row) => row.evidenceConfidence)) ?? context.stats?.confidence ?? (uniqueDeployments ? 0.55 : 0);
  const adjusted = Math.round(Math.max(0, Math.min(100, score * (0.7 + 0.3 * clamp01(confidence)))));
  if (coverage === 'unavailable' || coverage === 'minimal') reasons.push('Historical outcome coverage is insufficient; unknown ROI/ATH is not treated as zero or as a win.');
  return { score: adjusted, reasons: unique(reasons), coverage };
}

function wakeUpScore(evidence: number, alpha: number, context: WalletScoreContext, member: InvestigationMember, completedAt: string | null) {
  const asOf = completedAt ? Date.parse(completedAt) : Number.NaN;
  const lastLinked = Date.parse(member.lastLinkedAt);
  const silentDays = Number.isFinite(asOf) && Number.isFinite(lastLinked) ? Math.max(0, Math.floor((asOf - lastLinked) / 86_400_000)) : null;
  const dormantDays = Math.max(context.dormancyDays ?? 0, silentDays ?? 0, /dormant/i.test(member.role) ? 30 : 0);
  const dormantBonus = dormantDays >= 365 ? 15 : dormantDays >= 90 ? 12 : dormantDays >= 30 ? 8 : dormantDays >= 7 ? 4 : 0;
  const uniqueTokens = unique(context.deployments.map((row) => row.tokenAddress)).length;
  const repeatPattern = Math.min(20, Math.log2(uniqueTokens + 1) * 4 + Math.min(8, (context.repeatRunner?.runners ?? 0) * 2) + (context.dormantRunner && context.dormantRunner.pattern !== 'one_off' && context.dormantRunner.pattern !== 'insufficient_evidence' ? 6 : 0));
  const score = Math.round(Math.max(0, Math.min(100, alpha * 0.35 + evidence * 0.3 + repeatPattern + dormantBonus)));
  const reasons = [
    dormantDays >= 90 ? `${dormantDays}d dormant/silent history increases monitoring value; it is not a penalty.` : null,
    context.dormantRunner && context.dormantRunner.pattern !== 'one_off' && context.dormantRunner.pattern !== 'insufficient_evidence' ? `Repeated dormant-runner pattern: ${context.dormantRunner.pattern.replaceAll('_', ' ')}.` : null,
    uniqueTokens >= 2 ? `Repeated execution across ${uniqueTokens} post-funding tokens supports permanent monitoring.` : null
  ].filter(nonNull);
  return { score, reasons };
}

function tierFor(evidence: number, alpha: number, wake: number, signals: number, root: boolean): InvestigationMemberIntelligence['tier'] {
  if (!root && signals >= 3 && evidence >= 80 && alpha >= 70 && wake >= 75) return 'S';
  if (!root && signals >= 3 && evidence >= 65 && (alpha >= 45 || wake >= 40 || evidence >= 80)) return 'A';
  if ((root && (alpha >= 50 || wake >= 50)) || (signals >= 2 && evidence >= 40) || alpha >= 45 || wake >= 45) return 'B';
  return 'C';
}

function scoreDeployment(deployment: InvestigationDeployment, outcome: DeploymentOutcome | undefined, wallet: InvestigationMemberIntelligence | undefined, topPnlRows: Array<{ mint: string; claimedRoi: number | null; validation: string; confidence: number }>): InvestigationDeploymentIntelligence {
  const athMcapUsd = outcome?.athMcapUsd ?? null;
  const potentialRoi = athMcapUsd !== null && deployment.entryMarketCapUsd !== null && deployment.entryMarketCapUsd > 0 ? Math.max(-1, athMcapUsd / deployment.entryMarketCapUsd - 1) : null;
  const provider = topPnlRows.filter((row) => row.mint === deployment.tokenAddress && row.validation !== 'invalid' && row.claimedRoi !== null).sort((a, b) => b.confidence - a.confidence)[0];
  const roi = potentialRoi ?? provider?.claimedRoi ?? null;
  const roiBasis: InvestigationDeploymentIntelligence['roiBasis'] = potentialRoi !== null ? 'ath_over_entry_potential' : provider ? 'provider_claimed' : 'unavailable';
  const roiValue = roi === null ? 0 : Math.min(25, Math.max(0, Math.log2(Math.max(1, roi + 1)) * 6));
  const athValue = athMcapUsd === null ? 0 : Math.min(15, Math.max(0, Math.log10(Math.max(1, athMcapUsd / 100_000)) * 5));
  const importanceScore = Math.round(Math.min(100, (wallet?.historicalAlphaScore ?? 0) * 0.4 + (wallet?.evidenceScore ?? 0) * 0.25 + (wallet?.wakeUpPotential ?? 0) * 0.15 + roiValue + athValue));
  const whyImportant = [
    wallet?.tier === 'S' || wallet?.tier === 'A' ? `Bought by Tier ${wallet.tier} wallet.` : null,
    roi !== null ? `${roiBasis === 'ath_over_entry_potential' ? 'ATH-over-entry potential' : 'Provider-claimed'} ROI ${Math.round(roi * 100)}%.` : 'ROI unavailable; not fabricated.',
    athMcapUsd !== null ? `Covered ATH market cap ${moneyCompact(athMcapUsd)}.` : 'ATH coverage unavailable.',
    deployment.fundingToBuyDelaySec !== null && deployment.fundingToBuyDelaySec <= 86_400 ? `Funding→buy in ${duration(deployment.fundingToBuyDelaySec)}.` : null
  ].filter(nonNull);
  return { athMcapUsd, athBasis: outcome?.athBasis ?? 'unavailable', roi, roiBasis, importanceScore, whyImportant };
}

function deploymentOutcomes(
  tokenRows: Array<{ chain: ChainId; address: string; marketSnapshots: Array<{ marketCapUsd: unknown }> }>,
  universeRows: Array<{ chain: ChainId; tokenAddress: string; athMcapUsd: unknown }>,
  lifecycleRows: Array<{ mint: string; athMcapUsd: unknown }>,
  enrichmentRows: Array<{ mint: string; athMcapUsd: unknown }>
) {
  const map = new Map<string, DeploymentOutcome>();
  for (const token of tokenRows) setOutcome(map, refKey(token.chain, token.address), decimal(token.marketSnapshots[0]?.marketCapUsd), 'local_observed', 1);
  for (const row of enrichmentRows) for (const chain of ['SOLANA'] as ChainId[]) setOutcome(map, refKey(chain, row.mint), decimal(row.athMcapUsd), 'token_enrichment', 2);
  for (const row of lifecycleRows) setOutcome(map, refKey('SOLANA', row.mint), decimal(row.athMcapUsd), 'token_lifecycle', 3);
  for (const row of universeRows) setOutcome(map, refKey(row.chain, row.tokenAddress), decimal(row.athMcapUsd), 'historical_universe', 4);
  return map;
}

function setOutcome(map: Map<string, DeploymentOutcome & { priority?: number }>, key: string, ath: number | null, basis: DeploymentOutcome['athBasis'], priority: number) {
  if (ath === null) return;
  const current = map.get(key);
  if (!current || priority > (current.priority ?? 0)) map.set(key, { athMcapUsd: ath, athBasis: basis, priority });
}

function metrics(context: WalletScoreContext): InvestigationMemberIntelligence['metrics'] {
  const dna = context.dna;
  const completed = dna?.completedPositions ?? context.tokenIntelligence.reduce((sum, row) => sum + row.completedPositions, 0);
  return {
    transferCount: context.relationships.reduce((sum, row) => sum + row.transferCount, 0),
    uniqueTokensAfterFunding: unique(context.deployments.map((row) => row.tokenAddress)).length,
    completedPositions: completed || null,
    winRate: dna?.winRate ?? weightedWinRate(context.tokenIntelligence) ?? context.stats?.winRate ?? null,
    repeatRunnerCount: dna?.repeatRunnerCount ?? context.repeatRunner?.runners ?? maxNullable(context.tokenIntelligence.map((row) => row.repeatRunnerCount)),
    realizedPnlUsd: dna?.realizedPnlUsd ?? sumNullable(context.tokenIntelligence.map((row) => row.localRealizedPnlUsd)) ?? context.stats?.realizedPnlUsd ?? null,
    medianEntryMcapUsd: dna?.medianEntryMcapUsd ?? median(context.deployments.map((row) => row.entryMarketCapUsd).filter(nonNull)),
    maxCoveredDormantDays: context.dormancyDays
  };
}

function infrastructureScore(): InvestigationMemberIntelligence {
  return {
    evidenceScore: 0, historicalAlphaScore: 0, wakeUpPotential: 0, tier: 'C', trackingPriority: 'exclude', independentSignalCount: 0,
    clusterConclusion: 'infrastructure', evidenceSignals: [], whyImportant: ['Infrastructure/service/CEX terminal; excluded from entity ownership and alpha ranking.'],
    contradictions: ['Infrastructure nodes never merge otherwise unrelated wallets.'], historicalCoverage: 'unavailable',
    metrics: { transferCount: 0, uniqueTokensAfterFunding: 0, completedPositions: null, winRate: null, repeatRunnerCount: null, realizedPnlUsd: null, medianEntryMcapUsd: null, maxCoveredDormantDays: null },
    scoreVersion: WALLET_INTELLIGENCE_SCORE_VERSION
  };
}

function contradictionReasons(relationships: RelationshipEvidence[]) {
  const flattened = unique(relationships.flatMap((row) => flattenContradictions(row.contradictingEvidence).map(normalizeContradiction)).filter(nonNull));
  if (relationships.some((row) => row.route === 'bridge_inference')) flattened.push('Bridge inference is not exact cross-chain ownership evidence.');
  if (relationships.some((row) => row.route === 'cex_correlation')) flattened.push('CEX timing correlation is never ownership evidence.');
  return unique(flattened).slice(0, 6);
}

function normalizeContradiction(value: string) {
  if (/event was not individually safe/i.test(value)) return 'Some transfers were not individually safe for entity merge.';
  if (/inference.?only/i.test(value)) return 'Part of the relationship remains inference-only.';
  if (/cex/i.test(value)) return 'CEX correlation is not ownership evidence.';
  if (/service|router|infrastructure/i.test(value)) return 'Infrastructure may explain part of the route.';
  return value.length <= 180 ? value : null;
}

function dnaEvidence(row: {
  coverage: string; confidence: number; tokensEntered: number; runnersEntered: number; completedPositions: number; winRate: number | null;
  evUsdPerCompletedPosition: number | null; oneWinnerDependence: number | null; avgReturn: number | null; medianReturn: number | null;
  totalRealizedPnlUsd: unknown; repeatRunnerCount: number | null; medianEntryMcapUsd: unknown;
}): DnaEvidence {
  return {
    coverage: row.coverage, confidence: row.confidence, tokensEntered: row.tokensEntered, runnersEntered: row.runnersEntered,
    completedPositions: row.completedPositions, winRate: row.winRate, evUsd: row.evUsdPerCompletedPosition,
    oneWinnerDependence: row.oneWinnerDependence, avgReturn: row.avgReturn, medianReturn: row.medianReturn,
    realizedPnlUsd: decimal(row.totalRealizedPnlUsd), repeatRunnerCount: row.repeatRunnerCount,
    medianEntryMcapUsd: decimal(row.medianEntryMcapUsd)
  };
}

function weightedWinRate(rows: WalletScoreContext['tokenIntelligence']) {
  const completed = rows.reduce((sum, row) => sum + row.completedPositions, 0);
  if (!completed) return null;
  return rows.reduce((sum, row) => sum + row.winCount, 0) / completed;
}

function normalizeCoverage(value: string): InvestigationMemberIntelligence['historicalCoverage'] {
  return value === 'full' ? 'full' : value === 'partial' ? 'partial' : value === 'minimal' ? 'minimal' : 'unavailable';
}
function refKey(chain: ChainId, address: string) { return `${chain}:${address}`; }
function groupBy<T>(rows: T[], key: (row: T) => string) { const map = new Map<string, T[]>(); for (const row of rows) map.set(key(row), [...(map.get(key(row)) ?? []), row]); return map; }
function unique<T>(values: T[]) { return [...new Set(values)]; }
function nonNull<T>(value: T | null | undefined): value is T { return value !== null && value !== undefined; }
function clamp01(value: number) { return Math.max(0, Math.min(1, value)); }
function decimal(value: unknown) { if (value === null || value === undefined) return null; const number = Number(value); return Number.isFinite(number) ? number : null; }
function maxNullable(values: Array<number | null | undefined>) { const present = values.filter(nonNull); return present.length ? Math.max(...present) : null; }
function minNullable(values: Array<number | null | undefined>) { const present = values.filter(nonNull); return present.length ? Math.min(...present) : null; }
function sumNullable(values: Array<number | null | undefined>) { const present = values.filter(nonNull); return present.length ? present.reduce((sum, value) => sum + value, 0) : null; }
function median(values: number[]) { if (!values.length) return null; const sorted = [...values].sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2; }
function flattenEvidence(value: unknown, output: string[] = [], depth = 0): string[] {
  if (depth > 5 || output.length >= 500 || value === null || value === undefined) return output;
  if (typeof value === 'string') { output.push(value); return output; }
  if (Array.isArray(value)) { for (const item of value) flattenEvidence(item, output, depth + 1); return output; }
  if (typeof value === 'object') for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (item === false || item === null || item === undefined) continue;
    output.push(key);
    flattenEvidence(item, output, depth + 1);
  }
  return output;
}
function flattenContradictions(value: unknown, output: string[] = [], depth = 0): string[] {
  if (depth > 5 || output.length >= 200 || value === null || value === undefined) return output;
  if (typeof value === 'string') { output.push(value); return output; }
  if (Array.isArray(value)) { for (const item of value) flattenContradictions(item, output, depth + 1); return output; }
  if (typeof value === 'object') for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (item === true) output.push(key);
    else if (item !== false) flattenContradictions(item, output, depth + 1);
  }
  return output;
}
function moneyCompact(value: number) { return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 }).format(value); }
function duration(seconds: number) { if (seconds < 60) return `${seconds}s`; if (seconds < 3_600) return `${Math.round(seconds / 60)}m`; if (seconds < 86_400) return `${Math.round(seconds / 3_600)}h`; return `${Math.round(seconds / 86_400)}d`; }
