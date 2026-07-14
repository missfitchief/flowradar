import {
  OperatorService,
  type InvestigationDeployment,
  type InvestigationMember,
  type InvestigationPath,
  type OperatorSessionState,
  type OperatorWorkflow,
  type ProfitableSort,
  type WalletInvestigationResult
} from '@flowradar/db';
import { isAuthorized } from './auth';
import { renderInvestigationReport, renderRefreshFailure, renderRefreshProgress } from './investigationRenderer';
import { parseIntelligenceAlertCallback, renderIntelligenceAlert } from './intelligenceAlertRenderer';
import { callback, exportKeyboard, h, navKeyboard, renderProfitable, short } from './render';
import type { InlineKeyboard, TelegramApi, TelegramCallbackQuery, TelegramMessage, TelegramUpdate } from './types';

const COMMANDS = [
  { command: 'wallet', description: 'Unified wallet investigation' }, { command: 'token', description: 'Token + top-PnL wallets' },
  { command: 'profitable', description: 'Automatic profitable wallets' }, { command: 'entity', description: 'Investigation cluster wallets' },
  { command: 'flow', description: 'Investigation capital paths' }, { command: 'bridges', description: 'Verified investigation bridges' },
  { command: 'watch', description: 'Persist a wallet/entity watch' }, { command: 'recent', description: 'Recent relevant events' },
  { command: 'cancel', description: 'Cancel pending input' }
];
const PENDING_PROMPTS: Partial<Record<OperatorWorkflow, string>> = {
  wallet: 'Pošalji wallet adresu.', token: 'Pošalji token CA.', entity: 'Pošalji wallet ili entity ID.',
  flow: 'Pošalji wallet ili entity.', bridges: 'Pošalji wallet ili entity.'
};
const INVESTIGATION_WORKFLOWS = new Set<OperatorWorkflow>(['wallet', 'entity', 'flow', 'bridges']);
const EMPTY_KEYBOARD: InlineKeyboard = { inline_keyboard: [] };
const activeWalletInvestigationJobs = new Map<string, Promise<void>>();
const activeWalletRefreshJobs = new Map<string, Promise<void>>();
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
        await api.sendMessage(chatId, `<b>Watch enabled</b>\n${h(watch.targetType)}: <code>${h(watch.targetKey)}</code>\nNoise events are suppressed.`);
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
      await api.sendMessage(chatId, `<b>Request failed</b>\n${h(errorMessage(error))}`);
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
    await api.sendMessage(chatId, `<b>Request failed</b>\n${h(errorMessage(error))}`);
  }
}

async function handleCallback(service: OperatorService, api: TelegramApi, allowed: ReadonlySet<string>, query: TelegramCallbackQuery) {
  const chatId = query.message ? String(query.message.chat.id) : '';
  if (!isAuthorized(allowed, query.from.id) || !chatId) { await api.answerCallbackQuery(query.id, 'Unauthorized'); return; }
  const userId = String(query.from.id);
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
      const nextState = { ...state, page: 1 };
      if (workflow === 'wallet') nextState.investigationStatus = 'queued';
      const next = await service.createSession(userId, chatId, workflow, nextState);
      if (workflow === 'wallet') {
        await editIfChanged(api, query, 'Wallet primljen. Pokrećem analizu…', EMPTY_KEYBOARD);
        enqueueWalletInvestigation(service, api, userId, chatId, nextState, next.id);
        await api.sendMessage(chatId, 'Wallet Investigation je pokrenut. Skeniram stvarne on-chain tokove kapitala; rezultat će stići ovde po završetku.');
        await api.answerCallbackQuery(query.id, 'Investigation started');
        return;
      }
      const rendered = await renderWorkflow(service, workflow, nextState, next.id);
      await editIfChanged(api, query, rendered.text, rendered.keyboard);
      await api.answerCallbackQuery(query.id);
      return;
    }
    if (parsed.action === 'exportmenu') {
      await editIfChanged(api, query, `${h(query.message?.text ?? 'FlowRadar result')}\n\n<b>Izvoz</b>\nIzaberi format.`, exportKeyboard(session.id));
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

async function sendWorkflow(service: OperatorService, api: TelegramApi, userId: string, chatId: string, workflow: OperatorWorkflow, target?: string) {
  const state = defaultState(target);
  if (workflow === 'wallet') state.investigationStatus = 'queued';
  const session = await service.createSession(userId, chatId, workflow, state);
  if (workflow === 'wallet') {
    await api.sendMessage(chatId, 'Wallet primljen. Pokrećem analizu…');
    console.info(`[telegram] wallet acknowledgement delivered session=${session.id} target=${target ?? ''}`);
    await service.clearPendingSession(userId, chatId);
    enqueueWalletInvestigation(service, api, userId, chatId, state, session.id);
    await api.sendMessage(chatId, 'Wallet Investigation je pokrenut. Skeniram stvarne on-chain tokove kapitala; rezultat će stići ovde po završetku.');
    console.info(`[telegram] wallet progress delivered session=${session.id} target=${target ?? ''}`);
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
    if (resumed) await api.sendMessage(chatId, 'Wallet Investigation je nastavljen nakon restarta procesa.');
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
      await api.sendMessage(chatId, `<b>Wallet Investigation nije uspela</b>\n${h(message)}\nPokušaj ponovo komandom <code>/wallet</code>.`);
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
  if (query) await editIfChanged(api, query, rendered.text, rendered.keyboard);
  else await api.sendMessage(chatId, rendered.text, rendered.keyboard);
}

async function renderPersistedInvestigation(service: OperatorService, state: OperatorSessionState, sessionId: string) {
  const investigation = await service.loadWalletInvestigation(state.investigationId ?? required(state));
  if (!investigation) throw new Error('Investigation is no longer available. Use Refresh.');
  return renderInvestigation(investigation, state, sessionId);
}

async function renderWorkflow(service: OperatorService, workflow: OperatorWorkflow, state: OperatorSessionState, sessionId: string): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const page = state.page || 1;
  const size = state.pageSize || 10;
  if (INVESTIGATION_WORKFLOWS.has(workflow)) return renderPersistedInvestigation(service, state, sessionId);
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
  const value = await service.recent(page, size);
  const text = [`<b>Recent relevant events</b> · page ${page} · ${value.total} total`, ...value.items.map((row) => `${h(row.chain)} <b>${h(row.kind)}</b> ${h(short(row.source))}→${h(short(row.destination))} · ${h(row.amountUsd ?? 'n/a')} · score ${h(row.score)}`)].join('\n');
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
  if (view === 'priority' || view === 'paths') return renderFindingPage('NAJVAŽNIJE PUTANJE', presentation.priorityFindings, page, sessionId, 'p');
  if (view === 'deployments') return renderFindingPage('TOKEN DEPLOYMENTS', presentation.deploymentFindings, page, sessionId, 'd');
  if (view === 'bridges') return renderFindingPage('BRIDGES', presentation.bridgeFindings, page, sessionId, 'b');
  if (view === 'alts') return renderOperatorAltWallets(presentation, page, sessionId);
  if (view === 'cluster') return renderOperatorCluster(presentation, page, sessionId);
  if (view === 'advanced') return renderAdvanced(presentation, page, sessionId);
  if (view === 'receivers') return renderGroupReceivers(presentation, state.investigationItem, page, sessionId);
  return renderOperatorEvidence(presentation, state.investigationItem, sessionId);
}

function renderOperatorSummary(value: WalletInvestigationResult, presentation: InvestigationPresentation, sessionId: string) {
  const chains = value.activityChains.length ? value.activityChains.map(chainLabel).join(', ') : 'nema potvrđene aktivnosti';
  const highlights = presentation.priorityFindings.slice(0, 3);
  const findings = highlights.length
    ? ['<b>Najvažniji nalazi:</b>', ...highlights.map((finding, index) => renderSummaryFinding(finding, index + 1))]
    : [
        '<b>Nisu pronađene high-priority putanje.</b>',
        `- Ukupno relacija analizirano: ${presentation.totalRelations}`,
        `- Noise/infrastructure: ${presentation.noiseInfrastructure}`,
        `- Low priority: ${presentation.lowPriorityRelations}`,
        `- Coverage kompletna: ${presentation.completeCoverageChains}/${value.coverage.length} chainova`
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
    '<b>Rezultati:</b>',
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
      [{ text: 'Najvažnije putanje', callback_data: callback('invest', sessionId, 'priority') }],
      [{ text: 'Token deployments', callback_data: callback('invest', sessionId, 'deployments') }],
      [{ text: 'Alt / execution walleti', callback_data: callback('invest', sessionId, 'alts') }],
      [{ text: 'Bridges', callback_data: callback('invest', sessionId, 'bridges') }],
      [{ text: 'Ceo cluster', callback_data: callback('invest', sessionId, 'cluster') }],
      [{ text: 'Advanced / svi rezultati', callback_data: callback('invest', sessionId, 'advanced') }]
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
    `<b>${title}</b> · strana ${page} · ${rows.length} ukupno`,
    ...(items.length
      ? items.map((finding, index) => renderOperatorFinding(finding, (page - 1) * 5 + index + 1))
      : ['Nisu pronađene high-priority putanje.'])
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
    'CEO CLUSTER',
    `Strong: ${counts.get('Confirmed/strong relationships') ?? 0} · Probable alt/execution: ${counts.get('Probable alt/execution wallets') ?? 0}`,
    `Possible: ${counts.get('Possible relationships') ?? 0} · Infrastructure excluded: ${counts.get('Infrastructure excluded') ?? 0}`
  ].join('\n'), presentation.clusterMembers, page, sessionId);
}

function renderClusterPage(title: string, rows: PresentedClusterMember[], page: number, sessionId: string) {
  const { items, hasNext } = pageRows(rows, page, 5);
  const text = [
    `<b>${title}</b> · strana ${page} · ${rows.length} ukupno`,
    ...(items.length ? items.map((row, index) => renderPresentedClusterMember(row, (page - 1) * 5 + index + 1)) : ['Nema walleta u ovoj kategoriji.'])
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
    `<b>ADVANCED / SVI REZULTATI</b> · strana ${page}`,
    `${presentation.totalRelations} relacija · ${presentation.relationGroups.length} grupisanih događaja`,
    ...(items.length ? items.map((group, index) => renderRelationGroup(group, (page - 1) * 5 + index + 1)) : ['Nema persistovanih relacija.'])
  ].join('\n\n');
  const buttons = items.flatMap((group, index) => {
    const selector = String((page - 1) * 5 + index);
    const row: InlineKeyboard['inline_keyboard'][number] = [];
    if (group.sourceTxHash) row.push({ text: 'Source tx', url: transactionExplorer(group.sourceChain, group.sourceTxHash) });
    if (group.receivers.length === 1) row.push({ text: 'Receiver', url: walletExplorer(group.receivers[0].chain, group.receivers[0].address) });
    else row.push({ text: `Prikaži ${group.receivers.length} receivera`, callback_data: callback('receivers', sessionId, selector) });
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
    `- ${group.receivers.length} receiver walleta`,
    `- ukupno poslato: ${formatAmount(group.totalAmountUsd, group.amountToken, group.assetSymbol)}`,
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
  if (!group) return { text: '<b>Receiver grupa više nije dostupna.</b>', keyboard: operatorBackKeyboard(sessionId) };
  const { items, hasNext } = pageRows(group.receivers, page, 5);
  const text = [
    `<b>${h(group.label)} · RECEIVERI</b> · strana ${page} · ${group.receivers.length} ukupno`,
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
    if (!group) return { text: '<b>Evidence više nije dostupan.</b>', keyboard: operatorBackKeyboard(sessionId) };
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
  if (!finding) return { text: '<b>Evidence više nije dostupan.</b>', keyboard: operatorBackKeyboard(sessionId) };
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
function pendingKeyboard(sessionId: string): InlineKeyboard { return { inline_keyboard: [[{ text: 'Back', callback_data: callback('cancel', sessionId, 'pending') }]] }; }
function defaultState(target?: string): OperatorSessionState { return { target, chain: 'ALL', sort: 'pnl', page: 1, pageSize: 10 }; }
function invalidTargetMessage(workflow: OperatorWorkflow) {
  if (workflow === 'token') return 'Token CA nije validan. Pošalji validan token CA.';
  if (workflow === 'wallet') return 'Wallet adresa nije validna. Pošalji Solana base58 adresu (32–44 znaka) ili EVM 0x adresu (40 hex znakova).';
  return 'Vrednost nije validna. Pošalji validan wallet ili postojeći entity ID.';
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
function dormancyFlag(value: boolean | null) { return value == null ? '?' : value ? 'yes' : 'no'; }
function duration(seconds: number) { if (seconds < 60) return `${seconds}s`; if (seconds < 3600) return `${Math.round(seconds / 60)}m`; if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`; return `${Math.round(seconds / 86_400)}d`; }
function parseCommand(text: string) { const match = text.trim().match(/^\/([a-z_]+)(?:@[a-z0-9_]+)?(?:\s+([\s\S]+))?$/i); return { command: match?.[1]?.toLowerCase() ?? '', argument: match?.[2]?.trim() ?? '' }; }
function parseCallback(value: string | undefined) { const parts = value?.split('|'); return parts?.length === 4 && parts[0] === 'v1' ? { action: parts[1], sessionId: parts[2], value: parts[3] } : null; }
function required(state: OperatorSessionState) { if (!state.target) throw new Error('Target is required'); return state.target; }
function help() { return [`<b>FlowRadar operator</b>`, ...COMMANDS.map((row) => `/${row.command} — ${h(row.description)}`), '', 'Izaberi komandu; bot će zatim tražiti potrebnu adresu.', '<code>/wallet</code>', '<code>/token</code>', '<code>/profitable</code>'].join('\n'); }
function errorMessage(error: unknown) { return error instanceof Error ? error.message : String(error); }
