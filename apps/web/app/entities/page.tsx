import Link from 'next/link';
import { prisma } from '@/lib/db';
import { fmtUsd } from '@/lib/format';
import { shortAddr, fmtPct } from '@/lib/rescue';

// FlowRadar — Wallets / Entities (rescue sprint): the qualified-wallet
// quality leaderboard from real completed-position evidence. NULL metrics
// are shown as unknown — never fabricated.
export const dynamic = 'force-dynamic';

export default async function EntitiesPage() {
  const [entities, rows] = await Promise.all([
    prisma.entityDnaProfile.findMany({
      orderBy: [{ memberCount: 'desc' }, { completedPositions: 'desc' }, { entityKey: 'asc' }],
      take: 60
    }),
    prisma.walletDnaProfile.findMany({
      orderBy: [{ completedPositions: 'desc' }, { walletAddress: 'asc' }],
      take: 100
    })
  ]);
  const withWR = rows.filter((r) => r.winRate !== null).length;
  const multiWallet = entities.filter((e) => e.memberCount > 1);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-semibold">Entities</h1>
        <p className="mt-1 max-w-3xl text-sm text-zinc-400">
          ENTITY DNA aggregates only sufficiently-linked wallets (receiver funding, probable/strong on-chain
          relationships, repeat-candidate clusters, operator roots) — ten linked side wallets count as ONE entity,
          never ten independent wallets. Below the entity table is the per-ADDRESS DNA leaderboard.
        </p>
      </div>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-zinc-400">
          Entity DNA (entity-adjusted) · {multiWallet.length} multi-wallet · {entities.filter((e) => e.rootWallet).length} contain an operator root
        </h2>
        <div className="overflow-x-auto rounded-xl border border-zinc-800">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-zinc-800 bg-zinc-900/70 text-xs text-zinc-400">
              <tr>
                <th className="px-3 py-2">Entity</th>
                <th className="px-3 py-2 text-right">Wallets</th>
                <th className="px-3 py-2 text-right">Runners</th>
                <th className="px-3 py-2 text-right">Completed</th>
                <th className="px-3 py-2 text-right">Win rate</th>
                <th className="px-3 py-2 text-right">EV / pos</th>
                <th className="px-3 py-2 text-right">Realized PnL</th>
                <th className="px-3 py-2 text-right">One-winner dep.</th>
                <th className="px-3 py-2 text-right">Staged capital</th>
                <th className="px-3 py-2">Root</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/60">
              {entities.map((e) => (
                <tr key={e.id} className="hover:bg-zinc-900/40">
                  <td className="px-3 py-2">
                    <Link href={`/entity/${e.rootWallet ?? e.memberWallets[0] ?? e.entityKey}`} className="font-mono text-xs text-sky-400 hover:underline">
                      {shortAddr(e.entityKey)}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-right">{e.memberCount}</td>
                  <td className="px-3 py-2 text-right">{e.runnersInvolved}</td>
                  <td className="px-3 py-2 text-right">{e.completedPositions}</td>
                  <td className="px-3 py-2 text-right">{e.winRate === null ? <span className="text-zinc-500">unknown</span> : fmtPct(e.winRate)}</td>
                  <td className="px-3 py-2 text-right">{e.evUsdPerCompletedPosition === null ? '—' : fmtUsd(Number(e.evUsdPerCompletedPosition))}</td>
                  <td className="px-3 py-2 text-right">{e.totalRealizedPnlUsd === null ? '—' : fmtUsd(Number(e.totalRealizedPnlUsd))}</td>
                  <td className="px-3 py-2 text-right">{e.oneWinnerDependence === null ? '—' : fmtPct(e.oneWinnerDependence)}</td>
                  <td className="px-3 py-2 text-right">{e.stagedCapitalUsd === null ? '—' : fmtUsd(Number(e.stagedCapitalUsd))}</td>
                  <td className="px-3 py-2 text-xs">{e.rootWallet ? 'operator root' : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-zinc-400">
        Address DNA · {withWR} of {rows.length} wallets with calculable win rate
      </h2>
      <div className="overflow-x-auto rounded-xl border border-zinc-800">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-zinc-800 bg-zinc-900/70 text-xs text-zinc-400">
            <tr>
              <th className="px-3 py-2">Wallet</th>
              <th className="px-3 py-2 text-right">Completed</th>
              <th className="px-3 py-2 text-right">W / L</th>
              <th className="px-3 py-2 text-right">Win rate</th>
              <th className="px-3 py-2 text-right">EV / position</th>
              <th className="px-3 py-2 text-right">Median return</th>
              <th className="px-3 py-2 text-right">Realized PnL</th>
              <th className="px-3 py-2 text-right">Prior runners</th>
              <th className="px-3 py-2 text-right">One-winner dep.</th>
              <th className="px-3 py-2">Coverage</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800/60">
            {rows.map((r) => (
              <tr key={r.id} className="hover:bg-zinc-900/40">
                <td className="px-3 py-2">
                  <Link href={`/entity/${r.walletAddress}`} className="font-mono text-xs text-sky-400 hover:underline">
                    {shortAddr(r.walletAddress)}
                  </Link>
                </td>
                <td className="px-3 py-2 text-right">{r.completedPositions}</td>
                <td className="px-3 py-2 text-right">{r.winCount} / {r.lossCount}</td>
                <td className="px-3 py-2 text-right">{r.winRate === null ? <span className="text-zinc-500">unknown</span> : fmtPct(r.winRate)}</td>
                <td className="px-3 py-2 text-right">
                  {r.evUsdPerCompletedPosition === null ? <span className="text-zinc-500">unknown</span> : fmtUsd(Number(r.evUsdPerCompletedPosition))}
                </td>
                <td className="px-3 py-2 text-right">{r.medianReturn === null ? '—' : fmtPct(r.medianReturn)}</td>
                <td className="px-3 py-2 text-right">
                  {r.totalRealizedPnlUsd === null ? '—' : fmtUsd(Number(r.totalRealizedPnlUsd))}
                </td>
                <td className="px-3 py-2 text-right">{r.repeatRunnerCount ?? '—'}</td>
                <td className="px-3 py-2 text-right">{r.oneWinnerDependence === null ? '—' : fmtPct(r.oneWinnerDependence)}</td>
                <td className="px-3 py-2 text-xs">{r.coverage}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-zinc-500">
        “Prior runners” = distinct verified $10M+ tokens this wallet completed a profitable position on.
        High one-winner dependence means the wallet&apos;s realized profit comes mostly from a single trade.
      </p>
      </section>
    </div>
  );
}
