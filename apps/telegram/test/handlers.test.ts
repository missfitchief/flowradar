import { describe, expect, it, vi } from 'vitest';
import type { OperatorService } from '@flowradar/db';
import { createUpdateHandler } from '../src/handlers';
import type { TelegramApi } from '../src/types';

function apiMock(): TelegramApi {
  return {
    getMe: vi.fn(), deleteWebhook: vi.fn(), setMyCommands: vi.fn(), getUpdates: vi.fn(),
    sendMessage: vi.fn(), editMessage: vi.fn(), answerCallbackQuery: vi.fn(), sendDocument: vi.fn()
  } as unknown as TelegramApi;
}

describe('Telegram command handlers', () => {
  it('rejects unauthorized users before any service query', async () => {
    const api = apiMock();
    const service = { profitable: vi.fn() } as unknown as OperatorService;
    await createUpdateHandler(service, api, new Set(['123']))({ update_id: 1, message: { message_id: 1, from: { id: 999 }, chat: { id: 999, type: 'private' }, text: '/profitable' } });
    expect(service.profitable).not.toHaveBeenCalled();
    expect(api.sendMessage).toHaveBeenCalledWith('999', '<b>Unauthorized.</b>');
  });

  it('uses service pagination for an authorized /profitable command', async () => {
    const api = apiMock();
    const service = {
      createSession: vi.fn().mockResolvedValue({ id: 'session1' }),
      profitable: vi.fn().mockResolvedValue({ items: [], page: 1, pageSize: 10, total: 0, hasNext: false, coverageWarnings: [] })
    } as unknown as OperatorService;
    await createUpdateHandler(service, api, new Set(['123']))({ update_id: 1, message: { message_id: 1, from: { id: 123 }, chat: { id: 123, type: 'private' }, text: '/profitable' } });
    expect(service.profitable).toHaveBeenCalledWith({ chain: 'ALL', sort: 'pnl', page: 1, pageSize: 10 });
    expect(api.sendMessage).toHaveBeenCalledOnce();
  });
});
