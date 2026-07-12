import Link from 'next/link';
import { prisma } from '@/lib/db';
import { fmtUsd } from '@/lib/format';
import { shortAddr, missingEvidence, STATE_LABEL, STATE_BADGE_CLASS } from '@/lib/rescue';

// FlowRadar — Watching (rescue sprint): every discovered candidate that does
// NOT yet qualify, with exactly what evidence each one is missing. This is
// where score-zero and insufficient-data records live — never in /setups.
export const dynamic = 'force-dynamic';

export default async function WatchingPage() {
  const rows = await prisma.tokenCandidateScore.findMany({
    where: { state: { in: ['WATCHING', 'INVALIDATED'] } },
    orderBy: [{ confidence: 'desc' }, { qualifiedBuyerCount: 'desc' }, { mint: 'asc' }],
    take: 150
  });
  const tokenRows = await prisma.token.findMany({
    where: { chain: 'SOLANA', address: { in: rows.map((r) => r.mint) } },
    select: { address: true, symbol: true }
  });
  const symbolOf = new Map(tokenRows.map((t) => [t.address, t.symbol]));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Watching</h1>
        <p className="mt-1 max-w-3xl text-sm text-zinc-400">
          Tokens with SOME qualified-wallet activity that don&apos;t yet meet the setup bar. Each row says
          exactly what evidence is missing. Invalidated tokens (rug/failed outcome) are kept for the record.
        </p>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6 text-sm text-zinc-400">
          Nothing is being watched — run the candidate pipeline first.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-zinc-800">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-zinc-800 bg-zinc-900/70 text-xs text-zinc-400">
              <tr>
                <th className="px-3 py-2">Token</th>
                <th className="px-3 py-2">State</th>
                <th className="px-3 py-2 text-right">Market cap</th>
                <th className="px-3 py-2 text-right">Qualified buyers</th>
                <th className="px-3 py-2">What&apos;s missing</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/60">
              {rows.map((c) => (
                <tr key={c.id} className="align-top hover:bg-zinc-900/40">
                  <td className="px-3 py-2 whitespace-nowrap">
                    <Link href={`/token/${c.mint}`} className="text-sky-400 hover:underline">
                      {symbolOf.get(c.mint) ? `$${symbolOf.get(c.mint)}` : shortAddr(c.mint)}
                    </Link>
                  </td>
                  <td className="px-3 py-2">
                    <span className={`inline-block rounded px-1.5 py-0.5 text-[11px] ${STATE_BADGE_CLASS[c.state] ?? ''}`}>
                      {STATE_LABEL[c.state] ?? c.state}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    {c.currentMcapUsd === null ? <span className="text-zinc-500">unknown</span> : fmtUsd(Number(c.currentMcapUsd))}
                  </td>
                  <td className="px-3 py-2 text-right">{c.qualifiedBuyerCount}</td>
                  <td className="px-3 py-2 text-xs text-zinc-400">
                    {c.state === 'INVALIDATED'
                      ? 'token outcome was a rug or failed launch — kept for the record'
                      : missingEvidence(c).join(' · ') || 'a second independent qualified entity'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
