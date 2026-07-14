import type { InlineKeyboard } from './types';

type CoreAlertRecord = { id: string; alertType: string; payloadJson: unknown };
type CoreAlertView = 'summary' | 'wallets' | 'capital' | 'entity';

export function renderCoreMonitoringAlert(alert: CoreAlertRecord, view: CoreAlertView = 'summary') {
  const payload = record(alert.payloadJson);
  if (alert.alertType === 'dormant_wallet_reactivated') return renderDormant(alert.id, payload);
  if (view === 'wallets') return renderWallets(alert.id, payload);
  if (view === 'capital') return renderCapital(alert.id, payload);
  if (view === 'entity') return renderEntity(alert.id, payload);
  return renderSummary(alert.id, payload);
}

export function parseCoreAlertCallback(value: string | undefined): { alertId: string; view: CoreAlertView } | null {
  const parts = value?.split('|');
  if (parts?.length !== 3 || parts[0] !== 'c2') return null;
  const views: Record<string, CoreAlertView> = { s: 'summary', w: 'wallets', c: 'capital', e: 'entity' };
  const view = views[parts[1]];
  return view && parts[2] ? { alertId: parts[2], view } : null;
}

function renderSummary(alertId: string, payload: Record<string, unknown>) {
  const tier = string(payload.signalTier) ?? 'WATCH';
  const symbol = string(payload.symbol) ?? string(payload.token) ?? 'TOKEN';
  const protocol = string(payload.protocol);
  const rawWallets = number(payload.rawWalletCount) ?? array(payload.wallets).length;
  const independent = number(payload.independentEntityCount) ?? 0;
  const sameEntity = number(payload.sameEntityWalletCount) ?? 0;
  const combinedUsd = number(payload.combinedBuyUsd);
  const combinedToken = number(payload.combinedTokenAmount);
  const entityLabels = strings(payload.entityLabels);
  const entityLabel = entityLabels.length === 1 ? entityLabels[0]
    : independent >= 2 ? `${independent} independent entities` : 'Tracked Core cluster';
  const marketCap = number(payload.marketCapUsd);
  const liquidity = number(payload.liquidityUsd);
  const holders = number(payload.holderCount);
  const entryDelay = number(payload.entryDelaySec);
  const alpha = number(payload.historicalAlphaScore);
  const dormant = number(payload.dormantWakeUpCount) ?? 0;
  const maxDormantDays = number(payload.maxDormantDays);
  const confidence = number(payload.confidence);
  const windowMs = number(payload.windowMs);
  const why = string(payload.whyThisMatters);
  const ca = string(payload.ca);
  const chain = string(payload.chain);
  const icon = tier === 'WATCH' ? '🟡' : '🟢';
  const metrics = [
    entryDelay !== null ? `📊 Entry: <b>${duration(entryDelay)}</b> after launch` : null,
    liquidity !== null ? `💧 Liquidity: <b>${usd(liquidity)}</b>` : null,
    holders !== null ? `👥 Holders: <b>${Math.round(holders).toLocaleString('en-US')}</b>` : null,
    alpha !== null ? `📈 Historical Alpha: <b>${Math.round(alpha)}</b>` : null,
    dormant > 0 ? `⚡ Dormant wake-up: <b>${dormant}</b>${maxDormantDays !== null ? ` · ${Math.round(maxDormantDays)}d max` : ''}` : null,
    confidence !== null ? `🎯 Confidence: <b>${Math.round(confidence * 100)}%</b>` : null
  ].filter(nonNull);
  const buyDescription = combinedToken !== null
    ? `${quantity(combinedToken)} ${h(symbol)}${combinedUsd !== null ? ` (${usd(combinedUsd)})` : ''}`
    : combinedUsd !== null ? usd(combinedUsd) : null;
  return {
    text: [
      `${icon} <b>CLUSTER BUY</b>${protocol ? ` on ${h(protocol)}` : ''} · <b>${h(symbol)}</b>`,
      `🔷 ${h(entityLabel)}`, '',
      `🔹 <b>${rawWallets}</b> tracked wallets / <b>${independent}</b> independent entities`,
      ...(sameEntity > 1 && independent <= 1 ? [`🔹 ${sameEntity} wallets belong to the same entity and count as one independent confirmation.`] : []),
      ...(buyDescription ? [`🔹 Cluster bought <b>${buyDescription}</b>${marketCap !== null ? ` at MC <b>${usd(marketCap)}</b>` : ''}`] : []),
      ...(windowMs !== null ? [`⏱ Window: <b>${duration(Math.max(1, Math.round(windowMs / 1_000)))}</b>`] : []),
      '', ...metrics,
      ...(why ? ['', '🧠 <b>Why this matters</b>', h(why)] : []),
      '', `${tierIcon(tier)} Signal: <b>${h(tier.replaceAll('_', ' '))}</b>`,
      ...(ca ? ['', 'CA:', `<code>${h(ca)}</code>`] : [])
    ].join('\n'),
    keyboard: alertKeyboard(alertId, chain, ca)
  };
}

function renderDormant(alertId: string, payload: Record<string, unknown>) {
  const wallet = string(payload.wallet);
  const chain = string(payload.chain);
  const evidence = record(payload.evidence);
  const days = number(evidence.dormantDays ?? payload.preWakeDormancy);
  return {
    text: [
      '🟡 <b>DORMANT WALLET AWAKENED</b>',
      ...(chain ? [`🔷 ${h(chain)}`] : []), '',
      ...(wallet ? [`Wallet <code>${h(wallet)}</code>`] : []),
      ...(days !== null ? [`Inactive period: <b>${Math.round(days)} days</b>`] : []),
      '', 'This is an activity wake-up receipt, not a token buy opportunity.'
    ].join('\n'),
    keyboard: { inline_keyboard: [[{ text: '🧠 Entity', callback_data: coreCallback('entity', alertId) }]] }
  };
}

function renderWallets(alertId: string, payload: Record<string, unknown>) {
  const participants = objects(payload.participants);
  return detail([
    '👥 <b>QUALIFIED WALLETS</b>', '',
    ...(participants.length ? participants.map((participant, index) => {
      const entity = string(participant.entityLabel) ?? string(participant.entityKey);
      const amount = number(participant.amountUsd);
      return [
        `<b>${index + 1}. ${h(string(participant.role) ?? 'tracked')}</b>${amount !== null ? ` · ${usd(amount)}` : ''}`,
        `<code>${h(string(participant.wallet) ?? 'unknown')}</code>`,
        ...(entity ? [`Entity: ${h(entity)}`] : [])
      ].join('\n');
    }) : ['No qualified wallet details are available.'])
  ], alertId);
}

function renderCapital(alertId: string, payload: Record<string, unknown>) {
  const paths = objects(payload.fundingPaths);
  return detail([
    '🔗 <b>CAPITAL PATH</b>', '',
    ...(paths.length ? paths.map((path, index) => [
      `<b>${index + 1}. ${h(pretty(string(path.route) ?? 'funding'))}</b>`,
      `<code>${h(string(path.source) ?? 'unknown')}</code>`, '↓',
      `<code>${h(string(path.destination) ?? 'unknown')}</code>`,
      ...(number(path.confidence) !== null ? [`Confidence: ${Math.round(number(path.confidence)! * 100)}%`] : [])
    ].join('\n')) : ['No direct or exact-bridge funding path is attached to this signal.'])
  ], alertId);
}

function renderEntity(alertId: string, payload: Record<string, unknown>) {
  const labels = strings(payload.entityLabels);
  return detail([
    '🧠 <b>ENTITY CONFIRMATION</b>', '',
    `Raw wallets: <b>${number(payload.rawWalletCount) ?? 0}</b>`,
    `Core wallets: <b>${number(payload.coreWalletCount) ?? 0}</b>`,
    `Related wallets: <b>${number(payload.relatedWalletCount) ?? 0}</b>`,
    `Entities: <b>${number(payload.entityCount) ?? 0}</b>`,
    `Independent entities: <b>${number(payload.independentEntityCount) ?? 0}</b>`,
    `Same-entity wallets: <b>${number(payload.sameEntityWalletCount) ?? 0}</b>`,
    `Effective confirmations: <b>${number(payload.effectiveConfirmationCount) ?? 0}</b>`,
    ...(labels.length ? ['', ...labels.map((label) => `• ${h(label)}`)] : [])
  ], alertId);
}

function detail(lines: string[], alertId: string) {
  return { text: lines.join('\n'), keyboard: { inline_keyboard: [[{ text: '← Back', callback_data: coreCallback('summary', alertId) }]] } };
}

function alertKeyboard(alertId: string, chain: string | null, ca: string | null): InlineKeyboard {
  const rows: InlineKeyboard['inline_keyboard'] = [];
  if (chain === 'SOLANA' && ca) {
    rows.push([
      { text: '🐴 Trojan', url: `https://t.me/solana_trojanbot?start=${encodeURIComponent(ca)}` },
      { text: '🟪 Padre', url: `https://trade.padre.gg/trade/solana/${encodeURIComponent(ca)}` },
      { text: '🦎 GMGN', url: `https://gmgn.ai/sol/token/${encodeURIComponent(ca)}` }
    ]);
    rows.push([
      { text: 'AXIOM', url: `https://axiom.trade/t/${encodeURIComponent(ca)}` },
      { text: 'Bonk', url: `https://t.me/bonkbot_bot?start=${encodeURIComponent(ca)}` },
      { text: '📊 Info', url: `https://dexscreener.com/solana/${encodeURIComponent(ca)}` }
    ]);
  } else if (chain && ca) {
    const slug = ({ ETHEREUM: 'ethereum', BASE: 'base', ARBITRUM: 'arbitrum', BSC: 'bsc' } as Record<string, string>)[chain];
    if (slug) rows.push([{ text: '📊 Info', url: `https://dexscreener.com/${slug}/${encodeURIComponent(ca)}` }]);
  }
  rows.push([
    { text: '👥 Wallets', callback_data: coreCallback('wallets', alertId) },
    { text: '🔗 Capital Path', callback_data: coreCallback('capital', alertId) },
    { text: '🧠 Entity', callback_data: coreCallback('entity', alertId) }
  ]);
  return { inline_keyboard: rows };
}

function coreCallback(view: CoreAlertView, alertId: string) {
  const code = ({ summary: 's', wallets: 'w', capital: 'c', entity: 'e' } as const)[view];
  return `c2|${code}|${alertId}`;
}
function tierIcon(tier: string) { return tier === 'HIGH_CONVICTION' ? '🔴' : tier === 'STRONG_WATCH' ? '🟠' : '🟡'; }
function usd(value: number) { return `$${value >= 1_000_000 ? `${trim(value / 1_000_000)}M` : value >= 1_000 ? `${trim(value / 1_000)}K` : trim(value)}`; }
function quantity(value: number) { return value >= 1_000_000 ? `${trim(value / 1_000_000)}M` : value >= 1_000 ? `${trim(value / 1_000)}K` : trim(value); }
function trim(value: number) { return value.toLocaleString('en-US', { maximumFractionDigits: 2 }); }
function duration(seconds: number) { const s = Math.max(0, Math.round(seconds)); const days = Math.floor(s / 86_400); const hours = Math.floor((s % 86_400) / 3_600); const minutes = Math.floor((s % 3_600) / 60); const rest = s % 60; return days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes}m` : minutes ? `${minutes}m ${rest}s` : `${rest}s`; }
function h(value: string) { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'); }
function pretty(value: string) { return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function objects(value: unknown) { return Array.isArray(value) ? value.map(record).filter((item) => Object.keys(item).length > 0) : []; }
function array(value: unknown) { return Array.isArray(value) ? value : []; }
function strings(value: unknown) { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : []; }
function string(value: unknown) { return typeof value === 'string' && value.length > 0 ? value : null; }
function number(value: unknown) { const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN; return Number.isFinite(parsed) ? parsed : null; }
function nonNull<T>(value: T | null): value is T { return value !== null; }
