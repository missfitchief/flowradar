import Link from 'next/link';
import { prisma } from '@/lib/db';
import { fmtUsd } from '@/lib/format';
import { shortAddr } from '@/lib/rescue';

// FlowRadar — Historical Winners (discovery sprint): every processed
// historical $10M+ token, its top-PnL candidates, local validation, and
// whether the same discovered wallets are active again. Real persisted data.
export const dynamic = 'force-dynamic';

export default async function HistoricalPage() {
  const runners = await prisma.tokenLifecycle.findMany({
    where: { runnerClass: 'verified_above_10m' },
    orderBy: { mint: 'asc' },
    take: 400,
    select: { mint: true }
  });
  const mints = runners.map((r) => r.mint);

  const [enrichments, tokens, candGroups, replayEvents] = await Promise.all([
    prisma.tokenEnrichment.findMany({
      where: { mint: { in: mints } },
      select: { mint: true, athMcapUsd: true, athTs: true, status: true, confidence: true }
    }),
    prisma.token.findMany({ where: { chain: 'SOLANA', address: { in: mints } }, select: { address: true, symbol: true } }),
    prisma.tokenTopPnlCandidate.groupBy({
      by: ['mint', 'validation'],
      where: { chain: 'SOLANA', mint: { in: mints } },
      _count: { _all: true }
    }),
    prisma.replaySignalEvent.findMany({ where: { chain: 'SOLANA', mint: { in: mints } }, select: { mint: true, classification: true } })
  ]);
  const enrichOf = new Map(enrichments.map((e) => [e.mint, e]));
  const symbolOf = new Map(tokens.map((t) => [t.address, t.symbol]));
  const candsOf = new Map<string, { total: number; verified: number }>();
  for (const g of candGroups) {
    const c = candsOf.get(g.mint) ?? { total: 0, verified: 0 };
    c.total += g._count._all;
    if (g.validation === 'locally_verified') c.verified += g._count._all;
    candsOf.set(g.mint, c);
  }
  const replayOf = new Map(replayEvents.map((e) => [e.mint, e.classification]));

  // Order by ATH desc (known first), then mint.
  const rows = mints
    .map((mint) => ({ mint, enr: enrichOf.get(mint), cands: candsOf.get(mint) ?? { total: 0, verified: 0 }, replay: replayOf.get(mint) }))
    .sort((a, b) => {
      const av = a.enr?.athMcapUsd ? Number(a.enr.athMcapUsd) : -1;
      const bv = b.enr?.athMcapUsd ? Number(b.enr.athMcapUsd) : -1;
      return bv - av || (a.mint < b.mint ? -1 : 1);
    });

  const withCandidates = rows.filter((r) => r.cands.total > 0).length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Historical Winners</h1>
        <p className="mt-1 max-w-3xl text-sm text-zinc-400">
          Every verified historical $10M+ Solana token in the covered universe ({rows.length} tokens; {withCandidates} with
          top-PnL wallet candidates extracted). Click any token for its top-PnL wallets, dormant/fresh entries, funding
          paths and whether the same entities are active again.
        </p>
      </div>

      <div className="overflow-x-auto rounded-xl border border-zinc-800">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-zinc-800 bg-zinc-900/70 text-xs text-zinc-400">
            <tr>
              <th className="px-3 py-2">Token</th>
              <th className="px-3 py-2 text-right">ATH market cap</th>
              <th className="px-3 py-2">ATH date</th>
              <th className="px-3 py-2 text-right">Top-PnL candidates</th>
              <th className="px-3 py-2 text-right">Locally verified</th>
              <th className="px-3 py-2">Replay outcome</th>
              <th className="px-3 py-2">Coverage</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800/60">
            {rows.slice(0, 350).map((r) => (
              <tr key={r.mint} className="hover:bg-zinc-900/40">
                <td className="px-3 py-2 whitespace-nowrap">
                  <Link href={`/token/${r.mint}`} className="text-sky-400 hover:underline">
                    {symbolOf.get(r.mint) ? `$${symbolOf.get(r.mint)}` : shortAddr(r.mint)}
                  </Link>
                </td>
                <td className="px-3 py-2 text-right">
                  {r.enr?.athMcapUsd ? fmtUsd(Number(r.enr.athMcapUsd)) : <span className="text-zinc-500">unenriched</span>}
                </td>
                <td className="px-3 py-2 text-xs">{r.enr?.athTs ? r.enr.athTs.toISOString().slice(0, 10) : '—'}</td>
                <td className="px-3 py-2 text-right">{r.cands.total}</td>
                <td className="px-3 py-2 text-right">{r.cands.verified}</td>
                <td className="px-3 py-2 text-xs">{r.replay ? r.replay.replaceAll('_', ' ') : '—'}</td>
                <td className="px-3 py-2 text-xs text-zinc-400">{r.enr?.status ?? 'no enrichment'}{r.enr?.confidence ? ` · ${r.enr.confidence}` : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > 350 && <p className="text-xs text-zinc-500">Showing top 350 of {rows.length} by ATH.</p>}
    </div>
  );
}
