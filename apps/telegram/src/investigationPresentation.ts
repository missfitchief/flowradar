import type {
  InvestigationDeployment,
  InvestigationMember,
  InvestigationMemberIntelligence,
  InvestigationPath,
  WalletInvestigationResult
} from '@flowradar/db';

export interface PresentedIntelligenceWallet {
  member: InvestigationMember;
  intelligence: InvestigationMemberIntelligence;
  importanceScore: number;
}

export interface PresentedCapitalPath {
  id: string;
  label: string;
  sourceChain: string;
  sourceAddress: string;
  receiverChain: string;
  receiverAddress: string;
  sourceTxHash: string | null;
  amountUsd: number | null;
  amountToken: string | null;
  assetSymbol: string | null;
  tokenAddress: string | null;
  tokenSymbol: string | null;
  fundingToBuyDelaySec: number | null;
  importanceScore: number;
  whyImportant: string[];
  wallet: PresentedIntelligenceWallet;
}

export interface PresentedDeployment {
  deployment: InvestigationDeployment;
  wallet: PresentedIntelligenceWallet;
  importanceScore: number;
  whyImportant: string[];
}

export interface InvestigationPresentation {
  analyzedWallets: number;
  eligibleWallets: number;
  infrastructureExcluded: number;
  tierCounts: Record<'S' | 'A' | 'B' | 'C', number>;
  topWallets: PresentedIntelligenceWallet[];
  moreWallets: PresentedIntelligenceWallet[];
  walletCatalog: PresentedIntelligenceWallet[];
  strongestPaths: PresentedCapitalPath[];
  topDeployments: PresentedDeployment[];
  fullPathCount: number;
  fullDeploymentCount: number;
}

interface CollapsedPath {
  id: string;
  routeType: InvestigationPath['routeType'];
  sourceChain: string;
  sourceAddress: string;
  receiverChain: string;
  receiverAddress: string;
  sourceTxHash: string | null;
  amountUsd: number | null;
  amountToken: string | null;
  assetSymbol: string | null;
  confidence: number;
  transferCount: number;
  paths: InvestigationPath[];
}

const TIER_ORDER = { S: 4, A: 3, B: 2, C: 1 } as const;
const INFRA = /service|router|cex|infrastructure/i;

export function buildInvestigationPresentation(value: WalletInvestigationResult): InvestigationPresentation {
  const wallets = value.members.map((member): PresentedIntelligenceWallet => {
    const intelligence = member.intelligence ?? fallbackIntelligence(member);
    return { member, intelligence, importanceScore: walletImportance(intelligence) };
  });
  const candidates = wallets
    .filter((row) => row.member.role !== 'root_main' && row.intelligence.trackingPriority !== 'exclude' && !INFRA.test(row.member.role))
    .sort(walletOrder);
  const tierCounts = {
    S: candidates.filter((row) => row.intelligence.tier === 'S').length,
    A: candidates.filter((row) => row.intelligence.tier === 'A').length,
    B: candidates.filter((row) => row.intelligence.tier === 'B').length,
    C: candidates.filter((row) => row.intelligence.tier === 'C').length
  };
  const topWallets = candidates.filter((row) => row.intelligence.tier === 'S' || row.intelligence.tier === 'A').slice(0, 10);
  const moreWallets = candidates.filter((row) => row.intelligence.tier === 'B' || row.intelligence.tier === 'C').slice(0, 20);
  const walletCatalog = [...topWallets, ...moreWallets];
  const walletByAddress = new Map(wallets.map((row) => [`${row.member.chain}:${row.member.address}`, row]));
  const deployments = dedupeDeployments(value.deployments);
  const deploymentsByBuyer = groupBy(deployments, (row) => `${row.chain}:${row.buyerAddress}`);
  const collapsed = collapsePaths(value.paths.filter((path) => path.routeType !== 'token_deployment'));
  const strongestPaths = collapsed
    .map((path) => capitalPath(path, walletByAddress.get(`${path.receiverChain}:${path.receiverAddress}`), deploymentsByBuyer.get(`${path.receiverChain}:${path.receiverAddress}`) ?? []))
    .filter(nonNull)
    .sort(pathOrder)
    .slice(0, 10);
  const topDeployments = deployments
    .map((deployment): PresentedDeployment | null => {
      const wallet = walletByAddress.get(`${deployment.chain}:${deployment.buyerAddress}`);
      if (!wallet || wallet.intelligence.trackingPriority === 'exclude') return null;
      const intelligence = deployment.intelligence;
      const importanceScore = intelligence?.importanceScore ?? Math.round(wallet.importanceScore * 0.75);
      const whyImportant = intelligence?.whyImportant ?? [
        `Bought by Tier ${wallet.intelligence.tier} wallet.`,
        'ATH and ROI coverage unavailable; outcome is not fabricated.'
      ];
      return { deployment, wallet, importanceScore, whyImportant };
    })
    .filter(nonNull)
    .sort(deploymentOrder)
    .slice(0, 10);
  return {
    analyzedWallets: value.members.length,
    eligibleWallets: candidates.length,
    infrastructureExcluded: wallets.length - candidates.length - value.members.filter((member) => member.role === 'root_main').length,
    tierCounts,
    topWallets,
    moreWallets,
    walletCatalog,
    strongestPaths,
    topDeployments,
    fullPathCount: collapsed.length,
    fullDeploymentCount: deployments.length
  };
}

function capitalPath(path: CollapsedPath, wallet: PresentedIntelligenceWallet | undefined, deployments: InvestigationDeployment[]): PresentedCapitalPath | null {
  if (!wallet || wallet.intelligence.trackingPriority === 'exclude' || wallet.intelligence.independentSignalCount < 2) return null;
  const bestDeployment = [...deployments].sort((a, b) => (b.intelligence?.importanceScore ?? 0) - (a.intelligence?.importanceScore ?? 0) || Date.parse(b.buyTs) - Date.parse(a.buyTs))[0];
  const exactBridge = path.routeType === 'bridge' && path.paths.some((row) => /exact_bridge|protocol_match|official_message/i.test(row.evidenceTier));
  const significant = (path.amountUsd ?? 0) >= 1_000;
  const strongWallet = wallet.intelligence.tier === 'S' || wallet.intelligence.tier === 'A';
  if (!bestDeployment && !exactBridge && !significant && !strongWallet && path.routeType !== 'profit_return') return null;
  const routeBonus = bestDeployment ? 25 : path.routeType === 'profit_return' ? 22 : exactBridge ? 20 : path.routeType === 'direct' ? 12 : 6;
  const amountBonus = path.amountUsd === null ? 0 : Math.min(10, Math.max(0, Math.log10(path.amountUsd + 1) * 2));
  const importanceScore = Math.round(Math.min(100, wallet.importanceScore * 0.6 + routeBonus + amountBonus));
  const whyImportant = [
    bestDeployment ? `Capital reached a Tier ${wallet.intelligence.tier} wallet that then bought ${bestDeployment.tokenSymbol ?? 'a token'}.` : null,
    exactBridge ? 'Exact official bridge receipt links source and destination.' : null,
    path.routeType === 'profit_return' ? 'Observed profit rotation/return path.' : null,
    path.transferCount >= 2 ? `Repeated funding across ${path.transferCount} receipts.` : null,
    significant ? `Economically significant transfer (${moneyCompact(path.amountUsd!)}).` : null,
    `Terminal wallet: Evidence ${wallet.intelligence.evidenceScore}, Alpha ${wallet.intelligence.historicalAlphaScore}, Wake-up ${wallet.intelligence.wakeUpPotential}.`
  ].filter(nonNull);
  const label = bestDeployment ? `${routeLabel(path.routeType, exactBridge)} → TOKEN BUY`
    : path.routeType === 'profit_return' ? 'PROFIT ROTATION'
      : exactBridge ? 'EXACT BRIDGE'
        : routeLabel(path.routeType, false);
  return {
    id: path.id, label, sourceChain: path.sourceChain, sourceAddress: path.sourceAddress,
    receiverChain: path.receiverChain, receiverAddress: path.receiverAddress, sourceTxHash: path.sourceTxHash,
    amountUsd: path.amountUsd, amountToken: path.amountToken, assetSymbol: path.assetSymbol,
    tokenAddress: bestDeployment?.tokenAddress ?? null, tokenSymbol: bestDeployment?.tokenSymbol ?? null,
    fundingToBuyDelaySec: bestDeployment?.fundingToBuyDelaySec ?? null,
    importanceScore, whyImportant, wallet
  };
}

function collapsePaths(paths: InvestigationPath[]) {
  const map = new Map<string, InvestigationPath[]>();
  for (const path of paths) {
    const key = `${path.routeType}:${path.destinationChain}:${path.destinationAddress}`;
    const rows = map.get(key) ?? [];
    const signature = `${path.txHash ?? path.id}:${path.sourceChain}:${path.sourceAddress}:${path.destinationChain}:${path.destinationAddress}:${path.amountUsd ?? path.amountToken ?? 'unknown'}:${Math.floor(Date.parse(path.eventTs) / 1_000)}`;
    if (!rows.some((row) => `${row.txHash ?? row.id}:${row.sourceChain}:${row.sourceAddress}:${row.destinationChain}:${row.destinationAddress}:${row.amountUsd ?? row.amountToken ?? 'unknown'}:${Math.floor(Date.parse(row.eventTs) / 1_000)}` === signature)) rows.push(path);
    map.set(key, rows);
  }
  return [...map.entries()].map(([id, rows]): CollapsedPath => {
    const representative = [...rows].sort((a, b) => b.confidence - a.confidence || (b.amountUsd ?? -1) - (a.amountUsd ?? -1) || Date.parse(b.eventTs) - Date.parse(a.eventTs))[0];
    const amounts = rows.map((row) => row.amountUsd).filter(nonNull);
    return {
      id, routeType: representative.routeType, sourceChain: representative.sourceChain, sourceAddress: representative.sourceAddress,
      receiverChain: representative.destinationChain, receiverAddress: representative.destinationAddress,
      sourceTxHash: representative.hops[0]?.txHash ?? representative.txHash,
      amountUsd: amounts.length ? amounts.reduce((sum, amount) => sum + amount, 0) : null,
      amountToken: representative.amountToken, assetSymbol: representative.assetSymbol,
      confidence: Math.max(...rows.map((row) => row.confidence)),
      transferCount: new Set(rows.map((row) => row.txHash ?? row.id)).size, paths: rows
    };
  });
}

function dedupeDeployments(rows: InvestigationDeployment[]) {
  const map = new Map<string, InvestigationDeployment>();
  for (const row of rows) {
    const key = `${row.chain}:${row.buyerAddress}:${row.tokenAddress}:${row.buyTxHash}:${Math.floor(Date.parse(row.buyTs) / 1_000)}`;
    const current = map.get(key);
    if (!current || deploymentCompleteness(row) > deploymentCompleteness(current)) map.set(key, row);
  }
  return [...map.values()];
}

function deploymentCompleteness(row: InvestigationDeployment) {
  return Number(Boolean(row.tokenSymbol)) * 8 + Number(row.intelligence?.athMcapUsd !== null) * 4 + Number(row.intelligence?.roi !== null) * 4 + Number(row.entryMarketCapUsd !== null) * 2 + row.capitalRoute.length;
}

function fallbackIntelligence(member: InvestigationMember): InvestigationMemberIntelligence {
  const infrastructure = INFRA.test(member.role);
  const evidence = infrastructure ? 0 : Math.min(49, Math.round(member.relationshipConfidence * 49));
  return {
    evidenceScore: evidence, historicalAlphaScore: 0, wakeUpPotential: 0, tier: 'C',
    trackingPriority: infrastructure ? 'exclude' : 'context_only', independentSignalCount: member.role === 'root_main' ? 0 : 1,
    clusterConclusion: infrastructure ? 'infrastructure' : 'unconfirmed',
    evidenceSignals: infrastructure ? [] : [{ code: member.evidenceTier, label: member.evidenceTier.replaceAll('_', ' '), strength: member.relationshipConfidence, weight: 49, receiptCount: 1 }],
    whyImportant: [infrastructure ? 'Infrastructure terminal; excluded from intelligence ranking.' : 'Historical intelligence scoring has not been enriched for this fixture.'],
    contradictions: [], historicalCoverage: 'unavailable',
    metrics: { transferCount: 0, uniqueTokensAfterFunding: 0, completedPositions: null, winRate: null, repeatRunnerCount: null, realizedPnlUsd: null, medianEntryMcapUsd: null, maxCoveredDormantDays: null },
    scoreVersion: 1
  };
}

function walletImportance(intelligence: InvestigationMemberIntelligence) {
  return Math.round(intelligence.evidenceScore * 0.4 + intelligence.historicalAlphaScore * 0.35 + intelligence.wakeUpPotential * 0.25 + (intelligence.tier === 'S' ? 15 : intelligence.tier === 'A' ? 8 : 0));
}
function walletOrder(a: PresentedIntelligenceWallet, b: PresentedIntelligenceWallet) {
  return TIER_ORDER[b.intelligence.tier] - TIER_ORDER[a.intelligence.tier]
    || b.importanceScore - a.importanceScore
    || b.intelligence.historicalAlphaScore - a.intelligence.historicalAlphaScore
    || b.intelligence.wakeUpPotential - a.intelligence.wakeUpPotential
    || b.intelligence.evidenceScore - a.intelligence.evidenceScore
    || a.member.address.localeCompare(b.member.address);
}
function pathOrder(a: PresentedCapitalPath, b: PresentedCapitalPath) { return b.importanceScore - a.importanceScore || TIER_ORDER[b.wallet.intelligence.tier] - TIER_ORDER[a.wallet.intelligence.tier] || (b.amountUsd ?? -1) - (a.amountUsd ?? -1) || a.id.localeCompare(b.id); }
function deploymentOrder(a: PresentedDeployment, b: PresentedDeployment) { return b.importanceScore - a.importanceScore || (b.deployment.intelligence?.roi ?? -1) - (a.deployment.intelligence?.roi ?? -1) || (b.deployment.intelligence?.athMcapUsd ?? -1) - (a.deployment.intelligence?.athMcapUsd ?? -1) || Date.parse(b.deployment.buyTs) - Date.parse(a.deployment.buyTs); }
function routeLabel(route: InvestigationPath['routeType'], exactBridge: boolean) { if (exactBridge) return 'EXACT BRIDGE'; if (route === 'direct') return 'DIRECT FUNDING'; if (route === 'multi_hop') return 'MULTI-HOP FUNDING'; if (route === 'possible_cex') return 'POSSIBLE CEX'; return route.replaceAll('_', ' ').toUpperCase(); }
function groupBy<T>(rows: T[], key: (row: T) => string) { const map = new Map<string, T[]>(); for (const row of rows) map.set(key(row), [...(map.get(key(row)) ?? []), row]); return map; }
function nonNull<T>(value: T | null | undefined): value is T { return value !== null && value !== undefined; }
function moneyCompact(value: number) { return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 }).format(value); }
