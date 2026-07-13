import type { InlineKeyboard, TelegramApi, TelegramUpdate } from './types';

const BASE = 'https://api.telegram.org';

export function createTelegramApi(token: string, fetchImpl: typeof fetch = fetch): TelegramApi {
  if (!token.trim()) throw new Error('TELEGRAM_BOT_TOKEN is required');
  const call = async <T>(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> => {
    const response = await fetchImpl(`${BASE}/bot${token}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal
    });
    const payload = await response.json().catch(() => null) as { ok?: boolean; result?: T; description?: string } | null;
    if (!response.ok || !payload?.ok) throw new Error(`Telegram ${method} failed (${response.status}): ${payload?.description ?? 'unknown response'}`);
    return payload.result as T;
  };
  return {
    getMe: () => call('getMe', {}),
    async deleteWebhook() { await call('deleteWebhook', { drop_pending_updates: false }); },
    async setMyCommands(commands) { await call('setMyCommands', { commands }); },
    getUpdates: (offset, signal) => call<TelegramUpdate[]>('getUpdates', { offset: Number(offset), limit: 100, timeout: 25, allowed_updates: ['message', 'callback_query'] }, signal),
    async sendMessage(chatId, text, keyboard) { await call('sendMessage', messageBody(chatId, text, keyboard)); },
    async editMessage(chatId, messageId, text, keyboard) { await call('editMessageText', { ...messageBody(chatId, text, keyboard), message_id: messageId }); },
    async answerCallbackQuery(id, text) { await call('answerCallbackQuery', { callback_query_id: id, ...(text ? { text: text.slice(0, 200) } : {}) }); },
    async sendDocument(chatId, filename, content, mimeType, caption) {
      const form = new FormData();
      form.set('chat_id', chatId);
      form.set('document', new Blob([content], { type: mimeType }), filename);
      if (caption) form.set('caption', caption.slice(0, 1_024));
      const response = await fetchImpl(`${BASE}/bot${token}/sendDocument`, { method: 'POST', body: form });
      const payload = await response.json().catch(() => null) as { ok?: boolean; description?: string } | null;
      if (!response.ok || !payload?.ok) throw new Error(`Telegram sendDocument failed (${response.status}): ${payload?.description ?? 'unknown response'}`);
    }
  };
}

function messageBody(chatId: string, text: string, keyboard?: InlineKeyboard) {
  return { chat_id: chatId, text: text.slice(0, 4_096), parse_mode: 'HTML', disable_web_page_preview: true, ...(keyboard ? { reply_markup: keyboard } : {}) };
}
