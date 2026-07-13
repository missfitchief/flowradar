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

function walletCapitalSummary() {
  return {
    address: ADDRESS, scannedChains: ['SOLANA'], entityKey: 'entity:1', relations: [{
      sourceChain: 'SOLANA', chain: 'SOLANA', address: '22222222222222222222222222222222', role: 'execution_wallet',
      route: 'direct_transfer', hops: 1, amount: '2.5', amountSymbol: 'SOL', amountUsd: 400,
      sourceTxHash: 'tx-hash', sourceTxUrl: 'https://solscan.io/tx/tx-hash', firstTransferTs: '2026-07-13T01:00:00.000Z',
      lastTransferTs: '2026-07-13T01:00:00.000Z', tokens: [{ address: '33333333333333333333333333333333', symbol: 'NEW', firstBuyTs: '2026-07-13T01:05:00.000Z', fundingToBuyDelaySec: 300 }],
      rotations: ['SOLANA:44444444444444444444444444444444'], confidence: 0.9, fresh: true, dormant: false,
      safeEntityLink: true, entityKey: 'entity:1'
    }]
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
      createSession: vi.fn().mockResolvedValue({ id: 'session1' }), scanWalletCapital: vi.fn().mockResolvedValue({}),
      walletCapitalSummary: vi.fn().mockResolvedValue(walletCapitalSummary()), watch: vi.fn().mockResolvedValue({})
    } as unknown as OperatorService;
    await createUpdateHandler(service, api, new Set(['123']))({ update_id: 2, message: { message_id: 2, from: { id: 123 }, chat: { id: 123, type: 'private' }, text: ADDRESS } });
    expect(service.validateWorkflowTarget).toHaveBeenCalledWith('wallet', ADDRESS);
    expect(service.clearPendingSession).toHaveBeenCalledWith('123', '123');
    expect(service.scanWalletCapital).toHaveBeenCalledWith(ADDRESS);
    expect(service.walletCapitalSummary).toHaveBeenCalledWith(ADDRESS);
    expect(service.watch).toHaveBeenCalledWith('123', '123', ADDRESS);
    expect(api.sendMessage).toHaveBeenCalledWith('123', expect.stringContaining('<b>WALLET CAPITAL TRACE</b>'), expect.any(Object));
    const [, text, keyboard] = vi.mocked(api.sendMessage).mock.calls[0]!;
    expect(text).toContain('Direct receivers');
    expect(text).toContain('<code>22222222222222222222222222222222</code>');
    expect(text).toContain('NEW');
    expect(text).not.toContain('Wallet DNA');
    expect(keyboard?.inline_keyboard[0]?.[0]?.copy_text).toEqual({ text: '22222222222222222222222222222222' });
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

  it('runs the real token scan and returns one short empty message only after zero results', async () => {
    const api = apiMock();
    const service = {
      validateWorkflowTarget: vi.fn().mockResolvedValue(true), clearPendingSession: vi.fn(), createSession: vi.fn().mockResolvedValue({ id: 'session1' }),
      scanTokenTopPnl: vi.fn().mockResolvedValue({ chains: ['SOLANA'], candidateCount: 0 }),
      tokenSummary: vi.fn().mockResolvedValue({ tokens: [], metadata: [], universe: [{ chain: 'SOLANA', coverage: 'unavailable', processingStatus: 'unavailable' }], topPnl: { items: [], page: 1, pageSize: 10, total: 0, hasNext: false }, coverageWarnings: ['Provider coverage nije dostupan.'] })
    } as unknown as OperatorService;
    await createUpdateHandler(service, api, new Set(['123']))({ update_id: 6, message: { message_id: 6, from: { id: 123 }, chat: { id: 123, type: 'private' }, text: `/token ${ADDRESS}` } });
    const [chatId, text, keyboard] = vi.mocked(api.sendMessage).mock.calls[0]!;
    expect(chatId).toBe('123');
    expect(service.scanTokenTopPnl).toHaveBeenCalledWith(ADDRESS);
    expect(text).toBe('Nije pronađen nijedan top-PnL wallet za ovaj token.');
    expect(keyboard?.inline_keyboard).toEqual([]);
  });

  it('renders full top-PnL wallet details with copy and explorer buttons', async () => {
    const api = apiMock();
    const wallet = '22222222222222222222222222222222';
    const service = {
      validateWorkflowTarget: vi.fn().mockResolvedValue(true), clearPendingSession: vi.fn(), createSession: vi.fn().mockResolvedValue({ id: 'session1' }),
      scanTokenTopPnl: vi.fn().mockResolvedValue({ chains: ['SOLANA'], candidateCount: 1 }),
      tokenSummary: vi.fn().mockResolvedValue({
        tokens: [], metadata: [], universe: [], coverageWarnings: [],
        topPnl: { page: 1, pageSize: 10, total: 1, hasNext: false, items: [{
          chain: 'SOLANA', walletAddress: wallet, realizedPnlUsd: 125_400, roi: 6.4, boughtUsd: 20_000,
          soldUsd: 145_400, remainingPositionUsd: null, firstBuyTs: '2026-07-13T10:00:00.000Z',
          dormancy: { days7: true, days14: true, days30: false, days90: null }, validation: 'locally_verified'
        }] }
      })
    } as unknown as OperatorService;
    await createUpdateHandler(service, api, new Set(['123']))({ update_id: 7, message: { message_id: 7, from: { id: 123 }, chat: { id: 123, type: 'private' }, text: `/token ${ADDRESS}` } });
    const [, text, keyboard] = vi.mocked(api.sendMessage).mock.calls[0]!;
    expect(text).toContain('TOP 10 PNL WALLETS');
    expect(text).toContain('+$125,400 PnL · 640% ROI');
    expect(text).toContain(`<code>${wallet}</code>`);
    expect(text).not.toContain('Coverage:');
    expect(keyboard?.inline_keyboard[0]).toEqual([
      { text: 'Copy wallet', copy_text: { text: wallet } },
      { text: 'Explorer', url: `https://solscan.io/account/${wallet}` }
    ]);
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
