import type { BridgeRow, CapitalFlowRow, OperatorPage, ProfitableWalletRow, WalletSummary } from '@flowradar/db';
import type { InlineKeyboard } from './types';

const DIVIDER = '━━━━━━━━━━━━━━━━━━━━';

export function h(value: unknown) { return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'); }
export function short(value: string, size = 6) { return value.length <= size * 2 + 1 ? value : `${value.slice(0, size)}…${value.slice(-size)}`; }
export function money(value: number | null | undefined) { if (value == null) return 'n/a'; return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value); }
export function pct(value: number | null | undefined) { return value == null ? 'n/a' : `${(value * 100).toFixed(1)}%`; }

export function renderWallet(value: WalletSummary) {
  return [
    '👛 <b>WALLET PROFILE</b>', DIVIDER,
    `<code>${h(short(value.address, 8))}</code>  ·  ${h(value.detectedChains.join(', ') || 'Unknown chain')}`,
    `${qualityIcon(value.relationshipConfidence)} ${h(pretty(value.role))}  ·  confidence <b>${pct(value.relationshipConfidence)}</b>`,
    `🧠 ${h(value.entityKey ?? 'Entity unresolved')}`,
    '',
    '📊 <b>PERFORMANCE</b>',
    `WR <b>${pct(value.winRate)}</b>  ·  EV <b>${money(value.evUsd)}</b>  ·  Runners <b>${value.repeatRunnerCount ?? 'n/a'}</b>`,
    `Wins ${value.winCount}  ·  Losses ${value.lossCount}  ·  Open ${value.unresolvedPositions}`,
    '',
    '🔗 <b>CAPITAL MAP</b>',
    `Direct ${value.routes.direct}  ·  Multi-hop ${value.routes.multiHop}  ·  Bridges ${value.routes.bridges}  ·  Possible CEX ${value.routes.possibleCex}`,
    `💤 Dormancy 7/14/30/90d  ${flag(value.dormancy.days7)}/${flag(value.dormancy.days14)}/${flag(value.dormancy.days30)}/${flag(value.dormancy.days90)}`,
    `🕰 Last relevant  ${h(value.lastRelevantActivity ?? 'Unavailable')}`,
    warnings(value.coverageWarnings)
  ].filter(Boolean).join('\n');
}

export function renderProfitable(value: OperatorPage<ProfitableWalletRow>) {
  return [
    '📈 <b>PROFITABLE WALLETS</b>', DIVIDER,
    `Tracked <b>${value.total}</b>  ·  Page <b>${value.page}</b>`,
    '<i>Realized performance first. Provider-only claims remain labeled.</i>',
    ...value.items.map((row, i) => [
      '',
      `${(value.page - 1) * value.pageSize + i + 1}. ${qualityIcon(row.confidence)} <code>${h(short(row.address, 7))}</code>  ·  <b>${h(row.chain)}</b>`,
      `🎭 ${h(pretty(row.role))}  ·  confidence ${pct(row.confidence)}`,
      `💰 Local <b>${money(row.localRealizedPnlUsd)}</b>  ·  Provider ${money(row.providerClaimedPnlUsd)}`,
      `📊 WR ${pct(row.winRate)}  ·  EV ${money(row.evUsd)}  ·  Runners ${row.repeatRunnerCount ?? 'n/a'}`,
      `🛡 ${h(pretty(row.validation))}  ·  coverage ${h(pretty(row.coverage))}`
    ].join('\n')),
    warnings(value.coverageWarnings)
  ].filter(Boolean).join('\n');
}

export function renderFlows(value: OperatorPage<CapitalFlowRow>) {
  return [
    '💸 <b>CAPITAL FLOW</b>', DIVIDER,
    `Relevant paths <b>${value.total}</b>  ·  Page <b>${value.page}</b>`,
    ...value.items.map((row) => `\n${qualityIcon(null)} <b>${h(row.sourceChain)} → ${h(row.destinationChain)}</b>\n<code>${h(short(row.source))}</code>\n↓  ${money(row.amountUsd)}\n<code>${h(short(row.destination))}</code>\n• ${h(pretty(row.route))}${row.protocol ? ` · ${h(row.protocol)}` : ''}`),
    warnings(value.coverageWarnings)
  ].filter(Boolean).join('\n');
}

export function renderBridges(value: OperatorPage<BridgeRow>) {
  return [
    '🌉 <b>BRIDGE INTELLIGENCE</b>', DIVIDER,
    `Verified paths <b>${value.total}</b>  ·  Page <b>${value.page}</b>`,
    ...value.items.map((row) => `\n${qualityIcon(row.confidence)} <b>${h(row.protocol)}</b>  ·  ${h(row.sourceChain)} → ${h(row.destinationChain)}\n<code>${h(short(row.recipient, 7))}</code>  ·  ${money(row.amountUsd)}\n🛡 ${pct(row.confidence)}  ·  ${h(pretty(row.evidenceTier))}\n🎯 ${h(row.tokenBuy ? short(row.tokenBuy) : 'No token buy observed')}`),
    warnings(value.coverageWarnings)
  ].filter(Boolean).join('\n');
}

export function navKeyboard(sessionId: string, page: number, hasNext: boolean, extras: InlineKeyboard['inline_keyboard'] = []): InlineKeyboard {
  const nav = [];
  if (page > 1) nav.push({ text: '‹ Previous', callback_data: callback('page', sessionId, String(page - 1)) });
  if (hasNext) nav.push({ text: 'Next ›', callback_data: callback('page', sessionId, String(page + 1)) });
  return { inline_keyboard: [...(nav.length ? [nav] : []), ...extras, [{ text: '📦 Export', callback_data: callback('exportmenu', sessionId, 'open') }]] };
}

export function exportKeyboard(sessionId: string): InlineKeyboard {
  return { inline_keyboard: [[{ text: 'CSV', callback_data: callback('export', sessionId, 'csv') }, { text: 'JSON', callback_data: callback('export', sessionId, 'json') }], [{ text: '← Back', callback_data: callback('exportback', sessionId, 'result') }]] };
}

export function callback(action: string, sessionId: string, value: string) { const data = `v1|${action}|${sessionId}|${value}`; if (Buffer.byteLength(data) > 64) throw new Error('Telegram callback_data exceeds 64 bytes'); return data; }
function warnings(values: string[]) { return values.length ? `\n🟡 <i>Coverage limitations: ${values.map(h).join(' ')}</i>` : ''; }
function flag(value: boolean | null) { return value == null ? '?' : value ? 'yes' : 'no'; }
function pretty(value: string) { return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function qualityIcon(value: number | null) { if (value === null) return '⚪'; if (value >= 0.8) return '🟢'; if (value >= 0.5) return '🟡'; return '🔴'; }
