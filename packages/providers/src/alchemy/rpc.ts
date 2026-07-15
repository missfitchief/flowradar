import { createHash } from 'node:crypto';
import type { Chain, NormalizedTx, TxLeg } from '@flowradar/core';
import type { GetWalletTransactionsOpts, GetWalletTransactionsResult, WalletActivityProvider } from '../types';

export interface AlchemyRpcEnv {
  ALCHEMY_SOLANA_RPC_URL?: string;
  ALCHEMY_ETHEREUM_RPC_URL?: string;
  ALCHEMY_BASE_RPC_URL?: string;
  ALCHEMY_ARBITRUM_RPC_URL?: string;
  ALCHEMY_BSC_RPC_URL?: string;
}

const RPC_ENV_BY_CHAIN: Record<Chain, keyof AlchemyRpcEnv> = {
  SOLANA: 'ALCHEMY_SOLANA_RPC_URL',
  ETHEREUM: 'ALCHEMY_ETHEREUM_RPC_URL',
  BASE: 'ALCHEMY_BASE_RPC_URL',
  ARBITRUM: 'ALCHEMY_ARBITRUM_RPC_URL',
  BSC: 'ALCHEMY_BSC_RPC_URL'
};

const NATIVE_SYMBOL: Record<Chain, string> = {
  SOLANA: 'SOL', ETHEREUM: 'ETH', BASE: 'ETH', ARBITRUM: 'ETH', BSC: 'BNB'
};

export function alchemyRpcEnvName(chain: Chain) { return RPC_ENV_BY_CHAIN[chain]; }

export function alchemyRpcUrl(chain: Chain, env: AlchemyRpcEnv = process.env as AlchemyRpcEnv): string | null {
  const value = env[RPC_ENV_BY_CHAIN[chain]]?.trim();
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}

export function createAlchemyWalletActivityProvider(
  chain: Chain,
  env: AlchemyRpcEnv = process.env as AlchemyRpcEnv
): WalletActivityProvider | null {
  const url = alchemyRpcUrl(chain, env);
  if (!url) return null;
  return {
    providerName: 'Alchemy',
    async getWalletTransactions(requestChain, address, options = {}) {
      if (requestChain !== chain) throw new Error(`Alchemy provider for ${chain} cannot serve ${requestChain}`);
      return chain === 'SOLANA'
        ? getSolanaTransactions(url, address, options)
        : getEvmTransactions(url, chain, address, options);
    }
  };
}

export async function alchemyRpcRequest<T>(url: string, method: string, params: unknown[]): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(20_000)
    });
  } catch (error) {
    throw new Error(`Alchemy RPC ${method} request failed: ${safeError(error)}`);
  }
  if (!response.ok) throw new Error(`Alchemy RPC ${method} failed with HTTP ${response.status}`);
  const payload = await response.json() as { result?: T; error?: { code?: number; message?: string } };
  if (payload.error) throw new Error(`Alchemy RPC ${method} failed (${payload.error.code ?? 'unknown'}): ${String(payload.error.message ?? 'provider error').slice(0, 300)}`);
  return payload.result as T;
}

async function getSolanaTransactions(url: string, address: string, options: GetWalletTransactionsOpts): Promise<GetWalletTransactionsResult> {
  const limit = clamp(options.limit ?? 100, 1, 100);
  const config: Record<string, unknown> = {
    transactionDetails: 'full', sortOrder: 'desc', limit, commitment: 'confirmed',
    encoding: 'jsonParsed', maxSupportedTransactionVersion: 0,
    filters: { status: 'succeeded' }
  };
  if (options.cursor) config.paginationToken = options.cursor;
  const result = await alchemyRpcRequest<{ data?: unknown[]; paginationToken?: string }>(url, 'getTransactionsForAddress', [address, config]);
  const rows = Array.isArray(result?.data) ? result.data : [];
  const mapped = rows.map((row) => mapAlchemySolanaTransaction(row, address)).filter(nonNull);
  const txs = mapped.filter((tx) => !options.since || tx.ts >= options.since);
  const oldest = mapped.length ? mapped.reduce((value, tx) => tx.ts < value ? tx.ts : value, mapped[0].ts) : null;
  const reachedSince = Boolean(options.since && oldest && oldest <= options.since);
  return { txs, nextCursor: reachedSince ? undefined : result?.paginationToken };
}

interface EvmCursor { from?: string; to?: string; fromDone?: boolean; toDone?: boolean }

async function getEvmTransactions(url: string, chain: Chain, addressInput: string, options: GetWalletTransactionsOpts): Promise<GetWalletTransactionsResult> {
  const address = addressInput.toLowerCase();
  const limit = clamp(options.limit ?? 100, 1, 100);
  const cursor = decodeCursor(options.cursor);
  const common = {
    fromBlock: '0x0', toBlock: 'latest', category: ['external', 'internal', 'erc20'],
    withMetadata: true, excludeZeroValue: true, maxCount: `0x${limit.toString(16)}`, order: 'desc'
  };
  const [sent, received] = await Promise.all([
    cursor.fromDone ? Promise.resolve({ transfers: [] as AlchemyTransfer[], pageKey: undefined })
      : alchemyRpcRequest<AlchemyTransferPage>(url, 'alchemy_getAssetTransfers', [{ ...common, fromAddress: address, ...(cursor.from ? { pageKey: cursor.from } : {}) }]),
    cursor.toDone ? Promise.resolve({ transfers: [] as AlchemyTransfer[], pageKey: undefined })
      : alchemyRpcRequest<AlchemyTransferPage>(url, 'alchemy_getAssetTransfers', [{ ...common, toAddress: address, ...(cursor.to ? { pageKey: cursor.to } : {}) }])
  ]);
  const allTransfers = dedupeTransfers([...(sent?.transfers ?? []), ...(received?.transfers ?? [])]);
  const transfers = allTransfers.filter((row) => !options.since || transferDate(row) >= options.since);
  const txs = await mapAlchemyEvmTransfers(url, chain, address, transfers);
  const oldest = allTransfers.length ? allTransfers.reduce((value, row) => transferDate(row) < value ? transferDate(row) : value, transferDate(allTransfers[0])) : null;
  const reachedSince = Boolean(options.since && oldest && oldest <= options.since);
  const next: EvmCursor = {
    from: sent?.pageKey, to: received?.pageKey,
    fromDone: !sent?.pageKey, toDone: !received?.pageKey
  };
  const nextCursor = reachedSince || next.fromDone && next.toDone ? undefined : encodeCursor(next);
  return { txs, nextCursor };
}

export interface AlchemyTransferPage { transfers?: AlchemyTransfer[]; pageKey?: string }
export interface AlchemyTransfer {
  blockNum?: string; uniqueId?: string; hash?: string; from?: string; to?: string;
  value?: number | string | null; asset?: string | null; category?: string;
  rawContract?: { value?: string | null; address?: string | null; decimal?: string | number | null };
  metadata?: { blockTimestamp?: string };
}

export async function mapAlchemyEvmTransfers(url: string, chain: Chain, actor: string, rows: AlchemyTransfer[]): Promise<NormalizedTx[]> {
  const groups = new Map<string, AlchemyTransfer[]>();
  for (const row of rows) {
    if (!row.hash || !row.from || !row.to) continue;
    const bucket = groups.get(row.hash) ?? [];
    bucket.push(row); groups.set(row.hash, bucket);
  }
  const output: NormalizedTx[] = [];
  for (const [hash, transfers] of groups) {
    let legs = transfers.map((row) => transferLeg(chain, row)).filter(nonNull);
    const hasInbound = legs.some((leg) => leg.to === actor);
    const hasOutbound = legs.some((leg) => leg.from === actor);
    if (chain !== 'SOLANA' && hasInbound && hasOutbound && distinctAssets(legs) >= 2) {
      const transaction = await alchemyRpcRequest<Record<string, unknown> | null>(url, 'eth_getTransactionByHash', [hash]).catch(() => null);
      const from = stringOf(transaction?.from)?.toLowerCase();
      const input = stringOf(transaction?.input);
      if (from === actor && input && input !== '0x') {
        legs = legs.map((leg) => leg.from === actor || leg.to === actor ? { ...leg, kind: 'swap_leg' as const } : leg);
      }
    }
    if (!legs.length) continue;
    const first = transfers[0];
    output.push({
      txHash: hash, blockOrSlot: hexBigInt(first.blockNum), ts: transferDate(first), legs,
      status: 'succeeded'
    });
  }
  return output.sort((a, b) => a.ts.getTime() - b.ts.getTime() || a.txHash.localeCompare(b.txHash));
}

function transferLeg(chain: Chain, row: AlchemyTransfer): TxLeg | null {
  const from = normalizeAddress(chain, row.from);
  const to = normalizeAddress(chain, row.to);
  if (!from || !to) return null;
  const category = row.category?.toLowerCase();
  const token = category === 'erc20' || category === 'token';
  const decimals = parseDecimals(row.rawContract?.decimal, token ? 0 : chain === 'SOLANA' ? 9 : 18);
  const value = decimalValue(row.value, row.rawContract?.value, decimals);
  if (Number(value) <= 0) return null;
  const contractAddress = token && row.rawContract?.address
    ? normalizeAddress(chain, row.rawContract.address) ?? undefined
    : undefined;
  return {
    kind: token ? 'token_transfer' : 'native_transfer', from, to,
    asset: {
      ...(contractAddress ? { address: contractAddress } : {}),
      symbol: row.asset || NATIVE_SYMBOL[chain], decimals
    },
    amountToken: value
  };
}

interface SolanaTxRow {
  blockTime?: number | null; slot?: number; transaction?: { signatures?: string[]; message?: { accountKeys?: Array<string | { pubkey?: string }>; instructions?: unknown[] } };
  meta?: { err?: unknown; innerInstructions?: Array<{ instructions?: unknown[] }>; preBalances?: number[]; postBalances?: number[]; preTokenBalances?: SolanaTokenBalance[]; postTokenBalances?: SolanaTokenBalance[] };
}
interface SolanaTokenBalance { accountIndex?: number; mint?: string; owner?: string; uiTokenAmount?: { amount?: string; decimals?: number; uiAmountString?: string } }

export function mapAlchemySolanaTransaction(value: unknown, actor: string): NormalizedTx | null {
  const row = objectOf(value) as SolanaTxRow | null;
  const signature = row?.transaction?.signatures?.[0];
  const slot = row?.slot;
  const blockTime = row?.blockTime;
  if (!signature || !Number.isFinite(slot) || !Number.isFinite(blockTime)) return null;
  const keys = (row.transaction?.message?.accountKeys ?? []).map((key) => typeof key === 'string' ? key : key.pubkey ?? '');
  const tokenAccounts = tokenAccountMap(keys, row.meta?.preTokenBalances ?? [], row.meta?.postTokenBalances ?? []);
  const instructions = [
    ...(row.transaction?.message?.instructions ?? []),
    ...(row.meta?.innerInstructions ?? []).flatMap((entry) => entry.instructions ?? [])
  ];
  let legs = instructions.map((instruction) => solanaInstructionLeg(instruction, tokenAccounts)).filter(nonNull)
    .filter((leg) => leg.from === actor || leg.to === actor);
  legs = dedupeLegs(legs);
  const hasInbound = legs.some((leg) => leg.to === actor);
  const hasOutbound = legs.some((leg) => leg.from === actor);
  if (hasInbound && hasOutbound && distinctAssets(legs) >= 2) {
    legs = legs.map((leg) => ({ ...leg, kind: 'swap_leg' as const }));
  }
  if (!legs.length) return null;
  return {
    txHash: signature, blockOrSlot: BigInt(slot!), ts: new Date(blockTime! * 1_000), legs,
    status: row.meta?.err == null ? 'succeeded' : 'failed'
  };
}

function tokenAccountMap(keys: string[], before: SolanaTokenBalance[], after: SolanaTokenBalance[]) {
  const map = new Map<string, { owner: string; mint: string; decimals: number }>();
  for (const balance of [...before, ...after]) {
    const account = keys[Number(balance.accountIndex)];
    if (!account || !balance.owner || !balance.mint) continue;
    map.set(account, { owner: balance.owner, mint: balance.mint, decimals: Number(balance.uiTokenAmount?.decimals ?? 0) });
  }
  return map;
}

function solanaInstructionLeg(value: unknown, accounts: Map<string, { owner: string; mint: string; decimals: number }>): TxLeg | null {
  const instruction = objectOf(value);
  const parsed = objectOf(instruction?.parsed);
  const type = stringOf(parsed?.type)?.toLowerCase();
  const info = objectOf(parsed?.info);
  if (!type || !info || !['transfer', 'transferchecked'].includes(type)) return null;
  const source = stringOf(info.source);
  const destination = stringOf(info.destination);
  if (!source || !destination) return null;
  const lamports = numberOf(info.lamports);
  if (lamports !== null && lamports > 0) {
    return { kind: 'native_transfer', from: source, to: destination, asset: { symbol: 'SOL', decimals: 9 }, amountToken: formatUnits(BigInt(Math.trunc(lamports)), 9) };
  }
  const sourceToken = accounts.get(source);
  const destinationToken = accounts.get(destination);
  const mint = stringOf(info.mint) ?? sourceToken?.mint ?? destinationToken?.mint;
  if (!mint) return null;
  const decimals = Number(objectOf(info.tokenAmount)?.decimals ?? sourceToken?.decimals ?? destinationToken?.decimals ?? 0);
  const raw = stringOf(objectOf(info.tokenAmount)?.amount) ?? stringOf(info.amount);
  if (!raw || !/^\d+$/.test(raw)) return null;
  return {
    kind: 'token_transfer', from: sourceToken?.owner ?? source, to: destinationToken?.owner ?? destination,
    asset: { address: mint, symbol: mint.slice(0, 4), decimals }, amountToken: formatUnits(BigInt(raw), decimals)
  };
}

function dedupeTransfers(rows: AlchemyTransfer[]) {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = row.uniqueId || [row.hash, row.category, row.from, row.to, row.rawContract?.address, row.rawContract?.value, row.value].join('|');
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}
function dedupeLegs(legs: TxLeg[]) {
  const seen = new Set<string>();
  return legs.filter((leg) => { const key = [leg.kind, leg.from, leg.to, leg.asset.address, leg.amountToken].join('|'); if (seen.has(key)) return false; seen.add(key); return true; });
}
function distinctAssets(legs: TxLeg[]) { return new Set(legs.map((leg) => leg.asset.address ?? leg.asset.symbol)).size; }
function transferDate(row: AlchemyTransfer) { const date = new Date(row.metadata?.blockTimestamp ?? 0); return Number.isFinite(date.getTime()) ? date : new Date(0); }
function parseDecimals(value: unknown, fallback: number) { const parsed = typeof value === 'string' && value.startsWith('0x') ? Number.parseInt(value, 16) : Number(value); return Number.isInteger(parsed) && parsed >= 0 && parsed <= 36 ? parsed : fallback; }
function decimalValue(value: unknown, raw: unknown, decimals: number) { if (value != null && Number.isFinite(Number(value))) return String(value); if (typeof raw === 'string' && /^0x[0-9a-f]+$/i.test(raw)) return formatUnits(BigInt(raw), decimals); return '0'; }
function formatUnits(value: bigint, decimals: number) { if (!decimals) return value.toString(); const text = value.toString().padStart(decimals + 1, '0'); const split = text.length - decimals; return `${text.slice(0, split)}.${text.slice(split)}`.replace(/\.?0+$/, '') || '0'; }
function hexBigInt(value: unknown) { try { return typeof value === 'string' ? BigInt(value) : BigInt(Number(value ?? 0)); } catch { return 0n; } }
function encodeCursor(cursor: EvmCursor) { return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url'); }
function decodeCursor(cursor: string | undefined): EvmCursor { if (!cursor) return {}; try { return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as EvmCursor; } catch { return {}; } }
function objectOf(value: unknown): Record<string, any> | null { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : null; }
function stringOf(value: unknown): string | null { return typeof value === 'string' && value ? value : null; }
function numberOf(value: unknown): number | null { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null; }
function nonNull<T>(value: T | null): value is T { return value !== null; }
function normalizeAddress(chain: Chain, value: string | null | undefined) { if (!value) return null; return chain === 'SOLANA' ? value : value.toLowerCase(); }
function clamp(value: number, min: number, max: number) { return Math.max(min, Math.min(max, Math.trunc(value))); }
function safeError(error: unknown) { return error instanceof Error ? error.message.replace(/https:\/\/\S+/g, '<redacted-url>').slice(0, 300) : 'request failed'; }
export function alchemyTransferFingerprint(row: AlchemyTransfer) { return createHash('sha256').update([row.hash, row.category, row.from, row.to, row.rawContract?.address, row.rawContract?.value, row.value].join('|')).digest('hex'); }
