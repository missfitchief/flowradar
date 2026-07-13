// FlowRadar — query-only GMGN provider (Task 2). Wraps the runtime allowlist
// with bounded, budgeted, cursor-aware read-only fetches. Returns RAW feed
// rows (arrays of records) — normalization/persistence lives in @flowradar/db.
// No execution surface: every call goes through runGmgnCli's allowlist.
import type { Chain } from '@flowradar/core';
import type { GetTopTradersOpts, TokenTopTrader, TokenTopTradersProvider } from '../candidates/types';
import { runGmgnCli } from './allowlist';

export interface GmgnFetchOptions {
  chain?: 'sol';
  limit?: number;
  timeoutMs?: number;
  cliPath?: string;
}

const onlyObjects = (arr: unknown[]): Record<string, unknown>[] =>
  arr.filter((r): r is Record<string, unknown> => r !== null && typeof r === 'object' && !Array.isArray(r));

/** Extracts a row array from a raw response, tolerating array / {list} /
 *  {data} / {data:{list}} shapes and dropping any non-object elements
 *  (Codex Task-2 P2 — a null/primitive in the array must not reach a
 *  normalizer). Unknown shape → empty feed (bounded, never throws). */
function asRows(data: unknown, ...paths: string[]): Record<string, unknown>[] {
  if (Array.isArray(data)) return onlyObjects(data);
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    for (const p of paths) {
      if (Array.isArray(obj[p])) return onlyObjects(obj[p] as unknown[]);
    }
    // Nested one level (e.g. { data: { list: [...] } }).
    if (obj.data && typeof obj.data === 'object') {
      const inner = obj.data as Record<string, unknown>;
      for (const p of paths) {
        if (Array.isArray(inner[p])) return onlyObjects(inner[p] as unknown[]);
      }
    }
  }
  return [];
}

const clampLimit = (n: number | undefined, max: number) => Math.max(1, Math.min(n ?? 100, max));

/** track smartmoney — recent Smart Money trades (buy/sell distinguished). */
export async function fetchSmartMoney(opts: GmgnFetchOptions = {}): Promise<Record<string, unknown>[]> {
  const data = await runGmgnCli(['track', 'smartmoney', '--chain', opts.chain ?? 'sol', '--limit', String(clampLimit(opts.limit, 200)), '--raw'], { timeoutMs: opts.timeoutMs, cliPath: opts.cliPath });
  return asRows(data, 'list', 'data');
}

/** track kol — recent KOL trades. */
export async function fetchKolTrades(opts: GmgnFetchOptions = {}): Promise<Record<string, unknown>[]> {
  const data = await runGmgnCli(['track', 'kol', '--chain', opts.chain ?? 'sol', '--limit', String(clampLimit(opts.limit, 200)), '--raw'], { timeoutMs: opts.timeoutMs, cliPath: opts.cliPath });
  return asRows(data, 'list', 'data');
}

/** token traders — top traders for a token (rich per-wallet fields). */
export async function fetchTokenTraders(tokenAddress: string, opts: GmgnFetchOptions = {}): Promise<Record<string, unknown>[]> {
  const data = await runGmgnCli(['token', 'traders', '--chain', opts.chain ?? 'sol', '--address', tokenAddress, '--limit', String(clampLimit(opts.limit, 100)), '--raw'], { timeoutMs: opts.timeoutMs, cliPath: opts.cliPath });
  return asRows(data, 'list', 'data');
}

const finite = (value: unknown): number | null => {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
};

const firstFinite = (row: Record<string, unknown>, keys: string[]): number | null => {
  for (const key of keys) {
    const value = finite(row[key]);
    if (value !== null) return value;
  }
  return null;
};

const stringList = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
  return typeof value === 'string' && value.length > 0 ? [value] : [];
};

/** Maps the query-only GMGN token-traders feed into the shared discovery
 * contract. The endpoint is sampled at its bounded maximum before ranking so
 * the requested ten are PnL-ranked rather than simply the first ten holders. */
export function mapGmgnTokenTrader(row: Record<string, unknown>): TokenTopTrader | null {
  const walletAddress = [row.address, row.account_address].find((value): value is string => typeof value === 'string' && value.length > 0);
  if (!walletAddress) return null;
  const realizedPnlUsd = firstFinite(row, ['realized_profit', 'realized_pnl']);
  const totalPnlUsd = firstFinite(row, ['profit', 'total_profit', 'total_pnl']);
  const unrealizedPnlUsd = firstFinite(row, ['unrealized_profit', 'unrealized_pnl']);
  const volumeBuyUsd = firstFinite(row, ['history_bought_cost', 'buy_volume_cur', 'cost']);
  const volumeSellUsd = firstFinite(row, ['history_sold_income', 'sell_volume_cur']);
  const tradeBuy = firstFinite(row, ['buy_tx_count_cur', 'buy_count']);
  const tradeSell = firstFinite(row, ['sell_tx_count_cur', 'sell_count']);
  return {
    walletAddress,
    chain: 'SOLANA',
    pnlUsd: totalPnlUsd ?? realizedPnlUsd ?? undefined,
    realizedPnlUsd,
    unrealizedPnlUsd,
    totalPnlUsd,
    volumeBuyUsd,
    volumeSellUsd,
    remainingUsd: firstFinite(row, ['usd_value', 'remaining_usd']),
    tradeBuy,
    tradeSell,
    tradeCount: tradeBuy !== null || tradeSell !== null ? (tradeBuy ?? 0) + (tradeSell ?? 0) : undefined,
    winRate: firstFinite(row, ['winrate', 'win_rate']) ?? undefined,
    tags: [...new Set([...stringList(row.tags), ...stringList(row.tag), ...stringList(row.maker_token_tags)])],
    raw: row
  };
}

/** Real, keyless, read-only Solana fallback backed by the existing allowlisted
 * GMGN CLI. It has no signing or transaction execution surface. */
export function createGmgnTokenTopTraders(): TokenTopTradersProvider {
  return {
    async getTopTraders(chain: Chain, tokenAddress: string, opts: GetTopTradersOpts = {}): Promise<TokenTopTrader[]> {
      if (chain !== 'SOLANA') return [];
      const requested = Math.max(1, Math.min(opts.limit ?? 10, 100));
      const rows = await fetchTokenTraders(tokenAddress, { chain: 'sol', limit: 100, timeoutMs: 30_000 });
      return rows
        .map(mapGmgnTokenTrader)
        .filter((row): row is TokenTopTrader => row !== null)
        .sort((a, b) => (b.realizedPnlUsd ?? Number.NEGATIVE_INFINITY) - (a.realizedPnlUsd ?? Number.NEGATIVE_INFINITY))
        .slice(0, requested);
    }
  };
}

/** token holders — top holders for a token. */
export async function fetchTokenHolders(tokenAddress: string, opts: GmgnFetchOptions = {}): Promise<Record<string, unknown>[]> {
  const data = await runGmgnCli(['token', 'holders', '--chain', opts.chain ?? 'sol', '--address', tokenAddress, '--limit', String(clampLimit(opts.limit, 100)), '--raw'], { timeoutMs: opts.timeoutMs, cliPath: opts.cliPath });
  return asRows(data, 'list', 'data');
}

/** portfolio activity — a wallet's buy/sell/transfer activity, cursor-paged.
 *  Returns { rows, next } so the caller can persist the cursor. */
export async function fetchWalletActivity(
  walletAddress: string,
  opts: GmgnFetchOptions & { cursor?: string; limit?: number } = {}
): Promise<{ rows: Record<string, unknown>[]; next: string | null }> {
  const argv = ['portfolio', 'activity', '--chain', opts.chain ?? 'sol', '--wallet', walletAddress, '--raw'];
  if (opts.limit) { argv.push('--limit', String(clampLimit(opts.limit, 100))); }
  if (opts.cursor) { argv.push('--cursor', opts.cursor); }
  const data = await runGmgnCli(argv, { timeoutMs: opts.timeoutMs, cliPath: opts.cliPath });
  // Same hardened extraction as the other feeds (Codex Task-2 P2): array /
  // {activities} / {data:{activities}} tolerated, non-object rows dropped.
  const obj = (data && typeof data === 'object' && !Array.isArray(data)) ? (data as Record<string, unknown>) : {};
  const rows = asRows(data, 'activities');
  const nextRaw = (obj.next ?? (obj.data && typeof obj.data === 'object' ? (obj.data as Record<string, unknown>).next : undefined));
  const next = typeof nextRaw === 'string' && nextRaw ? nextRaw : null;
  return { rows, next };
}

/** portfolio stats — 30d provider PnL/win-rate aggregates for one or more wallets. */
export async function fetchWalletStats30d(walletAddress: string, opts: GmgnFetchOptions = {}): Promise<Record<string, unknown> | null> {
  const data = await runGmgnCli(['portfolio', 'stats', '--chain', opts.chain ?? 'sol', '--wallet', walletAddress, '--period', '30d', '--raw'], { timeoutMs: opts.timeoutMs, cliPath: opts.cliPath });
  return (data && typeof data === 'object' && !Array.isArray(data)) ? (data as Record<string, unknown>) : null;
}
