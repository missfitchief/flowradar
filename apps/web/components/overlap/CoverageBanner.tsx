// FlowRadar — CoverageBanner (Task 38, Wave 4.6, task-38-brief.md binding
// decision 6 — "the honesty surface", capture-mandated on EVERY overlap
// result). Shows: query_id (or 'local DB' for a local source), last_run_at
// age, rows_returned, cached-vs-fresh, truncation warning, and a source
// confidence badge (local=high/direct, dune=medium/external,
// provider=low/limited). For a local search this explicitly uses NO Dune
// credit language ('Local DB — direct on-chain-derived').
//
// Pure presentational component — every field pre-computed by the caller
// (OverlapFinder), no Prisma coupling, no Date objects (age is a
// pre-formatted string, same hydration-mismatch-avoidance reasoning as
// SourceHealthTable's lastSyncAgeLabel).

import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';

export type OverlapSourceKind = 'local' | 'dune' | 'provider' | 'hybrid';

export interface CoverageBannerProps {
  source: OverlapSourceKind;
  /** Dune query id, or null for local/provider (no query_id concept). */
  queryId: string | null;
  /** Pre-formatted "Xh Ym ago" (fmtAge(...) + ' ago'), or null if the search never finished. */
  lastRunAgeLabel: string | null;
  rowsReturned: number;
  /** null = n/a (local source has no cache/fresh distinction to report). */
  usedCachedResult: boolean | null;
  truncated: boolean;
  maxResults: number;
  candidatesAddedCount?: number;
}

const CONFIDENCE_BY_SOURCE: Record<OverlapSourceKind, { label: string; className: string; note: string }> = {
  local: {
    label: 'high · direct',
    className: 'border-transparent bg-emerald-500/15 text-emerald-300',
    note: 'Derived directly from this app’s own ingested trade ledger — not a third-party claim.',
  },
  dune: {
    label: 'medium · external',
    className: 'border-transparent bg-amber-500/15 text-amber-300',
    note: 'External query result — surfaced wallets enter as pending CandidateWallet rows, never trusted blindly.',
  },
  provider: {
    label: 'low · limited',
    className: 'border-transparent bg-red-500/15 text-red-400',
    note: 'Best-effort/documented-limited provider adapter — coverage may be incomplete or unavailable.',
  },
  hybrid: {
    label: 'mixed',
    className: 'border-transparent bg-sky-500/15 text-sky-300',
    note: 'Merged local (high/direct) + dune (medium/external) results — see each row’s own origin.',
  },
};

export function CoverageBanner({
  source,
  queryId,
  lastRunAgeLabel,
  rowsReturned,
  usedCachedResult,
  truncated,
  maxResults,
  candidatesAddedCount,
}: CoverageBannerProps) {
  const confidence = CONFIDENCE_BY_SOURCE[source];
  const isLocal = source === 'local';

  return (
    <Card className="border-primary/20 bg-primary/5">
      <CardContent className="flex flex-col gap-2 py-4">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
          <span className="font-medium">Coverage</span>
          <span className="text-muted-foreground">
            {isLocal ? 'Local DB — direct on-chain-derived' : `query_id: ${queryId ?? 'n/a'}`}
          </span>
          <span className="text-muted-foreground">last run: {lastRunAgeLabel ?? 'n/a'}</span>
          <span className="text-muted-foreground">rows returned: {rowsReturned}</span>
          {usedCachedResult !== null && (
            <Badge
              className={cn(
                'border-transparent',
                usedCachedResult ? 'bg-violet-500/15 text-violet-300' : 'bg-sky-500/15 text-sky-300',
              )}
            >
              {usedCachedResult ? 'latest cached result (no credits used)' : 'fresh execution'}
            </Badge>
          )}
          <Badge className={confidence.className}>confidence: {confidence.label}</Badge>
        </div>

        {truncated && (
          <p className="text-xs text-amber-400">
            Results capped at {maxResults} — may be incomplete.
          </p>
        )}

        <p className="text-xs text-muted-foreground">{confidence.note}</p>

        {typeof candidatesAddedCount === 'number' && candidatesAddedCount > 0 && (
          <p className="text-xs text-muted-foreground">
            {candidatesAddedCount} wallet{candidatesAddedCount === 1 ? '' : 's'} added as candidates → pending
            validation (see Sources). Overlap wallets are never auto-watched.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
