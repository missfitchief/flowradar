import { OperatorService, type OperatorSessionState, type OperatorWorkflow, type ProfitableSort, type WalletCapitalRelation, type WalletCapitalSummary } from '@flowradar/db';
import { isAuthorized } from './auth';
import { callback, exportKeyboard, h, navKeyboard, renderBridges, renderFlows, renderProfitable, short } from './render';
import type { InlineKeyboard, TelegramApi, TelegramCallbackQuery, TelegramMessage, TelegramUpdate } from './types';

const COMMANDS = [
  { command: 'wallet', description: 'Live capital tracing (Solana/EVM)' }, { command: 'token', description: 'Token + top-PnL wallets' },
  { command: 'profitable', description: 'Automatic profitable wallets' }, { command: 'entity', description: 'Entity and linked wallets' },
  { command: 'flow', description: 'Capital-flow history' }, { command: 'bridges', description: 'Official bridge history' },
  { command: 'watch', description: 'Persist a wallet/entity watch' }, { command: 'recent', description: 'Recent relevant events' },
  { command: 'cancel', description: 'Cancel pending input' }
];
const PENDING_PROMPTS: Partial<Record<OperatorWorkflow, string>> = {
  wallet: 'Pošalji wallet adresu.', token: 'Pošalji token CA.', entity: 'Pošalji wallet ili entity ID.',
  flow: 'Pošalji wallet ili entity.', bridges: 'Pošalji wallet ili entity.'
};
const EMPTY_KEYBOARD: InlineKeyboard = { inline_keyboard: [] };
export const TELEGRAM_COMMANDS = [{ command: 'start', description: 'FlowRadar operator menu' }, ...COMMANDS];

export function createUpdateHandler(service: OperatorService, api: TelegramApi, allowed: ReadonlySet<string>) {
  return async (update: TelegramUpdate) => {
    if (update.message) await handleMessage(service, api, allowed, update.message);
    else if (update.callback_query) await handleCallback(service, api, allowed, update.callback_query);
  };
}

async function handleMessage(service: OperatorService, api: TelegramApi, allowed: ReadonlySet<string>, message: TelegramMessage) {
  const chatId = String(message.chat.id);
  if (!isAuthorized(allowed, message.from?.id)) { await api.sendMessage(chatId, '<b>Unauthorized.</b>'); return; }
  const userId = String(message.from!.id);
  const text = (message.text ?? '').trim();
  const { command, argument } = parseCommand(text);

  if (command === 'cancel') {
    await service.clearPendingSession(userId, chatId);
    await api.sendMessage(chatId, 'Otkazano.');
    return;
  }
  if (command === 'start' || command === 'help') {
    await service.clearPendingSession(userId, chatId);
    await api.sendMessage(chatId, help());
    return;
  }
  if (command) {
    try {
      if (command === 'watch') {
        if (!argument) throw new Error('Pošalji wallet ili entity ID.');
        const watch = await service.watch(userId, chatId, argument);
        await api.sendMessage(chatId, `<b>Watch enabled</b>\n${h(watch.targetType)}: <code>${h(short(watch.targetKey, 10))}</code>\nNoise events are suppressed.`);
        return;
      }
      if (!['wallet', 'token', 'profitable', 'entity', 'flow', 'bridges', 'recent'].includes(command)) throw new Error('Unknown command. Use /start.');
      const workflow = command as OperatorWorkflow;
      if (!argument && PENDING_PROMPTS[workflow]) {
        const pending = await service.setPendingSession(userId, chatId, workflow, 10);
        await api.sendMessage(chatId, PENDING_PROMPTS[workflow]!, pendingKeyboard(pending.id));
        return;
      }
      if (argument && !(await service.validateWorkflowTarget(workflow, argument))) {
        await api.sendMessage(chatId, invalidTargetMessage(workflow));
        return;
      }
      await service.clearPendingSession(userId, chatId);
      await sendWorkflow(service, api, userId, chatId, workflow, argument || undefined);
    } catch (error) {
      await api.sendMessage(chatId, `<b>Request failed</b>\n${h(error instanceof Error ? error.message : String(error))}`);
    }
    return;
  }

  if (!text) { await api.sendMessage(chatId, help()); return; }
  try {
    const pending = await service.getPendingSession(userId, chatId);
    if (pending) {
      if (!(await service.validateWorkflowTarget(pending.workflow, text))) {
        await api.sendMessage(chatId, invalidTargetMessage(pending.workflow), pendingKeyboard(pending.session.id));
        return;
      }
      await service.clearPendingSession(userId, chatId);
      await sendWorkflow(service, api, userId, chatId, pending.workflow, text);
      return;
    }

    const classification = await service.classifyAddressInput(text);
    if (classification === 'wallet' || classification === 'token') {
      await sendWorkflow(service, api, userId, chatId, classification, text);
      return;
    }
    if (classification === 'ambiguous') {
      const session = await service.createSession(userId, chatId, 'wallet', defaultState(text));
      await api.sendMessage(chatId, 'Adresa može biti wallet ili token. Kako želiš da je analiziram?', {
        inline_keyboard: [[
          { text: 'Analiziraj kao wallet', callback_data: callback('choose', session.id, 'wallet') },
          { text: 'Analiziraj kao token', callback_data: callback('choose', session.id, 'token') }
        ], [{ text: 'Back', callback_data: callback('cancel', session.id, 'input') }]]
      });
      return;
    }
    await api.sendMessage(chatId, 'Adresa nije prepoznata. Pošalji validnu Solana ili EVM adresu, ili izaberi komandu iz /start.');
  } catch (error) {
    await api.sendMessage(chatId, `<b>Request failed</b>\n${h(error instanceof Error ? error.message : String(error))}`);
  }
}

async function handleCallback(service: OperatorService, api: TelegramApi, allowed: ReadonlySet<string>, query: TelegramCallbackQuery) {
  const chatId = query.message ? String(query.message.chat.id) : '';
  if (!isAuthorized(allowed, query.from.id) || !chatId) { await api.answerCallbackQuery(query.id, 'Unauthorized'); return; }
  const userId = String(query.from.id);
  const parsed = parseCallback(query.data);
  if (!parsed) { await api.answerCallbackQuery(query.id, 'Expired or invalid action'); return; }
  await service.clearPendingSession(userId, chatId);
  if (parsed.action === 'cancel') {
    await editIfChanged(api, query, 'Otkazano.', EMPTY_KEYBOARD);
    await api.answerCallbackQuery(query.id, 'Otkazano');
    return;
  }
  const session = await service.getSession(parsed.sessionId, userId, chatId);
  if (!session) { await api.answerCallbackQuery(query.id, 'Session expired. Run the command again.'); return; }
  const state = session.stateJson as unknown as OperatorSessionState;
  try {
    if (parsed.action === 'choose') {
      const workflow = parsed.value === 'token' ? 'token' : 'wallet';
      const next = await service.createSession(userId, chatId, workflow, { ...state, page: 1 });
      if (workflow === 'wallet') {
        await api.answerCallbackQuery(query.id, 'Capital tracing started');
        await runWalletWorkflow(service, api, userId, chatId, required({ ...state, page: 1 }), query);
        return;
      }
      const rendered = await renderWorkflow(service, workflow, { ...state, page: 1 }, next.id);
      await editIfChanged(api, query, rendered.text, rendered.keyboard);
      await api.answerCallbackQuery(query.id);
      return;
    }
    if (parsed.action === 'exportmenu') {
      await editIfChanged(api, query, `${h(query.message?.text ?? 'FlowRadar rezultat')}\n\n<b>Izvoz</b>\nIzaberi format.`, exportKeyboard(session.id));
      await api.answerCallbackQuery(query.id);
      return;
    }
    if (parsed.action === 'export') {
      const format = parsed.value === 'csv' ? 'csv' : 'json';
      const file = await service.exportWorkflow(session.workflow as OperatorWorkflow, state, format);
      await api.sendDocument(chatId, file.filename, file.content, file.mimeType, 'FlowRadar bounded export');
      await api.answerCallbackQuery(query.id, 'Export sent');
      return;
    }
    if (parsed.action === 'deepscan') {
      await service.queueDeeperTokenScan(state.target ?? '');
      await api.answerCallbackQuery(query.id, 'Dublji scan je stavljen u red');
      return;
    }
    if (parsed.action === 'watch') {
      await service.watch(userId, chatId, state.target ?? '');
      await api.answerCallbackQuery(query.id, 'Watch enabled');
      return;
    }
    if (parsed.action === 'wallet') {
      const entity = await service.entity(state.target ?? '');
      const index = Math.max(0, Number(parsed.value) || 0);
      const address = entity.addresses?.[index]?.address;
      if (!address) throw new Error('Wallet is no longer available on this entity page');
      const childState = defaultState(address);
      const child = await service.createSession(userId, chatId, 'wallet', childState);
      void child;
      await api.answerCallbackQuery(query.id, 'Capital tracing started');
      await runWalletWorkflow(service, api, userId, chatId, address, query);
      return;
    }
    if (parsed.action === 'page') state.page = Math.max(1, Number(parsed.value) || 1);
    else if (parsed.action === 'sort') state.sort = parsed.value as ProfitableSort;
    else if (parsed.action === 'tokensort') state.tokenSort = parsed.value as OperatorSessionState['tokenSort'];
    else if (parsed.action === 'filter') state.chain = parsed.value as OperatorSessionState['chain'];
    else if (parsed.action === 'view') {
      const workflow = parsed.value as OperatorWorkflow;
      const next = await service.createSession(userId, chatId, workflow, { ...state, page: 1 });
      if (workflow === 'wallet') {
        await api.answerCallbackQuery(query.id, 'Capital tracing started');
        await runWalletWorkflow(service, api, userId, chatId, required({ ...state, page: 1 }), query);
        return;
      }
      const rendered = await renderWorkflow(service, workflow, { ...state, page: 1 }, next.id);
      await editIfChanged(api, query, rendered.text, rendered.keyboard);
      await api.answerCallbackQuery(query.id);
      return;
    }
    await service.updateSession(session.id, userId, chatId, state);
    const rendered = await renderWorkflow(service, session.workflow as OperatorWorkflow, state, session.id);
    await editIfChanged(api, query, rendered.text, rendered.keyboard);
    await api.answerCallbackQuery(query.id);
  } catch (error) {
    await api.answerCallbackQuery(query.id, error instanceof Error ? error.message : 'Request failed');
  }
}

async function sendWorkflow(service: OperatorService, api: TelegramApi, userId: string, chatId: string, workflow: OperatorWorkflow, target?: string) {
  const state = defaultState(target);
  const session = await service.createSession(userId, chatId, workflow, state);
  if (workflow === 'wallet') {
    await runWalletWorkflow(service, api, userId, chatId, required(state));
    return;
  }
  const rendered = await renderWorkflow(service, workflow, state, session.id);
  await api.sendMessage(chatId, rendered.text, rendered.keyboard);
}

async function renderWorkflow(service: OperatorService, workflow: OperatorWorkflow, state: OperatorSessionState, sessionId: string): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const page = state.page || 1; const size = state.pageSize || 10;
  if (workflow === 'wallet') {
    const messages = renderWalletCapitalMessages(await service.walletCapitalSummary(required(state)));
    return messages[0];
  }
  if (workflow === 'token') {
    const tokenAddress = required(state);
    await service.scanTokenTopPnl(tokenAddress);
    const value = await service.tokenSummary(tokenAddress, 1, 10, 'pnl');
    const rows = value.topPnl.items.slice(0, 10) as TokenPnlTelegramRow[];
    if (!rows.length) return { text: 'Nije pronađen nijedan top-PnL wallet za ovaj token.', keyboard: EMPTY_KEYBOARD };
    return {
      text: [`<b>TOP 10 PNL WALLETS — ${h(tokenAddress)}</b>`, ...rows.map(renderTokenPnlWallet)].join('\n\n'),
      keyboard: tokenPnlKeyboard(rows)
    };
  }
  if (workflow === 'profitable') {
    const value = await service.profitable({ chain: state.chain, sort: state.sort, page, pageSize: size });
    return { text: renderProfitable(value), keyboard: navKeyboard(sessionId, page, value.hasNext, [[{ text: 'PnL', callback_data: callback('sort', sessionId, 'pnl') }, { text: 'WR', callback_data: callback('sort', sessionId, 'win_rate') }, { text: 'EV', callback_data: callback('sort', sessionId, 'ev') }], [{ text: 'SOL', callback_data: callback('filter', sessionId, 'SOLANA') }, { text: 'ETH', callback_data: callback('filter', sessionId, 'ETHEREUM') }, { text: 'Base', callback_data: callback('filter', sessionId, 'BASE') }], [{ text: 'ARB', callback_data: callback('filter', sessionId, 'ARBITRUM') }, { text: 'BSC', callback_data: callback('filter', sessionId, 'BSC') }, { text: 'All', callback_data: callback('filter', sessionId, 'ALL') }]]) };
  }
  if (workflow === 'entity') {
    const value = await service.entity(required(state));
    const entityPageSize = 6;
    const start = (page - 1) * entityPageSize;
    const addresses = (value.addresses ?? []).slice(start, start + entityPageSize);
    const text = [`<b>Entity ${h(value.entityKey ?? 'not found')}</b> · page ${page}`, ...addresses.map((x: { chain: string; address: string; role: string; confidence: number }) => `${h(x.chain)} <code>${h(short(x.address, 7))}</code> · ${h(x.role)} ${Math.round(x.confidence * 100)}%`), value.metrics ? `W/L/U ${value.metrics.winCount}/${value.metrics.lossCount}/${value.metrics.unresolvedPositions} · EV ${h(value.metrics.evUsd ?? 'n/a')}` : '', ...(value.coverageWarnings ?? []).map((x: string) => `<i>${h(x)}</i>`)].filter(Boolean).join('\n');
    const walletButtons = addresses.map((x: { address: string }, index: number) => [{ text: `Wallet ${short(x.address, 5)}`, callback_data: callback('wallet', sessionId, String(start + index)) }]);
    return { text, keyboard: navKeyboard(sessionId, page, start + addresses.length < (value.addresses?.length ?? 0), [...walletButtons, [{ text: 'Capital flow', callback_data: callback('view', sessionId, 'flow') }, { text: 'Bridges', callback_data: callback('view', sessionId, 'bridges') }], [{ text: 'Watch entity', callback_data: callback('watch', sessionId, 'on') }]]) };
  }
  if (workflow === 'flow') { const value = await service.flows(required(state), page, size); return { text: renderFlows(value), keyboard: navKeyboard(sessionId, page, value.hasNext) }; }
  if (workflow === 'bridges') { const value = await service.bridges(required(state), page, size); return { text: renderBridges(value), keyboard: navKeyboard(sessionId, page, value.hasNext) }; }
  const value = await service.recent(page, size);
  const text = [`<b>Recent relevant events</b> · page ${page} · ${value.total} total`, ...value.items.map((x) => `${h(x.chain)} <b>${h(x.kind)}</b> ${h(short(x.source))}→${h(short(x.destination))} · ${h(x.amountUsd ?? 'n/a')} · score ${h(x.score)}`)].join('\n');
  return { text, keyboard: navKeyboard(sessionId, page, value.hasNext) };
}

async function runWalletWorkflow(
  service: OperatorService,
  api: TelegramApi,
  userId: string,
  chatId: string,
  address: string,
  query?: TelegramCallbackQuery
) {
  await service.scanWalletCapital(address);
  const summary = await service.walletCapitalSummary(address);
  await service.watch(userId, chatId, address);
  const messages = renderWalletCapitalMessages(summary);
  if (query) {
    await editIfChanged(api, query, messages[0].text, messages[0].keyboard);
    for (const message of messages.slice(1)) { await telegramPace(); await api.sendMessage(chatId, message.text, message.keyboard); }
    return;
  }
  for (const [index, message] of messages.entries()) { if (index) await telegramPace(); await api.sendMessage(chatId, message.text, message.keyboard); }
}

function renderWalletCapitalMessages(summary: WalletCapitalSummary): Array<{ text: string; keyboard: InlineKeyboard }> {
  const group = (title: string, rows: WalletCapitalRelation[], limit: number, compact?: 'role' | 'token') => ({ title, total: rows.length, rows: prioritizeRelations(rows).slice(0, limit), compact });
  const groups: Array<{ title: string; total: number; rows: WalletCapitalRelation[]; compact?: 'role' | 'token' }> = [
    group('Direct receivers', summary.relations.filter((row) => row.route === 'direct_transfer'), 100),
    group('Bridge destinations', summary.relations.filter((row) => row.route === 'exact_bridge' || row.route === 'bridge_inference'), 100),
    group('Multi-hop receivers', summary.relations.filter((row) => row.route === 'multi_hop_transfer'), 40),
    group('Probable alt/execution wallets', summary.relations.filter((row) => /execution|side|profit_collection/.test(row.role)), 10, 'role'),
    group('Possible CEX-linked wallets', summary.relations.filter((row) => row.route === 'cex_correlation'), 50),
    group('Token deployments', summary.relations.filter((row) => row.tokens.length > 0), 20, 'token')
  ];
  const messages: Array<{ text: string; keyboard: InlineKeyboard }> = [];
  let first = true;
  for (const group of groups) {
    if (!group.rows.length) continue;
    const renderer = group.compact === 'role' ? renderRoleIndex : group.compact === 'token' ? renderTokenIndex : renderCapitalRelation;
    for (const rows of relationChunks(group.rows, renderer)) {
      const bounded = group.total > group.rows.length ? `Showing ${group.rows.length} highest-relevance routes of ${group.total}; every route is persisted and monitored.` : '';
      const header = first
        ? [`<b>WALLET CAPITAL TRACE</b>`, `<code>${h(summary.address)}</code>`, `Chains scanned: ${h(summary.scannedChains.join(', '))}`, summary.entityKey ? `Cluster: <code>${h(summary.entityKey)}</code>` : '', '', `<b>${h(group.title)}</b>`, bounded]
        : [`<b>${h(group.title)}</b>`, bounded];
      messages.push({
        text: [...header.filter(Boolean), ...rows.map(renderer)].join('\n\n'),
        keyboard: capitalRelationKeyboard(rows)
      });
      first = false;
    }
  }
  if (!messages.length) {
    messages.push({
      text: [`<b>WALLET CAPITAL TRACE</b>`, `<code>${h(summary.address)}</code>`, `Chains scanned: ${h(summary.scannedChains.join(', '))}`, '', 'Realni scan nije pronašao relevantan wallet-to-receiver kapitalni tok.'].join('\n'),
      keyboard: EMPTY_KEYBOARD
    });
  }
  return messages;
}

function prioritizeRelations(rows: WalletCapitalRelation[]) {
  return [...rows].sort((a, b) => Number(b.tokens.length > 0) - Number(a.tokens.length > 0)
    || Number(b.safeEntityLink) - Number(a.safeEntityLink)
    || b.confidence - a.confidence
    || new Date(b.lastTransferTs).getTime() - new Date(a.lastTransferTs).getTime()
    || a.address.localeCompare(b.address));
}

function renderCapitalRelation(row: WalletCapitalRelation) {
  const amount = row.amountUsd != null ? plainMoney(row.amountUsd)
    : row.amount ? `${h(row.amount)} ${h(row.amountSymbol ?? '')}`.trim() : 'n/a';
  const tokens = row.tokens.length
    ? row.tokens.slice(0, 8).map((token) => `${h(token.symbol ?? 'token')} <code>${h(token.address)}</code>${token.fundingToBuyDelaySec == null ? '' : ` (${duration(token.fundingToBuyDelaySec)} after funding)`}`).join('\n')
    : 'none observed after funding';
  const remainingTokens = row.tokens.length > 8 ? `\n+${row.tokens.length - 8} additional observed tokens` : '';
  const sourceTx = row.sourceTxHash
    ? row.sourceTxUrl ? `<a href="${h(row.sourceTxUrl)}">${h(row.sourceTxHash)}</a>` : `<code>${h(row.sourceTxHash)}</code>`
    : 'n/a';
  const status = row.fresh ? 'fresh' : row.dormant ? 'dormant' : 'active history';
  return [
    `<code>${h(row.address)}</code>`,
    `${h(row.chain)} · ${h(routeLabel(row.route, row.hops))} · role ${h(row.role)}`,
    `Amount: ${amount}`,
    `Source transaction: ${sourceTx}`,
    `First / last transfer: ${h(row.firstTransferTs)} / ${h(row.lastTransferTs)}`,
    `Tokens bought after funding:\n${tokens}${remainingTokens}`,
    `Profit / rotation: ${row.rotations.length ? row.rotations.map(h).join(', ') : 'none observed'}`,
    `Receiver: ${status} · confidence ${Math.round(row.confidence * 100)}%${row.safeEntityLink ? ' · evidence-backed cluster link' : ' · observation only'}`
  ].join('\n');
}

function renderRoleIndex(row: WalletCapitalRelation) {
  return [`<code>${h(row.address)}</code>`, `${h(row.chain)} · ${h(row.role)} · ${h(routeLabel(row.route, row.hops))} · confidence ${Math.round(row.confidence * 100)}%`].join('\n');
}

function renderTokenIndex(row: WalletCapitalRelation) {
  return [
    `<code>${h(row.address)}</code> · ${h(row.chain)}`,
    ...row.tokens.slice(0, 8).map((token) => `${h(token.symbol ?? 'token')} <code>${h(token.address)}</code>${token.fundingToBuyDelaySec == null ? '' : ` · funding→buy ${duration(token.fundingToBuyDelaySec)}`}`)
  ].join('\n');
}

function capitalRelationKeyboard(rows: WalletCapitalRelation[]): InlineKeyboard {
  return { inline_keyboard: rows.map((row) => [
    { text: `Copy ${short(row.address, 4)}`, copy_text: { text: row.address } },
    { text: 'Explorer', url: walletExplorer(row.chain, row.address) }
  ]) };
}

function routeLabel(route: WalletCapitalRelation['route'], hops: number) {
  if (route === 'direct_transfer') return 'direct';
  if (route === 'multi_hop_transfer') return `multi-hop (${hops})`;
  if (route === 'exact_bridge') return 'exact bridge';
  if (route === 'bridge_inference') return 'bridge inference';
  return 'possible CEX (unconfirmed)';
}
function duration(seconds: number) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.round(seconds / 3_600)}h`;
  return `${Math.round(seconds / 86_400)}d`;
}
function relationChunks(rows: WalletCapitalRelation[], renderer: (row: WalletCapitalRelation) => string) {
  const result: WalletCapitalRelation[][] = [];
  let current: WalletCapitalRelation[] = [];
  let length = 0;
  for (const row of rows) {
    const rowLength = renderer(row).length + 2;
    if (current.length && length + rowLength > 3_200) { result.push(current); current = []; length = 0; }
    current.push(row); length += rowLength;
  }
  if (current.length) result.push(current);
  return result;
}
function telegramPace() { return new Promise<void>((resolve) => setTimeout(resolve, 1_050)); }

async function editIfChanged(api: TelegramApi, query: TelegramCallbackQuery, text: string, keyboard: InlineKeyboard) {
  if (!query.message) return;
  const sameText = query.message.text === htmlToPlain(text);
  const sameKeyboard = JSON.stringify(query.message.reply_markup ?? null) === JSON.stringify(keyboard);
  if (sameText && sameKeyboard) return;
  await api.editMessage(String(query.message.chat.id), query.message.message_id, text, keyboard);
}

function htmlToPlain(value: string) {
  return value.replace(/<[^>]+>/g, '').replaceAll('&quot;', '"').replaceAll('&gt;', '>').replaceAll('&lt;', '<').replaceAll('&amp;', '&');
}
function pendingKeyboard(sessionId: string): InlineKeyboard { return { inline_keyboard: [[{ text: 'Back', callback_data: callback('cancel', sessionId, 'pending') }]] }; }
function defaultState(target?: string): OperatorSessionState { return { target, chain: 'ALL', sort: 'pnl', page: 1, pageSize: 10 }; }
function invalidTargetMessage(workflow: OperatorWorkflow) {
  if (workflow === 'token') return 'Token CA nije validan. Pošalji validan token CA.';
  if (workflow === 'wallet') return 'Wallet adresa nije validna. Pošalji validnu wallet adresu.';
  return 'Vrednost nije validna. Pošalji validan wallet ili postojeći entity ID.';
}
interface TokenPnlTelegramRow {
  chain: string;
  walletAddress: string;
  realizedPnlUsd: number | null;
  roi: number | null;
  boughtUsd: number | null;
  soldUsd: number | null;
  remainingPositionUsd: number | null;
  firstBuyTs: string | null;
  dormancy: { days7: boolean | null; days14: boolean | null; days30: boolean | null; days90: boolean | null } | null;
  validation: string;
}
function renderTokenPnlWallet(row: TokenPnlTelegramRow, index: number) {
  const dormancy = row.dormancy && Object.values(row.dormancy).some((value) => value !== null)
    ? `Dormancy 7d/14d/30d/90d: ${dormancyFlag(row.dormancy.days7)}/${dormancyFlag(row.dormancy.days14)}/${dormancyFlag(row.dormancy.days30)}/${dormancyFlag(row.dormancy.days90)}`
    : null;
  return [
    `${index + 1}. <b>${signedMoney(row.realizedPnlUsd)} PnL · ${roi(row.roi)} ROI</b>`,
    `<code>${h(row.walletAddress)}</code>`,
    `Bought ${plainMoney(row.boughtUsd)} · Sold ${plainMoney(row.soldUsd)} · Remaining ${plainMoney(row.remainingPositionUsd)}`,
    `Entry ${h(row.firstBuyTs ?? 'n/a')}`,
    dormancy,
    `Validation: ${h(tokenValidation(row.validation))}`
  ].filter(Boolean).join('\n');
}

function tokenValidation(value: string) {
  if (value === 'locally_verified') return 'locally verified';
  if (value === 'provider_only') return 'provider only';
  return 'incomplete';
}
function tokenPnlKeyboard(rows: TokenPnlTelegramRow[]): InlineKeyboard {
  return { inline_keyboard: rows.map((row) => [
    { text: 'Copy wallet', copy_text: { text: row.walletAddress } },
    { text: 'Explorer', url: walletExplorer(row.chain, row.walletAddress) }
  ]) };
}
function walletExplorer(chain: string, address: string) {
  const base = chain === 'SOLANA' ? 'https://solscan.io/account/'
    : chain === 'ETHEREUM' ? 'https://etherscan.io/address/'
    : chain === 'BASE' ? 'https://basescan.org/address/'
    : chain === 'ARBITRUM' ? 'https://arbiscan.io/address/'
    : 'https://bscscan.com/address/';
  return `${base}${encodeURIComponent(address)}`;
}
function plainMoney(value: number | null) { return value == null ? 'n/a' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value); }
function signedMoney(value: number | null) { if (value == null) return 'n/a'; return `${value >= 0 ? '+' : '-'}${plainMoney(Math.abs(value))}`; }
function roi(value: number | null) { return value == null ? 'n/a' : `${Math.round(value * 100).toLocaleString('en-US')}%`; }
function dormancyFlag(value: boolean | null) { return value == null ? '?' : value ? 'yes' : 'no'; }
function parseCommand(text: string) { const match = text.trim().match(/^\/([a-z_]+)(?:@[a-z0-9_]+)?(?:\s+([\s\S]+))?$/i); return { command: match?.[1]?.toLowerCase() ?? '', argument: match?.[2]?.trim() ?? '' }; }
function parseCallback(value: string | undefined) { const parts = value?.split('|'); return parts?.length === 4 && parts[0] === 'v1' ? { action: parts[1], sessionId: parts[2], value: parts[3] } : null; }
function required(state: OperatorSessionState) { if (!state.target) throw new Error('Target is required'); return state.target; }
function help() { return [`<b>FlowRadar operator</b>`, ...COMMANDS.map((x) => `/${x.command} — ${h(x.description)}`), '', 'Izaberi komandu; bot će zatim tražiti potrebnu adresu.', '<code>/wallet</code>', '<code>/token</code>', '<code>/profitable</code>'].join('\n'); }
