import { describe, expect, it, vi } from 'vitest';
import type { InvestigationMemberIntelligence, OperatorService, WalletInvestigationResult } from '@flowradar/db';
import { createUpdateHandler, resumeWalletInvestigationJobs } from '../src/handlers';
import { navKeyboard } from '../src/render';
import type { TelegramApi } from '../src/types';

const ADDRESS = '11111111111111111111111111111111';
const RECEIVER = '22222222222222222222222222222222';
const TOKEN = '33333333333333333333333333333333';

function intelligence(): InvestigationMemberIntelligence {
  return {
    evidenceScore: 84, historicalAlphaScore: 68, wakeUpPotential: 72, tier: 'A', trackingPriority: 'track_now',
    independentSignalCount: 3, clusterConclusion: 'supported',
    evidenceSignals: [
      { code: 'direct_funding', label: 'Direct funding', strength: 0.9, weight: 28, receiptCount: 2 },
      { code: 'repeated_funding', label: 'Repeated funding pattern', strength: 0.9, weight: 18, receiptCount: 2 },
      { code: 'execution_pattern', label: 'Post-funding execution pattern', strength: 0.9, weight: 14, receiptCount: 1 }
    ],
    whyImportant: ['Three independent signals plus an early post-funding token buy.'], contradictions: [], historicalCoverage: 'partial',
    metrics: { transferCount: 2, uniqueTokensAfterFunding: 1, completedPositions: 4, winRate: 0.75, repeatRunnerCount: 2, realizedPnlUsd: 12_000, medianEntryMcapUsd: 300_000, maxCoveredDormantDays: 90 }, scoreVersion: 1
  };
}

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
    members: [{ chain: 'SOLANA', address: ADDRESS, role: 'root_main', parentChain: null, parentAddress: null, entityKey: 'entity:1', relationshipConfidence: 1, evidenceTier: 'investigation_root', firstLinkedAt: '2026-07-13T01:00:00.000Z', lastLinkedAt: '2026-07-13T01:10:00.000Z', observationOnly: true }, { chain: 'SOLANA', address: RECEIVER, role: 'execution_wallet', parentChain: 'SOLANA', parentAddress: ADDRESS, entityKey: 'entity:1', relationshipConfidence: 0.9, evidenceTier: 'exact_direct_transfer', firstLinkedAt: '2026-07-13T01:00:00.000Z', lastLinkedAt: '2026-07-13T01:00:00.000Z', observationOnly: true, intelligence: intelligence() }],
    deployments: [{ id: 'deployment:1', chain: 'SOLANA', buyerAddress: RECEIVER, tokenAddress: TOKEN, tokenSymbol: 'NEW', buyTs: '2026-07-13T01:05:00.000Z', buyTxHash: 'buy-hash', amountToken: '100', amountUsd: 50, entryMarketCapUsd: 100_000, fundingToBuyDelaySec: 300, sourceEntityKey: 'entity:1', capitalRoute: [], holdingStatus: 'holding_or_unresolved', evidenceTier: 'transaction_verified_buy_after_funding', intelligence: { athMcapUsd: 1_000_000, athBasis: 'historical_universe', roi: 9, roiBasis: 'ath_over_entry_potential', importanceScore: 88, whyImportant: ['Bought by Tier A wallet.'] } }],
    providerReceipts: {}
  };
}

describe('Telegram command handlers', () => {
  it('rejects unauthorized users before any service query', async () => {
    const api = apiMock();
    const service = { profitable: vi.fn() } as unknown as OperatorService;
    await createUpdateHandler(service, api, new Set(['123']))({ update_id: 1, message: { message_id: 1, from: { id: 999 }, chat: { id: 999, type: 'private' }, text: '/profitable' } });
    expect(service.profitable).not.toHaveBeenCalled();
    expect(api.sendMessage).toHaveBeenCalledWith('999', '🔴 <b>ACCESS DENIED</b>');
  });

  it('prompts for a wallet and persists the pending action', async () => {
    const api = apiMock();
    const service = { setPendingSession: vi.fn().mockResolvedValue({ id: 'pending1' }) } as unknown as OperatorService;
    await createUpdateHandler(service, api, new Set(['123']))({ update_id: 1, message: { message_id: 1, from: { id: 123 }, chat: { id: 123, type: 'private' }, text: '/wallet' } });
    expect(service.setPendingSession).toHaveBeenCalledWith('123', '123', 'wallet', 10);
    expect(api.sendMessage).toHaveBeenCalledWith('123', expect.stringContaining('Pošalji wallet adresu.'), expect.objectContaining({ inline_keyboard: expect.any(Array) }));
  });

  it('acknowledges a pending wallet immediately, moves the state, and completes the investigation asynchronously', async () => {
    const api = apiMock();
    let resolveInvestigation!: (value: WalletInvestigationResult) => void;
    const investigationPromise = new Promise<WalletInvestigationResult>((resolve) => { resolveInvestigation = resolve; });
    const service = {
      getPendingSession: vi.fn().mockResolvedValue({ workflow: 'wallet', session: { id: 'pending1' } }),
      validateWorkflowTarget: vi.fn().mockResolvedValue(true), clearPendingSession: vi.fn().mockResolvedValue(1),
      createSession: vi.fn().mockResolvedValue({ id: 'session1' }), walletInvestigationView: vi.fn().mockReturnValue(investigationPromise),
      updateSession: vi.fn().mockResolvedValue(true)
    } as unknown as OperatorService;
    await createUpdateHandler(service, api, new Set(['123']))({ update_id: 2, message: { message_id: 2, from: { id: 123 }, chat: { id: 123, type: 'private' }, text: ADDRESS } });
    expect(service.createSession).toHaveBeenCalledWith('123', '123', 'wallet', expect.objectContaining({ target: ADDRESS, investigationStatus: 'queued' }));
    expect(service.clearPendingSession).toHaveBeenCalledWith('123', '123');
    expect(vi.mocked(api.sendMessage).mock.calls.map((call) => call[1])).toEqual([
      expect.stringContaining('✓ Wallet received'),
      expect.stringContaining('🔄 Investigation running')
    ]);
    await vi.waitFor(() => expect(service.walletInvestigationView).toHaveBeenCalledWith(ADDRESS, { maxDepth: 4, refresh: true }));
    resolveInvestigation(investigation());
    await vi.waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(3));
    expect(service.updateSession).toHaveBeenCalledWith('session1', '123', '123', expect.objectContaining({ investigationId: 'investigation1', investigationStatus: 'completed', investigationView: 'summary', pageSize: 5 }));
    const [, text, keyboard] = vi.mocked(api.sendMessage).mock.calls[2]!;
    expect(text).toContain('<b>FLOWRADAR INTELLIGENCE</b>');
    expect(text).toContain('<b>QUICK VERDICT</b>');
    expect(text).toContain('<b>TIMELINE</b>');
    expect(text).toContain('<code>111111…111111</code>');
    expect(text).not.toContain('Wallet DNA');
    expect(keyboard?.inline_keyboard.flat().map((button) => button.text)).toEqual([
      '💸 Capital Paths', '🧩 Cluster', '🚀 Deployments', '🛡 Evidence', '🔄 Refresh', '👁 Watch Cluster', '🕰 Entity History', '📊 Outcomes'
    ]);
  });

  it('keeps an invalid address in the active wallet flow and always explains the accepted formats', async () => {
    const api = apiMock();
    const service = {
      getPendingSession: vi.fn().mockResolvedValue({ workflow: 'wallet', session: { id: 'pending1' } }),
      validateWorkflowTarget: vi.fn().mockResolvedValue(false), clearPendingSession: vi.fn()
    } as unknown as OperatorService;
    await createUpdateHandler(service, api, new Set(['123']))({ update_id: 20, message: { message_id: 20, from: { id: 123 }, chat: { id: 123, type: 'private' }, text: 'not-an-address' } });
    expect(service.clearPendingSession).not.toHaveBeenCalled();
    expect(vi.mocked(api.sendMessage).mock.calls[0]?.[1]).toContain('Solana base58 adresu (32–44 znaka)');
  });

  it('turns an asynchronous wallet scan failure into a visible Telegram failure', async () => {
    const api = apiMock();
    const service = {
      getPendingSession: vi.fn().mockResolvedValue({ workflow: 'wallet', session: { id: 'pending1' } }),
      validateWorkflowTarget: vi.fn().mockResolvedValue(true), clearPendingSession: vi.fn().mockResolvedValue(1),
      createSession: vi.fn().mockResolvedValue({ id: 'session-failed' }), walletInvestigationView: vi.fn().mockRejectedValue(new Error('provider timeout')),
      updateSession: vi.fn().mockResolvedValue(true)
    } as unknown as OperatorService;
    await createUpdateHandler(service, api, new Set(['123']))({ update_id: 21, message: { message_id: 21, from: { id: 123 }, chat: { id: 123, type: 'private' }, text: ADDRESS } });
    await vi.waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(3));
    expect(vi.mocked(api.sendMessage).mock.calls[2]?.[1]).toContain('INVESTIGATION FAILED');
    expect(vi.mocked(api.sendMessage).mock.calls[2]?.[1]).toContain('provider timeout');
    expect(service.updateSession).toHaveBeenCalledWith('session-failed', '123', '123', expect.objectContaining({ investigationStatus: 'failed', investigationError: 'provider timeout' }));
  });

  it('resumes a persisted queued wallet investigation after a poller restart', async () => {
    const api = apiMock();
    const service = {
      pendingWalletInvestigationSessions: vi.fn().mockResolvedValue([{ id: 'session-resume', userId: '123', chatId: '123', stateJson: { target: ADDRESS, page: 1, pageSize: 10, investigationStatus: 'queued' } }]),
      walletInvestigationView: vi.fn().mockResolvedValue(investigation()), updateSession: vi.fn().mockResolvedValue(true)
    } as unknown as OperatorService;
    expect(await resumeWalletInvestigationJobs(service, api)).toBe(1);
    await vi.waitFor(() => expect(service.walletInvestigationView).toHaveBeenCalledWith(ADDRESS, { maxDepth: 4, refresh: true }));
    await vi.waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.sendMessage).mock.calls[0]?.[1]).toContain('Runtime resumed');
    expect(vi.mocked(api.sendMessage).mock.calls[1]?.[1]).toContain('FLOWRADAR INTELLIGENCE');
  });

  it.each([
    ['/flow', 'priority', 'CAPITAL PATHS'],
    ['/bridges', 'bridges', 'BRIDGE PATHS'],
    ['/entity', 'cluster', 'ENTITY CLUSTER']
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

  it('paginates at most five persisted priority paths with compact addresses and explorer links without rescanning', async () => {
    const api = apiMock();
    const service = {
      clearPendingSession: vi.fn(), getSession: vi.fn().mockResolvedValue({ id: 'session1', workflow: 'wallet', stateJson: { target: ADDRESS, investigationId: 'investigation1', investigationView: 'summary', page: 1, pageSize: 5 } }),
      updateSession: vi.fn(), loadWalletInvestigation: vi.fn().mockResolvedValue(investigation())
    } as unknown as OperatorService;
    await createUpdateHandler(service, api, new Set(['123']))({ update_id: 4, callback_query: { id: 'cb-paths', from: { id: 123 }, data: 'v1|invest|session1|priority', message: { message_id: 4, chat: { id: 123, type: 'private' }, text: 'summary' } } });
    const [, , text, keyboard] = vi.mocked(api.editMessage).mock.calls[0]!;
    expect(service.loadWalletInvestigation).toHaveBeenCalledWith('investigation1');
    expect(text).toContain('<code>111111…111111</code>');
    expect(text).toContain('<code>222222…222222</code>');
    expect(text).toContain('TOKEN BUY');
    expect(keyboard?.inline_keyboard.flat().find((button) => button.url === `https://solscan.io/account/${RECEIVER}`)?.url).toBe(`https://solscan.io/account/${RECEIVER}`);
    expect(text?.match(/<b>\d+\. /g)?.length ?? 0).toBeLessThanOrEqual(5);
  });

  it('runs a real refresh in the same message and returns to the intelligence summary', async () => {
    const api = apiMock();
    const service = {
      clearPendingSession: vi.fn(), getSession: vi.fn().mockResolvedValue({ id: 'session1', workflow: 'wallet', stateJson: { target: ADDRESS, investigationId: 'investigation1', investigationView: 'summary', page: 1, pageSize: 5 } }),
      walletInvestigationView: vi.fn().mockResolvedValue(investigation()), updateSession: vi.fn().mockResolvedValue(true)
    } as unknown as OperatorService;
    await createUpdateHandler(service, api, new Set(['123']))({ update_id: 5, callback_query: { id: 'cb-refresh', from: { id: 123 }, data: 'v1|refresh|session1|run', message: { message_id: 5, chat: { id: 123, type: 'private' }, text: 'old summary' } } });
    expect(vi.mocked(api.editMessage).mock.calls[0]?.[2]).toContain('REFRESHING INTELLIGENCE');
    await vi.waitFor(() => expect(service.walletInvestigationView).toHaveBeenCalledWith(ADDRESS, { maxDepth: 4, refresh: true }));
    await vi.waitFor(() => expect(vi.mocked(api.editMessage).mock.calls.some((call) => call[2].includes('FLOWRADAR INTELLIGENCE'))).toBe(true));
    expect(vi.mocked(api.editMessage).mock.calls.some((call) => call[2].includes('✅ Done.'))).toBe(true);
  });

  it('enables the persisted entity watch from the Wallet Investigation callback', async () => {
    const api = apiMock();
    const service = {
      clearPendingSession: vi.fn(),
      getSession: vi.fn().mockResolvedValue({ id: 'session1', workflow: 'wallet', stateJson: { target: ADDRESS, investigationId: 'investigation1', investigationView: 'summary', page: 1, pageSize: 5 } }),
      loadWalletInvestigation: vi.fn().mockResolvedValue(investigation()),
      watch: vi.fn().mockResolvedValue({}), updateSession: vi.fn().mockResolvedValue(true)
    } as unknown as OperatorService;
    await createUpdateHandler(service, api, new Set(['123']))({ update_id: 51, callback_query: { id: 'cb-watch', from: { id: 123 }, data: 'v1|watch|session1|cluster', message: { message_id: 51, chat: { id: 123, type: 'private' }, text: 'summary' } } });
    expect(service.watch).toHaveBeenCalledWith('123', '123', 'entity:1');
    expect(api.answerCallbackQuery).toHaveBeenCalledWith('cb-watch', 'Cluster added to monitoring');
    expect(vi.mocked(api.editMessage).mock.calls[0]?.[2]).toContain('MONITORING ENABLED');
  });

  it.each([
    ['cluster', 'ENTITY CLUSTER'],
    ['deployments', 'TOP DEPLOYMENTS'],
    ['evidence', 'EVIDENCE DESK'],
    ['history', 'ENTITY HISTORY'],
    ['outcomes', 'OUTCOMES']
  ])('renders the %s intelligence screen from persisted real fields', async (view, heading) => {
    const api = apiMock();
    const service = {
      clearPendingSession: vi.fn(),
      getSession: vi.fn().mockResolvedValue({ id: 'session1', workflow: 'wallet', stateJson: { target: ADDRESS, investigationId: 'investigation1', investigationView: 'summary', page: 1, pageSize: 5 } }),
      updateSession: vi.fn().mockResolvedValue(true), loadWalletInvestigation: vi.fn().mockResolvedValue(investigation())
    } as unknown as OperatorService;
    await createUpdateHandler(service, api, new Set(['123']))({ update_id: 52, callback_query: { id: `cb-${view}`, from: { id: 123 }, data: `v1|invest|session1|${view}`, message: { message_id: 52, chat: { id: 123, type: 'private' }, text: 'summary' } } });
    expect(vi.mocked(api.editMessage).mock.calls[0]?.[2]).toContain(heading);
    expect(service.updateSession).toHaveBeenCalledWith('session1', '123', '123', expect.objectContaining({ investigationView: view, investigationPreviousView: 'summary' }));
  });

  it('returns from wallet evidence to the exact previous investigation screen', async () => {
    const api = apiMock();
    const service = {
      clearPendingSession: vi.fn(),
      getSession: vi.fn().mockResolvedValue({ id: 'session1', workflow: 'wallet', stateJson: { target: ADDRESS, investigationId: 'investigation1', investigationView: 'evidence', investigationItem: 'w:0', investigationPreviousView: 'priority', investigationPreviousPage: 1, page: 1, pageSize: 5 } }),
      updateSession: vi.fn().mockResolvedValue(true), loadWalletInvestigation: vi.fn().mockResolvedValue(investigation())
    } as unknown as OperatorService;
    await createUpdateHandler(service, api, new Set(['123']))({ update_id: 53, callback_query: { id: 'cb-back', from: { id: 123 }, data: 'v1|back|session1|previous', message: { message_id: 53, chat: { id: 123, type: 'private' }, text: 'evidence' } } });
    expect(service.updateSession).toHaveBeenCalledWith('session1', '123', '123', expect.objectContaining({ investigationView: 'priority', investigationPreviousView: 'summary' }));
    expect(vi.mocked(api.editMessage).mock.calls[0]?.[2]).toContain('CAPITAL PATHS');
  });

  it('clears pending state on /cancel and Back', async () => {
    const api = apiMock();
    const service = { clearPendingSession: vi.fn().mockResolvedValue(1) } as unknown as OperatorService;
    const handler = createUpdateHandler(service, api, new Set(['123']));
    await handler({ update_id: 6, message: { message_id: 6, from: { id: 123 }, chat: { id: 123, type: 'private' }, text: '/cancel' } });
    await handler({ update_id: 7, callback_query: { id: 'cb1', from: { id: 123 }, data: 'v1|cancel|pending1|pending', message: { message_id: 7, chat: { id: 123, type: 'private' }, text: 'Pošalji wallet adresu.' } } });
    expect(service.clearPendingSession).toHaveBeenCalledTimes(2);
    expect(api.editMessage).toHaveBeenCalledWith('123', 7, '✓ <b>Action cancelled.</b>', { inline_keyboard: [] });
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
    expect(vi.mocked(api.sendMessage).mock.calls[0]?.[1]).toContain('Nije pronađen nijedan top-PnL wallet za ovaj token.');
  });

  it('does not edit an unchanged Telegram message', async () => {
    const api = apiMock();
    const keyboard = navKeyboard('session1', 1, false);
    const service = {
      clearPendingSession: vi.fn(), getSession: vi.fn().mockResolvedValue({ id: 'session1', workflow: 'recent', stateJson: { page: 1, pageSize: 10 } }),
      updateSession: vi.fn().mockResolvedValue(true), recent: vi.fn().mockResolvedValue({ items: [], page: 1, pageSize: 10, total: 0, hasNext: false, coverageWarnings: [] })
    } as unknown as OperatorService;
    await createUpdateHandler(service, api, new Set(['123']))({ update_id: 10, callback_query: { id: 'cb2', from: { id: 123 }, data: 'v1|exportback|session1|result', message: { message_id: 10, chat: { id: 123, type: 'private' }, text: '📡 LIVE INTELLIGENCE FEED\n━━━━━━━━━━━━━━━━━━━━\nRelevant events 0  ·  Page 1', reply_markup: keyboard } } });
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
