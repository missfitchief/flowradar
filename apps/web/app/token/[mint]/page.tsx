import Link from 'next/link';
import { notFound } from 'next/navigation';
import { prisma } from '@/lib/db';
import { fmtUsd } from '@/lib/format';
import {
  STATE_LABEL,
  STATE_DESCRIPTION,
  STATE_BADGE_CLASS,
  explainReason,
  shortAddr,
  fmtPct
} from '@/lib/rescue';
import { resolveTokenIdentity, solscanTokenUrl } from '@/lib/tokenIdentity';
import { CopyButton } from '@/components/CopyButton';

// FlowRadar — Token detail (rescue sprint): plain-English summary first,
// evidence grouped by independent entity, receipts under Advanced.
export const dynamic = 'force-dynamic';

interface BuyerEntry {
  address: string;
  entityKey: string;
  firstBuyTs: string | null;
  via: string;
  pricedEvidence?: boolean;
}

export default async function TokenDetailPage({ params }: { params: Promise<{ mint: string }> }) {
  const { mint } = await params;
  const candidate = await prisma.tokenCandidateScore.findUnique({
    where: { chain_mint: { chain: 'SOLANA', mint } }
  });
  const token = await prisma.token.findUnique({
    where: { chain_address: { chain: 'SOLANA', address: mint } },
    select: { id: true, symbol: true, name: true }
  });
  const meta = await prisma.tokenMetadata.findUnique({
    where: { chain_mint: { chain: 'SOLANA', mint } },
    select: { mint: true, name: true, symbol: true, logoUri: true, availability: true }
  });
  const identity = resolveTokenIdentity(mint, meta);
  const lifecycle = await prisma.tokenLifecycle.findUnique({
    where: { mint },
    select: { runnerClass: true, outcomeLabels: true }
  });
  if (!candidate && !token) notFound();

  const buyers: BuyerEntry[] = candidate ? ((candidate.buyersJson ?? []) as unknown as BuyerEntry[]) : [];
  const buyerAddresses = buyers.map((b) => b.address);
  const [dnaRows, replayEvents, dormancy, funding] = await Promise.all([
    prisma.walletDnaProfile.findMany({
      where: { chain: 'SOLANA', walletAddress: { in: buyerAddresses } },
      select: {
        walletAddress: true, completedPositions: true, winRate: true,
        evUsdPerCompletedPosition: true, repeatRunnerCount: true, coverage: true
      }
    }),
    prisma.replaySignalEvent.findMany({ where: { chain: 'SOLANA', mint }, orderBy: { eventKind: 'asc' } }),
    prisma.addressDormancyObservation.findMany({
      where: { chain: 'SOLANA', anchorKey: mint, overallClass: 'covered_dormant' },
      orderBy: { walletAddress: 'asc' },
      take: 20,
      select: { walletAddress: true, eventTs: true, maxCoveredDormantDays: true }
    }),
    prisma.fundingReactivationPath.findMany({
      where: { chain: 'SOLANA', anchorKey: mint, status: 'funded' },
      orderBy: { walletAddress: 'asc' },
      take: 20,
      select: { walletAddress: true, directFunderAddress: true, fundingToEventDelaySec: true, funderRelationshipTier: true }
    })
  ]);
  const dnaOf = new Map(dnaRows.map((d) => [d.walletAddress, d]));

  // Buyers grouped by independent entity.
  const byEntity = new Map<string, BuyerEntry[]>();
  for (const b of buyers) {
    const list = byEntity.get(b.entityKey) ?? [];
    list.push(b);
    byEntity.set(b.entityKey, list);
  }

  const behavior = candidate ? ((candidate.behaviorMixJson ?? {}) as Record<string, number>) : {};
  const outcomeLabels = Array.isArray(lifecycle?.outcomeLabels) ? (lifecycle?.outcomeLabels as string[]) : [];

  // Chronological timeline from real persisted timestamps.
  const timeline: { ts: string; text: string }[] = [];
  for (const b of buyers) {
    if (b.firstBuyTs) {
      timeline.push({ ts: b.firstBuyTs, text: `${shortAddr(b.address)} (${b.via.replaceAll('_', ' ')}) first bought` });
    }
  }
  for (const e of replayEvents) {
    timeline.push({
      ts: e.eventTs.toISOString(),
      text:
        e.eventKind === 'signal'
          ? `replay: SIGNAL fired — ${STATE_LABEL[e.stateAtEvent]} at score ${Math.round(e.scoreAtEvent)}`
          : `replay: best evaluation point (no signal) — ${STATE_LABEL[e.stateAtEvent]}`
    });
  }
  timeline.sort((a, b) => a.ts.localeCompare(b.ts));

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="flex flex-wrap items-center gap-3 text-xl font-semibold">
          {identity.logoUri && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={identity.logoUri} alt="" width={28} height={28} className="rounded-full" />
          )}
          {identity.isUnknown ? <span className="text-zinc-300">Unknown token</span> : identity.display}
          {identity.name && !identity.isUnknown && <span className="text-base font-normal text-zinc-400">{identity.name}</span>}
          {candidate && (
            <span className={`inline-block rounded px-2 py-0.5 text-sm ${STATE_BADGE_CLASS[candidate.state] ?? ''}`}>
              {STATE_LABEL[candidate.state] ?? candidate.state}
            </span>
          )}
        </h1>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <span className="font-mono text-xs text-zinc-500">{mint}</span>
          <CopyButton value={mint} label="Copy CA" />
          <a href={solscanTokenUrl(mint)} target="_blank" rel="noopener noreferrer" className="text-xs text-sky-400 hover:underline">
            Solscan ↗
          </a>
          {identity.isUnknown && <span className="text-xs text-zinc-500">(name/symbol not yet resolved — provider quota)</span>}
        </div>
        {candidate && (
          <p className="mt-2 max-w-3xl text-sm">
            {STATE_DESCRIPTION[candidate.state]} {candidate.reasonCodes.map(explainReason).join('; ')}.
            {lifecycle?.runnerClass === 'verified_above_10m' && ' This token is a VERIFIED historical $10M+ runner.'}
            {outcomeLabels.includes('rug_or_collapse') && ' Outcome: rug / collapse.'}
          </p>
        )}
      </div>

      {candidate && (
        <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
            <div className="text-lg font-semibold">
              {candidate.currentMcapUsd === null ? 'unknown' : fmtUsd(Number(candidate.currentMcapUsd))}
            </div>
            <div className="text-xs text-zinc-400">last observed market cap</div>
          </div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
            <div className="text-lg font-semibold">{Math.round(candidate.score)} / 100</div>
            <div className="text-xs text-zinc-400">shadow score · confidence {Math.round(candidate.confidence)}</div>
          </div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
            <div className="text-lg font-semibold">{candidate.independentEntityCount}</div>
            <div className="text-xs text-zinc-400">independent entities · {candidate.qualifiedBuyerCount} qualified buyers</div>
          </div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
            <div className="text-lg font-semibold">
              {candidate.dormantReactivations + candidate.fundedPathCount + candidate.altWalletEvidenceCount}
            </div>
            <div className="text-xs text-zinc-400">
              dormancy / funding / alt-wallet evidence items
            </div>
          </div>
        </section>
      )}

      {timeline.length > 0 && (
        <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-400">Timeline</h2>
          <ol className="mt-3 space-y-1.5 text-sm">
            {timeline.map((t, i) => (
              <li key={i} className="flex gap-3">
                <span className="whitespace-nowrap font-mono text-xs text-zinc-500">
                  {t.ts.slice(0, 16).replace('T', ' ')}Z
                </span>
                <span>{t.text}</span>
              </li>
            ))}
          </ol>
        </section>
      )}

      {byEntity.size > 0 && (
        <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-400">
            Buyers by independent entity
          </h2>
          <div className="mt-3 space-y-4">
            {[...byEntity.entries()].map(([entity, members]) => (
              <div key={entity}>
                <div className="text-xs font-medium text-zinc-400">
                  Entity {shortAddr(entity)} · {members.length} wallet(s)
                </div>
                <div className="mt-1 overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="text-xs text-zinc-500">
                      <tr>
                        <th className="py-1 pr-4">Wallet</th>
                        <th className="py-1 pr-4">Role</th>
                        <th className="py-1 pr-4">First buy</th>
                        <th className="py-1 pr-4">Historical WR</th>
                        <th className="py-1 pr-4">EV / position</th>
                        <th className="py-1">Prior runners</th>
                      </tr>
                    </thead>
                    <tbody>
                      {members.map((m) => {
                        const dna = dnaOf.get(m.address);
                        return (
                          <tr key={m.address} className="border-t border-zinc-800/60">
                            <td className="py-1.5 pr-4">
                              <Link href={`/entity/${m.address}`} className="font-mono text-xs text-sky-400 hover:underline">
                                {shortAddr(m.address)}
                              </Link>
                            </td>
                            <td className="py-1.5 pr-4 text-xs">
                              {m.via.replaceAll('_', ' ')}
                              {m.pricedEvidence === false && <span className="text-zinc-500"> (unpriced)</span>}
                            </td>
                            <td className="py-1.5 pr-4 text-xs">{m.firstBuyTs ? `${m.firstBuyTs.slice(0, 10)}` : 'unknown'}</td>
                            <td className="py-1.5 pr-4">{dna?.winRate === null || dna?.winRate === undefined ? '—' : fmtPct(dna.winRate)}</td>
                            <td className="py-1.5 pr-4">
                              {dna?.evUsdPerCompletedPosition === null || dna?.evUsdPerCompletedPosition === undefined
                                ? '—'
                                : fmtUsd(Number(dna.evUsdPerCompletedPosition))}
                            </td>
                            <td className="py-1.5">{dna?.repeatRunnerCount ?? '—'}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {(dormancy.length > 0 || funding.length > 0) && (
        <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-400">
            Dormancy &amp; funding evidence at the entries
          </h2>
          {dormancy.length > 0 && (
            <div className="mt-3 text-sm">
              <div className="text-xs font-medium text-zinc-400">Dormant wallets reactivating into this token:</div>
              <ul className="mt-1 space-y-1">
                {dormancy.map((d, i) => (
                  <li key={i}>
                    <Link href={`/entity/${d.walletAddress}`} className="font-mono text-xs text-sky-400 hover:underline">
                      {shortAddr(d.walletAddress)}
                    </Link>{' '}
                    <span className="text-xs text-zinc-400">
                      — dormant ≥{d.maxCoveredDormantDays ?? '?'}d before entering on {d.eventTs.toISOString().slice(0, 10)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {funding.length > 0 && (
            <div className="mt-3 text-sm">
              <div className="text-xs font-medium text-zinc-400">Funded entries (capital arrived before the buy):</div>
              <ul className="mt-1 space-y-1">
                {funding.map((f, i) => (
                  <li key={i} className="text-xs text-zinc-400">
                    <Link href={`/entity/${f.walletAddress}`} className="font-mono text-sky-400 hover:underline">
                      {shortAddr(f.walletAddress)}
                    </Link>
                    {' '}funded by{' '}
                    {f.directFunderAddress ? (
                      <Link href={`/entity/${f.directFunderAddress}`} className="font-mono text-sky-400 hover:underline">
                        {shortAddr(f.directFunderAddress)}
                      </Link>
                    ) : 'unknown'}
                    {f.fundingToEventDelaySec !== null &&
                      ` · ${Math.round(f.fundingToEventDelaySec / 3600)}h before the buy`}
                    {f.funderRelationshipTier && ` · ${f.funderRelationshipTier} link`}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      {Object.keys(behavior).length > 0 && (
        <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-400">Buy / sell behavior on this token</h2>
          <div className="mt-2 flex flex-wrap gap-2 text-xs">
            {Object.entries(behavior).map(([k, v]) => (
              <span key={k} className="rounded bg-zinc-800 px-2 py-1">
                {k.replaceAll('_', ' ')}: {v}
              </span>
            ))}
          </div>
        </section>
      )}

      {replayEvents.length > 0 && (
        <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 text-sm">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-400">Historical replay</h2>
          {replayEvents.map((e) => (
            <p key={e.id} className="mt-2">
              <Link href={`/proof/${e.id}`} className="text-sky-400 hover:underline">
                {e.eventKind === 'signal' ? 'Signal case' : 'No-signal case'} — {e.classification.replaceAll('_', ' ')} →
              </Link>
            </p>
          ))}
        </section>
      )}

      {candidate && (
        <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-400">Advanced evidence</h2>
          <p className="mt-2 text-xs text-zinc-400">Evidence completeness / caveats: {candidate.caveats.join(' · ')}</p>
          <p className="mt-2 text-xs text-zinc-500">Raw reason codes: {candidate.reasonCodes.join(', ')}</p>
          <pre className="mt-2 overflow-x-auto rounded bg-zinc-950 p-3 text-[11px] text-zinc-400">
            {JSON.stringify(candidate.receiptsJson, null, 2)}
          </pre>
        </section>
      )}
    </div>
  );
}
