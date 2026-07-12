import Link from 'next/link';
import { notFound } from 'next/navigation';
import { prisma } from '@/lib/db';
import { fmtUsd } from '@/lib/format';
import { shortAddr, fmtPct } from '@/lib/rescue';

// FlowRadar — Wallet / Entity detail (rescue sprint): verified history,
// completed positions, quality metrics, dormancy events, funders/links,
// capital movements and current exposures — with coverage warnings.
export const dynamic = 'force-dynamic';

interface TokenPosition {
  tokenAddress: string;
  buyCount: number;
  sellCount: number;
  buyUsd: number;
  sellUsd: number;
  firstBuyTs: string | null;
  exitRatio: number | null;
  fullExitSec: number | null;
  stillHolding: boolean;
  receivedNotBought: boolean;
  entryMcap: number | null;
}

export default async function EntityDetailPage({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  const dna = await prisma.walletDnaProfile.findUnique({
    where: { chain_walletAddress: { chain: 'SOLANA', walletAddress: address } }
  });
  const behavior = await prisma.walletBehaviorProfile.findUnique({
    where: { chain_walletAddress: { chain: 'SOLANA', walletAddress: address } },
    select: { profileJson: true }
  });
  const enrollment = await prisma.receiverEnrollment.findUnique({
    where: { chain_receiverAddress: { chain: 'SOLANA', receiverAddress: address } }
  });
  // Roles are loaded early so a role-only address (e.g. an operator root with
  // no local DNA) still resolves instead of 404-ing, and so its entity panel
  // can be found via the role's entityKey.
  const roleRows = await prisma.walletRoleAssignment.findMany({
    where: { chain: 'SOLANA', walletAddress: address },
    orderBy: { confidence: 'desc' },
    select: { role: true, evidenceTier: true, confidence: true, reasonCodes: true, entityKey: true }
  });
  const entityKeyForAddr = roleRows[0]?.entityKey ?? address;
  const entityRow =
    (await prisma.entityDnaProfile.findUnique({ where: { chain_entityKey: { chain: 'SOLANA', entityKey: address } } })) ??
    (entityKeyForAddr !== address
      ? await prisma.entityDnaProfile.findUnique({ where: { chain_entityKey: { chain: 'SOLANA', entityKey: entityKeyForAddr } } })
      : null);
  if (!dna && !behavior && !enrollment && !entityRow && roleRows.length === 0) notFound();

  const profile = (behavior?.profileJson ?? null) as unknown as {
    local?: { tokenPositions?: TokenPosition[] };
    localViewTruncated?: boolean;
  } | null;
  const positions = (profile?.local?.tokenPositions ?? []).filter((p) => p.firstBuyTs !== null || p.receivedNotBought);

  // Trade-level honesty (same rule as the DNA builder): a token with ANY
  // unpriced BUY/SELL leg has an unknown cost basis — its result is never
  // rendered as a concrete win/loss number.
  const walletRow = await prisma.wallet.findUnique({
    where: { address_chain: { address, chain: 'SOLANA' } },
    select: { id: true }
  });
  const tokensWithUnpricedLegs = new Set<string>(
    walletRow
      ? (
          await prisma.walletTokenTrade.findMany({
            where: { walletId: walletRow.id, chain: 'SOLANA', action: { in: ['BUY', 'SELL'] }, amountUsd: 0 },
            select: { token: { select: { address: true } } },
            distinct: ['tokenId'],
            take: 5000
          })
        ).map((t) => t.token.address)
      : []
  );

  const [dormancyEvents, outflows, inflowsAsReceiver, topPnl, lifecycles] = await Promise.all([
    prisma.addressDormancyObservation.findMany({
      where: { chain: 'SOLANA', walletAddress: address, overallClass: 'covered_dormant' },
      orderBy: { eventTs: 'asc' },
      take: 15,
      select: { anchorKey: true, eventTs: true, maxCoveredDormantDays: true }
    }),
    prisma.capitalOutflowPath.findMany({
      where: { chain: 'SOLANA', sourceWallet: address },
      orderBy: [{ firstTransferTs: 'asc' }],
      take: 15
    }),
    prisma.capitalOutflowPath.findMany({
      where: { chain: 'SOLANA', destinationAddress: address },
      orderBy: [{ firstTransferTs: 'asc' }],
      take: 15,
      select: { sourceWallet: true, evidenceTier: true, knownValueUsd: true, firstTransferTs: true, receiverRelationshipTier: true }
    }),
    prisma.tokenTopPnlCandidate.findMany({
      where: { chain: 'SOLANA', walletAddress: address },
      orderBy: [{ mint: 'asc' }, { source: 'asc' }],
      take: 30,
      select: { mint: true, source: true, validation: true, providerRank: true }
    }),
    prisma.tokenLifecycle.findMany({
      where: { mint: { in: positions.map((p) => p.tokenAddress).slice(0, 200) } },
      select: { mint: true, runnerClass: true, outcomeLabels: true }
    })
  ]);
  const lifecycleOf = new Map(lifecycles.map((l) => [l.mint, l]));

  const openPositions = positions.filter((p) => p.stillHolding);

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <Link href="/entities" className="text-sm text-sky-400 hover:underline">← Wallets / Entities</Link>
        <h1 className="mt-2 text-xl font-semibold">Wallet {shortAddr(address)}</h1>
        <p className="mt-1 font-mono text-xs text-zinc-500">{address}</p>
        <p className="mt-1 text-xs text-zinc-400">
          Status: observation-only{enrollment ? ` · enrolled receiver (${enrollment.receiverClass.replaceAll('_', ' ')})` : ''}.
          {profile?.localViewTruncated && ' Coverage warning: the local trade view is TRUNCATED — metrics understate activity.'}
        </p>
        {roleRows.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {roleRows.map((r) => (
              <span
                key={r.role}
                className="rounded bg-zinc-800 px-2 py-1 text-xs"
                title={`${r.evidenceTier.replaceAll('_', ' ')} · ${r.reasonCodes.join(', ')}`}
              >
                {r.role.replaceAll('_', ' ')} <span className="text-zinc-500">({Math.round(r.confidence)})</span>
              </span>
            ))}
          </div>
        )}
        {roleRows[0]?.entityKey && roleRows[0].entityKey !== address && (
          <p className="mt-1 text-xs text-zinc-500">
            Part of entity{' '}
            <Link href={`/entity/${roleRows[0].entityKey}`} className="font-mono text-sky-400 hover:underline">
              {shortAddr(roleRows[0].entityKey)}
            </Link>{' '}
            — probabilistic on-chain linkage, never an identity claim.
          </p>
        )}
      </div>

      {dna && (
        <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
            <div className="text-lg font-semibold">
              {dna.winRate === null ? 'unknown' : fmtPct(dna.winRate)}
            </div>
            <div className="text-xs text-zinc-400">win rate over {dna.completedPositions} completed ({dna.winCount}W / {dna.lossCount}L)</div>
          </div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
            <div className="text-lg font-semibold">
              {dna.evUsdPerCompletedPosition === null ? 'unknown' : fmtUsd(Number(dna.evUsdPerCompletedPosition))}
            </div>
            <div className="text-xs text-zinc-400">
              expectancy / completed position · total realized{' '}
              {dna.totalRealizedPnlUsd === null ? 'unknown' : fmtUsd(Number(dna.totalRealizedPnlUsd))}
            </div>
          </div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
            <div className="text-lg font-semibold">{dna.repeatRunnerCount ?? 'unknown'}</div>
            <div className="text-xs text-zinc-400">
              verified runners won · one-winner dependence{' '}
              {dna.oneWinnerDependence === null ? 'n/a' : fmtPct(dna.oneWinnerDependence)}
            </div>
          </div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
            <div className="text-lg font-semibold">{dna.tokensEntered}</div>
            <div className="text-xs text-zinc-400">
              tokens entered · {dna.openPositions} open · {dna.unpricedPositions} unpriceable · coverage {dna.coverage}
            </div>
          </div>
        </section>
      )}

      {positions.length > 0 && (
        <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-400">
            Token history ({positions.length} positions, verified local evidence)
          </h2>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-zinc-400">
                <tr>
                  <th className="py-1 pr-4">Token</th>
                  <th className="py-1 pr-4">Outcome class</th>
                  <th className="py-1 pr-4 text-right">Bought</th>
                  <th className="py-1 pr-4 text-right">Sold</th>
                  <th className="py-1 pr-4 text-right">Result</th>
                  <th className="py-1 pr-4 text-right">Entry mcap</th>
                  <th className="py-1">Status</th>
                </tr>
              </thead>
              <tbody>
                {positions.slice(0, 50).map((p) => {
                  const lc = lifecycleOf.get(p.tokenAddress);
                  const labels = Array.isArray(lc?.outcomeLabels) ? (lc?.outcomeLabels as string[]) : [];
                  const outcome =
                    lc?.runnerClass === 'verified_above_10m'
                      ? 'runner ($10M+)'
                      : labels.includes('rug_or_collapse')
                        ? 'rug'
                        : labels.includes('failed_launch')
                          ? 'dead'
                          : 'unresolved';
                  const completed = p.exitRatio !== null && p.exitRatio >= 0.95 && p.fullExitSec !== null;
                  const priced = p.buyUsd > 0 && !tokensWithUnpricedLegs.has(p.tokenAddress);
                  const proxy = p.sellUsd - p.buyUsd;
                  return (
                    <tr key={p.tokenAddress} className="border-t border-zinc-800/60">
                      <td className="py-1.5 pr-4">
                        <Link href={`/token/${p.tokenAddress}`} className="font-mono text-xs text-sky-400 hover:underline">
                          {shortAddr(p.tokenAddress)}
                        </Link>
                      </td>
                      <td className="py-1.5 pr-4 text-xs">{outcome}</td>
                      <td className="py-1.5 pr-4 text-right">{priced ? fmtUsd(p.buyUsd) : 'unpriced'}</td>
                      <td className="py-1.5 pr-4 text-right">{p.sellUsd > 0 ? fmtUsd(p.sellUsd) : p.sellCount > 0 ? 'unpriced' : '—'}</td>
                      <td className={`py-1.5 pr-4 text-right ${completed && priced ? (proxy > 0 ? 'text-emerald-400' : proxy < 0 ? 'text-red-400' : '') : 'text-zinc-500'}`}>
                        {completed && priced ? fmtUsd(proxy) : p.stillHolding ? 'open' : 'incomplete'}
                      </td>
                      <td className="py-1.5 pr-4 text-right text-xs">
                        {p.entryMcap !== null && p.entryMcap > 0 ? fmtUsd(p.entryMcap) : 'unknown'}
                      </td>
                      <td className="py-1.5 text-xs">
                        {p.receivedNotBought ? 'received, not bought' : p.stillHolding ? 'holding' : completed ? 'fully exited' : 'partial'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {positions.length > 50 && <p className="mt-2 text-xs text-zinc-500">Showing 50 of {positions.length} positions.</p>}
        </section>
      )}

      {dormancyEvents.length > 0 && (
        <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 text-sm">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-400">Dormancy / reactivation events</h2>
          <ul className="mt-2 space-y-1 text-xs text-zinc-400">
            {dormancyEvents.map((d, i) => (
              <li key={i}>
                dormant ≥{d.maxCoveredDormantDays ?? '?'} days, then entered{' '}
                <Link href={`/token/${d.anchorKey}`} className="font-mono text-sky-400 hover:underline">
                  {shortAddr(d.anchorKey)}
                </Link>{' '}
                on {d.eventTs.toISOString().slice(0, 10)}
              </li>
            ))}
          </ul>
        </section>
      )}

      {(inflowsAsReceiver.length > 0 || outflows.length > 0) && (
        <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 text-sm">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-400">Capital movements</h2>
          {inflowsAsReceiver.length > 0 && (
            <div className="mt-2">
              <div className="text-xs font-medium text-zinc-400">Received from qualified wallets:</div>
              <ul className="mt-1 space-y-1 text-xs text-zinc-400">
                {inflowsAsReceiver.map((f, i) => (
                  <li key={i}>
                    <Link href={`/entity/${f.sourceWallet}`} className="font-mono text-sky-400 hover:underline">
                      {shortAddr(f.sourceWallet)}
                    </Link>{' '}
                    → this wallet · {f.knownValueUsd === null ? 'unknown value' : fmtUsd(Number(f.knownValueUsd))} ·{' '}
                    {f.evidenceTier.replaceAll('_', ' ')} · {f.firstTransferTs.toISOString().slice(0, 10)}
                    {f.receiverRelationshipTier && ` · ${f.receiverRelationshipTier} pre-existing link`}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {outflows.length > 0 && (
            <div className="mt-3">
              <div className="text-xs font-medium text-zinc-400">Capital sent out:</div>
              <ul className="mt-1 space-y-1 text-xs text-zinc-400">
                {outflows.map((f, i) => (
                  <li key={i}>
                    → {f.destinationType === 'wallet' ? (
                      <Link href={`/entity/${f.destinationAddress}`} className="font-mono text-sky-400 hover:underline">
                        {shortAddr(f.destinationAddress)}
                      </Link>
                    ) : (
                      <span className="font-mono">{shortAddr(f.destinationAddress)} ({f.destinationType})</span>
                    )}{' '}
                    · {f.knownValueUsd === null ? 'unknown value' : fmtUsd(Number(f.knownValueUsd))} ·{' '}
                    {f.evidenceTier.replaceAll('_', ' ')} · receiver was {f.receiverClassAtReceipt.replaceAll('_', ' ')}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      {openPositions.length > 0 && (
        <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 text-sm">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-400">Current token exposures (still holding)</h2>
          <div className="mt-2 flex flex-wrap gap-2">
            {openPositions.slice(0, 20).map((p) => (
              <Link
                key={p.tokenAddress}
                href={`/token/${p.tokenAddress}`}
                className="rounded bg-zinc-800 px-2 py-1 font-mono text-xs text-sky-400 hover:underline"
              >
                {shortAddr(p.tokenAddress)}
              </Link>
            ))}
          </div>
        </section>
      )}

      {entityRow && entityRow.memberCount > 1 && (
        <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 text-sm">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-400">
            Entity ({entityRow.memberCount} linked wallets)
          </h2>
          <p className="mt-1 text-xs text-zinc-500">
            Entity-adjusted quality — win rate {entityRow.winRate === null ? 'unknown' : fmtPct(entityRow.winRate)},{' '}
            {entityRow.completedPositions} completed, realized{' '}
            {entityRow.totalRealizedPnlUsd === null ? 'unknown' : fmtUsd(Number(entityRow.totalRealizedPnlUsd))}. Linked
            wallets count once, not {entityRow.memberCount} times.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {entityRow.memberWallets.slice(0, 30).map((m) => (
              <Link key={m} href={`/entity/${m}`} className="rounded bg-zinc-800 px-2 py-1 font-mono text-xs text-sky-400 hover:underline">
                {shortAddr(m)}
              </Link>
            ))}
          </div>
        </section>
      )}

      <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-400">Advanced evidence</h2>
        <p className="mt-2 text-xs text-zinc-400">
          Discovery: {topPnl.length} top-PnL candidate row(s) —{' '}
          {topPnl.slice(0, 5).map((t) => `${shortAddr(t.mint)} (${t.validation}${t.source === 'birdeye_top_traders' ? ', provider' : ', local'})`).join('; ')}
          {topPnl.length > 5 ? ` and ${topPnl.length - 5} more` : ''}
        </p>
        {dna && <p className="mt-2 text-xs text-zinc-500">Caveats: {dna.caveats.join(' · ')}</p>}
      </section>
    </div>
  );
}
