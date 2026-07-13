import type { BridgeRow, CapitalFlowRow, OperatorPage, ProfitableWalletRow, WalletSummary } from '@flowradar/db';
import type { InlineKeyboard } from './types';

export function h(value: unknown) { return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'); }
export function short(value: string, size = 6) { return value.length <= size * 2 + 1 ? value : `${value.slice(0, size)}…${value.slice(-size)}`; }
export function money(value: number | null | undefined) { if (value == null) return 'n/a'; return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value); }
export function pct(value: number | null | undefined) { return value == null ? 'n/a' : `${(value * 100).toFixed(1)}%`; }

export function renderWallet(value: WalletSummary) {
  return [`<b>Wallet ${h(short(value.address, 8))}</b>`, `Chains: ${h(value.detectedChains.join(', ') || 'unknown')}`, `Role: <b>${h(value.role)}</b> · confidence ${pct(value.relationshipConfidence)}`, `Entity: ${h(value.entityKey ?? 'not linked')}`, `Events: ${value.eventCounts.raw} raw · ${value.eventCounts.relevant} relevant · ${value.eventCounts.highPriority} high`, `PnL: WR ${pct(value.winRate)} · EV ${money(value.evUsd)} · W/L/U ${value.winCount}/${value.lossCount}/${value.unresolvedPositions}`, `Repeat runners: ${value.repeatRunnerCount ?? 'n/a'} · one-winner ${pct(value.oneWinnerDependence)}`, `Routes: direct ${value.routes.direct} · multi-hop ${value.routes.multiHop} · bridge ${value.routes.bridges} · possible CEX ${value.routes.possibleCex}`, `Dormancy 7/14/30/90d: ${flag(value.dormancy.days7)}/${flag(value.dormancy.days14)}/${flag(value.dormancy.days30)}/${flag(value.dormancy.days90)}`, `Undeployed capital: ${money(value.undeployedCapitalUsd)}`, `Last relevant: ${h(value.lastRelevantActivity ?? 'n/a')}`, warnings(value.coverageWarnings)].filter(Boolean).join('\n');
}

export function renderProfitable(value: OperatorPage<ProfitableWalletRow>) {
  return [`<b>Profitable wallets</b> · page ${value.page} · ${value.total} total`, ...value.items.map((row, i) => `${(value.page - 1) * value.pageSize + i + 1}. <b>${h(row.chain)}</b> <code>${h(short(row.address, 7))}</code>\n   local ${money(row.localRealizedPnlUsd)} · claimed ${money(row.providerClaimedPnlUsd)} · WR ${pct(row.winRate)} · ${h(row.validation)}`), warnings(value.coverageWarnings)].filter(Boolean).join('\n');
}

export function renderFlows(value: OperatorPage<CapitalFlowRow>) {
  return [`<b>Capital flow</b> · page ${value.page} · ${value.total} total`, ...value.items.map((row) => `<b>${h(row.sourceChain)}→${h(row.destinationChain)}</b> ${h(short(row.source))} → ${h(short(row.destination))}\n${h(row.route)} · ${money(row.amountUsd)} · ${h(row.protocol ?? row.asset ?? '')} · ${h(row.ts)}`), warnings(value.coverageWarnings)].filter(Boolean).join('\n');
}

export function renderBridges(value: OperatorPage<BridgeRow>) {
  return [`<b>Bridges</b> · page ${value.page} · ${value.total} total`, ...value.items.map((row) => `<b>${h(row.protocol)}</b> ${h(row.sourceChain)}→${h(row.destinationChain)} · ${h(row.evidenceTier)} ${pct(row.confidence)}\nrecipient <code>${h(short(row.recipient, 7))}</code> · ${money(row.amountUsd)} · buy ${h(row.tokenBuy ? short(row.tokenBuy) : 'none observed')}`), warnings(value.coverageWarnings)].filter(Boolean).join('\n');
}

export function navKeyboard(sessionId: string, page: number, hasNext: boolean, extras: InlineKeyboard['inline_keyboard'] = []): InlineKeyboard {
  const nav = [];
  if (page > 1) nav.push({ text: '‹ Back', callback_data: callback('page', sessionId, String(page - 1)) });
  if (hasNext) nav.push({ text: 'Next ›', callback_data: callback('page', sessionId, String(page + 1)) });
  return { inline_keyboard: [...(nav.length ? [nav] : []), ...extras, [{ text: 'CSV', callback_data: callback('export', sessionId, 'csv') }, { text: 'JSON', callback_data: callback('export', sessionId, 'json') }]] };
}

export function callback(action: string, sessionId: string, value: string) { const data = `v1|${action}|${sessionId}|${value}`; if (Buffer.byteLength(data) > 64) throw new Error('Telegram callback_data exceeds 64 bytes'); return data; }
function warnings(values: string[]) { return values.length ? `\n<i>Coverage:</i> ${values.map(h).join(' ')}` : ''; }
function flag(value: boolean | null) { return value == null ? '?' : value ? 'yes' : 'no'; }
