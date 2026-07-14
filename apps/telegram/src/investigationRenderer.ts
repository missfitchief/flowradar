import type { OperatorSessionState, WalletInvestigationResult } from '@flowradar/db';
import {
  buildInvestigationPresentation,
  type InvestigationPresentation,
  type PresentedCapitalPath,
  type PresentedDeployment,
  type PresentedIntelligenceWallet
} from './investigationPresentation';
import { callback, h } from './render';
import type { InlineKeyboard } from './types';

export function renderInvestigationReport(investigation: WalletInvestigationResult, state: OperatorSessionState, sessionId: string) {
  const presentation = buildInvestigationPresentation(investigation);
  const view = state.investigationView ?? 'summary';
  const page = state.page || 1;
  if (view === 'priority' || view === 'paths') return renderPaths(presentation.strongestPaths, page, sessionId, presentation, 'STRONGEST CAPITAL PATHS');
  if (view === 'bridges') return renderPaths(presentation.strongestPaths.filter((path) => path.label.includes('BRIDGE')), page, sessionId, presentation, 'STRONGEST BRIDGE PATHS');
  if (view === 'deployments') return renderDeployments(presentation, page, sessionId);
  if (view === 'cluster' || view === 'alts') return renderCluster(presentation, page, sessionId);
  if (view === 'more' || view === 'advanced' || view === 'receivers') return renderMoreWallets(presentation, page, sessionId);
  if (view === 'evidence') return renderEvidence(presentation, state.investigationItem, sessionId);
  return renderSummary(investigation, presentation, sessionId);
}

function renderSummary(value: WalletInvestigationResult, presentation: InvestigationPresentation, sessionId: string) {
  const coverage = `${value.coverage.filter((row) => row.coverageStatus === 'complete').length}/${value.coverage.length} chains complete`;
  const active = presentation.topActiveWallets;
  const dormant = presentation.topDormantWallets;
  const text = [
    '<b>WALLET INTELLIGENCE REPORT</b>',
    '',
    '<b>Root capital source:</b>',
    `<code>${h(value.rootAddress)}</code>`,
    `Chains: ${h(value.activityChains.map(chainLabel).join(', ') || 'no confirmed activity')} · Coverage: ${h(coverage)}`,
    '',
    '<b>Intelligence tiers</b>',
    `Tier S: ${presentation.tierCounts.S} · Tier A: ${presentation.tierCounts.A}`,
    `Tier B/C hidden: ${presentation.tierCounts.B + presentation.tierCounts.C} · Infrastructure excluded: ${presentation.infrastructureExcluded}`,
    '',
    '<b>TOP ACTIVE ALPHA</b>',
    ...(active.length ? active.map((wallet, index) => renderWallet(wallet, index + 1)) : ['No active Tier S/A wallet passed the multi-signal gate.']),
    '',
    '<b>TOP DORMANT WALLETS TO WATCH</b>',
    ...(dormant.length ? dormant.map((wallet, index) => renderWallet(wallet, index + 1)) : [
      'No dormant Tier S/A wallet passed the multi-signal confidence gate.'
    ])
  ].join('\n\n');
  const walletRows = presentation.topWallets.map((wallet) => walletButtons(wallet, presentation, sessionId));
  return {
    text,
    keyboard: { inline_keyboard: [
      ...walletRows,
      [{ text: 'Strongest paths', callback_data: callback('invest', sessionId, 'priority') }, { text: 'Top deployments', callback_data: callback('invest', sessionId, 'deployments') }],
      [{ text: 'Core / peripheral', callback_data: callback('invest', sessionId, 'cluster') }, { text: 'Evidence', callback_data: callback('invest', sessionId, 'evidence') }],
      [{ text: 'Show more', callback_data: callback('invest', sessionId, 'more') }]
    ] }
  };
}

function renderWallet(row: PresentedIntelligenceWallet, rank: number) {
  const intelligence = row.intelligence;
  return [
    `${rank}. <b>TIER ${intelligence.tier} · ${h(row.member.role.replaceAll('_', ' '))}</b>`,
    `<code>${h(row.member.address)}</code>`,
    `Source ${intelligence.sourceScore ?? 'n/a'} · Evidence <b>${intelligence.evidenceScore}</b> · Alpha <b>${intelligence.sampleAdjustedHistoricalAlphaScore}</b> · Wake-up <b>${intelligence.wakeUpPotential}</b>`,
    `Entity: ${h(row.member.entityKey ?? 'unresolved')} · Status: ${h(intelligence.status.replaceAll('_', ' '))}`,
    `Why: ${h(intelligence.whyImportant[0] ?? 'No multi-signal intelligence reason available.')}`,
    `Tracking: ${h(intelligence.trackingPriority.replaceAll('_', ' '))}`
  ].join('\n');
}

function renderCluster(presentation: InvestigationPresentation, page: number, sessionId: string) {
  const rows = [
    ...presentation.coreClusterWallets.map((wallet) => ({ scope: 'CORE CLUSTER', wallet })),
    ...presentation.peripheralClusterWallets.map((wallet) => ({ scope: 'PERIPHERAL CLUSTER', wallet }))
  ];
  const { items, hasNext } = pageRows(rows, page, 5);
  const text = [
    `<b>ENTITY CLUSTER</b> · page ${page}`,
    'Core requires a relevant role plus at least two independent evidence types. Peripheral wallets remain context and never count as equal confirmations.',
    ...(items.length ? items.map(({ scope, wallet }, index) => [
      `${(page - 1) * 5 + index + 1}. <b>${scope} · TIER ${wallet.intelligence.tier}</b>`,
      `<code>${h(wallet.member.address)}</code>`,
      `Role: ${h(wallet.member.role.replaceAll('_', ' '))} · Entity: ${h(wallet.member.entityKey ?? 'unresolved')}`,
      `Why ${scope.startsWith('CORE') ? 'core' : 'peripheral'}: ${h(scope.startsWith('CORE') ? `${wallet.intelligence.independentSignalCount} independent signals and an operational role.` : 'Useful relationship, but the core multi-signal/role gate is not satisfied.')}`
    ].join('\n')) : ['No entity-linked wallets passed the display gate.'])
  ].join('\n\n');
  return { text, keyboard: listKeyboard(sessionId, page, hasNext, items.map(({ wallet }) => walletButtons(wallet, presentation, sessionId))) };
}

function renderMoreWallets(presentation: InvestigationPresentation, page: number, sessionId: string) {
  const { items, hasNext } = pageRows(presentation.moreWallets, page, 5);
  const text = [
    `<b>SHOW MORE · Tier B/C candidates</b> · page ${page}`,
    'Only the 20 highest-ranked B/C candidates are exposed; full graph coverage remains in the backend.',
    ...(items.length ? items.map((wallet, index) => renderWallet(wallet, (page - 1) * 5 + index + 1)) : ['No additional candidates.'])
  ].join('\n\n');
  return { text, keyboard: listKeyboard(sessionId, page, hasNext, items.map((wallet) => walletButtons(wallet, presentation, sessionId))) };
}

function renderPaths(rows: PresentedCapitalPath[], page: number, sessionId: string, presentation: InvestigationPresentation, title: string) {
  const { items, hasNext } = pageRows(rows, page, 5);
  const text = [
    `<b>${title}</b> · page ${page}`,
    'Only paths with multi-signal wallet intelligence, an exact bridge, token execution, profit rotation, or meaningful value are shown.',
    ...(items.length ? items.map((path, index) => renderPath(path, (page - 1) * 5 + index + 1)) : ['No capital path passed the intelligence threshold.'])
  ].join('\n\n');
  const buttons = items.map((path) => {
    const row: InlineKeyboard['inline_keyboard'][number] = [];
    if (path.sourceTxHash) row.push({ text: 'Source tx', url: transactionExplorer(path.sourceChain, path.sourceTxHash) });
    row.push({ text: 'Receiver', url: walletExplorer(path.receiverChain, path.receiverAddress) });
    if (path.tokenAddress) row.push({ text: 'Token', url: tokenExplorer(path.receiverChain, path.tokenAddress) });
    row.push({ text: 'Why / evidence', callback_data: callback('evidence', sessionId, walletSelector(presentation, path.wallet)) });
    return row;
  });
  return { text, keyboard: listKeyboard(sessionId, page, hasNext, buttons) };
}

function renderPath(path: PresentedCapitalPath, rank: number) {
  return [
    `${rank}. <b>${h(path.label)}</b> · importance ${path.importanceScore}`,
    `Source: <code>${h(path.sourceAddress)}</code>`,
    `Receiver: <code>${h(path.receiverAddress)}</code>`,
    `Amount: ${amount(path.amountUsd, path.amountToken, path.assetSymbol)}`,
    path.tokenAddress ? `Bought: ${h(path.tokenSymbol ?? 'TOKEN')} · <code>${h(path.tokenAddress)}</code>` : null,
    path.fundingToBuyDelaySec === null ? null : `Funding → buy: ${duration(path.fundingToBuyDelaySec)}`,
    `Why important: ${h(path.whyImportant[0] ?? 'Strong multi-signal capital path.')}`
  ].filter(nonNull).join('\n');
}

function renderDeployments(presentation: InvestigationPresentation, page: number, sessionId: string) {
  const { items, hasNext } = pageRows(presentation.topDeployments, page, 5);
  const text = [
    `<b>TOP DEPLOYMENTS</b> · page ${page}`,
    'Maximum 10 intelligence-ranked deployments. Unknown ATH/ROI stays unavailable and never becomes a synthetic win.',
    ...(items.length ? items.map((deployment, index) => renderDeployment(deployment, (page - 1) * 5 + index + 1)) : ['No deployment has enough wallet intelligence to rank.'])
  ].join('\n\n');
  const buttons = items.map((row) => [
    { text: 'Wallet evidence', callback_data: callback('evidence', sessionId, walletSelector(presentation, row.wallet)) },
    { text: 'Wallet', url: walletExplorer(row.deployment.chain, row.deployment.buyerAddress) },
    { text: 'Token', url: tokenExplorer(row.deployment.chain, row.deployment.tokenAddress) }
  ]);
  return { text, keyboard: listKeyboard(sessionId, page, hasNext, buttons) };
}

function renderDeployment(row: PresentedDeployment, rank: number) {
  const deployment = row.deployment;
  const intelligence = deployment.intelligence;
  return [
    `${rank}. <b>${h(deployment.tokenSymbol ?? 'TOKEN')}</b> · importance ${row.importanceScore}`,
    `Token: <code>${h(deployment.tokenAddress)}</code>`,
    `Wallet: <code>${h(deployment.buyerAddress)}</code> · Tier ${row.wallet.intelligence.tier}`,
    `Entity: ${h(deployment.sourceEntityKey ?? row.wallet.member.entityKey ?? 'unresolved')} · Entry timing: ${deployment.fundingToBuyDelaySec === null ? 'unavailable' : duration(deployment.fundingToBuyDelaySec)}`,
    `ATH: ${intelligence?.athMcapUsd === null || intelligence?.athMcapUsd === undefined ? 'unavailable' : money(intelligence.athMcapUsd)}${intelligence?.athBasis && intelligence.athBasis !== 'unavailable' ? ` (${h(intelligence.athBasis.replaceAll('_', ' '))})` : ''}`,
    `ROI: ${intelligence?.roi === null || intelligence?.roi === undefined ? 'unavailable' : `${Math.round(intelligence.roi * 100)}%`}${intelligence?.roiBasis && intelligence.roiBasis !== 'unavailable' ? ` (${h(intelligence.roiBasis.replaceAll('_', ' '))})` : ''}`,
    `Why important: ${h(row.whyImportant[0] ?? 'Ranked from wallet intelligence and funding receipt.')}`
  ].join('\n');
}

function renderEvidence(presentation: InvestigationPresentation, selector: string | undefined, sessionId: string) {
  const match = /^w:(\d+)$/.exec(selector ?? '');
  if (!match) {
    const candidates = presentation.walletCatalog.slice(0, 10);
    return {
      text: [
        '<b>WALLET EVIDENCE</b>',
        'Select a ranked wallet to see independent signals, confidence, contradictions, historical coverage, and tracking value.',
        ...candidates.map((wallet, index) => `${index + 1}. Tier ${wallet.intelligence.tier} · <code>${h(wallet.member.address)}</code> · Evidence ${wallet.intelligence.evidenceScore}`)
      ].join('\n\n'),
      keyboard: listKeyboard(sessionId, 1, false, candidates.map((wallet) => walletButtons(wallet, presentation, sessionId)))
    };
  }
  const wallet = presentation.walletCatalog[Number(match[1])];
  if (!wallet) return { text: '<b>Wallet evidence is no longer available.</b>', keyboard: backKeyboard(sessionId) };
  const intel = wallet.intelligence;
  const signals = intel.evidenceSignals.length
    ? intel.evidenceSignals.map((signal, index) => `${index + 1}. ${h(signal.label)} · strength ${Math.round(signal.strength * 100)}% · ${signal.receiptCount} receipt${signal.receiptCount === 1 ? '' : 's'}`)
    : ['No independent ownership/relationship signal.'];
  const text = [
    `<b>WALLET EVIDENCE · TIER ${intel.tier}</b>`,
    `<code>${h(wallet.member.address)}</code>`,
    `Role: ${h(wallet.member.role.replaceAll('_', ' '))} · Chain: ${h(chainLabel(wallet.member.chain))}`,
    '',
    `<b>Scores</b>`,
    `Source Score: ${intel.sourceScore ?? 'unavailable'} <i>(discovery prior only; never ownership/signal evidence)</i>`,
    `Evidence: ${intel.evidenceScore}/100 · ${intel.independentSignalCount} independent signals`,
    `Raw Historical Alpha: ${intel.rawHistoricalAlphaScore}/100`,
    `Sample-adjusted Alpha: ${intel.sampleAdjustedHistoricalAlphaScore}/100 · confidence ${Math.round(intel.alphaConfidence * 100)}% · n=${intel.alphaSampleSize}`,
    `Historical coverage: ${h(intel.historicalCoverage)} · Status: ${h(intel.status.replaceAll('_', ' '))}`,
    `Wake-up Potential: ${intel.wakeUpPotential}/100 · dormancy is never penalized`,
    `Cluster conclusion: ${h(intel.clusterConclusion)} · Tracking: ${h(intel.trackingPriority.replaceAll('_', ' '))}`,
    '',
    '<b>Strongest evidence</b>',
    ...signals.slice(0, 4),
    '',
    '<b>Weak / contextual evidence</b>',
    ...(intel.evidenceSignals.filter((signal) => signal.strength < 0.65).length
      ? intel.evidenceSignals.filter((signal) => signal.strength < 0.65).map((signal) => `• ${h(signal.label)} · ${Math.round(signal.strength * 100)}%`)
      : ['None recorded.']),
    '',
    '<b>Why it matters</b>',
    ...intel.whyImportant.map((reason) => `• ${h(reason)}`),
    '',
    '<b>Historical metrics</b>',
    `Post-funding tokens: ${intel.metrics.uniqueTokensAfterFunding} · Transfers: ${intel.metrics.transferCount}`,
    `WR: ${percentNullable(intel.metrics.winRate)} · Realized PnL: ${intel.metrics.realizedPnlUsd === null ? 'unavailable' : money(intel.metrics.realizedPnlUsd)}`,
    `Repeat runners: ${intel.metrics.repeatRunnerCount ?? 'unavailable'} · Dormancy: ${intel.metrics.maxCoveredDormantDays === null ? 'unavailable' : `${intel.metrics.maxCoveredDormantDays}d`}`,
    '',
    '<b>Contradicting / limiting evidence</b>',
    ...(intel.contradictions.length ? intel.contradictions.map((reason) => `• ${h(reason)}`) : ['None recorded.']),
    '',
    '<b>Infrastructure exclusions</b>',
    'Service/router/CEX-only nodes are excluded from entity ownership and independence counts.',
    '',
    `<b>Conclusion</b> ${h(intel.clusterConclusion)} · ${h(intel.whyImportant[0] ?? 'Insufficient evidence for a stronger conclusion.')}`
  ].join('\n');
  return {
    text,
    keyboard: { inline_keyboard: [
      [{ text: 'Explorer', url: walletExplorer(wallet.member.chain, wallet.member.address) }, { text: 'Copy wallet', copy_text: { text: wallet.member.address } }],
      [{ text: 'Back', callback_data: callback('invest', sessionId, 'summary') }]
    ] }
  };
}

function walletButtons(wallet: PresentedIntelligenceWallet, presentation: InvestigationPresentation, sessionId: string): InlineKeyboard['inline_keyboard'][number] {
  return [
    { text: `Tier ${wallet.intelligence.tier} evidence`, callback_data: callback('evidence', sessionId, walletSelector(presentation, wallet)) },
    { text: 'Explorer', url: walletExplorer(wallet.member.chain, wallet.member.address) }
  ];
}

function walletSelector(presentation: InvestigationPresentation, wallet: PresentedIntelligenceWallet) {
  const index = presentation.walletCatalog.findIndex((candidate) => candidate.member.chain === wallet.member.chain && candidate.member.address === wallet.member.address);
  return `w:${Math.max(0, index)}`;
}

function listKeyboard(sessionId: string, page: number, hasNext: boolean, rows: InlineKeyboard['inline_keyboard']): InlineKeyboard {
  const navigation: InlineKeyboard['inline_keyboard'][number] = [];
  if (page > 1) navigation.push({ text: '‹ Back', callback_data: callback('page', sessionId, String(page - 1)) });
  if (hasNext) navigation.push({ text: 'Next ›', callback_data: callback('page', sessionId, String(page + 1)) });
  return { inline_keyboard: [...rows, ...(navigation.length ? [navigation] : []), [{ text: 'Back to report', callback_data: callback('invest', sessionId, 'summary') }]] };
}
function backKeyboard(sessionId: string): InlineKeyboard { return { inline_keyboard: [[{ text: 'Back to report', callback_data: callback('invest', sessionId, 'summary') }]] }; }
function pageRows<T>(rows: T[], page: number, size: number) { const start = (page - 1) * size; return { items: rows.slice(start, start + size), hasNext: start + size < rows.length }; }
function walletExplorer(chain: string, address: string) { return `${explorerBase(chain)}/address/${encodeURIComponent(address)}`.replace('solscan.io/address', 'solscan.io/account'); }
function tokenExplorer(chain: string, address: string) { return chain === 'SOLANA' ? `https://solscan.io/token/${encodeURIComponent(address)}` : `${explorerBase(chain)}/token/${encodeURIComponent(address)}`; }
function transactionExplorer(chain: string, txHash: string) { return `${explorerBase(chain)}/tx/${encodeURIComponent(txHash)}`; }
function explorerBase(chain: string) { if (chain === 'SOLANA') return 'https://solscan.io'; if (chain === 'ETHEREUM') return 'https://etherscan.io'; if (chain === 'BASE') return 'https://basescan.org'; if (chain === 'ARBITRUM') return 'https://arbiscan.io'; return 'https://bscscan.com'; }
function chainLabel(chain: string) { if (chain === 'ETHEREUM') return 'Ethereum'; if (chain === 'ARBITRUM') return 'Arbitrum'; if (chain === 'SOLANA') return 'Solana'; if (chain === 'BASE') return 'Base'; return chain; }
function amount(usd: number | null, token: string | null, symbol: string | null) { return usd !== null ? money(usd) : token ? `${h(token)} ${h(symbol ?? '')}`.trim() : 'unpriced'; }
function money(value: number) { return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value); }
function percentNullable(value: number | null) { return value === null ? 'unavailable' : `${Math.round(value * 100)}%`; }
function duration(seconds: number) { if (seconds < 60) return `${seconds}s`; if (seconds < 3_600) return `${Math.round(seconds / 60)}m`; if (seconds < 86_400) return `${Math.round(seconds / 3_600)}h`; return `${Math.round(seconds / 86_400)}d`; }
function nonNull<T>(value: T | null | undefined): value is T { return value !== null && value !== undefined; }
