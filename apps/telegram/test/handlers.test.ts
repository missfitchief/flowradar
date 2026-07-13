import { describe, expect, it, vi } from 'vitest';
import type { OperatorService } from '@flowradar/db';
import { createUpdateHandler } from '../src/handlers';
import { navKeyboard } from '../src/render';
import type { TelegramApi } from '../src/types';

const ADDRESS = '11111111111111111111111111111111';

function apiMock(): TelegramApi {
  return {
    getMe: vi.fn(), deleteWebhook: vi.fn(), setMyCommands: vi.fn(), getUpdates: vi.fn(),
    sendMessage: vi.fn(), editMessage: vi.fn(), answerCallbackQuery: vi.fn(), sendDocument: vi.fn()
  } as unknown as TelegramApi;
}

function walletSummary() {
  return {
    address: ADDRESS, detectedChains: ['SOLANA'], role: 'execution_wallet', relationshipConfidence: null, entityKey: null,
    eventCounts: { raw: 1, relevant: 1, highPriority: 0 }, funders: [], routes: { direct: 0, multiHop: 0, bridges: 0, possibleCex: 0 },
    dormancy: { days7: null, days14: null, days30: null, days90: null, latestClass: null, evidence: null }, positions: [],
    completedPositions: 0, winCount: 0, lossCount: 0, unresolvedPositions: 0, winRate: null, evUsd: null,
    repeatRunnerCount: null, oneWinnerDependence: null, undeployedCapitalUsd: null, lastRelevantActivity: null, coverageWarnings: []
  };
}

describe('Telegram command handlers', () => {
  it('rejects unauthorized users before any service query', async () => {
    const api = apiMock();
    const service = { profitable: vi.fn() } as unknown as OperatorService;
    await createUpdateHandler(service, api, new Set(['123']))({ update_id: 1, message: { message_id: 1, from: { id: 999 }, chat: { id: 999, type: 'private' }, text: '/profitable' } });
    expect(service.profitable).not.toHaveBeenCalled();
    expect(api.sendMessage).toHaveBeenCalledWith('999', '<b>Unauthorized.</b>');
  });

  it('prompts for a wallet and persists the pending action', async () => {
    const api = apiMock();
    const service = { setPendingSession: vi.fn().mockResolvedValue({ id: 'pending1' }) } as unknown as OperatorService;
    await createUpdateHandler(service, api, new Set(['123']))({ update_id: 1, message: { message_id: 1, from: { id: 123 }, chat: { id: 123, type: 'private' }, text: '/wallet' } });
    expect(service.setPendingSession).toHaveBeenCalledWith('123', '123', 'wallet', 10);
    expect(api.sendMessage).toHaveBeenCalledWith('123', 'Pošalji wallet adresu.', expect.objectContaining({ inline_keyboard: expect.any(Array) }));
  });

  it('treats the next ordinary message as the pending wallet target', async () => {
    const api = apiMock();
    const service = {
      getPendingSession: vi.fn().mockResolvedValue({ workflow: 'wallet', session: { id: 'pending1' } }),
      validateWorkflowTarget: vi.fn().mockResolvedValue(true), clearPendingSession: vi.fn().mockResolvedValue(1),
      createSession: vi.fn().mockResolvedValue({ id: 'session1' }), walletSummary: vi.fn().mockResolvedValue(walletSummary())
    } as unknown as OperatorService;
    await createUpdateHandler(service, api, new Set(['123']))({ update_id: 2, message: { message_id: 2, from: { id: 123 }, chat: { id: 123, type: 'private' }, text: ADDRESS } });
    expect(service.validateWorkflowTarget).toHaveBeenCalledWith('wallet', ADDRESS);
    expect(service.clearPendingSession).toHaveBeenCalledWith('123', '123');
    expect(service.walletSummary).toHaveBeenCalledWith(ADDRESS);
    expect(api.sendMessage).toHaveBeenCalledWith('123', expect.stringContaining('<b>Wallet'), expect.any(Object));
  });

  it('clears pending state on /cancel and Back', async () => {
    const api = apiMock();
    const service = { clearPendingSession: vi.fn().mockResolvedValue(1) } as unknown as OperatorService;
    const handler = createUpdateHandler(service, api, new Set(['123']));
    await handler({ update_id: 3, message: { message_id: 3, from: { id: 123 }, chat: { id: 123, type: 'private' }, text: '/cancel' } });
    await handler({ update_id: 4, callback_query: { id: 'cb1', from: { id: 123 }, data: 'v1|cancel|pending1|pending', message: { message_id: 4, chat: { id: 123, type: 'private' }, text: 'Pošalji wallet adresu.' } } });
    expect(service.clearPendingSession).toHaveBeenCalledTimes(2);
    expect(api.editMessage).toHaveBeenCalledWith('123', 4, 'Otkazano.', { inline_keyboard: [] });
  });

  it('offers wallet/token choice for an ambiguous direct address', async () => {
    const api = apiMock();
    const service = { getPendingSession: vi.fn().mockResolvedValue(null), classifyAddressInput: vi.fn().mockResolvedValue('ambiguous'), createSession: vi.fn().mockResolvedValue({ id: 'session1' }) } as unknown as OperatorService;
    await createUpdateHandler(service, api, new Set(['123']))({ update_id: 5, message: { message_id: 5, from: { id: 123 }, chat: { id: 123, type: 'private' }, text: ADDRESS } });
    const keyboard = vi.mocked(api.sendMessage).mock.calls[0]?.[2];
    expect(keyboard?.inline_keyboard[0]?.map((button) => button.text)).toEqual(['Analiziraj kao wallet', 'Analiziraj kao token']);
  });

  it('shows token coverage and deep-scan control when top-PnL is empty', async () => {
    const api = apiMock();
    const service = {
      validateWorkflowTarget: vi.fn().mockResolvedValue(true), clearPendingSession: vi.fn(), createSession: vi.fn().mockResolvedValue({ id: 'session1' }),
      tokenSummary: vi.fn().mockResolvedValue({ tokens: [], metadata: [], universe: [{ chain: 'SOLANA', coverage: 'unavailable', processingStatus: 'unavailable' }], topPnl: { items: [], page: 1, pageSize: 10, total: 0, hasNext: false }, coverageWarnings: ['Provider coverage nije dostupan.'] })
    } as unknown as OperatorService;
    await createUpdateHandler(service, api, new Set(['123']))({ update_id: 6, message: { message_id: 6, from: { id: 123 }, chat: { id: 123, type: 'private' }, text: `/token ${ADDRESS}` } });
    const [chatId, text, keyboard] = vi.mocked(api.sendMessage).mock.calls[0]!;
    expect(chatId).toBe('123');
    expect(text).toContain('Top-PnL rezultati još ne postoje.');
    expect(text).toContain('Provereno:');
    expect(text).toContain('Coverage: SOLANA unavailable/unavailable');
    expect(keyboard?.inline_keyboard.flat().map((button) => button.text)).toEqual(['Pokreni dublji scan', 'Izvoz']);
  });

  it('does not edit an unchanged Telegram message', async () => {
    const api = apiMock();
    const keyboard = navKeyboard('session1', 1, false);
    const service = {
      clearPendingSession: vi.fn(), getSession: vi.fn().mockResolvedValue({ id: 'session1', workflow: 'recent', stateJson: { page: 1, pageSize: 10 } }),
      updateSession: vi.fn().mockResolvedValue(true), recent: vi.fn().mockResolvedValue({ items: [], page: 1, pageSize: 10, total: 0, hasNext: false, coverageWarnings: [] })
    } as unknown as OperatorService;
    await createUpdateHandler(service, api, new Set(['123']))({ update_id: 7, callback_query: { id: 'cb2', from: { id: 123 }, data: 'v1|exportback|session1|result', message: { message_id: 7, chat: { id: 123, type: 'private' }, text: 'Recent relevant events · page 1 · 0 total', reply_markup: keyboard } } });
    expect(api.editMessage).not.toHaveBeenCalled();
    expect(api.answerCallbackQuery).toHaveBeenCalledWith('cb2');
  });

  it('uses service pagination for an authorized /profitable command', async () => {
    const api = apiMock();
    const service = {
      clearPendingSession: vi.fn(), createSession: vi.fn().mockResolvedValue({ id: 'session1' }),
      profitable: vi.fn().mockResolvedValue({ items: [], page: 1, pageSize: 10, total: 0, hasNext: false, coverageWarnings: [] })
    } as unknown as OperatorService;
    await createUpdateHandler(service, api, new Set(['123']))({ update_id: 8, message: { message_id: 8, from: { id: 123 }, chat: { id: 123, type: 'private' }, text: '/profitable' } });
    expect(service.profitable).toHaveBeenCalledWith({ chain: 'ALL', sort: 'pnl', page: 1, pageSize: 10 });
    expect(api.sendMessage).toHaveBeenCalledOnce();
  });
});
