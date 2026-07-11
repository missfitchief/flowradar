// FlowRadar — TokenRiskCache: the canonical cached risk layer (Task 1, the
// Helius risk-check 429 burst fix).
//
// PROBLEM (shadow-run finding H-1): runFlowScoringPass called the Helius risk
// RPC (getTokenLargestAccounts + getTokenSupply) once PER TOKEN, PER PASS —
// and entityClustering runs a SECOND full scoring pass each cycle, doubling
// it. 2,978 tokens × 2 passes × 2 RPCs, uncached, produced ~3,440 × HTTP 429
// and blocks universe scaling.
//
// FIX: split read from fetch.
//   - CONSUMERS (flowScoring, entityClustering's re-run) READ the cache via
//     `getCachedRisk` — a pure DB read of the canonical TokenRiskSnapshot.
//     It NEVER calls the provider. Fresh -> stored report verbatim (FlowScore
//     identical). Stale/throttled/error with a last-good value -> that value
//     labeled stale (penalty unchanged). Missing / honestly-unavailable ->
//     unavailableRiskReport() (penalty 0 + warn flag — unknown, NEVER "safe").
//   - ONE bounded job (`runTokenRiskRefresh`) is the SOLE provider caller. It
//     scans traded tokens that are missing a snapshot or due for refresh
//     (nextRefreshAt <= now), bounded to `limit`, and calls `refreshToken`.
//   - `refreshToken` is the fetch primitive with IN-FLIGHT DEDUP (a
//     module-instance Map keyed by chain:address) so concurrent refreshes of
//     one token collapse to a single provider call. It is 429-aware
//     (Retry-After honored, else bounded exponential backoff), preserves the
//     last successful observation on failure, and NEVER lets one token's error
//     escape (the batch continues).
//
// INVARIANTS: risk MEANING and FlowScore are unchanged — the score reads only
// RiskReport.penalty, which the cache stores and returns byte-for-byte on a
// fresh read; stale reads keep the same penalty and only ADD a label flag
// (flags do not affect the score). Missing data stays UNKNOWN (penalty 0 +
// warn), never fabricated as safe or as a penalty.

import type { PrismaClient } from '@prisma/client';
import type { Chain, RiskReport } from '@flowradar/core';
import {
  DEFAULT_RISK_FRESHNESS,
  nextRefreshDelaySec,
  reportForSnapshot,
  riskFreshness,
  unavailableRiskReport,
  type RiskSnapshotStatusValue,
  type RiskSnapshotView
} from '@flowradar/core';
import type { RiskProviderLike, RiskProviderResolver } from '../scoring-pass';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface RiskBackoffConfig {
  baseSec: number;
  factor: number;
  maxSec: number;
}

export interface TokenRiskCacheConfig {
  /** Seconds a successful observation stays 'fresh'. */
  freshSec: number;
  /** Exponential-backoff schedule for repeated failures (bounded). */
  backoff: RiskBackoffConfig;
  /** Confidence (0..100) stamped on each snapshot status. */
  confidence: { ok: number; unavailable: number; failedWithLastGood: number; failedNoValue: number };
  /**
   * Hard cap on how many INLINE warm-on-miss provider fetches this cache
   * instance (i.e. one scoring pass) may issue. Beyond it, getRiskWarmOnMiss
   * degrades to a pure cache read (unknown for a cold token) rather than
   * fetching — so a cold-start scoring pass can NEVER re-create the burst
   * regardless of universe size. The bounded refresh job fills the rest.
   */
  maxInlineRefreshesPerPass: number;
  /**
   * Lease seconds a refresh CLAIMS a token for by advancing nextRefreshAt into
   * the future before calling the provider. A concurrent job/process that sees
   * the lease skips the provider call (cross-instance dedup). If the claimer
   * dies mid-fetch the lease expires and the token becomes eligible again.
   */
  claimLeaseSec: number;
  /** Max seconds to wait for a single provider fetch before treating it as a (retryable) error — bounds a hung request so it can't stall the batch or leak the in-flight entry. */
  fetchTimeoutSec: number;
}

export const DEFAULT_RISK_CACHE_CONFIG: TokenRiskCacheConfig = {
  freshSec: DEFAULT_RISK_FRESHNESS.freshSec, // 600s (10 min)
  backoff: { baseSec: 30, factor: 2, maxSec: 900 }, // 30s → … → 15 min cap
  confidence: { ok: 100, unavailable: 50, failedWithLastGood: 40, failedNoValue: 0 },
  maxInlineRefreshesPerPass: 200,
  claimLeaseSec: 60,
  fetchTimeoutSec: 20
};

// ---------------------------------------------------------------------------
// Error classification (pure)
// ---------------------------------------------------------------------------

export interface RiskErrorClassification {
  kind: 'throttled' | 'error';
  /** Seconds the provider asked us to wait (429 Retry-After), if given. */
  retryAfterSec?: number;
  /** Short category persisted on the snapshot for metrics/monitoring. */
  category: string;
}

function numericOrUndefined(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/**
 * Classifies a THROWN provider error WITHOUT coupling the cache to any one
 * provider's error class. It returns only `throttled` (HTTP 429 / rate-limit,
 * reading a typed `status`/`code` === 429, a `throttled` marker, or a
 * "429"/"too many requests"/"rate limit" message; plus any `retryAfterSec`) or
 * `error` (everything else). It DELIBERATELY never returns `unavailable`: a
 * definitive "data unavailable" verdict (mega-holder mint) only ever comes from
 * the provider RETURNING an unavailable RiskReport (handled on the success
 * path), never from a thrown error — because misclassifying a transient failure
 * as definitive-unavailable would ERASE a token's real last-good penalty and
 * advance observedAt. A thrown error is always retryable and PRESERVES
 * last-good. It never returns a "safe"/clean classification.
 */
export function classifyRiskError(err: unknown): RiskErrorClassification {
  const e = err as Record<string, unknown> | null | undefined;
  const message = e && typeof e.message === 'string' ? e.message : String(err ?? '');

  const status = numericOrUndefined(e?.status) ?? numericOrUndefined(e?.code);
  const looksThrottled =
    status === 429 || e?.throttled === true || /\b429\b|too many requests|rate limit/i.test(message);
  if (looksThrottled) {
    const retryAfterSec = numericOrUndefined(e?.retryAfterSec) ?? numericOrUndefined(e?.retryAfter);
    return { kind: 'throttled', retryAfterSec, category: 'rate_limited' };
  }

  return { kind: 'error', category: 'rpc' };
}

// ---------------------------------------------------------------------------
// Cache coordinator
// ---------------------------------------------------------------------------

export interface TokenRef {
  id: string;
  chain: Chain;
  address: string;
}

/** What a single refreshToken attempt actually did — drives honest job metrics. */
export type RefreshOutcome = 'refreshed' | 'unavailable' | 'throttled' | 'error' | 'skipped_claim';

export interface RefreshResult {
  report: RiskReport;
  outcome: RefreshOutcome;
}

export interface TokenRiskCacheDeps {
  prisma: PrismaClient;
  /** Resolves the REAL provider (Helius/GoPlus) for a chain — the only thing that calls out. */
  resolveFetcher: (chain: Chain) => RiskProviderLike & { providerName?: string };
  now?: () => Date;
  config?: Partial<TokenRiskCacheConfig>;
  classify?: (err: unknown) => RiskErrorClassification;
  log?: { info?: (m: string, meta?: Record<string, unknown>) => void; error?: (m: string, meta?: Record<string, unknown>) => void };
}

type SnapshotRow = {
  status: string;
  penalty: number;
  flags: unknown;
  observedAt: Date | null;
  expiresAt: Date;
  nextRefreshAt: Date;
  confidence: number;
  failCount: number;
};

const UNAVAILABLE_FLAG_ID = 'holder_data_unavailable';

function keyOf(chain: Chain, address: string): string {
  return `${chain}:${address}`;
}

function toView(row: SnapshotRow): RiskSnapshotView {
  return {
    status: row.status as RiskSnapshotStatusValue,
    penalty: row.penalty,
    flags: (Array.isArray(row.flags) ? row.flags : []) as RiskReport['flags'],
    observedAt: row.observedAt,
    expiresAt: row.expiresAt,
    nextRefreshAt: row.nextRefreshAt,
    confidence: row.confidence
  };
}

/** Rejects with a `{ timeout: true }` error if `p` doesn't settle within `ms`. Always clears its timer. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`${label} timed out after ${ms}ms`), { timeout: true })), ms);
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

/** Sanitizes a provider-supplied Retry-After to a finite non-negative number, else undefined. */
function sanitizeRetryAfterSec(v: number | undefined): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
}

export class TokenRiskCache {
  private readonly prisma: PrismaClient;
  private readonly resolveFetcher: (chain: Chain) => RiskProviderLike & { providerName?: string };
  private readonly now: () => Date;
  private readonly cfg: TokenRiskCacheConfig;
  private readonly classify: (err: unknown) => RiskErrorClassification;
  private readonly log?: TokenRiskCacheDeps['log'];
  /** In-flight provider fetches, keyed by chain:address — the dedup guard. */
  private readonly inFlight = new Map<string, Promise<RefreshResult>>();
  /** Remaining INLINE warm-on-miss fetches this instance may issue (the cold-start cap). */
  private remainingInlineWarms: number;

  constructor(deps: TokenRiskCacheDeps) {
    this.prisma = deps.prisma;
    this.resolveFetcher = deps.resolveFetcher;
    this.now = deps.now ?? (() => new Date());
    const merged = {
      ...DEFAULT_RISK_CACHE_CONFIG,
      ...deps.config,
      backoff: { ...DEFAULT_RISK_CACHE_CONFIG.backoff, ...deps.config?.backoff },
      confidence: { ...DEFAULT_RISK_CACHE_CONFIG.confidence, ...deps.config?.confidence }
    };
    // The claim lease MUST outlive a single (timeout-bounded) fetch, otherwise a
    // slow claimant's lease could expire mid-fetch and a second worker could
    // claim + persist while the first is still running — an unfenced overwrite.
    // Clamp so a misconfigured claimLeaseSec <= fetchTimeoutSec can't open that
    // window (lease = at least 2× the fetch timeout).
    merged.claimLeaseSec = Math.max(merged.claimLeaseSec, merged.fetchTimeoutSec * 2);
    this.cfg = merged;
    this.classify = deps.classify ?? classifyRiskError;
    this.log = deps.log;
    this.remainingInlineWarms = this.cfg.maxInlineRefreshesPerPass;
  }

  /** Number of provider fetches currently in flight (test/monitoring hook). */
  inFlightCount(): number {
    return this.inFlight.size;
  }

  /** Remaining inline warm-on-miss budget (test/monitoring hook). */
  inlineWarmBudgetRemaining(): number {
    return this.remainingInlineWarms;
  }

  /**
   * PURE cache read used by consumers (flowScoring, entityClustering). NEVER
   * calls the provider. Fresh -> stored report verbatim (FlowScore identical);
   * stale/throttled/error with a last-good value -> that value labeled stale;
   * missing / honestly-unavailable -> unavailableRiskReport() (unknown, not safe).
   */
  async getCachedRisk(chain: Chain, address: string): Promise<RiskReport> {
    const row = (await this.prisma.tokenRiskSnapshot.findUnique({
      where: { chain_tokenAddress: { chain: chain as 'SOLANA' | 'BSC', tokenAddress: address } },
      select: { status: true, penalty: true, flags: true, observedAt: true, expiresAt: true, nextRefreshAt: true, confidence: true, failCount: true }
    })) as SnapshotRow | null;

    if (!row) return unavailableRiskReport();
    const view = toView(row);
    const freshness = riskFreshness(view, this.now(), { freshSec: this.cfg.freshSec });
    return reportForSnapshot(view, freshness);
  }

  /** A RiskProviderLike backed purely by the cache read — never fetches. */
  asRiskProvider(): RiskProviderLike {
    return { getTokenRisk: (chain, address) => this.getCachedRisk(chain, address) };
  }

  /**
   * The SCORE-PRESERVING consumer read. Returns the best cached value without
   * a provider call whenever one exists — fresh (verbatim), stale-with-value
   * (labeled, same penalty), or honest-unavailable. It inline-fetches (deduped)
   * ONLY when there is literally nothing usable yet AND the token is not in a
   * 429 backoff window: i.e. a brand-new token with no snapshot, or one that
   * has never observed a value and is past its nextRefreshAt. This guarantees a
   * token is NEVER scored as a spurious penalty-0 just because the background
   * refresh job hasn't reached it — so FlowScore is unchanged — while the
   * per-cycle burst still collapses to at most one call per genuinely-new token
   * (dedup + freshness serve everything else from cache). Backoff is respected:
   * a throttled token still within its wait window returns its best-known value
   * rather than hammering the provider again.
   *
   * COLD-START CAP: inline warm fetches are bounded per instance (one scoring
   * pass) by maxInlineRefreshesPerPass. Once exhausted, a cold token degrades to
   * a pure cache read (unknown) instead of fetching — so a freshly-migrated
   * universe of N tokens can never issue N inline provider calls in one pass;
   * the bounded refresh job fills the remainder over subsequent cycles.
   */
  async getRiskWarmOnMiss(chain: Chain, address: string): Promise<RiskReport> {
    const row = (await this.prisma.tokenRiskSnapshot.findUnique({
      where: { chain_tokenAddress: { chain: chain as 'SOLANA' | 'BSC', tokenAddress: address } },
      select: { status: true, penalty: true, flags: true, observedAt: true, expiresAt: true, nextRefreshAt: true, confidence: true, failCount: true }
    })) as SnapshotRow | null;

    const now = this.now();
    if (row) {
      const view = toView(row);
      const report = reportForSnapshot(view, riskFreshness(view, now, { freshSec: this.cfg.freshSec }));
      const hasValue = view.observedAt !== null || view.status === 'unavailable';
      const backingOff = view.nextRefreshAt.getTime() > now.getTime();
      if (hasValue || backingOff) return report; // serve best-known; no inline fetch
      // else: never observed a value AND due -> fall through and warm inline
    }

    // Cold-start cap: beyond the per-pass budget, do NOT fetch — read through.
    // Reserve the budget slot SYNCHRONOUSLY (before any await) so concurrent
    // cold reads can't all observe the same remaining count and overshoot the
    // cap; refund it if we end up not fetching (token not found).
    if (this.remainingInlineWarms <= 0) return this.getCachedRisk(chain, address);
    this.remainingInlineWarms -= 1;

    const token = (await this.prisma.token.findUnique({
      where: { chain_address: { chain: chain as 'SOLANA' | 'BSC', address } },
      select: { id: true }
    })) as { id: string } | null;
    if (!token) {
      this.remainingInlineWarms += 1; // refund — no fetch happened
      return unavailableRiskReport();
    }

    return this.refreshToken({ id: token.id, chain, address });
  }

  /**
   * The fetch primitive — the ONLY method that calls the real provider.
   * Concurrent calls for the same token in THIS instance share ONE provider
   * call (in-flight dedup); across instances/processes a persisted CLAIM (a
   * short lease on nextRefreshAt) prevents a double provider call. Persists the
   * outcome to the canonical snapshot and returns the report a consumer would
   * read. NEVER throws — failures are recorded as throttled/error with backoff.
   */
  async refreshToken(token: TokenRef): Promise<RiskReport> {
    return (await this.refreshTokenDetailed(token)).report;
  }

  /**
   * Like refreshToken but returns WHAT the attempt did (refreshed / unavailable
   * / throttled / error / skipped_claim), so the bounded job can report honest
   * metrics — a lost claim (another job/process already owns the refresh) is
   * counted as skipped, never as a refresh that never issued a provider call.
   */
  async refreshTokenDetailed(token: TokenRef): Promise<RefreshResult> {
    const key = keyOf(token.chain, token.address);
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const p = this.doRefresh(token).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, p);
    return p;
  }

  /**
   * Atomically CLAIM an EXISTING snapshot for refresh by advancing its
   * nextRefreshAt to a short lease. Returns true iff this caller won:
   *   - existing row that is DUE (nextRefreshAt <= now): the updateMany flips
   *     exactly one row, so two concurrent jobs/processes can't both proceed —
   *     cross-instance dedup AND backoff enforcement in one atomic step (a
   *     token still inside its 429 wait window is never `<= now`, so it is
   *     never claimed). This is the steady-state path — the actual 429 source.
   *   - existing row NOT due (fresh / already leased): false — do not re-fetch.
   *   - NO row yet (brand-new token): true, WITHOUT writing a placeholder. A
   *     placeholder would be visible to a concurrent same-pass consumer and make
   *     it skip the shared in-flight result; instead brand-new tokens dedup via
   *     the in-flight map (same instance) and are best-effort across instances
   *     (two processes might each fetch a brand-new token once — bounded,
   *     harmless, both write the same value). The row is created by persist*.
   */
  private async claim(token: TokenRef): Promise<boolean> {
    const now = this.now();
    const lease = new Date(now.getTime() + this.cfg.claimLeaseSec * 1000);
    const res = await this.prisma.tokenRiskSnapshot.updateMany({
      where: { tokenId: token.id, nextRefreshAt: { lte: now } },
      data: { nextRefreshAt: lease, requestedAt: now }
    });
    if (res.count > 0) return true;

    // No row flipped: either the row exists but is not due (lost), or there is
    // no row yet (brand-new -> proceed without a placeholder).
    const existing = await this.prisma.tokenRiskSnapshot.findUnique({
      where: { tokenId: token.id },
      select: { tokenId: true }
    });
    return existing === null;
  }

  private async doRefresh(token: TokenRef): Promise<RefreshResult> {
    // Cross-instance/process dedup + backoff gate: only the winner calls out.
    const won = await this.claim(token);
    if (!won) {
      return { report: await this.getCachedRisk(token.chain, token.address), outcome: 'skipped_claim' };
    }

    const requestedAt = this.now();
    const fetcher = this.resolveFetcher(token.chain);
    const providerName = fetcher.providerName ?? 'unknown';

    try {
      // Bound the provider call so a hung request can't stall the batch or leak
      // the in-flight entry — a timeout is a retryable error (backoff applies).
      const report = await withTimeout(
        fetcher.getTokenRisk(token.chain, token.address),
        this.cfg.fetchTimeoutSec * 1000,
        'risk fetch'
      );
      // A successful fetch can still legitimately be "unavailable" (the Helius
      // adapter returns a holder_data_unavailable report for mega-holder mints
      // rather than throwing) — record it as unavailable so monitoring sees it,
      // but the stored penalty (0) + flag read back identically either way.
      const isUnavailable = report.flags.some((f) => f.id === UNAVAILABLE_FLAG_ID);
      const status: RiskSnapshotStatusValue = isUnavailable ? 'unavailable' : 'ok';
      await this.persistSuccess(token, providerName, requestedAt, status, report);
      return { report, outcome: isUnavailable ? 'unavailable' : 'refreshed' };
    } catch (err) {
      const cls = this.classify(err);
      await this.persistFailure(token, providerName, requestedAt, cls);
      this.log?.error?.('tokenRiskCache: refresh failed', {
        chain: token.chain,
        kind: cls.kind,
        category: cls.category
      });
      // Return what a consumer would now read (last-good stale, or unknown).
      return { report: await this.getCachedRisk(token.chain, token.address), outcome: cls.kind };
    }
  }

  private async persistSuccess(
    token: TokenRef,
    provider: string,
    requestedAt: Date,
    status: RiskSnapshotStatusValue,
    report: RiskReport
  ): Promise<void> {
    const observedAt = requestedAt;
    const next = new Date(requestedAt.getTime() + this.cfg.freshSec * 1000);
    const confidence = status === 'unavailable' ? this.cfg.confidence.unavailable : this.cfg.confidence.ok;
    const data = {
      chain: token.chain as 'SOLANA' | 'BSC',
      tokenAddress: token.address,
      provider,
      requestedAt,
      observedAt,
      status: status as 'ok' | 'unavailable' | 'throttled' | 'error',
      flags: report.flags as unknown as object,
      penalty: report.penalty,
      confidence,
      errorCategory: null,
      failCount: 0,
      expiresAt: next,
      nextRefreshAt: next
    };
    await this.prisma.tokenRiskSnapshot.upsert({
      where: { tokenId: token.id },
      create: { tokenId: token.id, ...data },
      update: data
    });
  }

  private async persistFailure(
    token: TokenRef,
    provider: string,
    requestedAt: Date,
    cls: RiskErrorClassification
  ): Promise<void> {
    const prior = (await this.prisma.tokenRiskSnapshot.findUnique({
      where: { tokenId: token.id },
      select: { observedAt: true, penalty: true, flags: true, expiresAt: true, failCount: true }
    })) as { observedAt: Date | null; penalty: number; flags: unknown; expiresAt: Date; failCount: number } | null;

    const failCount = (prior?.failCount ?? 0) + 1;
    const status: RiskSnapshotStatusValue = cls.kind === 'throttled' ? 'throttled' : 'error';

    // Delay: a sanitized+capped Retry-After if the provider gave one, else
    // bounded exponential backoff. Capping at backoff.maxSec means a bogus or
    // hostile Retry-After (86400, -1, NaN, Infinity) can neither defeat the
    // bound, schedule an immediately-due retry, nor produce an invalid Date.
    const retryAfter = sanitizeRetryAfterSec(cls.retryAfterSec);
    const rawDelaySec = retryAfter ?? nextRefreshDelaySec(failCount, this.cfg.backoff);
    const delaySec = Math.max(1, Math.min(rawDelaySec, this.cfg.backoff.maxSec));
    const nextRefreshAt = new Date(requestedAt.getTime() + delaySec * 1000);

    // PRESERVE the last successful observation (observedAt + penalty + flags) so
    // getCachedRisk can still return that value labeled stale — dropping a real
    // penalty to a false 0 just because the latest attempt failed would be LESS
    // safe. A thrown error is ALWAYS treated as transient/retryable (classify
    // never returns `unavailable`), so last-good is never erased here.
    const hasLastGood = prior?.observedAt != null;
    const confidence = hasLastGood ? this.cfg.confidence.failedWithLastGood : this.cfg.confidence.failedNoValue;

    const observedAt = prior?.observedAt ?? null;
    const penalty = prior?.penalty ?? 0;
    const flags = (prior?.flags ?? []) as unknown as object;
    const expiresAt = prior?.expiresAt ?? requestedAt;

    const data = {
      chain: token.chain as 'SOLANA' | 'BSC',
      tokenAddress: token.address,
      provider,
      requestedAt,
      observedAt,
      status: status as 'ok' | 'unavailable' | 'throttled' | 'error',
      flags,
      penalty,
      confidence,
      errorCategory: cls.category,
      failCount,
      expiresAt,
      nextRefreshAt
    };
    await this.prisma.tokenRiskSnapshot.upsert({
      where: { tokenId: token.id },
      create: { tokenId: token.id, ...data },
      update: data
    });
  }
}

/**
 * The RiskProviderResolver consumers pass to runFlowScoringPass — every chain
 * resolves to the SAME cache-backed read (so flowScoring and entityClustering's
 * re-run share one warm cache and issue zero provider calls).
 */
export function cachedRiskResolver(cache: TokenRiskCache): RiskProviderResolver {
  const provider = cache.asRiskProvider();
  return () => provider;
}

/**
 * The RiskProviderResolver consumers use in PRODUCTION — a score-preserving
 * read that serves the cache and inline-fetches (deduped) only on a genuine
 * miss (see TokenRiskCache.getRiskWarmOnMiss). Every chain resolves to the SAME
 * cache instance so a cycle's flowScoring warms it and entityClustering's
 * re-run reads it (zero extra provider calls).
 */
export function warmingRiskResolver(cache: TokenRiskCache): RiskProviderResolver {
  const provider: RiskProviderLike = { getTokenRisk: (chain, address) => cache.getRiskWarmOnMiss(chain, address) };
  return () => provider;
}
