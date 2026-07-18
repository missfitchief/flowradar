// FlowRadar — Birdeye historical enrichment worker (runner-mining evidence
// layer). Endpoint contracts are the P5-probe-verified ones ONLY:
//   GET /defi/ohlcv?address&type&time_from&time_to  -> { items: [{unixTime,o,h,l,c}] }
//   GET /defi/token_overview?address               -> { circulatingSupply?, totalSupply? }
// Auth via X-API-KEY header; ~1 rps ceiling on this plan; success/data envelope.
//
// Honesty rules: missing OHLCV / supply / provider failure are RECORDED states
// (no_ohlcv / no_supply / provider_error), never zero. Supply is the LABELED
// 'current_supply_assumption' (historical supply needs a provider we do not
// have) — confidence is capped at 'medium' because of it. Candles use
// candle-END semantics downstream (no lookahead). Bounded, resumable (rows
// with lastSuccessAt are skipped), idempotent (mint-unique upsert), rate-
// limited, retry-counted, receipts persisted (key never stored).

import type { PrismaClient, Prisma } from '@prisma/client';

const BASE = 'https://public-api.birdeye.so';
const OHLCV_FROM_TS = Math.floor(Date.parse('2021-01-01T00:00:00Z') / 1000);
const MAX_CANDLES_STORED = 1500; // 1D candles: > 4 years — bounded row size

export interface EnrichReport {
  attempted: number;
  enriched: number;
  noOhlcv: number;
  noSupply: number;
  providerErrors: number;
  skippedFresh: number;
  requestsUsed: number;
}

interface Candle { t: number; o: number; h: number; l: number; c: number }

export async function enrichTokenHistory(
  prisma: PrismaClient,
  opts: {
    mints: string[];
    apiKey: string | undefined;
    maxRequests?: number;
    /** ms between requests (plan ceiling ~1 rps). */
    paceMs?: number;
    now?: Date;
    fetchImpl?: typeof fetch;
  }
): Promise<EnrichReport> {
  if (!opts.apiKey) throw new Error('BIRDEYE_API_KEY not configured — enrichment cannot run (reported, not fabricated)');
  const fetchImpl = opts.fetchImpl ?? fetch;
  const paceMs = opts.paceMs ?? 1100;
  const maxRequests = opts.maxRequests ?? 1000;
  const now = opts.now ?? new Date();
  const headers = { 'X-API-KEY': opts.apiKey, 'x-chain': 'solana', accept: 'application/json' };

  const report: EnrichReport = { attempted: 0, enriched: 0, noOhlcv: 0, noSupply: 0, providerErrors: 0, skippedFresh: 0, requestsUsed: 0 };
  const pace = () => new Promise((r) => setTimeout(r, paceMs));

  const get = async <T>(url: string): Promise<{ data: T | null; http: number | null }> => {
    report.requestsUsed += 1;
    try {
      const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) return { data: null, http: res.status };
      const j = (await res.json()) as { success?: boolean; data?: T };
      return { data: j?.success ? (j.data as T) : null, http: res.status };
    } catch {
      return { data: null, http: null };
    } finally {
      await pace();
    }
  };

  for (const mint of opts.mints) {
    if (report.requestsUsed + 2 > maxRequests) break; // bounded — resumable next run
    const existing = await prisma.tokenEnrichment.findUnique({ where: { mint }, select: { lastSuccessAt: true, retryCount: true } });
    if (existing?.lastSuccessAt) {
      report.skippedFresh += 1;
      continue;
    }
    report.attempted += 1;

    const nowSec = Math.floor(now.getTime() / 1000);
    const ohlcvUrl = `${BASE}/defi/ohlcv?address=${mint}&type=1D&time_from=${OHLCV_FROM_TS}&time_to=${nowSec}`;
    const overviewUrl = `${BASE}/defi/token_overview?address=${mint}`;
    const { data: ohlcv, http: h1 } = await get<{ items: { unixTime: number; o: number; h: number; l: number; c: number }[] }>(ohlcvUrl);
    const { data: overview, http: h2 } = await get<{ circulatingSupply?: number; totalSupply?: number }>(overviewUrl);

    const receiptsBase = {
      requestFromTs: OHLCV_FROM_TS,
      requests: [
        { endpoint: '/defi/ohlcv', params: { type: '1D', time_from: OHLCV_FROM_TS, time_to: nowSec }, http: h1 },
        { endpoint: '/defi/token_overview', http: h2 }
      ],
      itemCount: ohlcv?.items?.length ?? 0
    };

    let status: string;
    let storedTruncated = false;
    let confidence = 'low';
    let candles: Candle[] = [];
    let supply: number | null = null;
    let athMcapUsd: number | null = null;
    let athTs: Date | null = null;

    const overviewFailed = h2 === null || (h2 !== 200 && h2 !== 404);
    if (h1 === null || (h1 !== 200 && h1 !== 404) || overviewFailed) {
      status = 'provider_error'; // BOTH endpoints must respond — an overview failure is retryable, never a permanent no_supply
    } else if (!ohlcv?.items?.length) {
      status = 'no_ohlcv';
    } else {
      const allCandles = ohlcv.items
        .filter((i) => Number.isFinite(i.h) && i.h > 0)
        .map((i) => ({ t: i.unixTime, o: i.o, h: i.h, l: i.l, c: i.c }))
        .sort((a, b) => a.t - b.t);
      storedTruncated = allCandles.length > MAX_CANDLES_STORED; // launch-era candles dropped -> can NEVER anchor
      candles = allCandles.slice(-MAX_CANDLES_STORED);
      supply = overview?.circulatingSupply ?? overview?.totalSupply ?? null;
      if (supply === null || !Number.isFinite(supply) || supply <= 0) {
        status = 'no_supply'; // candles kept; mcap NOT fabricated
        supply = null;
      } else {
        status = 'enriched';
        confidence = 'medium'; // capped: supply is the labeled current-supply assumption
        for (const cd of candles) {
          const mcap = cd.h * supply;
          if (athMcapUsd === null || mcap > athMcapUsd) {
            athMcapUsd = mcap;
            athTs = new Date(cd.t * 1000);
          }
        }
      }
    }

    const receipts = { ...receiptsBase, storedTruncated } as Prisma.InputJsonValue;
    const data = {
      provider: 'birdeye',
      ohlcvStartTs: candles.length > 0 ? new Date(candles[0].t * 1000) : null,
      ohlcvEndTs: candles.length > 0 ? new Date(candles[candles.length - 1].t * 1000) : null,
      candleCount: candles.length,
      candlesJson: candles.length > 0 ? (candles as unknown as Prisma.InputJsonValue) : undefined,
      supplyJson: { supply, source: supply !== null ? 'current_supply_assumption' : 'unavailable' } as Prisma.InputJsonValue,
      athMcapUsd,
      athTs,
      status,
      confidence,
      receiptsJson: receipts,
      lastError: status === 'provider_error' ? `http=${h1 ?? 'network'}` : null,
      lastSuccessAt: status === 'enriched' || status === 'no_ohlcv' || status === 'no_supply' ? now : null,
      retryCount: (existing?.retryCount ?? 0) + (status === 'provider_error' ? 1 : 0)
    };
    await prisma.tokenEnrichment.upsert({ where: { mint }, create: { mint, ...data }, update: data });

    if (status === 'enriched') report.enriched += 1;
    else if (status === 'no_ohlcv') report.noOhlcv += 1;
    else if (status === 'no_supply') report.noSupply += 1;
    else report.providerErrors += 1;
  }
  return report;
}

/** Candle-END mcap series from an enrichment row — the no-lookahead form:
 *  a candle's value is knowable only at its END (t + 1 day for 1D). */
export function enrichmentSeriesPoints(row: {
  candlesJson: unknown;
  supplyJson: unknown;
}): { ts: Date; marketCapUsd: number | null; priceUsd: number | null; liquidityUsd: null }[] {
  const candles = (Array.isArray(row.candlesJson) ? row.candlesJson : []) as Candle[];
  const supply = (row.supplyJson as { supply?: number } | null)?.supply ?? null;
  if (supply === null || !Number.isFinite(supply) || supply <= 0) return [];
  // HIGH at candle END: consistent with the persisted ATH (Codex C2), and
  // conservative for entry bands — it can only OVERSTATE an entry mcap,
  // biasing AGAINST claiming a low-band entry, never toward it.
  return candles.map((cd) => ({
    ts: new Date((cd.t + 86_400) * 1000), // candle END (value knowable only then)
    marketCapUsd: Number.isFinite(cd.h) && cd.h > 0 ? cd.h * supply : null,
    priceUsd: Number.isFinite(cd.c) ? cd.c : null,
    liquidityUsd: null
  }));
}
