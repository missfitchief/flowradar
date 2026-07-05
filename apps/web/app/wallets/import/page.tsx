import Link from 'next/link';
import { prisma } from '@/lib/db';

// DB-backed history table — must render per-request, never freeze at build
// time (same convention as every other DB-backed page in this app).
export const dynamic = 'force-dynamic';

import { fmtAge } from '@/lib/format';
import { ImportForm } from '@/components/wallets/ImportForm';
import { ImportHistoryTable } from '@/components/wallets/ImportHistoryTable';
import type { ImportHistoryRow, ImportRowErrorDisplay } from '@/components/wallets/ImportHistoryTable';

const MAX_DISPLAYED_JOBS = 100;

/**
 * ImportJob.errors is a Prisma Json column — importWalletsCsv.ts always
 * writes it as an `ImportRowError[]` (see that module's ImportRowError
 * interface: `{ row: number; message: string; raw: Record<string, string> }`),
 * but Prisma's generated type for the column is the broad `Prisma.JsonValue`
 * (any valid JSON shape), so this narrows defensively at the query boundary
 * rather than casting blindly — a malformed/legacy value degrades to an
 * empty list instead of crashing the page. `raw` is intentionally dropped
 * here (never rendered) — only `row`/`message` are surfaced per decision 4's
 * "per-row error list" (the raw source row isn't part of the display spec).
 */
function parseErrorsJson(value: unknown): ImportRowErrorDisplay[] {
  if (!Array.isArray(value)) return [];
  const parsed: ImportRowErrorDisplay[] = [];
  for (const item of value) {
    if (
      item !== null &&
      typeof item === 'object' &&
      'row' in item &&
      'message' in item &&
      typeof (item as { row: unknown }).row === 'number' &&
      typeof (item as { message: unknown }).message === 'string'
    ) {
      parsed.push({ row: (item as { row: number }).row, message: (item as { message: string }).message });
    }
  }
  return parsed;
}

/**
 * CSV Import history page (Task 12 binding decision 4). Server component:
 * upload form (ImportForm, client component) + ImportJob rows newest-first
 * (filename, status, total/ok/error counts, age, expandable per-row error
 * list). Every Date/Json field is converted at this query boundary before
 * reaching the client-rendered table — same "server queries, client renders
 * plain serialized data" invariant as app/wallets/page.tsx.
 */
export default async function ImportHistoryPage() {
  const jobs = await prisma.importJob.findMany({
    orderBy: { createdAt: 'desc' },
    take: MAX_DISPLAYED_JOBS
  });

  // ageLabel is formatted once here (server component, one wall-clock
  // moment) rather than passed as a raw Date/ISO string and reformatted
  // inside ImportHistoryTable's render — that component is a client
  // component (needed for the expand/collapse toggle), so a
  // fmtAge(new Date(...)) call inside its render body would compute a
  // different "time since createdAt" string during SSR vs. during
  // browser-side hydration a moment later, producing a React
  // hydration-mismatch warning (see ImportHistoryRow.ageLabel's own doc
  // comment for the exact mismatch observed during this task's boot check).
  const rows: ImportHistoryRow[] = jobs.map((job) => ({
    id: job.id,
    filename: job.filename,
    status: job.status,
    totalRows: job.totalRows,
    okRows: job.okRows,
    errorRows: job.errorRows,
    ageLabel: fmtAge(job.createdAt),
    errors: parseErrorsJson(job.errors)
  }));

  return (
    <div>
      <Link href="/wallets" className="text-sm text-muted-foreground hover:text-foreground hover:underline">
        ← Back to Wallet Leaderboard
      </Link>

      <h1 className="mt-2 text-2xl font-semibold tracking-tight">Import CSV</h1>
      <p className="mt-2 text-sm text-muted-foreground">Upload a wallet-stats CSV and review import history</p>

      <div className="mt-6">
        <ImportForm />
      </div>

      <h2 className="mt-8 text-lg font-semibold tracking-tight">History</h2>
      <div className="mt-4">
        <ImportHistoryTable rows={rows} />
      </div>
    </div>
  );
}
