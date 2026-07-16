import {
  OperatorService,
  type AlertInboxFilter,
  type CoreWalletListItem,
  type InvestigationDeployment,
  type InvestigationMember,
  type InvestigationPath,
  type OperatorSessionState,
  type OperatorWorkflow,
  type ProfitableSort,
  type WalletInvestigationResult
} from '@flowradar/db';
import { isAuthorized } from './auth';
import { parseCoreAlertCallback, renderCoreMonitoringAlert } from './coreAlertRenderer';
import { renderInvestigationReport, renderRefreshFailure, renderRefreshProgress } from './investigationRenderer';
import { parseIntelligenceAlertCallback, renderIntelligenceAlert } from './intelligenceAlertRenderer';
import { callback, exportKeyboard, h, navKeyboard, renderProfitable, short } from './render';
import type { InlineKeyboard, TelegramApi, TelegramCallbackQuery, TelegramMessage, TelegramUpdate } from './types';

const COMMANDS = [
  { command: 'list', description: 'Core wallet monitoring' }, { command: 'add', description: 'Add a Core wallet' },
  { command: 'remove', description: 'Remove a Core wallet' },
  { command: 'alerts', description: 'Production alert inbox' },
  { command: 'wallet', description: 'Unified wallet investigation' }, { command: 'token', description: 'Token + top-PnL wallets' },
  { command: 'profitable', description: 'Automatic profitable wallets' }, { command: 'entity', description: 'Investigation cluster wallets' },
  { command: 'flow', description: 'Investigation capital paths' }, { command: 'bridges', description: 'Verified investigation bridges' },
  { command: 'watch', description: 'Persist a wallet/entity watch' }, { command: 'recent', description: 'Recent relevant events' },
  { command: 'cancel', description: 'Cancel pending input' }
];
const PENDING_PROMPTS: Partial<Record<OperatorWorkflow, string>> = {
  wallet: '👛 <b>WALLET INVESTIGATION</b>\n━━━━━━━━━━━━━━━━━━━━\nSend a wallet address.\n<i>Solana or EVM · this prompt expires in 10 minutes.</i>',
  token: '🎯 <b>TOKEN INTELLIGENCE</b>\n━━━━━━━━━━━━━━━━━━━━\nSend a token contract address.\n<i>FlowRadar will run a live top-PnL scan.</i>',
  entity: '🧠 <b>ENTITY INTELLIGENCE</b>\n━━━━━━━━━━━━━━━━━━━━\nSend a wallet address or entity ID.',
  flow: '💸 <b>CAPITAL PATHS</b>\n━━━━━━━━━━━━━━━━━━━━\nSend a wallet address or entity ID.',
  bridges: '🌉 <b>BRIDGE INTELLIGENCE</b>\n━━━━━━━━━━━━━━━━━━━━\nSend a wallet address or entity ID.',
  core_add: '➕ <b>ADD CORE WALLET</b>\n━━━━━━━━━━━━━━━━━━━━\nSend a Solana or EVM wallet address.\n<i>Monitoring starts immediately; historical sync runs in the background.</i>',
  core_remove: '➖ <b>REMOVE CORE WALLET</b>\n━━━━━━━━━━━━━━━━━━━━\nSend the wallet address to remove from Core monitoring.\n<i>Saved history remains available.</i>'
};
const INVESTIGATION_WORKFLOWS = new Set<OperatorWorkflow>(['wallet', 'entity', 'flow', 'bridges']);
const EMPTY_KEYBOARD: InlineKeyboard = { inline_keyboard: [] };
const activeWalletInvestigationJobs = new Map<string, Promise<void>>();
const activeWalletRefreshJobs = new Map<string, Promise<void>>();
const TOKEN_ANALYSIS_TIMEOUT_MS = 120_000;
export const TELEGRAM_COMMANDS = [{ command: 'start', description: 'FlowRadar operator menu' }, ...COMMANDS];

export function createUpdateHandler(service: OperatorService, api: TelegramApi, allowed: ReadonlySet<string>) {
  return async (update: TelegramUpdate) => {
    if (update.message) await handleMessage(service, api, allowed, update.message);
    else if (update.callback_query) await handleCallback(service, api, allowed, update.callback_query);
  };
}

async function handleMessage(service: OperatorService, api: TelegramApi, allowed: ReadonlySet<string>, message: TelegramMessage) {
  const chatId = String(message.chat.id);
  if (!isAuthorized(allowed, message.from?.id)) { await api.sendMessage(chatId, '🔴 <b>ACCESS DENIED</b>'); return; }
  const userId = String(message.from!.id);
  const text = (message.text ?? '').trim();
  const { command, argument } = parseCommand(text);

  if (command === 'cancel') {
    await service.clearPendingSession(userId, chatId);
    await api.sendMessage(chatId, '✓ <b>Action cancelled.</b>');
    return;
  }
  if (command === 'start' || command === 'help') {
    await service.clearPendingSession(userId, chatId);
    await api.sendMessage(chatId, help());
    return;
  }
  if (command) {
    try {
      if (command === 'list') {
        await service.clearPendingSession(userId, chatId);
        await sendCorePanel(service, api, userId, chatId);
        return;
      }
      if (command === 'alerts') {
        await service.clearPendingSession(userId, chatId);
        await sendAlertInbox(service, api, userId, chatId);
        return;
      }
      if (command === 'add' || command === 'remove') {
        const pendingWorkflow: OperatorWorkflow = command === 'add' ? 'core_add' : 'core_remove';
        if (!argument) {
          const pending = await service.setPendingSession(userId, chatId, pendingWorkflow, 10);
          await api.sendMessage(chatId, PENDING_PROMPTS[pendingWorkflow]!, pendingKeyboard(pending.id));
          return;
        }
        if (!(await service.validateWorkflowTarget(pendingWorkflow, argument))) {
          await api.sendMessage(chatId, invalidTargetMessage(pendingWorkflow));
          return;
        }
        await service.clearPendingSession(userId, chatId);
        if (command === 'add') await addCoreAndQueue(service, api, userId, chatId, argument);
        else await removeCore(service, api, userId, chatId, argument);
        return;
      }
      if (command === 'watch') {
        if (!argument) throw new Error('Send a wallet address or entity ID.');
        const watch = await service.watch(userId, chatId, argument);
        await api.sendMessage(chatId, [
          '✅ <b>MONITORING ENABLED</b>', '━━━━━━━━━━━━━━━━━━━━',
          `Target  <code>${h(watch.targetKey)}</code>`,
          `Type  <b>${h(watch.targetType)}</b>`,
          '', '👁 Funding · buys · bridges · dormant wake-ups',
          '<i>Low-value infrastructure noise remains suppressed.</i>'
        ].join('\n'));
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
      await api.sendMessage(chatId, requestFailure(error));
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
      if (pending.workflow === 'core_add' || pending.workflow === 'core_remove') {
        await service.clearPendingSession(userId, chatId);
        if (pending.workflow === 'core_add') await addCoreAndQueue(service, api, userId, chatId, text);
        else await removeCore(service, api, userId, chatId, text);
        return;
      }
      if (pending.workflow !== 'wallet') await service.clearPendingSession(userId, chatId);
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
      await api.sendMessage(chatId, '🧭 <b>ADDRESS DETECTED</b>\n━━━━━━━━━━━━━━━━━━━━\nThis address may be a wallet or a token. Choose an analysis:', {
        inline_keyboard: [[
          { text: 'Analyze as wallet', callback_data: callback('choose', session.id, 'wallet') },
          { text: 'Analyze as token', callback_data: callback('choose', session.id, 'token') }
        ], [{ text: '← Cancel', callback_data: callback('cancel', session.id, 'input') }]]
      });
      return;
    }
    await api.sendMessage(chatId, '🔴 <b>ADDRESS NOT RECOGNIZED</b>\n━━━━━━━━━━━━━━━━━━━━\nSend a valid Solana or EVM address, or open <code>/start</code>.');
  } catch (error) {
    await api.sendMessage(chatId, requestFailure(error));
  }
}

async function handleCallback(service: OperatorService, api: TelegramApi, allowed: ReadonlySet<string>, query: TelegramCallbackQuery) {
  const chatId = query.message ? String(query.message.chat.id) : '';
  if (!isAuthorized(allowed, query.from.id) || !chatId) { await api.answerCallbackQuery(query.id, 'Unauthorized'); return; }
  const userId = String(query.from.id);
  const coreAlertAction = parseCoreAlertCallback(query.data);
  if (coreAlertAction) {
    const alert = await service.coreMonitoringAlert(coreAlertAction.alertId, userId, chatId);
    if (!alert) { await api.answerCallbackQuery(query.id, 'Alert is no longer available.'); return; }
    const rendered = renderCoreMonitoringAlert(alert, coreAlertAction.view);
    await editIfChanged(api, query, rendered.text, rendered.keyboard);
    await api.answerCallbackQuery(query.id);
    return;
  }
  const alertAction = parseIntelligenceAlertCallback(query.data);
  if (alertAction) {
    const alert = await service.intelligenceAlert(alertAction.alertId);
    if (!alert) { await api.answerCallbackQuery(query.id, 'Alert is no longer available.'); return; }
    const rendered = renderIntelligenceAlert(alert, alertAction.view);
    await editIfChanged(api, query, rendered.text, rendered.keyboard);
    await api.answerCallbackQuery(query.id);
    return;
  }
  const parsed = parseCallback(query.data);
  if (!parsed) { await api.answerCallbackQuery(query.id, 'Expired or invalid action'); return; }
  await service.clearPendingSession(userId, chatId);
  if (parsed.action === 'cancel') {
    await editIfChanged(api, query, '✓ <b>Action cancelled.</b>', EMPTY_KEYBOARD);
    await api.answerCallbackQuery(query.id, 'Cancelled');
    return;
  }
  const session = await service.getSession(parsed.sessionId, userId, chatId);
  if (!session) { await api.answerCallbackQuery(query.id, 'Session expired. Run the command again.'); return; }
  const state = session.stateJson as unknown as OperatorSessionState;
  try {
    if (session.workflow === 'alerts') {
      if (parsed.action === 'alertfilter') {
        state.alertFilter = alertFilter(parsed.value);
        state.page = 1;
      } else if (parsed.action === 'page') {
        state.page = Math.max(1, Number(parsed.value) || 1);
      } else {
        throw new Error('This alert action has expired.');
      }
      await service.updateSession(session.id, userId, chatId, state);
      const rendered = await renderAlertInbox(service, userId, chatId, state, session.id);
      await editIfChanged(api, query, rendered.text, rendered.keyboard);
      await api.answerCallbackQuery(query.id);
      return;
    }
    if (session.workflow === 'core') {
      if (parsed.action === 'corewallet') {
        const item = await service.coreWalletAt(userId, chatId, Math.max(0, Number(parsed.value) || 0));
        if (!item) throw new Error('This Core wallet is no longer available.');
        state.coreTarget = item.address;
        state.coreView = 'detail';
        state.page = 1;
      } else if (parsed.action === 'coreview') {
        if (!state.coreTarget) throw new Error('No Core wallet is selected.');
        state.corePreviousView = state.coreView ?? 'detail';
        state.coreView = coreView(parsed.value);
        state.page = 1;
      } else if (parsed.action === 'coreremove') {
        if (!state.coreTarget) throw new Error('No Core wallet is selected.');
        if (parsed.value === 'yes') {
          await service.removeCoreWallet(userId, chatId, state.coreTarget);
          state.coreTarget = undefined;
          state.coreView = 'list';
          state.corePreviousView = undefined;
          state.page = 1;
        } else {
          state.corePreviousView = state.coreView ?? 'detail';
          state.coreView = 'remove_confirm';
        }
      } else if (parsed.action === 'coreback') {
        if ((state.coreView ?? 'list') === 'detail') {
          state.coreTarget = undefined;
          state.coreView = 'list';
        } else {
          state.coreView = state.corePreviousView === 'list' ? 'list' : 'detail';
          state.corePreviousView = undefined;
        }
        state.page = 1;
      } else if (parsed.action === 'page') {
        state.page = Math.max(1, Number(parsed.value) || 1);
      } else {
        throw new Error('This Core wallet action has expired.');
      }
      await service.updateSession(session.id, userId, chatId, state);
      const rendered = await renderCorePanel(service, userId, chatId, state, session.id);
      await editIfChanged(api, query, rendered.text, rendered.keyboard);
      await api.answerCallbackQuery(query.id, parsed.action === 'coreremove' && parsed.value === 'yes' ? 'Core monitoring removed' : undefined);
      return;
    }
    if (parsed.action === 'choose') {
      const workflow = parsed.value === 'token' ? 'token' : 'wallet';
      const nextState = { ...state, page: 1 };
      if (workflow === 'wallet') nextState.investigationStatus = 'queued';
      const next = await service.createSession(userId, chatId, workflow, nextState);
      if (workflow === 'wallet') {
        await editIfChanged(api, query, walletProgress(nextState.target ?? '', 'received'), EMPTY_KEYBOARD);
        enqueueWalletInvestigation(service, api, userId, chatId, nextState, next.id);
        await api.sendMessage(chatId, walletProgress(nextState.target ?? '', 'running'));
        await api.answerCallbackQuery(query.id, 'Investigation started');
        return;
      }
      await editIfChanged(api, query, tokenProgress(required(nextState)), EMPTY_KEYBOARD);
      try {
        const rendered = await withTimeout(renderWorkflow(service, workflow, nextState, next.id), TOKEN_ANALYSIS_TIMEOUT_MS, 'Token analysis timed out');
        await editIfChanged(api, query, rendered.text, rendered.keyboard);
        await api.answerCallbackQuery(query.id);
      } catch (error) {
        logTokenAnalysisFailure(next.id, required(nextState), error);
        const failure = tokenAnalysisFailure(required(nextState), next.id);
        await editIfChanged(api, query, failure.text, failure.keyboard);
        await api.answerCallbackQuery(query.id, 'Token analysis failed');
      }
      return;
    }
    if (session.workflow === 'token' && parsed.action === 'tokenretry') {
      await editIfChanged(api, query, tokenProgress(required(state)), EMPTY_KEYBOARD);
      try {
        const rendered = await withTimeout(renderWorkflow(service, 'token', state, session.id), TOKEN_ANALYSIS_TIMEOUT_MS, 'Token analysis timed out');
        await editIfChanged(api, query, rendered.text, rendered.keyboard);
        await api.answerCallbackQuery(query.id, 'Analysis completed');
      } catch (error) {
        logTokenAnalysisFailure(session.id, required(state), error);
        const failure = tokenAnalysisFailure(required(state), session.id);
        await editIfChanged(api, query, failure.text, failure.keyboard);
        await api.answerCallbackQuery(query.id, 'Token analysis failed');
      }
      return;
    }
    if (session.workflow === 'token' && parsed.action === 'tokenback') {
      await editIfChanged(api, query, help(), EMPTY_KEYBOARD);
      await api.answerCallbackQuery(query.id);
      return;
    }
    if (parsed.action === 'exportmenu') {
      await editIfChanged(api, query, '📦 <b>EXPORT</b>\n━━━━━━━━━━━━━━━━━━━━\nChoose a format for this intelligence report.\n\n<i>Exports remain separate from the primary report.</i>', exportKeyboard(session.id));
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
      await api.answerCallbackQuery(query.id, 'Deep scan queued');
      return;
    }
    if (parsed.action === 'watch') {
      const investigation = state.investigationId ? await service.loadWalletInvestigation(state.investigationId) : null;
      if (!investigation) throw new Error('Investigation is no longer available. Use Refresh.');
      await service.watch(userId, chatId, investigation?.entityKey ?? state.target ?? '');
      rememberInvestigationScreen(state);
      state.investigationView = 'watch';
      state.investigationItem = undefined;
      state.page = 1;
      await service.updateSession(session.id, userId, chatId, state);
      const rendered = renderInvestigation(investigation, state, session.id);
      await editIfChanged(api, query, rendered.text, rendered.keyboard);
      await api.answerCallbackQuery(query.id, 'Cluster added to monitoring');
      return;
    }
    if (parsed.action === 'refresh') {
      if (activeWalletRefreshJobs.has(session.id)) {
        await api.answerCallbackQuery(query.id, 'Refresh is already running');
        return;
      }
      if (!state.investigationPreviousView) rememberInvestigationScreen(state);
      state.investigationView = 'summary';
      state.investigationItem = undefined;
      state.page = 1;
      await service.updateSession(session.id, userId, chatId, state);
      await api.answerCallbackQuery(query.id, 'Refreshing intelligence');
      const progress = renderRefreshProgress(required(state), 0);
      await editIfChanged(api, query, progress.text, progress.keyboard);
      enqueueWalletRefresh(service, api, userId, chatId, state, session.id, query);
      return;
    }
    if (parsed.action === 'invest') {
      const nextView = investigationView(parsed.value);
      if (nextView === 'summary') clearInvestigationHistory(state);
      else rememberInvestigationScreen(state);
      state.investigationView = nextView;
      state.investigationItem = undefined;
      state.page = 1;
    } else if (parsed.action === 'evidence') {
      rememberInvestigationScreen(state);
      state.investigationView = 'evidence';
      state.investigationItem = parsed.value;
      state.page = 1;
    } else if (parsed.action === 'receivers') {
      rememberInvestigationScreen(state);
      state.investigationView = 'receivers';
      state.investigationItem = parsed.value;
      state.page = 1;
    } else if (parsed.action === 'back') {
      restoreInvestigationScreen(state);
    } else if (parsed.action === 'page') state.page = Math.max(1, Number(parsed.value) || 1);
    else if (parsed.action === 'sort') state.sort = parsed.value as ProfitableSort;
    else if (parsed.action === 'tokensort') state.tokenSort = parsed.value as OperatorSessionState['tokenSort'];
    else if (parsed.action === 'filter') state.chain = parsed.value as OperatorSessionState['chain'];
    else if (parsed.action === 'view') state.page = 1;

    await service.updateSession(session.id, userId, chatId, state);
    const rendered = INVESTIGATION_WORKFLOWS.has(session.workflow as OperatorWorkflow)
      ? await renderPersistedInvestigation(service, state, session.id)
      : await renderWorkflow(service, session.workflow as OperatorWorkflow, state, session.id);
    await editIfChanged(api, query, rendered.text, rendered.keyboard);
    await api.answerCallbackQuery(query.id);
  } catch (error) {
    await api.answerCallbackQuery(query.id, errorMessage(error));
  }
}

async function sendCorePanel(service: OperatorService, api: TelegramApi, userId: string, chatId: string) {
  const state: OperatorSessionState = { page: 1, pageSize: 5, coreView: 'list' };
  const session = await service.createSession(userId, chatId, 'core', state, 24 * 60);
  const rendered = await renderCorePanel(service, userId, chatId, state, session.id);
  await api.sendMessage(chatId, rendered.text, rendered.keyboard);
}

async function sendAlertInbox(service: OperatorService, api: TelegramApi, userId: string, chatId: string) {
  const state: OperatorSessionState = { page: 1, pageSize: 5, alertFilter: 'push' };
  const session = await service.createSession(userId, chatId, 'alerts', state, 24 * 60);
  const rendered = await renderAlertInbox(service, userId, chatId, state, session.id);
  await api.sendMessage(chatId, rendered.text, rendered.keyboard);
}

async function renderAlertInbox(
  service: OperatorService,
  userId: string,
  chatId: string,
  state: OperatorSessionState,
  sessionId: string
): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const filter = state.alertFilter ?? 'push';
  const page = Math.max(1, state.page || 1);
  const result = await service.alertInbox(userId, chatId, filter, page, 5);
  const filters: Array<[string, AlertInboxFilter]> = [
    ['Push', 'push'], ['Inbox only', 'inbox'], ['Rejected', 'rejected'],
    ['Dormant', 'dormant'], ['Cluster', 'cluster'], ['Independent', 'independent']
  ];
  const filterRows = [filters.slice(0, 3), filters.slice(3)].map((row) => row.map(([label, value]) => ({
    text: `${filter === value ? '• ' : ''}${label}`, callback_data: callback('alertfilter', sessionId, value)
  })));
  const navigation = [];
  if (page > 1) navigation.push({ text: '‹ Previous', callback_data: callback('page', sessionId, String(page - 1)) });
  if (result.hasNext) navigation.push({ text: 'Next ›', callback_data: callback('page', sessionId, String(page + 1)) });
  return {
    text: [
      '🚨 <b>ALERT INBOX</b>',
      `${h(alertFilterLabel(filter))}  ·  <b>${result.total}</b>  ·  Page <b>${page}</b>`, '',
      ...(result.items.length ? result.items.map((item, index) => [
        `${alertInboxIcon(item.category)} <b>${(page - 1) * result.pageSize + index + 1}. ${h(item.token ?? 'Unknown token')}</b>${item.chain ? ` · ${h(item.chain)}` : ''}`,
        `${item.qualifyingWalletCount} wallets · ${item.independentEntityCount} independent entities${item.amountUsd == null ? '' : ` · ${plainMoney(item.amountUsd)}`}`,
        item.rejectionReason ? `Reason: <code>${h(item.rejectionReason)}</code>` : `Signal: <b>${h(prettyLabel(item.signalTier ?? item.status))}</b>`,
        `<i>${h(relativeAlertTime(item.timestamp))}</i>`
      ].join('\n')) : ['No alert receipts in this category.'])
    ].join('\n\n'),
    keyboard: { inline_keyboard: [...filterRows, ...(navigation.length ? [navigation] : [])] }
  };
}

async function addCoreAndQueue(service: OperatorService, api: TelegramApi, userId: string, chatId: string, address: string) {
  const added = await service.addCoreWallet(userId, chatId, address);
  const session = await service.queueCoreHistoricalSync(userId, chatId, added.watch.targetKey);
  const state = session.stateJson as unknown as OperatorSessionState;
  enqueueWalletInvestigation(service, api, userId, chatId, state, session.id);
  await api.sendMessage(chatId, [
    '✅ <b>CORE WALLET ADDED</b>', '━━━━━━━━━━━━━━━━━━━━',
    `<code>${h(added.watch.targetKey)}</code>`,
    `Chains  <b>${added.refs.map((ref) => h(ref.chain)).join(' · ')}</b>`,
    'Status  <b>Monitoring active</b>',
    '', 'Historical sync is running in the background.',
    '<i>Transfers are stored silently. Alerts require qualified cluster confluence or a separate dormant wake-up event.</i>'
  ].join('\n'));
}

async function removeCore(service: OperatorService, api: TelegramApi, userId: string, chatId: string, address: string) {
  await service.removeCoreWallet(userId, chatId, address);
  await api.sendMessage(chatId, [
    '✓ <b>CORE MONITORING REMOVED</b>', '━━━━━━━━━━━━━━━━━━━━',
    `<code>${h(address)}</code>`, '',
    'Active Core monitoring has stopped.',
    '<i>Wallet history and previously stored events remain available.</i>'
  ].join('\n'));
}

async function sendWorkflow(service: OperatorService, api: TelegramApi, userId: string, chatId: string, workflow: OperatorWorkflow, target?: string) {
  const state = defaultState(target);
  if (workflow === 'wallet') state.investigationStatus = 'queued';
  const session = await service.createSession(userId, chatId, workflow, state);
  if (workflow === 'wallet') {
    await api.sendMessage(chatId, walletProgress(target ?? '', 'received'));
    console.info(`[telegram] wallet acknowledgement delivered session=${session.id} target=${target ?? ''}`);
    await service.clearPendingSession(userId, chatId);
    enqueueWalletInvestigation(service, api, userId, chatId, state, session.id);
    await api.sendMessage(chatId, walletProgress(target ?? '', 'running'));
    console.info(`[telegram] wallet progress delivered session=${session.id} target=${target ?? ''}`);
    return;
  }
  if (workflow === 'token') {
    await api.sendMessage(chatId, tokenProgress(required(state)));
    try {
      const rendered = await withTimeout(renderWorkflow(service, workflow, state, session.id), TOKEN_ANALYSIS_TIMEOUT_MS, 'Token analysis timed out');
      await api.sendMessage(chatId, rendered.text, rendered.keyboard);
    } catch (error) {
      logTokenAnalysisFailure(session.id, required(state), error);
      const failure = tokenAnalysisFailure(required(state), session.id);
      await api.sendMessage(chatId, failure.text, failure.keyboard);
    }
    return;
  }
  if (INVESTIGATION_WORKFLOWS.has(workflow)) {
    await runInvestigationWorkflow(service, api, userId, chatId, workflow, state, session.id);
    return;
  }
  const rendered = await renderWorkflow(service, workflow, state, session.id);
  await api.sendMessage(chatId, rendered.text, rendered.keyboard);
}

function enqueueWalletInvestigation(
  service: OperatorService,
  api: TelegramApi,
  userId: string,
  chatId: string,
  state: OperatorSessionState,
  sessionId: string,
  resumed = false
) {
  if (activeWalletInvestigationJobs.has(sessionId)) return false;
  const job = new Promise<void>((resolve) => {
    setImmediate(() => {
      void executeWalletInvestigation(service, api, userId, chatId, state, sessionId, resumed).finally(resolve);
    });
  });
  activeWalletInvestigationJobs.set(sessionId, job);
  void job.finally(() => activeWalletInvestigationJobs.delete(sessionId));
  return true;
}

function enqueueWalletRefresh(
  service: OperatorService,
  api: TelegramApi,
  userId: string,
  chatId: string,
  state: OperatorSessionState,
  sessionId: string,
  query: TelegramCallbackQuery
) {
  if (activeWalletRefreshJobs.has(sessionId)) return false;
  const job = new Promise<void>((resolve) => {
    setImmediate(() => {
      void executeWalletRefresh(service, api, userId, chatId, state, sessionId, query).finally(resolve);
    });
  });
  activeWalletRefreshJobs.set(sessionId, job);
  void job.finally(() => activeWalletRefreshJobs.delete(sessionId));
  return true;
}

async function executeWalletRefresh(
  service: OperatorService,
  api: TelegramApi,
  userId: string,
  chatId: string,
  state: OperatorSessionState,
  sessionId: string,
  query: TelegramCallbackQuery
) {
  const target = required(state);
  try {
    const investigation = await service.walletInvestigationView(target, { maxDepth: 4, refresh: true });
    for (let stage = 1; stage <= 4; stage += 1) {
      const progress = renderRefreshProgress(target, stage);
      await editIfChanged(api, query, progress.text, progress.keyboard);
    }
    state.investigationId = investigation.id;
    state.investigationStatus = 'completed';
    state.investigationError = undefined;
    state.investigationView = 'summary';
    state.investigationItem = undefined;
    state.page = 1;
    state.pageSize = 5;
    clearInvestigationHistory(state);
    await service.updateSession(sessionId, userId, chatId, state);
    const rendered = renderInvestigation(investigation, state, sessionId);
    await editIfChanged(api, query, rendered.text, rendered.keyboard);
    console.info(`[telegram] wallet intelligence refreshed session=${sessionId} target=${target}`);
  } catch (error) {
    const message = errorMessage(error);
    state.investigationError = message;
    await Promise.resolve(service.updateSession(sessionId, userId, chatId, state)).catch(() => false);
    const rendered = renderRefreshFailure(sessionId, message);
    await editIfChanged(api, query, rendered.text, rendered.keyboard).catch((deliveryError) => {
      console.error(`[telegram] wallet refresh failure could not be displayed session=${sessionId}: ${errorMessage(deliveryError)}`);
    });
    console.error(`[telegram] wallet intelligence refresh failed session=${sessionId} target=${target}: ${message}`);
  }
}

async function executeWalletInvestigation(
  service: OperatorService,
  api: TelegramApi,
  userId: string,
  chatId: string,
  state: OperatorSessionState,
  sessionId: string,
  resumed: boolean
) {
  const target = required(state);
  try {
    state.investigationStatus = 'running';
    state.investigationError = undefined;
    await service.updateSession(sessionId, userId, chatId, state);
    if (resumed && !state.silentCoreSync) await api.sendMessage(chatId, walletProgress(target, 'resumed'));
    console.info(`[telegram] wallet investigation started session=${sessionId} target=${target}`);
    await runInvestigationWorkflow(service, api, userId, chatId, 'wallet', state, sessionId);
    console.info(`[telegram] wallet investigation completed session=${sessionId} target=${target}`);
  } catch (error) {
    const message = errorMessage(error);
    state.investigationStatus = 'failed';
    state.investigationError = message;
    await service.updateSession(sessionId, userId, chatId, state).catch(() => false);
    console.error(`[telegram] wallet investigation failed session=${sessionId} target=${target}: ${message}`);
    try {
      await api.sendMessage(chatId, state.silentCoreSync
        ? `⚠️ <b>CORE HISTORY SYNC FAILED</b>\n━━━━━━━━━━━━━━━━━━━━\n<code>${h(target)}</code>\n${h(message)}\n\n<i>Live monitoring remains active. The scheduler will continue polling.</i>`
        : `🔴 <b>INVESTIGATION FAILED</b>\n━━━━━━━━━━━━━━━━━━━━\n${h(message)}\n\n<i>Run a new investigation with <code>/wallet</code>.</i>`);
    } catch (deliveryError) {
      console.error(`[telegram] wallet investigation failure notice could not be delivered session=${sessionId}: ${errorMessage(deliveryError)}`);
    }
  }
}

export async function resumeWalletInvestigationJobs(service: OperatorService, api: TelegramApi) {
  const sessions = await service.pendingWalletInvestigationSessions();
  let resumed = 0;
  for (const session of sessions) {
    const state = session.stateJson as unknown as OperatorSessionState;
    if (!state.target || !enqueueWalletInvestigation(service, api, session.userId, session.chatId, state, session.id, true)) continue;
    resumed += 1;
  }
  return resumed;
}

async function runInvestigationWorkflow(
  service: OperatorService,
  api: TelegramApi,
  userId: string,
  chatId: string,
  workflow: OperatorWorkflow,
  state: OperatorSessionState,
  sessionId: string,
  query?: TelegramCallbackQuery
) {
  const investigation = await service.walletInvestigationView(required(state), { maxDepth: 4, ...(workflow === 'wallet' ? { refresh: true } : {}) });
  state.investigationId = investigation.id;
  state.investigationStatus = 'completed';
  state.investigationError = undefined;
  state.investigationView = workflowView(workflow);
  state.page = 1;
  state.pageSize = 5;
  await service.updateSession(sessionId, userId, chatId, state);
  const rendered = renderInvestigation(investigation, state, sessionId);
  if (state.silentCoreSync) return;
  if (query) await editIfChanged(api, query, rendered.text, rendered.keyboard);
  else await api.sendMessage(chatId, rendered.text, rendered.keyboard);
}

async function renderPersistedInvestigation(service: OperatorService, state: OperatorSessionState, sessionId: string) {
  const investigation = await service.loadWalletInvestigation(state.investigationId ?? required(state));
  if (!investigation) throw new Error('Investigation is no longer available. Use Refresh.');
  return renderInvestigation(investigation, state, sessionId);
}

async function renderCorePanel(
  service: OperatorService,
  userId: string,
  chatId: string,
  state: OperatorSessionState,
  sessionId: string
): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const view = state.coreView ?? 'list';
  const page = Math.max(1, state.page || 1);
  if (view === 'list') {
    const result = await service.listCoreWallets(userId, chatId, page, 5);
    const rows = result.items.map((wallet, index) => {
      const globalIndex = (page - 1) * result.pageSize + index;
      const stateIcon = wallet.status === 'Active' ? '🟢' : '🌙';
      return [{ text: `${stateIcon} ${wallet.label} · ${short(wallet.address)}`, callback_data: callback('corewallet', sessionId, String(globalIndex)) }];
    });
    const navigation = [];
    if (page > 1) navigation.push({ text: '‹ Previous', callback_data: callback('page', sessionId, String(page - 1)) });
    if (result.hasNext) navigation.push({ text: 'Next ›', callback_data: callback('page', sessionId, String(page + 1)) });
    return {
      text: [
        '🛰 <b>CORE WALLET MONITOR</b>', '━━━━━━━━━━━━━━━━━━━━',
        `Tracked wallets  <b>${result.total}</b>  ·  Page <b>${page}</b>`,
        '',
        ...(result.items.length ? result.items.map((wallet, index) => renderCoreListItem(wallet, (page - 1) * result.pageSize + index + 1)) : [
          '⚪ No Core wallets.', '', 'Add the first wallet with <code>/add</code>.'
        ]),
        '', '<i>Transfers are stored silently. Telegram alerts only on actionable wallet activity.</i>'
      ].join('\n'),
      keyboard: { inline_keyboard: [...rows, ...(navigation.length ? [navigation] : [])] }
    };
  }
  if (!state.coreTarget) throw new Error('No Core wallet is selected.');
  const wallet = await service.coreWalletDetail(userId, chatId, state.coreTarget);
  if (view === 'detail') {
    return {
      text: [
        '🛰 <b>CORE WALLET</b>', '━━━━━━━━━━━━━━━━━━━━',
        `<code>${h(wallet.address)}</code>`, '',
        `Label  <b>${h(wallet.label)}</b>`,
        `Chains  <b>${wallet.chains.map((chain) => h(chain)).join(' · ')}</b>`,
        `Entity  <b>${h(wallet.entity ?? 'Unresolved')}</b>`,
        `Status  <b>${wallet.status === 'Active' ? '🟢 Active' : '🌙 Dormant'}</b>`,
        `Historical Alpha  <b>${score(wallet.historicalAlpha)}</b>`,
        `Evidence  <b>${score(wallet.evidence)}</b>`,
        `Last activity  <b>${formatTelegramDate(wallet.lastActivity)}</b>`,
        `Stored events  <b>${wallet.eventCount}</b>`,
        `Priority  <b>${h(prettyLabel(wallet.monitoringPriority))}</b>`
      ].join('\n'),
      keyboard: { inline_keyboard: [
        [{ text: '📋 Activity', callback_data: callback('coreview', sessionId, 'activity') }, { text: '💸 Capital Path', callback_data: callback('coreview', sessionId, 'capital') }],
        [{ text: '🧩 Entity', callback_data: callback('coreview', sessionId, 'entity') }, { text: '🗑 Remove', callback_data: callback('coreremove', sessionId, 'confirm') }],
        [{ text: '← Back', callback_data: callback('coreback', sessionId, 'list') }]
      ] }
    };
  }
  if (view === 'activity') {
    const activity = await service.coreWalletActivity(wallet.address, page, 8);
    const navigation = corePagination(sessionId, page, activity.hasNext);
    return {
      text: [
        '📋 <b>WALLET ACTIVITY</b>', '━━━━━━━━━━━━━━━━━━━━',
        `<code>${h(wallet.address)}</code>`,
        `Events  <b>${activity.total}</b>  ·  Page <b>${page}</b>`, '',
        ...(activity.items.length ? activity.items.map((event) => {
          const verb = event.direction === 'sent' ? '➡ Sent' : event.direction === 'received' ? '⬅ Received' : event.direction === 'bought' ? '🟢 Bought' : event.direction === 'sold' ? '🔴 Sold' : '⚪ Activity';
          return [
            `<b>${formatTelegramDate(event.ts)}</b>`,
            `${verb} <b>${h(compactAmount(event.amount))} ${h(event.token)}</b>${event.amountUsd == null ? '' : ` · ${money(event.amountUsd)}`}`,
            ...(event.counterparty ? [`${event.direction === 'sent' ? 'to' : 'from'}  <code>${h(event.counterparty)}</code>`] : []),
            `<i>${h(event.chain)}</i>`
          ].join('\n');
        }) : ['No stored activity yet.'])
      ].join('\n\n'),
      keyboard: { inline_keyboard: [...navigation, [{ text: '← Back', callback_data: callback('coreback', sessionId, 'detail') }]] }
    };
  }
  if (view === 'capital') {
    const capital = await service.coreWalletCapital(wallet.address, page, 5);
    const navigation = corePagination(sessionId, page, capital.hasNext);
    return {
      text: [
        '💸 <b>CAPITAL PATHS</b>', '━━━━━━━━━━━━━━━━━━━━',
        `<code>${h(wallet.address)}</code>`,
        `Evidence-backed paths  <b>${capital.total}</b>  ·  Page <b>${page}</b>`, '',
        ...(capital.items.length ? capital.items.map((path, index) => [
          `<b>${(page - 1) * capital.pageSize + index + 1}. ${h(prettyLabel(path.route).toUpperCase())}</b>`,
          `<code>${h(path.source)}</code>`, '↓', `<code>${h(path.destination)}</code>`,
          `${h(path.sourceChain)} → ${h(path.destinationChain)}  ·  Confidence <b>${Math.round(path.confidence * 100)}%</b>`,
          `Value  <b>${path.amountUsd == null ? 'Unknown' : money(path.amountUsd)}</b>`,
          `First / last  <b>${formatTelegramDate(path.firstTransfer)} / ${formatTelegramDate(path.lastTransfer)}</b>`,
          ...(path.tokenBuys.length ? [`Bought after funding  <b>${path.tokenBuys.map((token) => h(short(token))).join(' · ')}</b>`] : [])
        ].join('\n')) : ['No evidence-backed capital paths are stored yet.'])
      ].join('\n\n'),
      keyboard: { inline_keyboard: [...navigation, [{ text: '← Back', callback_data: callback('coreback', sessionId, 'detail') }]] }
    };
  }
  if (view === 'entity') {
    return {
      text: [
        '🧩 <b>CORE ENTITY</b>', '━━━━━━━━━━━━━━━━━━━━',
        `<code>${h(wallet.address)}</code>`, '',
        `Entity  <b>${h(wallet.entity ?? 'Unresolved')}</b>`,
        `Evidence  <b>${score(wallet.evidence)}</b>`,
        `Historical Alpha  <b>${score(wallet.historicalAlpha)}</b>`,
        `Monitoring  <b>${h(prettyLabel(wallet.monitoringPriority))}</b>`, '',
        '<i>Direct funding and verified exact-bridge receivers remain observation-only. Bridge inference and CEX correlation never prove ownership.</i>'
      ].join('\n'),
      keyboard: { inline_keyboard: [[{ text: '← Back', callback_data: callback('coreback', sessionId, 'detail') }]] }
    };
  }
  return {
    text: [
      '⚠️ <b>REMOVE CORE WALLET?</b>', '━━━━━━━━━━━━━━━━━━━━',
      `<code>${h(wallet.address)}</code>`, '',
      'Active monitoring will stop.',
      '<i>History and stored events will remain available.</i>'
    ].join('\n'),
    keyboard: { inline_keyboard: [
      [{ text: 'Remove', callback_data: callback('coreremove', sessionId, 'yes') }],
      [{ text: '← Back', callback_data: callback('coreback', sessionId, 'detail') }]
    ] }
  };
}

async function renderWorkflow(service: OperatorService, workflow: OperatorWorkflow, state: OperatorSessionState, sessionId: string): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const page = state.page || 1;
  const size = state.pageSize || 10;
  if (INVESTIGATION_WORKFLOWS.has(workflow)) return renderPersistedInvestigation(service, state, sessionId);
  if (workflow === 'token') {
    const tokenAddress = required(state);
    await service.scanTokenTopPnl(tokenAddress);
    const value = await service.tokenSummary(tokenAddress, 1, 10, 'pnl');
    const rows = value.topPnl.items.slice(0, 5) as TokenPnlTelegramRow[];
    const displayedRows = rows.slice(0, 5);
    return {
      text: renderTokenIntelligenceSummary(tokenAddress, value, rows, displayedRows),
      keyboard: displayedRows.length ? tokenPnlKeyboard(displayedRows) : EMPTY_KEYBOARD
    };
  }
  if (workflow === 'profitable') {
    const value = await service.profitable({ chain: state.chain, sort: state.sort, page, pageSize: size });
    return { text: renderProfitable(value), keyboard: navKeyboard(sessionId, page, value.hasNext, [[{ text: 'PnL', callback_data: callback('sort', sessionId, 'pnl') }, { text: 'WR', callback_data: callback('sort', sessionId, 'win_rate') }, { text: 'EV', callback_data: callback('sort', sessionId, 'ev') }], [{ text: 'SOL', callback_data: callback('filter', sessionId, 'SOLANA') }, { text: 'ETH', callback_data: callback('filter', sessionId, 'ETHEREUM') }, { text: 'Base', callback_data: callback('filter', sessionId, 'BASE') }], [{ text: 'ARB', callback_data: callback('filter', sessionId, 'ARBITRUM') }, { text: 'BSC', callback_data: callback('filter', sessionId, 'BSC') }, { text: 'All', callback_data: callback('filter', sessionId, 'ALL') }]]) };
  }
  const value = await service.recent(page, size);
  const text = [
    '📡 <b>LIVE INTELLIGENCE FEED</b>',
    '━━━━━━━━━━━━━━━━━━━━',
    `Relevant events <b>${value.total}</b>  ·  Page <b>${page}</b>`,
    ...value.items.map((row, index) => [
      '',
      `${(page - 1) * size + index + 1}. ${eventIcon(row.kind)} <b>${h(prettyLabel(row.kind))}</b>  ·  ${h(row.chain)}`,
      `<code>${h(short(row.source))}</code>  →  <code>${h(short(row.destination))}</code>`,
      `💰 ${plainMoney(row.amountUsd)}  ·  🛡 score ${h(row.score)}`
    ].join('\n')),
    ...(value.coverageWarnings.length ? ['', `🟡 <i>${value.coverageWarnings.map(h).join(' ')}</i>`] : [])
  ].join('\n');
  return { text, keyboard: navKeyboard(sessionId, page, value.hasNext) };
}

export function renderInvestigation(investigation: WalletInvestigationResult, state: OperatorSessionState, sessionId: string) {
  return renderInvestigationReport(investigation, state, sessionId);
}

/* Retired raw-relation renderer retained temporarily for review history.
export function renderInvestigationRawLegacy(investigation: WalletInvestigationResult, state: OperatorSessionState, sessionId: string) {
  const presentation = buildInvestigationPresentation(investigation);
  const view = state.investigationView ?? 'summary';
  const page = state.page || 1;
  if (view === 'summary') return renderOperatorSummary(investigation, presentation, sessionId);
  if (view === 'priority' || view === 'paths') return renderFindingPage('PRIORITY CAPITAL PATHS', presentation.priorityFindings, page, sessionId, 'p');
  if (view === 'deployments') return renderFindingPage('TOKEN DEPLOYMENTS', presentation.deploymentFindings, page, sessionId, 'd');
  if (view === 'bridges') return renderFindingPage('BRIDGES', presentation.bridgeFindings, page, sessionId, 'b');
  if (view === 'alts') return renderOperatorAltWallets(presentation, page, sessionId);
  if (view === 'cluster') return renderOperatorCluster(presentation, page, sessionId);
  if (view === 'advanced') return renderAdvanced(presentation, page, sessionId);
  if (view === 'receivers') return renderGroupReceivers(presentation, state.investigationItem, page, sessionId);
  return renderOperatorEvidence(presentation, state.investigationItem, sessionId);
}

function renderOperatorSummary(value: WalletInvestigationResult, presentation: InvestigationPresentation, sessionId: string) {
  const chains = value.activityChains.length ? value.activityChains.map(chainLabel).join(', ') : 'No confirmed activity';
  const highlights = presentation.priorityFindings.slice(0, 3);
  const findings = highlights.length
    ? ['<b>Key findings:</b>', ...highlights.map((finding, index) => renderSummaryFinding(finding, index + 1))]
    : [
        '<b>No high-priority paths found.</b>',
        `- Relationships analyzed: ${presentation.totalRelations}`,
        `- Noise/infrastructure: ${presentation.noiseInfrastructure}`,
        `- Low priority: ${presentation.lowPriorityRelations}`,
        `- Complete coverage: ${presentation.completeCoverageChains}/${value.coverage.length} chains`
      ];
  const text = [
    '<b>WALLET INVESTIGATION</b>',
    '',
    '<b>Root:</b>',
    `<code>${h(value.rootAddress)}</code>`,
    '',
    '<b>Chains:</b>',
    h(chains),
    '',
    '<b>Results:</b>',
    `- High-priority capital paths: ${presentation.highPriorityCount}`,
    `- Direct receivers: ${presentation.directReceivers}`,
    `- Exact bridge destinations: ${presentation.exactBridgeDestinations}`,
    `- Probable alt/execution wallets: ${presentation.probableAltExecutionWallets}`,
    `- Token deployments: ${presentation.tokenDeployments}`,
    `- Profit rotations: ${presentation.profitRotations}`,
    `- Low-priority/noise hidden: ${presentation.hiddenRelations}`,
    '',
    ...findings
  ].join('\n');
  return {
    text,
    keyboard: { inline_keyboard: [
      [{ text: 'Priority paths', callback_data: callback('invest', sessionId, 'priority') }],
      [{ text: 'Token deployments', callback_data: callback('invest', sessionId, 'deployments') }],
      [{ text: 'Alt / execution wallets', callback_data: callback('invest', sessionId, 'alts') }],
      [{ text: 'Bridges', callback_data: callback('invest', sessionId, 'bridges') }],
      [{ text: 'Full cluster', callback_data: callback('invest', sessionId, 'cluster') }],
      [{ text: 'Advanced / all results', callback_data: callback('invest', sessionId, 'advanced') }]
    ] }
  };
}

function renderSummaryFinding(finding: PresentedFinding, rank: number) {
  const token = finding.tokenAddress ? ` · ${h(finding.tokenSymbol ?? short(finding.tokenAddress))}` : '';
  return `${rank}. <b>${h(finding.label)}</b> · ${formatAmount(finding.amountUsd, finding.amountToken, finding.assetSymbol)}${token}\n<code>${h(finding.receiverAddress)}</code>`;
}

function renderFindingPage(title: string, rows: PresentedFinding[], page: number, sessionId: string, prefix: string) {
  const { items, hasNext } = pageRows(rows, page, 5);
  const text = [
    `<b>${title}</b> · page ${page} · ${rows.length} total`,
    ...(items.length
      ? items.map((finding, index) => renderOperatorFinding(finding, (page - 1) * 5 + index + 1))
      : ['No high-priority paths found.'])
  ].join('\n\n');
  const buttons = items.flatMap((finding, index) => operatorFindingButtons(finding, sessionId, `${prefix}:${(page - 1) * 5 + index}`));
  return { text, keyboard: operatorListKeyboard(sessionId, page, hasNext, buttons) };
}

function renderOperatorFinding(finding: PresentedFinding, rank: number) {
  const lines = [
    `${rank}. <b>${h(finding.label)}</b>`,
    '',
    '<b>Source:</b>',
    `<code>${h(finding.sourceAddress)}</code>`,
    '',
    '<b>Receiver:</b>',
    `<code>${h(finding.receiverAddress)}</code>`,
    '',
    `Amount: ${formatAmount(finding.amountUsd, finding.amountToken, finding.assetSymbol)}`,
    `Receiver role: ${h(finding.receiverRole.replaceAll('_', ' '))}`,
    finding.tokenAddress ? `Bought: ${h(finding.tokenSymbol ?? 'TOKEN')} · <code>${h(finding.tokenAddress)}</code>` : null,
    finding.fundingToBuyDelaySec == null ? null : `Funding → buy: ${duration(finding.fundingToBuyDelaySec)}`,
    `Confidence: ${Math.round(finding.confidence * 100)}%`
  ].filter((line): line is string => line !== null);
  return lines.join('\n');
}

function operatorFindingButtons(finding: PresentedFinding, sessionId: string, selector: string): InlineKeyboard['inline_keyboard'] {
  const row: InlineKeyboard['inline_keyboard'][number] = [];
  if (finding.sourceTxHash) row.push({ text: 'Source tx', url: transactionExplorer(finding.sourceChain, finding.sourceTxHash) });
  row.push({ text: 'Receiver', url: walletExplorer(finding.receiverChain, finding.receiverAddress) });
  if (finding.tokenAddress) row.push({ text: 'Token', url: tokenExplorer(finding.receiverChain, finding.tokenAddress) });
  row.push({ text: 'Evidence', callback_data: callback('evidence', sessionId, selector) });
  return [row];
}

function renderOperatorAltWallets(presentation: InvestigationPresentation, page: number, sessionId: string) {
  return renderClusterPage('ALT / EXECUTION WALLETI', presentation.altWallets, page, sessionId);
}

function renderOperatorCluster(presentation: InvestigationPresentation, page: number, sessionId: string) {
  const counts = new Map<string, number>();
  for (const row of presentation.clusterMembers) counts.set(row.section, (counts.get(row.section) ?? 0) + 1);
  return renderClusterPage([
    'FULL CLUSTER',
    `Strong: ${counts.get('Confirmed/strong relationships') ?? 0} · Probable alt/execution: ${counts.get('Probable alt/execution wallets') ?? 0}`,
    `Possible: ${counts.get('Possible relationships') ?? 0} · Infrastructure excluded: ${counts.get('Infrastructure excluded') ?? 0}`
  ].join('\n'), presentation.clusterMembers, page, sessionId);
}

function renderClusterPage(title: string, rows: PresentedClusterMember[], page: number, sessionId: string) {
  const { items, hasNext } = pageRows(rows, page, 5);
  const text = [
    `<b>${title}</b> · page ${page} · ${rows.length} total`,
    ...(items.length ? items.map((row, index) => renderPresentedClusterMember(row, (page - 1) * 5 + index + 1)) : ['No wallets in this category.'])
  ].join('\n\n');
  return { text, keyboard: operatorListKeyboard(sessionId, page, hasNext, items.map(({ member }) => memberButtons(member))) };
}

function renderPresentedClusterMember(row: PresentedClusterMember, rank: number) {
  const member = row.member;
  return [
    `${rank}. <b>${h(row.section)}</b>`,
    `<code>${h(member.address)}</code>`,
    `${chainLabel(member.chain)} · ${h(member.role.replaceAll('_', ' '))} · ${Math.round(member.relationshipConfidence * 100)}%`,
    `Evidence: ${h(member.evidenceTier)} · observation_only`
  ].join('\n');
}

function renderAdvanced(presentation: InvestigationPresentation, page: number, sessionId: string) {
  const { items, hasNext } = pageRows(presentation.relationGroups, page, 5);
  const text = [
    `<b>ADVANCED / ALL RESULTS</b> · page ${page}`,
    `${presentation.totalRelations} relationships · ${presentation.relationGroups.length} grouped events`,
    ...(items.length ? items.map((group, index) => renderRelationGroup(group, (page - 1) * 5 + index + 1)) : ['No persisted relationships.'])
  ].join('\n\n');
  const buttons = items.flatMap((group, index) => {
    const selector = String((page - 1) * 5 + index);
    const row: InlineKeyboard['inline_keyboard'][number] = [];
    if (group.sourceTxHash) row.push({ text: 'Source tx', url: transactionExplorer(group.sourceChain, group.sourceTxHash) });
    if (group.receivers.length === 1) row.push({ text: 'Receiver', url: walletExplorer(group.receivers[0].chain, group.receivers[0].address) });
    else row.push({ text: `Show ${group.receivers.length} receivers`, callback_data: callback('receivers', sessionId, selector) });
    row.push({ text: 'Evidence', callback_data: callback('evidence', sessionId, `a:${selector}`) });
    return [row];
  });
  return { text, keyboard: operatorListKeyboard(sessionId, page, hasNext, buttons) };
}

function renderRelationGroup(group: PresentedRelationGroup, rank: number) {
  const receiver = group.receivers[0];
  if (group.receivers.length > 1) return [
    `${rank}. <b>${h(group.label)}</b>`,
    '',
    '<b>Source:</b>',
    `<code>${h(group.sourceAddress)}</code>`,
    '',
    `- ${group.receivers.length} receiver wallets`,
    `- total sent: ${formatAmount(group.totalAmountUsd, group.amountToken, group.assetSymbol)}`,
    `- route: ${h(group.routeType.replaceAll('_', '-'))}, depth ${group.depth}`,
    `- token deployments: ${group.deploymentCount}`,
    `- classification: ${h(group.classification.replaceAll('_', ' '))}`
  ].join('\n');
  return [
    `${rank}. <b>${h(group.label)}</b> · ${h(group.classification.replaceAll('_', ' '))}`,
    `Source: <code>${h(group.sourceAddress)}</code>`,
    `Receiver: <code>${h(receiver?.address ?? 'n/a')}</code>`,
    `Amount: ${formatAmount(group.totalAmountUsd, group.amountToken, group.assetSymbol)} · depth ${group.depth}`,
    `Role: ${h(receiver?.role.replaceAll('_', ' ') ?? 'unclassified')} · Confidence: ${Math.round(group.confidence * 100)}%`
  ].join('\n');
}

function renderGroupReceivers(presentation: InvestigationPresentation, selector: string | undefined, page: number, sessionId: string) {
  const groupIndex = Math.max(0, Number(selector) || 0);
  const group = presentation.relationGroups[groupIndex];
  if (!group) return { text: '<b>This receiver group is no longer available.</b>', keyboard: operatorBackKeyboard(sessionId) };
  const { items, hasNext } = pageRows(group.receivers, page, 5);
  const text = [
    `<b>${h(group.label)} · RECEIVERS</b> · page ${page} · ${group.receivers.length} total`,
    ...items.map((receiver, index) => [
      `${(page - 1) * 5 + index + 1}. <code>${h(receiver.address)}</code>`,
      `${chainLabel(receiver.chain)} · ${h(receiver.role.replaceAll('_', ' '))} · ${Math.round(receiver.confidence * 100)}%`
    ].join('\n'))
  ].join('\n\n');
  return { text, keyboard: operatorListKeyboard(sessionId, page, hasNext, items.map((receiver) => [{ text: 'Receiver', url: walletExplorer(receiver.chain, receiver.address) }])) };
}

function renderOperatorEvidence(presentation: InvestigationPresentation, selector: string | undefined, sessionId: string) {
  const match = /^([pdba]):(\d+)$/.exec(selector ?? '');
  const index = Number(match?.[2] ?? -1);
  if (match?.[1] === 'a') {
    const group = presentation.relationGroups[index];
    if (!group) return { text: '<b>Evidence is no longer available.</b>', keyboard: operatorBackKeyboard(sessionId) };
    return {
      text: [
        `<b>EVIDENCE · ${h(group.label)}</b>`,
        `Supporting: ${h(group.evidenceTiers.join(', ') || 'none')}`,
        `Reasons: ${h(group.reasons.join(', ') || 'none')}`,
        `Persisted relations: ${group.relationCount} · transfers: ${group.transferCount}`,
        `Classification: ${h(group.classification)}`
      ].join('\n'),
      keyboard: operatorBackKeyboard(sessionId)
    };
  }
  const rows = match?.[1] === 'd' ? presentation.deploymentFindings : match?.[1] === 'b' ? presentation.bridgeFindings : presentation.priorityFindings;
  const finding = rows[index];
  if (!finding) return { text: '<b>Evidence is no longer available.</b>', keyboard: operatorBackKeyboard(sessionId) };
  return {
    text: [
      `<b>EVIDENCE · ${h(finding.label)}</b>`,
      `Supporting: ${h(finding.evidenceTiers.join(', ') || 'none')}`,
      `Reasons: ${h(finding.reasons.join(', ') || 'none')}`,
      `Relationship confidence: ${Math.round(finding.confidence * 100)}%`,
      `Contradicting evidence records: ${finding.contradictingEvidence.filter(Boolean).length}`,
      `Event time: ${h(finding.eventTs)}`
    ].join('\n'),
    keyboard: operatorBackKeyboard(sessionId)
  };
}

function operatorListKeyboard(sessionId: string, page: number, hasNext: boolean, rows: InlineKeyboard['inline_keyboard']): InlineKeyboard {
  const navigation: InlineKeyboard['inline_keyboard'][number] = [];
  if (page > 1) navigation.push({ text: '‹ Back', callback_data: callback('page', sessionId, String(page - 1)) });
  if (hasNext) navigation.push({ text: 'Next ›', callback_data: callback('page', sessionId, String(page + 1)) });
  return { inline_keyboard: [...rows, ...(navigation.length ? [navigation] : []), [{ text: 'Back', callback_data: callback('invest', sessionId, 'summary') }]] };
}

function operatorBackKeyboard(sessionId: string): InlineKeyboard {
  return { inline_keyboard: [[{ text: 'Back', callback_data: callback('invest', sessionId, 'summary') }]] };
}

function chainLabel(chain: string) {
  if (chain === 'ETHEREUM') return 'Ethereum';
  if (chain === 'ARBITRUM') return 'Arbitrum';
  if (chain === 'SOLANA') return 'Solana';
  if (chain === 'BASE') return 'Base';
  return chain;
}
*/

function renderInvestigationLegacy(investigation: WalletInvestigationResult, state: OperatorSessionState, sessionId: string) {
  const view = state.investigationView ?? 'summary';
  if (view === 'summary') return renderInvestigationSummary(investigation, sessionId);
  if (view === 'cluster') return renderCluster(investigation, state.page || 1, sessionId);
  if (view === 'deployments') return renderDeployments(investigation, state.page || 1, sessionId);
  if (view === 'evidence') return renderEvidence(investigation, sessionId);
  return renderPaths(investigation, state.page || 1, sessionId, view === 'bridges');
}

function renderInvestigationSummary(value: WalletInvestigationResult, sessionId: string) {
  const activity = value.activityChains.length ? value.activityChains.join(', ') : 'none observed';
  const text = [
    '<b>WALLET INVESTIGATION</b>',
    '',
    '<b>Root:</b>',
    `<code>${h(value.rootAddress)}</code>`,
    '',
    '<b>Chains:</b>',
    h(activity),
    '',
    '<b>Discovered:</b>',
    `- Direct receivers: ${value.counts.directReceivers}`,
    `- Multi-hop wallets: ${value.counts.multiHopWallets}`,
    `- Bridge destinations: ${value.counts.bridgeDestinations}`,
    `- Probable alt/execution wallets: ${value.counts.probableAltExecutionWallets}`,
    `- Profit collectors: ${value.counts.profitCollectors}`,
    `- Token deployments: ${value.counts.tokenDeployments}`,
    `- Possible CEX links: ${value.counts.possibleCexLinks}`,
    '',
    '<b>Cluster:</b>',
    `- Entity ID: ${value.entityKey ? `<code>${h(value.entityKey)}</code>` : 'not established'}`,
    `- Strong/probable links: ${value.counts.strongLinks}/${value.counts.probableLinks}`,
    `- Possible links: ${value.counts.possibleLinks}`,
    `- Coverage status: ${h(value.coverageStatus)}`
  ].join('\n');
  const keyboard: InlineKeyboard = { inline_keyboard: [
    [{ text: 'Capital paths', callback_data: callback('invest', sessionId, 'paths') }, { text: 'Cluster wallets', callback_data: callback('invest', sessionId, 'cluster') }],
    [{ text: 'Token deployments', callback_data: callback('invest', sessionId, 'deployments') }, { text: 'Evidence', callback_data: callback('invest', sessionId, 'evidence') }],
    [{ text: 'Refresh', callback_data: callback('refresh', sessionId, 'run') }, { text: 'Watch cluster', callback_data: callback('watch', sessionId, 'cluster') }]
  ] };
  return { text, keyboard };
}

function renderPaths(value: WalletInvestigationResult, page: number, sessionId: string, bridgesOnly: boolean) {
  const all = value.paths
    .filter((path) => bridgesOnly ? path.routeType === 'bridge' : true)
    .sort((a, b) => Date.parse(a.eventTs) - Date.parse(b.eventTs) || a.id.localeCompare(b.id));
  const { items, hasNext } = pageRows(all, page, 5);
  const title = bridgesOnly ? 'VERIFIED BRIDGE PATHS' : 'CAPITAL PATHS';
  const text = [`<b>${title}</b> · page ${page} · ${all.length} total`, ...(items.length ? items.map((path, index) => renderPath(path, (page - 1) * 5 + index + 1)) : ['No persisted paths in this view.'])].join('\n\n');
  return { text, keyboard: investigationListKeyboard(sessionId, page, hasNext, items.flatMap(pathButtonRows)) };
}

function renderPath(path: InvestigationPath, rank: number) {
  const route = path.routeType.replaceAll('_', ' ').toUpperCase();
  const hops = path.hops.length ? path.hops : [{
    sourceChain: path.sourceChain, sourceAddress: path.sourceAddress, destinationChain: path.destinationChain,
    destinationAddress: path.destinationAddress, amountToken: path.amountToken, amountUsd: path.amountUsd,
    assetSymbol: path.assetSymbol, timestamp: path.eventTs, txHash: path.txHash ?? '', protocol: path.protocol,
    evidenceTier: path.evidenceTier, confidence: path.confidence
  }];
  const routeLines = hops.flatMap((hop, index) => [
    `${index ? '↓' : ''} ${h(hop.sourceChain)} <code>${h(hop.sourceAddress)}</code>`,
    `→ ${h(hop.destinationChain)} <code>${h(hop.destinationAddress)}</code> · ${formatAmount(hop.amountUsd, hop.amountToken, hop.assetSymbol)}`
  ]);
  return [
    `${rank}. <b>${h(route)}</b> · ${Math.round(path.confidence * 100)}%`,
    ...routeLines,
    `Evidence: ${h(path.evidenceTier)}${path.protocol ? ` · ${h(path.protocol)}` : ''}`,
    `Time: ${h(path.eventTs)}`,
    path.txHash ? `Source tx: <code>${h(path.txHash)}</code>` : 'Source tx: unavailable'
  ].join('\n');
}

function pathButtonRows(path: InvestigationPath): InlineKeyboard['inline_keyboard'] {
  const walletRefs = path.hops.length
    ? [{ chain: path.hops[0].sourceChain, address: path.hops[0].sourceAddress }, ...path.hops.map((hop) => ({ chain: hop.destinationChain, address: hop.destinationAddress }))]
    : [{ chain: path.sourceChain, address: path.sourceAddress }, { chain: path.destinationChain, address: path.destinationAddress }];
  const uniqueWallets = [...new Map(walletRefs.map((ref) => [`${ref.chain}:${ref.address}`, ref])).values()];
  const walletRows = uniqueWallets.map((ref, index) => [
    { text: `Copy wallet ${index + 1}`, copy_text: { text: ref.address } },
    { text: `Wallet ${index + 1} explorer`, url: walletExplorer(ref.chain, ref.address) }
  ]);
  const txRefs = path.hops.length
    ? path.hops.filter((hop) => hop.txHash).map((hop) => ({ chain: hop.sourceChain, txHash: hop.txHash }))
    : path.txHash ? [{ chain: path.sourceChain, txHash: path.txHash }] : [];
  const uniqueTransactions = [...new Map(txRefs.map((ref) => [`${ref.chain}:${ref.txHash}`, ref])).values()];
  const transactionRows = uniqueTransactions.map((ref, index) => [{ text: `Transaction ${index + 1}`, url: transactionExplorer(ref.chain, ref.txHash) }]);
  return [...walletRows, ...transactionRows];
}

function renderCluster(value: WalletInvestigationResult, page: number, sessionId: string) {
  const { items, hasNext } = pageRows(value.members, page, 5);
  const text = [`<b>CLUSTER WALLETS</b> · page ${page} · ${value.members.length} total`, ...(items.length ? items.map((member, index) => renderMember(member, (page - 1) * 5 + index + 1)) : ['No evidence-backed cluster wallets.'])].join('\n\n');
  return { text, keyboard: investigationListKeyboard(sessionId, page, hasNext, items.map(memberButtons)) };
}

function renderMember(member: InvestigationMember, rank: number) {
  const parent = member.parentAddress ? `${member.parentChain} <code>${h(member.parentAddress)}</code>` : 'investigation root';
  return [
    `${rank}. <b>${h(member.role.replaceAll('_', ' '))}</b> · ${Math.round(member.relationshipConfidence * 100)}%`,
    `${h(member.chain)} <code>${h(member.address)}</code>`,
    `Linked from: ${parent}`,
    `Evidence: ${h(member.evidenceTier)} · observation_only`,
    `First/last: ${h(member.firstLinkedAt)} · ${h(member.lastLinkedAt)}`
  ].join('\n');
}

function memberButtons(member: InvestigationMember): InlineKeyboard['inline_keyboard'][number] {
  return [
    { text: 'Copy wallet', copy_text: { text: member.address } },
    { text: 'Explorer', url: walletExplorer(member.chain, member.address) }
  ];
}

function renderDeployments(value: WalletInvestigationResult, page: number, sessionId: string) {
  const { items, hasNext } = pageRows(value.deployments, page, 5);
  const text = [`<b>TOKEN DEPLOYMENTS</b> · page ${page} · ${value.deployments.length} total`, ...(items.length ? items.map((deployment, index) => renderDeployment(deployment, (page - 1) * 5 + index + 1)) : ['No token buy observed after tracked funding.'])].join('\n\n');
  return { text, keyboard: investigationListKeyboard(sessionId, page, hasNext, items.map(deploymentButtons)) };
}

function renderDeployment(row: InvestigationDeployment, rank: number) {
  return [
    `${rank}. <b>${h(row.tokenSymbol ?? 'TOKEN')}</b> · ${h(row.chain)}`,
    `Token: <code>${h(row.tokenAddress)}</code>`,
    `Buyer: <code>${h(row.buyerAddress)}</code>`,
    `Buy: ${formatAmount(row.amountUsd, row.amountToken, row.tokenSymbol)} · ${h(row.buyTs)}`,
    `Funding→buy: ${row.fundingToBuyDelaySec == null ? 'n/a' : duration(row.fundingToBuyDelaySec)}`,
    `Evidence: ${h(row.evidenceTier)} · holding ${h(row.holdingStatus)}`,
    `Buy tx: <code>${h(row.buyTxHash)}</code>`
  ].join('\n');
}

function deploymentButtons(row: InvestigationDeployment): InlineKeyboard['inline_keyboard'][number] {
  return [
    { text: 'Copy token', copy_text: { text: row.tokenAddress } },
    { text: 'Token explorer', url: tokenExplorer(row.chain, row.tokenAddress) },
    { text: 'Buy tx', url: transactionExplorer(row.chain, row.buyTxHash) }
  ];
}

function renderEvidence(value: WalletInvestigationResult, sessionId: string) {
  const chains = value.coverage.map((row) => [
    `<b>${h(row.chain)}</b> · ${h(row.coverageStatus)} · ${row.eventsScanned} events`,
    `Provider: ${h(row.provider ?? 'unavailable')} · activity ${row.activityFound ? 'found' : 'not observed'}`,
    `First/last: ${h(row.firstActivityAt ?? 'n/a')} · ${h(row.lastActivityAt ?? 'n/a')}`,
    ...row.warnings.map((warning) => `<i>${h(warning)}</i>`)
  ].join('\n'));
  const text = [
    '<b>INVESTIGATION EVIDENCE</b>',
    `Status: ${h(value.status)} · coverage ${h(value.coverageStatus)} · depth ${value.maxDepth}`,
    `Strong/probable/possible links: ${value.counts.strongLinks}/${value.counts.probableLinks}/${value.counts.possibleLinks}`,
    'Service/router/CEX nodes are not ownership links. CEX paths remain inference-only.',
    '',
    ...chains
  ].join('\n\n');
  return { text, keyboard: investigationListKeyboard(sessionId, 1, false, []) };
}

function investigationListKeyboard(sessionId: string, page: number, hasNext: boolean, rows: InlineKeyboard['inline_keyboard']): InlineKeyboard {
  const navigation: InlineKeyboard['inline_keyboard'][number] = [];
  if (page > 1) navigation.push({ text: '‹ Back', callback_data: callback('page', sessionId, String(page - 1)) });
  if (hasNext) navigation.push({ text: 'Next ›', callback_data: callback('page', sessionId, String(page + 1)) });
  return { inline_keyboard: [
    ...rows,
    ...(navigation.length ? [navigation] : []),
    [{ text: 'Investigation summary', callback_data: callback('invest', sessionId, 'summary') }]
  ] };
}

function pageRows<T>(rows: T[], page: number, pageSize: number) {
  const start = (page - 1) * pageSize;
  return { items: rows.slice(start, start + pageSize), hasNext: start + pageSize < rows.length };
}

async function editIfChanged(api: TelegramApi, query: TelegramCallbackQuery, text: string, keyboard: InlineKeyboard) {
  if (!query.message) return;
  const sameText = query.message.text === htmlToPlain(text);
  const sameKeyboard = JSON.stringify(query.message.reply_markup ?? null) === JSON.stringify(keyboard);
  if (sameText && sameKeyboard) return;
  try {
    await api.editMessage(String(query.message.chat.id), query.message.message_id, text, keyboard);
  } catch (error) {
    if (/message is not modified/i.test(errorMessage(error))) return;
    throw error;
  }
}

function htmlToPlain(value: string) {
  return value.replace(/<[^>]+>/g, '').replaceAll('&quot;', '"').replaceAll('&gt;', '>').replaceAll('&lt;', '<').replaceAll('&amp;', '&');
}
function pendingKeyboard(sessionId: string): InlineKeyboard { return { inline_keyboard: [[{ text: '← Cancel', callback_data: callback('cancel', sessionId, 'pending') }]] }; }
function defaultState(target?: string): OperatorSessionState { return { target, chain: 'ALL', sort: 'pnl', page: 1, pageSize: 10 }; }
function invalidTargetMessage(workflow: OperatorWorkflow) {
  if (workflow === 'token') return '🔴 <b>INVALID TOKEN CONTRACT</b>\n━━━━━━━━━━━━━━━━━━━━\nSend a valid token contract address.';
  if (workflow === 'wallet' || workflow === 'core_add' || workflow === 'core_remove') return '🔴 <b>INVALID WALLET</b>\n━━━━━━━━━━━━━━━━━━━━\nSend a Solana base58 address (32–44 characters) or an EVM <code>0x</code> address (40 hexadecimal characters).';
  return '🔴 <b>INVALID TARGET</b>\n━━━━━━━━━━━━━━━━━━━━\nSend a valid wallet address or an existing entity ID.';
}
function workflowView(workflow: OperatorWorkflow): OperatorSessionState['investigationView'] {
  if (workflow === 'flow') return 'priority';
  if (workflow === 'bridges') return 'bridges';
  if (workflow === 'entity') return 'cluster';
  return 'summary';
}
function investigationView(value: string): NonNullable<OperatorSessionState['investigationView']> {
  return value === 'paths' || value === 'priority' || value === 'cluster' || value === 'alts' || value === 'deployments'
    || value === 'evidence' || value === 'bridges' || value === 'more' || value === 'advanced' || value === 'receivers'
    || value === 'history' || value === 'outcomes' || value === 'watch' ? value : 'summary';
}

function coreView(value: string): NonNullable<OperatorSessionState['coreView']> {
  return value === 'activity' || value === 'capital' || value === 'entity' ? value : 'detail';
}
function alertFilter(value: string): AlertInboxFilter {
  return value === 'inbox' || value === 'rejected' || value === 'dormant' || value === 'cluster' || value === 'independent' ? value : 'push';
}
function alertFilterLabel(value: AlertInboxFilter) {
  return ({ push: 'Push alerts', inbox: 'Inbox only', rejected: 'Rejected', dormant: 'Dormant wake-ups', cluster: 'Cluster confluence', independent: 'Independent entity confluence' } as const)[value];
}
function alertInboxIcon(value: string) { return value === 'rejected' ? '⚪' : value === 'inbox' ? '🔵' : value === 'dormant' ? '⚡' : value === 'independent' ? '🟢' : '🟡'; }
function relativeAlertTime(value: string) {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return value;
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1_000));
  if (seconds < 60) return 'just now';
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

function rememberInvestigationScreen(state: OperatorSessionState) {
  state.investigationPreviousView = state.investigationView ?? 'summary';
  state.investigationPreviousItem = state.investigationItem;
  state.investigationPreviousPage = state.page || 1;
}

function restoreInvestigationScreen(state: OperatorSessionState) {
  const previous = state.investigationPreviousView ?? 'summary';
  state.investigationView = previous;
  state.investigationItem = state.investigationPreviousItem;
  state.page = state.investigationPreviousPage ?? 1;
  if (previous === 'summary') clearInvestigationHistory(state);
  else {
    state.investigationPreviousView = 'summary';
    state.investigationPreviousItem = undefined;
    state.investigationPreviousPage = 1;
  }
}

function clearInvestigationHistory(state: OperatorSessionState) {
  state.investigationPreviousView = undefined;
  state.investigationPreviousItem = undefined;
  state.investigationPreviousPage = undefined;
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
  firstSellTs?: string | null;
  lastActivityTs?: string | null;
  qualityScore?: number | null;
  rawAlpha?: number | null;
  alphaConfidence?: number | null;
  alphaSampleSize?: number | null;
  medianRoi?: number | null;
  winRate?: number | null;
  status?: 'Holding' | 'Accumulating' | 'Exited' | 'Active Trader' | 'Dormant' | 'Unknown';
  intelligenceReason?: string;
  relatedWalletCount?: number;
  finalRankingScore?: number;
  repeatRunnerCount?: number | null;
  confidence?: number | null;
  entityKey?: string | null;
  role?: string | null;
  dormancy: { days7: boolean | null; days14: boolean | null; days30: boolean | null; days90: boolean | null } | null;
  validation: string;
}
function renderTokenIntelligenceSummary(
  tokenAddress: string,
  value: {
    tokens?: Array<{ name?: string | null; symbol?: string | null }>;
    metadata?: Array<{ name?: string | null; symbol?: string | null }>;
    candidateSelection?: {
      candidatesAnalyzed: number; infrastructureExcluded: number; exchangeExcluded: number;
      ownershipUnverified: number; unreliablePnl: number; validatedTraders: number;
      probableTraders: number; uniqueEntities: number;
      cohort: { medianAlpha: number | null; medianRoi: number | null; active: number; dormant: number; holding: number };
    };
  },
  analyzedRows: TokenPnlTelegramRow[],
  displayedRows: TokenPnlTelegramRow[]
) {
  const token = value.tokens?.[0] ?? value.metadata?.[0];
  const tokenLabel = token?.symbol || token?.name;
  const selection = value.candidateSelection;
  if (!displayedRows.length) return [
    '🎯 <b>TOKEN INTELLIGENCE</b>',
    `${tokenLabel ? `<b>${h(tokenLabel)}</b>  ·  ` : ''}<code>${h(short(tokenAddress, 6))}</code>`,
    '',
    '<b>No validated trader wallets found.</b>',
    '',
    `Candidates analyzed  <b>${selection?.candidatesAnalyzed ?? 0}</b>`,
    `Infrastructure excluded  <b>${selection?.infrastructureExcluded ?? 0}</b>`,
    `Ownership unverified  <b>${selection?.ownershipUnverified ?? 0}</b>`,
    `Unreliable PnL  <b>${selection?.unreliablePnl ?? 0}</b>`,
    `Unique entities  <b>${selection?.uniqueEntities ?? 0}</b>`
  ].join('\n');
  const alphaValues = analyzedRows.map((row) => row.qualityScore).filter(isNumber);
  const roiValues = analyzedRows.map((row) => row.medianRoi ?? row.roi).filter(isNumber);
  const statuses = analyzedRows.map((row) => tokenWalletStatus(row));
  return [
    '🎯 <b>TOKEN INTELLIGENCE</b>',
    `${tokenLabel ? `<b>${h(tokenLabel)}</b>  ·  ` : ''}<code>${h(short(tokenAddress, 6))}</code>`,
    '',
    `<b>${selection?.candidatesAnalyzed ?? analyzedRows.length}</b> candidates analyzed`,
    `<b>${selection?.infrastructureExcluded ?? 0}</b> infrastructure excluded  ·  <b>${selection?.validatedTraders ?? analyzedRows.length}</b> validated traders`,
    `<b>${selection?.uniqueEntities ?? new Set(analyzedRows.map((row) => row.entityKey ?? row.walletAddress)).size}</b> unique entities`,
    '',
    '📊 <b>COHORT</b>',
    `Median Alpha  <b>${formatScore(selection?.cohort.medianAlpha ?? median(alphaValues))}</b>  ·  Median ROI  <b>${roi(selection?.cohort.medianRoi ?? median(roiValues))}</b>`,
    `Active  <b>${selection?.cohort.active ?? statuses.filter((status) => status.kind === 'active').length}</b>  ·  Dormant  <b>${selection?.cohort.dormant ?? statuses.filter((status) => status.kind === 'dormant').length}</b>  ·  Holding  <b>${selection?.cohort.holding ?? statuses.filter((status) => status.kind === 'holding').length}</b>`,
    '',
    '<b>TOP ALPHA WALLETS</b>',
    ...displayedRows.map(renderTokenPnlWallet)
  ].join('\n');
}
function renderTokenPnlWallet(row: TokenPnlTelegramRow, index: number) {
  const status = tokenWalletStatus(row);
  const confidence = confidenceLabel(row.alphaConfidence ?? row.confidence);
  const positions = row.alphaSampleSize ?? 0;
  const related = (row.relatedWalletCount ?? 0) > 0 ? `  ·  ${row.relatedWalletCount} related` : '';
  return [
    '',
    `<b>${index + 1}.</b> <code>${h(short(row.walletAddress, 6))}</code>  ·  ${status.icon} <b>${h(status.label)}</b>`,
    `${alphaLabel(row.qualityScore)}  ·  ${h(confidence)} confidence  ·  ${positions} positions${related}`,
    `💰 <b>${signedMoney(row.realizedPnlUsd)}</b>  ·  Median ROI <b>${roi(row.medianRoi ?? row.roi)}</b>  ·  WR <b>${percentage(row.winRate)}</b>  ·  <i>${h(tokenIntelligenceSentence(row, status.kind))}</i>`
  ].join('\n');
}
type TokenWalletStatusKind = 'holding' | 'active' | 'dormant' | 'unknown' | 'exited';
function tokenWalletStatus(row: TokenPnlTelegramRow, now = Date.now()): { kind: TokenWalletStatusKind; icon: string; label: string } {
  if (row.status) {
    if (row.status === 'Holding') return { kind: 'holding', icon: '🟢', label: row.status };
    if (row.status === 'Accumulating') return { kind: 'active', icon: '🟢', label: row.status };
    if (row.status === 'Exited') return { kind: 'exited', icon: '🔴', label: row.status };
    if (row.status === 'Active Trader') return { kind: 'active', icon: '🟢', label: row.status };
    if (row.status === 'Dormant') return { kind: 'dormant', icon: '🟡', label: relativeLastSeen(row.lastActivityTs, 'dormant', now) };
    return { kind: 'unknown', icon: '⚪', label: 'Unknown' };
  }
  const lastSeen = timestamp(row.lastActivityTs ?? row.firstSellTs ?? row.firstBuyTs);
  const ageDays = lastSeen == null ? null : Math.max(0, (now - lastSeen) / 86_400_000);
  const exited = row.remainingPositionUsd != null && row.remainingPositionUsd <= 0
    || row.firstSellTs != null && row.boughtUsd != null && row.soldUsd != null && row.soldUsd >= row.boughtUsd;
  if (exited) return { kind: 'exited', icon: '🔴', label: 'Exited' };
  if (ageDays != null && ageDays >= 14) return { kind: 'dormant', icon: '🟡', label: `Dormant ${Math.floor(ageDays)}d` };
  if (ageDays != null && ageDays < 7) return { kind: 'active', icon: '🟢', label: 'Active Trader' };
  if (row.remainingPositionUsd != null && row.remainingPositionUsd > 0 || row.boughtUsd != null && row.firstSellTs == null) {
    return { kind: 'holding', icon: '🟢', label: 'Holding' };
  }
  return { kind: 'unknown', icon: '⚪', label: 'Unknown' };
}
function tokenIntelligenceSentence(row: TokenPnlTelegramRow, status: TokenWalletStatusKind) {
  if (row.intelligenceReason) return row.intelligenceReason;
  const role = (row.role ?? '').toLowerCase();
  if (status === 'dormant' || row.dormancy && Object.values(row.dormancy).some((value) => value === true)) return 'Dormant high-alpha wallet.';
  if ((row.finalRankingScore ?? 0) >= 80) return 'High-conviction trader.';
  if (role.includes('funder') || role.includes('funding') || role.includes('treasury') || role.includes('root')) return 'Core funder.';
  if (role.includes('execution') || role.includes('side')) return 'Execution wallet.';
  if ((row.repeatRunnerCount ?? 0) >= 2) return 'Repeated winner.';
  if ((row.qualityScore ?? 0) >= 80) return 'High-alpha trader.';
  if ((row.realizedPnlUsd ?? 0) > 0) return 'Profitable token trader.';
  return 'Historical token trader.';
}
function alphaLabel(value: number | null | undefined) {
  if (value == null) return '⚪ <b>Alpha N/A</b>';
  const icon = value >= 80 ? '🟢' : value >= 60 ? '🟡' : '⚪';
  return `${icon} <b>Alpha ${Math.round(value)}</b>`;
}
function median(values: number[]) { if (!values.length) return null; const sorted = [...values].sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2; }
function formatScore(value: number | null | undefined) { return value == null ? 'N/A' : String(Math.round(value)); }
function percentage(value: number | null | undefined) { return value == null ? 'N/A' : `${Math.round(value * 100)}%`; }
function confidenceLabel(value: number | null | undefined) { if (value == null) return 'Low'; const normalized = value > 1 ? value / 100 : value; return normalized >= 0.7 ? 'High' : normalized >= 0.4 ? 'Medium' : 'Low'; }
function isNumber(value: number | null | undefined): value is number { return typeof value === 'number' && Number.isFinite(value); }
function timestamp(value: string | null | undefined) { if (!value) return null; const result = new Date(value).getTime(); return Number.isFinite(result) ? result : null; }
function relativeLastSeen(value: string | null | undefined, status: TokenWalletStatusKind, now = Date.now()) {
  const observed = timestamp(value);
  if (observed == null) return 'Unknown';
  const seconds = Math.max(0, Math.floor((now - observed) / 1_000));
  const days = Math.floor(seconds / 86_400);
  if (status === 'dormant') return `Dormant ${days}d`;
  if (seconds < 3_600) return seconds < 120 ? 'Just now' : `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ago`;
  return `${days}d ago`;
}
function tokenPnlKeyboard(rows: TokenPnlTelegramRow[]): InlineKeyboard {
  return { inline_keyboard: rows.map((row, index) => [
    { text: `Copy #${index + 1}`, copy_text: { text: row.walletAddress } },
    { text: 'Explorer ↗', url: walletExplorer(row.chain, row.walletAddress) }
  ]) };
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
function formatAmount(amountUsd: number | null, amountToken: string | null, symbol: string | null) {
  if (amountUsd != null) return plainMoney(amountUsd);
  return amountToken ? `${h(amountToken)} ${h(symbol ?? '')}`.trim() : 'unpriced';
}
function plainMoney(value: number | null) { return value == null ? 'n/a' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value); }
function signedMoney(value: number | null) { if (value == null) return 'n/a'; return `${value >= 0 ? '+' : '-'}${plainMoney(Math.abs(value))}`; }
function roi(value: number | null) { return value == null ? 'n/a' : `${Math.round(value * 100).toLocaleString('en-US')}%`; }
function prettyLabel(value: string) { return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function renderCoreListItem(wallet: CoreWalletListItem, rank: number) {
  return [
    `<b>${rank}. ${h(wallet.label)}</b>  ${wallet.status === 'Active' ? '🟢' : '🌙'}`,
    `<code>${h(wallet.address)}</code>`,
    `${wallet.chains.map((chain) => h(chain)).join(' · ')}  ·  ${h(wallet.status)}`,
    `Alpha <b>${score(wallet.historicalAlpha)}</b>  ·  Evidence <b>${score(wallet.evidence)}</b>`,
    `Last activity  <b>${formatTelegramDate(wallet.lastActivity)}</b>`,
    `Priority  <b>${h(prettyLabel(wallet.monitoringPriority))}</b>`
  ].join('\n');
}
function corePagination(sessionId: string, page: number, hasNext: boolean): InlineKeyboard['inline_keyboard'] {
  const row: InlineKeyboard['inline_keyboard'][number] = [];
  if (page > 1) row.push({ text: '‹ Previous', callback_data: callback('page', sessionId, String(page - 1)) });
  if (hasNext) row.push({ text: 'Next ›', callback_data: callback('page', sessionId, String(page + 1)) });
  return row.length ? [row] : [];
}
function score(value: number | null) { return value == null ? 'n/a' : `${Math.round(value)}/100`; }
function money(value: number) { return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: value >= 1_000 ? 0 : 2 }).format(value); }
function compactAmount(value: string) { const number = Number(value); return Number.isFinite(number) ? new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 }).format(number) : value; }
function formatTelegramDate(value: string | null) { if (!value) return 'Never observed'; const date = new Date(value); return Number.isNaN(date.getTime()) ? h(value) : `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 16)} UTC`; }
function eventIcon(value: string) { if (/buy|deployment/i.test(value)) return '🎯'; if (/bridge/i.test(value)) return '🌉'; if (/fund|transfer/i.test(value)) return '💸'; if (/dormant|awaken/i.test(value)) return '😴'; return '📡'; }
function requestFailure(error: unknown) { return `🔴 <b>REQUEST FAILED</b>\n━━━━━━━━━━━━━━━━━━━━\n${h(errorMessage(error))}\n\n<i>No intelligence conclusion was changed.</i>`; }
function tokenProgress(target: string) {
  return [
    '🎯 <b>TOKEN INTELLIGENCE</b>',
    `Token: <code>${h(short(target, 7))}</code>`,
    '',
    '✓ Token received. Analysis started…',
    '<i>Loading persisted intelligence and running the live investigation.</i>'
  ].join('\n');
}
function tokenAnalysisFailure(target: string, sessionId: string) {
  return {
    text: [
      '🔴 <b>TOKEN ANALYSIS FAILED</b>',
      '',
      'Token:',
      `<code>${h(short(target, 7))}</code>`,
      '',
      'Reason:',
      'Internal database query failed.'
    ].join('\n'),
    keyboard: { inline_keyboard: [[
      { text: 'Retry', callback_data: callback('tokenretry', sessionId, 'run') },
      { text: 'Back', callback_data: callback('tokenback', sessionId, 'menu') }
    ]] }
  } satisfies { text: string; keyboard: InlineKeyboard };
}
function logTokenAnalysisFailure(sessionId: string, target: string, error: unknown) {
  console.error(`[telegram] token analysis failed session=${sessionId} target=${target}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
}
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
function walletProgress(target: string, stage: 'received' | 'running' | 'resumed') {
  const label = stage === 'received' ? '✓ Wallet received' : stage === 'resumed' ? '✓ Runtime resumed' : '🔄 Investigation running';
  const detail = stage === 'received' ? 'Preparing production investigation…' : 'Fetching transactions\n↓\nResolving entity\n↓\nRanking intelligence';
  return `🧠 <b>WALLET INVESTIGATION</b>\n━━━━━━━━━━━━━━━━━━━━\n<code>${h(short(target, 7))}</code>\n\n${label}\n${detail}`;
}
function duration(seconds: number) { if (seconds < 60) return `${seconds}s`; if (seconds < 3600) return `${Math.round(seconds / 60)}m`; if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`; return `${Math.round(seconds / 86_400)}d`; }
function parseCommand(text: string) { const match = text.trim().match(/^\/([a-z_]+)(?:@[a-z0-9_]+)?(?:\s+([\s\S]+))?$/i); return { command: match?.[1]?.toLowerCase() ?? '', argument: match?.[2]?.trim() ?? '' }; }
function parseCallback(value: string | undefined) { const parts = value?.split('|'); return parts?.length === 4 && parts[0] === 'v1' ? { action: parts[1], sessionId: parts[2], value: parts[3] } : null; }
function required(state: OperatorSessionState) { if (!state.target) throw new Error('Target is required'); return state.target; }
function help() {
  return [
    '━━━━━━━━━━━━━━━━━━━━',
    '🧠 <b>FLOWRADAR INTELLIGENCE</b>',
    '━━━━━━━━━━━━━━━━━━━━',
    '<i>On-chain entity, capital-flow and alpha intelligence.</i>',
    '',
    '🎯 <b>INVESTIGATE</b>',
    '<code>/wallet</code>  Wallet & entity intelligence',
    '<code>/token</code>  Top-PnL wallet discovery',
    '<code>/entity</code>  Entity cluster',
    '',
    '💸 <b>TRACE</b>',
    '<code>/flow</code>  Capital paths',
    '<code>/bridges</code>  Cross-chain routes',
    '',
    '📈 <b>DISCOVER</b>',
    '<code>/profitable</code>  Ranked wallets',
    '<code>/recent</code>  Live intelligence feed',
    '',
    '👁 <b>MONITOR</b>',
    '<code>/list</code>  Core wallet control panel',
    '<code>/alerts</code>  Production alert inbox',
    '<code>/add</code>  Add Core wallet',
    '<code>/remove</code>  Stop Core monitoring',
    '<code>/watch &lt;wallet-or-entity&gt;</code>',
    '',
    '<i>Select a command. FlowRadar will request the required address.</i>'
  ].join('\n');
}
function errorMessage(error: unknown) { return error instanceof Error ? error.message : String(error); }
