// FlowRadar — createTelegramSender tests (Task 16 binding decision 4).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTelegramSender } from '../src/telegram';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createTelegramSender', () => {
  it('returns null when TELEGRAM_BOT_TOKEN is missing', () => {
    const sender = createTelegramSender({ TELEGRAM_CHAT_ID: '12345' });
    expect(sender).toBeNull();
  });

  it('returns null when TELEGRAM_CHAT_ID is missing', () => {
    const sender = createTelegramSender({ TELEGRAM_BOT_TOKEN: 'bot-token' });
    expect(sender).toBeNull();
  });

  it('returns null when both are missing', () => {
    const sender = createTelegramSender({});
    expect(sender).toBeNull();
  });

  it('returns null when either value is an empty string', () => {
    expect(createTelegramSender({ TELEGRAM_BOT_TOKEN: '', TELEGRAM_CHAT_ID: '12345' })).toBeNull();
    expect(createTelegramSender({ TELEGRAM_BOT_TOKEN: 'bot-token', TELEGRAM_CHAT_ID: '' })).toBeNull();
  });

  it('POSTs to the correct Telegram Bot API URL with the correct body when both env vars are present', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => 'ok'
    });
    vi.stubGlobal('fetch', fetchMock);

    const sender = createTelegramSender({ TELEGRAM_BOT_TOKEN: 'abc123', TELEGRAM_CHAT_ID: '999' });
    expect(sender).not.toBeNull();

    await sender!.send('hello world');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.telegram.org/botabc123/sendMessage');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({
      chat_id: '999',
      text: 'hello world',
      parse_mode: 'HTML',
      disable_web_page_preview: true
    });
  });

  it('throws (with the response body in the message) when Telegram returns a non-2xx response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: async () => '{"ok":false,"description":"chat not found"}'
    });
    vi.stubGlobal('fetch', fetchMock);

    const sender = createTelegramSender({ TELEGRAM_BOT_TOKEN: 'abc123', TELEGRAM_CHAT_ID: '999' });

    await expect(sender!.send('hello')).rejects.toThrow(/400/);
    await expect(sender!.send('hello')).rejects.toThrow(/chat not found/);
  });
});
