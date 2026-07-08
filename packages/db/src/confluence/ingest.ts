// FlowRadar — runExternalConfluencePass: the External Confluence ingest body
// (Task D). Same worker/seed-sharing pattern as runSocialIngestPass /
// runExternalWalletSourceSync — apps/worker/src/jobs/externalConfluence.ts is
// a thin wrapper around this function, and seed.ts calls it directly.
//
// SHADOW-ONLY (design doc global rules 1-16). Two legs, both write ONLY
// TokenConfluenceSnapshot rows:
//   (1) INTERNAL LiquidityRisk: for every Token that has a latest
//       TokenMarketSnapshot (liquidityUsd + marketCapUsd), compute
//       computeLiquidityRisk() and upsert one provider="internal",
//       snapshotType="liquidity_risk", sourceId=null snapshot. No provider,
//       no key, deterministic.
//   (2) EXTERNAL providers: for each ENABLED ExternalConfluenceSource, resolve
//       a ConfluenceProvider (mock / live factory / null => skip). Fetch ONLY
//       for tokens ALREADY IN THE DB — never discover-and-create a Token. The
//       returned ConfluenceFetchResult.status (ok | unavailable | missing_key
//       | plan_required | rate_limited | error | stub) is stored VERBATIM on
//       the snapshot; absence of data is stored as its honest status, NEVER as
//       a fabricated "ok"/"safe" (global rule 15). dataJson is stored as-is
//       (Task C guarantees it is secret-free; this pass adds no secrets).
//
// HARD CONSTRAINTS this body enforces:
//   - NEVER creates Token/Signal/Alert/CandidateWallet rows (only reads Token,
//     only writes TokenConfluenceSnapshot).
//   - NEVER touches FlowScore / signal thresholds / wallet scoring.
//   - Per-SOURCE try/catch: a source's resolve/fetch throwing marks THAT
//     source status='error'/lastError/failCount++ and continues the pass.
//   - Per-TOKEN try/catch inside a source: one token's fetch throwing is
//     logged + counted and NEVER aborts sibling tokens (nor marks the source
//     'error' — the source itself resolved fine).
//   - missing_key / plan_required / stub / unavailable are CLEAN skips at the
//     result level AND recorded: the source's own status is updated to that
//     value, and (for every targeted known token) a snapshot carrying that
//     status is upserted.
//
// NULL-DEDUPE NOTE (Task D empirical finding, see Task B's report for the
// original flag): the schema's `@@unique([sourceId, tokenAddress,
// snapshotType, dedupeKey])` does NOT dedupe rows where sourceId IS NULL —
// Postgres (like standard SQL) treats NULL as distinct from NULL in a unique
// btree index, composite or not. This affects ONLY the INTERNAL leg (the only
// place sourceId is null by design — every external leg row has a real
// sourceId, where the compound-unique upsert works perfectly). Verified
// against THIS generated client (node_modules/.prisma/client/index.d.ts,
// TokenConfluenceSnapshotSourceIdTokenAddressSnapshotTypeDedupeKeyCompound-
// UniqueInput): the compound-unique input type requires `sourceId: string`
// (NOT `string | null`), so an upsert whose compound `where` includes
// `sourceId: null` does not even type-check — and even if it did, the
// underlying Postgres index cannot match NULL rows (Task B's probe-table
// proof), so the upsert would insert duplicates instead of updating. The
// internal leg
// therefore uses the explicit `findFirst` (by the plain, non-compound
// `{ sourceId: null, tokenAddress, snapshotType, dedupeKey }` where) +
// `create`/`update`-by-id fallback described in the brief's Step 8 NOTE,
// rather than `upsert` on the compound key. The external leg (sourceId always
// a real id) uses `prisma.tokenConfluenceSnapshot.upsert` on the compound key
// directly, since it is never null there.

import type { Prisma, PrismaClient } from '@prisma/client';
import type { Chain, Settings } from '@flowradar/core';
import { computeLiquidityRisk } from '@flowradar/core';
import type { ConfluenceProvider } from '@flowradar/providers';

export interface ConfluenceIngestLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/** Row shape this module needs from ExternalConfluenceSource — narrower than the full Prisma model. */
export interface ExternalConfluenceSourceRow {
  id: string;
  name: string;
  provider: string;
  enabled: boolean;
  apiKeyEnvName: string | null;
}

/**
 * Resolves a ConfluenceProvider for a given ExternalConfluenceSource row.
 * Returns null/undefined (OR throws) to signal "no reader for this source" —
 * all handled gracefully (mirrors SocialSourceResolver). The CALLER decides
 * mock-vs-live-vs-null: MOCK_MODE => shared MockConfluenceProvider for every
 * source; live => per-provider factory (null when the apiKeyEnvName env value
 * is absent, i.e. missing_key/stub/plan_required). A null return is a clean
 * per-source skip, never a crash.
 */
export type ConfluenceSourceResolver = (
  source: ExternalConfluenceSourceRow
) => ConfluenceProvider | null | undefined;

export interface ExternalConfluencePassResult {
  sourcesConsidered: number;
  sourcesSynced: number;
  sourcesSkippedDisabled: number;
  sourcesSkippedNoProvider: number;
  internalLiquiditySnapshots: number;
  externalSnapshotsUpserted: number;
  tokensConsidered: number;
  errors: number;
}

const VALID_CHAINS: Chain[] = ['SOLANA', 'BSC'];

/** Hour bucket for dedupeKey — one snapshot per (provider,type,address) per wall-clock hour (idempotent re-runs inside the hour). */
function hourBucket(d: Date): string {
  return `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}-${d.getUTCHours()}`;
}

/** dedupeKey per design doc: `${provider}:${snapshotType}:${tokenAddress}:${observedHourBucket}`. */
function buildDedupeKey(provider: string, snapshotType: string, tokenAddress: string, observedAt: Date): string {
  return `${provider}:${snapshotType}:${tokenAddress}:${hourBucket(observedAt)}`;
}

/** All Tokens that have >=1 TokenMarketSnapshot, each paired with its LATEST snapshot's liquidity/mcap. */
interface KnownToken {
  tokenId: string;
  chain: Chain;
  address: string;
}

export async function runExternalConfluencePass(
  prisma: PrismaClient,
  settings: Settings,
  resolveProvider: ConfluenceSourceResolver,
  log?: ConfluenceIngestLogger
): Promise<ExternalConfluencePassResult> {
  const cfg = settings.connectors.externalConfluence.liquidityRisk;

  let internalLiquiditySnapshots = 0;
  let externalSnapshotsUpserted = 0;
  let sourcesSynced = 0;
  let sourcesSkippedDisabled = 0;
  let sourcesSkippedNoProvider = 0;
  let errors = 0;

  // Known tokens = every Token row. External providers fetch ONLY for these
  // (never discover-and-create). LiquidityRisk runs for the subset that has a
  // latest TokenMarketSnapshot.
  const tokens = await prisma.token.findMany({ select: { id: true, chain: true, address: true } });
  const knownTokens: KnownToken[] = tokens.map((t) => ({ tokenId: t.id, chain: t.chain as Chain, address: t.address }));

  // -----------------------------------------------------------------------
  // Leg 1: INTERNAL LiquidityRisk (no provider, no key). Per-token try/catch
  // so one token's bad market row never aborts the internal leg.
  //
  // sourceId is always null here (see file-header NULL-DEDUPE NOTE) — the
  // compound unique index [sourceId, tokenAddress, snapshotType, dedupeKey]
  // does not dedupe null sourceId rows, and (empirically, against the
  // generated client for this schema) `upsert` on that compound key also
  // rejects `sourceId: null` as an input value. So this leg uses an explicit
  // findFirst-by-plain-where + create/update-by-id, NOT `upsert`.
  // -----------------------------------------------------------------------
  for (const token of knownTokens) {
    try {
      const latest = await prisma.tokenMarketSnapshot.findFirst({
        where: { tokenId: token.tokenId },
        orderBy: [{ ts: 'desc' }, { id: 'desc' }],
        select: { liquidityUsd: true, marketCapUsd: true, ts: true }
      });
      if (!latest) continue; // no market data yet — no internal snapshot (NOT an error)

      const displayedLiquidityUsd = Number(latest.liquidityUsd);
      const marketCapUsd = Number(latest.marketCapUsd);

      const risk = computeLiquidityRisk(
        {
          displayedLiquidityUsd,
          marketCapUsd,
          positionSizeUsd: cfg.positionSizeUsd,
          poolType: 'unknown'
        },
        {
          absoluteLiquidityBandsUsd: cfg.absoluteLiquidityBandsUsd,
          ratioFragilityBands: cfg.ratioFragilityBands
        }
      );

      const observedAt = latest.ts;
      const dataJson = {
        ...risk,
        inputs: { displayedLiquidityUsd, marketCapUsd, positionSizeUsd: cfg.positionSizeUsd },
        computedBy: 'internal',
        providerClaimed: false
      } as unknown as Prisma.InputJsonValue;

      const dedupeKey = buildDedupeKey('internal', 'liquidity_risk', token.address, observedAt);

      // Explicit findFirst-then-create/update — NOT prisma.upsert on the
      // compound key, because sourceId is null here (see NULL-DEDUPE NOTE
      // above). This is the only correct way to dedupe internal rows.
      const existing = await prisma.tokenConfluenceSnapshot.findFirst({
        where: {
          sourceId: null,
          tokenAddress: token.address,
          snapshotType: 'liquidity_risk',
          dedupeKey
        },
        select: { id: true }
      });

      if (existing) {
        await prisma.tokenConfluenceSnapshot.update({
          where: { id: existing.id },
          data: {
            tokenId: token.tokenId,
            status: 'ok',
            dataJson,
            observedAt
          }
        });
      } else {
        await prisma.tokenConfluenceSnapshot.create({
          data: {
            tokenId: token.tokenId,
            chain: token.chain,
            tokenAddress: token.address,
            sourceId: null,
            provider: 'internal',
            snapshotType: 'liquidity_risk',
            status: 'ok',
            dataJson,
            observedAt,
            dedupeKey
          }
        });
      }
      internalLiquiditySnapshots += 1;
    } catch (err) {
      errors += 1;
      const message = err instanceof Error ? err.message : String(err);
      log?.error('externalConfluence: internal LiquidityRisk error (token skipped)', {
        tokenAddress: token.address,
        error: message
      });
    }
  }

  // -----------------------------------------------------------------------
  // Leg 2: EXTERNAL providers. Per-SOURCE try/catch (resolve/fetch throwing
  // marks THAT source 'error' + continue). Inside a synced source, per-TOKEN
  // try/catch (one token throwing never aborts siblings, never marks the
  // source 'error'). Fetch ONLY known tokens on chains the provider supports.
  // -----------------------------------------------------------------------
  const sources = await prisma.externalConfluenceSource.findMany();

  for (const source of sources) {
    if (!source.enabled) {
      sourcesSkippedDisabled += 1;
      log?.info('externalConfluence: source disabled, skipping', { source: source.name });
      continue;
    }

    let provider: ConfluenceProvider | null | undefined;
    try {
      provider = resolveProvider({
        id: source.id,
        name: source.name,
        provider: source.provider,
        enabled: source.enabled,
        apiKeyEnvName: source.apiKeyEnvName
      });
    } catch (err) {
      // Resolver itself threw -> treat as a per-source error (continue pass).
      errors += 1;
      const message = err instanceof Error ? err.message : String(err);
      await prisma.externalConfluenceSource.update({
        where: { id: source.id },
        data: { status: 'error', lastError: message, failCount: { increment: 1 } }
      });
      log?.error(`externalConfluence: resolver error for source ${source.name}`, { source: source.name, error: message });
      continue;
    }

    if (!provider) {
      // Clean per-source skip: no live adapter / missing key at resolve time /
      // manual/stub provider. Recorded as source status (NEVER 'live'), no
      // snapshot fabricated.
      sourcesSkippedNoProvider += 1;
      await prisma.externalConfluenceSource.update({
        where: { id: source.id },
        data: { status: 'missing_key', lastError: null }
      });
      log?.info('externalConfluence: no provider resolved for source, skipping', {
        source: source.name,
        provider: source.provider
      });
      continue;
    }

    const providerChains = new Set<Chain>(provider.chains);
    let sourceStatusForHealth: string = 'live';
    let tokensTargeted = 0;
    let tokensSucceeded = 0;
    let lastTokenErrorMessage: string | null = null;

    try {
      for (const token of knownTokens) {
        if (!VALID_CHAINS.includes(token.chain)) continue;
        if (!providerChains.has(token.chain)) continue;

        tokensTargeted += 1;

        try {
          const fetched = await provider.fetchForToken(token.chain, token.address);
          const observedAt = fetched.observedAt ?? new Date();
          const dedupeKey = buildDedupeKey(source.provider, provider.snapshotType, token.address, observedAt);

          // Store the returned status VERBATIM. Absence of data (missing_key/
          // plan_required/unavailable/stub/rate_limited/error) is recorded as
          // its honest status — NEVER coerced to 'ok'/'safe' (global rule 15).
          await prisma.tokenConfluenceSnapshot.upsert({
            where: {
              sourceId_tokenAddress_snapshotType_dedupeKey: {
                sourceId: source.id,
                tokenAddress: token.address,
                snapshotType: provider.snapshotType,
                dedupeKey
              }
            },
            create: {
              tokenId: token.tokenId,
              chain: token.chain,
              tokenAddress: token.address,
              sourceId: source.id,
              provider: source.provider,
              snapshotType: provider.snapshotType,
              status: fetched.status,
              dataJson: (fetched.dataJson ?? {}) as Prisma.InputJsonValue,
              observedAt,
              dedupeKey
            },
            update: {
              tokenId: token.tokenId,
              status: fetched.status,
              dataJson: (fetched.dataJson ?? {}) as Prisma.InputJsonValue,
              observedAt
            }
          });
          externalSnapshotsUpserted += 1;
          tokensSucceeded += 1;

          // The MOST-degraded status a fetch returned drives the source-health
          // status: any real 'ok' keeps it 'live'; a uniform non-ok status
          // (e.g. every token missing_key) surfaces that at the source level.
          if (fetched.status !== 'ok') {
            sourceStatusForHealth = fetched.status;
          }
        } catch (tokenErr) {
          // Per-token guard: one token's fetch throwing never aborts siblings
          // and never marks the SOURCE 'error' (the source resolved fine) —
          // AS LONG AS at least one sibling token succeeds. If EVERY targeted
          // token for this source fails (the source itself is effectively
          // unreachable/broken, not just flaky on one address), that is
          // treated as a source-level failure below (mirrors a resolve/fetch
          // throw — same "the source resolved fine for its siblings" test
          // this per-token guard exists for doesn't hold when there are no
          // siblings that succeeded).
          errors += 1;
          const message = tokenErr instanceof Error ? tokenErr.message : String(tokenErr);
          lastTokenErrorMessage = message;
          log?.error('externalConfluence: token fetch error (skipped, source continues)', {
            source: source.name,
            tokenAddress: token.address,
            error: message
          });
        }
      }

      if (tokensTargeted > 0 && tokensSucceeded === 0 && lastTokenErrorMessage) {
        // Total failure across every targeted token — surfaced as a
        // source-level error (status='error', lastError, failCount++),
        // same as a resolver/provider-level throw.
        await prisma.externalConfluenceSource.update({
          where: { id: source.id },
          data: { status: 'error', lastError: lastTokenErrorMessage, failCount: { increment: 1 } }
        });
        log?.error(`externalConfluence: every targeted token failed for source ${source.name}`, {
          source: source.name,
          tokensTargeted
        });
        continue;
      }

      await prisma.externalConfluenceSource.update({
        where: { id: source.id },
        data: {
          lastSyncAt: new Date(),
          status: sourceStatusForHealth,
          lastError: null,
          failCount: 0
        }
      });
      sourcesSynced += 1;
      log?.info('externalConfluence: source sync complete', {
        source: source.name,
        status: sourceStatusForHealth
      });
    } catch (err) {
      // Per-source guard: an unexpected throw OUTSIDE the per-token loop
      // (e.g. provider.chains access) marks THIS source 'error' + continues.
      errors += 1;
      const message = err instanceof Error ? err.message : String(err);
      await prisma.externalConfluenceSource.update({
        where: { id: source.id },
        data: { status: 'error', lastError: message, failCount: { increment: 1 } }
      });
      log?.error(`externalConfluence: provider error for source ${source.name}`, { source: source.name, error: message });
    }
  }

  const summary: ExternalConfluencePassResult = {
    sourcesConsidered: sources.length,
    sourcesSynced,
    sourcesSkippedDisabled,
    sourcesSkippedNoProvider,
    internalLiquiditySnapshots,
    externalSnapshotsUpserted,
    tokensConsidered: knownTokens.length,
    errors
  };
  log?.info('externalConfluence cycle complete', { ...summary });
  return summary;
}
