import { prisma } from '@/lib/db';
import { fmtUsd } from '@/lib/format';
import { missingEvidence, STATE_LABEL, STATE_BADGE_CLASS } from '@/lib/rescue';
import { SortableTable } from '@/components/SortableTable';
import type { SortColumn, SortRow } from '@/components/SortableTable';
import { resolveTokenIdentity } from '@/lib/tokenIdentity';

// FlowRadar — Watching: discovered candidates that don't yet qualify, sortable
// + searchable, with what evidence each is missing. Score-zero / insufficient
// records live here — never in Live Opportunities. Real persisted data.
export const dynamic = 'force-dynamic';

const COLUMNS: SortColumn[] = [
  { key: 'token', label: 'Token', searchable: true },
  { key: 'state', label: 'State', searchable: true },
  { key: 'mcap', label: 'Market cap', align: 'right' },
  { key: 'buyers', label: 'Qualified buyers', align: 'right' },
  { key: 'missing', label: "What's missing" }
];

export default async function WatchingPage() {
  const cands = await prisma.tokenCandidateScore.findMany({
    where: { chain: 'SOLANA', state: { in: ['WATCHING', 'INVALIDATED'] } },
    orderBy: [{ confidence: 'desc' }, { qualifiedBuyerCount: 'desc' }, { mint: 'asc' }],
    take: 200
  });
  const metaRows = await prisma.tokenMetadata.findMany({ where: { chain: 'SOLANA', mint: { in: cands.map((r) => r.mint) } }, select: { mint: true, name: true, symbol: true, logoUri: true, availability: true } });
  const metaOf = new Map(metaRows.map((m) => [m.mint, m]));

  const rows: SortRow[] = cands.map((c) => {
    const id = resolveTokenIdentity(c.mint, metaOf.get(c.mint));
    const mcap = c.currentMcapUsd === null ? null : Number(c.currentMcapUsd);
    const missing = c.state === 'INVALIDATED' ? 'token outcome was a rug or failed launch — kept for the record' : missingEvidence(c).join(' · ') || 'a second independent qualified entity';
    return {
      id: c.id,
      href: `/token/${c.mint}`,
      cells: {
        token: { kind: 'token', mint: c.mint, display: id.display, logoUri: id.logoUri, isUnknown: id.isUnknown },
        state: { kind: 'badge', text: STATE_LABEL[c.state] ?? c.state, className: STATE_BADGE_CLASS[c.state] },
        mcap: { kind: 'usd', value: mcap, display: mcap === null ? 'unknown' : fmtUsd(mcap) },
        buyers: { kind: 'number', value: c.qualifiedBuyerCount, display: String(c.qualifiedBuyerCount) },
        missing: { kind: 'text', text: missing, muted: true }
      }
    };
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Watching</h1>
        <p className="mt-1 max-w-3xl text-sm text-zinc-400">
          Tokens with SOME qualified-wallet activity that don&apos;t yet meet the setup bar. Each row says exactly what
          evidence is missing. Invalidated tokens (rug/failed outcome) are kept for the record. Click a heading to
          sort, or search by token / mint / state.
        </p>
      </div>
      <SortableTable rows={rows} columns={COLUMNS} initialSort={{ key: 'buyers', dir: 'desc' }} searchPlaceholder="Search token / mint / state…" emptyText="Nothing is being watched — run the candidate pipeline first." />
    </div>
  );
}
