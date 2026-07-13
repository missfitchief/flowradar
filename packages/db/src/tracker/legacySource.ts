import type { MassTransactionEvent } from '@flowradar/core';
import type { MoneyFlowEdge, PrismaClient, Token, Wallet, WalletTokenTrade } from '@prisma/client';
import type { MassTrackerSourceItem } from './massTracker';

export interface LegacyTrackerSourceOptions {
  maxEdges?: number;
  maxBuys?: number;
  readBatchSize?: number;
  observedAt?: Date;
  onEvent?: (event: MassTransactionEvent, source: 'money_flow_edges' | 'wallet_token_trades') => void;
}

type LegacyBuyRow = WalletTokenTrade & { wallet: Pick<Wallet, 'address'>; token: Pick<Token, 'address' | 'symbol' | 'decimals'> };

/** Cursor-streams existing real evidence; never loads the dataset into RAM. */
export async function* streamLegacyTrackerDataset(
  prisma: PrismaClient,
  options: LegacyTrackerSourceOptions = {}
): AsyncIterable<MassTrackerSourceItem> {
  const maxEdges = clamp(options.maxEdges ?? 250_000, 0, 10_000_000);
  const maxBuys = clamp(options.maxBuys ?? 50_000, 0, 10_000_000);
  const take = clamp(options.readBatchSize ?? 2_000, 1, 10_000);
  const observedAt = options.observedAt ?? new Date();
  let edgeCursor: string | undefined;
  let emittedEdges = 0;
  while (emittedEdges < maxEdges) {
    const rows = await prisma.moneyFlowEdge.findMany({
      take: Math.min(take, maxEdges - emittedEdges),
      ...(edgeCursor ? { cursor: { id: edgeCursor }, skip: 1 } : {}),
      orderBy: { id: 'asc' }
    });
    if (rows.length === 0) break;
    for (const row of rows) {
      const event = legacyEdgeToEvent(row, observedAt);
      options.onEvent?.(event, 'money_flow_edges');
      yield { event };
      emittedEdges++;
    }
    edgeCursor = rows.at(-1)!.id;
  }

  let tradeCursor: string | undefined;
  let emittedBuys = 0;
  while (emittedBuys < maxBuys) {
    const rows = await prisma.walletTokenTrade.findMany({
      where: { action: 'BUY' }, take: Math.min(take, maxBuys - emittedBuys),
      ...(tradeCursor ? { cursor: { id: tradeCursor }, skip: 1 } : {}),
      orderBy: { id: 'asc' },
      include: { wallet: { select: { address: true } }, token: { select: { address: true, symbol: true, decimals: true } } }
    });
    if (rows.length === 0) break;
    for (const row of rows) {
      const event = legacyBuyToEvent(row, observedAt);
      options.onEvent?.(event, 'wallet_token_trades');
      yield { event };
      emittedBuys++;
    }
    tradeCursor = rows.at(-1)!.id;
  }
}

export interface LegacyLineageEvidenceOptions {
  maxEdges?: number;
  maxBuys?: number;
  sourcesPerQuery?: number;
  observedAt?: Date;
}

/**
 * Targeted real-evidence backfill: existing roots/lineage subscriptions ->
 * outgoing capital -> destination wallets' locally persisted BUYs.
 */
export async function* streamLegacyLineageEvidence(
  prisma: PrismaClient,
  options: LegacyLineageEvidenceOptions = {}
): AsyncIterable<MassTrackerSourceItem> {
  const maxEdges = clamp(options.maxEdges ?? 100_000, 1, 1_000_000);
  const maxBuys = clamp(options.maxBuys ?? 50_000, 1, 1_000_000);
  const chunkSize = clamp(options.sourcesPerQuery ?? 100, 10, 500);
  const observedAt = options.observedAt ?? new Date();
  const [roots, subscriptions] = await Promise.all([
    prisma.lineageRoot.findMany({ where: { permanent: true }, select: { wallet: { select: { chain: true, address: true } } } }),
    prisma.monitoringSubscription.findMany({ where: { active: true, lineageRootId: { not: null } }, select: { wallet: { select: { chain: true, address: true } } } })
  ]);
  const sourceKeys = new Map<string, { chain: 'SOLANA' | 'BSC'; address: string }>();
  for (const item of [...roots, ...subscriptions]) sourceKeys.set(`${item.wallet.chain}:${item.wallet.address}`, item.wallet);
  const destinations = new Map<string, { chain: 'SOLANA' | 'BSC'; address: string }>();
  let edges = 0;
  for (const chain of ['SOLANA', 'BSC'] as const) {
    const addresses = [...sourceKeys.values()].filter((x) => x.chain === chain).map((x) => x.address);
    for (const chunk of chunks(addresses, chunkSize)) {
      if (edges >= maxEdges) break;
      const rows = await prisma.moneyFlowEdge.findMany({
        where: { sourceChain: chain, sourceAddress: { in: chunk }, actionType: { in: ['transfer', 'cex_deposit', 'cex_withdrawal', 'bridge_deposit', 'bridge_withdrawal'] } },
        orderBy: [{ ts: 'desc' }, { id: 'asc' }], take: Math.min(5_000, maxEdges - edges)
      });
      for (const row of rows) {
        destinations.set(`${row.destinationChain}:${row.destinationAddress}`, { chain: row.destinationChain, address: row.destinationAddress });
        yield { event: legacyEdgeToEvent(row, observedAt) };
        edges++;
      }
    }
  }
  let buys = 0;
  for (const chain of ['SOLANA', 'BSC'] as const) {
    const addresses = [...destinations.values()].filter((x) => x.chain === chain).map((x) => x.address);
    for (const chunk of chunks(addresses, 500)) {
      if (buys >= maxBuys) break;
      const rows = await prisma.walletTokenTrade.findMany({
        where: { chain, action: 'BUY', wallet: { address: { in: chunk } } },
        orderBy: [{ ts: 'asc' }, { id: 'asc' }], take: Math.min(5_000, maxBuys - buys),
        include: { wallet: { select: { address: true } }, token: { select: { address: true, symbol: true, decimals: true } } }
      });
      for (const row of rows) { yield { event: legacyBuyToEvent(row, observedAt) }; buys++; }
    }
  }
}

export function legacyEdgeToEvent(row: MoneyFlowEdge, observedAt: Date): MassTransactionEvent {
  const kind = edgeKind(row.actionType, row.assetMint !== null);
  return {
    eventId: `legacy-edge:${row.id}`, chain: row.sourceChain, txHash: row.txHash,
    eventIndex: stableEventIndex(row.id), blockOrSlot: 0n, ts: row.ts, kind,
    status: 'succeeded', from: canonical(row.sourceChain, row.sourceAddress),
    to: canonical(row.destinationChain, row.destinationAddress), actor: canonical(row.sourceChain, row.sourceAddress),
    asset: { address: row.assetMint ? canonical(row.sourceChain, row.assetMint) : null, symbol: row.asset || null, decimals: null, amount: row.amountToken.toString(), amountUsd: honestUsd(row) },
    programOrContract: row.bridgeProtocol, provider: `legacy:${row.providerSource}`, observedAt, bridge: null,
    metadata: { legacyTable: 'money_flow_edges', legacyId: row.id, originalActionType: row.actionType, bridgeLinkStatus: row.actionType.startsWith('bridge_') ? 'unverified_legacy_heuristic' : null }
  };
}

export function legacyBuyToEvent(row: LegacyBuyRow, observedAt: Date): MassTransactionEvent {
  const actor = canonical(row.chain, row.wallet.address);
  return {
    eventId: `legacy-buy:${row.id}`, chain: row.chain, txHash: row.txHash,
    eventIndex: stableEventIndex(row.id), blockOrSlot: row.blockOrSlot, ts: row.ts,
    kind: 'token_buy', status: 'succeeded', from: actor, to: actor, actor,
    asset: { address: canonical(row.chain, row.token.address), symbol: row.token.symbol, decimals: row.token.decimals, amount: row.amountToken.toString(), amountUsd: Number(row.amountUsd) > 0 ? Number(row.amountUsd) : null },
    programOrContract: null, provider: `legacy:${row.provider}`, observedAt, bridge: null,
    metadata: { legacyTable: 'wallet_token_trades', legacyId: row.id, locallyPersistedBuy: true }
  };
}

function edgeKind(action: string, token: boolean): MassTransactionEvent['kind'] {
  if (action === 'bridge_deposit') return 'bridge_source';
  if (action === 'bridge_withdrawal') return 'bridge_destination';
  if (action === 'dex_buy') return 'token_buy';
  if (action === 'dex_sell') return 'token_sell';
  if (action === 'contract_interaction') return 'contract_interaction';
  if (action === 'lp_add') return 'lp_add';
  if (action === 'lp_remove') return 'lp_remove';
  return token ? 'token_transfer' : 'native_transfer';
}
function honestUsd(row: { valuedUsd: unknown; valuationStatus: string | null; amountUsd: unknown }): number | null {
  if (row.valuationStatus === 'unavailable' || row.valuationStatus === 'not_applicable') return null;
  if (row.valuedUsd != null && Number.isFinite(Number(row.valuedUsd))) return Number(row.valuedUsd);
  const legacy = Number(row.amountUsd);
  return legacy > 0 && Number.isFinite(legacy) ? legacy : null;
}
function canonical(chain: 'SOLANA' | 'BSC', value: string): string { return chain === 'BSC' ? value.toLowerCase() : value; }
/** Stable signed 31-bit FNV-1a; eventId remains the authoritative identity. */
function stableEventIndex(value: string): number { let hash = 0x811c9dc5; for (let i = 0; i < value.length; i++) { hash ^= value.charCodeAt(i); hash = Math.imul(hash, 0x01000193); } return hash & 0x7fffffff; }
function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, Math.trunc(value))); }
function* chunks<T>(values: T[], size: number): Generator<T[]> { for (let i = 0; i < values.length; i += size) yield values.slice(i, i + size); }
