import { prisma } from '@/lib/db';
import { getCandidateSourceStatuses } from '@flowradar/providers';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { SourceHealthTable } from '@/components/sources/SourceHealthTable';
import type { SourceHealthRow, SourceMode } from '@/components/sources/SourceHealthTable';
import { fmtAge } from '@/lib/format';

// DB-backed dashboard — must render per-request, never freeze at build time
// (same invariant every other DB page in this app follows).
export const dynamic = 'force-dynamic';

/**
 * Source Health page (Task 36, Wave 4.5, Spec §5b binding decision 3).
 *
 * Per ExternalWalletSource row: name, type, enabled, a status badge (mode
 * from getCandidateSourceStatuses — mock/live/missing_key/stub), apiKeyEnvName
 * + env-presence (boolean only, value never leaves the server), lastSyncAt
 * age, rateLimitPerMinute, and candidate counts for that source
 * (CandidateWallet groupBy source: found=total, validated=promoted+rejected,
 * promoted, pending, lastError). A source can resolve to multiple
 * (chain, mode) rows from getCandidateSourceStatuses (e.g. birdeye_wallet_pnl
 * covers both SOLANA and BSC) — this page picks the WORST mode across a
 * source's chain rows for its single badge (stub < missing_key < mock < live
 * in "most attention needed" order) so a source that's live on one chain but
 * missing a key on another still surfaces the gap, and joins their notes.
 *
 * Summary cards on top: total candidates / promoted / pending / rejected
 * across ALL sources (a single CandidateWallet groupBy, not per-source).
 */

const MODE_SEVERITY: Record<SourceMode, number> = {
  stub: 0,
  missing_key: 1,
  mock: 2,
  live: 3
};

function worstMode(modes: SourceMode[]): SourceMode {
  return modes.reduce((worst, m) => (MODE_SEVERITY[m] < MODE_SEVERITY[worst] ? m : worst), modes[0]);
}

export default async function SourcesPage() {
  const [sources, candidateGroups] = await Promise.all([
    prisma.externalWalletSource.findMany({ orderBy: { name: 'asc' } }),
    prisma.candidateWallet.groupBy({
      by: ['source', 'validationStatus'],
      _count: { _all: true }
    })
  ]);

  const statuses = getCandidateSourceStatuses();
  const statusesByName = new Map<string, typeof statuses>();
  for (const status of statuses) {
    const list = statusesByName.get(status.sourceName) ?? [];
    list.push(status);
    statusesByName.set(status.sourceName, list);
  }

  // Per-source validationStatus counts (pending/validating/promoted/rejected).
  interface StatusCounts {
    pending: number;
    validating: number;
    promoted: number;
    rejected: number;
  }
  const countsBySource = new Map<string, StatusCounts>();
  for (const group of candidateGroups) {
    const counts = countsBySource.get(group.source) ?? { pending: 0, validating: 0, promoted: 0, rejected: 0 };
    counts[group.validationStatus as keyof StatusCounts] =
      (counts[group.validationStatus as keyof StatusCounts] ?? 0) + group._count._all;
    countsBySource.set(group.source, counts);
  }

  // Cross-source summary totals — a single reduction over the same groupBy
  // result, not a second query.
  const summary = candidateGroups.reduce(
    (acc, group) => {
      acc.total += group._count._all;
      if (group.validationStatus === 'promoted') acc.promoted += group._count._all;
      if (group.validationStatus === 'pending' || group.validationStatus === 'validating') acc.pending += group._count._all;
      if (group.validationStatus === 'rejected') acc.rejected += group._count._all;
      return acc;
    },
    { total: 0, promoted: 0, pending: 0, rejected: 0 }
  );

  const rows: SourceHealthRow[] = sources.map((source) => {
    const sourceStatuses = statusesByName.get(source.name) ?? [];
    const mode: SourceMode = sourceStatuses.length > 0 ? worstMode(sourceStatuses.map((s) => s.mode as SourceMode)) : 'stub';
    const modeNote = sourceStatuses.map((s) => s.note).filter(Boolean).join(' ');
    const counts = countsBySource.get(source.name) ?? { pending: 0, validating: 0, promoted: 0, rejected: 0 };

    return {
      id: source.id,
      name: source.name,
      type: source.type,
      enabled: source.enabled,
      mode,
      modeNote,
      apiKeyEnvName: source.apiKeyEnvName,
      envKeyPresent: Boolean(process.env[source.apiKeyEnvName]),
      // Pre-formatted server-side (see SourceHealthRow.lastSyncAgeLabel's doc
      // comment) — SourceHealthTable is a client component, so computing
      // fmtAge() there directly would hydration-mismatch.
      lastSyncAgeLabel: source.lastSyncAt ? `${fmtAge(source.lastSyncAt)} ago` : 'never',
      rateLimitPerMinute: source.rateLimitPerMinute,
      lastError: source.lastError,
      found: counts.pending + counts.validating + counts.promoted + counts.rejected,
      validated: counts.promoted + counts.rejected,
      promoted: counts.promoted,
      pending: counts.pending + counts.validating
    };
  });

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Source Health</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        External candidate-wallet feeders — enabled state, live/mock/stub status, and candidate counts. Candidates
        never influence signals or counts until promoted (see Wallets).
      </p>

      <div className="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-xs text-muted-foreground">Total candidates</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold tabular-nums">{summary.total}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-xs text-muted-foreground">Promoted</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold tabular-nums text-emerald-400">{summary.promoted}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-xs text-muted-foreground">Pending</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold tabular-nums text-amber-400">{summary.pending}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-xs text-muted-foreground">Rejected</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold tabular-nums text-red-400">{summary.rejected}</div>
          </CardContent>
        </Card>
      </div>

      <div className="mt-6">
        <SourceHealthTable rows={rows} />
      </div>
    </div>
  );
}
