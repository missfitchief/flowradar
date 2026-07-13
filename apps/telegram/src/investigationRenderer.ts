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
  if (view === 'more' || view === 'advanced' || view === 'receivers') return renderMoreWallets(presentation, page, sessionId);
  if (view === 'evidence') return renderEvidence(presentation, state.investigationItem, sessionId);
  return renderSummary(investigation, presentation, sessionId);
}

function renderSummary(value: WalletInvestigationResult, presentation: InvestigationPresentation, sessionId: string) {
  const coverage = `${value.coverage.filter((row) => row.coverageStatus === 'complete').length}/${value.coverage.length} chains complete`;
  const top = presentation.topWallets;
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
    '<b>TOP INTELLIGENCE · Tier S/A only</b>',
    ...(top.length ? top.map((wallet, index) => renderWallet(wallet, index + 1)) : [
      'No Tier S/A wallets meet the multi-signal confidence gate.',
      'Use <b>Show more</b> for the highest Tier B/C candidates; no wallet is promoted from a single signal.'
    ])
  ].join('\n\n');
  const walletRows = top.map((wallet) => walletButtons(wallet, presentation, sessionId));
  return {
    text,
    keyboard: { inline_keyboard: [
      ...walletRows,
      [{ text: 'Strongest paths', callback_data: callback('invest', sessionId, 'priority') }, { text: 'Top deployments', callback_data: callback('invest', sessionId, 'deployments') }],
      [{ text: 'Evidence', callback_data: callback('invest', sessionId, 'evidence') }, { text: 'Show more', callback_data: callback('invest', sessionId, 'more') }]
    ] }
  };
}

function renderWallet(row: PresentedIntelligenceWallet, rank: number) {
  const intelligence = row.intelligence;
  return [
    `${rank}. <b>TIER ${intelligence.tier} · ${h(row.member.role.replaceAll('_', ' '))}</b>`,
    `<code>${h(row.member.address)}</code>`,
    `Evidence <b>${intelligence.evidenceScore}</b> · Historical Alpha <b>${intelligence.historicalAlphaScore}</b> · Wake-up <b>${intelligence.wakeUpPotential}</b>`,
    `Why: ${h(intelligence.whyImportant[0] ?? 'No multi-signal intelligence reason available.')}`,
    `Tracking: ${h(intelligence.trackingPriority.replaceAll('_', ' '))}`
  ].join('\n');
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
    `Evidence: ${intel.evidenceScore}/100 · ${intel.independentSignalCount} independent signals`,
    `Historical Alpha: ${intel.historicalAlphaScore}/100 · coverage ${h(intel.historicalCoverage)}`,
    `Wake-up Potential: ${intel.wakeUpPotential}/100 · dormancy is never penalized`,
    `Cluster conclusion: ${h(intel.clusterConclusion)} · Tracking: ${h(intel.trackingPriority.replaceAll('_', ' '))}`,
    '',
    '<b>Why we link it</b>',
    ...signals,
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
    ...(intel.contradictions.length ? intel.contradictions.map((reason) => `• ${h(reason)}`) : ['None recorded.'])
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
