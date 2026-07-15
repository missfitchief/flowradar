import { describe, expect, it, vi } from 'vitest';
import type { OperatorService } from '@flowradar/db';
import { dispatchWatchAlerts } from '../src/poller';
import type { TelegramApi } from '../src/types';

describe('Telegram watch alert delivery', () => {
  it('disables delivery for a blocked chat without throwing or retrying the alert', async () => {
    const service = {
      materializeWatchAlerts: vi.fn(),
      prepareWatchAlertForDispatch: vi.fn().mockResolvedValue(true),
      pendingWatchAlerts: vi.fn().mockResolvedValue([{
        id: 'alert1', alertType: 'receiver_bought_token', payloadJson: { token: 'NEW' }, watch: { chatId: '123' }
      }]),
      recordWatchAlertDispatchAttempt: vi.fn(),
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

  it('persists the Telegram delivery receipt after a successful Core alert', async () => {
    const service = {
      materializeWatchAlerts: vi.fn(),
      prepareWatchAlertForDispatch: vi.fn().mockResolvedValue(true),
      pendingWatchAlerts: vi.fn().mockResolvedValue([{
        id: 'alert2', alertType: 'core_multi_wallet_buy', status: 'pending',
        payloadJson: { token: 'NEW', ca: 'NewMint', chain: 'SOLANA', rawWalletCount: 2, independentEntityCount: 2 },
        watch: { chatId: '123', targetType: 'core_wallet' }
      }]),
      recordWatchAlertDispatchAttempt: vi.fn(),
      markWatchAlert: vi.fn(),
      stopTelegramDelivery: vi.fn()
    } as unknown as OperatorService;
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 456, chat: { id: 123, type: 'private' } })
    } as unknown as TelegramApi;

    await dispatchWatchAlerts(service, api, { info: vi.fn(), error: vi.fn() });

    expect(service.recordWatchAlertDispatchAttempt).toHaveBeenCalledWith('alert2');
    expect(service.markWatchAlert).toHaveBeenCalledWith('alert2', undefined, {
      telegramMessageId: 456, telegramChatId: 123
    });
  });

  it('dispatches an existing queued alert when materialization fails', async () => {
    const service = {
      materializeWatchAlerts: vi.fn().mockRejectedValue(new Error('materializer unavailable')),
      prepareWatchAlertForDispatch: vi.fn().mockResolvedValue(true),
      pendingWatchAlerts: vi.fn().mockResolvedValue([{
        id: 'alert3', alertType: 'core_multi_wallet_buy', status: 'pending',
        payloadJson: { token: 'NEW', ca: 'NewMint', chain: 'SOLANA', rawWalletCount: 2, independentEntityCount: 1 },
        watch: { chatId: '123', targetType: 'core_wallet' }
      }]),
      recordWatchAlertDispatchAttempt: vi.fn(), markWatchAlert: vi.fn(), stopTelegramDelivery: vi.fn()
    } as unknown as OperatorService;
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 789, chat: { id: 123, type: 'private' } })
    } as unknown as TelegramApi;

    await dispatchWatchAlerts(service, api, { info: vi.fn(), error: vi.fn() });

    expect(api.sendMessage).toHaveBeenCalledOnce();
    expect(service.markWatchAlert).toHaveBeenCalledWith('alert3', undefined, {
      telegramMessageId: 789, telegramChatId: 123
    });
  });

  it('edits the existing Telegram message when confluence grows instead of sending a duplicate', async () => {
    const service = {
      materializeWatchAlerts: vi.fn(),
      prepareWatchAlertForDispatch: vi.fn().mockResolvedValue(true),
      pendingWatchAlerts: vi.fn().mockResolvedValue([{
        id: 'alert4', alertType: 'core_multi_wallet_buy', status: 'update_pending',
        payloadJson: {
          token: 'NEW', ca: 'NewMint', chain: 'SOLANA', rawWalletCount: 3, qualifyingWalletCount: 3, independentEntityCount: 2,
          combinedBuyUsd: 420, deliveryReceipt: { telegramMessageId: 456, telegramChatId: 123 }
        },
        watch: { chatId: '123', targetType: 'core_wallet' }
      }]),
      recordWatchAlertDispatchAttempt: vi.fn(), markWatchAlert: vi.fn(), stopTelegramDelivery: vi.fn()
    } as unknown as OperatorService;
    const api = {
      sendMessage: vi.fn(), editMessage: vi.fn().mockResolvedValue(undefined)
    } as unknown as TelegramApi;

    await dispatchWatchAlerts(service, api, { info: vi.fn(), error: vi.fn() });

    expect(api.editMessage).toHaveBeenCalledWith('123', 456, expect.stringContaining('3</b> qualified wallets'), expect.any(Object));
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(service.markWatchAlert).toHaveBeenCalledWith('alert4', undefined, {
      telegramMessageId: 456, telegramChatId: 123
    });
  });

  it('suppresses a stale or legacy queued alert before Telegram dispatch', async () => {
    const service = {
      materializeWatchAlerts: vi.fn(),
      prepareWatchAlertForDispatch: vi.fn().mockResolvedValue(false),
      pendingWatchAlerts: vi.fn().mockResolvedValue([{
        id: 'stale-alert', alertType: 'core_multi_wallet_buy', status: 'pending', payloadJson: {},
        watch: { chatId: '123', targetType: 'core_wallet' }
      }]),
      recordWatchAlertDispatchAttempt: vi.fn(), markWatchAlert: vi.fn(), stopTelegramDelivery: vi.fn()
    } as unknown as OperatorService;
    const api = { sendMessage: vi.fn(), editMessage: vi.fn() } as unknown as TelegramApi;

    await dispatchWatchAlerts(service, api, { info: vi.fn(), error: vi.fn() });

    expect(service.prepareWatchAlertForDispatch).toHaveBeenCalledWith('stale-alert');
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(api.editMessage).not.toHaveBeenCalled();
  });
});
