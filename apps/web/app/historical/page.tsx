import { prisma } from '@/lib/db';
import { fmtUsd } from '@/lib/format';
import { SortableTable } from '@/components/SortableTable';
import type { SortColumn, SortRow } from '@/components/SortableTable';
import { resolveTokenIdentity } from '@/lib/tokenIdentity';
import { CLASSIFICATION_LABEL } from '@/lib/rescue';

// FlowRadar — Historical Winners: every processed historical $10M+ token, its
// top-PnL extraction outcome and candidates, sortable + searchable, with real
// token identity (never a mint prefix). Real persisted data.
export const dynamic = 'force-dynamic';

const COLUMNS: SortColumn[] = [
  { key: 'token', label: 'Token', searchable: true },
  { key: 'ath', label: 'ATH market cap', align: 'right' },
  { key: 'athDate', label: 'ATH date' },
  { key: 'extraction', label: 'Extraction', searchable: true },
  { key: 'candTotal', label: 'Candidates', align: 'right' },
  { key: 'candVerified', label: 'Verified', align: 'right' },
  { key: 'replay', label: 'Replay outcome' },
  { key: 'coverage', label: 'Coverage' }
];

export default async function HistoricalPage() {
  const totalRunners = await prisma.tokenLifecycle.count({ where: { runnerClass: 'verified_above_10m' } });
  const runners = await prisma.tokenLifecycle.findMany({ where: { runnerClass: 'verified_above_10m' }, orderBy: { mint: 'asc' }, take: 2000, select: { mint: true } });
  const mints = runners.map((r) => r.mint);

  const [enrichments, metaRows, candGroups, replayEvents, extractionRows] = await Promise.all([
    prisma.tokenEnrichment.findMany({ where: { mint: { in: mints } }, select: { mint: true, athMcapUsd: true, athTs: true, status: true } }),
    prisma.tokenMetadata.findMany({ where: { chain: 'SOLANA', mint: { in: mints } }, select: { mint: true, name: true, symbol: true, logoUri: true, availability: true } }),
    prisma.tokenTopPnlCandidate.groupBy({ by: ['mint', 'validation'], where: { chain: 'SOLANA', mint: { in: mints } }, _count: { _all: true } }),
    prisma.replaySignalEvent.findMany({ where: { chain: 'SOLANA', mint: { in: mints } }, orderBy: [{ mint: 'asc' }, { eventKind: 'asc' }], select: { mint: true, eventKind: true, classification: true } }),
    prisma.topPnlExtractionStatus.findMany({ where: { chain: 'SOLANA', mint: { in: mints } }, select: { mint: true, status: true } })
  ]);
  const enrichOf = new Map(enrichments.map((e) => [e.mint, e]));
  const metaOf = new Map(metaRows.map((m) => [m.mint, m]));
  const extractionOf = new Map(extractionRows.map((e) => [e.mint, e.status]));
  const extractionCounts: Record<string, number> = {};
  for (const e of extractionRows) extractionCounts[e.status] = (extractionCounts[e.status] ?? 0) + 1;
  const candsOf = new Map<string, { total: number; verified: number }>();
  for (const g of candGroups) {
    const c = candsOf.get(g.mint) ?? { total: 0, verified: 0 };
    c.total += g._count._all;
    if (g.validation === 'locally_verified') c.verified += g._count._all;
    candsOf.set(g.mint, c);
  }
  const replayOf = new Map<string, string>();
  for (const e of replayEvents) if (e.eventKind === 'signal' || !replayOf.has(e.mint)) replayOf.set(e.mint, e.classification);

  const rows: SortRow[] = mints.map((mint) => {
    const id = resolveTokenIdentity(mint, metaOf.get(mint));
    const enr = enrichOf.get(mint);
    const ath = enr?.athMcapUsd ? Number(enr.athMcapUsd) : null;
    const c = candsOf.get(mint) ?? { total: 0, verified: 0 };
    const replay = replayOf.get(mint) ?? null;
    return {
      id: mint,
      href: `/token/${mint}`,
      cells: {
        token: { kind: 'token', mint, display: id.display, logoUri: id.logoUri, isUnknown: id.isUnknown },
        ath: { kind: 'usd', value: ath, display: ath === null ? 'unenriched' : fmtUsd(ath) },
        athDate: { kind: 'text', text: enr?.athTs ? enr.athTs.toISOString().slice(0, 10) : '—', muted: true },
        extraction: { kind: 'text', text: (extractionOf.get(mint) ?? 'pending').replaceAll('_', ' '), muted: true },
        candTotal: { kind: 'number', value: c.total, display: String(c.total) },
        candVerified: { kind: 'number', value: c.verified, display: String(c.verified) },
        replay: { kind: 'text', text: replay ? CLASSIFICATION_LABEL[replay] ?? replay.replaceAll('_', ' ') : '—', muted: true },
        coverage: { kind: 'text', text: enr?.status ?? 'no enrichment', muted: true }
      }
    };
  });
  const withCandidates = rows.filter((r) => (r.cells.candTotal as { value: number }).value > 0).length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Historical Winners</h1>
        <p className="mt-1 max-w-3xl text-sm text-zinc-400">
          {totalRunners} verified historical $10M+ Solana tokens ({rows.length} loaded); {withCandidates} have top-PnL
          wallet candidates extracted. Click any row for the token&apos;s top-PnL wallets, dormant/fresh entries and
          funding paths. Click a column heading to sort.
        </p>
        <p className="mt-2 text-xs text-zinc-400">
          <span className="font-medium text-zinc-300">Extraction outcomes: </span>
          {Object.entries(extractionCounts).sort((a, b) => b[1] - a[1]).map(([s, n]) => `${s.replaceAll('_', ' ')}: ${n}`).join(' · ') || 'not computed'}
        </p>
      </div>
      <SortableTable rows={rows} columns={COLUMNS} initialSort={{ key: 'ath', dir: 'desc' }} searchPlaceholder="Search token / mint / extraction status…" />
    </div>
  );
}
