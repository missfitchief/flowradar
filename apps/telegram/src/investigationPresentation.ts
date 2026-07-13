import type {
  InvestigationDeployment,
  InvestigationMember,
  InvestigationPath,
  WalletInvestigationResult
} from '@flowradar/db';

export interface PresentedReceiver {
  chain: string;
  address: string;
  role: string;
  confidence: number;
}

export interface PresentedRelationGroup {
  id: string;
  label: string;
  routeType: InvestigationPath['routeType'];
  sourceChain: string;
  sourceAddress: string;
  sourceTxHash: string | null;
  receivers: PresentedReceiver[];
  relationKeys: string[];
  relationCount: number;
  transferCount: number;
  depth: number;
  totalAmountUsd: number | null;
  amountToken: string | null;
  assetSymbol: string | null;
  confidence: number;
  eventTs: string;
  evidenceTiers: string[];
  reasons: string[];
  classification: 'high_priority' | 'low_priority' | 'noise';
  deploymentCount: number;
  paths: InvestigationPath[];
}

export interface PresentedFinding {
  id: string;
  kind: 'deployment' | 'relation';
  label: string;
  sourceChain: string;
  sourceAddress: string;
  sourceTxHash: string | null;
  receiverChain: string;
  receiverAddress: string;
  receiverRole: string;
  amountUsd: number | null;
  amountToken: string | null;
  assetSymbol: string | null;
  tokenAddress: string | null;
  tokenSymbol: string | null;
  tokenTxHash: string | null;
  fundingToBuyDelaySec: number | null;
  confidence: number;
  eventTs: string;
  evidenceTiers: string[];
  reasons: string[];
  relationKeys: string[];
  contradictingEvidence: unknown[];
}

export type ClusterSection = 'Confirmed/strong relationships' | 'Probable alt/execution wallets' | 'Possible relationships' | 'Infrastructure excluded';
export interface PresentedClusterMember {
  section: ClusterSection;
  member: InvestigationMember;
}

export interface InvestigationPresentation {
  totalRelations: number;
  highPriorityCount: number;
  directReceivers: number;
  exactBridgeDestinations: number;
  probableAltExecutionWallets: number;
  tokenDeployments: number;
  profitRotations: number;
  hiddenRelations: number;
  lowPriorityRelations: number;
  noiseInfrastructure: number;
  completeCoverageChains: number;
  priorityFindings: PresentedFinding[];
  deploymentFindings: PresentedFinding[];
  bridgeFindings: PresentedFinding[];
  altWallets: PresentedClusterMember[];
  clusterMembers: PresentedClusterMember[];
  relationGroups: PresentedRelationGroup[];
}

interface RelationRecord {
  key: string;
  routeType: InvestigationPath['routeType'];
  destinationChain: string;
  destinationAddress: string;
  paths: InvestigationPath[];
  representative: InvestigationPath;
  transferCount: number;
  totalAmountUsd: number | null;
}

const INFRA_ROLE = /service|router|cex|infrastructure/i;
const ALT_ROLE = /execution|side|alt/i;
const FRESH_ROLE = /fresh/i;
const DORMANT_ROLE = /dormant/i;

export function buildInvestigationPresentation(value: WalletInvestigationResult): InvestigationPresentation {
  const memberByAddress = new Map(value.members.map((member) => [`${member.chain}:${member.address}`, member]));
  const records = collapseRelations(value.paths.filter((path) => path.routeType !== 'token_deployment'));
  const dedupedDeployments = dedupeDeployments(value.deployments);
  const relationByDestination = new Map<string, RelationRecord[]>();
  for (const record of records) {
    const key = `${record.destinationChain}:${record.destinationAddress}`;
    relationByDestination.set(key, [...(relationByDestination.get(key) ?? []), record]);
  }
  const deploymentFindings = dedupedDeployments.map((deployment) => deploymentFinding(deployment, relationByDestination, memberByAddress));
  const deploymentByReceiver = new Map<string, PresentedFinding[]>();
  for (const finding of deploymentFindings) {
    const key = `${finding.receiverChain}:${finding.receiverAddress}`;
    deploymentByReceiver.set(key, [...(deploymentByReceiver.get(key) ?? []), finding]);
  }
  const knownCapitalUsd = knownCapitalFromEvidence(value.paths);
  const relationGroups = groupRelations(records, memberByAddress, deploymentByReceiver, knownCapitalUsd);
  const relationFindings = relationGroups
    .filter((group) => group.classification === 'high_priority' && group.deploymentCount === 0)
    .map(relationFinding);
  const priorityDeployments = representativeDeploymentFindings(deploymentFindings);
  const priorityFindings = [...priorityDeployments, ...relationFindings].sort(findingOrder);
  const highRelationKeys = new Set(priorityFindings.flatMap((finding) => finding.relationKeys));
  const exactBridgeKeys = new Set(records.filter(isExactBridge).map((record) => record.key));
  const profitKeys = new Set(records.filter((record) => record.routeType === 'profit_return').map((record) => record.key));
  const directKeys = new Set(records.filter((record) => record.routeType === 'direct').map((record) => record.key));
  const cluster = clusterPresentation(value.members);
  const altWallets = cluster.filter((row) => ALT_ROLE.test(row.member.role) && row.member.relationshipConfidence >= 0.5 && row.section !== 'Infrastructure excluded');
  const lowPriorityRelations = new Set(relationGroups.filter((group) => group.classification === 'low_priority').flatMap((group) => group.relationKeys)).size;
  const noiseRelations = new Set(relationGroups.filter((group) => group.classification === 'noise').flatMap((group) => group.relationKeys)).size;
  return {
    totalRelations: records.length,
    highPriorityCount: highRelationKeys.size,
    directReceivers: directKeys.size,
    exactBridgeDestinations: exactBridgeKeys.size,
    probableAltExecutionWallets: altWallets.length,
    tokenDeployments: deploymentFindings.length,
    profitRotations: profitKeys.size,
    hiddenRelations: Math.max(0, records.length - highRelationKeys.size),
    lowPriorityRelations,
    noiseInfrastructure: noiseRelations,
    completeCoverageChains: value.coverage.filter((coverage) => coverage.coverageStatus === 'complete').length,
    priorityFindings,
    deploymentFindings: [...deploymentFindings].sort(findingOrder),
    bridgeFindings: relationGroups.filter((group) => group.routeType === 'bridge' && group.evidenceTiers.some(isExactBridgeEvidence)).map(relationFinding).sort(findingOrder),
    altWallets,
    clusterMembers: cluster,
    relationGroups: [...relationGroups].sort(groupOrder)
  };
}

function collapseRelations(paths: InvestigationPath[]): RelationRecord[] {
  const byRelation = new Map<string, InvestigationPath[]>();
  for (const path of paths) {
    const key = relationKey(path.routeType, path.destinationChain, path.destinationAddress);
    const rows = byRelation.get(key) ?? [];
    const signature = pathSignature(path);
    if (!rows.some((row) => pathSignature(row) === signature)) rows.push(path);
    byRelation.set(key, rows);
  }
  return [...byRelation.entries()].map(([key, relationPaths]) => {
    const representative = [...relationPaths].sort(pathOrder)[0];
    const knownAmounts = relationPaths.map((path) => path.amountUsd).filter((amount): amount is number => amount !== null && Number.isFinite(amount));
    return {
      key,
      routeType: representative.routeType,
      destinationChain: representative.destinationChain,
      destinationAddress: representative.destinationAddress,
      paths: relationPaths,
      representative,
      transferCount: new Set(relationPaths.map((path) => path.txHash ?? path.id)).size,
      totalAmountUsd: knownAmounts.length ? knownAmounts.reduce((sum, amount) => sum + amount, 0) : null
    };
  });
}

function groupRelations(
  records: RelationRecord[],
  memberByAddress: Map<string, InvestigationMember>,
  deploymentByReceiver: Map<string, PresentedFinding[]>,
  knownCapitalUsd: number
) {
  const grouped = new Map<string, RelationRecord[]>();
  for (const record of records) {
    const key = fundingGroupKey(record.representative);
    grouped.set(key, [...(grouped.get(key) ?? []), record]);
  }
  return [...grouped.entries()].map(([id, groupRecords]): PresentedRelationGroup => {
    const representative = [...groupRecords].map((record) => record.representative).sort(pathOrder)[0];
    const receivers = groupRecords.map((record) => {
      const member = memberByAddress.get(`${record.destinationChain}:${record.destinationAddress}`);
      return {
        chain: record.destinationChain,
        address: record.destinationAddress,
        role: member?.role ?? 'unknown_related_wallet',
        confidence: member?.relationshipConfidence ?? record.representative.confidence
      };
    }).sort((a, b) => b.confidence - a.confidence || a.address.localeCompare(b.address));
    const paths = groupRecords.flatMap((record) => record.paths);
    const totalAmountValues = groupRecords.map((record) => record.totalAmountUsd).filter((amount): amount is number => amount !== null);
    const totalAmountUsd = totalAmountValues.length ? totalAmountValues.reduce((sum, amount) => sum + amount, 0) : null;
    const evidenceTiers = unique(paths.map((path) => path.evidenceTier));
    const deploymentCount = unique(receivers.flatMap((receiver) => deploymentByReceiver.get(`${receiver.chain}:${receiver.address}`) ?? []).map((finding) => finding.id)).length;
    const exactBridge = representative.routeType === 'bridge' && evidenceTiers.some(isExactBridgeEvidence);
    const profitRotation = representative.routeType === 'profit_return';
    const infrastructureOnly = receivers.every((receiver) => INFRA_ROLE.test(receiver.role)) || representative.routeType === 'possible_cex';
    const dormant = receivers.some((receiver) => DORMANT_ROLE.test(receiver.role));
    const fresh = receivers.some((receiver) => FRESH_ROLE.test(receiver.role));
    const probableExecution = receivers.some((receiver) => ALT_ROLE.test(receiver.role) && receiver.confidence >= 0.5);
    const repeatedFunding = groupRecords.some((record) => record.transferCount >= 2) || evidenceTiers.some((tier) => /repeated/i.test(tier));
    const significant = totalAmountUsd !== null && (totalAmountUsd >= 1_000 || (knownCapitalUsd > 0 && totalAmountUsd >= knownCapitalUsd * 0.1));
    const high = !infrastructureOnly && (deploymentCount > 0 || exactBridge || profitRotation || dormant || probableExecution || repeatedFunding || significant || (fresh && significant));
    const reasons = [
      deploymentCount > 0 ? 'receiver_bought_token_after_funding' : null,
      exactBridge ? 'exact_bridge_protocol_match' : null,
      profitRotation ? 'profit_rotation' : null,
      dormant ? 'dormant_receiver' : null,
      probableExecution ? 'probable_execution_relationship_gte_50' : null,
      repeatedFunding ? 'repeated_funding' : null,
      significant ? 'economically_significant_transfer' : null,
      fresh && !deploymentCount && !significant ? 'fresh_receiver_without_follow_on_behavior' : null
    ].filter(nonNull);
    return {
      id,
      label: groupLabel(representative.routeType, receivers.length, exactBridge, profitRotation),
      routeType: representative.routeType,
      sourceChain: representative.sourceChain,
      sourceAddress: representative.sourceAddress,
      sourceTxHash: sourceTx(representative),
      receivers,
      relationKeys: groupRecords.map((record) => record.key),
      relationCount: groupRecords.length,
      transferCount: groupRecords.reduce((sum, record) => sum + record.transferCount, 0),
      depth: Math.max(1, ...paths.map((path) => Math.max(1, path.hops.length))),
      totalAmountUsd,
      amountToken: representative.amountToken,
      assetSymbol: representative.assetSymbol,
      confidence: Math.max(...receivers.map((receiver) => receiver.confidence), representative.confidence),
      eventTs: paths.map((path) => path.eventTs).sort().at(-1) ?? representative.eventTs,
      evidenceTiers,
      reasons,
      classification: infrastructureOnly ? 'noise' : high ? 'high_priority' : 'low_priority',
      deploymentCount,
      paths
    };
  });
}

function deploymentFinding(
  deployment: InvestigationDeployment,
  relationByDestination: Map<string, RelationRecord[]>,
  memberByAddress: Map<string, InvestigationMember>
): PresentedFinding {
  const fundingHops = deployment.capitalRoute.filter((hop) => hop.routeType !== 'token_deployment');
  const firstHop = fundingHops[0];
  const lastHop = fundingHops.at(-1);
  const matchingRecords = relationByDestination.get(`${deployment.chain}:${deployment.buyerAddress}`) ?? [];
  const routeTxs = new Set(fundingHops.map((hop) => hop.txHash));
  const matched = [...matchingRecords].sort((a, b) => Number(recordMatchesTx(b, routeTxs)) - Number(recordMatchesTx(a, routeTxs)) || b.representative.confidence - a.representative.confidence)[0];
  const member = memberByAddress.get(`${deployment.chain}:${deployment.buyerAddress}`);
  const routeLabel = fundingHops.some((hop) => hop.routeType === 'bridge') ? 'BRIDGE → TOKEN DEPLOYMENT'
    : fundingHops.length > 1 || fundingHops.some((hop) => hop.routeType === 'multi_hop') ? 'MULTI-HOP → TOKEN DEPLOYMENT'
      : 'DIRECT → TOKEN DEPLOYMENT';
  return {
    id: deployment.id,
    kind: 'deployment',
    label: routeLabel,
    sourceChain: firstHop?.sourceChain ?? matched?.representative.sourceChain ?? deployment.chain,
    sourceAddress: firstHop?.sourceAddress ?? matched?.representative.sourceAddress ?? deployment.buyerAddress,
    sourceTxHash: firstHop?.txHash ?? (matched ? sourceTx(matched.representative) : null),
    receiverChain: deployment.chain,
    receiverAddress: deployment.buyerAddress,
    receiverRole: member?.role ?? 'execution_wallet',
    amountUsd: lastHop?.amountUsd ?? matched?.representative.amountUsd ?? deployment.amountUsd,
    amountToken: lastHop?.amountToken ?? matched?.representative.amountToken ?? deployment.amountToken,
    assetSymbol: lastHop?.assetSymbol ?? matched?.representative.assetSymbol ?? null,
    tokenAddress: deployment.tokenAddress,
    tokenSymbol: deployment.tokenSymbol,
    tokenTxHash: deployment.buyTxHash,
    fundingToBuyDelaySec: deployment.fundingToBuyDelaySec,
    confidence: Math.min(1, Math.max(0, ...(fundingHops.map((hop) => hop.confidence)), matched?.representative.confidence ?? 0.9)),
    eventTs: deployment.buyTs,
    evidenceTiers: unique([deployment.evidenceTier, ...fundingHops.map((hop) => hop.evidenceTier)]),
    reasons: ['receiver_bought_token_after_funding'],
    relationKeys: matched ? [matched.key] : [],
    contradictingEvidence: matched ? matched.paths.map((path) => path.contradictingEvidence) : []
  };
}

function relationFinding(group: PresentedRelationGroup): PresentedFinding {
  const receiver = group.receivers[0];
  return {
    id: group.id,
    kind: 'relation',
    label: group.label,
    sourceChain: group.sourceChain,
    sourceAddress: group.sourceAddress,
    sourceTxHash: group.sourceTxHash,
    receiverChain: receiver?.chain ?? group.sourceChain,
    receiverAddress: receiver?.address ?? group.sourceAddress,
    receiverRole: receiver?.role ?? 'unknown_related_wallet',
    amountUsd: group.totalAmountUsd,
    amountToken: group.amountToken,
    assetSymbol: group.assetSymbol,
    tokenAddress: null,
    tokenSymbol: null,
    tokenTxHash: null,
    fundingToBuyDelaySec: null,
    confidence: group.confidence,
    eventTs: group.eventTs,
    evidenceTiers: group.evidenceTiers,
    reasons: group.reasons,
    relationKeys: group.relationKeys,
    contradictingEvidence: group.paths.map((path) => path.contradictingEvidence)
  };
}

function clusterPresentation(members: InvestigationMember[]): PresentedClusterMember[] {
  return members.filter((member) => member.role !== 'root_main').map((member) => {
    const section: ClusterSection = INFRA_ROLE.test(member.role) || /infrastructure_terminal/i.test(member.evidenceTier) ? 'Infrastructure excluded'
      : member.relationshipConfidence >= 0.85 ? 'Confirmed/strong relationships'
        : ALT_ROLE.test(member.role) && member.relationshipConfidence >= 0.5 ? 'Probable alt/execution wallets'
          : 'Possible relationships';
    return { section, member };
  }).sort((a, b) => sectionOrder(a.section) - sectionOrder(b.section) || b.member.relationshipConfidence - a.member.relationshipConfidence || a.member.address.localeCompare(b.member.address));
}

function dedupeDeployments(rows: InvestigationDeployment[]) {
  const byReceipt = new Map<string, InvestigationDeployment>();
  for (const row of rows) {
    const key = `${row.chain}:${row.buyerAddress}:${row.tokenAddress}:${row.buyTxHash}:${Math.floor(Date.parse(row.buyTs) / 1_000)}`;
    const current = byReceipt.get(key);
    if (!current || deploymentCompleteness(row) > deploymentCompleteness(current)) byReceipt.set(key, row);
  }
  return [...byReceipt.values()];
}

function representativeDeploymentFindings(rows: PresentedFinding[]) {
  const byCapitalPath = new Map<string, PresentedFinding[]>();
  for (const row of rows) {
    const key = row.relationKeys[0] ?? `${row.receiverChain}:${row.receiverAddress}`;
    byCapitalPath.set(key, [...(byCapitalPath.get(key) ?? []), row]);
  }
  return [...byCapitalPath.values()].map((findings) => [...findings].sort(findingOrder)[0]);
}

function deploymentCompleteness(row: InvestigationDeployment) {
  return Number(Boolean(row.tokenSymbol)) * 8 + Number(row.amountUsd !== null) * 4 + Number(row.entryMarketCapUsd !== null) * 2 + row.capitalRoute.length;
}

function fundingGroupKey(path: InvestigationPath) {
  const tx = sourceTx(path) ?? 'no-source-tx';
  const window = Math.floor(Date.parse(path.eventTs) / (10 * 60_000));
  const amountPattern = path.amountUsd === null ? `${path.amountToken ?? 'unpriced'}:${path.assetSymbol ?? path.assetAddress ?? 'asset'}` : `${path.amountUsd.toFixed(2)}:usd`;
  return `${path.sourceChain}:${path.sourceAddress}:${path.routeType}:${tx}:${window}:${amountPattern}:${Math.max(1, path.hops.length)}`;
}

function groupLabel(route: InvestigationPath['routeType'], receivers: number, exactBridge: boolean, profitRotation: boolean) {
  if (receivers > 1) return 'SPLIT FUNDING';
  if (profitRotation) return 'PROFIT ROTATION';
  if (exactBridge) return 'EXACT BRIDGE';
  if (route === 'direct') return 'DIRECT FUNDING';
  if (route === 'multi_hop') return 'MULTI-HOP';
  if (route === 'possible_cex') return 'POSSIBLE CEX-MEDIATED';
  return route.replaceAll('_', ' ').toUpperCase();
}

function isExactBridge(record: RelationRecord) {
  return record.routeType === 'bridge' && record.paths.some((path) => isExactBridgeEvidence(path.evidenceTier));
}
function isExactBridgeEvidence(value: string) { return /exact_bridge|protocol_match|official_message/i.test(value); }
function recordMatchesTx(record: RelationRecord, txs: Set<string>) { return record.paths.some((path) => path.hops.some((hop) => txs.has(hop.txHash)) || Boolean(path.txHash && txs.has(path.txHash))); }
function relationKey(route: string, chain: string, address: string) { return `${route}:${chain}:${address}`; }
function sourceTx(path: InvestigationPath) { return path.hops[0]?.txHash || path.txHash || null; }
function pathSignature(path: InvestigationPath) { return `${sourceTx(path) ?? path.id}:${path.sourceChain}:${path.sourceAddress}:${path.destinationChain}:${path.destinationAddress}:${path.amountUsd ?? path.amountToken ?? 'unpriced'}:${Math.floor(Date.parse(path.eventTs) / 1_000)}`; }
function pathOrder(a: InvestigationPath, b: InvestigationPath) { return (b.amountUsd ?? -1) - (a.amountUsd ?? -1) || b.confidence - a.confidence || Date.parse(b.eventTs) - Date.parse(a.eventTs) || a.id.localeCompare(b.id); }
function findingOrder(a: PresentedFinding, b: PresentedFinding) { return findingTier(b) - findingTier(a) || b.confidence - a.confidence || (b.amountUsd ?? -1) - (a.amountUsd ?? -1) || Date.parse(b.eventTs) - Date.parse(a.eventTs) || a.id.localeCompare(b.id); }
function findingTier(row: PresentedFinding) { if (row.kind === 'deployment') return 6; if (row.label === 'PROFIT ROTATION') return 5; if (row.label === 'EXACT BRIDGE') return 4; if (/DIRECT|SPLIT/.test(row.label)) return 3; return 2; }
function groupOrder(a: PresentedRelationGroup, b: PresentedRelationGroup) { return classificationOrder(a.classification) - classificationOrder(b.classification) || findingTier(relationFinding(b)) - findingTier(relationFinding(a)) || b.confidence - a.confidence || (b.totalAmountUsd ?? -1) - (a.totalAmountUsd ?? -1) || Date.parse(b.eventTs) - Date.parse(a.eventTs); }
function classificationOrder(value: PresentedRelationGroup['classification']) { return value === 'high_priority' ? 0 : value === 'low_priority' ? 1 : 2; }
function sectionOrder(value: ClusterSection) { return value === 'Confirmed/strong relationships' ? 0 : value === 'Probable alt/execution wallets' ? 1 : value === 'Possible relationships' ? 2 : 3; }
function unique<T>(values: T[]) { return [...new Set(values)]; }
function nonNull<T>(value: T | null | undefined): value is T { return value !== null && value !== undefined; }
function knownCapitalFromEvidence(paths: InvestigationPath[]) {
  const values = paths.flatMap((path) => {
    if (!path.supportingEvidence || typeof path.supportingEvidence !== 'object' || Array.isArray(path.supportingEvidence)) return [];
    const evidence = path.supportingEvidence as Record<string, unknown>;
    return ['knownCapitalUsd', 'sourceKnownCapitalUsd', 'rootCapitalUsd']
      .map((key) => evidence[key])
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0);
  });
  return values.length ? Math.max(...values) : 0;
}
