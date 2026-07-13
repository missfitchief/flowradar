import { OperatorService } from '@flowradar/db';
import { TELEGRAM_COMMANDS, createUpdateHandler } from './handlers';
import type { TelegramApi } from './types';

export async function runLongPolling(options: { service: OperatorService; api: TelegramApi; allowedUserIds: ReadonlySet<string>; signal?: AbortSignal; log?: Pick<Console, 'info' | 'error'> }) {
  const log = options.log ?? console;
  const me = await options.api.getMe();
  const botKey = `${me.id}:${me.username ?? 'bot'}`;
  await options.api.deleteWebhook();
  await options.api.setMyCommands(TELEGRAM_COMMANDS);
  let offset = await options.service.getCursor(botKey);
  let retry = 0;
  let lastAlertsAt = 0;
  log.info(`[telegram] @${me.username ?? me.id} polling started`);
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

async function dispatchWatchAlerts(service: OperatorService, api: TelegramApi) {
  await service.materializeWatchAlerts();
  for (const alert of await service.pendingWatchAlerts(100)) {
    try {
      const payload = alert.payloadJson as Record<string, unknown>;
      const text = `<b>FlowRadar · ${escape(String(alert.alertType))}</b>\n${Object.entries(payload).map(([key, value]) => `${escape(key)}: ${escape(String(value ?? 'n/a'))}`).join('\n')}`;
      await api.sendMessage(alert.watch.chatId, text);
      await service.markWatchAlert(alert.id);
    } catch (error) { await service.markWatchAlert(alert.id, error instanceof Error ? error.message : String(error)); }
  }
}

function escape(value: string) { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'); }
function delay(ms: number, signal?: AbortSignal) { return new Promise<void>((resolve) => { const timer = setTimeout(resolve, ms); signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true }); }); }
