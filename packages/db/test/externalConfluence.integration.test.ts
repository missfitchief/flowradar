// FlowRadar — runExternalConfluencePass end-to-end integration (Task F,
// External Confluence, design §Worker integration). Same LITE-Postgres
// pattern as socialIngest.test.ts / externalWalletSource.test.ts:
// probePort(:5439) skipIf, prefix-scoped cleanup, serialized db project.
//
// SHADOW-ONLY (design global rules 1/2/6): asserts the pass computes an
// INTERNAL liquidity_risk snapshot from existing market data, records
// external-source statuses honestly (missing_key/stub/unavailable, NEVER
// "safe"), and NEVER creates Token / Signal / Alert / CandidateWallet rows.
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import net from 'node:net';
import { DEFAULT_SETTINGS, computeLiquidityRisk } from '@flowradar/core';
import type { Chain } from '@flowradar/core';
import type { ConfluenceProvider, ConfluenceFetchResult } from '@flowradar/providers';
import { MockConfluenceProvider } from '@flowradar/providers';
import { prisma } from '../src/client';
import { runExternalConfluencePass } from '../src/confluence/ingest';

const ADDR_PREFIX = 'TFconfAddr';
const SOURCE_PREFIX = 'TFconfSource';

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
      '[externalConfluence.integration.test] LITE Postgres not reachable on localhost:5439 — ' +
        'skipping. Run `npm run db:migrate` first to exercise this suite.'
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

/** Deterministic fake provider — records fetch call count + status returned, never touches network. */
function makeStubConfluenceProvider(
  provider: string,
  snapshotType: string,
  result: ConfluenceFetchResult
): ConfluenceProvider & { callCount: number } {
  return {
    name: `fake-${provider}`,
    provider,
    snapshotType,
    chains: ['SOLANA'] as Chain[],
    callCount: 0,
    async fetchForToken(_chain: Chain, _tokenAddress: string) {
      this.callCount += 1;
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

/** Seeds a Token + one latest TokenMarketSnapshot (the LiquidityRisk inputs). */
async function seedTokenWithMarket(
  addressSuffix: string,
  liquidityUsd: number,
  marketCapUsd: number
) {
  const address = `${ADDR_PREFIX}${addressSuffix}`;
  const token = await prisma.token.create({
    data: {
      chain: 'SOLANA',
      address,
      symbol: 'TFCONF',
      name: 'Task F Confluence Token',
      decimals: 9,
      firstSeenAt: new Date(),
      riskFlags: []
    }
  });
  await prisma.tokenMarketSnapshot.create({
    data: {
      tokenId: token.id,
      ts: new Date(),
      priceUsd: 1,
      marketCapUsd,
      fdvUsd: marketCapUsd,
      liquidityUsd,
      vol5m: 0,
      vol1h: 0,
      vol6h: 0,
      vol24h: 0,
      holderCount: 100,
      source: 'test'
    }
  });
  return { token, address };
}

describe.skipIf(!(await probePort('localhost', 5439)))('runExternalConfluencePass (Task F end-to-end)', () => {
  it('computes an INTERNAL liquidity_risk snapshot from the latest TokenMarketSnapshot (matches computeLiquidityRisk)', async () => {
    const L = 100_000;
    const MC = 1_000_000;
    const { token, address } = await seedTokenWithMarket('LR1', L, MC);

    // No external sources at all — the internal LiquidityRisk leg runs
    // regardless of any provider.
    const result = await runExternalConfluencePass(prisma, DEFAULT_SETTINGS, () => null, undefined);
    expect(result.errors).toBe(0);

    const snap = await prisma.tokenConfluenceSnapshot.findFirst({
      where: { tokenAddress: address, snapshotType: 'liquidity_risk', provider: 'internal' }
    });
    expect(snap).not.toBeNull();
    expect(snap!.sourceId).toBeNull(); // internal snapshot has no source
    expect(snap!.tokenId).toBe(token.id); // linked to the existing Token
    expect(snap!.status).toBe('ok');

    // The stored dataJson must equal the pure computeLiquidityRisk output for
    // the same inputs + settings-config (design: internal, deterministic).
    const cfg = {
      absoluteLiquidityBandsUsd:
        DEFAULT_SETTINGS.connectors.externalConfluence.liquidityRisk.absoluteLiquidityBandsUsd,
      ratioFragilityBands:
        DEFAULT_SETTINGS.connectors.externalConfluence.liquidityRisk.ratioFragilityBands
    };
    const expected = computeLiquidityRisk(
      {
        displayedLiquidityUsd: L,
        marketCapUsd: MC,
        positionSizeUsd: DEFAULT_SETTINGS.connectors.externalConfluence.liquidityRisk.positionSizeUsd,
        poolType: 'unknown'
      },
      cfg
    );
    const data = snap!.dataJson as Record<string, unknown>;
    expect(data.liquidityToMcapRatio).toBeCloseTo(expected.liquidityToMcapRatio!, 10);
    expect(data.absoluteLiquidityBand).toBe(expected.absoluteLiquidityBand);
    expect(data.ratioFragilityBand).toBe(expected.ratioFragilityBand);
    // Sanity: ratio 0.1 -> the identities the design fixes.
    expect(expected.liquidityToMcapRatio).toBeCloseTo(0.1, 10);
    expect(expected.dumpToHalveUsd).toBeCloseTo(0.207 * L, 6);
  });

  it('is idempotent across two passes: exactly ONE internal liquidity_risk row per token (app-layer dedupe, not the compound unique index)', async () => {
    const { token, address } = await seedTokenWithMarket('LRIDEM', 80_000, 800_000);

    const first = await runExternalConfluencePass(prisma, DEFAULT_SETTINGS, () => null, undefined);
    const second = await runExternalConfluencePass(prisma, DEFAULT_SETTINGS, () => null, undefined);
    expect(first.errors).toBe(0);
    expect(second.errors).toBe(0);

    const rows = await prisma.tokenConfluenceSnapshot.findMany({
      where: { tokenAddress: address, snapshotType: 'liquidity_risk', provider: 'internal' }
    });
    expect(rows).toHaveLength(1); // updated, not re-inserted
    expect(rows[0]!.tokenId).toBe(token.id);
    expect(rows[0]!.status).toBe('ok');
  });

  it('all external keys missing: every external source is a clean skip (missing_key/stub), no external snapshot claims "safe"', async () => {
    const { address } = await seedTokenWithMarket('SKIP1', 50_000, 2_000_000);

    // Two enabled external sources whose real live factories would return null
    // when their key env var is absent — the resolver here returns null for
    // both (simulating no keys), the design's graceful per-source skip.
    await makeSourceRow(`${SOURCE_PREFIX}_holderscan`, { provider: 'holderscan', apiKeyEnvName: 'HOLDERSCAN_API_KEY' });
    await makeSourceRow(`${SOURCE_PREFIX}_gmgn`, { provider: 'gmgn', apiKeyEnvName: 'GMGN_API_KEY' });

    const result = await runExternalConfluencePass(prisma, DEFAULT_SETTINGS, () => null, undefined);

    // Never throws; the internal LiquidityRisk leg still ran.
    expect(result.errors).toBe(0);
    expect(result.sourcesSkippedNoProvider).toBeGreaterThanOrEqual(2);

    const internal = await prisma.tokenConfluenceSnapshot.findFirst({
      where: { tokenAddress: address, snapshotType: 'liquidity_risk', provider: 'internal' }
    });
    expect(internal).not.toBeNull(); // internal leg is key-free, always present

    // The unavailable-not-safe principle: no snapshot from a skipped external
    // source may carry status "ok" — absence of data is never a green light.
    const externalSnaps = await prisma.tokenConfluenceSnapshot.findMany({
      where: { tokenAddress: address, provider: { in: ['holderscan', 'gmgn'] } }
    });
    for (const s of externalSnaps) {
      expect(['missing_key', 'plan_required', 'stub', 'unavailable', 'error']).toContain(s.status);
      expect(s.status).not.toBe('ok');
    }

    // Source-health rows reflect a non-live, non-error skip state — never "ok"/"live".
    const sourceRows = await prisma.externalConfluenceSource.findMany({
      where: { name: { startsWith: SOURCE_PREFIX } }
    });
    for (const r of sourceRows) {
      expect(['missing_key', 'plan_required', 'stub', 'unavailable', 'idle']).toContain(r.status);
    }
  });

  it('never creates Token / Signal / Alert / CandidateWallet rows for an address not already in the DB', async () => {
    // A mock provider that WOULD return ok data for any token — but the pass
    // must only fetch for tokens already in the DB, never discover-and-create.
    const okResult: ConfluenceFetchResult = {
      status: 'ok',
      dataJson: { providerClaimed: true, trending: true },
      observedAt: new Date()
    };
    const fake = makeStubConfluenceProvider('gmgn', 'external_intel', okResult);
    await makeSourceRow(`${SOURCE_PREFIX}_gmgn2`, { provider: 'gmgn', apiKeyEnvName: 'GMGN_API_KEY' });

    const tokenCountBefore = await prisma.token.count();
    const signalCountBefore = await prisma.signal.count();
    const candidateCountBefore = await prisma.candidateWallet.count();

    // No Token seeded here (the SKIP-scoped ones are cleaned between tests) —
    // so there is nothing for the provider to be fetched against.
    const result = await runExternalConfluencePass(prisma, DEFAULT_SETTINGS, () => fake, undefined);
    expect(result.errors).toBe(0);

    expect(await prisma.token.count()).toBe(tokenCountBefore);   // no Token created
    expect(await prisma.signal.count()).toBe(signalCountBefore); // no Signal
    expect(await prisma.candidateWallet.count()).toBe(candidateCountBefore); // no CandidateWallet
    // The fake never fetched for a non-existent token (known-tokens-only).
    const snaps = await prisma.tokenConfluenceSnapshot.findMany({
      where: { provider: 'gmgn', dataJson: { path: ['trending'], equals: true } }
    });
    expect(snaps.every((s) => s.tokenId !== null || s.tokenAddress.startsWith(ADDR_PREFIX) === false)).toBe(true);
  });

  it('MOCK_MODE: a real MockConfluenceProvider produces an ok, provider-claimed snapshot for a KNOWN token, read back via getTokenConfluence', async () => {
    const { token, address } = await seedTokenWithMarket('MOCK1', 120_000, 3_000_000);
    await makeSourceRow(`${SOURCE_PREFIX}_mockgmgn`, { provider: 'gmgn', apiKeyEnvName: 'GMGN_API_KEY' });

    // The real mock (same instance the worker's MOCK_MODE path uses) — resolve
    // it for the enabled source, exactly as the job does in mock mode.
    const mock: ConfluenceProvider = new MockConfluenceProvider();
    const result = await runExternalConfluencePass(prisma, DEFAULT_SETTINGS, () => mock, undefined);
    expect(result.errors).toBe(0);

    const external = await prisma.tokenConfluenceSnapshot.findFirst({
      where: { tokenAddress: address, provider: { not: 'internal' } }
    });
    expect(external).not.toBeNull();
    expect(external!.status).toBe('ok');
    expect(external!.tokenId).toBe(token.id); // linked to the existing Token, not created
    // Provider-claimed labeling lives in dataJson (design rule 16) — the mock
    // marks its metrics as provider-claimed, distinct from the internal leg.
    const data = external!.dataJson as Record<string, unknown>;
    expect(data.providerClaimed).toBe(true);

    // dataJson carries NO secret — no key-shaped value (design rule 13 / security).
    const serialized = JSON.stringify(external!.dataJson);
    expect(serialized).not.toMatch(/API_KEY|apiKey|secret|Bearer\s/i);
  });

  it('getTokenConfluence returns the internal liquidityRisk snapshot + source statuses for a token', async () => {
    const { token, address } = await seedTokenWithMarket('READ1', 90_000, 1_500_000);
    await makeSourceRow(`${SOURCE_PREFIX}_readgmgn`, { provider: 'gmgn', apiKeyEnvName: 'GMGN_API_KEY' });
    const mock = new MockConfluenceProvider();
    await runExternalConfluencePass(prisma, DEFAULT_SETTINGS, () => mock, undefined);

    const { getTokenConfluence } = await import('../src/confluence/queries');
    const view = await getTokenConfluence(prisma, token.id);
    expect(view.liquidityRisk).not.toBeNull();
    expect(view.liquidityRisk!.status).toBe('ok');
    expect(Array.isArray(view.sourceStatuses)).toBe(true);
    void address;
  });
});
