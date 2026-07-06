'use client';

// FlowRadar — CSV import history table (Task 12 binding decision 4).
//
// Client component so a row's per-row error list can be expanded/collapsed
// inline (a plain server component can't hold that toggle state) — the query
// itself (ImportJob rows, newest first) lives in app/wallets/import/page.tsx;
// this component only renders + toggles expansion, same
// query-in-page/render-in-component split as LeaderboardTable.

import { Fragment, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

export interface ImportRowErrorDisplay {
  row: number;
  message: string;
}

/**
 * One ImportJob row, already serialized to plain JSON-safe values. `status`
 * is ImportJob.status's free-form String column (importWalletsCsv.ts writes
 * one of 'completed' | 'completed_with_errors' | 'failed', but the column
 * itself isn't a bounded enum in schema.prisma, so this stays `string`
 * rather than a literal union — same reasoning as WalletStats.window being a
 * plain string per that model's own schema comment).
 *
 * `ageLabel` is a pre-formatted string (fmtAge(job.createdAt), computed in
 * app/wallets/import/page.tsx's server component), NOT a raw Date/ISO string
 * reformatted here — this component is 'use client' (needed for the
 * expand/collapse toggle below), so it hydrates in the browser after the
 * server's initial render; calling fmtAge(new Date(...)) directly in this
 * component's render body computes "time since createdAt" twice at two
 * different wall-clock moments (once during SSR, once during hydration a
 * few seconds later), producing two different strings for the same prop and
 * triggering a React hydration-mismatch warning (verified live during this
 * task's boot check — Next's dev overlay flagged exactly this: "3m 41s" vs
 * "3m 40s"). Formatting once, server-side, and passing the already-frozen
 * label avoids the mismatch entirely.
 */
export interface ImportHistoryRow {
  id: string;
  filename: string;
  status: string;
  totalRows: number;
  okRows: number;
  errorRows: number;
  ageLabel: string;
  errors: ImportRowErrorDisplay[];
}

const STATUS_BADGE_CLASS: Record<string, string> = {
  completed: 'border-transparent bg-emerald-500/15 text-emerald-300',
  completed_with_errors: 'border-transparent bg-amber-500/15 text-amber-300',
  failed: 'border-transparent bg-red-500/15 text-red-400'
};

function statusBadgeClass(status: string): string {
  return STATUS_BADGE_CLASS[status] ?? 'border-transparent bg-zinc-500/15 text-zinc-300';
}

export interface ImportHistoryTableProps {
  rows: ImportHistoryRow[];
}

export function ImportHistoryTable({ rows }: ImportHistoryTableProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No imports yet.</p>;
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Filename</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Total</TableHead>
            <TableHead className="text-right">Ok</TableHead>
            <TableHead className="text-right">Errors</TableHead>
            <TableHead>Age</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((job) => {
            const isExpanded = expandedId === job.id;
            const hasErrors = job.errors.length > 0;
            return (
              <Fragment key={job.id}>
                <TableRow>
                  <TableCell className="font-medium">{job.filename}</TableCell>
                  <TableCell>
                    <Badge className={statusBadgeClass(job.status)}>{job.status}</Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{job.totalRows}</TableCell>
                  <TableCell className="text-right tabular-nums text-emerald-400">{job.okRows}</TableCell>
                  <TableCell className="text-right tabular-nums text-red-400">{job.errorRows}</TableCell>
                  <TableCell className="text-muted-foreground">{job.ageLabel} ago</TableCell>
                  <TableCell className="text-right">
                    {hasErrors && (
                      <button
                        type="button"
                        onClick={() => setExpandedId(isExpanded ? null : job.id)}
                        className="text-xs font-medium text-muted-foreground hover:text-foreground hover:underline"
                      >
                        {isExpanded ? 'Hide errors' : `Show ${job.errors.length} error${job.errors.length === 1 ? '' : 's'}`}
                      </button>
                    )}
                  </TableCell>
                </TableRow>
                {isExpanded && hasErrors && (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={7} className="whitespace-normal bg-muted/30">
                      <ul className="max-h-64 space-y-1 overflow-y-auto py-1 text-xs">
                        {job.errors.map((err, idx) => (
                          <li key={`${err.row}-${idx}`} className="text-muted-foreground">
                            <span className="font-medium text-foreground">row {err.row}:</span> {err.message}
                          </li>
                        ))}
                      </ul>
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
