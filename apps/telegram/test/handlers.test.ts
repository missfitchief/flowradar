import { describe, expect, it, vi } from 'vitest';
import type { InvestigationMemberIntelligence, OperatorService, WalletInvestigationResult } from '@flowradar/db';
import { createUpdateHandler, resumeWalletInvestigationJobs } from '../src/handlers';
import { navKeyboard } from '../src/render';
import type { TelegramApi } from '../src/types';

const ADDRESS = '11111111111111111111111111111111';
const RECEIVER = '22222222222222222222222222222222';
const TOKEN = '33333333333333333333333333333333';
const EVM_TOKEN = `0x${'ab'.repeat(20)}`;

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
    expect(api.sendMessage).toHaveBeenCalledWith('123', expect.stringContaining('Send a wallet address.'), expect.objectContaining({ inline_keyboard: expect.any(Array) }));
  });

  it('renders /list as a paginated Core wallet terminal without transaction spam', async () => {
    const api = apiMock();
    const service = {
      clearPendingSession: vi.fn(), createSession: vi.fn().mockResolvedValue({ id: 'core-session' }),
      listCoreWallets: vi.fn().mockResolvedValue({
        page: 1, pageSize: 5, total: 1, hasNext: false, coverageWarnings: [],
        items: [{ address: ADDRESS, chains: ['SOLANA'], label: 'Dormant Alpha', status: 'Dormant', historicalAlpha: 91, evidence: 84, lastActivity: '2025-01-01T00:00:00.000Z', monitoringPriority: 'root_permanent', eventCount: 42, entity: 'Entity One' }]
      })
    } as unknown as OperatorService;
    await createUpdateHandler(service, api, new Set(['123']))({ update_id: 20, message: { message_id: 20, from: { id: 123 }, chat: { id: 123, type: 'private' }, text: '/list' } });
    const [, text, keyboard] = vi.mocked(api.sendMessage).mock.calls[0]!;
    expect(text).toContain('CORE WALLET MONITOR');
    expect(text).toContain('Dormant Alpha');
    expect(text).toContain('91/100');
    expect(keyboard?.inline_keyboard.flat()[0]?.callback_data).toBe('v1|corewallet|core-session|0');
    expect(text).not.toContain('Sent 0');
  });

  it('renders the production /alerts inbox with compact receipts and filters', async () => {
    const api = apiMock();
    const service = {
      clearPendingSession: vi.fn(), createSession: vi.fn().mockResolvedValue({ id: 'alerts-session' }),
      alertInbox: vi.fn().mockResolvedValue({
        page: 1, pageSize: 5, total: 1, hasNext: false,
        items: [{
          id: 'receipt-1', category: 'rejected', status: 'rejected', token: 'OLD', chain: 'SOLANA',
          qualifyingWalletCount: 1, independentEntityCount: 0, amountUsd: 125, signalTier: null,
          rejectionReason: 'solo_core_buy_no_confluence', timestamp: '2026-07-14T12:00:00.000Z'
        }]
      })
    } as unknown as OperatorService;

    await createUpdateHandler(service, api, new Set(['123']))({
      update_id: 24, message: { message_id: 24, from: { id: 123 }, chat: { id: 123, type: 'private' }, text: '/alerts' }
    });

    expect(service.alertInbox).toHaveBeenCalledWith('123', '123', 'push', 1, 5);
    const [, text, keyboard] = vi.mocked(api.sendMessage).mock.calls[0]!;
    expect(text).toContain('ALERT INBOX');
    expect(text).toContain('solo_core_buy_no_confluence');
    expect(text).not.toContain('payloadJson');
    expect(keyboard?.inline_keyboard.flat().map((button) => button.text)).toEqual([
      '• Push', 'Inbox only', 'Rejected', 'Dormant', 'Cluster', 'Independent'
    ]);
  });

  it('switches /alerts filters and resets pagination without dispatching a push', async () => {
    const api = apiMock();
    const service = {
      clearPendingSession: vi.fn(),
      getSession: vi.fn().mockResolvedValue({ id: 'alerts-session', workflow: 'alerts', stateJson: { page: 3, pageSize: 5, alertFilter: 'push' } }),
      updateSession: vi.fn().mockResolvedValue(true),
      alertInbox: vi.fn().mockResolvedValue({ page: 1, pageSize: 5, total: 0, hasNext: false, items: [] })
    } as unknown as OperatorService;

    await createUpdateHandler(service, api, new Set(['123']))({
      update_id: 25, callback_query: {
        id: 'alerts-filter', from: { id: 123 }, data: 'v1|alertfilter|alerts-session|rejected',
        message: { message_id: 25, chat: { id: 123, type: 'private' }, text: 'old inbox' }
      }
    });

    expect(service.updateSession).toHaveBeenCalledWith('alerts-session', '123', '123', expect.objectContaining({ alertFilter: 'rejected', page: 1 }));
    expect(service.alertInbox).toHaveBeenCalledWith('123', '123', 'rejected', 1, 5);
    expect(api.editMessage).toHaveBeenCalledWith('123', 25, expect.stringContaining('Rejected'), expect.any(Object));
  });

  it('adds a Core wallet, starts persisted historical sync, and acknowledges immediately', async () => {
    const api = apiMock();
    const service = {
      validateWorkflowTarget: vi.fn().mockResolvedValue(true), clearPendingSession: vi.fn(),
      addCoreWallet: vi.fn().mockResolvedValue({ watch: { targetKey: ADDRESS }, refs: [{ chain: 'SOLANA', address: ADDRESS }], roots: ['root1'] }),
      queueCoreHistoricalSync: vi.fn().mockResolvedValue({ id: 'core-sync', stateJson: { target: ADDRESS, page: 1, pageSize: 5, investigationStatus: 'queued', silentCoreSync: true } }),
      updateSession: vi.fn().mockResolvedValue(true), walletInvestigationView: vi.fn().mockResolvedValue(investigation())
    } as unknown as OperatorService;
    await createUpdateHandler(service, api, new Set(['123']))({ update_id: 21, message: { message_id: 21, from: { id: 123 }, chat: { id: 123, type: 'private' }, text: `/add ${ADDRESS}` } });
    expect(service.addCoreWallet).toHaveBeenCalledWith('123', '123', ADDRESS);
    expect(service.queueCoreHistoricalSync).toHaveBeenCalledWith('123', '123', ADDRESS);
    expect(vi.mocked(api.sendMessage).mock.calls[0]?.[1]).toContain('CORE WALLET ADDED');
    await vi.waitFor(() => expect(service.walletInvestigationView).toHaveBeenCalledWith(ADDRESS, { maxDepth: 4, refresh: true }));
    expect(vi.mocked(api.sendMessage).mock.calls.filter((call) => call[1].includes('FLOWRADAR INTELLIGENCE'))).toHaveLength(0);
  });

  it('opens Core wallet detail from /list and exposes only operator controls', async () => {
    const api = apiMock();
    const item = { address: ADDRESS, chains: ['SOLANA'] as const, label: 'Core One', status: 'Active' as const, historicalAlpha: 88, evidence: 76, lastActivity: '2026-07-14T01:00:00.000Z', monitoringPriority: 'root_permanent', eventCount: 12, entity: 'Entity One' };
    const service = {
      clearPendingSession: vi.fn(),
      getSession: vi.fn().mockResolvedValue({ id: 'core-session', workflow: 'core', stateJson: { page: 1, pageSize: 5, coreView: 'list' } }),
      coreWalletAt: vi.fn().mockResolvedValue(item), coreWalletDetail: vi.fn().mockResolvedValue(item), updateSession: vi.fn().mockResolvedValue(true)
    } as unknown as OperatorService;
    await createUpdateHandler(service, api, new Set(['123']))({ update_id: 22, callback_query: { id: 'core-cb', from: { id: 123 }, data: 'v1|corewallet|core-session|0', message: { message_id: 22, chat: { id: 123, type: 'private' }, text: 'list' } } });
    const [, , text, keyboard] = vi.mocked(api.editMessage).mock.calls[0]!;
    expect(text).toContain('CORE WALLET');
    expect(text).toContain('Stored events  <b>12</b>');
    expect(keyboard?.inline_keyboard.flat().map((button) => button.text)).toEqual(['📋 Activity', '💸 Capital Path', '🧩 Entity', '🗑 Remove', '← Back']);
  });

  it('opens qualified wallet details from a Core confluence alert callback', async () => {
    const api = apiMock();
    const service = {
      coreMonitoringAlert: vi.fn().mockResolvedValue({
        id: 'cluster-alert', alertType: 'core_multi_wallet_buy',
        payloadJson: {
          token: 'NEW', chain: 'SOLANA', rawWalletCount: 2, independentEntityCount: 2,
          participants: [{ wallet: ADDRESS, role: 'core', amountUsd: 125, entityLabel: 'Alpha Entity' }]
        }
      })
    } as unknown as OperatorService;

    await createUpdateHandler(service, api, new Set(['123']))({
      update_id: 23,
      callback_query: {
        id: 'core-alert-cb', from: { id: 123 }, data: 'c2|w|cluster-alert',
        message: { message_id: 23, chat: { id: 123, type: 'private' }, text: 'cluster summary' }
      }
    });

    expect(service.coreMonitoringAlert).toHaveBeenCalledWith('cluster-alert', '123', '123');
    expect(api.editMessage).toHaveBeenCalledWith('123', 23, expect.stringContaining(`<code>${ADDRESS}</code>`), expect.any(Object));
    expect(api.answerCallbackQuery).toHaveBeenCalledWith('core-alert-cb');
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
    expect(vi.mocked(api.sendMessage).mock.calls[0]?.[1]).toContain('Solana base58 address (32–44 characters)');
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
    await handler({ update_id: 7, callback_query: { id: 'cb1', from: { id: 123 }, data: 'v1|cancel|pending1|pending', message: { message_id: 7, chat: { id: 123, type: 'private' }, text: 'Send a wallet address.' } } });
    expect(service.clearPendingSession).toHaveBeenCalledTimes(2);
    expect(api.editMessage).toHaveBeenCalledWith('123', 7, '✓ <b>Action cancelled.</b>', { inline_keyboard: [] });
  });

  it('offers wallet/token choice for an ambiguous direct address', async () => {
    const api = apiMock();
    const service = { getPendingSession: vi.fn().mockResolvedValue(null), classifyAddressInput: vi.fn().mockResolvedValue('ambiguous'), createSession: vi.fn().mockResolvedValue({ id: 'session1' }) } as unknown as OperatorService;
    await createUpdateHandler(service, api, new Set(['123']))({ update_id: 8, message: { message_id: 8, from: { id: 123 }, chat: { id: 123, type: 'private' }, text: ADDRESS } });
    const keyboard = vi.mocked(api.sendMessage).mock.calls[0]?.[2];
    expect(keyboard?.inline_keyboard[0]?.map((button) => button.text)).toEqual(['Analyze as wallet', 'Analyze as token']);
  });

  it('acknowledges a direct valid Solana token before the real scan and keeps an empty result short', async () => {
    const api = apiMock();
    const service = {
      validateWorkflowTarget: vi.fn().mockResolvedValue(true), clearPendingSession: vi.fn(), createSession: vi.fn().mockResolvedValue({ id: 'session1' }),
      scanTokenTopPnl: vi.fn().mockResolvedValue({ chains: ['SOLANA'], candidateCount: 0 }),
      tokenSummary: vi.fn().mockResolvedValue({ topPnl: { items: [], page: 1, pageSize: 10, total: 0, hasNext: false } })
    } as unknown as OperatorService;
    await createUpdateHandler(service, api, new Set(['123']))({ update_id: 9, message: { message_id: 9, from: { id: 123 }, chat: { id: 123, type: 'private' }, text: `/token ${ADDRESS}` } });
    expect(vi.mocked(api.sendMessage).mock.calls[0]?.[1]).toContain('Token received. Analysis started');
    expect(vi.mocked(api.sendMessage).mock.calls[1]?.[1]).toContain('No validated trader wallets found.');
    expect(service.tokenSummary).toHaveBeenCalledTimes(1);
    expect(service.scanTokenTopPnl).toHaveBeenCalledWith(ADDRESS);
  });

  it('renders token intelligence as a compact decision screen without provider/debug fields', async () => {
    const api = apiMock();
    const now = Date.now();
    const daysAgo = (days: number) => new Date(now - days * 86_400_000).toISOString();
    const hoursAgo = (hours: number) => new Date(now - hours * 3_600_000).toISOString();
    const rows = [
      { walletAddress: 'WalletOneFullAddress', qualityScore: 94, medianRoi: 1.84, realizedPnlUsd: 125_400, status: 'Holding', lastActivityTs: daysAgo(45), alphaConfidence: 0.91, alphaSampleSize: 28, winRate: 0.72, relatedWalletCount: 2, finalRankingScore: 92, entityKey: 'entity:one' },
      { walletAddress: 'WalletTwoFullAddress', qualityScore: 88, medianRoi: 0.96, realizedPnlUsd: 88_200, status: 'Active Trader', lastActivityTs: hoursAgo(2), alphaConfidence: 0.66, alphaSampleSize: 11, winRate: 0.64, relatedWalletCount: 0, finalRankingScore: 86, entityKey: 'entity:two' },
      { walletAddress: 'WalletThreeFullAddress', qualityScore: 85, medianRoi: 0.82, realizedPnlUsd: 54_000, status: 'Dormant', lastActivityTs: daysAgo(214), alphaConfidence: 0.8, alphaSampleSize: 18, winRate: 0.61, relatedWalletCount: 0, finalRankingScore: 84, entityKey: 'entity:three' },
      { walletAddress: 'WalletFourFullAddress', qualityScore: 72, medianRoi: 0.55, realizedPnlUsd: 20_000, status: 'Unknown', lastActivityTs: null, alphaConfidence: 0.5, alphaSampleSize: 4, winRate: 0.5, relatedWalletCount: 0, finalRankingScore: 70, entityKey: 'entity:four' },
      { walletAddress: 'WalletFiveFullAddress', qualityScore: 61, medianRoi: 0.4, realizedPnlUsd: 8_000, status: 'Exited', lastActivityTs: daysAgo(4), alphaConfidence: 0.4, alphaSampleSize: 3, winRate: 0.5, relatedWalletCount: 0, finalRankingScore: 62, entityKey: 'entity:five' },
      { walletAddress: 'WalletSixHiddenAddress', qualityScore: 55, roi: 0.4, realizedPnlUsd: 2_000, boughtUsd: 4_000, soldUsd: null, remainingPositionUsd: null, firstBuyTs: daysAgo(3), firstSellTs: null, lastActivityTs: daysAgo(3), repeatRunnerCount: 0, confidence: 0.4, entityKey: null, role: 'trader' }
    ].map((row) => ({ chain: 'SOLANA', validation: 'validated_trader', dormancy: null, ...row }));
    const summary = {
      tokens: [{ symbol: 'ALPHA', name: 'Alpha Token' }], metadata: [],
      candidateSelection: { candidatesAnalyzed: 50, infrastructureExcluded: 31, exchangeExcluded: 4, ownershipUnverified: 7, unreliablePnl: 2, validatedTraders: 12, probableTraders: 1, uniqueEntities: 7, cohort: { medianAlpha: 87, medianRoi: 1.84, active: 1, dormant: 1, holding: 1 } },
      topPnl: { items: rows.slice(0, 5), page: 1, pageSize: 10, total: 5, hasNext: false }
    };
    const service = {
      validateWorkflowTarget: vi.fn().mockResolvedValue(true), clearPendingSession: vi.fn(), createSession: vi.fn().mockResolvedValue({ id: 'compact-token-session' }),
      scanTokenTopPnl: vi.fn().mockResolvedValue({ chains: ['SOLANA'], candidateCount: rows.length }), tokenSummary: vi.fn().mockResolvedValue(summary)
    } as unknown as OperatorService;

    await createUpdateHandler(service, api, new Set(['123']))({ update_id: 97, message: { message_id: 97, from: { id: 123 }, chat: { id: 123, type: 'private' }, text: `/token ${ADDRESS}` } });

    const [, text, keyboard] = vi.mocked(api.sendMessage).mock.calls[1]!;
    expect(text).toContain('🎯 <b>TOKEN INTELLIGENCE</b>');
    expect(text).toContain('<b>ALPHA</b>');
    expect(text).toContain('<b>50</b> candidates analyzed');
    expect(text).toContain('<b>31</b> infrastructure excluded');
    expect(text).toContain('<b>12</b> validated traders');
    expect(text).toContain('<b>7</b> unique entities');
    expect(text).toContain('Median Alpha');
    expect(text).toContain('Median ROI');
    expect(text).toContain('🟢 <b>Alpha 94</b>');
    expect(text).toContain('🟢 <b>Holding</b>');
    expect(text).toContain('🟢 <b>Active Trader</b>');
    expect(text).toContain('⚪ <b>Unknown</b>');
    expect(text).toContain('🔴 <b>Exited</b>');
    expect(text).toContain('Dormant 214d');
    expect(text).toContain('High-conviction trader.');
    expect(text).not.toContain('WalletOneFullAddress');
    expect(text).not.toContain('WalletSixHiddenAddress');
    expect(text).not.toMatch(/provider only|Position \$0|Capital in|Entry UTC|UTC/i);
    expect(keyboard?.inline_keyboard).toHaveLength(5);
  });

  it('renders Solana holder intelligence with real holder rank and no provider-only PnL', async () => {
    const api = apiMock();
    const report = {
      chain: 'SOLANA', tokenAddress: ADDRESS, tokenSymbol: 'ALPHA', holdersScanned: 50, ownersResolved: 50,
      uniqueOwnerWallets: 44, infrastructureExcluded: 12, csvMatches: 2, flowradarMatches: 3,
      liveEnriched: 8, smartProfiles: 7, uniqueEntities: 6, processingTimeMs: 2_100, coverageWarnings: [],
      profiles: [{
        holderRank: 7, walletAddress: 'GV6UUmNxz2RpKxmNAPadYKb7uQpszwqQAu3qLJxVdC52', entityKey: 'entity:one',
        relatedWalletCount: 1, tags: ['Dormant', 'Insider', 'Sniper'], wins: [], medianHoldMs: null,
        reliability: 92, historicalAlpha: 88, rankingScore: 91, passReasons: ['csv_high_reliability'],
        holdings: [{ symbol: 'ALPHA', tokenAddress: ADDRESS, usdValue: 31_000, supplyPercentage: 4.8 }]
      }]
    };
    const service = {
      validateWorkflowTarget: vi.fn().mockResolvedValue(true), clearPendingSession: vi.fn(),
      createSession: vi.fn().mockResolvedValue({ id: 'holder-session' }), investigateTokenHolders: vi.fn().mockResolvedValue(report)
    } as unknown as OperatorService;

    await createUpdateHandler(service, api, new Set(['123']))({ update_id: 98, message: { message_id: 98, from: { id: 123 }, chat: { id: 123, type: 'private' }, text: `/token ${ADDRESS}` } });

    const [, text, keyboard] = vi.mocked(api.sendMessage).mock.calls[1]!;
    expect(text).toContain('50 holders scanned · 7 smart profiles');
    expect(text).toContain('12 infrastructure excluded · 6 unique entities');
    expect(text).toContain('HOLDER #7');
    expect(text).toContain('Dormant · Insider · Sniper');
    expect(text).toContain('Wins: No verified history');
    expect(text).toContain('ALPHA 4.8%');
    expect(text).toContain('Reliability: 92/100');
    expect(text).not.toMatch(/provider|realized pnl|roi|trade_ownership_unverified/i);
    expect(keyboard?.inline_keyboard[0]?.map((button) => button.text)).toEqual(['Copy #1', 'Explorer ↗']);
    expect(service.investigateTokenHolders).toHaveBeenCalledWith(ADDRESS);
  });

  it('accepts a valid EVM contract in the direct /token flow', async () => {
    const api = apiMock();
    const service = {
      validateWorkflowTarget: vi.fn().mockResolvedValue(true), clearPendingSession: vi.fn(), createSession: vi.fn().mockResolvedValue({ id: 'evm-token-session' }),
      scanTokenTopPnl: vi.fn().mockResolvedValue({ chains: ['ETHEREUM', 'BASE', 'ARBITRUM', 'BSC'], candidateCount: 0 }),
      tokenSummary: vi.fn().mockResolvedValue({ topPnl: { items: [], page: 1, pageSize: 10, total: 0, hasNext: false } })
    } as unknown as OperatorService;

    await createUpdateHandler(service, api, new Set(['123']))({ update_id: 90, message: { message_id: 90, from: { id: 123 }, chat: { id: 123, type: 'private' }, text: `/token ${EVM_TOKEN}` } });

    expect(service.validateWorkflowTarget).toHaveBeenCalledWith('token', EVM_TOKEN);
    expect(service.scanTokenTopPnl).toHaveBeenCalledWith(EVM_TOKEN);
    expect(vi.mocked(api.sendMessage).mock.calls[0]?.[1]).toContain('Token received. Analysis started');
  });

  it('rejects an invalid token without creating an analysis session', async () => {
    const api = apiMock();
    const service = { validateWorkflowTarget: vi.fn().mockResolvedValue(false) } as unknown as OperatorService;

    await createUpdateHandler(service, api, new Set(['123']))({ update_id: 91, message: { message_id: 91, from: { id: 123 }, chat: { id: 123, type: 'private' }, text: '/token not-a-token' } });

    expect(api.sendMessage).toHaveBeenCalledWith('123', expect.stringContaining('INVALID TOKEN CONTRACT'));
  });

  it('supports /token without an argument followed by the token address', async () => {
    const api = apiMock();
    const service = {
      setPendingSession: vi.fn().mockResolvedValue({ id: 'pending-token' }),
      getPendingSession: vi.fn().mockResolvedValue({ workflow: 'token', session: { id: 'pending-token' } }),
      validateWorkflowTarget: vi.fn().mockResolvedValue(true), clearPendingSession: vi.fn(),
      createSession: vi.fn().mockResolvedValue({ id: 'token-session' }), scanTokenTopPnl: vi.fn().mockResolvedValue({ chains: ['SOLANA'], candidateCount: 0 }),
      tokenSummary: vi.fn().mockResolvedValue({ topPnl: { items: [], page: 1, pageSize: 10, total: 0, hasNext: false } })
    } as unknown as OperatorService;
    const handler = createUpdateHandler(service, api, new Set(['123']));

    await handler({ update_id: 92, message: { message_id: 92, from: { id: 123 }, chat: { id: 123, type: 'private' }, text: '/token' } });
    await handler({ update_id: 93, message: { message_id: 93, from: { id: 123 }, chat: { id: 123, type: 'private' }, text: ADDRESS } });

    expect(service.setPendingSession).toHaveBeenCalledWith('123', '123', 'token', 10);
    expect(service.scanTokenTopPnl).toHaveBeenCalledWith(ADDRESS);
    expect(vi.mocked(api.sendMessage).mock.calls.map((call) => call[1])).toEqual(expect.arrayContaining([
      expect.stringContaining('Send a token contract address.'), expect.stringContaining('Token received. Analysis started')
    ]));
  });

  it('never exposes a Prisma schema/query mismatch through Telegram and offers Retry/Back', async () => {
    const api = apiMock();
    const stack = 'Invalid this.prisma.tokenMetadata.count() invocation\nUnknown argument tokenAddress. Did you mean toAddress?';
    const service = {
      validateWorkflowTarget: vi.fn().mockResolvedValue(true), clearPendingSession: vi.fn(), createSession: vi.fn().mockResolvedValue({ id: 'failed-token-session' }),
      tokenSummary: vi.fn().mockRejectedValue(new Error(stack)), scanTokenTopPnl: vi.fn()
    } as unknown as OperatorService;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await createUpdateHandler(service, api, new Set(['123']))({ update_id: 94, message: { message_id: 94, from: { id: 123 }, chat: { id: 123, type: 'private' }, text: `/token ${ADDRESS}` } });

    const [, text, keyboard] = vi.mocked(api.sendMessage).mock.calls[1]!;
    expect(text).toContain('TOKEN ANALYSIS FAILED');
    expect(text).toContain('Internal database query failed.');
    expect(text).not.toContain('tokenMetadata.count');
    expect(text).not.toContain('tokenAddress');
    expect(keyboard?.inline_keyboard[0]?.map((button) => button.text)).toEqual(['Retry', 'Back']);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('tokenMetadata.count'));
    errorSpy.mockRestore();
  });

  it('runs Retry through the real token workflow and Back returns to the menu', async () => {
    const api = apiMock();
    const service = {
      clearPendingSession: vi.fn(),
      getSession: vi.fn().mockResolvedValue({ id: 'retry-token-session', workflow: 'token', stateJson: { target: ADDRESS, page: 1, pageSize: 10 } }),
      scanTokenTopPnl: vi.fn().mockResolvedValue({ chains: ['SOLANA'], candidateCount: 0 }),
      tokenSummary: vi.fn().mockResolvedValue({ topPnl: { items: [], page: 1, pageSize: 10, total: 0, hasNext: false } })
    } as unknown as OperatorService;
    const handler = createUpdateHandler(service, api, new Set(['123']));

    await handler({ update_id: 95, callback_query: { id: 'token-retry', from: { id: 123 }, data: 'v1|tokenretry|retry-token-session|run', message: { message_id: 95, chat: { id: 123, type: 'private' }, text: 'TOKEN ANALYSIS FAILED' } } });
    await handler({ update_id: 96, callback_query: { id: 'token-back', from: { id: 123 }, data: 'v1|tokenback|retry-token-session|menu', message: { message_id: 96, chat: { id: 123, type: 'private' }, text: 'TOKEN ANALYSIS FAILED' } } });

    expect(service.scanTokenTopPnl).toHaveBeenCalledWith(ADDRESS);
    expect(vi.mocked(api.editMessage).mock.calls.some((call) => call[2].includes('No validated trader wallets found'))).toBe(true);
    expect(vi.mocked(api.editMessage).mock.calls.some((call) => call[2].includes('FLOWRADAR INTELLIGENCE'))).toBe(true);
    expect(api.answerCallbackQuery).toHaveBeenCalledWith('token-retry', 'Analysis completed');
    expect(api.answerCallbackQuery).toHaveBeenCalledWith('token-back');
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
