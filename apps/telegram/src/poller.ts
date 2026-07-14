import { OperatorService } from '@flowradar/db';
import { isTelegramRecipientUnavailable } from './api';
import { TELEGRAM_COMMANDS, createUpdateHandler, resumeWalletInvestigationJobs } from './handlers';
import { renderIntelligenceAlert } from './intelligenceAlertRenderer';
import type { TelegramApi } from './types';

export async function runLongPolling(options: { service: OperatorService; api: TelegramApi; allowedUserIds: ReadonlySet<string>; signal?: AbortSignal; log?: Pick<Console, 'info' | 'error'> }) {
  const log = options.log ?? console;
  const me = await options.api.getMe();
  const botKey = `${me.id}:${me.username ?? 'bot'}`;
  await options.api.deleteWebhook();
  await options.api.setMyCommands(TELEGRAM_COMMANDS);
  for (const userId of options.allowedUserIds) await options.service.ensureCoreWalletWatches(userId, userId);
  let offset = await options.service.getCursor(botKey);
  let retry = 0;
  let lastAlertsAt = 0;
  log.info(`[telegram] @${me.username ?? me.id} polling started`);
  const resumed = await resumeWalletInvestigationJobs(options.service, options.api);
  if (resumed) log.info(`[telegram] resumed ${resumed} wallet investigation job(s)`);
  while (!options.signal?.aborted) {
    try {
      const updates = await options.api.getUpdates(offset, options.signal);
      for (const update of updates.sort((a, b) => a.update_id - b.update_id)) {
        try {
          await createUpdateHandler(options.service, options.api, options.allowedUserIds)(update);
        } catch (error) {
          // One malformed/poison update must not stall the durable offset.
          log.error(`[telegram] update ${update.update_id} failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        offset = BigInt(update.update_id) + 1n;
        await options.service.setCursor(botKey, offset);
      }
      if (Date.now() - lastAlertsAt >= 30_000) {
        await dispatchWatchAlerts(options.service, options.api);
        lastAlertsAt = Date.now();
      }
      retry = 0;
    } catch (error) {
      if (options.signal?.aborted) break;
      retry += 1;
      const waitMs = Math.min(30_000, 500 * 2 ** Math.min(retry, 6));
      log.error(`[telegram] polling retry ${retry}: ${error instanceof Error ? error.message : String(error)}`);
      await delay(waitMs, options.signal);
    }
  }
}

export async function dispatchWatchAlerts(service: OperatorService, api: TelegramApi) {
  await service.materializeWatchAlerts();
  for (const alert of await service.pendingWatchAlerts(100)) {
    try {
      const payload = alert.payloadJson as Record<string, unknown>;
      if (alert.alertType === 'receiver_bought_token' && typeof payload.intelligenceSignalId === 'string') {
        const intelligence = await service.intelligenceAlert(alert.id);
        if (intelligence) {
          const rendered = renderIntelligenceAlert(intelligence);
          await api.sendMessage(alert.watch.chatId, rendered.text, rendered.keyboard);
        } else {
          await api.sendMessage(alert.watch.chatId, '📡 <b>FLOWRADAR SIGNAL</b>\n━━━━━━━━━━━━━━━━━━━━\n⚪ Signal receipt is no longer available.');
        }
      } else if (alert.watch.targetType === 'core_wallet') {
        await api.sendMessage(alert.watch.chatId, renderCoreMonitoringAlert(alert.alertType, payload));
      } else {
        await api.sendMessage(alert.watch.chatId, renderLegacyAlert(alert.alertType, payload));
      }
      await service.markWatchAlert(alert.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isTelegramRecipientUnavailable(error)) await service.stopTelegramDelivery(alert.watch.chatId, message);
      else await service.markWatchAlert(alert.id, message);
    }
  }
}

function renderCoreMonitoringAlert(type: string, payload: Record<string, unknown>) {
  const title = typeof payload.title === 'string' ? payload.title : pretty(type);
  const wallets = Array.isArray(payload.wallets) ? payload.wallets.filter((value): value is string => typeof value === 'string') : [];
  const wallet = typeof payload.wallet === 'string' ? payload.wallet : null;
  const ca = typeof payload.ca === 'string' ? payload.ca : null;
  const confidence = typeof payload.relationshipConfidence === 'number' ? `${Math.round(payload.relationshipConfidence * 100)}%` : null;
  return [
    '📡 <b>CORE WALLET SIGNAL</b>',
    '━━━━━━━━━━━━━━━━━━━━',
    `⚡ <b>${escape(title.toUpperCase())}</b>`,
    '',
    ...(wallet ? [`Wallet\n<code>${escape(wallet)}</code>`] : []),
    ...(wallets.length ? [`Wallets\n${wallets.slice(0, 8).map((value) => `<code>${escape(value)}</code>`).join('\n')}`] : []),
    ...(payload.coreWallet ? [`Core source\n<code>${escape(String(payload.coreWallet))}</code>`] : []),
    ...(payload.connection ? [`Connection  <b>${escape(pretty(String(payload.connection)))}</b>${confidence ? ` · ${confidence}` : ''}`] : []),
    ...(payload.token || payload.symbol ? [`Token  <b>${escape(String(payload.token ?? payload.symbol))}</b>`] : []),
    ...(ca ? [`CA\n<code>${escape(ca)}</code>`] : []),
    ...(payload.amountUsd != null ? [`Amount  <b>$${Number(payload.amountUsd).toLocaleString('en-US')}</b>`] : []),
    ...(payload.reason ? ['', `<i>${escape(String(payload.reason))}</i>`] : []),
    '', '<i>Observation-only monitoring · no trade execution.</i>'
  ].join('\n');
}

function escape(value: string) { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'); }
function renderLegacyAlert(type: string, payload: Record<string, unknown>) {
  const visibleKeys = ['token', 'symbol', 'wallet', 'entity', 'chain', 'amountUsd', 'status'];
  const details = visibleKeys.flatMap((key) => payload[key] === undefined ? [] : [`${pretty(key)}  <b>${escape(String(payload[key] ?? 'Unknown'))}</b>`]).slice(0, 5);
  return [
    '📡 <b>FLOWRADAR MONITOR</b>',
    '━━━━━━━━━━━━━━━━━━━━',
    `⚠️ <b>${escape(pretty(type).toUpperCase())}</b>`,
    '',
    ...(details.length ? details : ['⚪ No structured intelligence details are available.']),
    '',
    '<i>Legacy monitor event · no ownership conclusion implied.</i>'
  ].join('\n');
}
function pretty(value: string) { return value.replace(/([A-Z])/g, ' $1').replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()).trim(); }
function delay(ms: number, signal?: AbortSignal) { return new Promise<void>((resolve) => { const timer = setTimeout(resolve, ms); signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true }); }); }
