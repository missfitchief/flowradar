import { describe, expect, it, vi } from 'vitest';
import { createTelegramApi } from '../src/api';

describe('Telegram API runtime handling', () => {
  it('ignores message-is-not-modified from editMessageText', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false, description: 'Bad Request: message is not modified' }), { status: 400, headers: { 'content-type': 'application/json' } }));
    const api = createTelegramApi('test-token', fetchImpl);
    await expect(api.editMessage('1', 1, 'same text', { inline_keyboard: [] })).resolves.toBeUndefined();
  });
});
