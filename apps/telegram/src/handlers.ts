import { OperatorService, type OperatorSessionState, type OperatorWorkflow, type ProfitableSort } from '@flowradar/db';
import { isAuthorized } from './auth';
import { callback, h, navKeyboard, renderBridges, renderFlows, renderProfitable, renderWallet, short } from './render';
import type { InlineKeyboard, TelegramApi, TelegramCallbackQuery, TelegramMessage, TelegramUpdate } from './types';

const COMMANDS = [
  { command: 'wallet', description: 'Wallet summary (Solana/EVM)' }, { command: 'token', description: 'Token + top-PnL wallets' },
  { command: 'profitable', description: 'Automatic profitable wallets' }, { command: 'entity', description: 'Entity and linked wallets' },
  { command: 'flow', description: 'Capital-flow history' }, { command: 'bridges', description: 'Official bridge history' },
  { command: 'watch', description: 'Persist a wallet/entity watch' }, { command: 'recent', description: 'Recent relevant events' }
];
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
  const { command, argument } = parseCommand(message.text ?? '');
  if (!command || command === 'start' || command === 'help') { await api.sendMessage(chatId, help()); return; }
  try {
    if (command === 'watch') {
      if (!argument) throw new Error('Usage: /watch &lt;wallet-or-entity&gt;');
      const watch = await service.watch(userId, chatId, argument);
      await api.sendMessage(chatId, `<b>Watch enabled</b>\n${h(watch.targetType)}: <code>${h(short(watch.targetKey, 10))}</code>\nNoise events are suppressed.`);
      return;
    }
    if (!argument && !['profitable', 'recent'].includes(command)) throw new Error(`Usage: /${command} &lt;address-or-entity&gt;`);
    const workflow = command as OperatorWorkflow;
    if (!['wallet', 'token', 'profitable', 'entity', 'flow', 'bridges', 'recent'].includes(workflow)) throw new Error('Unknown command. Use /start.');
    const state: OperatorSessionState = { target: argument || undefined, chain: 'ALL', sort: 'pnl', page: 1, pageSize: 10 };
    const session = await service.createSession(userId, chatId, workflow, state);
    const rendered = await renderWorkflow(service, workflow, state, session.id);
    await api.sendMessage(chatId, rendered.text, rendered.keyboard);
  } catch (error) { await api.sendMessage(chatId, `<b>Request failed</b>\n${h(error instanceof Error ? error.message : String(error))}`); }
}

async function handleCallback(service: OperatorService, api: TelegramApi, allowed: ReadonlySet<string>, query: TelegramCallbackQuery) {
  const chatId = query.message ? String(query.message.chat.id) : '';
  if (!isAuthorized(allowed, query.from.id) || !chatId) { await api.answerCallbackQuery(query.id, 'Unauthorized'); return; }
  const parsed = parseCallback(query.data);
  if (!parsed) { await api.answerCallbackQuery(query.id, 'Expired or invalid action'); return; }
  const session = await service.getSession(parsed.sessionId, String(query.from.id), chatId);
  if (!session) { await api.answerCallbackQuery(query.id, 'Session expired. Run the command again.'); return; }
  const state = session.stateJson as unknown as OperatorSessionState;
  try {
    if (parsed.action === 'export') {
      const format = parsed.value === 'csv' ? 'csv' : 'json';
      const file = await service.exportWorkflow(session.workflow as OperatorWorkflow, state, format);
      await api.sendDocument(chatId, file.filename, file.content, file.mimeType, 'FlowRadar bounded export');
      await api.answerCallbackQuery(query.id, 'Export sent');
      return;
    }
    if (parsed.action === 'watch') {
      await service.watch(String(query.from.id), chatId, state.target ?? '');
      await api.answerCallbackQuery(query.id, 'Watch enabled');
      return;
    }
    if (parsed.action === 'wallet') {
      const entity = await service.entity(state.target ?? '');
      const index = Math.max(0, Number(parsed.value) || 0);
      const address = entity.addresses?.[index]?.address;
      if (!address) throw new Error('Wallet is no longer available on this entity page');
      const childState: OperatorSessionState = { target: address, page: 1, pageSize: 10 };
      const child = await service.createSession(String(query.from.id), chatId, 'wallet', childState);
      const rendered = await renderWorkflow(service, 'wallet', childState, child.id);
      await api.editMessage(chatId, query.message!.message_id, rendered.text, rendered.keyboard);
      await api.answerCallbackQuery(query.id);
      return;
    }
    if (parsed.action === 'page') state.page = Math.max(1, Number(parsed.value) || 1);
    else if (parsed.action === 'sort') state.sort = parsed.value as ProfitableSort;
    else if (parsed.action === 'tokensort') state.tokenSort = parsed.value as OperatorSessionState['tokenSort'];
    else if (parsed.action === 'filter') state.chain = parsed.value as OperatorSessionState['chain'];
    else if (parsed.action === 'view') {
      const workflow = parsed.value as OperatorWorkflow;
      const next = await service.createSession(String(query.from.id), chatId, workflow, { ...state, page: 1 });
      const rendered = await renderWorkflow(service, workflow, { ...state, page: 1 }, next.id);
      await api.editMessage(chatId, query.message!.message_id, rendered.text, rendered.keyboard);
      await api.answerCallbackQuery(query.id);
      return;
    }
    await service.updateSession(session.id, String(query.from.id), chatId, state);
    const rendered = await renderWorkflow(service, session.workflow as OperatorWorkflow, state, session.id);
    await api.editMessage(chatId, query.message!.message_id, rendered.text, rendered.keyboard);
    await api.answerCallbackQuery(query.id);
  } catch (error) { await api.answerCallbackQuery(query.id, error instanceof Error ? error.message : 'Request failed'); }
}

async function renderWorkflow(service: OperatorService, workflow: OperatorWorkflow, state: OperatorSessionState, sessionId: string): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const page = state.page || 1; const size = state.pageSize || 10;
  if (workflow === 'wallet') {
    const value = await service.walletSummary(required(state));
    return { text: renderWallet(value), keyboard: navKeyboard(sessionId, 1, false, [[{ text: 'Capital flow', callback_data: callback('view', sessionId, 'flow') }, { text: 'Entity / alts', callback_data: callback('view', sessionId, 'entity') }], [{ text: 'Bridges', callback_data: callback('view', sessionId, 'bridges') }, { text: 'Watch wallet', callback_data: callback('watch', sessionId, 'on') }]]) };
  }
  if (workflow === 'token') {
    const value = await service.tokenSummary(required(state), page, size, state.tokenSort ?? 'pnl');
    const text = [`<b>Token</b> ${h(short(required(state), 9))}`, ...value.tokens.map((x) => `${h(x.chain)} <b>${h(x.symbol)}</b> ${h(x.name)} · mcap ${h(x.latestMcapUsd ?? 'n/a')}`), ...value.topPnl.items.map((x, i) => `${(page - 1) * size + i + 1}. ${h(x.chain)} <code>${h(short(x.walletAddress, 7))}</code> · local ${h(x.realizedPnlUsd ?? 'n/a')} · ${h(x.validation)}`), value.coverageWarnings.length ? `<i>Coverage:</i> ${value.coverageWarnings.map(h).join(' ')}` : ''].filter(Boolean).join('\n');
    return { text, keyboard: navKeyboard(sessionId, page, value.topPnl.hasNext, [[{ text: 'PnL', callback_data: callback('tokensort', sessionId, 'pnl') }, { text: 'ROI', callback_data: callback('tokensort', sessionId, 'roi') }, { text: 'Entry MC', callback_data: callback('tokensort', sessionId, 'entry_mcap') }], [{ text: 'Repeat', callback_data: callback('tokensort', sessionId, 'repeat_runners') }, { text: 'Dormancy', callback_data: callback('tokensort', sessionId, 'dormancy') }, { text: 'Confidence', callback_data: callback('tokensort', sessionId, 'confidence') }]]) };
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

function parseCommand(text: string) { const match = text.trim().match(/^\/([a-z_]+)(?:@[a-z0-9_]+)?(?:\s+([\s\S]+))?$/i); return { command: match?.[1]?.toLowerCase() ?? '', argument: match?.[2]?.trim() ?? '' }; }
function parseCallback(value: string | undefined) { const parts = value?.split('|'); return parts?.length === 4 && parts[0] === 'v1' ? { action: parts[1], sessionId: parts[2], value: parts[3] } : null; }
function required(state: OperatorSessionState) { if (!state.target) throw new Error('Target is required'); return state.target; }
function help() { return [`<b>FlowRadar operator</b>`, ...COMMANDS.map((x) => `/${x.command} — ${h(x.description)}`), '', 'Examples:', '<code>/wallet ADDRESS</code>', '<code>/token TOKEN_ADDRESS</code>', '<code>/profitable</code>'].join('\n'); }
