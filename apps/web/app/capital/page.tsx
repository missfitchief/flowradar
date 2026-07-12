import Link from 'next/link';
import { prisma } from '@/lib/db';
import { fmtUsd } from '@/lib/format';
import { shortAddr } from '@/lib/rescue';

// FlowRadar — Capital Movements (rescue sprint): where capital LEAVES
// qualified wallets and who receives it, ordered by evidence strength
// (direct transfer > multi-hop > bridge inference > CEX correlation).
export const dynamic = 'force-dynamic';

const TIER_LABEL: Record<string, string> = {
  direct_transfer: 'Direct transfer (strongest evidence)',
  multi_hop_transfer: 'Multi-hop transfer',
  bridge_inference: 'Bridge exit (destination not attributed)',
  cex_correlation: 'CEX deposit (correlation only — receiver never attributed)'
};

export default async function CapitalPage() {
  const [paths, receivers] = await Promise.all([
    prisma.capitalOutflowPath.findMany({
      orderBy: [{ evidenceTier: 'asc' }, { firstTransferTs: 'desc' }],
      take: 100
    }),
    prisma.receiverEnrollment.findMany({
      orderBy: [{ deployedTokenCount: 'desc' }, { receiverAddress: 'asc' }],
      take: 50
    })
  ]);

  const byTier = new Map<string, typeof paths>();
  for (const p of paths) {
    const list = byTier.get(p.evidenceTier) ?? [];
    list.push(p);
    byTier.set(p.evidenceTier, list);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Capital Movements</h1>
        <p className="mt-1 max-w-3xl text-sm text-zinc-400">
          Where qualified wallets send capital, ordered by evidence strength. A bridge exit or CEX deposit ends
          the trail honestly — this system never attributes what happens on the other side.
        </p>
      </div>

      {paths.length === 0 ? (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6 text-sm text-zinc-400">
          No capital outflow paths persisted yet.
        </div>
      ) : (
        ['direct_transfer', 'multi_hop_transfer', 'bridge_inference', 'cex_correlation'].map((tier) => {
          const rows = byTier.get(tier);
          if (!rows || rows.length === 0) return null;
          return (
            <section key={tier}>
              <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-zinc-400">{TIER_LABEL[tier]}</h2>
              <div className="overflow-x-auto rounded-xl border border-zinc-800">
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-zinc-800 bg-zinc-900/70 text-xs text-zinc-400">
                    <tr>
                      <th className="px-3 py-2">From (qualified)</th>
                      <th className="px-3 py-2">To</th>
                      <th className="px-3 py-2">Receiver at receipt</th>
                      <th className="px-3 py-2 text-right">Known value</th>
                      <th className="px-3 py-2 text-right">Transfers</th>
                      <th className="px-3 py-2">First / last</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800/60">
                    {rows.map((p) => (
                      <tr key={p.id} className="hover:bg-zinc-900/40">
                        <td className="px-3 py-2">
                          <Link href={`/entity/${p.sourceWallet}`} className="font-mono text-xs text-sky-400 hover:underline">
                            {shortAddr(p.sourceWallet)}
                          </Link>
                        </td>
                        <td className="px-3 py-2">
                          {p.destinationType === 'wallet' ? (
                            <Link href={`/entity/${p.destinationAddress}`} className="font-mono text-xs text-sky-400 hover:underline">
                              {shortAddr(p.destinationAddress)}
                            </Link>
                          ) : (
                            <span className="font-mono text-xs">
                              {shortAddr(p.destinationAddress)}{' '}
                              <span className="text-zinc-500">({p.destinationType}{p.bridgeProtocol ? `: ${p.bridgeProtocol}` : ''})</span>
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-xs">{p.receiverClassAtReceipt.replaceAll('_', ' ')}</td>
                        <td className="px-3 py-2 text-right">
                          {p.knownValueUsd === null ? <span className="text-zinc-500">unknown</span> : fmtUsd(Number(p.knownValueUsd))}
                        </td>
                        <td className="px-3 py-2 text-right">{p.transferCount}</td>
                        <td className="px-3 py-2 text-xs">
                          {p.firstTransferTs.toISOString().slice(0, 10)} → {p.lastTransferTs.toISOString().slice(0, 10)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          );
        })
      )}

      {receivers.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-zinc-400">
            Enrolled receivers (observation-only)
          </h2>
          <div className="overflow-x-auto rounded-xl border border-zinc-800">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-zinc-800 bg-zinc-900/70 text-xs text-zinc-400">
                <tr>
                  <th className="px-3 py-2">Receiver</th>
                  <th className="px-3 py-2">Class</th>
                  <th className="px-3 py-2 text-right">Known inflow</th>
                  <th className="px-3 py-2 text-right">Deployed into</th>
                  <th className="px-3 py-2">First receipt</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60">
                {receivers.map((r) => (
                  <tr key={r.id} className="hover:bg-zinc-900/40">
                    <td className="px-3 py-2">
                      <Link href={`/entity/${r.receiverAddress}`} className="font-mono text-xs text-sky-400 hover:underline">
                        {shortAddr(r.receiverAddress)}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-xs">{r.receiverClass.replaceAll('_', ' ')}</td>
                    <td className="px-3 py-2 text-right">
                      {r.totalKnownInflowUsd === null ? <span className="text-zinc-500">unknown</span> : fmtUsd(Number(r.totalKnownInflowUsd))}
                    </td>
                    <td className="px-3 py-2 text-right">{r.deployedTokenCount} token(s)</td>
                    <td className="px-3 py-2 text-xs">{r.firstReceiptTs.toISOString().slice(0, 10)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
