// FlowRadar — wallet behavior reconstruction (pure; GMGN behavior plan Task 4
// / directive Task 3).
//
// Merges LOCAL truth (WalletTokenTrade rows, money-flow funding edges) with
// PROVIDER claims (GMGN activity + claimed stats) into one canonical
// BehaviorProfile with FIELD-LEVEL provenance. The four provenance classes
// are never blended:
//   - locally_observed : raw local rows (trades, edges) — our own chain data
//   - locally_computed : arithmetic over locally_observed rows only
//   - provider_claimed : the provider's own figures, verbatim, never verified
//   - inferred         : cross-source deduction, always labeled as such
// Missing data is null + 'unknown' — NEVER fabricated, never defaulted.
// Provider-vs-local disagreements are surfaced as explicit conflicts, not
// silently resolved.

export type FieldProvenance = 'locally_observed' | 'locally_computed' | 'provider_claimed' | 'inferred' | 'unknown';

export interface ProvenancedField<T> {
  value: T | null;
  provenance: FieldProvenance;
  /** 0..100. unknown fields are 0. provider_claimed tops out at 60 (never verified). */
  confidence: number;
}

export interface LocalTradeInput {
  tokenAddress: string;
  action: 'BUY' | 'SELL';
  amountUsd: number;
  ts: Date;
  marketCapAtTrade: number | null;
}

export interface ProviderActivityInput {
  side: 'buy' | 'sell' | 'transfer' | null;
  amountUsd: number | null;
  activityTs: Date | null;
  tokenAddress: string | null;
  sourceCommand: string;
}

export interface ProviderStatsInput {
  source: string;
  pnlUsd: number | null;
  winRate: number | null;
  tradeCount: number | null;
  observedAt: Date;
}

export interface FundingEdgeInput {
  direction: 'in' | 'out';
  usd: number | null;
  counterpartyAddress: string;
  ts: Date;
}

export interface BehaviorInputs {
  chain: 'SOLANA' | 'BSC';
  address: string;
  localTrades: LocalTradeInput[];
  providerActivity: ProviderActivityInput[];
  providerStats: ProviderStatsInput[];
  fundingEdges: FundingEdgeInput[];
  now: Date;
}

export interface TokenPositionSummary {
  tokenAddress: string;
  buyCount: number;
  sellCount: number;
  buyUsd: number;
  sellUsd: number;
  firstBuyTs: string | null;
  lastSellTs: string | null;
  /** First buy -> last sell, seconds. Null while never sold. */
  holdDurationSec: number | null;
  /** Seconds from first buy to FIRST sell. Null while never sold. */
  timeToFirstSellSec: number | null;
  /** sellUsd / buyUsd. Null when never bought (received-not-bought shape). */
  exitRatio: number | null;
  /** Entry market cap of the FIRST local buy, when locally known. */
  entryMcap: number | null;
  /** More than one distinct buy — repeat entry. */
  repeatedEntry: boolean;
  /** Bought locally but never sold and still (per local data) holding. */
  stillHolding: boolean;
  /** Sold without any local buy — received/transferred in, not bought. */
  receivedNotBought: boolean;
}

export interface BehaviorConflict {
  field: string;
  providerValue: number | null;
  localValue: number | null;
  note: string;
}

export type BehaviorDataQuality = 'local_and_provider' | 'local_only' | 'provider_only' | 'insufficient';

export interface BehaviorProfile {
  engineVersion: 1;
  chain: 'SOLANA' | 'BSC';
  address: string;
  computedAt: string;
  dataQuality: BehaviorDataQuality;
  local: {
    tradeCount: ProvenancedField<number>;
    buyCount: ProvenancedField<number>;
    sellCount: ProvenancedField<number>;
    tokenDiversity: ProvenancedField<number>;
    activeDays: ProvenancedField<number>;
    firstTradeTs: string | null;
    lastTradeTs: string | null;
    /** sum(sellUsd) - sum(buyUsd) over local trades — a ROUGH realized proxy
     *  (not FIFO PnL; open inventory is not priced). Labeled locally_computed
     *  with reduced confidence for exactly that reason. */
    realizedProxyUsd: ProvenancedField<number>;
    medianHoldSec: ProvenancedField<number>;
    medianTimeToFirstSellSec: ProvenancedField<number>;
    partialExits: ProvenancedField<number>;
    fullExits: ProvenancedField<number>;
    tokenPositions: TokenPositionSummary[];
  };
  provider: {
    tradeCount: ProvenancedField<number>;
    pnlUsd: ProvenancedField<number>;
    winRate: ProvenancedField<number>;
    activityBuys: ProvenancedField<number>;
    activitySells: ProvenancedField<number>;
    activityTransfers: ProvenancedField<number>;
  };
  funding: {
    inflowCount: ProvenancedField<number>;
    outflowCount: ProvenancedField<number>;
    topCounterparties: { address: string; direction: 'in' | 'out'; usd: number | null }[];
  };
  conflicts: BehaviorConflict[];
}

const FULL_EXIT_RATIO = 0.95; // >=95% of bought USD sold — "full" with the USD-proxy caveat

function unknown<T>(): ProvenancedField<T> {
  return { value: null, provenance: 'unknown', confidence: 0 };
}
function local<T>(value: T, confidence = 90): ProvenancedField<T> {
  return { value, provenance: 'locally_observed', confidence };
}
function computed<T>(value: T, confidence = 80): ProvenancedField<T> {
  return { value, provenance: 'locally_computed', confidence };
}
function claimed<T>(value: T, confidence = 50): ProvenancedField<T> {
  return { value, provenance: 'provider_claimed', confidence: Math.min(confidence, 60) };
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function buildTokenPositions(trades: LocalTradeInput[]): TokenPositionSummary[] {
  const byToken = new Map<string, LocalTradeInput[]>();
  for (const t of trades) {
    const list = byToken.get(t.tokenAddress) ?? [];
    list.push(t);
    byToken.set(t.tokenAddress, list);
  }
  const out: TokenPositionSummary[] = [];
  for (const [tokenAddress, list] of byToken) {
    const sorted = [...list].sort((a, b) => a.ts.getTime() - b.ts.getTime());
    const buys = sorted.filter((t) => t.action === 'BUY');
    const sells = sorted.filter((t) => t.action === 'SELL');
    const buyUsd = buys.reduce((s, t) => s + t.amountUsd, 0);
    const sellUsd = sells.reduce((s, t) => s + t.amountUsd, 0);
    const firstBuy = buys[0] ?? null;
    const firstSellAfterBuy = firstBuy ? sells.find((s) => s.ts.getTime() >= firstBuy.ts.getTime()) ?? null : null;
    const lastSell = sells.length > 0 ? sells[sells.length - 1] : null;
    out.push({
      tokenAddress,
      buyCount: buys.length,
      sellCount: sells.length,
      buyUsd,
      sellUsd,
      firstBuyTs: firstBuy ? firstBuy.ts.toISOString() : null,
      lastSellTs: lastSell ? lastSell.ts.toISOString() : null,
      holdDurationSec:
        firstBuy && lastSell && lastSell.ts.getTime() >= firstBuy.ts.getTime()
          ? Math.round((lastSell.ts.getTime() - firstBuy.ts.getTime()) / 1000)
          : null,
      timeToFirstSellSec:
        firstBuy && firstSellAfterBuy
          ? Math.round((firstSellAfterBuy.ts.getTime() - firstBuy.ts.getTime()) / 1000)
          : null,
      exitRatio: buyUsd > 0 ? sellUsd / buyUsd : null,
      entryMcap: firstBuy?.marketCapAtTrade ?? null,
      repeatedEntry: buys.length > 1,
      stillHolding: buys.length > 0 && sellUsd < buyUsd * FULL_EXIT_RATIO,
      receivedNotBought: buys.length === 0 && sells.length > 0
    });
  }
  return out.sort((a, b) => (a.firstBuyTs ?? '') < (b.firstBuyTs ?? '') ? -1 : 1);
}

/** Latest claimed stats across sources (per-field latest-observedAt wins; sources never averaged). */
function latestClaimed(stats: ProviderStatsInput[]): { pnlUsd: number | null; winRate: number | null; tradeCount: number | null } {
  const sorted = [...stats].sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime());
  let pnlUsd: number | null = null;
  let winRate: number | null = null;
  let tradeCount: number | null = null;
  for (const s of sorted) {
    if (s.pnlUsd != null) pnlUsd = s.pnlUsd;
    if (s.winRate != null) winRate = s.winRate;
    if (s.tradeCount != null) tradeCount = s.tradeCount;
  }
  return { pnlUsd, winRate, tradeCount };
}

export function reconstructBehaviorProfile(inputs: BehaviorInputs): BehaviorProfile {
  const { localTrades, providerActivity, providerStats, fundingEdges } = inputs;
  const hasLocal = localTrades.length > 0 || fundingEdges.length > 0;
  const hasProvider = providerActivity.length > 0 || providerStats.length > 0;

  // ---- local ----------------------------------------------------------
  const positions = buildTokenPositions(localTrades);
  const buys = localTrades.filter((t) => t.action === 'BUY').length;
  const sells = localTrades.filter((t) => t.action === 'SELL').length;
  const dayKeys = new Set(localTrades.map((t) => t.ts.toISOString().slice(0, 10)));
  const sortedTs = [...localTrades].sort((a, b) => a.ts.getTime() - b.ts.getTime());
  const buyUsdTotal = localTrades.filter((t) => t.action === 'BUY').reduce((s, t) => s + t.amountUsd, 0);
  const sellUsdTotal = localTrades.filter((t) => t.action === 'SELL').reduce((s, t) => s + t.amountUsd, 0);
  const holdDurations = positions.map((p) => p.holdDurationSec).filter((x): x is number => x !== null);
  const firstSellTimes = positions.map((p) => p.timeToFirstSellSec).filter((x): x is number => x !== null);
  const boughtPositions = positions.filter((p) => p.buyUsd > 0);
  const fullExits = boughtPositions.filter((p) => (p.exitRatio ?? 0) >= FULL_EXIT_RATIO).length;
  const partialExits = boughtPositions.filter((p) => (p.exitRatio ?? 0) > 0 && (p.exitRatio ?? 0) < FULL_EXIT_RATIO).length;

  const localBlock: BehaviorProfile['local'] = localTrades.length > 0
    ? {
        tradeCount: local(localTrades.length),
        buyCount: local(buys),
        sellCount: local(sells),
        tokenDiversity: computed(positions.length),
        activeDays: computed(dayKeys.size),
        firstTradeTs: sortedTs[0]?.ts.toISOString() ?? null,
        lastTradeTs: sortedTs[sortedTs.length - 1]?.ts.toISOString() ?? null,
        realizedProxyUsd: computed(sellUsdTotal - buyUsdTotal, 55), // rough proxy — open inventory unpriced
        medianHoldSec: holdDurations.length > 0 ? computed(median(holdDurations) as number) : unknown<number>(),
        medianTimeToFirstSellSec: firstSellTimes.length > 0 ? computed(median(firstSellTimes) as number) : unknown<number>(),
        partialExits: computed(partialExits),
        fullExits: computed(fullExits),
        tokenPositions: positions
      }
    : {
        tradeCount: unknown<number>(),
        buyCount: unknown<number>(),
        sellCount: unknown<number>(),
        tokenDiversity: unknown<number>(),
        activeDays: unknown<number>(),
        firstTradeTs: null,
        lastTradeTs: null,
        realizedProxyUsd: unknown<number>(),
        medianHoldSec: unknown<number>(),
        medianTimeToFirstSellSec: unknown<number>(),
        partialExits: unknown<number>(),
        fullExits: unknown<number>(),
        tokenPositions: []
      };

  // ---- provider (claimed, verbatim, separate) --------------------------
  const stats = latestClaimed(providerStats);
  const actBuys = providerActivity.filter((a) => a.side === 'buy').length;
  const actSells = providerActivity.filter((a) => a.side === 'sell').length;
  const actTransfers = providerActivity.filter((a) => a.side === 'transfer').length;
  const providerBlock: BehaviorProfile['provider'] = {
    tradeCount: stats.tradeCount != null ? claimed(stats.tradeCount) : unknown<number>(),
    pnlUsd: stats.pnlUsd != null ? claimed(stats.pnlUsd) : unknown<number>(),
    winRate: stats.winRate != null ? claimed(stats.winRate) : unknown<number>(),
    activityBuys: providerActivity.length > 0 ? claimed(actBuys) : unknown<number>(),
    activitySells: providerActivity.length > 0 ? claimed(actSells) : unknown<number>(),
    activityTransfers: providerActivity.length > 0 ? claimed(actTransfers) : unknown<number>()
  };

  // ---- funding ---------------------------------------------------------
  const inflows = fundingEdges.filter((e) => e.direction === 'in');
  const outflows = fundingEdges.filter((e) => e.direction === 'out');
  const topCounterparties = [...fundingEdges]
    .sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0))
    .slice(0, 10)
    .map((e) => ({ address: e.counterpartyAddress, direction: e.direction, usd: e.usd }));
  const fundingBlock: BehaviorProfile['funding'] = fundingEdges.length > 0
    ? { inflowCount: local(inflows.length), outflowCount: local(outflows.length), topCounterparties }
    : { inflowCount: unknown<number>(), outflowCount: unknown<number>(), topCounterparties: [] };

  // ---- conflicts (surfaced, never resolved) ----------------------------
  const conflicts: BehaviorConflict[] = [];
  if (stats.tradeCount != null && localTrades.length > 0) {
    const ratio = stats.tradeCount / localTrades.length;
    if ((ratio > 3 || ratio < 1 / 3) && Math.abs(stats.tradeCount - localTrades.length) > 10) {
      conflicts.push({
        field: 'tradeCount',
        providerValue: stats.tradeCount,
        localValue: localTrades.length,
        note: 'provider-claimed trade count differs >3x from locally observed trades — local view may be partial (bounded polling) or provider window differs; NOT reconciled'
      });
    }
  }
  if (stats.pnlUsd != null && localTrades.length >= 10) {
    const proxy = sellUsdTotal - buyUsdTotal;
    if (Math.sign(stats.pnlUsd) !== 0 && Math.sign(proxy) !== 0 && Math.sign(stats.pnlUsd) !== Math.sign(proxy) && Math.abs(proxy) > 1000) {
      conflicts.push({
        field: 'pnlUsd',
        providerValue: stats.pnlUsd,
        localValue: proxy,
        note: 'provider-claimed PnL sign disagrees with the local realized proxy (which excludes open inventory) — flagged for review, NOT reconciled'
      });
    }
  }

  const dataQuality: BehaviorDataQuality =
    hasLocal && hasProvider ? 'local_and_provider' : hasLocal ? 'local_only' : hasProvider ? 'provider_only' : 'insufficient';

  return {
    engineVersion: 1,
    chain: inputs.chain,
    address: inputs.address,
    computedAt: inputs.now.toISOString(),
    dataQuality,
    local: localBlock,
    provider: providerBlock,
    funding: fundingBlock,
    conflicts
  };
}
