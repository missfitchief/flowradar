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

const DIVIDER = '━━━━━━━━━━━━━━━━━━━━━━';
const PAGE_SIZE = 5;

export function renderInvestigationReport(investigation: WalletInvestigationResult, state: OperatorSessionState, sessionId: string) {
  const presentation = buildInvestigationPresentation(investigation);
  const view = state.investigationView ?? 'summary';
  const page = state.page || 1;
  if (view === 'priority' || view === 'paths') return renderPaths(presentation.strongestPaths, page, sessionId, presentation, 'CAPITAL PATHS');
  if (view === 'bridges') return renderPaths(presentation.strongestPaths.filter((path) => path.label.includes('BRIDGE')), page, sessionId, presentation, 'BRIDGE PATHS');
  if (view === 'deployments') return renderDeployments(presentation, page, sessionId);
  if (view === 'cluster' || view === 'alts') return renderCluster(presentation, sessionId);
  if (view === 'more' || view === 'advanced' || view === 'receivers') return renderMoreWallets(presentation, page, sessionId);
  if (view === 'evidence') return renderEvidence(presentation, state.investigationItem, page, sessionId);
  if (view === 'history') return renderEntityHistory(investigation, presentation, sessionId);
  if (view === 'outcomes') return renderOutcomes(investigation, sessionId);
  if (view === 'watch') return renderWatchConfirmation(investigation, presentation, sessionId);
  return renderSummary(investigation, presentation, sessionId);
}

export function renderRefreshProgress(target: string, stage: number) {
  const rows = [
    ['📡', 'Fetching transactions'],
    ['🧩', 'Building graph'],
    ['🧠', 'Scoring entities'],
    ['📊', 'Ranking intelligence']
  ] as const;
  const status = rows.map(([icon, label], index) => `${index < stage ? '✅' : index === stage ? icon : '⚪'} ${label}${index === stage ? '…' : ''}`);
  if (stage >= rows.length) status.push('✅ Done.');
  return {
    text: [
      '🔄 <b>REFRESHING INTELLIGENCE</b>',
      DIVIDER,
      `🎯 <code>${h(shortAddress(target))}</code>`,
      '',
      ...status
    ].join('\n'),
    keyboard: { inline_keyboard: [] } as InlineKeyboard
  };
}

export function renderRefreshFailure(sessionId: string, message: string) {
  return {
    text: [
      '🔴 <b>REFRESH FAILED</b>',
      DIVIDER,
      h(message),
      '',
      '<i>The last completed intelligence report is still available.</i>'
    ].join('\n'),
    keyboard: { inline_keyboard: [
      [{ text: '🔄 Retry', callback_data: callback('refresh', sessionId, 'run') }],
      [{ text: '← Back', callback_data: callback('back', sessionId, 'previous') }]
    ] } as InlineKeyboard
  };
}

function renderSummary(value: WalletInvestigationResult, presentation: InvestigationPresentation, sessionId: string) {
  const active = presentation.topActiveWallets;
  const dormant = presentation.topDormantWallets;
  const text = [
    '🧠 <b>WALLET INVESTIGATION</b>',
    DIVIDER,
    `🎯 <b>Root</b>  <code>${h(shortAddress(value.rootAddress))}</code>`,
    `🔗 <b>Entity</b>  ${value.entityKey ? `<code>${h(shortEntity(value.entityKey))}</code>` : '⚪ unresolved'}`,
    '',
    '📡 <b>COVERAGE</b>',
    ...(value.coverage.length ? value.coverage.map(renderCoverage) : ['🔴 No chain coverage available']),
    '',
    '🔥 <b>TOP ACTIVE ALPHA</b>',
    ...(active.length ? active.map((wallet, index) => renderWalletCard(wallet, index + 1, false)) : ['⚪ No active Tier S/A wallet passed the multi-signal gate.']),
    '',
    '💤 <b>TOP DORMANT WALLETS TO WATCH</b>',
    ...(dormant.length ? dormant.map((wallet, index) => renderWalletCard(wallet, index + 1, true)) : ['⚪ No dormant high-value wallet passed the confidence gate.']),
    '',
    '🧩 <b>INTELLIGENCE MAP</b>',
    `Core <b>${presentation.coreClusterWallets.length}</b>  ·  Peripheral <b>${presentation.peripheralClusterWallets.length}</b>  ·  Entities <b>${entityCount(presentation)}</b>`,
    `Capital paths <b>${presentation.fullPathCount}</b>  ·  Deployments <b>${presentation.fullDeploymentCount}</b>`,
    `Hidden context <b>${presentation.tierCounts.B + presentation.tierCounts.C}</b>  ·  Infrastructure excluded <b>${presentation.infrastructureExcluded}</b>`
  ].join('\n');
  return { text, keyboard: summaryKeyboard(sessionId) };
}

function renderWalletCard(row: PresentedIntelligenceWallet, rank: number, dormant: boolean) {
  const intel = row.intelligence;
  const reasons = intel.whyImportant.slice(0, 1);
  return [
    '',
    `${rank}. ${tierIcon(intel.tier)} <b>Tier ${intel.tier} · ${h(roleLabel(row.member.role))}</b>`,
    `💼 <code>${h(shortAddress(row.member.address))}</code>  ·  ${h(chainLabel(row.member.chain))}`,
    `🛡 <b>${intel.evidenceScore}</b>  ·  📈 <b>${intel.sampleAdjustedHistoricalAlphaScore}</b>  ·  💤 <b>${intel.wakeUpPotential}</b>  ·  ${confidenceIcon(row.member.relationshipConfidence)} ${percent(row.member.relationshipConfidence)}`,
    dormant ? `🕰 ${dormancyLabel(intel.metrics.maxCoveredDormantDays)}  ·  Source ${intel.sourceScore ?? 'n/a'}` : null,
    `• ${h(reasons[0] ?? 'No stronger intelligence reason is currently supported.')}`
  ].filter(nonNull).join('\n');
}

function renderPaths(rows: PresentedCapitalPath[], page: number, sessionId: string, presentation: InvestigationPresentation, title: string) {
  const { items, hasNext } = pageRows(rows, page, PAGE_SIZE);
  const text = [
    `💸 <b>${title}</b>`,
    DIVIDER,
    `<i>Only the strongest intelligence-bearing routes · page ${page}</i>`,
    ...(items.length ? items.map((path, index) => renderPath(path, (page - 1) * PAGE_SIZE + index + 1)) : ['⚪ No high-priority capital path passed the intelligence threshold.'])
  ].join('\n\n');
  const buttons = items.map((path) => {
    const row: InlineKeyboard['inline_keyboard'][number] = [];
    if (path.sourceTxHash) row.push({ text: 'Tx', url: transactionExplorer(path.sourceChain, path.sourceTxHash) });
    row.push({ text: 'Receiver', url: walletExplorer(path.receiverChain, path.receiverAddress) });
    if (path.tokenAddress) row.push({ text: 'Token', url: tokenExplorer(path.receiverChain, path.tokenAddress) });
    row.push({ text: 'Evidence', callback_data: callback('evidence', sessionId, walletSelector(presentation, path.wallet)) });
    return row;
  });
  return { text, keyboard: listKeyboard(sessionId, page, hasNext, buttons) };
}

function renderPath(path: PresentedCapitalPath, rank: number) {
  return [
    `${rank}. ${routeIcon(path.label)} <b>${h(path.label)}</b>  ·  ${path.importanceScore}/100`,
    `${h(chainLabel(path.sourceChain))}  <code>${h(shortAddress(path.sourceAddress))}</code>`,
    `↓  ${amount(path.amountUsd, path.amountToken, path.assetSymbol)}`,
    `${h(chainLabel(path.receiverChain))}  <code>${h(shortAddress(path.receiverAddress))}</code>`,
    path.tokenAddress ? `🎯 ${h(path.tokenSymbol ?? 'TOKEN')}  ·  funding → buy ${path.fundingToBuyDelaySec === null ? 'n/a' : duration(path.fundingToBuyDelaySec)}` : null,
    `🛡 ${percent(path.wallet.member.relationshipConfidence)}  ·  ${h(path.whyImportant[0] ?? 'Strong multi-signal route.')}`
  ].filter(nonNull).join('\n');
}

function renderCluster(presentation: InvestigationPresentation, sessionId: string) {
  const core = presentation.coreClusterWallets.filter(isTopTier).slice(0, 5);
  const peripheral = presentation.peripheralClusterWallets.filter(isTopTier).slice(0, 5);
  const text = [
    '🧩 <b>ENTITY CLUSTER</b>',
    DIVIDER,
    '🟢 <b>CORE</b>',
    ...(core.length ? core.map((wallet, index) => renderClusterWallet(wallet, index + 1)) : ['⚪ No core wallet passed the multi-signal role gate.']),
    '',
    '🟡 <b>PERIPHERAL</b>',
    ...(peripheral.length ? peripheral.map((wallet, index) => renderClusterWallet(wallet, index + 1)) : ['⚪ No peripheral relationship passed the display gate.']),
    '',
    `<i>Tier S/A shown by default. ${presentation.tierCounts.B + presentation.tierCounts.C} lower-tier candidates remain under Show more.</i>`
  ].join('\n');
  return { text, keyboard: { inline_keyboard: [
    [{ text: '🔎 Show more', callback_data: callback('invest', sessionId, 'more') }],
    [{ text: '← Back', callback_data: callback('back', sessionId, 'previous') }]
  ] } as InlineKeyboard };
}

function renderClusterWallet(row: PresentedIntelligenceWallet, rank: number) {
  return [
    '',
    `${rank}. ${tierIcon(row.intelligence.tier)} <code>${h(shortAddress(row.member.address))}</code>  ·  <b>${h(roleLabel(row.member.role))}</b>`,
    `🛡 ${row.intelligence.evidenceScore}/100  ·  confidence ${percent(row.member.relationshipConfidence)}`,
    `• ${h(row.intelligence.evidenceSignals[0]?.label ?? row.member.evidenceTier.replaceAll('_', ' '))}`
  ].join('\n');
}

function renderMoreWallets(presentation: InvestigationPresentation, page: number, sessionId: string) {
  const { items, hasNext } = pageRows(presentation.moreWallets, page, PAGE_SIZE);
  const text = [
    '🔎 <b>ADDITIONAL INTELLIGENCE</b>',
    DIVIDER,
    `<i>Tier B/C context · page ${page}</i>`,
    ...(items.length ? items.map((wallet, index) => renderWalletCard(wallet, (page - 1) * PAGE_SIZE + index + 1, /dormant|awakened/i.test(wallet.intelligence.status))) : ['⚪ No additional ranked candidates.'])
  ].join('\n');
  return { text, keyboard: listKeyboard(sessionId, page, hasNext, items.map((wallet) => [{ text: `${shortAddress(wallet.member.address)} · Evidence`, callback_data: callback('evidence', sessionId, walletSelector(presentation, wallet)) }])) };
}

function renderDeployments(presentation: InvestigationPresentation, page: number, sessionId: string) {
  const { items, hasNext } = pageRows(presentation.topDeployments, page, PAGE_SIZE);
  const text = [
    '🚀 <b>TOP DEPLOYMENTS</b>',
    DIVIDER,
    `<i>Intelligence-ranked · page ${page}</i>`,
    ...(items.length ? items.map((row, index) => renderDeployment(row, (page - 1) * PAGE_SIZE + index + 1)) : ['⚪ No deployment has enough intelligence to rank.'])
  ].join('\n\n');
  const buttons = items.map((row) => [
    { text: 'Evidence', callback_data: callback('evidence', sessionId, walletSelector(presentation, row.wallet)) },
    { text: 'Wallet', url: walletExplorer(row.deployment.chain, row.deployment.buyerAddress) },
    { text: 'Token', url: tokenExplorer(row.deployment.chain, row.deployment.tokenAddress) }
  ]);
  return { text, keyboard: listKeyboard(sessionId, page, hasNext, buttons) };
}

function renderDeployment(row: PresentedDeployment, rank: number) {
  const deployment = row.deployment;
  const intel = deployment.intelligence;
  return [
    `${rank}. 🚀 <b>${h(deployment.tokenSymbol ?? 'TOKEN')}</b>  ·  ${row.importanceScore}/100`,
    `🎯 <code>${h(shortAddress(deployment.tokenAddress))}</code>  ·  ${h(chainLabel(deployment.chain))}`,
    `💼 <code>${h(shortAddress(deployment.buyerAddress))}</code>  ·  Tier ${row.wallet.intelligence.tier}`,
    `🔗 ${h(shortEntity(deployment.sourceEntityKey ?? row.wallet.member.entityKey ?? 'unresolved'))}`,
    `📈 ATH ${intel?.athMcapUsd == null ? 'unavailable' : money(intel.athMcapUsd)}  ·  Result ${roi(intel?.roi)}`,
    `• ${h(row.whyImportant[0] ?? 'Ranked by existing wallet intelligence and funding evidence.')}`
  ].join('\n');
}

function renderEvidence(presentation: InvestigationPresentation, selector: string | undefined, page: number, sessionId: string) {
  const match = /^w:(\d+)$/.exec(selector ?? '');
  if (!match) {
    const { items, hasNext } = pageRows(presentation.walletCatalog.slice(0, 10), page, PAGE_SIZE);
    return {
      text: [
        '🛡 <b>EVIDENCE DESK</b>',
        DIVIDER,
        '<i>Select a wallet for its full evidence record.</i>',
        ...items.map((wallet, index) => [
          '',
          `${(page - 1) * PAGE_SIZE + index + 1}. ${tierIcon(wallet.intelligence.tier)} <code>${h(shortAddress(wallet.member.address))}</code>  ·  ${h(roleLabel(wallet.member.role))}`,
          `Evidence <b>${wallet.intelligence.evidenceScore}</b>  ·  ${wallet.intelligence.independentSignalCount} independent signals  ·  ${percent(wallet.member.relationshipConfidence)}`,
          `• ${h(wallet.intelligence.evidenceSignals[0]?.label ?? 'No strong signal recorded.')}`
        ].join('\n')),
        ...(items.length ? [] : ['⚪ No ranked wallet evidence is available.'])
      ].join('\n'),
      keyboard: listKeyboard(sessionId, page, hasNext, items.map((wallet) => [{ text: `🛡 ${shortAddress(wallet.member.address)}`, callback_data: callback('evidence', sessionId, walletSelector(presentation, wallet)) }]))
    };
  }
  const wallet = presentation.walletCatalog[Number(match[1])];
  if (!wallet) return { text: '🔴 <b>Wallet evidence is no longer available.</b>', keyboard: backKeyboard(sessionId) };
  const intel = wallet.intelligence;
  const strong = intel.evidenceSignals.filter((signal) => signal.strength >= 0.65).slice(0, 5);
  const weak = intel.evidenceSignals.filter((signal) => signal.strength < 0.65).slice(0, 3);
  const text = [
    `🛡 <b>EVIDENCE · TIER ${intel.tier}</b>`,
    DIVIDER,
    `<code>${h(wallet.member.address)}</code>`,
    `${h(chainLabel(wallet.member.chain))}  ·  ${h(roleLabel(wallet.member.role))}  ·  confidence <b>${percent(wallet.member.relationshipConfidence)}</b>`,
    '',
    '📊 <b>SCORES</b>',
    `Evidence <b>${intel.evidenceScore}/100</b>  ·  Alpha <b>${intel.sampleAdjustedHistoricalAlphaScore}/100</b>  ·  Wake <b>${intel.wakeUpPotential}/100</b>`,
    `Source ${intel.sourceScore ?? 'unavailable'} <i>· discovery prior only</i>`,
    `Coverage ${h(intel.historicalCoverage)}  ·  sample n=${intel.alphaSampleSize}  ·  alpha confidence ${percent(intel.alphaConfidence)}`,
    '',
    '🟢 <b>STRONG EVIDENCE</b>',
    ...(strong.length ? strong.map((signal) => `• ${h(signal.label)}  ·  ${percent(signal.strength)}  ·  ${signal.receiptCount} receipt${signal.receiptCount === 1 ? '' : 's'}`) : ['• None recorded.']),
    '',
    '🟡 <b>WEAK / CONTEXTUAL</b>',
    ...(weak.length ? weak.map((signal) => `• ${h(signal.label)}  ·  ${percent(signal.strength)}`) : ['• None recorded.']),
    '',
    '🔴 <b>COUNTER EVIDENCE</b>',
    ...(intel.contradictions.length ? intel.contradictions.slice(0, 4).map((reason) => `• ${h(reason)}`) : ['• None recorded.']),
    '',
    '⚙️ <b>INFRASTRUCTURE EXCLUSIONS</b>',
    '• Service, router and CEX-only nodes do not count as ownership evidence.',
    '',
    `🧠 <b>CONCLUSION</b>  ${conclusionIcon(intel.clusterConclusion)} ${h(intel.clusterConclusion)}`,
    `• ${h(intel.whyImportant[0] ?? 'Insufficient evidence for a stronger conclusion.')}`
  ].join('\n');
  return {
    text,
    keyboard: { inline_keyboard: [
      [{ text: 'Explorer', url: walletExplorer(wallet.member.chain, wallet.member.address) }, { text: 'Copy wallet', copy_text: { text: wallet.member.address } }],
      [{ text: '← Back', callback_data: callback('back', sessionId, 'previous') }]
    ] }
  };
}

function renderEntityHistory(value: WalletInvestigationResult, presentation: InvestigationPresentation, sessionId: string) {
  const wallets = presentation.walletCatalog;
  const dormant = wallets.filter((wallet) => /dormant|awakened/i.test(wallet.intelligence.status));
  const bestAlpha = wallets.reduce((best, wallet) => Math.max(best, wallet.intelligence.sampleAdjustedHistoricalAlphaScore), 0);
  const coveredRunners = presentation.topDeployments.filter((row) => (row.deployment.intelligence?.roi ?? 0) > 0);
  const lastActivity = latestTimestamp([
    ...value.members.map((member) => member.lastLinkedAt),
    ...value.deployments.map((deployment) => deployment.buyTs),
    ...value.coverage.map((coverage) => coverage.lastActivityAt)
  ]);
  const text = [
    '🕰 <b>ENTITY HISTORY</b>',
    DIVIDER,
    `🔗 <b>Entity</b>  ${value.entityKey ? `<code>${h(shortEntity(value.entityKey))}</code>` : '⚪ unresolved'}`,
    `📈 Historical Alpha  <b>${bestAlpha}/100</b>`,
    `🧩 Core wallets  <b>${presentation.coreClusterWallets.length}</b>  ·  Dormant tracked  <b>${dormant.length}</b>`,
    `🚀 Top deployments  <b>${presentation.topDeployments.length}</b>  ·  ROI-covered runners  <b>${coveredRunners.length}</b>`,
    `🕰 Last observed activity  <b>${h(lastActivity ? formatDate(lastActivity) : 'unavailable')}</b>`,
    '',
    '🚀 <b>HISTORICAL HIGHLIGHTS</b>',
    ...(presentation.topDeployments.length ? presentation.topDeployments.slice(0, 3).map((row, index) => `${index + 1}. <b>${h(row.deployment.tokenSymbol ?? 'TOKEN')}</b>  ·  ATH ${row.deployment.intelligence?.athMcapUsd == null ? 'unavailable' : money(row.deployment.intelligence.athMcapUsd)}  ·  ${roi(row.deployment.intelligence?.roi)}`) : ['⚪ No ranked historical deployment.']),
    '',
    '🛡 <b>STRONGEST EVIDENCE</b>',
    `• ${h(wallets[0]?.intelligence.evidenceSignals[0]?.label ?? 'No multi-signal relationship passed the gate.')}`
  ].join('\n');
  return { text, keyboard: backKeyboard(sessionId) };
}

function renderOutcomes(value: WalletInvestigationResult, sessionId: string) {
  const text = [
    '📊 <b>OUTCOMES & CALIBRATION</b>',
    DIVIDER,
    `🔗 ${value.entityKey ? `<code>${h(shortEntity(value.entityKey))}</code>` : 'Entity unresolved'}`,
    '',
    '⚪ <b>Insufficient production sample.</b>',
    '',
    '<i>This investigation does not contain a production-grade cohort linking WATCH, STRONG WATCH, HIGH CONVICTION, OPPORTUNITY and BUY CANDIDATE signals to realized outcomes. Precision, median ATH and drawdown are therefore not fabricated.</i>'
  ].join('\n');
  return { text, keyboard: backKeyboard(sessionId) };
}

function renderWatchConfirmation(value: WalletInvestigationResult, presentation: InvestigationPresentation, sessionId: string) {
  const dormant = presentation.walletCatalog.filter((wallet) => /dormant|awakened/i.test(wallet.intelligence.status)).length;
  const priority = monitoringPriority(presentation.walletCatalog);
  const text = [
    '✅ <b>CLUSTER ADDED TO MONITORING</b>',
    DIVIDER,
    `🔗 Entity  ${value.entityKey ? `<code>${h(shortEntity(value.entityKey))}</code>` : `<code>${h(shortAddress(value.rootAddress))}</code>`}`,
    `🧩 Core wallets  <b>${presentation.coreClusterWallets.length}</b>`,
    `💤 Dormant wallets  <b>${dormant}</b>`,
    `🎯 Monitoring priority  <b>${h(priority)}</b>`,
    '',
    '📡 <b>WATCHING</b>',
    '• Funding and capital rotations',
    '• Token buys and deployments',
    '• Bridge-linked activity',
    '• Dormant wallet wake-ups',
    '• Coordinated cluster execution'
  ].join('\n');
  return { text, keyboard: backKeyboard(sessionId) };
}

function summaryKeyboard(sessionId: string): InlineKeyboard {
  return { inline_keyboard: [
    [{ text: '💸 Capital Paths', callback_data: callback('invest', sessionId, 'priority') }, { text: '🧩 Cluster', callback_data: callback('invest', sessionId, 'cluster') }],
    [{ text: '🚀 Deployments', callback_data: callback('invest', sessionId, 'deployments') }, { text: '🛡 Evidence', callback_data: callback('invest', sessionId, 'evidence') }],
    [{ text: '🔄 Refresh', callback_data: callback('refresh', sessionId, 'run') }, { text: '📡 Watch', callback_data: callback('watch', sessionId, 'cluster') }],
    [{ text: '🕰 Entity History', callback_data: callback('invest', sessionId, 'history') }, { text: '📊 Outcomes', callback_data: callback('invest', sessionId, 'outcomes') }]
  ] };
}

function walletSelector(presentation: InvestigationPresentation, wallet: PresentedIntelligenceWallet) {
  const index = presentation.walletCatalog.findIndex((candidate) => candidate.member.chain === wallet.member.chain && candidate.member.address === wallet.member.address);
  return `w:${Math.max(0, index)}`;
}

function listKeyboard(sessionId: string, page: number, hasNext: boolean, rows: InlineKeyboard['inline_keyboard']): InlineKeyboard {
  const navigation: InlineKeyboard['inline_keyboard'][number] = [];
  if (page > 1) navigation.push({ text: '‹ Previous', callback_data: callback('page', sessionId, String(page - 1)) });
  if (hasNext) navigation.push({ text: 'Next ›', callback_data: callback('page', sessionId, String(page + 1)) });
  return { inline_keyboard: [...rows, ...(navigation.length ? [navigation] : []), [{ text: '← Back', callback_data: callback('back', sessionId, 'previous') }]] };
}

function backKeyboard(sessionId: string): InlineKeyboard {
  return { inline_keyboard: [[{ text: '← Back', callback_data: callback('back', sessionId, 'previous') }]] };
}

function pageRows<T>(rows: T[], page: number, size: number) {
  const start = (page - 1) * size;
  return { items: rows.slice(start, start + size), hasNext: start + size < rows.length };
}

function renderCoverage(row: WalletInvestigationResult['coverage'][number]) {
  const [icon, label] = coverageMark(row.coverageStatus);
  const activity = row.activityFound ? `${row.eventsScanned.toLocaleString('en-US')} events` : 'no activity';
  return `${icon} ${h(chainLabel(row.chain))}  ·  ${label}  ·  ${activity}`;
}

function coverageMark(status: WalletInvestigationResult['coverage'][number]['coverageStatus']): [string, string] {
  if (status === 'complete') return ['🟢', 'Complete'];
  if (status === 'partial' || status === 'retryable') return ['🟡', status === 'partial' ? 'Partial' : 'Retryable'];
  return ['🔴', 'None'];
}

function entityCount(presentation: InvestigationPresentation) {
  return new Set(presentation.walletCatalog.map((row) => row.member.entityKey).filter(nonNull)).size;
}

function isTopTier(wallet: PresentedIntelligenceWallet) {
  return wallet.intelligence.tier === 'S' || wallet.intelligence.tier === 'A';
}

function monitoringPriority(wallets: PresentedIntelligenceWallet[]) {
  if (wallets.some((wallet) => wallet.intelligence.trackingPriority === 'track_now')) return 'TRACK NOW';
  if (wallets.some((wallet) => wallet.intelligence.trackingPriority === 'watch')) return 'WATCH';
  return 'CONTEXT ONLY';
}

function latestTimestamp(values: Array<string | null>) {
  return values.filter(nonNull).sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' }).format(date)} UTC`;
}

function shortAddress(value: string) {
  if (value.length <= 14) return value;
  return `${value.slice(0, value.startsWith('0x') ? 8 : 6)}…${value.slice(-6)}`;
}

function shortEntity(value: string) {
  return value.length <= 24 ? value : `${value.slice(0, 12)}…${value.slice(-8)}`;
}

function roleLabel(value: string) {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function chainLabel(chain: string) {
  if (chain === 'ETHEREUM') return 'Ethereum';
  if (chain === 'ARBITRUM') return 'Arbitrum';
  if (chain === 'SOLANA') return 'Solana';
  if (chain === 'BASE') return 'Base';
  if (chain === 'BSC') return 'BSC';
  return chain;
}

function tierIcon(tier: string) {
  if (tier === 'S') return '🟣';
  if (tier === 'A') return '🟢';
  if (tier === 'B') return '🟡';
  return '⚪';
}

function confidenceIcon(value: number) {
  if (value >= 0.8) return '🟢';
  if (value >= 0.5) return '🟡';
  return '🔴';
}

function conclusionIcon(value: string) {
  if (value === 'supported') return '🟢';
  if (value === 'probable' || value === 'possible') return '🟡';
  return '🔴';
}

function routeIcon(label: string) {
  if (label.includes('TOKEN')) return '🎯';
  if (label.includes('BRIDGE')) return '🌉';
  if (label.includes('PROFIT')) return '📈';
  return '💸';
}

function dormancyLabel(days: number | null) {
  return days === null ? 'Dormancy unavailable' : `Dormant ${days}d`;
}

function amount(usd: number | null, token: string | null, symbol: string | null) {
  return usd !== null ? money(usd) : token ? `${h(token)} ${h(symbol ?? '')}`.trim() : 'unpriced';
}

function money(value: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value);
}

function roi(value: number | null | undefined) {
  if (value === null || value === undefined) return 'unavailable';
  const percentValue = Math.round(value * 100);
  return `${percentValue >= 0 ? '+' : ''}${percentValue}% ROI`;
}

function percent(value: number) {
  return `${Math.round(value * 100)}%`;
}

function duration(seconds: number) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.round(seconds / 3_600)}h`;
  return `${Math.round(seconds / 86_400)}d`;
}

function walletExplorer(chain: string, address: string) {
  return `${explorerBase(chain)}/address/${encodeURIComponent(address)}`.replace('solscan.io/address', 'solscan.io/account');
}

function tokenExplorer(chain: string, address: string) {
  return chain === 'SOLANA' ? `https://solscan.io/token/${encodeURIComponent(address)}` : `${explorerBase(chain)}/token/${encodeURIComponent(address)}`;
}

function transactionExplorer(chain: string, txHash: string) {
  return `${explorerBase(chain)}/tx/${encodeURIComponent(txHash)}`;
}

function explorerBase(chain: string) {
  if (chain === 'SOLANA') return 'https://solscan.io';
  if (chain === 'ETHEREUM') return 'https://etherscan.io';
  if (chain === 'BASE') return 'https://basescan.org';
  if (chain === 'ARBITRUM') return 'https://arbiscan.io';
  return 'https://bscscan.com';
}

function nonNull<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}
