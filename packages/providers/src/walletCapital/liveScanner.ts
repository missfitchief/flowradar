import { createHash } from 'node:crypto';
import { normalizeMassTransaction, type Chain, type InfrastructureCategory, type MassTransactionEvent } from '@flowradar/core';
import { createHeliusActivityProvider } from '../solana/helius';
import { fetchWalletActivity } from '../gmgn/gmgnProvider';
import { createAlchemyWalletActivityProvider, type AlchemyRpcEnv } from '../alchemy/rpc';

const BLOCKSCOUT_HOSTS: Partial<Record<Chain, string>> = {
  ETHEREUM: 'https://eth.blockscout.com',
  BASE: 'https://base.blockscout.com',
  ARBITRUM: 'https://arbitrum.blockscout.com'
};
const BSC_SCAN_BASE = 'https://bscscan.com';
const BSC_RPC = 'https://bsc-dataseed.binance.org/';
const EVM_ADDRESS = /^0x[0-9a-f]{40}$/;
const ERC20_TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

export interface WalletCapitalScanOptions {
  maxPages?: number;
  root?: boolean;
  since?: Date;
}

export interface DetectedInfrastructure {
  chain: Chain;
  address: string;
  category: InfrastructureCategory;
  label: string;
}

export interface WalletCapitalScanResult {
  events: MassTransactionEvent[];
  infrastructure: DetectedInfrastructure[];
  provider: string;
  pagesFetched: number;
  complete: boolean;
  warnings: string[];
}

export interface WalletCapitalScanProvider {
  scanAddress(chain: Chain, address: string, options?: WalletCapitalScanOptions): Promise<WalletCapitalScanResult>;
}

export interface LiveWalletCapitalEnv extends AlchemyRpcEnv {
  HELIUS_API_KEY?: string;
  HELIUS_RPS?: string;
}

/** Live-only capital scanner. No mock fallback is used by this operator path. */
export function createLiveWalletCapitalScanner(env: LiveWalletCapitalEnv = process.env as LiveWalletCapitalEnv): WalletCapitalScanProvider {
  const helius = createHeliusActivityProvider(env);
  const alchemy = new Map<Chain, ReturnType<typeof createAlchemyWalletActivityProvider>>();
  return {
    async scanAddress(chain, address, options = {}) {
      if (!alchemy.has(chain)) alchemy.set(chain, createAlchemyWalletActivityProvider(chain, env));
      const alchemyProvider = alchemy.get(chain);
      if (alchemyProvider) return scanAlchemy(chain, address, options, alchemyProvider);
      if (chain === 'SOLANA') return scanSolana(address, options, helius);
      if (chain === 'BSC') return scanBsc(address, options);
      const host = BLOCKSCOUT_HOSTS[chain];
      if (!host) throw new Error(`No live wallet capital source for ${chain}`);
      return scanBlockscout(chain, address, host, options);
    }
  };
}

async function scanAlchemy(
  chain: Chain,
  address: string,
  options: WalletCapitalScanOptions,
  provider: NonNullable<ReturnType<typeof createAlchemyWalletActivityProvider>>
): Promise<WalletCapitalScanResult> {
  const maxPages = clamp(options.maxPages ?? (options.root ? 10 : 4), 1, 20);
  let cursor: string | undefined;
  let pages = 0;
  const events: MassTransactionEvent[] = [];
  do {
    const result = await provider.getWalletTransactions(chain, address, { cursor, limit: 100, since: options.since });
    pages += 1;
    for (const tx of result.txs) {
      // This scanner is historical/backfill-oriented. Transaction time is the
      // observation watermark so old history can never masquerade as a fresh
      // opportunity after an investigation refresh.
      events.push(...normalizeMassTransaction(tx, { chain, provider: 'Alchemy', observedAt: tx.ts }, address).map((event) => ({
        ...event, metadata: { ...event.metadata, historicalBackfill: true, alchemyRpc: true }
      })));
    }
    cursor = result.nextCursor;
  } while (cursor && pages < maxPages);
  return {
    events: dedupeEvents(events), infrastructure: [], provider: 'Alchemy', pagesFetched: pages,
    complete: !cursor, warnings: cursor ? ['Alchemy history bounded by page budget'] : []
  };
}

async function scanBlockscout(chain: Chain, addressInput: string, host: string, options: WalletCapitalScanOptions): Promise<WalletCapitalScanResult> {
  const address = addressInput.toLowerCase();
  if (!EVM_ADDRESS.test(address)) throw new Error(`Invalid ${chain} address`);
  const maxPages = clamp(options.maxPages ?? (options.root ? 30 : 6), 1, 100);
  const observedAt = new Date();
  const [transactions, tokenTransfers, internals] = await Promise.all([
    fetchBlockscoutPages(host, `/api/v2/addresses/${address}/transactions`, maxPages),
    fetchBlockscoutPages(host, `/api/v2/addresses/${address}/token-transfers`, Math.min(maxPages, 10)),
    fetchBlockscoutPages(host, `/api/v2/addresses/${address}/internal-transactions`, Math.min(maxPages, 10))
  ]);
  const infrastructure = new Map<string, DetectedInfrastructure>();
  const events: MassTransactionEvent[] = [];
  for (const [index, row] of transactions.items.entries()) {
    const from = blockscoutAddress(row.from);
    const to = blockscoutAddress(row.to);
    const valueWei = finiteString(row.value);
    const ts = dateOf(row.timestamp);
    if (!from || !to || !valueWei || !ts || (options.since && ts < options.since)) continue;
    const toObject = objectOf(row.to);
    const isContract = toObject?.is_contract === true;
    const label = blockscoutLabel(toObject);
    if (isContract) addInfrastructure(infrastructure, chain, to, infrastructureCategory(label, stringOf(row.method)), label || 'Blockscout contract');
    const nativeAmount = Number(valueWei) / 1e18;
    if (!(nativeAmount > 0)) continue;
    const exchangeRate = finiteNumber(row.exchange_rate);
    events.push(massEvent({
      chain, provider: 'Blockscout', txHash: stringOf(row.hash) || stableHash(JSON.stringify(row)), index,
      block: bigintOf(row.block_number), ts, kind: isContract ? 'contract_interaction' : 'native_transfer',
      from, to, actor: from, assetAddress: null, symbol: nativeSymbol(chain), decimals: 18,
      amount: String(nativeAmount), amountUsd: exchangeRate === null ? null : nativeAmount * exchangeRate,
      program: isContract ? to : null, observedAt,
      metadata: { method: stringOf(row.method), toIsContract: isContract, toLabel: label, source: 'blockscout_address_transactions' }
    }));
  }
  mapBlockscoutInternalEvents(chain, address, internals.items, observedAt, options.since, events);
  mapBlockscoutTokenEvents(chain, address, tokenTransfers.items, observedAt, options.since, events);
  return {
    events: dedupeEvents(events), infrastructure: [...infrastructure.values()], provider: 'Blockscout',
    pagesFetched: transactions.pages + tokenTransfers.pages + internals.pages,
    complete: transactions.complete && tokenTransfers.complete && internals.complete,
    warnings: [...transactions.warnings, ...tokenTransfers.warnings, ...internals.warnings]
  };
}

async function scanBsc(addressInput: string, options: WalletCapitalScanOptions): Promise<WalletCapitalScanResult> {
  const address = addressInput.toLowerCase();
  if (!EVM_ADDRESS.test(address)) throw new Error('Invalid BSC address');
  const maxTxPages = clamp(options.maxPages ?? (options.root ? 30 : 3), 1, 50);
  const maxTokenPages = Math.min(options.root ? 8 : 6, maxTxPages + (options.root ? 0 : 3));
  const transactionPages = await fetchBscHtmlPages('txs', address, maxTxPages, true);
  const tokenPages = await fetchBscHtmlPages('tokentxns', address, maxTokenPages, false);
  const txRows = transactionPages.rows.map(parseBscTransactionRow).filter(nonNull);
  const tokenRows = tokenPages.rows.map(parseBscTokenRow).filter(nonNull);
  const counterparties = [...new Set([
    ...txRows.map((row) => row.to),
    ...tokenRows.flatMap((row) => [row.from, row.to])
  ].filter((value) => EVM_ADDRESS.test(value)))];
  const contracts = await fetchBscContractFlags(counterparties);
  const infrastructure = new Map<string, DetectedInfrastructure>();
  const observedAt = new Date();
  const events: MassTransactionEvent[] = [];
  for (const row of txRows) {
    if (row.from !== address || (options.since && row.ts < options.since) || !(row.nativeAmount > 0)) continue;
    const isContract = contracts.has(row.to);
    if (isContract) addInfrastructure(infrastructure, 'BSC', row.to, infrastructureCategory(row.toLabel, row.method), row.toLabel || `BscScan contract (${row.method || 'unknown method'})`);
    events.push(massEvent({
      chain: 'BSC', provider: 'BscScanHtml', txHash: row.txHash, index: stableIndex(`${row.txHash}:native`),
      block: row.block, ts: row.ts, kind: isContract ? 'contract_interaction' : 'native_transfer',
      from: row.from, to: row.to, actor: row.from, assetAddress: null, symbol: 'BNB', decimals: 18,
      amount: String(row.nativeAmount), amountUsd: row.amountUsd, program: isContract ? row.to : null, observedAt,
      metadata: { method: row.method, toIsContract: isContract, toLabel: row.toLabel, source: 'bscscan_html_transactions' }
    }));
  }
  for (const row of tokenRows) {
    if (options.since && row.ts < options.since) continue;
    const actorInbound = row.to === address;
    const actorOutbound = row.from === address;
    if (!actorInbound && !actorOutbound) continue;
    const trade = isTradeMethod(row.method);
    const kind = trade && actorInbound ? 'token_buy' : trade && actorOutbound ? 'token_sell' : 'token_transfer';
    const counterparty = actorInbound ? row.from : row.to;
    if (contracts.has(counterparty)) addInfrastructure(infrastructure, 'BSC', counterparty, isTradeMethod(row.method) ? 'POOL' : 'TOKEN_CONTRACT', row.counterpartyLabel || `BscScan contract (${row.method || 'token transfer'})`);
    events.push(massEvent({
      chain: 'BSC', provider: 'BscScanHtml', txHash: row.txHash,
      index: stableIndex(`${row.txHash}:${row.token}:${row.from}:${row.to}:${row.amount}`), block: row.block, ts: row.ts, kind,
      from: row.from, to: row.to, actor: address, assetAddress: row.token, symbol: row.symbol, decimals: null,
      amount: row.amount, amountUsd: row.amountUsd, program: trade ? counterparty : null, observedAt,
      metadata: { method: row.method, source: 'bscscan_html_token_transfers', providerClassifiedTrade: trade }
    }));
  }
  events.push(...await fetchBscTradeReceiptEvents(address, txRows, contracts, observedAt, options.since));
  return {
    events: dedupeEvents(events), infrastructure: [...infrastructure.values()], provider: 'BscScanHtml',
    pagesFetched: transactionPages.pages + tokenPages.pages,
    complete: transactionPages.complete && tokenPages.complete,
    warnings: [...transactionPages.warnings, ...tokenPages.warnings]
  };
}

interface BscReceiptLog { address?: string; topics?: string[]; data?: string; logIndex?: string }
interface BscReceipt { transactionHash?: string; status?: string; logs?: BscReceiptLog[] }
async function fetchBscTradeReceiptEvents(address: string, rows: BscTransactionRow[], contracts: Set<string>, observedAt: Date, since?: Date) {
  const byHash = new Map(rows.filter((row) => row.from === address && contracts.has(row.to) && isTradeMethod(row.method) && (!since || row.ts >= since)).map((row) => [row.txHash, row]));
  const receipts: BscReceipt[] = [];
  for (const hashes of chunks([...byHash.keys()].slice(0, 1_000), 50)) {
    const body = hashes.map((hash, index) => ({ jsonrpc: '2.0', id: index + 1, method: 'eth_getTransactionReceipt', params: [hash] }));
    const response = await fetch(BSC_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`BSC receipt batch HTTP ${response.status}`);
    const result = await response.json() as Array<{ id?: number; result?: BscReceipt | null }>;
    receipts.push(...result.map((item) => item.result).filter(nonNull));
  }
  const events: MassTransactionEvent[] = [];
  for (const receipt of receipts) {
    if (receipt.status && receipt.status !== '0x1') continue;
    const row = receipt.transactionHash ? byHash.get(receipt.transactionHash.toLowerCase()) : null;
    if (!row) continue;
    for (const [position, log] of (receipt.logs ?? []).entries()) {
      if (log.topics?.[0]?.toLowerCase() !== ERC20_TRANSFER_TOPIC || log.topics.length < 3 || !log.address || !EVM_ADDRESS.test(log.address.toLowerCase())) continue;
      const from = topicAddress(log.topics[1]); const to = topicAddress(log.topics[2]);
      if (!from || !to || (from !== address && to !== address)) continue;
      const rawAmount = hexQuantity(log.data);
      events.push(massEvent({
        chain: 'BSC', provider: 'BscRpcReceipt', txHash: row.txHash,
        index: finiteNumber(log.logIndex) ?? stableIndex(`${row.txHash}:receipt:${position}`), block: row.block, ts: row.ts,
        kind: to === address ? 'token_buy' : 'token_sell', from, to, actor: address,
        assetAddress: log.address.toLowerCase(), symbol: null, decimals: null, amount: rawAmount,
        amountUsd: null, program: row.to, observedAt,
        metadata: { method: row.method, source: 'bsc_official_rpc_transaction_receipt', providerClassifiedTrade: true }
      }));
    }
  }
  return events;
}

async function scanSolana(address: string, options: WalletCapitalScanOptions, helius: ReturnType<typeof createHeliusActivityProvider>): Promise<WalletCapitalScanResult> {
  const observedAt = new Date();
  let heliusWarning: string | null = null;
  if (helius) {
    try {
      const maxPages = clamp(options.maxPages ?? (options.root ? 10 : 4), 1, 20);
      let cursor: string | undefined;
      let pages = 0;
      const events: MassTransactionEvent[] = [];
      do {
        const result = await helius.getWalletTransactions('SOLANA', address, { cursor, limit: 100, since: options.since });
        pages += 1;
        events.push(...result.txs.flatMap((tx) => normalizeMassTransaction(tx, { chain: 'SOLANA', provider: 'Helius', observedAt }, address)));
        // before-signature paginates into older history. Once a full raw page
        // maps to zero rows after the incremental since filter, every following
        // page is older too; stop instead of spending the whole page budget and
        // falsely reporting an incomplete live scan.
        if (options.since && result.txs.length === 0) {
          cursor = undefined;
          break;
        }
        cursor = result.nextCursor;
      } while (cursor && pages < maxPages);
      return { events: dedupeEvents(events), infrastructure: [], provider: 'Helius', pagesFetched: pages, complete: !cursor, warnings: cursor ? ['Helius history bounded by page budget'] : [] };
    } catch (error) {
      // The operator scanner already has a query-only GMGN fallback for a
      // missing key. Use the same source when Helius is configured but rejects
      // or throttles the request; one provider credential must not stop Core
      // monitoring. The warning is deliberately credential-safe.
      heliusWarning = safeHeliusFailure(error);
    }
  }
  const maxPages = clamp(options.maxPages ?? (options.root ? 10 : 4), 1, 20);
  let gmgnCursor: string | undefined;
  let gmgnPages = 0;
  const events: MassTransactionEvent[] = [];
  do {
    const result = await fetchWalletActivity(address, { chain: 'sol', limit: 100, cursor: gmgnCursor, timeoutMs: 30_000 });
    gmgnPages += 1;
    const mapped = result.rows.map((row, index) => mapGmgnActivity(address, row, index, observedAt)).filter(nonNull);
    events.push(...mapped.filter((event) => !options.since || event.ts >= options.since));
    if (options.since && mapped.length > 0 && mapped.every((event) => event.ts < options.since!)) {
      gmgnCursor = undefined;
      break;
    }
    gmgnCursor = result.next ?? undefined;
  } while (gmgnCursor && gmgnPages < maxPages);
  return {
    events: dedupeEvents(events), infrastructure: [], provider: 'GMGN', pagesFetched: gmgnPages, complete: !gmgnCursor,
    warnings: [...(heliusWarning ? [heliusWarning] : []), ...(gmgnCursor ? ['GMGN history bounded by page budget'] : [])]
  };
}

function safeHeliusFailure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/401|unauthorized/i.test(message)) return 'Helius authentication rejected (401); GMGN fallback used';
  if (/429|rate.?limit/i.test(message)) return 'Helius rate limited; GMGN fallback used';
  return `Helius unavailable; GMGN fallback used (${(error instanceof Error ? error.name : 'provider_error').slice(0, 80)})`;
}

export function mapGmgnActivity(address: string, row: Record<string, unknown>, index: number, observedAt: Date): MassTransactionEvent | null {
  const txHash = firstString(row, ['tx_hash', 'txHash', 'hash', 'signature']);
  const ts = dateOf(firstValue(row, ['timestamp', 'time', 'block_timestamp', 'created_at']));
  const action = firstString(row, ['event_type', 'type', 'event', 'action'])?.toLowerCase() ?? '';
  if (!txHash || !ts) return null;
  const from = firstString(row, ['from_address', 'from', 'sender']) ?? address;
  const to = firstString(row, ['to_address', 'to', 'receiver']) ?? address;
  const tokenObject = objectOf(row.token);
  const token = firstString(row, ['token_address', 'token', 'mint']) ?? stringOf(tokenObject?.address);
  const kind = action.includes('buy') ? 'token_buy' : action.includes('sell') ? 'token_sell' : token ? 'token_transfer' : 'native_transfer';
  return massEvent({
    chain: 'SOLANA', provider: 'GMGN', txHash, index: stableIndex(`${txHash}:${index}:${action}`), block: bigintOf(firstValue(row, ['block_number', 'slot'])), ts, kind,
    from, to, actor: address, assetAddress: token,
    symbol: firstString(row, ['symbol', 'token_symbol']) ?? stringOf(tokenObject?.symbol),
    decimals: finiteNumber(firstValue(row, ['decimals'])) ?? finiteNumber(tokenObject?.decimals),
    amount: firstString(row, ['amount', 'token_amount', 'amount_token']) ?? '0',
    amountUsd: finiteNumber(firstValue(row, ['amount_usd', 'usd_value', 'cost_usd', 'buy_cost_usd', 'sell_income_usd'])),
    program: firstString(row, ['program', 'program_id', 'router']), observedAt, metadata: { source: 'gmgn_portfolio_activity', raw: row }
  });
}

interface PageFetch { items: Record<string, unknown>[]; pages: number; complete: boolean; warnings: string[] }
async function fetchBlockscoutPages(host: string, path: string, maxPages: number): Promise<PageFetch> {
  const items: Record<string, unknown>[] = [];
  const warnings: string[] = [];
  let params: Record<string, unknown> | null = null;
  let pages = 0;
  do {
    const url = new URL(path, host);
    for (const [key, value] of Object.entries(params ?? {})) if (value !== null && value !== undefined) url.searchParams.set(key, String(value));
    const response = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'FlowRadar/1.0 capital-tracing' }, signal: AbortSignal.timeout(30_000) });
    if (response.status === 404) return { items, pages, complete: true, warnings };
    if (!response.ok) throw new Error(`Blockscout ${url.pathname} HTTP ${response.status}`);
    const body = await response.json() as { items?: unknown; next_page_params?: unknown };
    if (!Array.isArray(body.items)) throw new Error(`Blockscout ${url.pathname} missing items[]`);
    items.push(...body.items.filter(isObject));
    pages += 1;
    params = isObject(body.next_page_params) ? body.next_page_params : null;
  } while (params && pages < maxPages);
  if (params) warnings.push(`Blockscout ${path.split('/').at(-1)} history bounded at ${maxPages} pages`);
  return { items, pages, complete: !params, warnings };
}

interface HtmlPages { rows: string[]; pages: number; complete: boolean; warnings: string[] }
let lastBscFetchAt = 0;
async function fetchBscHtmlPages(kind: 'txs' | 'tokentxns', address: string, maxPages: number, outgoingOnly: boolean): Promise<HtmlPages> {
  const rows: string[] = [];
  let totalPages = 1;
  let pages = 0;
  for (let page = 1; page <= Math.min(totalPages, maxPages); page += 1) {
    const wait = Math.max(0, 350 - (Date.now() - lastBscFetchAt));
    if (wait) await delay(wait);
    const url = new URL(`/${kind}`, BSC_SCAN_BASE);
    url.searchParams.set('a', address); url.searchParams.set('ps', '100'); url.searchParams.set('p', String(page));
    if (outgoingOnly) url.searchParams.set('f', '2');
    const response = await fetch(url, { headers: { accept: 'text/html', 'user-agent': 'Mozilla/5.0 (compatible; FlowRadar/1.0; on-chain research)' }, signal: AbortSignal.timeout(30_000) });
    lastBscFetchAt = Date.now();
    if (!response.ok) throw new Error(`BscScan ${kind} HTTP ${response.status}`);
    const html = await response.text();
    if (page === 1) totalPages = clamp(Number(html.match(/Page\s+1\s+of\s+([\d,]+)/i)?.[1].replaceAll(',', '') ?? 1), 1, 10_000);
    rows.push(...htmlRows(html));
    pages += 1;
  }
  const complete = pages >= totalPages;
  return { rows, pages, complete, warnings: complete ? [] : [`BscScan ${kind} history bounded at ${pages}/${totalPages} pages`] };
}

interface BscTransactionRow { txHash: string; block: bigint; ts: Date; method: string; from: string; to: string; toLabel: string; nativeAmount: number; amountUsd: number | null }
function parseBscTransactionRow(row: string): BscTransactionRow | null {
  const txHash = match(row, /href=["']\/tx\/(0x[0-9a-f]{64})/i);
  const block = bigintOf(match(row, /href=["']\/block\/(\d+)/i));
  const epoch = finiteNumber(match(row, /showLocalDate[\s\S]*?<span[^>]*>(\d+)<\/span>/i));
  const addresses = unique([...row.matchAll(/data-highlight-target=["'](0x[0-9a-f]{40})["']/gi)].map((item) => item[1].toLowerCase()));
  const method = decodeHtml(match(row, /td_functionNameOri[\s\S]*?data-title=["']([^"']*)/i) ?? '');
  const amountTitle = decodeHtml(match(row, /td_showAmount[\s\S]*?data-bs-title=["']([^"']*)/i) ?? '');
  const nativeAmount = finiteNumber(amountTitle.split('|')[0].replace(/[^\d.eE+-]/g, '')) ?? 0;
  const amountUsd = moneyFromTitle(amountTitle);
  if (!txHash || epoch === null || addresses.length < 2) return null;
  const toLabel = decodeHtml(match(row, /data-highlight-value=["'][^"']+["'][\s\S]*?data-bs-title=["']([^"']*)/i) ?? '');
  return { txHash, block, ts: new Date(epoch * 1_000), method, from: addresses[0], to: addresses[1], toLabel, nativeAmount, amountUsd };
}

interface BscTokenRow { txHash: string; block: bigint; ts: Date; method: string; from: string; to: string; token: string; symbol: string | null; amount: string; amountUsd: number | null; counterpartyLabel: string }
function parseBscTokenRow(row: string): BscTokenRow | null {
  const txHash = match(row, /href=["']\/tx\/(0x[0-9a-f]{64})/i);
  const block = bigintOf(match(row, /href=["']\/block\/(\d+)/i));
  const epoch = finiteNumber(match(row, /showLocalDate[\s\S]*?<span[^>]*>(\d+)<\/span>/i));
  const addresses = unique([...row.matchAll(/data-highlight-target=["'](0x[0-9a-f]{40})["']/gi)].map((item) => item[1].toLowerCase()));
  const token = match(row, /href=["']\/token\/(0x[0-9a-f]{40})/i)?.toLowerCase();
  if (!txHash || epoch === null || addresses.length < 2 || !token) return null;
  const method = decodeHtml(match(row, /td_functionNameOri[\s\S]*?data-title=["']([^"']*)/i) ?? '');
  const amountTitle = decodeHtml(match(row, /td_showAmount[\s\S]*?data-bs-title=["']([^"']*)/i) ?? '');
  const tokenTitle = decodeHtml(match(row, new RegExp(`href=["']\\/token\\/${token}[^>]*>[\\s\\S]*?title=["']([^"']*)`, 'i')) ?? '');
  const symbol = tokenTitle.match(/\(([^()]+)\)\s*$/)?.[1] ?? null;
  const counterpartyLabel = decodeHtml(match(row, /href=["']\/address\/0x[0-9a-f]{40}#tokentxns["'][\s\S]*?data-bs-title=["']([^"']*)/i) ?? '');
  return {
    txHash, block, ts: new Date(epoch * 1_000), method, from: addresses[0], to: addresses[1], token, symbol,
    amount: amountTitle.split('|')[0].trim().replaceAll(',', '') || '0', amountUsd: moneyFromTitle(amountTitle), counterpartyLabel
  };
}

async function fetchBscContractFlags(addresses: string[]): Promise<Set<string>> {
  const contracts = new Set<string>();
  for (let offset = 0; offset < addresses.length; offset += 100) {
    const chunk = addresses.slice(offset, offset + 100);
    const body = chunk.map((address, index) => ({ jsonrpc: '2.0', id: index + 1, method: 'eth_getCode', params: [address, 'latest'] }));
    const response = await fetch(BSC_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`BSC eth_getCode HTTP ${response.status}`);
    const result = await response.json() as Array<{ id?: number; result?: string }>;
    for (const item of result) if (item.id && typeof item.result === 'string' && item.result !== '0x') contracts.add(chunk[item.id - 1]);
  }
  return contracts;
}

function mapBlockscoutInternalEvents(chain: Chain, actor: string, rows: Record<string, unknown>[], observedAt: Date, since: Date | undefined, events: MassTransactionEvent[]) {
  for (const [index, row] of rows.entries()) {
    const from = blockscoutAddress(row.from); const to = blockscoutAddress(row.to); const ts = dateOf(row.timestamp);
    const value = finiteString(row.value); if (!from || !to || !ts || !value || (since && ts < since)) continue;
    const amount = Number(value) / 1e18; if (!(amount > 0)) continue;
    events.push(massEvent({
      chain, provider: 'Blockscout', txHash: stringOf(row.transaction_hash) || stableHash(JSON.stringify(row)), index: stableIndex(`internal:${index}:${from}:${to}:${value}`),
      block: bigintOf(row.block_number), ts, kind: 'native_transfer', from, to, actor, assetAddress: null, symbol: nativeSymbol(chain), decimals: 18,
      amount: String(amount), amountUsd: null, program: null, observedAt, metadata: { source: 'blockscout_internal_transactions' }
    }));
  }
}

function mapBlockscoutTokenEvents(chain: Chain, actor: string, rows: Record<string, unknown>[], observedAt: Date, since: Date | undefined, events: MassTransactionEvent[]) {
  for (const [index, row] of rows.entries()) {
    const from = blockscoutAddress(row.from); const to = blockscoutAddress(row.to); const ts = dateOf(row.timestamp);
    const tokenObject = objectOf(row.token); const token = blockscoutAddress(tokenObject?.address_hash ?? tokenObject?.address);
    if (!from || !to || !ts || !token || (since && ts < since)) continue;
    const method = stringOf(row.method); const trade = isTradeMethod(method);
    const inbound = to === actor; const outbound = from === actor;
    const kind = trade && inbound ? 'token_buy' : trade && outbound ? 'token_sell' : 'token_transfer';
    const total = objectOf(row.total);
    events.push(massEvent({
      chain, provider: 'Blockscout', txHash: stringOf(row.transaction_hash) || stableHash(JSON.stringify(row)), index: stableIndex(`token:${index}:${from}:${to}:${token}`),
      block: bigintOf(row.block_number), ts, kind, from, to, actor, assetAddress: token, symbol: stringOf(tokenObject?.symbol), decimals: finiteNumber(tokenObject?.decimals),
      amount: finiteString(total?.value) ?? '0', amountUsd: null, program: trade ? (inbound ? from : to) : null, observedAt,
      metadata: { method, source: 'blockscout_token_transfers', providerClassifiedTrade: trade }
    }));
  }
}

function massEvent(input: {
  chain: Chain; provider: string; txHash: string; index: number; block: bigint; ts: Date; kind: MassTransactionEvent['kind']; from: string; to: string; actor: string | null;
  assetAddress: string | null; symbol: string | null; decimals: number | null; amount: string; amountUsd: number | null; program: string | null; observedAt: Date; metadata: Record<string, unknown>;
}): MassTransactionEvent {
  return { eventId: `${input.provider.toLowerCase()}:${input.chain}:${input.txHash}:${input.index}`, chain: input.chain, txHash: input.txHash, eventIndex: input.index, blockOrSlot: input.block,
    ts: input.ts, kind: input.kind, status: 'succeeded', from: input.from, to: input.to, actor: input.actor,
    asset: { address: input.assetAddress, symbol: input.symbol, decimals: input.decimals, amount: input.amount, amountUsd: input.amountUsd },
    programOrContract: input.program, provider: input.provider, observedAt: input.observedAt, bridge: null, metadata: input.metadata };
}

function addInfrastructure(map: Map<string, DetectedInfrastructure>, chain: Chain, address: string, category: InfrastructureCategory, label: string) {
  map.set(`${chain}:${address}`, { chain, address, category, label: label.slice(0, 200) });
}
function infrastructureCategory(label: string | null, method: string | null): InfrastructureCategory {
  const text = `${label ?? ''} ${method ?? ''}`.toLowerCase();
  if (/binance|coinbase|kraken|kucoin|bybit|mexc|gate\.io|bitget|okx/.test(text)) return 'CEX';
  if (/bridge|deposit eth|withdraw eth/.test(text)) return 'BRIDGE';
  if (/swap|multicall|router|dispatch|maestro|buy|sell/.test(text)) return 'ROUTER';
  return 'TOKEN_CONTRACT';
}
function isTradeMethod(value: string | null) { return /swap|multicall|dispatch|aggregate|buy|sell|maestro|exact.*token|token.*exact/i.test(value ?? ''); }
function htmlRows(html: string) { const tbody = html.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i)?.[1] ?? ''; return [...tbody.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((item) => item[1]); }
function blockscoutAddress(value: unknown): string | null { const object = objectOf(value); const address = typeof value === 'string' ? value : stringOf(object?.hash ?? object?.address_hash); return address && EVM_ADDRESS.test(address.toLowerCase()) ? address.toLowerCase() : null; }
function blockscoutLabel(value: Record<string, unknown> | null) { return stringOf(value?.name) ?? stringOf(objectOf(value?.metadata)?.name) ?? ''; }
function nativeSymbol(chain: Chain) { return chain === 'BSC' ? 'BNB' : 'ETH'; }
function moneyFromTitle(value: string) { const parsed = finiteNumber(value.match(/\|\s*\$([\d,.]+)/)?.[1]?.replaceAll(',', '')); return parsed; }
function dateOf(value: unknown): Date | null { if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value; if (typeof value === 'number' || (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value))) { const n = Number(value); const date = new Date(n < 10_000_000_000 ? n * 1_000 : n); return Number.isNaN(date.getTime()) ? null : date; } if (typeof value === 'string') { const date = new Date(value); return Number.isNaN(date.getTime()) ? null : date; } return null; }
function stableIndex(value: string) { const hash = createHash('sha256').update(value).digest(); return hash.readUInt32BE(0) & 0x7fffffff; }
function stableHash(value: string) { return `0x${createHash('sha256').update(value).digest('hex')}`; }
function dedupeEvents(events: MassTransactionEvent[]) { return [...new Map(events.map((event) => [event.eventId, event])).values()].sort((a, b) => a.ts.getTime() - b.ts.getTime() || a.eventId.localeCompare(b.eventId)); }
function unique<T>(values: T[]) { return [...new Set(values)]; }
function objectOf(value: unknown): Record<string, unknown> | null { return isObject(value) ? value : null; }
function isObject(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function stringOf(value: unknown) { return typeof value === 'string' && value.trim() ? value.trim() : null; }
function finiteString(value: unknown) { if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return value; if (typeof value === 'number' && Number.isFinite(value)) return String(value); return null; }
function finiteNumber(value: unknown): number | null { const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN; return Number.isFinite(parsed) ? parsed : null; }
function bigintOf(value: unknown) { try { return BigInt(typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint' ? value : 0); } catch { return 0n; } }
function firstValue(row: Record<string, unknown>, keys: string[]) { for (const key of keys) if (row[key] !== undefined && row[key] !== null) return row[key]; return null; }
function firstString(row: Record<string, unknown>, keys: string[]) { return stringOf(firstValue(row, keys)); }
function match(value: string, pattern: RegExp) { return value.match(pattern)?.[1] ?? null; }
function decodeHtml(value: string) { return value.replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').trim(); }
function nonNull<T>(value: T | null | undefined): value is T { return value !== null && value !== undefined; }
function topicAddress(value: string | undefined) { if (!value || !/^0x[0-9a-f]{64}$/i.test(value)) return null; return `0x${value.slice(-40)}`.toLowerCase(); }
function hexQuantity(value: string | undefined) { try { return value && /^0x[0-9a-f]+$/i.test(value) ? BigInt(value).toString() : '0'; } catch { return '0'; } }
function chunks<T>(values: T[], size: number) { const result: T[][] = []; for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size)); return result; }
function clamp(value: number, min: number, max: number) { return Math.max(min, Math.min(max, Math.trunc(value))); }
function delay(ms: number) { return new Promise<void>((resolve) => setTimeout(resolve, ms)); }
