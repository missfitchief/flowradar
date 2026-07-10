// FlowRadar — lineageExpansion job (Capital Lineage 6b).
//
// Thin wrapper around @flowradar/db's runLineageExpansion — the bounded
// frontier-consuming expansion engine lives there (same worker/DB-sharing
// pattern as every other job in this directory). Registered on
// settings.intervals — reuses walletActivitySec cadence class since it drives
// the same Helius wallet-transaction provider under the same rate budget.
//
// The provider resolves to the live Helius walletActivity adapter (or its
// mock in MOCK_MODE); a resolution failure is caught and the pass no-ops for
// that run (runLineageExpansion also isolates per-node provider errors).
// runLineageExpansion holds the global job lock for the whole pass, so this
// never interleaves with seed / import / reset.

import { runLineageExpansion, type LineageProvider } from '@flowradar/db';
import type { JobContext } from '../context';

// Bounded per-pass work: keep a single scheduled tick short so the worker's
// other jobs keep cycling. The frontier persists across passes, so expansion
// makes incremental progress each tick rather than one unbounded sweep.
const MAX_NODES_PER_PASS = 25;

export async function run(ctx: JobContext): Promise<void> {
  const { prisma, settings, providers, log } = ctx;

  let provider: LineageProvider;
  try {
    provider = providers('SOLANA', 'walletActivity') as unknown as LineageProvider;
  } catch (err) {
    log?.info('lineageExpansion: no Solana wallet-activity provider — skipping pass', {
      error: err instanceof Error ? err.message : String(err)
    });
    return;
  }

  const result = await runLineageExpansion(prisma, provider, settings, { maxNodesPerPass: MAX_NODES_PER_PASS });
  log?.info('lineageExpansion pass complete', { ...result, stopReasons: JSON.stringify(result.stopReasons) });
}
