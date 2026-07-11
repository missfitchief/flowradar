// FlowRadar — worker-side risk-cache construction (Task 1, Helius 429 fix).
//
// Builds a TokenRiskCache bound to the job's prisma + provider resolver. The
// cache's persistent layer is the shared TokenRiskSnapshot table, so a fresh
// instance per job invocation still shares warm data across flowScoring,
// entityClustering, and the bounded tokenRiskRefresh job (the in-flight dedup
// map is per-instance and only needs to collapse concurrent calls WITHIN a
// single pass). The resolved 'risk' provider is the ONLY thing that calls
// Helius — everything else reads the cache.

import { TokenRiskCache } from '@flowradar/db';
import type { JobContext } from './context';

export function buildRiskCache(ctx: JobContext): TokenRiskCache {
  return new TokenRiskCache({
    prisma: ctx.prisma,
    resolveFetcher: (chain) => ctx.providers(chain, 'risk'),
    // The cold-start inline warm cap reuses the bounded refresh batch size, so a
    // scoring pass over a freshly-migrated universe issues at most this many
    // inline provider calls before degrading to pure cache reads.
    config: { maxInlineRefreshesPerPass: ctx.settings.intervals.tokenRiskRefreshBatch },
    log: { info: ctx.log.info, error: ctx.log.error }
  });
}
