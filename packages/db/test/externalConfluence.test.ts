// FlowRadar — runExternalConfluencePass integration tests (Task D, External
// Confluence). Same LITE-Postgres integration pattern as
// socialIngest.test.ts (probePort skipIf, prefix-cleanup, serialized).
//
// SHADOW-ONLY (design doc global rules 1-6/15/16): this pass READS the latest
// TokenMarketSnapshot + enabled ExternalConfluenceSource rows and WRITES only
// TokenConfluenceSnapshot rows. It NEVER creates a Token/Signal/Alert/
// CandidateWallet, never touches FlowScore, and never renders absence as safe.
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import net from 'node:net';
import { DEFAULT_SETTINGS } from '@flowradar/core';
import type { Chain } from '@flowradar/core';
import type { ConfluenceProvider, ConfluenceFetchResult } from '@flowradar/providers';
import { prisma } from '../src/client';
import { runExternalConfluencePass } from '../src/confluence/ingest';

const SOURCE_PREFIX = 'T_D_confSource';
const ADDR_PREFIX = 'TDconfAddr';

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

let dbReachable = false;

beforeAll(async () => {
  dbReachable = await probePort('localhost', 5439);
  if (!dbReachable) {
    // eslint-disable-next-line no-console
    console.warn(
      '[externalConfluence.test] LITE Postgres not reachable on localhost:5439 — skipping ' +
        'integration tests. Run `npm run db:migrate` first to exercise this suite.'
    );
  }
});

async function cleanup(): Promise<void> {
  // Snapshots created VIA a test source must be deleted while the relation
  // still exists (the pass fetches for EVERY known token, so a seeded DB gets
  // test-source snapshots on non-prefixed addresses too — deleting the source
  // first would orphan those via ON DELETE SET NULL instead of removing them).
  await prisma.tokenConfluenceSnapshot.deleteMany({ where: { source: { name: { startsWith: SOURCE_PREFIX } } } });
  await prisma.tokenConfluenceSnapshot.deleteMany({ where: { tokenAddress: { startsWith: ADDR_PREFIX } } });
  await prisma.externalConfluenceSource.deleteMany({ where: { name: { startsWith: SOURCE_PREFIX } } });
  await prisma.token.deleteMany({ where: { address: { startsWith: ADDR_PREFIX } } });
}

afterAll(async () => {
  if (!dbReachable) return;
  await cleanup();
  await prisma.$disconnect();
});

beforeEach(async () => {
  if (!dbReachable) return;
  await cleanup();
});

type ExternalConfluenceSourceRowLike = { id: string; name: string; provider: string; enabled: boolean; apiKeyEnvName: string | null };

/** Explicit fake provider — deterministic single-result fetch, records per-token call args. */
function makeFakeConfluenceProvider(
  result: ConfluenceFetchResult,
  opts: { provider?: string; snapshotType?: string; name?: string } = {}
): ConfluenceProvider & { calls: Array<{ chain: Chain; tokenAddress: string }> } {
  return {
    name: opts.name ?? 'fake-confluence',
    provider: opts.provider ?? 'holderscan',
    snapshotType: opts.snapshotType ?? 'holder_risk',
    chains: ['SOLANA'],
    calls: [],
    async fetchForToken(chain: Chain, tokenAddress: string): Promise<ConfluenceFetchResult> {
      this.calls.push({ chain, tokenAddress });
      return result;
    }
  };
}

async function makeSourceRow(
  name: string,
  overrides: Partial<{ enabled: boolean; provider: string; apiKeyEnvName: string | null }> = {}
) {
  return prisma.externalConfluenceSource.create({
    data: {
      name,
      provider: overrides.provider ?? 'holderscan',
      enabled: overrides.enabled ?? true,
      apiKeyEnvName: overrides.apiKeyEnvName ?? 'HOLDERSCAN_API_KEY',
      rateLimitPerMinute: 30
    }
  });
}

/** Creates a Token + one latest TokenMarketSnapshot with the given liquidity/mcap so LiquidityRisk has real inputs. */
async function makeTokenWithMarket(
  address: string,
  market: { liquidityUsd: number; marketCapUsd: number }
): Promise<string> {
  const token = await prisma.token.create({
    data: {
      chain: 'SOLANA',
      address,
      symbol: 'TDCONF',
      name: 'Task D Confluence Token',
      decimals: 9,
      firstSeenAt: new Date(),
      riskFlags: []
    }
  });
  await prisma.tokenMarketSnapshot.create({
    data: {
      tokenId: token.id,
      ts: new Date(),
      priceUsd: 0.001,
      marketCapUsd: market.marketCapUsd,
      fdvUsd: market.marketCapUsd,
      liquidityUsd: market.liquidityUsd,
      vol5m: 0,
      vol1h: 0,
      vol6h: 0,
      vol24h: 0,
      holderCount: 100
    }
  });
  return token.id;
}

describe.skipIf(!(await probePort('localhost', 5439)))('runExternalConfluencePass', () => {
  it('computes an internal LiquidityRisk snapshot from the latest TokenMarketSnapshot', async () => {
    const address = `${ADDR_PREFIX}1111111111111111111111111111`;
    const tokenId = await makeTokenWithMarket(address, { liquidityUsd: 40000, marketCapUsd: 1_000_000 });

    // No enabled sources — only the INTERNAL LiquidityRisk leg runs.
    const result = await runExternalConfluencePass(prisma, DEFAULT_SETTINGS, () => null);

    expect(result.errors).toBe(0);
    expect(result.internalLiquiditySnapshots).toBeGreaterThanOrEqual(1);

    const snap = await prisma.tokenConfluenceSnapshot.findFirst({
      where: { tokenAddress: address, provider: 'internal', snapshotType: 'liquidity_risk' }
    });
    expect(snap).not.toBeNull();
    expect(snap!.sourceId).toBeNull();
    expect(snap!.tokenId).toBe(tokenId);
    expect(snap!.chain).toBe('SOLANA');
    expect(snap!.status).toBe('ok');
    // ratio = L/MC = 40000 / 1_000_000 = 0.04
    const data = snap!.dataJson as Record<string, unknown>;
    expect(data.liquidityToMcapRatio).toBeCloseTo(0.04, 6);
    // Band from DEFAULT_SETTINGS.ratioFragilityBands [0.02,0.05,0.15]: 0.04 -> "fragile".
    expect(data.ratioFragilityBand).toBe('fragile');
    // absoluteLiquidityBand from [10000,50000,250000]: 40000 -> "thin".
    expect(data.absoluteLiquidityBand).toBe('thin');
  });

  it('internal (sourceId=null) snapshots are deduped at the APP layer: a second pass yields ONE row per token+dedupeKey, not two', async () => {
    // THE Task-B NULL-dedup proof: the composite unique
    // [sourceId, tokenAddress, snapshotType, dedupeKey] does NOT constrain
    // sourceId=null rows (Postgres NULL-distinctness), so only an app-layer
    // findFirst -> update-else-create keeps re-runs at one row. Two rows here
    // would mean the pass wrongly relied on the (null-ineffective) index.
    const address = `${ADDR_PREFIX}dedupe1111111111111111111111`;
    await makeTokenWithMarket(address, { liquidityUsd: 40000, marketCapUsd: 1_000_000 });

    const first = await runExternalConfluencePass(prisma, DEFAULT_SETTINGS, () => null);
    const second = await runExternalConfluencePass(prisma, DEFAULT_SETTINGS, () => null);
    expect(first.errors).toBe(0);
    expect(second.errors).toBe(0);

    const internalRows = await prisma.tokenConfluenceSnapshot.findMany({
      where: { tokenAddress: address, provider: 'internal', snapshotType: 'liquidity_risk' }
    });
    expect(internalRows).toHaveLength(1); // ONE row per token+dedupeKey — updated, not re-inserted
    expect(internalRows[0]!.sourceId).toBeNull();
    expect(internalRows[0]!.status).toBe('ok');
  });

  it('enabled source with a resolved provider upserts an external snapshot for a KNOWN token (status stored verbatim, provider-claimed)', async () => {
    const address = `${ADDR_PREFIX}2222222222222222222222222222`;
    await makeTokenWithMarket(address, { liquidityUsd: 60000, marketCapUsd: 500_000 });
    const sourceName = `${SOURCE_PREFIX}_ok`;
    await makeSourceRow(sourceName, { provider: 'holderscan' });

    const provider = makeFakeConfluenceProvider(
      { status: 'ok', dataJson: { holderCount: 1234, providerClaimed: true }, observedAt: new Date() },
      { provider: 'holderscan', snapshotType: 'holder_risk', name: sourceName }
    );

    const result = await runExternalConfluencePass(prisma, DEFAULT_SETTINGS, (s) =>
      s.name === sourceName ? provider : null
    );

    expect(result.errors).toBe(0);
    expect(result.sourcesSynced).toBeGreaterThanOrEqual(1);
    expect(result.externalSnapshotsUpserted).toBeGreaterThanOrEqual(1);
    // Fetch was targeted at the KNOWN token's real address, on its chain.
    expect(provider.calls.some((c) => c.tokenAddress === address && c.chain === 'SOLANA')).toBe(true);

    const snap = await prisma.tokenConfluenceSnapshot.findFirst({
      where: { tokenAddress: address, provider: 'holderscan', snapshotType: 'holder_risk' }
    });
    expect(snap).not.toBeNull();
    expect(snap!.status).toBe('ok');
    expect(snap!.sourceId).not.toBeNull();
    const data = snap!.dataJson as Record<string, unknown>;
    expect(data.holderCount).toBe(1234);
    // Provider-claimed labeling (global rule 16): external data carries the flag.
    expect(data.providerClaimed).toBe(true);

    const sourceRow = await prisma.externalConfluenceSource.findUnique({ where: { name: sourceName } });
    expect(sourceRow?.status).toBe('live');
    expect(sourceRow?.lastSyncAt).not.toBeNull();
    expect(sourceRow?.failCount).toBe(0);
  });

  it('missing_key result is a clean skip: source status="missing_key", snapshot stored with that status, NEVER "ok"/"safe"', async () => {
    const address = `${ADDR_PREFIX}3333333333333333333333333333`;
    await makeTokenWithMarket(address, { liquidityUsd: 5000, marketCapUsd: 800_000 });
    const sourceName = `${SOURCE_PREFIX}_missingkey`;
    await makeSourceRow(sourceName, { provider: 'holderscan' });

    // The RESOLVED provider itself returns missing_key (Task C: adapter present
    // but env key absent -> fetch reports missing_key rather than fabricating data).
    const provider = makeFakeConfluenceProvider(
      { status: 'missing_key', dataJson: {}, observedAt: new Date() },
      { provider: 'holderscan', snapshotType: 'holder_risk', name: sourceName }
    );

    const result = await runExternalConfluencePass(prisma, DEFAULT_SETTINGS, (s) =>
      s.name === sourceName ? provider : null
    );

    expect(result.errors).toBe(0);
    const snap = await prisma.tokenConfluenceSnapshot.findFirst({
      where: { tokenAddress: address, provider: 'holderscan', snapshotType: 'holder_risk' }
    });
    expect(snap).not.toBeNull();
    expect(snap!.status).toBe('missing_key'); // honest, NOT "ok"
    expect(snap!.status).not.toBe('ok');
    expect(snap!.status).not.toBe('safe'); // no such status exists — absence is never green
    const sourceRow = await prisma.externalConfluenceSource.findUnique({ where: { name: sourceName } });
    expect(sourceRow?.status).toBe('missing_key');
  });

  it('resolver returning null (adapter unavailable / manual provider) is a graceful per-source skip, no external snapshot', async () => {
    const address = `${ADDR_PREFIX}4444444444444444444444444444`;
    await makeTokenWithMarket(address, { liquidityUsd: 20000, marketCapUsd: 400_000 });
    const sourceName = `${SOURCE_PREFIX}_noprovider`;
    await makeSourceRow(sourceName, { provider: 'ag_paper', apiKeyEnvName: null });

    const result = await runExternalConfluencePass(prisma, DEFAULT_SETTINGS, () => null);

    expect(result.errors).toBe(0);
    expect(result.sourcesSkippedNoProvider).toBeGreaterThanOrEqual(1);
    // The internal LiquidityRisk snapshot still exists; NO ag_paper snapshot does.
    const ext = await prisma.tokenConfluenceSnapshot.findFirst({
      where: { tokenAddress: address, provider: 'ag_paper' }
    });
    expect(ext).toBeNull();
  });

  it('unavailable result stores an "unavailable" snapshot — never a reassuring/clean verdict (global rule 15)', async () => {
    const address = `${ADDR_PREFIX}5555555555555555555555555555`;
    await makeTokenWithMarket(address, { liquidityUsd: 15000, marketCapUsd: 300_000 });
    const sourceName = `${SOURCE_PREFIX}_unavail`;
    await makeSourceRow(sourceName, { provider: 'gmgn' });

    const provider = makeFakeConfluenceProvider(
      { status: 'unavailable', dataJson: {}, observedAt: new Date() },
      { provider: 'gmgn', snapshotType: 'external_intel', name: sourceName }
    );

    const result = await runExternalConfluencePass(prisma, DEFAULT_SETTINGS, (s) =>
      s.name === sourceName ? provider : null
    );
    expect(result.errors).toBe(0);

    const snap = await prisma.tokenConfluenceSnapshot.findFirst({
      where: { tokenAddress: address, provider: 'gmgn', snapshotType: 'external_intel' }
    });
    expect(snap).not.toBeNull();
    expect(snap!.status).toBe('unavailable');
    const sourceRow = await prisma.externalConfluenceSource.findUnique({ where: { name: sourceName } });
    expect(sourceRow?.status).toBe('unavailable');
  });

  it('disabled source is skipped entirely — provider never called, no external snapshot', async () => {
    const address = `${ADDR_PREFIX}6666666666666666666666666666`;
    await makeTokenWithMarket(address, { liquidityUsd: 30000, marketCapUsd: 600_000 });
    const sourceName = `${SOURCE_PREFIX}_disabled`;
    await makeSourceRow(sourceName, { enabled: false });

    const provider = makeFakeConfluenceProvider(
      { status: 'ok', dataJson: { holderCount: 1 }, observedAt: new Date() },
      { name: sourceName }
    );

    const result = await runExternalConfluencePass(prisma, DEFAULT_SETTINGS, (s) =>
      s.name === sourceName ? provider : null
    );

    expect(result.sourcesSkippedDisabled).toBeGreaterThanOrEqual(1);
    expect(provider.calls).toHaveLength(0);
    const rows = await prisma.tokenConfluenceSnapshot.findMany({
      where: { tokenAddress: address, provider: 'holderscan' }
    });
    expect(rows).toHaveLength(0);
  });

  it('NEVER creates a Token: a source that could fetch does not add a Token row (external providers are read-only w.r.t. Token)', async () => {
    // No Token/market exists at this address at all.
    const unknownAddress = `${ADDR_PREFIX}7777777777777777777777777777`;
    const sourceName = `${SOURCE_PREFIX}_notoken`;
    await makeSourceRow(sourceName, { provider: 'holderscan' });

    const provider = makeFakeConfluenceProvider(
      { status: 'ok', dataJson: { holderCount: 99 }, observedAt: new Date() },
      { name: sourceName }
    );

    const tokensBefore = await prisma.token.count();
    const result = await runExternalConfluencePass(prisma, DEFAULT_SETTINGS, (s) =>
      s.name === sourceName ? provider : null
    );
    const tokensAfter = await prisma.token.count();

    expect(result.errors).toBe(0);
    expect(tokensAfter).toBe(tokensBefore); // no Token created
    // The provider was never asked to fetch a non-existent token (known-tokens-only).
    expect(provider.calls.some((c) => c.tokenAddress === unknownAddress)).toBe(false);
    // And no snapshot was written for the phantom address.
    const phantom = await prisma.tokenConfluenceSnapshot.findFirst({ where: { tokenAddress: unknownAddress } });
    expect(phantom).toBeNull();
  });

  it('re-run (same hour, same token+source) is idempotent — 0 net new external rows, upsert not insert', async () => {
    const address = `${ADDR_PREFIX}8888888888888888888888888888`;
    await makeTokenWithMarket(address, { liquidityUsd: 45000, marketCapUsd: 900_000 });
    const sourceName = `${SOURCE_PREFIX}_idem`;
    const source = await makeSourceRow(sourceName, { provider: 'holderscan' });

    const provider = makeFakeConfluenceProvider(
      { status: 'ok', dataJson: { holderCount: 7 }, observedAt: new Date() },
      { name: sourceName }
    );
    const resolver = (s: ExternalConfluenceSourceRowLike) => (s.name === sourceName ? provider : null);

    await runExternalConfluencePass(prisma, DEFAULT_SETTINGS, resolver as never);
    await runExternalConfluencePass(prisma, DEFAULT_SETTINGS, resolver as never);

    const extRows = await prisma.tokenConfluenceSnapshot.findMany({
      where: { sourceId: source.id, tokenAddress: address, snapshotType: 'holder_risk' }
    });
    expect(extRows).toHaveLength(1); // deduped on [sourceId, tokenAddress, snapshotType, dedupeKey]

    const internalRows = await prisma.tokenConfluenceSnapshot.findMany({
      where: { tokenAddress: address, provider: 'internal', snapshotType: 'liquidity_risk' }
    });
    expect(internalRows).toHaveLength(1); // internal leg is idempotent too
  });

  it('one source throwing never aborts other enabled sources (per-source try/catch)', async () => {
    const address = `${ADDR_PREFIX}9999999999999999999999999999`;
    await makeTokenWithMarket(address, { liquidityUsd: 25000, marketCapUsd: 500_000 });
    const goodName = `${SOURCE_PREFIX}_good`;
    const badName = `${SOURCE_PREFIX}_bad`;
    await makeSourceRow(goodName, { provider: 'holderscan' });
    await makeSourceRow(badName, { provider: 'gmgn' });

    const goodProvider = makeFakeConfluenceProvider(
      { status: 'ok', dataJson: { holderCount: 42 }, observedAt: new Date() },
      { provider: 'holderscan', snapshotType: 'holder_risk', name: goodName }
    );
    const badProvider: ConfluenceProvider = {
      name: badName,
      provider: 'gmgn',
      snapshotType: 'external_intel',
      chains: ['SOLANA'],
      async fetchForToken() {
        throw new Error('simulated confluence provider failure');
      }
    };

    const result = await runExternalConfluencePass(prisma, DEFAULT_SETTINGS, (s) =>
      s.name === goodName ? goodProvider : badProvider
    );

    expect(result.errors).toBeGreaterThanOrEqual(1);
    const goodSnap = await prisma.tokenConfluenceSnapshot.findFirst({
      where: { tokenAddress: address, provider: 'holderscan', snapshotType: 'holder_risk' }
    });
    expect(goodSnap).not.toBeNull();

    const badRow = await prisma.externalConfluenceSource.findUnique({ where: { name: badName } });
    expect(badRow?.status).toBe('error');
    expect(badRow?.lastError).toContain('simulated confluence provider failure');
    expect(badRow?.failCount).toBeGreaterThanOrEqual(1);

    const goodRow = await prisma.externalConfluenceSource.findUnique({ where: { name: goodName } });
    expect(goodRow?.status).toBe('live');
  });

  it('one token throwing never aborts sibling tokens in the same source (per-token try/catch); source stays live', async () => {
    const okAddr = `${ADDR_PREFIX}aaaaaaaaaaaaaaaaaaaaaaaaaaaa`;
    const badAddr = `${ADDR_PREFIX}bbbbbbbbbbbbbbbbbbbbbbbbbbbb`;
    await makeTokenWithMarket(okAddr, { liquidityUsd: 33000, marketCapUsd: 700_000 });
    await makeTokenWithMarket(badAddr, { liquidityUsd: 33000, marketCapUsd: 700_000 });
    const sourceName = `${SOURCE_PREFIX}_pertoken`;
    await makeSourceRow(sourceName, { provider: 'holderscan' });

    // Provider throws for exactly one target token, returns ok for the other.
    const provider: ConfluenceProvider = {
      name: sourceName,
      provider: 'holderscan',
      snapshotType: 'holder_risk',
      chains: ['SOLANA'],
      async fetchForToken(_chain: Chain, tokenAddress: string) {
        if (tokenAddress === badAddr) throw new Error('per-token fetch boom');
        return { status: 'ok', dataJson: { holderCount: 5 }, observedAt: new Date() } as ConfluenceFetchResult;
      }
    };

    const result = await runExternalConfluencePass(prisma, DEFAULT_SETTINGS, (s) =>
      s.name === sourceName ? provider : null
    );

    // The good token still got its snapshot even though a sibling threw.
    const ok = await prisma.tokenConfluenceSnapshot.findFirst({
      where: { tokenAddress: okAddr, provider: 'holderscan', snapshotType: 'holder_risk' }
    });
    expect(ok).not.toBeNull();
    // A per-TOKEN failure does NOT mark the SOURCE 'error' (it resolved + fetched fine for siblings).
    const sourceRow = await prisma.externalConfluenceSource.findUnique({ where: { name: sourceName } });
    expect(sourceRow?.status).toBe('live');
    expect(result.errors).toBeGreaterThanOrEqual(1);
  });
});
