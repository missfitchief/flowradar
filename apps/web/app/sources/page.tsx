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

  // Rescue sprint — honest provider-state annotation: a source can be
  // CONFIGURED (key present, mode 'live') yet blocked by a plan quota. The
  // fetch-state/enrichment tables carry the real recent provider errors, so
  // the badge never claims "live and working" when every call is failing.
  const recencyCutoff = new Date(Date.now() - 7 * 86_400_000);
  const [quotaErrors, enrichErrors] = await Promise.all([
    prisma.topPnlFetchState.count({
      where: {
        status: 'provider_error',
        lastError: { contains: 'usage limit', mode: 'insensitive' },
        updatedAt: { gte: recencyCutoff }
      }
    }),
    prisma.tokenEnrichment.count({
      where: { status: 'provider_error', lastError: { not: null }, updatedAt: { gte: recencyCutoff } }
    })
  ]);
  const birdeyeQuotaLimited = quotaErrors > 0;
  for (const s of statuses) {
    if (s.sourceName.startsWith('birdeye') && s.mode === 'live' && birdeyeQuotaLimited) {
      s.note = `CONFIGURED BUT QUOTA-LIMITED: ${quotaErrors} calls in the last 7 days blocked by the plan's compute-unit quota (retryable when it resets; fetch states persisted). ${enrichErrors} enrichment fetches also pending retry. ${s.note}`;
    }
    if (s.mode === 'mock') {
      s.note = `MOCK/DEV-ONLY — never an active product source. ${s.note}`;
    }
  }

  // The `dune` status rows aren't backed by an ExternalWalletSource, so they're
  // rendered in their own subsection below rather than the main table.
  const duneStatuses = statuses.filter((s) => s.sourceName === 'dune');
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

  // --- TRUTHFUL Solana-product source execution (live-recovery sprint) ------
  // Real recent execution from persisted tables, not just key presence.
  const recentCutoff = new Date(Date.now() - 7 * 86_400_000);
  const [
    birdeyeFetch,
    birdeyeQuota,
    metaResolved,
    metaRetryable,
    metaUnavailable,
    metaLastErr,
    topPnlRows,
    topPnlVerified,
    candidateRows
  ] = await Promise.all([
    prisma.topPnlFetchState.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.topPnlFetchState.count({ where: { status: 'provider_error', lastError: { contains: 'usage', mode: 'insensitive' }, updatedAt: { gte: recentCutoff } } }),
    prisma.tokenMetadata.count({ where: { chain: 'SOLANA', availability: 'resolved' } }),
    prisma.tokenMetadata.count({ where: { chain: 'SOLANA', availability: 'retryable' } }),
    prisma.tokenMetadata.count({ where: { chain: 'SOLANA', availability: 'unavailable' } }),
    prisma.tokenMetadata.findFirst({ where: { chain: 'SOLANA', lastError: { not: null } }, orderBy: { updatedAt: 'desc' }, select: { lastError: true, updatedAt: true } }),
    prisma.tokenTopPnlCandidate.count({ where: { chain: 'SOLANA' } }),
    prisma.tokenTopPnlCandidate.count({ where: { chain: 'SOLANA', validation: 'locally_verified' } }),
    prisma.tokenCandidateScore.count({ where: { chain: 'SOLANA' } })
  ]);
  const birdeyeByStatus = Object.fromEntries(birdeyeFetch.map((g) => [g.status, g._count._all]));
  // Credential presence — boolean only, values never leave the server.
  const heliusKey = Boolean(process.env.HELIUS_API_KEY);
  const birdeyeKey = Boolean(process.env.BIRDEYE_API_KEY);
  const metaAttempted = metaResolved + metaRetryable + metaUnavailable;
  const productSources = [
    {
      name: 'Local on-chain reconstruction',
      credential: 'n/a (local DB)',
      status: topPnlRows > 0 ? 'Healthy' : 'Degraded',
      detail: `${topPnlRows} historical top-PnL candidate rows persisted · ${topPnlVerified} locally verified · ${candidateRows} automatic token candidates`
    },
    {
      name: 'Helius (token metadata)',
      credential: heliusKey ? 'configured' : 'missing credential',
      status: !heliusKey ? 'Missing credential' : metaResolved > 0 && metaRetryable === 0 ? 'Healthy' : metaRetryable > 0 ? 'Quota limited' : metaAttempted === 0 ? 'Degraded' : metaUnavailable > 0 ? 'Degraded' : 'Healthy',
      detail: metaAttempted === 0 ? 'no metadata fetch attempted yet' : `token metadata: ${metaResolved} resolved · ${metaRetryable} retryable · ${metaUnavailable} unavailable${metaLastErr?.lastError ? ` · last error: ${metaLastErr.lastError.slice(0, 60)}` : ''}`
    },
    {
      name: 'Helius (wallet-activity polling)',
      credential: heliusKey ? 'configured' : 'missing credential',
      status: !heliusKey ? 'Missing credential' : 'Disabled',
      detail: 'driven by the live shadow-run worker, a separate process — its real health is on the Shadow page, not measured here'
    },
    {
      name: 'Birdeye (top traders / historical)',
      credential: birdeyeKey ? 'configured' : 'missing credential',
      status: !birdeyeKey
        ? 'Missing credential'
        : birdeyeQuota > 0
          ? 'Quota limited'
          : (birdeyeByStatus.provider_error ?? 0) > 0
            ? 'Degraded'
            : (birdeyeByStatus.fetched ?? 0) > 0
              ? 'Healthy'
              : 'Degraded',
      detail: `fetch states — ${Object.entries(birdeyeByStatus).map(([s, n]) => `${s}: ${n}`).join(' · ') || 'none'}${birdeyeQuota > 0 ? ` · ${birdeyeQuota} calls blocked by compute-unit quota in last 7d` : ''}`
    },
    { name: 'GMGN', credential: 'no verified endpoint', status: 'Stub / not implemented', detail: 'typed stub — no verified public API; returns no candidates' }
  ];
  const STATUS_CLASS: Record<string, string> = {
    Healthy: 'bg-emerald-500/15 text-emerald-300',
    'Quota limited': 'bg-amber-500/15 text-amber-300',
    Degraded: 'bg-orange-500/15 text-orange-300',
    Error: 'bg-red-500/15 text-red-300',
    'Missing credential': 'bg-red-500/15 text-red-300',
    Disabled: 'bg-zinc-500/15 text-zinc-300',
    'Stub / not implemented': 'bg-zinc-500/15 text-zinc-300'
  };

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Source Health</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Real execution state of the Solana product data sources, from persisted fetch/metadata results — not merely
        whether an API key is present. The legacy connector-health table (mock/stub feeders) is under Advanced below.
      </p>

      <div className="mt-4 overflow-x-auto rounded-xl border border-zinc-800">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-zinc-800 bg-zinc-900/70 text-xs text-zinc-400">
            <tr>
              <th className="px-3 py-2">Source</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Credential</th>
              <th className="px-3 py-2">Real execution result</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800/60">
            {productSources.map((s) => (
              <tr key={s.name}>
                <td className="px-3 py-2 font-medium">{s.name}</td>
                <td className="px-3 py-2"><span className={`inline-block rounded px-2 py-0.5 text-xs ${STATUS_CLASS[s.status] ?? 'bg-zinc-500/15 text-zinc-300'}`}>{s.status}</span></td>
                <td className="px-3 py-2 text-xs text-zinc-400">{s.credential}</td>
                <td className="px-3 py-2 text-xs text-zinc-400">{s.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-zinc-500">
        Historical top-PnL candidates ({topPnlRows}) and automatic token candidates ({candidateRows}) are distinct from
        the legacy provider-discovery candidate count below.
      </p>

      <h2 className="mt-8 text-lg font-semibold tracking-tight text-zinc-400">Advanced — legacy connector health</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        External candidate-wallet feeders (Wave 4.5). Stub/mock feeders are labeled; they never influence signals or
        counts until promoted (see Wallets).
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

      {/* Dune query sources — getCandidateSourceStatuses() surfaces a `dune`
          entry that isn't an ExternalWalletSource row (it's the Wave-4.6 Dune
          overlap connector, not a candidate feeder), so it never appears in the
          table above. Render it minimally here so its mode is still visible. */}
      {duneStatuses.length > 0 && (
        <div className="mt-8">
          <h2 className="text-lg font-semibold tracking-tight">Dune query sources</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Multi-token wallet overlap connector (Overlap Finder). Credit-safe by default (latest-cached results;
            fresh paid execution gated behind DUNE_EXECUTE_FRESH).
          </p>
          <div className="mt-3 overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="px-3 py-2 font-medium">Source</th>
                  <th className="px-3 py-2 font-medium">Chain</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Note</th>
                </tr>
              </thead>
              <tbody>
                {duneStatuses.map((s, i) => (
                  <tr key={`${s.sourceName}-${s.chain}-${i}`} className="border-b border-border/50 last:border-0">
                    <td className="px-3 py-2 font-mono text-xs">{s.sourceName}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">{s.chain}</td>
                    <td className="px-3 py-2">
                      <span
                        className={
                          'rounded px-1.5 py-0.5 text-[11px] font-medium ' +
                          (s.mode === 'live'
                            ? 'bg-emerald-500/10 text-emerald-400'
                            : s.mode === 'mock'
                              ? 'bg-sky-500/10 text-sky-400'
                              : s.mode === 'missing_key'
                                ? 'bg-amber-500/10 text-amber-400'
                                : 'bg-muted text-muted-foreground')
                        }
                      >
                        {s.mode}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">{s.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
