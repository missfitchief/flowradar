import type { Chain, MassTransactionEvent } from '@flowradar/core';

const MAINNET_BASE = 'https://api.wormholescan.io/api/v1';
const WORMHOLE_SOLANA = 1;
const WORMHOLE_BSC = 4;

export interface WormholeScanOperation {
  id: string;
  emitterChain: number;
  sequence: string;
  vaa?: { raw?: string; guardianSetIndex?: number; isDuplicated?: boolean };
  content?: {
    standarizedProperties?: {
      fromChain?: number; fromAddress?: string; toChain?: number; toAddress?: string;
      tokenChain?: number; tokenAddress?: string; amount?: string; normalizedDecimals?: number | null;
    };
  };
  sourceChain?: { chainId?: number; timestamp?: string; transaction?: { txHash?: string }; from?: string; status?: string };
  targetChain?: { chainId?: number; timestamp?: string; transaction?: { txHash?: string }; from?: string; to?: string; status?: string };
  data?: { symbol?: string; tokenAmount?: string; usdAmount?: string };
}

export interface FetchWormholeOperationsOptions {
  emitterChain: 1 | 4;
  targetChain: 1 | 4;
  page?: number;
  pageSize?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export async function fetchWormholeOperations(options: FetchWormholeOperationsOptions): Promise<WormholeScanOperation[]> {
  const page = clampInt(options.page ?? 0, 0, 1_000_000);
  const pageSize = clampInt(options.pageSize ?? 100, 1, 100);
  const url = new URL(`${MAINNET_BASE}/operations`);
  url.searchParams.set('emitterChain', String(options.emitterChain));
  url.searchParams.set('targetChain', String(options.targetChain));
  url.searchParams.set('page', String(page));
  url.searchParams.set('pageSize', String(pageSize));
  const response = await (options.fetchImpl ?? fetch)(url, { headers: { accept: 'application/json' }, signal: options.signal });
  if (!response.ok) throw new Error(`WormholeScan operations HTTP ${response.status}`);
  const payload = await response.json() as { operations?: unknown };
  if (!Array.isArray(payload.operations)) throw new Error('WormholeScan operations response missing operations[]');
  return payload.operations.filter(isOperation);
}

export interface StreamWormholeOptions {
  pages?: number;
  pageSize?: number;
  observedAt?: Date;
  fetchImpl?: typeof fetch;
}

/** Streams official, completed Wormhole Solana<->BSC operation legs. */
export async function* streamWormholeSolanaBscEvents(options: StreamWormholeOptions = {}): AsyncIterable<MassTransactionEvent> {
  const pages = clampInt(options.pages ?? 1, 1, 10_000);
  const observedAt = options.observedAt ?? new Date();
  const seen = new Set<string>();
  for (const [emitterChain, targetChain] of [[WORMHOLE_SOLANA, WORMHOLE_BSC], [WORMHOLE_BSC, WORMHOLE_SOLANA]] as const) {
    for (let page = 0; page < pages; page++) {
      const operations = await fetchWormholeOperations({ emitterChain, targetChain, page, pageSize: options.pageSize, fetchImpl: options.fetchImpl });
      if (operations.length === 0) break;
      for (const operation of operations) {
        const properties = operation.content?.standarizedProperties;
        if (properties?.fromChain !== emitterChain || properties.toChain !== targetChain) continue;
        for (const event of mapWormholeOperation(operation, observedAt)) {
          if (seen.has(event.eventId)) continue;
          seen.add(event.eventId);
          yield event;
        }
      }
    }
  }
}

/** Maps one official operation into its source and destination canonical legs. */
export function mapWormholeOperation(operation: WormholeScanOperation, observedAt: Date): MassTransactionEvent[] {
  const p = operation.content?.standarizedProperties;
  const sourceHash = operation.sourceChain?.transaction?.txHash;
  const destinationHash = operation.targetChain?.transaction?.txHash;
  const sourceChain = chainOf(p?.fromChain);
  const destinationChain = chainOf(p?.toChain);
  if (!p || !sourceHash || !destinationHash || !sourceChain || !destinationChain || sourceChain === destinationChain) return [];
  const sender = canonicalAddress(sourceChain, p.fromAddress || operation.sourceChain?.from || '');
  const recipient = canonicalAddress(destinationChain, p.toAddress || operation.targetChain?.to || '');
  if (!sender || !recipient || !operation.id) return [];
  const amount = operation.data?.tokenAmount || p.amount || '0';
  const parsedUsd = Number(operation.data?.usdAmount);
  const amountUsd = Number.isFinite(parsedUsd) && parsedUsd >= 0 ? parsedUsd : null;
  const protocolCompleted = Boolean(operation.vaa?.raw && operation.targetChain?.status?.toLowerCase() === 'completed');
  const sourceFinality = finalityOf(operation.sourceChain?.status);
  const bridge = {
    protocol: 'Wormhole', officialMessageId: operation.id, sourceChain, destinationChain,
    sourceTxHash: sourceHash, destinationTxHash: destinationHash, sender, recipient,
    verifiedBy: 'protocol_message' as const, protocolCompleted, sourceFinality
  };
  const assetBase = { symbol: operation.data?.symbol ?? null, decimals: p.normalizedDecimals ?? null, amount, amountUsd };
  const common = {
    eventIndex: 0, blockOrSlot: 0n, status: 'succeeded' as const,
    provider: 'WormholeScan', observedAt: new Date(observedAt), bridge,
    metadata: { officialOperationId: operation.id, sourceStatus: operation.sourceChain?.status ?? null, destinationStatus: operation.targetChain?.status ?? null }
  };
  return [{
    ...common, eventId: `${sourceChain}:${sourceHash}:wormhole-source`, chain: sourceChain,
    txHash: sourceHash, ts: new Date(operation.sourceChain?.timestamp ?? 0), kind: 'bridge_source',
    from: sender, to: `wormhole:${sourceChain.toLowerCase()}:source`, actor: sender,
    programOrContract: 'Wormhole',
    asset: { ...assetBase, address: p.tokenAddress && p.tokenChain === p.fromChain ? canonicalAddress(sourceChain, p.tokenAddress) : null }
  }, {
    ...common, eventId: `${destinationChain}:${destinationHash}:wormhole-destination`, chain: destinationChain,
    txHash: destinationHash, ts: new Date(operation.targetChain?.timestamp ?? 0), kind: 'bridge_destination',
    from: `wormhole:${destinationChain.toLowerCase()}:destination`, to: recipient, actor: recipient,
    programOrContract: 'Wormhole',
    asset: { ...assetBase, address: p.tokenAddress && p.tokenChain === p.toChain ? canonicalAddress(destinationChain, p.tokenAddress) : null }
  }];
}

function chainOf(id: number | undefined): Chain | null { return id === WORMHOLE_SOLANA ? 'SOLANA' : id === WORMHOLE_BSC ? 'BSC' : null; }
function canonicalAddress(chain: Chain, value: string): string { return chain === 'BSC' ? value.trim().toLowerCase() : value.trim(); }
function finalityOf(value: string | undefined): 'processed' | 'confirmed' | 'finalized' | 'unknown' {
  const normalized = value?.toLowerCase();
  return normalized === 'processed' || normalized === 'confirmed' || normalized === 'finalized' ? normalized : 'unknown';
}
function isOperation(value: unknown): value is WormholeScanOperation { return typeof value === 'object' && value !== null && typeof (value as { id?: unknown }).id === 'string'; }
function clampInt(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, Math.trunc(value))); }
