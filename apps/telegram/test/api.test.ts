import { describe, expect, it, vi } from 'vitest';
import { createTelegramApi, isTelegramRecipientUnavailable } from '../src/api';

describe('Telegram API runtime handling', () => {
  it('ignores message-is-not-modified from editMessageText', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false, description: 'Bad Request: message is not modified' }), { status: 400, headers: { 'content-type': 'application/json' } }));
    const api = createTelegramApi('test-token', fetchImpl);
    await expect(api.editMessage('1', 1, 'same text', { inline_keyboard: [] })).resolves.toBeUndefined();
  });

  it('recognizes permanent recipient failures without matching transient errors', () => {
    expect(isTelegramRecipientUnavailable(new Error('Telegram sendMessage failed (403): Forbidden: bot was blocked by the user'))).toBe(true);
    expect(isTelegramRecipientUnavailable(new Error('Telegram sendMessage failed (400): Bad Request: chat not found'))).toBe(true);
    expect(isTelegramRecipientUnavailable(new Error('Telegram sendMessage failed (429): Too Many Requests'))).toBe(false);
  });
});
