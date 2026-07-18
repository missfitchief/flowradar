import type { OperatorService } from '@flowradar/db';
import type { InlineKeyboard } from './types';

type AdaptiveAlert = NonNullable<Awaited<ReturnType<OperatorService['intelligenceAlert']>>>;
type AdaptiveAlertView = 'summary' | 'why' | 'evidence' | 'history' | 'outcomes' | 'path' | 'risk';
const DIVIDER = '━━━━━━━━━━━━━━━━━━━━';

export function renderIntelligenceAlert(data: AdaptiveAlert, view: AdaptiveAlertView = 'summary'): { text: string; keyboard: InlineKeyboard } {
  if (!data.signal) return renderLegacy(data);
  if (view === 'why') return detail(data, 'Why this signal', scoreLines(data), view);
  if (view === 'evidence') return detail(data, 'Evidence', evidenceLines(data), view);
  if (view === 'history') return detail(data, 'Full entity history', historyLines(data), view);
  if (view === 'outcomes') return detail(data, 'Outcome tracking', outcomeLines(data), view);
  if (view === 'path') return detail(data, 'Capital path', capitalPathLines(data), view);
  if (view === 'risk') return detail(data, 'Token risk', riskLines(data), view);
  const signal = data.signal;
  const payload = data.payload ?? {};
  const quality = signal.qualityAssessment;
  const token = stringValue(payload.token) ?? stringValue(payload.symbol) ?? signal.tokenAddress;
  const tier = signal.buyCandidate ? 'BUY CANDIDATE' : signal.lifecycleStage.replaceAll('_', ' ');
  const snapshotWalletRows = snapshotWallets(signal.featureSnapshotJson);
  const activeCore = data.entities.flatMap((entity) => entity.memberships.filter((membership) => membership.scope === 'core').map((membership) => membership.profile.address)).slice(0, 5);
  const dormantAwakened = snapshotWalletRows.filter((wallet) => wallet.dormantAwakened === true);
  const fundingSequences = array(record(signal.evidenceJson).funding).length;
  const riskPassed = quality?.reasonCodes.filter((code) => code.endsWith('_pass') || code.includes('_verified')).slice(0, 5) ?? [];
  const riskFailed = quality?.reasonCodes.filter((code) => code.includes('fail') || code.includes('risk') || code.includes('unknown')).slice(0, 5) ?? [];
  const invalidation = invalidationConditions(quality?.reasonCodes ?? []);
  const text = [
    DIVIDER,
    '📡 <b>FLOWRADAR SIGNAL</b>',
    DIVIDER,
    `${signalIcon(tier)} <b>${h(tier)}</b>`,
    '',
    `🎯 <b>${h(token)}</b>  ·  ${h(signal.chain)}`,
    `<code>${h(signal.tokenAddress)}</code>`,
    '',
    '📊 <b>INTELLIGENCE</b>',
    `${scoreIcon(signal.score)} Signal confidence  <b>${Math.round(signal.score)}/100</b>`,
    `${quality ? (quality.passed ? '🟢' : '🟡') : '⚪'} Token quality  <b>${quality ? Math.round(quality.score) : 'Unknown'}</b>  ·  ${quality?.passed ? 'PASS' : 'BLOCKED'}`,
    '',
    '💡 <b>WHY THIS MATTERS</b>',
    ...signal.reasons.slice(0, 4).map((reason) => `✓ ${h(reason)}`),
    '',
    '🧩 <b>CLUSTER ACTIVATION</b>',
    `🧠 Independent entities  <b>${signal.independentEntityCount}</b>  ·  Capital roots  <b>${signal.independentCapitalRootCount}</b>`,
    `👑 Core wallets  <b>${signal.coreWalletCount}</b>  ·  Peripheral  <b>${signal.peripheralWalletCount}</b>`,
    ...(activeCore.length ? [`Active core  ${activeCore.map(short).join('  ·  ')}`] : []),
    `😴 Dormant awakened  <b>${dormantAwakened.length}</b>  ·  Funding → execution → buy  <b>${fundingSequences ? 'Yes' : 'No'}</b>`,
    ...entitySummary(data),
    '',
    '🛡 <b>RISK GATE</b>',
    quality ? `${quality.passed ? '🟢 PASS' : '🟡 BLOCKED'}  ·  ${Math.round(quality.score)}/100  ·  coverage ${h(quality.coverage)}` : '⚪ BLOCKED  ·  quality assessment unavailable',
    ...(riskPassed.length ? [`✓ ${h(riskPassed.map(pretty).join('  ·  '))}`] : []),
    ...(riskFailed.length ? [`• Open: ${h(riskFailed.map(pretty).join('  ·  '))}`] : []),
    '',
    '⚠️ <b>INVALIDATION</b>',
    ...invalidation.map((row) => `• ${h(row)}`),
    '',
    `📈 <b>Outcome</b>  ${h(signal.outcomeLabel?.label ?? signal.outcomeStatus)}${signal.outcomeLabel ? `  ·  ${h(signal.outcomeLabel.basisHorizon)}` : ''}`,
    '<i>Research intelligence only · no automatic execution.</i>'
  ].join('\n');
  return { text, keyboard: keyboard(data.alert.id, 'summary') };
}

function scoreLines(data: AdaptiveAlert) {
  const decomposition = record(data.signal?.scoreDecompositionJson);
  const dimensions = record(decomposition.dimensions);
  const dimensionLines = Object.entries(dimensions).flatMap(([key, value]) => typeof value === 'number'
    ? [`• ${pretty(key)}: ${Math.round(value)}/100${key === 'riskScore' ? ' (lower is better)' : ''}`]
    : []);
  const lines = Object.entries(decomposition).map(([key, value]) => {
    const row = record(value);
    return `• ${pretty(key)}: ${number(row.contribution) ?? 0} pts · ${stringValue(row.explanation) ?? 'no explanation'}`;
  }).filter((line) => !line.startsWith('• dimensions:'));
  return [
    `Stage: ${data.signal?.lifecycleStage ?? 'unknown'} · total ${data.signal?.score ?? 0}/100`,
    ...(dimensionLines.length ? dimensionLines : lines),
    '',
    'Wallets inside the same entity count as one independent confirmation.'
  ];
}

function evidenceLines(data: AdaptiveAlert) {
  const lines = data.entities.flatMap((entity) => [
    `Entity ${entity.label} · identity ${pct(entity.identityConfidence)} · relevance ${pct(entity.currentRelevance)}`,
    `Strongest: ${summarizeEvidence(entity.strongestEvidenceJson)}`,
    `Counter-evidence: ${summarizeCounterEvidence(entity.counterEvidenceJson)}`,
    ...entity.memberships.slice(0, 8).map((membership) => `• ${membership.scope}/${membership.status} · ${membership.profile.role} · ${short(membership.profile.address)} · ${membership.evidenceTypes.join(', ') || 'evidence unknown'}`)
  ]);
  return lines.length ? [...lines, 'Infrastructure/router/CEX-only memberships are excluded from independence counts.'] : ['No adaptive entity membership receipt is available for this legacy alert.'];
}

function historyLines(data: AdaptiveAlert) {
  const participants = array(record(data.signal?.historySupportJson).participants);
  return [
    ...data.entities.map((entity) => `${entity.label}: alpha ${Math.round(entity.historicalAlphaScore)}/100 (${pct(entity.historicalAlphaConfidence)} sample confidence), wake-up ${Math.round(entity.wakeUpPotential)}/100, outcomes ${entity.outcomeCount}`),
    ...participants.slice(0, 10).map((value) => {
      const row = record(value);
      return `• ${short(stringValue(row.address) ?? 'unknown')} · role ${stringValue(row.role) ?? 'unknown'} · source ${number(row.sourceScore) ?? 'n/a'} · raw/sample alpha ${number(row.rawHistoricalAlphaScore) ?? 'n/a'}/${number(row.sampleAdjustedHistoricalAlphaScore) ?? number(row.historicalAlphaScore) ?? 'n/a'} · confidence ${pct(number(row.alphaConfidence) ?? 0)}`;
    }),
    ...(participants.length === 0 && data.entities.length === 0 ? ['Historical support unavailable. It is not inferred.'] : [])
  ];
}

function outcomeLines(data: AdaptiveAlert) {
  const outcomes = data.signal?.outcomes ?? [];
  if (!outcomes.length) return ['Outcome evaluation is pending.'];
  return [
    `Label: ${data.signal?.outcomeLabel?.label ?? 'pending'}`,
    ...outcomes.map((row) => `${row.horizon}: ${row.status}/${row.coverage} · return ${fmt(row.realizedReturnPct)} · peak ${fmt(row.maxReturnPct)} · drawdown ${fmt(row.maxDrawdownPct)} · liquidity ${fmt(row.liquidityRetentionPct)}`),
    '',
    'Each horizon uses only snapshots at or before its target time.'
  ];
}

function capitalPathLines(data: AdaptiveAlert) {
  const evidence = record(data.signal?.evidenceJson);
  const funding = array(evidence.funding);
  const buys = array(evidence.buys);
  const lines = [
    ...funding.slice(0, 8).map((value) => {
      const event = record(record(value).event);
      return `funding ${short(stringValue(event.from) ?? 'unknown')} → ${short(stringValue(event.to) ?? 'unknown')} · tx ${short(stringValue(event.txHash) ?? 'unknown')}`;
    }),
    ...buys.slice(0, 8).map((value) => {
      const event = record(value);
      return `buy ${short(stringValue(event.actor) ?? stringValue(event.from) ?? 'unknown')} → ${short(data.signal?.tokenAddress ?? 'unknown')} · tx ${short(stringValue(event.txHash) ?? 'unknown')}`;
    })
  ];
  return lines.length ? lines : ['No receipt-linked capital path is available for this alert.'];
}

function riskLines(data: AdaptiveAlert) {
  const quality = data.signal?.qualityAssessment;
  if (!quality) return ['Token quality assessment unavailable. Signal cannot become a Buy Candidate.'];
  const checks = record(quality.checksJson);
  const results = record(checks.results);
  return [
    `Gate: ${quality.passed ? 'PASS' : 'BLOCKED'} · score ${Math.round(quality.score)}/100 · coverage ${quality.coverage}`,
    ...Object.entries(results).map(([key, value]) => `• ${pretty(key)}: ${value === true ? 'pass' : value === false ? 'fail' : 'unknown'}`),
    ...quality.reasonCodes.slice(0, 12).map((code) => `• ${code}`)
  ];
}

function detail(data: AdaptiveAlert, title: string, lines: string[], view: AdaptiveAlertView) {
  const icon = view === 'evidence' ? '🛡' : view === 'why' ? '💡' : view === 'path' ? '💸' : view === 'risk' ? '⚠️' : view === 'history' ? '📜' : '📈';
  return {
    text: [`${icon} <b>${h(title.toUpperCase())}</b>`, DIVIDER, '<i>Production signal receipt · existing intelligence only.</i>', '', ...lines.map((line) => h(line))].join('\n'),
    keyboard: keyboard(data.alert.id, view)
  };
}

function keyboard(alertId: string, view: AdaptiveAlertView): InlineKeyboard {
  if (view !== 'summary') return { inline_keyboard: [[{ text: '← Back', callback_data: alertCallback('summary', alertId) }]] };
  return { inline_keyboard: [
    [{ text: '🛡 Evidence', callback_data: alertCallback('evidence', alertId) }, { text: '💡 Why', callback_data: alertCallback('why', alertId) }],
    [{ text: '💸 Capital Path', callback_data: alertCallback('path', alertId) }, { text: '⚠️ Token Risk', callback_data: alertCallback('risk', alertId) }],
    [{ text: '📜 Entity History', callback_data: alertCallback('history', alertId) }, { text: '📈 Outcomes', callback_data: alertCallback('outcomes', alertId) }]
  ] };
}

function renderLegacy(data: AdaptiveAlert) {
  return { text: `📡 <b>FLOWRADAR SIGNAL</b>\n${DIVIDER}\n${h(pretty(data.alert.alertType))}\n\n⚪ Adaptive signal receipt unavailable for this legacy alert.`, keyboard: { inline_keyboard: [] } };
}
export function parseIntelligenceAlertCallback(value: string | undefined): { view: AdaptiveAlertView; alertId: string } | null {
  const parts = value?.split('|');
  if (parts?.length !== 3 || parts[0] !== 'ia' || !['summary', 'why', 'evidence', 'history', 'outcomes', 'path', 'risk'].includes(parts[1]!)) return null;
  return { view: parts[1] as AdaptiveAlertView, alertId: parts[2]! };
}
function alertCallback(view: AdaptiveAlertView, alertId: string) { return `ia|${view}|${alertId}`; }
function entitySummary(data: AdaptiveAlert) { return data.entities.slice(0, 3).map((entity) => `${h(entity.label)} · alpha ${Math.round(entity.historicalAlphaScore)} · evidence ${pct(entity.identityConfidence)}`); }
function snapshotWallets(value: unknown) { const wallets = record(value).wallets; return Array.isArray(wallets) ? wallets.map(record) : []; }
function summarizeEvidence(value: unknown) {
  const evidence = record(value).evidence;
  if (!Array.isArray(evidence) || !evidence.length) return 'unavailable';
  return evidence.slice(0, 4).map((item) => stringValue(record(item).type) ?? 'unknown').join(', ');
}
function summarizeCounterEvidence(value: unknown) {
  const contradictions = record(value).contradictions;
  const infrastructure = record(value).infrastructureExclusions;
  const count = (Array.isArray(contradictions) ? contradictions.length : 0) + (Array.isArray(infrastructure) ? infrastructure.length : 0);
  return count ? `${count} recorded limitation(s)` : 'none recorded';
}
function invalidationConditions(reasons: string[]) { const base = ['LP removal or liquidity collapse', 'sellability/ownership control risk', 'entity evidence invalidated or split']; if (reasons.some((row) => row.includes('holder'))) base.push('holder concentration deterioration'); return base; }
function pretty(value: string) { return value.replace(/([A-Z])/g, ' $1').replaceAll('_', ' ').trim(); }
function fmt(value: number | null) { return value === null ? 'n/a' : `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`; }
function pct(value: number) { return `${Math.round((value > 1 ? value / 100 : value) * 100)}%`; }
function short(value: string) { return value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value; }
function h(value: string) { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'); }
function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function stringValue(value: unknown) { return typeof value === 'string' ? value : null; }
function number(value: unknown) { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
function signalIcon(value: string) { if (value === 'BUY CANDIDATE' || value.includes('HIGH')) return '🔥'; if (value.includes('WATCH') || value.includes('OPPORTUNITY')) return '⚠️'; return '⚪'; }
function scoreIcon(value: number) { return value >= 80 ? '🟢' : value >= 55 ? '🟡' : '🔴'; }
