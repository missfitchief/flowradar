'use client';

// FlowRadar — Source Health table (Task 36, Wave 4.5, Spec §5b).
//
// One row per seeded ExternalWalletSource. Status badge color follows the
// task's binding decision 3 exactly: mock=violet, live=emerald,
// missing_key=amber, stub=zinc (same violet/emerald/amber/zinc palette
// LeaderboardTable/HotTokensTable already use for their own status/label
// badges — no new color convention introduced). The enabled toggle PATCHes
// /api/sources immediately (optimistic local state + router.refresh() on
// success so the rest of the server-rendered page — summary cards, other
// rows' candidate counts — stays consistent; a failed PATCH reverts the
// toggle and shows an inline error, same "busy/done state, no toast library"
// convention as BacktestControls).

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';

export type SourceMode = 'live' | 'mock' | 'missing_key' | 'stub';

export interface SourceHealthRow {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  mode: SourceMode;
  modeNote: string;
  apiKeyEnvName: string;
  envKeyPresent: boolean;
  /**
   * Pre-formatted "Xh Ym ago" / "never" label (fmtAge(lastSyncAt) + ' ago',
   * computed server-side in app/sources/page.tsx), NOT a raw Date/ISO string
   * reformatted here — this component is 'use client' (needed for the
   * enabled-toggle switch below), so calling fmtAge(new Date(...)) directly
   * in its render body would compute "time since lastSyncAt" at two
   * different wall-clock moments (once during SSR, once during client
   * hydration), producing a hydration-mismatch warning — same fix
   * ImportHistoryTable's ageLabel documents.
   */
  lastSyncAgeLabel: string;
  rateLimitPerMinute: number;
  lastError: string | null;
  found: number;
  validated: number;
  promoted: number;
  pending: number;
}

export interface SourceHealthTableProps {
  rows: SourceHealthRow[];
}

const MODE_BADGE_CLASS: Record<SourceMode, string> = {
  mock: 'border-transparent bg-violet-500/15 text-violet-300',
  live: 'border-transparent bg-emerald-500/15 text-emerald-300',
  missing_key: 'border-transparent bg-amber-500/15 text-amber-300',
  stub: 'border-transparent bg-zinc-500/15 text-zinc-300'
};

interface ToggleState {
  busy: boolean;
  error: string | null;
}

function SourceToggle({ row }: { row: SourceHealthRow }) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(row.enabled);
  const [state, setState] = useState<ToggleState>({ busy: false, error: null });

  async function handleChange(next: boolean): Promise<void> {
    const previous = enabled;
    setEnabled(next);
    setState({ busy: true, error: null });
    try {
      const response = await fetch('/api/sources', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: row.name, enabled: next })
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error ?? `PATCH failed (HTTP ${response.status})`);
      }
      setState({ busy: false, error: null });
      router.refresh();
    } catch (err) {
      setEnabled(previous);
      setState({ busy: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <Switch checked={enabled} disabled={state.busy} onCheckedChange={handleChange} aria-label={`Toggle ${row.name}`} />
      {state.error && <span className="text-xs text-red-400">{state.error}</span>}
    </div>
  );
}

export function SourceHealthTable({ rows }: SourceHealthTableProps) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No external wallet sources seeded yet.</p>;
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Source</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Enabled</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>API key</TableHead>
            <TableHead>Last sync</TableHead>
            <TableHead className="text-right">Rate limit</TableHead>
            <TableHead className="text-right">Found</TableHead>
            <TableHead className="text-right">Validated</TableHead>
            <TableHead className="text-right">Promoted</TableHead>
            <TableHead className="text-right">Pending</TableHead>
            <TableHead>Last error</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell className="font-medium">{row.name}</TableCell>
              <TableCell className="text-xs text-muted-foreground">{row.type}</TableCell>
              <TableCell>
                <SourceToggle row={row} />
              </TableCell>
              <TableCell>
                <Badge className={MODE_BADGE_CLASS[row.mode]} title={row.modeNote}>
                  {row.mode}
                </Badge>
              </TableCell>
              <TableCell className="text-xs">
                <code className="text-muted-foreground">{row.apiKeyEnvName}</code>{' '}
                <span className={cn(row.envKeyPresent ? 'text-emerald-400' : 'text-zinc-500')}>
                  {row.envKeyPresent ? 'set' : 'missing'}
                </span>
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">{row.lastSyncAgeLabel}</TableCell>
              <TableCell className="text-right tabular-nums">{row.rateLimitPerMinute}/min</TableCell>
              <TableCell className="text-right tabular-nums">{row.found}</TableCell>
              <TableCell className="text-right tabular-nums">{row.validated}</TableCell>
              <TableCell className="text-right tabular-nums text-emerald-400">{row.promoted}</TableCell>
              <TableCell className="text-right tabular-nums text-amber-400">{row.pending}</TableCell>
              <TableCell className="max-w-[240px] truncate text-xs text-red-400" title={row.lastError ?? undefined}>
                {row.lastError ?? '—'}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
