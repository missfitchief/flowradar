// FlowRadar — ExternalConfluenceSource + TokenConfluenceSnapshot schema-behavior
// integration tests (External Confluence, Task B). Same LITE-Postgres pattern as
// socialSchema.test.ts (prefix-cleanup, describe.skipIf when embedded Postgres is
// not reachable on 5439). Proves the guarantees later tasks depend on:
//   - [sourceId, tokenAddress, snapshotType, dedupeKey] idempotent upsert
//   - the unique key is scoped per-sourceId (and works with sourceId=null internal rows)
//   - a nullable tokenId link (unlinked snapshot for a not-yet-known token)
//   - ON DELETE SET NULL: deleting the Token nulls the snapshot's tokenId (never deletes it)
//   - unavailable/stub/plan_required/missing_key statuses persist verbatim (unavailable != safe)
//   - the four documented @@index() entries exist (pg_indexes)
//   - readback via the Token.confluenceSnapshots back-relation

import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import net from 'node:net';
import { prisma } from '../src/client';

const SOURCE_PREFIX = 'TBconfSource';
const TOKEN_PREFIX = 'TBconfToken';

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
      '[confluenceSchema.test] LITE Postgres not reachable on localhost:5439 — skipping ' +
        'integration tests. Run `npm run db:migrate` first to exercise this suite.'
    );
  }
});

async function cleanup() {
  // Null-safe prefix cleanup: snapshots may be unlinked (tokenId null) or internal
  // (sourceId null), so delete by tokenAddress prefix which is always set, then by
  // source-name prefix, then the tokens themselves.
  await prisma.tokenConfluenceSnapshot.deleteMany({ where: { tokenAddress: { startsWith: TOKEN_PREFIX } } });
  await prisma.tokenConfluenceSnapshot.deleteMany({ where: { source: { name: { startsWith: SOURCE_PREFIX } } } });
  await prisma.externalConfluenceSource.deleteMany({ where: { name: { startsWith: SOURCE_PREFIX } } });
  await prisma.token.deleteMany({ where: { address: { startsWith: TOKEN_PREFIX } } });
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

async function makeSource(
  name: string,
  overrides: Partial<Parameters<typeof prisma.externalConfluenceSource.create>[0]['data']> = {}
) {
  return prisma.externalConfluenceSource.create({
    data: {
      name,
      provider: 'holderscan',
      apiKeyEnvName: 'HOLDERSCAN_API_KEY',
      ...overrides
    }
  });
}

async function makeToken(addressSuffix: string) {
  return prisma.token.create({
    data: {
      chain: 'SOLANA',
      address: `${TOKEN_PREFIX}_${addressSuffix}`,
      symbol: 'NOVA',
      name: 'Nova',
      decimals: 9,
      firstSeenAt: new Date(),
      riskFlags: []
    }
  });
}

/** Deterministic snapshot payload for a given source + snapshotType + dedupeKey. */
function snapshotData(
  over: Partial<Parameters<typeof prisma.tokenConfluenceSnapshot.create>[0]['data']> & {
    sourceId?: string | null;
    tokenAddress: string;
    snapshotType: string;
    dedupeKey: string;
  }
) {
  return {
    chain: 'SOLANA' as const,
    provider: 'holderscan',
    status: 'ok',
    dataJson: { providerClaimed: true },
    observedAt: new Date('2026-07-08T00:00:00.000Z'),
    ...over
  };
}

describe.skipIf(!(await probePort('localhost', 5439)))(
  'ExternalConfluenceSource + TokenConfluenceSnapshot schema',
  () => {
    it('applies documented column defaults on ExternalConfluenceSource', async () => {
      const source = await makeSource(`${SOURCE_PREFIX}_defaults`);
      expect(source.enabled).toBe(true);
      expect(source.rateLimitPerMinute).toBe(30);
      expect(source.status).toBe('idle');
      expect(source.failCount).toBe(0);
      expect(source.addedAt).toBeInstanceOf(Date);
      expect(source.lastSyncAt).toBeNull();
      expect(source.lastError).toBeNull();
      // apiKeyEnvName holds a NAME, never a value — sanity-check the seeded name.
      expect(source.apiKeyEnvName).toBe('HOLDERSCAN_API_KEY');
    });

    it('applies TokenConfluenceSnapshot defaults (ingestedAt now, nullable link fields)', async () => {
      const source = await makeSource(`${SOURCE_PREFIX}_snapdefaults`);
      const snap = await prisma.tokenConfluenceSnapshot.create({
        data: snapshotData({
          sourceId: source.id,
          tokenAddress: `${TOKEN_PREFIX}_defaults`,
          snapshotType: 'holder_risk',
          dedupeKey: 'holderscan:holder_risk:' + TOKEN_PREFIX + '_defaults:2026070800'
        })
      });
      expect(snap.ingestedAt).toBeInstanceOf(Date);
      expect(snap.tokenId).toBeNull();
      expect(snap.metadataJson).toBeNull();
      expect(snap.status).toBe('ok');
    });

    it('[sourceId, tokenAddress, snapshotType, dedupeKey] upsert is idempotent — re-upsert yields exactly 1 row', async () => {
      const source = await makeSource(`${SOURCE_PREFIX}_idem`);
      const tokenAddress = `${TOKEN_PREFIX}_idem`;
      const dedupeKey = 'holderscan:holder_risk:' + tokenAddress + ':2026070800';
      const where = {
        sourceId_tokenAddress_snapshotType_dedupeKey: {
          sourceId: source.id,
          tokenAddress,
          snapshotType: 'holder_risk',
          dedupeKey
        }
      };

      await prisma.tokenConfluenceSnapshot.upsert({
        where,
        create: snapshotData({ sourceId: source.id, tokenAddress, snapshotType: 'holder_risk', dedupeKey }),
        update: {}
      });
      // Second upsert of the SAME key with a different status/dataJson must UPDATE, never insert.
      const second = await prisma.tokenConfluenceSnapshot.upsert({
        where,
        create: snapshotData({ sourceId: source.id, tokenAddress, snapshotType: 'holder_risk', dedupeKey }),
        update: { status: 'plan_required', dataJson: { note: 'quota exhausted' } }
      });

      const rows = await prisma.tokenConfluenceSnapshot.findMany({
        where: { sourceId: source.id, tokenAddress, snapshotType: 'holder_risk', dedupeKey }
      });
      expect(rows).toHaveLength(1);
      expect(second.status).toBe('plan_required');
      expect(second.dataJson).toEqual({ note: 'quota exhausted' });
    });

    it('same (tokenAddress, snapshotType, dedupeKey) under a DIFFERENT sourceId is a distinct row', async () => {
      const s1 = await makeSource(`${SOURCE_PREFIX}_scopeA`);
      const s2 = await makeSource(`${SOURCE_PREFIX}_scopeB`, { provider: 'gmgn', apiKeyEnvName: 'GMGN_API_KEY' });
      const tokenAddress = `${TOKEN_PREFIX}_scope`;
      const dedupeKey = 'x:external_intel:' + tokenAddress + ':2026070800';
      await prisma.tokenConfluenceSnapshot.create({
        data: snapshotData({ sourceId: s1.id, tokenAddress, snapshotType: 'external_intel', dedupeKey, provider: 'holderscan' })
      });
      await prisma.tokenConfluenceSnapshot.create({
        data: snapshotData({ sourceId: s2.id, tokenAddress, snapshotType: 'external_intel', dedupeKey, provider: 'gmgn' })
      });

      const all = await prisma.tokenConfluenceSnapshot.findMany({ where: { tokenAddress, dedupeKey } });
      expect(all).toHaveLength(2);
    });

    it('stores the INTERNAL LiquidityRisk snapshot with sourceId=null AND demonstrates the composite unique does NOT dedupe sourceId=null rows (Task D must dedupe internal snapshots at the app layer)', async () => {
      const tokenAddress = `${TOKEN_PREFIX}_internal`;
      const dedupeKey = 'internal:liquidity_risk:' + tokenAddress + ':2026070800';
      const internal = await prisma.tokenConfluenceSnapshot.create({
        data: snapshotData({
          sourceId: null,
          tokenAddress,
          snapshotType: 'liquidity_risk',
          provider: 'internal',
          dedupeKey,
          dataJson: { liquidityToMcapRatio: 0.03, ratioFragilityBand: 'fragile', confidence: 'high' }
        })
      });
      expect(internal.sourceId).toBeNull();
      expect(internal.provider).toBe('internal');
      expect(internal.snapshotType).toBe('liquidity_risk');
      // KNOWN GAP (documented, not fixed by this task): standard Postgres unique
      // btree indexes treat NULL as distinct from NULL (ANSI SQL semantics), so
      // @@unique([sourceId, tokenAddress, snapshotType, dedupeKey]) does NOT
      // dedupe rows where sourceId is null, even when the other three columns
      // are identical. A second create with the exact same internal key
      // therefore SUCCEEDS (inserts a second row) rather than throwing —
      // verified directly against a scratch table on this same Postgres
      // instance. Internal (sourceId=null) dedup, if ever required, needs a
      // partial unique index (`WHERE "sourceId" IS NULL`) or an app-layer
      // findFirst-then-upsert — deliberately NOT introduced here since the
      // brief prescribes this exact schema verbatim and no later task
      // (C/D/E) has been told to expect a different constraint shape.
      // Task D implementers: do NOT rely on the composite unique for
      // idempotent upserts of internal snapshots; scope by sourceId only
      // when sourceId is present, and use an explicit findFirst + create/update
      // (not upsert-by-composite-key) when sourceId is null.
      const secondInternal = await prisma.tokenConfluenceSnapshot.create({
        data: snapshotData({ sourceId: null, tokenAddress, snapshotType: 'liquidity_risk', provider: 'internal', dedupeKey })
      });
      expect(secondInternal.sourceId).toBeNull();
      const internalRows = await prisma.tokenConfluenceSnapshot.findMany({
        where: { sourceId: null, tokenAddress, snapshotType: 'liquidity_risk', dedupeKey }
      });
      // Two rows, NOT deduped — this is the documented NULL-uniqueness gap.
      expect(internalRows).toHaveLength(2);
    });

    it('unlinked snapshot: a missing token yields tokenId=null and persists cleanly (external providers never create Token rows)', async () => {
      const source = await makeSource(`${SOURCE_PREFIX}_unlinked`);
      const tokenAddress = `${TOKEN_PREFIX}_ghost`;
      const unlinked = await prisma.tokenConfluenceSnapshot.create({
        data: snapshotData({
          sourceId: source.id,
          tokenAddress,
          snapshotType: 'external_intel',
          provider: 'gmgn',
          dedupeKey: 'gmgn:external_intel:' + tokenAddress + ':2026070800',
          tokenId: null
        })
      });
      expect(unlinked.tokenId).toBeNull();

      const readBack = await prisma.tokenConfluenceSnapshot.findUnique({
        where: { id: unlinked.id },
        include: { token: true }
      });
      expect(readBack!.token).toBeNull();
      // And the token was NOT created as a side effect.
      const token = await prisma.token.findUnique({ where: { chain_address: { chain: 'SOLANA', address: tokenAddress } } });
      expect(token).toBeNull();
    });

    it('links a snapshot to a Token and reads it back via Token.confluenceSnapshots back-relation', async () => {
      const source = await makeSource(`${SOURCE_PREFIX}_linked`);
      const token = await makeToken('linked');
      const tokenAddress = token.address;
      const linked = await prisma.tokenConfluenceSnapshot.create({
        data: snapshotData({
          sourceId: source.id,
          tokenAddress,
          snapshotType: 'holder_risk',
          dedupeKey: 'holderscan:holder_risk:' + tokenAddress + ':2026070800',
          tokenId: token.id
        })
      });
      expect(linked.tokenId).toBe(token.id);

      const tokenWithSnaps = await prisma.token.findUnique({
        where: { id: token.id },
        include: { confluenceSnapshots: true }
      });
      expect(tokenWithSnaps!.confluenceSnapshots).toHaveLength(1);
      expect(tokenWithSnaps!.confluenceSnapshots[0]!.snapshotType).toBe('holder_risk');
    });

    it('ON DELETE SET NULL: deleting the linked Token nulls the snapshot tokenId (snapshot survives)', async () => {
      const source = await makeSource(`${SOURCE_PREFIX}_setnull`);
      const token = await makeToken('setnull');
      const tokenAddress = token.address;
      const snap = await prisma.tokenConfluenceSnapshot.create({
        data: snapshotData({
          sourceId: source.id,
          tokenAddress,
          snapshotType: 'liquidity_map',
          provider: 'clobr',
          dedupeKey: 'clobr:liquidity_map:' + tokenAddress + ':2026070800',
          tokenId: token.id
        })
      });

      await prisma.token.delete({ where: { id: token.id } });

      const after = await prisma.tokenConfluenceSnapshot.findUnique({ where: { id: snap.id } });
      expect(after).not.toBeNull();
      expect(after!.tokenId).toBeNull();
      // tokenAddress is retained so the row is still keyed to the (chain,address) pair.
      expect(after!.tokenAddress).toBe(tokenAddress);
    });

    it('unavailable != safe: a provider that could not return data persists status="unavailable" verbatim, no coercion', async () => {
      const source = await makeSource(`${SOURCE_PREFIX}_unavail`);
      const tokenAddress = `${TOKEN_PREFIX}_unavail`;
      const snap = await prisma.tokenConfluenceSnapshot.create({
        data: snapshotData({
          sourceId: source.id,
          tokenAddress,
          snapshotType: 'external_intel',
          provider: 'gmgn',
          status: 'unavailable',
          dataJson: {},
          dedupeKey: 'gmgn:external_intel:' + tokenAddress + ':2026070800'
        })
      });
      const readBack = await prisma.tokenConfluenceSnapshot.findUnique({ where: { id: snap.id } });
      expect(readBack!.status).toBe('unavailable');
      expect(readBack!.status).not.toBe('ok');
      expect(readBack!.dataJson).toEqual({});
    });

    it('persists every honest degraded status (missing_key, plan_required, rate_limited, stub, error) unchanged', async () => {
      const source = await makeSource(`${SOURCE_PREFIX}_statuses`);
      const statuses = ['missing_key', 'plan_required', 'rate_limited', 'stub', 'error'] as const;
      for (const status of statuses) {
        const tokenAddress = `${TOKEN_PREFIX}_st_${status}`;
        const snap = await prisma.tokenConfluenceSnapshot.create({
          data: snapshotData({
            sourceId: source.id,
            tokenAddress,
            snapshotType: 'holder_risk',
            status,
            dataJson: {},
            dedupeKey: 'holderscan:holder_risk:' + tokenAddress + ':2026070800'
          })
        });
        expect(snap.status).toBe(status);
      }
    });

    it('paper_trade snapshotType is a valid value on TokenConfluenceSnapshot (no separate PaperTradeObservation table)', async () => {
      const tokenAddress = `${TOKEN_PREFIX}_paper`;
      const snap = await prisma.tokenConfluenceSnapshot.create({
        data: snapshotData({
          sourceId: null,
          tokenAddress,
          snapshotType: 'paper_trade',
          provider: 'manual',
          status: 'stub',
          dataJson: { note: 'manual CSV import only; stub for now' },
          dedupeKey: 'manual:paper_trade:' + tokenAddress + ':2026070800'
        })
      });
      expect(snap.snapshotType).toBe('paper_trade');
    });

    it('all four documented indexes exist on token_confluence_snapshots', async () => {
      const rows = await prisma.$queryRawUnsafe<{ indexdef: string }[]>(
        `SELECT indexdef FROM pg_indexes WHERE tablename = 'token_confluence_snapshots'`
      );
      const defs = rows.map((r) => r.indexdef).join('\n');
      // @@index([tokenId])
      expect(defs).toMatch(/\("?tokenId"?\)/);
      // @@index([chain, tokenAddress])
      expect(defs).toMatch(/\("?chain"?, "?tokenAddress"?\)/);
      // @@index([provider, snapshotType])
      expect(defs).toMatch(/\("?provider"?, "?snapshotType"?\)/);
      // @@index([observedAt])
      expect(defs).toMatch(/\("?observedAt"?\)/);
    });
  }
);
