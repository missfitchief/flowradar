import { describe, expect, it, vi } from 'vitest';
import type { OperatorService, WalletInvestigationResult } from '@flowradar/db';
import { createUpdateHandler } from '../src/handlers';
import { navKeyboard } from '../src/render';
import type { TelegramApi } from '../src/types';

const ADDRESS = '11111111111111111111111111111111';
const RECEIVER = '22222222222222222222222222222222';
const TOKEN = '33333333333333333333333333333333';

function apiMock(): TelegramApi {
  return {
    getMe: vi.fn(), deleteWebhook: vi.fn(), setMyCommands: vi.fn(), getUpdates: vi.fn(),
    sendMessage: vi.fn(), editMessage: vi.fn(), answerCallbackQuery: vi.fn(), sendDocument: vi.fn()
  } as unknown as TelegramApi;
}

function investigation(): WalletInvestigationResult {
  return {
    id: 'investigation1', investigationKey: `solana:${ADDRESS}`, rootAddress: ADDRESS, addressKind: 'solana', maxDepth: 4,
    status: 'completed', entityKey: 'entity:1', coverageStatus: 'complete', activityChains: ['SOLANA'], completedAt: '2026-07-13T01:10:00.000Z',
    coverage: [{ chain: 'SOLANA', activityFound: true, firstActivityAt: '2026-07-13T01:00:00.000Z', lastActivityAt: '2026-07-13T01:10:00.000Z', eventsScanned: 3, coverageStatus: 'complete', provider: 'test', warnings: [] }],
    counts: { directReceivers: 1, multiHopWallets: 0, bridgeDestinations: 0, probableAltExecutionWallets: 1, profitCollectors: 0, tokenDeployments: 1, possibleCexLinks: 0, strongLinks: 1, probableLinks: 0, possibleLinks: 0 },
    paths: [{
      id: 'direct:1', routeType: 'direct', sourceChain: 'SOLANA', sourceAddress: ADDRESS, destinationChain: 'SOLANA', destinationAddress: RECEIVER,
      assetAddress: null, assetSymbol: 'SOL', amountToken: '2.5', amountUsd: 400, valueStatus: 'usd_verified', eventTs: '2026-07-13T01:00:00.000Z',
      txHash: 'tx-hash', protocol: null, evidenceTier: 'exact_direct_transfer', confidence: 0.9, supportingEvidence: {}, contradictingEvidence: {},
      hops: [{ sourceChain: 'SOLANA', sourceAddress: ADDRESS, destinationChain: 'SOLANA', destinationAddress: RECEIVER, assetAddress: null, assetSymbol: 'SOL', amountToken: '2.5', amountUsd: 400, valueStatus: 'usd_verified', timestamp: '2026-07-13T01:00:00.000Z', txHash: 'tx-hash', routeType: 'direct', protocol: null, evidenceTier: 'exact_direct_transfer', confidence: 0.9 }]
    }, {
      id: 'deployment:1', routeType: 'token_deployment', sourceChain: 'SOLANA', sourceAddress: RECEIVER, destinationChain: 'SOLANA', destinationAddress: TOKEN,
      assetAddress: TOKEN, assetSymbol: 'NEW', amountToken: '100', amountUsd: 50, valueStatus: 'usd_verified', eventTs: '2026-07-13T01:05:00.000Z',
      txHash: 'buy-hash', protocol: null, evidenceTier: 'transaction_verified_buy_after_funding', confidence: 0.9, supportingEvidence: {}, contradictingEvidence: {}, hops: []
    }],
    members: [{ chain: 'SOLANA', address: ADDRESS, role: 'root_main', parentChain: null, parentAddress: null, entityKey: 'entity:1', relationshipConfidence: 1, evidenceTier: 'investigation_root', firstLinkedAt: '2026-07-13T01:00:00.000Z', lastLinkedAt: '2026-07-13T01:10:00.000Z', observationOnly: true }, { chain: 'SOLANA', address: RECEIVER, role: 'execution_wallet', parentChain: 'SOLANA', parentAddress: ADDRESS, entityKey: 'entity:1', relationshipConfidence: 0.9, evidenceTier: 'exact_direct_transfer', firstLinkedAt: '2026-07-13T01:00:00.000Z', lastLinkedAt: '2026-07-13T01:00:00.000Z', observationOnly: true }],
    deployments: [{ id: 'deployment:1', chain: 'SOLANA', buyerAddress: RECEIVER, tokenAddress: TOKEN, tokenSymbol: 'NEW', buyTs: '2026-07-13T01:05:00.000Z', buyTxHash: 'buy-hash', amountToken: '100', amountUsd: 50, entryMarketCapUsd: null, fundingToBuyDelaySec: 300, sourceEntityKey: 'entity:1', capitalRoute: [], holdingStatus: 'holding_or_unresolved', evidenceTier: 'transaction_verified_buy_after_funding' }],
    providerReceipts: {}
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

  it('runs one canonical investigation for the pending wallet and sends only its summary', async () => {
    const api = apiMock();
    const service = {
      getPendingSession: vi.fn().mockResolvedValue({ workflow: 'wallet', session: { id: 'pending1' } }),
      validateWorkflowTarget: vi.fn().mockResolvedValue(true), clearPendingSession: vi.fn().mockResolvedValue(1),
      createSession: vi.fn().mockResolvedValue({ id: 'session1' }), walletInvestigationView: vi.fn().mockResolvedValue(investigation()),
      updateSession: vi.fn().mockResolvedValue(true)
    } as unknown as OperatorService;
    await createUpdateHandler(service, api, new Set(['123']))({ update_id: 2, message: { message_id: 2, from: { id: 123 }, chat: { id: 123, type: 'private' }, text: ADDRESS } });
    expect(service.walletInvestigationView).toHaveBeenCalledWith(ADDRESS, { maxDepth: 4 });
    expect(service.updateSession).toHaveBeenCalledWith('session1', '123', '123', expect.objectContaining({ investigationId: 'investigation1', investigationView: 'summary', pageSize: 5 }));
    expect(api.sendMessage).toHaveBeenCalledOnce();
    const [, text, keyboard] = vi.mocked(api.sendMessage).mock.calls[0]!;
    expect(text).toContain('<b>WALLET INVESTIGATION</b>');
    expect(text).toContain(`<code>${ADDRESS}</code>`);
    expect(text).not.toContain('Wallet DNA');
    expect(keyboard?.inline_keyboard.flat().map((button) => button.text)).toEqual([
      'Najvažnije putanje', 'Token deployments', 'Alt / execution walleti', 'Bridges', 'Ceo cluster', 'Advanced / svi rezultati'
    ]);
    expect(keyboard?.inline_keyboard.flat().some((button) => button.text === 'Refresh')).toBe(false);
  });

  it.each([
    ['/flow', 'priority', 'NAJVAŽNIJE PUTANJE'],
    ['/bridges', 'bridges', 'BRIDGES'],
    ['/entity', 'cluster', 'CEO CLUSTER']
  ])('uses the same canonical investigation for %s', async (command, view, heading) => {
    const api = apiMock();
    const service = {
      validateWorkflowTarget: vi.fn().mockResolvedValue(true), clearPendingSession: vi.fn(), createSession: vi.fn().mockResolvedValue({ id: 'session1' }),
      walletInvestigationView: vi.fn().mockResolvedValue(investigation()), updateSession: vi.fn()
    } as unknown as OperatorService;
    await createUpdateHandler(service, api, new Set(['123']))({ update_id: 3, message: { message_id: 3, from: { id: 123 }, chat: { id: 123, type: 'private' }, text: `${command} ${ADDRESS}` } });
    expect(service.walletInvestigationView).toHaveBeenCalledWith(ADDRESS, { maxDepth: 4 });
    expect(service.updateSession).toHaveBeenCalledWith('session1', '123', '123', expect.objectContaining({ investigationId: 'investigation1', investigationView: view }));
    expect(vi.mocked(api.sendMessage).mock.calls[0]?.[1]).toContain(heading);
  });

  it('paginates at most five persisted priority paths with full addresses and explorer links without rescanning', async () => {
    const api = apiMock();
    const service = {
      clearPendingSession: vi.fn(), getSession: vi.fn().mockResolvedValue({ id: 'session1', workflow: 'wallet', stateJson: { target: ADDRESS, investigationId: 'investigation1', investigationView: 'summary', page: 1, pageSize: 5 } }),
      updateSession: vi.fn(), loadWalletInvestigation: vi.fn().mockResolvedValue(investigation())
    } as unknown as OperatorService;
    await createUpdateHandler(service, api, new Set(['123']))({ update_id: 4, callback_query: { id: 'cb-paths', from: { id: 123 }, data: 'v1|invest|session1|priority', message: { message_id: 4, chat: { id: 123, type: 'private' }, text: 'summary' } } });
    const [, , text, keyboard] = vi.mocked(api.editMessage).mock.calls[0]!;
    expect(service.loadWalletInvestigation).toHaveBeenCalledWith('investigation1');
    expect(text).toContain(`<code>${ADDRESS}</code>`);
    expect(text).toContain(`<code>${RECEIVER}</code>`);
    expect(text).toContain('TOKEN DEPLOYMENT');
    expect(keyboard?.inline_keyboard.flat().find((button) => button.url === `https://solscan.io/account/${RECEIVER}`)?.url).toBe(`https://solscan.io/account/${RECEIVER}`);
    expect(text?.match(/<b>\d+\. /g)?.length ?? 0).toBeLessThanOrEqual(5);
  });

  it('turns a stale Refresh callback into a persisted summary refresh without starting a scan', async () => {
    const api = apiMock();
    const service = {
      clearPendingSession: vi.fn(), getSession: vi.fn().mockResolvedValue({ id: 'session1', workflow: 'wallet', stateJson: { target: ADDRESS, investigationId: 'investigation1', investigationView: 'summary', page: 1, pageSize: 5 } }),
      loadWalletInvestigation: vi.fn().mockResolvedValue(investigation()), investigateWallet: vi.fn(), updateSession: vi.fn()
    } as unknown as OperatorService;
    await createUpdateHandler(service, api, new Set(['123']))({ update_id: 5, callback_query: { id: 'cb-refresh', from: { id: 123 }, data: 'v1|refresh|session1|run', message: { message_id: 5, chat: { id: 123, type: 'private' }, text: 'old summary' } } });
    expect(service.loadWalletInvestigation).toHaveBeenCalledWith('investigation1');
    expect(service.investigateWallet).not.toHaveBeenCalled();
    expect(vi.mocked(api.editMessage).mock.calls[0]?.[2]).toContain('WALLET INVESTIGATION');
  });

  it('clears pending state on /cancel and Back', async () => {
    const api = apiMock();
    const service = { clearPendingSession: vi.fn().mockResolvedValue(1) } as unknown as OperatorService;
    const handler = createUpdateHandler(service, api, new Set(['123']));
    await handler({ update_id: 6, message: { message_id: 6, from: { id: 123 }, chat: { id: 123, type: 'private' }, text: '/cancel' } });
    await handler({ update_id: 7, callback_query: { id: 'cb1', from: { id: 123 }, data: 'v1|cancel|pending1|pending', message: { message_id: 7, chat: { id: 123, type: 'private' }, text: 'Pošalji wallet adresu.' } } });
    expect(service.clearPendingSession).toHaveBeenCalledTimes(2);
    expect(api.editMessage).toHaveBeenCalledWith('123', 7, 'Otkazano.', { inline_keyboard: [] });
  });

  it('offers wallet/token choice for an ambiguous direct address', async () => {
    const api = apiMock();
    const service = { getPendingSession: vi.fn().mockResolvedValue(null), classifyAddressInput: vi.fn().mockResolvedValue('ambiguous'), createSession: vi.fn().mockResolvedValue({ id: 'session1' }) } as unknown as OperatorService;
    await createUpdateHandler(service, api, new Set(['123']))({ update_id: 8, message: { message_id: 8, from: { id: 123 }, chat: { id: 123, type: 'private' }, text: ADDRESS } });
    const keyboard = vi.mocked(api.sendMessage).mock.calls[0]?.[2];
    expect(keyboard?.inline_keyboard[0]?.map((button) => button.text)).toEqual(['Analiziraj kao wallet', 'Analiziraj kao token']);
  });

  it('keeps the token empty result short after the real scan', async () => {
    const api = apiMock();
    const service = {
      validateWorkflowTarget: vi.fn().mockResolvedValue(true), clearPendingSession: vi.fn(), createSession: vi.fn().mockResolvedValue({ id: 'session1' }),
      scanTokenTopPnl: vi.fn().mockResolvedValue({ chains: ['SOLANA'], candidateCount: 0 }),
      tokenSummary: vi.fn().mockResolvedValue({ topPnl: { items: [], page: 1, pageSize: 10, total: 0, hasNext: false } })
    } as unknown as OperatorService;
    await createUpdateHandler(service, api, new Set(['123']))({ update_id: 9, message: { message_id: 9, from: { id: 123 }, chat: { id: 123, type: 'private' }, text: `/token ${ADDRESS}` } });
    expect(vi.mocked(api.sendMessage).mock.calls[0]?.[1]).toBe('Nije pronađen nijedan top-PnL wallet za ovaj token.');
  });

  it('does not edit an unchanged Telegram message', async () => {
    const api = apiMock();
    const keyboard = navKeyboard('session1', 1, false);
    const service = {
      clearPendingSession: vi.fn(), getSession: vi.fn().mockResolvedValue({ id: 'session1', workflow: 'recent', stateJson: { page: 1, pageSize: 10 } }),
      updateSession: vi.fn().mockResolvedValue(true), recent: vi.fn().mockResolvedValue({ items: [], page: 1, pageSize: 10, total: 0, hasNext: false, coverageWarnings: [] })
    } as unknown as OperatorService;
    await createUpdateHandler(service, api, new Set(['123']))({ update_id: 10, callback_query: { id: 'cb2', from: { id: 123 }, data: 'v1|exportback|session1|result', message: { message_id: 10, chat: { id: 123, type: 'private' }, text: 'Recent relevant events · page 1 · 0 total', reply_markup: keyboard } } });
    expect(api.editMessage).not.toHaveBeenCalled();
    expect(api.answerCallbackQuery).toHaveBeenCalledWith('cb2');
  });

  it('uses service pagination for an authorized /profitable command', async () => {
    const api = apiMock();
    const service = {
      clearPendingSession: vi.fn(), createSession: vi.fn().mockResolvedValue({ id: 'session1' }),
      profitable: vi.fn().mockResolvedValue({ items: [], page: 1, pageSize: 10, total: 0, hasNext: false, coverageWarnings: [] })
    } as unknown as OperatorService;
    await createUpdateHandler(service, api, new Set(['123']))({ update_id: 11, message: { message_id: 11, from: { id: 123 }, chat: { id: 123, type: 'private' }, text: '/profitable' } });
    expect(service.profitable).toHaveBeenCalledWith({ chain: 'ALL', sort: 'pnl', page: 1, pageSize: 10 });
  });
});
