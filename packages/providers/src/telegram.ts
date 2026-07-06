// FlowRadar — Telegram alert sender (Task 16 binding decision 4).
//
// Normative source: Spec §2 "Telegram: raw Bot API via fetch (no SDK dep)",
// Spec §9 "Raw Bot API sendMessage (HTML), TELEGRAM_BOT_TOKEN +
// TELEGRAM_CHAT_ID", Task 16 task brief: "Sender: fetch
// https://api.telegram.org/bot${token}/sendMessage; missing token => Alert
// row with deliveryStatus skipped_no_token."
//
// Node v24.17.0 (Spec §2 environment facts) ships a native global `fetch` —
// no node-fetch/undici dependency needed, matching every other provider file
// in this package (none of which pull in an HTTP client dependency either).

export interface TelegramSender {
  send(text: string): Promise<void>;
}

export interface TelegramSenderEnv {
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
}

const TELEGRAM_API_BASE = 'https://api.telegram.org';

/**
 * Constructs a TelegramSender from env vars, or returns `null` when either
 * TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is missing/empty — callers (the
 * alertDispatch job, the /api/alerts/test route) treat a null sender as "no
 * delivery channel configured" and persist Alert rows with deliveryStatus
 * 'skipped_no_token' instead of attempting a send (Task 16 binding decision
 * 3/4). This function itself never throws.
 */
export function createTelegramSender(env: TelegramSenderEnv): TelegramSender | null {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    return null;
  }

  return {
    async send(text: string): Promise<void> {
      const url = `${TELEGRAM_API_BASE}/bot${token}/sendMessage`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true
        })
      });

      if (!response.ok) {
        const responseText = await response.text().catch(() => '<no response body>');
        throw new Error(`Telegram sendMessage failed (${response.status} ${response.statusText}): ${responseText}`);
      }
    }
  };
}
