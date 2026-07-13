import { prisma } from '@/lib/db';
import { fmtUsd } from '@/lib/format';
import { missingEvidence, STATE_LABEL, STATE_BADGE_CLASS } from '@/lib/rescue';
import { SortableTable, TokenCellInner } from '@/components/SortableTable';
import type { Column } from '@/components/SortableTable';
import { resolveTokenIdentity } from '@/lib/tokenIdentity';

// FlowRadar — Watching: discovered candidates that don't yet qualify, sortable
// + searchable, with what evidence each is missing. Score-zero / insufficient
// records live here — never in Live Opportunities. Real persisted data.
export const dynamic = 'force-dynamic';

interface Row {
  id: string;
  mint: string;
  display: string;
  logoUri: string | null;
  isUnknown: boolean;
  state: string;
  mcap: number | null;
  buyers: number;
  missing: string;
}

export default async function WatchingPage() {
  const cands = await prisma.tokenCandidateScore.findMany({
    where: { state: { in: ['WATCHING', 'INVALIDATED'] } },
    orderBy: [{ confidence: 'desc' }, { qualifiedBuyerCount: 'desc' }, { mint: 'asc' }],
    take: 200
  });
  const metaRows = await prisma.tokenMetadata.findMany({
    where: { chain: 'SOLANA', mint: { in: cands.map((r) => r.mint) } },
    select: { mint: true, name: true, symbol: true, logoUri: true, availability: true }
  });
  const metaOf = new Map(metaRows.map((m) => [m.mint, m]));

  const rows: Row[] = cands.map((c) => {
    const id = resolveTokenIdentity(c.mint, metaOf.get(c.mint));
    return {
      id: c.id,
      mint: c.mint,
      display: id.display,
      logoUri: id.logoUri,
      isUnknown: id.isUnknown,
      state: c.state,
      mcap: c.currentMcapUsd === null ? null : Number(c.currentMcapUsd),
      buyers: c.qualifiedBuyerCount,
      missing:
        c.state === 'INVALIDATED'
          ? 'token outcome was a rug or failed launch — kept for the record'
          : missingEvidence(c).join(' · ') || 'a second independent qualified entity'
    };
  });

  const columns: Column<Row>[] = [
    { key: 'token', label: 'Token', value: (r) => (r.isUnknown ? r.mint : r.display), searchable: true, render: (r) => <TokenCellInner mint={r.mint} display={r.display} logoUri={r.logoUri} isUnknown={r.isUnknown} /> },
    { key: 'state', label: 'State', value: (r) => r.state, searchable: true, render: (r) => <span className={`inline-block rounded px-1.5 py-0.5 text-[11px] ${STATE_BADGE_CLASS[r.state] ?? ''}`}>{STATE_LABEL[r.state] ?? r.state}</span> },
    { key: 'mcap', label: 'Market cap', align: 'right', type: 'number', value: (r) => r.mcap, render: (r) => (r.mcap === null ? <span className="text-zinc-500">unknown</span> : fmtUsd(r.mcap)) },
    { key: 'buyers', label: 'Qualified buyers', align: 'right', type: 'number', value: (r) => r.buyers },
    { key: 'missing', label: "What's missing", value: (r) => r.missing, render: (r) => <span className="text-xs text-zinc-400">{r.missing}</span> }
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Watching</h1>
        <p className="mt-1 max-w-3xl text-sm text-zinc-400">
          Tokens with SOME qualified-wallet activity that don&apos;t yet meet the setup bar. Each row says exactly
          what evidence is missing. Invalidated tokens (rug/failed outcome) are kept for the record. Click a heading
          to sort, or search by token / mint / state.
        </p>
      </div>
      <SortableTable
        rows={rows}
        columns={columns}
        rowKey={(r) => r.id}
        rowHref={(r) => `/token/${r.mint}`}
        initialSort={{ key: 'buyers', dir: 'desc' }}
        searchPlaceholder="Search token / mint / state…"
        emptyText="Nothing is being watched — run the candidate pipeline first."
      />
    </div>
  );
}
