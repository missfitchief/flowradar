// FlowRadar — query-only GMGN provider (Task 2). Wraps the runtime allowlist
// with bounded, budgeted, cursor-aware read-only fetches. Returns RAW feed
// rows (arrays of records) — normalization/persistence lives in @flowradar/db.
// No execution surface: every call goes through runGmgnCli's allowlist.
import { runGmgnCli } from './allowlist';

export interface GmgnFetchOptions {
  chain?: 'sol';
  limit?: number;
  timeoutMs?: number;
  cliPath?: string;
}

function asRows(data: unknown, ...paths: string[]): Record<string, unknown>[] {
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  if (data && typeof data === 'object') {
    for (const p of paths) {
      const v = (data as Record<string, unknown>)[p];
      if (Array.isArray(v)) return v as Record<string, unknown>[];
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
  const obj = (data && typeof data === 'object') ? (data as Record<string, unknown>) : {};
  const rows = Array.isArray(obj.activities) ? (obj.activities as Record<string, unknown>[]) : [];
  const next = typeof obj.next === 'string' && obj.next ? obj.next : null;
  return { rows, next };
}

/** portfolio stats — 30d provider PnL/win-rate aggregates for one or more wallets. */
export async function fetchWalletStats30d(walletAddress: string, opts: GmgnFetchOptions = {}): Promise<Record<string, unknown> | null> {
  const data = await runGmgnCli(['portfolio', 'stats', '--chain', opts.chain ?? 'sol', '--wallet', walletAddress, '--period', '30d', '--raw'], { timeoutMs: opts.timeoutMs, cliPath: opts.cliPath });
  return (data && typeof data === 'object' && !Array.isArray(data)) ? (data as Record<string, unknown>) : null;
}
