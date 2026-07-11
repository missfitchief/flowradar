// FlowRadar — TokenRiskCache integration tests (Task 1 Helius 429 fix).
//
// Covers the DB/coordination half of the operator's 12 required tests:
//   #1  two consumers requesting one token create one provider call (in-flight dedup)
//   #2  fresh snapshot causes zero provider calls
//   #3  stale snapshot schedules refresh (picked up + refreshed by the job)
//   #4  429 honors Retry-After
//   #5  repeated 429 uses bounded backoff (persisted nextRefreshAt)
//   #6  one token error does not fail the pass (batch continues)
//   #7  unavailable data is not safe (missing snapshot read is unknown, penalty 0 + warn)
//   #10 clustering does not issue independent risk calls (2nd scoring pass = 0 calls)
//   #11 restart resumes pending refreshes (persisted, new instance picks up)
//   #12 no unbounded queue / memory growth (in-flight map empties; batch is bounded)
//
// Same LITE-Postgres integration harness as the sibling db tests
// (probe :5439, describe.skipIf, prefix cleanup). Runs against flowradar_test.

import { describe, expect, it, afterAll, beforeEach } from 'vitest';
import net from 'node:net';
import { prisma } from '../../src/client';
import type { Chain, RiskReport } from '@flowradar/core';
import { TokenRiskCache, classifyRiskError, cachedRiskResolver, warmingRiskResolver } from '../../src/risk/tokenRiskCache';
import { runTokenRiskRefresh } from '../../src/risk/runTokenRiskRefresh';
import { runFlowScoringPass } from '../../src/scoring-pass';
import { DEFAULT_SETTINGS } from '@flowradar/core';

const PREFIX = 'T1RISK';
const CHAIN: Chain = 'SOLANA';

function probePort(host: string, port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

// Probe at COLLECTION time (top-level await) — describe.skipIf evaluates its
// condition eagerly, so a runtime beforeAll flag would always read false.
const dbReachable = await probePort('localhost', 5439);
if (!dbReachable) {
  // eslint-disable-next-line no-console
  console.warn('[tokenRiskCache.test] LITE Postgres not reachable on :5439 — skipping.');
}

/** Real-looking risk report a fake fetcher returns. */
function okReport(penalty = 0.3): RiskReport {
  return { penalty, flags: [{ id: 'top_holder_concentration', label: 'Top holder 42%', severity: 'danger' }] };
}

/** A spy fetcher whose behavior per-address is scriptable. */
function spyFetcher(behavior: (address: string, callIndex: number) => Promise<RiskReport>) {
  const calls: string[] = [];
  return {
    providerName: 'FakeHelius',
    calls,
    async getTokenRisk(_chain: Chain, address: string): Promise<RiskReport> {
      const idx = calls.length;
      calls.push(address);
      return behavior(address, idx);
    }
  };
}

function throttleError(retryAfterSec?: number): Error {
  return Object.assign(new Error('Helius RPC failed (429 Too Many Requests)'), {
    status: 429,
    ...(retryAfterSec !== undefined ? { retryAfterSec } : {})
  });
}

async function makeTradedToken(suffix: string, chain: Chain = CHAIN): Promise<{ id: string; address: string }> {
  const address = `${PREFIX}${suffix}`;
  const token = await prisma.token.create({
    data: {
      chain: chain as 'SOLANA' | 'BSC',
      address,
      symbol: `S${suffix}`.slice(0, 10),
      name: `Token ${suffix}`,
      decimals: 9,
      firstSeenAt: new Date(),
      riskFlags: []
    }
  });
  const wallet = await prisma.wallet.create({
    data: { chain: chain as 'SOLANA' | 'BSC', address: `${PREFIX}W${suffix}`, firstSeenAt: new Date(), lastActiveAt: new Date() }
  });
  await prisma.walletTokenTrade.create({
    data: {
      walletId: wallet.id,
      tokenId: token.id,
      chain: chain as 'SOLANA' | 'BSC',
      action: 'BUY',
      amountToken: '1000',
      amountUsd: '500',
      txHash: `${PREFIX}TX${suffix}`,
      blockOrSlot: 1n,
      ts: new Date(),
      priceUsd: '0.5',
      marketCapAtTrade: '100000',
      walletScoreAtTime: 50,
      provider: 'test'
    }
  });
  return { id: token.id, address };
}

async function cleanup() {
  await prisma.tokenRiskSnapshot.deleteMany({ where: { tokenAddress: { startsWith: PREFIX } } });
  await prisma.walletTokenTrade.deleteMany({ where: { txHash: { startsWith: PREFIX } } });
  await prisma.tokenFlowSnapshot.deleteMany({ where: { token: { address: { startsWith: PREFIX } } } });
  await prisma.wallet.deleteMany({ where: { address: { startsWith: PREFIX } } });
  await prisma.token.deleteMany({ where: { address: { startsWith: PREFIX } } });
}

beforeEach(async () => {
  if (dbReachable) await cleanup();
});

afterAll(async () => {
  if (!dbReachable) return;
  await cleanup();
  await prisma.$disconnect();
});

// Pure — does NOT need the database, so it runs even when the embedded
// Postgres is unavailable (Codex Minor-2: don't gate pure logic on the DB).
describe('classifyRiskError (pure)', () => {
  it('classifies a 429 with Retry-After as throttled', () => {
    const c = classifyRiskError(throttleError(45));
    expect(c.kind).toBe('throttled');
    expect(c.retryAfterSec).toBe(45);
  });
  it('classifies a plain 429 as throttled with no retryAfter', () => {
    const c = classifyRiskError(throttleError());
    expect(c.kind).toBe('throttled');
    expect(c.retryAfterSec).toBeUndefined();
  });
  it('classifies an unknown error as error (never silently safe)', () => {
    const c = classifyRiskError(new Error('boom'));
    expect(c.kind).toBe('error');
  });
  it('never classifies a THROWN error as "unavailable" — even a "too many accounts" message (Important-5 fix)', () => {
    // A thrown error must stay retryable so it can't erase a real last-good
    // penalty. Only a RETURNED unavailable report (success path) is definitive.
    const c = classifyRiskError(new Error('Too many accounts requested (5000000 pubkeys)'));
    expect(c.kind).toBe('error');
    expect((c as { kind: string }).kind).not.toBe('unavailable');
  });
  it('reads a message-only 429 as throttled', () => {
    const c = classifyRiskError(new Error('Helius RPC failed (429 Too Many Requests)'));
    expect(c.kind).toBe('throttled');
  });
});

describe.skipIf(!dbReachable)('TokenRiskCache', () => {
  it('#1 two concurrent refreshes of one token create exactly one provider call', async () => {
    const tok = await makeTradedToken('A');
    let resolveFetch!: (r: RiskReport) => void;
    const gate = new Promise<RiskReport>((res) => (resolveFetch = res));
    const fetcher = spyFetcher(() => gate);
    const cache = new TokenRiskCache({ prisma, resolveFetcher: () => fetcher });

    const p1 = cache.refreshToken({ id: tok.id, chain: CHAIN, address: tok.address });
    const p2 = cache.refreshToken({ id: tok.id, chain: CHAIN, address: tok.address });
    resolveFetch(okReport());
    await Promise.all([p1, p2]);

    expect(fetcher.calls.length).toBe(1); // deduped
    expect(cache.inFlightCount()).toBe(0); // map cleared
  });

  it('#1b two concurrent CONSUMER reads of one uncached token create exactly one provider call (warm-on-miss dedup)', async () => {
    const tok = await makeTradedToken('A2');
    let resolveFetch!: (r: RiskReport) => void;
    const gate = new Promise<RiskReport>((res) => (resolveFetch = res));
    const fetcher = spyFetcher(() => gate);
    const cache = new TokenRiskCache({ prisma, resolveFetcher: () => fetcher });
    const provider = warmingRiskResolver(cache)(CHAIN);

    const p1 = provider.getTokenRisk(CHAIN, tok.address);
    const p2 = provider.getTokenRisk(CHAIN, tok.address);
    resolveFetch(okReport(0.3));
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(fetcher.calls.length).toBe(1); // two consumers, one call
    expect(r1.penalty).toBe(0.3);
    expect(r2.penalty).toBe(0.3);
    expect(cache.inFlightCount()).toBe(0);
  });

  it('warm-on-miss preserves score: brand-new token fetches once, then reads serve cache (no spurious 0)', async () => {
    const tok = await makeTradedToken('A3');
    const fetcher = spyFetcher(async () => okReport(0.45));
    const cache = new TokenRiskCache({ prisma, resolveFetcher: () => fetcher });
    const provider = warmingRiskResolver(cache)(CHAIN);

    const first = await provider.getTokenRisk(CHAIN, tok.address);
    expect(first.penalty).toBe(0.45); // fetched, NOT a spurious unavailable 0
    expect(fetcher.calls.length).toBe(1);

    const second = await provider.getTokenRisk(CHAIN, tok.address);
    expect(second.penalty).toBe(0.45);
    expect(fetcher.calls.length).toBe(1); // served from cache
  });

  it('warm-on-miss respects 429 backoff: a token still within its wait window is not re-fetched', async () => {
    const tok = await makeTradedToken('A4');
    const future = new Date(Date.now() + 120_000);
    await prisma.tokenRiskSnapshot.create({
      data: {
        tokenId: tok.id,
        chain: CHAIN as 'SOLANA' | 'BSC',
        tokenAddress: tok.address,
        provider: 'FakeHelius',
        requestedAt: new Date(),
        observedAt: null, // never got a value
        status: 'throttled',
        flags: [],
        penalty: 0,
        confidence: 0,
        failCount: 3,
        expiresAt: new Date(),
        nextRefreshAt: future // still backing off
      }
    });
    const fetcher = spyFetcher(async () => okReport());
    const cache = new TokenRiskCache({ prisma, resolveFetcher: () => fetcher });
    const provider = warmingRiskResolver(cache)(CHAIN);

    const report = await provider.getTokenRisk(CHAIN, tok.address);
    expect(report.penalty).toBe(0); // unknown, not safe
    expect(fetcher.calls.length).toBe(0); // backoff respected — no hammering
  });

  it('#2 a fresh snapshot causes zero provider calls on read', async () => {
    const tok = await makeTradedToken('B');
    const fetcher = spyFetcher(async () => okReport(0.3));
    const cache = new TokenRiskCache({ prisma, resolveFetcher: () => fetcher });
    // warm it (1 call)
    await cache.refreshToken({ id: tok.id, chain: CHAIN, address: tok.address });
    expect(fetcher.calls.length).toBe(1);

    const report = await cache.getCachedRisk(CHAIN, tok.address);
    expect(report.penalty).toBe(0.3); // verbatim
    expect(fetcher.calls.length).toBe(1); // read added ZERO calls
  });

  it('#7 a missing snapshot reads as unknown (penalty 0 + warn flag), NOT safe', async () => {
    const fetcher = spyFetcher(async () => okReport());
    const cache = new TokenRiskCache({ prisma, resolveFetcher: () => fetcher });
    const report = await cache.getCachedRisk(CHAIN, `${PREFIX}MISSING`);
    expect(report.penalty).toBe(0);
    expect(report.flags.some((f) => f.severity === 'warn')).toBe(true);
    expect(fetcher.calls.length).toBe(0); // read never fetches
  });

  it('#3 a stale/pending snapshot is scheduled and refreshed by the job', async () => {
    const tok = await makeTradedToken('C');
    const past = new Date(Date.now() - 3_600_000);
    // seed a stale snapshot (nextRefreshAt in the past -> due)
    await prisma.tokenRiskSnapshot.create({
      data: {
        tokenId: tok.id,
        chain: CHAIN as 'SOLANA' | 'BSC',
        tokenAddress: tok.address,
        provider: 'FakeHelius',
        requestedAt: past,
        observedAt: past,
        status: 'ok',
        flags: okReport(0.5).flags as object,
        penalty: 0.5,
        confidence: 100,
        failCount: 0,
        expiresAt: past,
        nextRefreshAt: past
      }
    });
    const fetcher = spyFetcher(async () => okReport(0.2));
    const cache = new TokenRiskCache({ prisma, resolveFetcher: () => fetcher });

    const metrics = await runTokenRiskRefresh(cache, prisma, { limit: 50 });
    expect(fetcher.calls).toContain(tok.address);
    expect(metrics.refreshed).toBeGreaterThanOrEqual(1);

    const row = await prisma.tokenRiskSnapshot.findUnique({ where: { tokenId: tok.id } });
    expect(row?.penalty).toBe(0.2); // refreshed to the new value
    expect(row?.nextRefreshAt.getTime()).toBeGreaterThan(Date.now()); // rescheduled into the future
  });

  it('#4 a 429 with Retry-After schedules nextRefreshAt at ~now+retryAfter and preserves last-good penalty', async () => {
    const tok = await makeTradedToken('D');
    // warm a good value first
    const good = spyFetcher(async () => okReport(0.4));
    const cache = new TokenRiskCache({ prisma, resolveFetcher: () => good });
    await cache.refreshToken({ id: tok.id, chain: CHAIN, address: tok.address });
    // make the token DUE again so the next refresh actually claims + fetches
    // (the claim step intentionally refuses to re-fetch a not-yet-due token).
    await prisma.tokenRiskSnapshot.update({
      where: { tokenId: tok.id },
      data: { nextRefreshAt: new Date(Date.now() - 1000) }
    });

    // now the provider throttles
    const throttling = spyFetcher(async () => {
      throw throttleError(120);
    });
    const cache2 = new TokenRiskCache({ prisma, resolveFetcher: () => throttling });
    const before = Date.now();
    await cache2.refreshToken({ id: tok.id, chain: CHAIN, address: tok.address });

    const row = await prisma.tokenRiskSnapshot.findUnique({ where: { tokenId: tok.id } });
    expect(row?.status).toBe('throttled');
    // Retry-After honored: ~120s out (allow slack)
    const deltaSec = ((row?.nextRefreshAt.getTime() ?? 0) - before) / 1000;
    expect(deltaSec).toBeGreaterThanOrEqual(110);
    expect(deltaSec).toBeLessThanOrEqual(140);
    expect(row?.penalty).toBe(0.4); // last-good penalty preserved (never dropped to a false 0)
    expect(row?.observedAt).not.toBeNull(); // last successful observation kept

    // read returns the last-good value, labeled stale (safer than "unavailable")
    const report = await cache2.getCachedRisk(CHAIN, tok.address);
    expect(report.penalty).toBe(0.4);
    expect(report.flags.some((f) => f.id === 'risk_data_stale')).toBe(true);
  });

  it('#5 repeated 429s use bounded exponential backoff (capped)', async () => {
    const tok = await makeTradedToken('E');
    const throttling = spyFetcher(async () => {
      throw throttleError(); // no Retry-After -> use backoff
    });
    // Injected clock advanced far past each backoff window so every iteration
    // finds the token DUE and actually re-fetches (the claim refuses to fetch a
    // not-yet-due token). Delay is measured from the PERSISTED requestedAt
    // column, so it's independent of wall-clock / clock injection.
    let clock = new Date('2026-07-11T00:00:00Z');
    const cache = new TokenRiskCache({
      prisma,
      resolveFetcher: () => throttling,
      now: () => clock,
      config: { backoff: { baseSec: 30, factor: 2, maxSec: 300 } }
    });

    const deltas: number[] = [];
    for (let i = 0; i < 6; i++) {
      clock = new Date(clock.getTime() + 3_600_000); // +1h: always past the (<=300s) backoff
      await cache.refreshToken({ id: tok.id, chain: CHAIN, address: tok.address });
      const row = await prisma.tokenRiskSnapshot.findUnique({ where: { tokenId: tok.id } });
      deltas.push(((row?.nextRefreshAt.getTime() ?? 0) - (row?.requestedAt.getTime() ?? 0)) / 1000);
    }
    // grows exponentially (30, 60, 120, 240) then caps at maxSec (300)
    expect(deltas[0]).toBe(30);
    expect(deltas[1]).toBe(60);
    expect(deltas[2]).toBe(120);
    expect(deltas[3]).toBe(240);
    expect(deltas[4]).toBe(300); // capped (would be 480)
    expect(deltas[5]).toBe(300); // still capped, never unbounded
    const row = await prisma.tokenRiskSnapshot.findUnique({ where: { tokenId: tok.id } });
    expect(row?.failCount).toBe(6);
  });

  it('#6 one token error does not fail the batch; other tokens still refresh', async () => {
    const good1 = await makeTradedToken('F1');
    const bad = await makeTradedToken('F2');
    const good2 = await makeTradedToken('F3');
    const fetcher = spyFetcher(async (address) => {
      if (address === bad.address) throw new Error('rpc exploded');
      return okReport(0.1);
    });
    const cache = new TokenRiskCache({ prisma, resolveFetcher: () => fetcher });

    const metrics = await runTokenRiskRefresh(cache, prisma, { limit: 50 });
    expect(metrics.errors).toBeGreaterThanOrEqual(1);
    expect(metrics.refreshed).toBeGreaterThanOrEqual(2);

    const r1 = await prisma.tokenRiskSnapshot.findUnique({ where: { tokenId: good1.id } });
    const r2 = await prisma.tokenRiskSnapshot.findUnique({ where: { tokenId: good2.id } });
    const rb = await prisma.tokenRiskSnapshot.findUnique({ where: { tokenId: bad.id } });
    expect(r1?.status).toBe('ok');
    expect(r2?.status).toBe('ok');
    expect(rb?.status).toBe('error'); // recorded, not thrown
  });

  it('#10 a second scoring pass (clustering) issues zero independent provider calls', async () => {
    const tok = await makeTradedToken('G');
    const fetcher = spyFetcher(async () => okReport(0.3));
    const cache = new TokenRiskCache({ prisma, resolveFetcher: () => fetcher });
    // pre-warm via the bounded refresh job (the ONLY provider caller)
    await runTokenRiskRefresh(cache, prisma, { limit: 50 });
    const callsAfterWarm = fetcher.calls.length;
    expect(callsAfterWarm).toBeGreaterThanOrEqual(1);

    const resolver = cachedRiskResolver(cache);
    // two full scoring passes (flowScoring, then entityClustering re-runs it)
    await runFlowScoringPass(prisma, DEFAULT_SETTINGS, resolver);
    await runFlowScoringPass(prisma, DEFAULT_SETTINGS, resolver);

    expect(fetcher.calls.length).toBe(callsAfterWarm); // scoring passes added ZERO calls
  });

  it('#11 pending refreshes persist across a restart (fresh instance picks them up)', async () => {
    const tok = await makeTradedToken('H');
    // instance 1 warms then "crashes" — leave a due snapshot behind
    const past = new Date(Date.now() - 3_600_000);
    await prisma.tokenRiskSnapshot.create({
      data: {
        tokenId: tok.id,
        chain: CHAIN as 'SOLANA' | 'BSC',
        tokenAddress: tok.address,
        provider: 'FakeHelius',
        requestedAt: past,
        observedAt: null,
        status: 'error',
        flags: [],
        penalty: 0,
        confidence: 0,
        failCount: 1,
        expiresAt: past,
        nextRefreshAt: past
      }
    });
    // brand-new cache instance (in-flight map empty — simulates process restart)
    const fetcher = spyFetcher(async () => okReport(0.25));
    const fresh = new TokenRiskCache({ prisma, resolveFetcher: () => fetcher });
    expect(fresh.inFlightCount()).toBe(0);

    const metrics = await runTokenRiskRefresh(fresh, prisma, { limit: 50 });
    expect(metrics.refreshed).toBeGreaterThanOrEqual(1);
    const row = await prisma.tokenRiskSnapshot.findUnique({ where: { tokenId: tok.id } });
    expect(row?.status).toBe('ok');
    expect(row?.penalty).toBe(0.25);
  });

  it('#12 the batch is bounded by limit and the in-flight map returns to empty', async () => {
    for (let i = 0; i < 5; i++) await makeTradedToken(`L${i}`);
    const fetcher = spyFetcher(async () => okReport(0.1));
    const cache = new TokenRiskCache({ prisma, resolveFetcher: () => fetcher });

    const metrics = await runTokenRiskRefresh(cache, prisma, { limit: 2 });
    expect(metrics.considered).toBeLessThanOrEqual(2); // never fetch more than the cap
    expect(fetcher.calls.length).toBeLessThanOrEqual(2);
    expect(cache.inFlightCount()).toBe(0); // no leak

    // a second bounded run makes progress on the remaining tokens
    const m2 = await runTokenRiskRefresh(cache, prisma, { limit: 2 });
    expect(m2.considered).toBeLessThanOrEqual(2);
    expect(cache.inFlightCount()).toBe(0);
  });

  it('Critical-1: a cold scoring pass is capped by the inline-warm budget (no burst)', async () => {
    const toks = [];
    for (let i = 0; i < 5; i++) toks.push(await makeTradedToken(`CAP${i}`));
    const fetcher = spyFetcher(async () => okReport(0.3));
    const cache = new TokenRiskCache({ prisma, resolveFetcher: () => fetcher, config: { maxInlineRefreshesPerPass: 2 } });
    const provider = warmingRiskResolver(cache)(CHAIN);

    const reports = [];
    for (const t of toks) reports.push(await provider.getTokenRisk(CHAIN, t.address));

    expect(fetcher.calls.length).toBe(2); // hard cap: never N calls for N cold tokens
    expect(cache.inlineWarmBudgetRemaining()).toBe(0);
    expect(reports.filter((r) => r.penalty === 0.3).length).toBe(2); // first 2 fetched
    // the rest read through as UNKNOWN (penalty 0 + warn), never a spurious safe-0 without a flag
    expect(reports.filter((r) => r.penalty === 0 && r.flags.some((f) => f.severity === 'warn')).length).toBe(3);
  });

  it('Important-1/2: two separate cache instances refreshing one DUE token make exactly one provider call', async () => {
    const tok = await makeTradedToken('XI');
    const past = new Date(Date.now() - 3_600_000);
    await prisma.tokenRiskSnapshot.create({
      data: {
        tokenId: tok.id,
        chain: CHAIN as 'SOLANA' | 'BSC',
        tokenAddress: tok.address,
        provider: 'FakeHelius',
        requestedAt: past,
        observedAt: past,
        status: 'ok',
        flags: okReport(0.4).flags as object,
        penalty: 0.4,
        confidence: 100,
        failCount: 0,
        expiresAt: past,
        nextRefreshAt: past // DUE
      }
    });
    const fetcherA = spyFetcher(async () => okReport(0.21));
    const fetcherB = spyFetcher(async () => okReport(0.22));
    const cacheA = new TokenRiskCache({ prisma, resolveFetcher: () => fetcherA });
    const cacheB = new TokenRiskCache({ prisma, resolveFetcher: () => fetcherB });

    const [rA, rB] = await Promise.all([
      cacheA.refreshToken({ id: tok.id, chain: CHAIN, address: tok.address }),
      cacheB.refreshToken({ id: tok.id, chain: CHAIN, address: tok.address })
    ]);

    // The atomic DB claim lets exactly one instance call the provider; the other
    // sees the lease and returns the cached read instead of a second call.
    expect(fetcherA.calls.length + fetcherB.calls.length).toBe(1);
    // Whoever lost still returns a usable value (fresh new or last-good), never a crash.
    for (const r of [rA, rB]) expect(typeof r.penalty).toBe('number');
  });

  it('Important-4: a hostile Retry-After is capped at backoff.maxSec; a negative one falls back to backoff', async () => {
    // huge Retry-After -> capped
    const big = await makeTradedToken('RA1');
    let clock = new Date('2026-07-11T00:00:00Z');
    const cacheBig = new TokenRiskCache({
      prisma,
      resolveFetcher: () => spyFetcher(async () => { throw throttleError(86_400); }),
      now: () => clock,
      config: { backoff: { baseSec: 30, factor: 2, maxSec: 300 } }
    });
    await cacheBig.refreshToken({ id: big.id, chain: CHAIN, address: big.address });
    const rowBig = await prisma.tokenRiskSnapshot.findUnique({ where: { tokenId: big.id } });
    const bigDelta = ((rowBig?.nextRefreshAt.getTime() ?? 0) - (rowBig?.requestedAt.getTime() ?? 0)) / 1000;
    expect(bigDelta).toBe(300); // 86400 capped to maxSec, no invalid Date, no absurd wait

    // negative Retry-After -> ignored -> exponential backoff base (30)
    const neg = await makeTradedToken('RA2');
    const cacheNeg = new TokenRiskCache({
      prisma,
      resolveFetcher: () => spyFetcher(async () => { throw throttleError(-5); }),
      now: () => clock,
      config: { backoff: { baseSec: 30, factor: 2, maxSec: 300 } }
    });
    await cacheNeg.refreshToken({ id: neg.id, chain: CHAIN, address: neg.address });
    const rowNeg = await prisma.tokenRiskSnapshot.findUnique({ where: { tokenId: neg.id } });
    const negDelta = ((rowNeg?.nextRefreshAt.getTime() ?? 0) - (rowNeg?.requestedAt.getTime() ?? 0)) / 1000;
    expect(negDelta).toBe(30);
  });

  it('inline-warm budget is refunded when the token is not found (no fetch happened)', async () => {
    const fetcher = spyFetcher(async () => okReport());
    const cache = new TokenRiskCache({ prisma, resolveFetcher: () => fetcher, config: { maxInlineRefreshesPerPass: 3 } });
    const provider = warmingRiskResolver(cache)(CHAIN);
    // Address with no Token row -> reserve then refund; budget must not erode.
    await provider.getTokenRisk(CHAIN, `${PREFIX}NOTOKEN1`);
    await provider.getTokenRisk(CHAIN, `${PREFIX}NOTOKEN2`);
    expect(fetcher.calls.length).toBe(0);
    expect(cache.inlineWarmBudgetRemaining()).toBe(3); // fully refunded
  });

  it('Minor-1(metrics): a lost claim reports outcome "skipped_claim" and issues no provider call', async () => {
    const tok = await makeTradedToken('SKIP');
    // A row already LEASED into the future (as if a concurrent claimant owns it).
    const future = new Date(Date.now() + 120_000);
    await prisma.tokenRiskSnapshot.create({
      data: {
        tokenId: tok.id,
        chain: CHAIN as 'SOLANA' | 'BSC',
        tokenAddress: tok.address,
        provider: 'FakeHelius',
        requestedAt: new Date(),
        observedAt: new Date(Date.now() - 3_600_000),
        status: 'ok',
        flags: okReport(0.4).flags as object,
        penalty: 0.4,
        confidence: 100,
        failCount: 0,
        expiresAt: new Date(),
        nextRefreshAt: future // not due -> a claim here must LOSE
      }
    });
    const fetcherB = spyFetcher(async () => okReport(0.9));
    const cacheB = new TokenRiskCache({ prisma, resolveFetcher: () => fetcherB });

    const res = await cacheB.refreshTokenDetailed({ id: tok.id, chain: CHAIN, address: tok.address });
    expect(res.outcome).toBe('skipped_claim'); // lost the claim
    expect(fetcherB.calls.length).toBe(0); // no provider call
    expect(res.report.penalty).toBe(0.4); // still returns the best-known (last-good, fresh) value
  });

  it('Minor-1: a hung provider fetch times out, records an error, and does not leak the in-flight entry', async () => {
    const tok = await makeTradedToken('HANG');
    const hanging = spyFetcher(() => new Promise<RiskReport>(() => {})); // never resolves
    const cache = new TokenRiskCache({ prisma, resolveFetcher: () => hanging, config: { fetchTimeoutSec: 0.05 } });

    const report = await cache.refreshToken({ id: tok.id, chain: CHAIN, address: tok.address });
    expect(report.penalty).toBe(0); // unknown, not safe
    expect(cache.inFlightCount()).toBe(0); // no leak despite the still-hung underlying fetch

    const row = await prisma.tokenRiskSnapshot.findUnique({ where: { tokenId: tok.id } });
    expect(row?.status).toBe('error');
    expect(row?.errorCategory).toBe('rpc');
  });
});
