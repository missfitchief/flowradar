import { prisma } from '@/lib/db';
import { fmtUsd } from '@/lib/format';
import { SortableTable, TokenCellInner } from '@/components/SortableTable';
import type { Column } from '@/components/SortableTable';
import { resolveTokenIdentity } from '@/lib/tokenIdentity';
import { CLASSIFICATION_LABEL } from '@/lib/rescue';

// FlowRadar — Historical Winners: every processed historical $10M+ token, its
// top-PnL extraction outcome and candidates, sortable + searchable, with real
// token identity (never a mint prefix). Real persisted data.
export const dynamic = 'force-dynamic';

interface Row {
  mint: string;
  display: string;
  logoUri: string | null;
  isUnknown: boolean;
  ath: number | null;
  athDate: string | null;
  extraction: string;
  candTotal: number;
  candVerified: number;
  replay: string | null;
  coverage: string;
}

export default async function HistoricalPage() {
  const totalRunners = await prisma.tokenLifecycle.count({ where: { runnerClass: 'verified_above_10m' } });
  const runners = await prisma.tokenLifecycle.findMany({
    where: { runnerClass: 'verified_above_10m' },
    orderBy: { mint: 'asc' },
    take: 2000,
    select: { mint: true }
  });
  const mints = runners.map((r) => r.mint);

  const [enrichments, metaRows, candGroups, replayEvents, extractionRows] = await Promise.all([
    prisma.tokenEnrichment.findMany({ where: { mint: { in: mints } }, select: { mint: true, athMcapUsd: true, athTs: true, status: true, confidence: true } }),
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

  const rows: Row[] = mints.map((mint) => {
    const id = resolveTokenIdentity(mint, metaOf.get(mint));
    const enr = enrichOf.get(mint);
    const c = candsOf.get(mint) ?? { total: 0, verified: 0 };
    return {
      mint,
      display: id.display,
      logoUri: id.logoUri,
      isUnknown: id.isUnknown,
      ath: enr?.athMcapUsd ? Number(enr.athMcapUsd) : null,
      athDate: enr?.athTs ? enr.athTs.toISOString().slice(0, 10) : null,
      extraction: extractionOf.get(mint) ?? 'pending',
      candTotal: c.total,
      candVerified: c.verified,
      replay: replayOf.get(mint) ?? null,
      coverage: enr?.status ?? 'no enrichment'
    };
  });
  const withCandidates = rows.filter((r) => r.candTotal > 0).length;

  const columns: Column<Row>[] = [
    { key: 'token', label: 'Token', value: (r) => (r.isUnknown ? r.mint : r.display), searchable: true, render: (r) => <TokenCellInner mint={r.mint} display={r.display} logoUri={r.logoUri} isUnknown={r.isUnknown} /> },
    { key: 'ath', label: 'ATH market cap', align: 'right', type: 'number', value: (r) => r.ath, render: (r) => (r.ath === null ? <span className="text-zinc-500">unenriched</span> : fmtUsd(r.ath)) },
    { key: 'athDate', label: 'ATH date', type: 'date', value: (r) => r.athDate, render: (r) => <span className="text-xs">{r.athDate ?? '—'}</span> },
    { key: 'extraction', label: 'Extraction', value: (r) => r.extraction, searchable: true, render: (r) => <span className="text-xs">{r.extraction.replaceAll('_', ' ')}</span> },
    { key: 'candTotal', label: 'Candidates', align: 'right', type: 'number', value: (r) => r.candTotal },
    { key: 'candVerified', label: 'Verified', align: 'right', type: 'number', value: (r) => r.candVerified },
    { key: 'replay', label: 'Replay outcome', value: (r) => r.replay, render: (r) => <span className="text-xs">{r.replay ? CLASSIFICATION_LABEL[r.replay] ?? r.replay.replaceAll('_', ' ') : '—'}</span> },
    { key: 'coverage', label: 'Coverage', value: (r) => r.coverage, render: (r) => <span className="text-xs text-zinc-400">{r.coverage}</span> }
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Historical Winners</h1>
        <p className="mt-1 max-w-3xl text-sm text-zinc-400">
          All {totalRunners} verified historical $10M+ Solana tokens in the covered universe; {withCandidates} have
          top-PnL wallet candidates extracted. Click any row for the token&apos;s top-PnL wallets, dormant/fresh
          entries, funding paths and whether the same entities are active again. Click a column heading to sort.
        </p>
        <p className="mt-2 text-xs text-zinc-400">
          <span className="font-medium text-zinc-300">Extraction outcomes: </span>
          {Object.entries(extractionCounts).sort((a, b) => b[1] - a[1]).map(([s, n]) => `${s.replaceAll('_', ' ')}: ${n}`).join(' · ') || 'not computed'}
        </p>
      </div>
      <SortableTable
        rows={rows}
        columns={columns}
        rowKey={(r) => r.mint}
        rowHref={(r) => `/token/${r.mint}`}
        initialSort={{ key: 'ath', dir: 'desc' }}
        searchPlaceholder="Search token / mint / extraction status…"
      />
    </div>
  );
}
