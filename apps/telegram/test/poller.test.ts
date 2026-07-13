import { describe, expect, it, vi } from 'vitest';
import type { OperatorService } from '@flowradar/db';
import { dispatchWatchAlerts } from '../src/poller';
import type { TelegramApi } from '../src/types';

describe('Telegram watch alert delivery', () => {
  it('disables delivery for a blocked chat without throwing or retrying the alert', async () => {
    const service = {
      materializeWatchAlerts: vi.fn(),
      pendingWatchAlerts: vi.fn().mockResolvedValue([{
        id: 'alert1', alertType: 'receiver_bought_token', payloadJson: { token: 'NEW' }, watch: { chatId: '123' }
      }]),
      markWatchAlert: vi.fn(),
      stopTelegramDelivery: vi.fn()
    } as unknown as OperatorService;
    const api = {
      sendMessage: vi.fn().mockRejectedValue(new Error('Telegram sendMessage failed (403): Forbidden: bot was blocked by the user'))
    } as unknown as TelegramApi;

    await expect(dispatchWatchAlerts(service, api)).resolves.toBeUndefined();
    expect(service.stopTelegramDelivery).toHaveBeenCalledWith('123', expect.stringContaining('blocked by the user'));
    expect(service.markWatchAlert).not.toHaveBeenCalled();
  });
});
