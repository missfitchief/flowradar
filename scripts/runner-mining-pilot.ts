// FlowRadar — runner-mining BOUNDED PILOT (P5, Task 3 in miniature).
//
// Proves the provider→pure-engine pipeline end-to-end on ONE token with ~8
// read-only requests: Birdeye token discovery → OHLCV history → top traders →
// first-buy trades, mapped to TokenSeriesPoint[] and EntryContexts through
// the APPROVED no-lookahead engine. Market cap uses the CURRENT circulating
// supply as a LABELED assumption (supplySource='current_supply_assumption',
// confidence capped) — historical supply needs a provider we don't have yet;
// unknown stays unknown, never fabricated. Series are window-relative
// (anchoredAtLaunch=false — creation_info is plan-gated 401), so runner
// multiples may be UNDERSTATED; the engine states that in dataQuality.
//
// READ-ONLY: no DB writes, no eligibility, no trading. Never prints the key.
// Usage: npx tsx scripts/runner-mining-pilot.ts [tokenMint]
import { config } from 'dotenv';
config({ path: '.env' });
import {
  computeEntryContext,
  computeTokenOutcome,
  DEFAULT_RUNNER_MINING_CONFIG,
  type TokenSeriesPoint
} from '../packages/core/src/runnermining';

const KEY = process.env.BIRDEYE_API_KEY;
if (!KEY) { console.log(JSON.stringify({ pilot: 'skipped', reason: 'BIRDEYE_API_KEY unset' })); process.exit(0); }
const BASE = 'https://public-api.birdeye.so';
const H = { 'X-API-KEY': KEY!, 'x-chain': 'solana', accept: 'application/json' };
const pace = () => new Promise((r) => setTimeout(r, 1300));

let requests = 0;
async function get<T>(url: string): Promise<T | null> {
  requests += 1;
  try {
    const res = await fetch(url, { headers: H });
    if (!res.ok) { console.log(JSON.stringify({ fetchFailed: url.split('?')[0], http: res.status })); return null; }
    const j = (await res.json()) as { success?: boolean; data?: T };
    return j?.success ? (j.data as T) : null;
  } finally {
    await pace(); // pace EVERY request incl. failures — a 401 must not cascade into 429s
  }
}

async function main(): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  // 1. Token: operator-supplied mint, or discover a recent high-volume token.
  let mint = process.argv[2];
  let symbol = 'operator-supplied';
  if (!mint) {
    const list = await get<{ items: { address: string; symbol: string; market_cap?: number }[] }>(
      `${BASE}/defi/v3/token/list?sort_by=volume_24h_usd&sort_type=desc&min_market_cap=10000&max_market_cap=5000000&limit=1`
    );
    if (!list?.items?.length) throw new Error('token discovery returned nothing');
    mint = list.items[0]!.address;
    symbol = list.items[0]!.symbol;
  }

  // 2. Historical series: 7 days of 1H OHLCV (one bounded request).
  const ohlcv = await get<{ items: { unixTime: number; c: number }[] }>(
    `${BASE}/defi/ohlcv?address=${mint}&type=1H&time_from=${now - 7 * 86400}&time_to=${now}`
  );
  if (!ohlcv?.items?.length) throw new Error('no OHLCV history');

  // 3. Supply ASSUMPTION (current supply — labeled, never claimed historical).
  const overview = await get<{ circulatingSupply?: number; totalSupply?: number; liquidity?: number }>(
    `${BASE}/defi/token_overview?address=${mint}`
  );
  const supply = overview?.circulatingSupply ?? overview?.totalSupply ?? null;
  const supplySource = supply !== null ? 'current_supply_assumption' : 'unavailable';

  // Candle CLOSE prices are only knowable at candle END — timestamp each
  // point at unixTime + interval so computeEntryContext can never hand a buy
  // inside a candle that candle's own close (Codex P5 #1: no lookahead).
  // Historical liquidity is UNKNOWN (null) — repeating CURRENT liquidity
  // across history would let present-day liquidity mint historical
  // illiquidity labels (Codex P5 #2); current liquidity reported separately.
  const CANDLE_SEC = 3600; // matches type=1H
  const series: TokenSeriesPoint[] = ohlcv.items.map((c) => ({
    ts: new Date((c.unixTime + CANDLE_SEC) * 1000),
    priceUsd: Number.isFinite(c.c) ? c.c : null,
    marketCapUsd: supply !== null && Number.isFinite(c.c) ? c.c * supply : null, // labeled assumption
    liquidityUsd: null // historical liquidity has no source — unknown stays unknown
  }));

  // 4. Outcome (window-relative — NOT launch-anchored; engine caps confidence).
  const outcome = computeTokenOutcome(series, DEFAULT_RUNNER_MINING_CONFIG);

  // 5. Top traders → entry contexts for their observed buys (no-lookahead).
  const traders = await get<{ items: { owner: string; tags?: string[] }[] }>(
    `${BASE}/defi/v2/tokens/top_traders?address=${mint}&time_frame=24h&sort_by=volume&sort_type=desc&limit=3`
  );
  const entries: Record<string, unknown>[] = [];
  for (const t of traders?.items ?? []) {
    const txs = await get<{ items: { blockUnixTime: number; side?: string; from?: { symbol?: string } }[] }>(
      `${BASE}/defi/txs/token/seek_by_time?address=${mint}&owner=${t.owner}&tx_type=swap&limit=10&before_time=${now}`
    ).catch(() => null);
    // Fall back to plain token txs when owner-scoped seek isn't available.
    const buys = (txs?.items ?? []).filter((x) => x.side === 'buy');
    const firstBuyTs = buys.length > 0 ? new Date(Math.min(...buys.map((b) => b.blockUnixTime * 1000))) : null;
    if (!firstBuyTs) { entries.push({ owner: t.owner.slice(0, 8), entry: 'no observed buys in window' }); continue; }
    const ctx = computeEntryContext(firstBuyTs, series, DEFAULT_RUNNER_MINING_CONFIG);
    entries.push({
      owner: t.owner.slice(0, 8),
      firstObservedBuy: firstBuyTs.toISOString(),
      entryMarketCapUsd: ctx.entryMarketCapUsd,
      bucket: ctx.bucket,
      valuationStatus: ctx.valuationStatus,
      valuationConfidence: Number(ctx.valuationConfidence.toFixed(3)),
      belowFocusCeiling: ctx.belowFocusCeiling
    });
  }

  console.log(JSON.stringify({
    pilot: 'runner-mining-e2e',
    token: { mint, symbol },
    seriesPoints: series.length,
    supplySource,
    currentLiquidityUsd: overview?.liquidity ?? null, // reported separately, never injected into history
    liquidityCaveat: 'historical liquidity unknown (null in series) — liquidity-dependent labels correctly unavailable in this pilot',
    outcome: {
      labels: outcome.labels,
      baselineMcapUsd: outcome.baselineMcapUsd,
      athMcapUsd: outcome.athMcapUsd,
      maxMultipleFromBaseline: outcome.maxMultipleFromBaseline === null ? null : Number(outcome.maxMultipleFromBaseline.toFixed(2)),
      confidence: outcome.confidence,
      dataQuality: outcome.dataQuality
    },
    topTraderEntries: entries,
    providerRequests: requests
  }, null, 2));
}

main().catch((e) => { console.error('pilot failed:', e instanceof Error ? e.message : e); process.exitCode = 1; });
