import Link from 'next/link';
import { notFound } from 'next/navigation';
import { prisma } from '@/lib/db';
import { fmtUsd } from '@/lib/format';
import {
  CLASSIFICATION_LABEL,
  CLASSIFICATION_BADGE_CLASS,
  STATE_LABEL,
  STATE_DESCRIPTION,
  explainReason,
  shortAddr,
  fmtMult
} from '@/lib/rescue';

// FlowRadar — Historical Proof case detail (rescue sprint): exactly what the
// engine saw AT the historical moment, why it (did not) trigger, and the
// honestly-separated later outcome.
export const dynamic = 'force-dynamic';

export default async function ProofCasePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const e = await prisma.replaySignalEvent.findUnique({ where: { id } });
  if (!e) notFound();

  const token = await prisma.token.findUnique({
    where: { chain_address: { chain: 'SOLANA', address: e.mint } },
    select: { symbol: true, name: true }
  });
  const evidence = (e.evidenceAsOfJson ?? {}) as {
    buyers?: string[];
    crowdBuyersAtEvent?: number;
    stateReasons?: string[];
    evaluationPoints?: number;
  };
  const windows: { label: string; v: unknown }[] = [
    { label: '1 hour', v: e.mcapH1Usd },
    { label: '6 hours', v: e.mcapH6Usd },
    { label: '24 hours', v: e.mcapH24Usd },
    { label: '3 days', v: e.mcapD3Usd },
    { label: '7 days', v: e.mcapD7Usd }
  ];
  const atSignal = e.mcapAtSignalUsd === null ? null : Number(e.mcapAtSignalUsd);

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <Link href="/proof" className="text-sm text-sky-400 hover:underline">← Historical Proof</Link>
        <h1 className="mt-2 flex flex-wrap items-center gap-3 text-xl font-semibold">
          {token?.symbol ? `$${token.symbol}` : shortAddr(e.mint)}
          <span className={`inline-block rounded px-2 py-0.5 text-sm ${CLASSIFICATION_BADGE_CLASS[e.classification] ?? ''}`}>
            {CLASSIFICATION_LABEL[e.classification] ?? e.classification}
          </span>
        </h1>
        <p className="mt-1 text-sm text-zinc-400">
          Evaluated at <span className="font-medium text-zinc-300">{e.eventTs.toISOString().replace('T', ' ').slice(0, 19)}Z</span> —
          using only evidence available at that moment ({e.cohortKind === 'runner' ? 'historical $10M+ runner' : 'matched control token'}).
          {' '}<Link href={`/token/${e.mint}`} className="text-sky-400 hover:underline">Token detail →</Link>
        </p>
      </div>

      <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-400">What the system saw at that moment</h2>
        <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-sm md:grid-cols-3">
          <div><span className="text-zinc-400">State: </span>{STATE_LABEL[e.stateAtEvent] ?? e.stateAtEvent}</div>
          <div><span className="text-zinc-400">Score: </span>{Math.round(e.scoreAtEvent)} / 100</div>
          <div><span className="text-zinc-400">Market cap: </span>{atSignal === null ? 'unknown' : fmtUsd(atSignal)}</div>
          <div><span className="text-zinc-400">Independent entities: </span>{e.independentEntitiesAtEvent}</div>
          <div><span className="text-zinc-400">Qualified buyers: </span>{e.buyersAtEvent}</div>
          <div><span className="text-zinc-400">Dormant reactivations: </span>{e.dormantReactivationsAtEvent}</div>
          <div><span className="text-zinc-400">Funded entries: </span>{e.fundedPathsAtEvent}</div>
          <div><span className="text-zinc-400">KOL buyers: </span>{e.kolContaminationAtEvent}</div>
          <div><span className="text-zinc-400">Retail buyers so far: </span>{evidence.crowdBuyersAtEvent ?? 0}</div>
        </div>
        <p className="mt-3 text-sm">
          <span className="font-medium">Why: </span>
          {STATE_DESCRIPTION[e.stateAtEvent] ?? ''} {e.reasonCodes.map(explainReason).join('; ')}.
        </p>
        {(evidence.buyers?.length ?? 0) > 0 && (
          <div className="mt-3 text-sm">
            <span className="text-zinc-400">Buyers at that moment: </span>
            {evidence.buyers!.map((b) => (
              <Link key={b} href={`/entity/${b}`} className="mr-2 font-mono text-xs text-sky-400 hover:underline">
                {shortAddr(b)}
              </Link>
            ))}
          </div>
        )}
      </section>

      <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-400">What happened afterwards</h2>
        <p className="mt-1 text-xs text-zinc-500">Recorded separately — outcome data never influenced the evaluation above.</p>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-zinc-400">
              <tr>
                <th className="py-1 pr-6">Window</th>
                <th className="py-1 pr-6">Market cap</th>
                <th className="py-1">vs signal</th>
              </tr>
            </thead>
            <tbody>
              {windows.map((w) => {
                const v = w.v === null ? null : Number(w.v);
                return (
                  <tr key={w.label} className="border-t border-zinc-800/60">
                    <td className="py-1.5 pr-6">{w.label}</td>
                    <td className="py-1.5 pr-6">{v === null ? <span className="text-zinc-500">not covered</span> : fmtUsd(v)}</td>
                    <td className="py-1.5">{fmtMult(atSignal, v) ?? '—'}</td>
                  </tr>
                );
              })}
              <tr className="border-t border-zinc-800/60 font-medium">
                <td className="py-1.5 pr-6">Peak after signal</td>
                <td className="py-1.5 pr-6">
                  {e.maxLaterMcapUsd === null ? <span className="text-zinc-500">not covered</span> : fmtUsd(Number(e.maxLaterMcapUsd))}
                </td>
                <td className="py-1.5 text-emerald-400">
                  {fmtMult(atSignal, e.maxLaterMcapUsd === null ? null : Number(e.maxLaterMcapUsd)) ?? '—'}
                </td>
              </tr>
              <tr className="border-t border-zinc-800/60">
                <td className="py-1.5 pr-6">Max drawdown after signal</td>
                <td className="py-1.5 pr-6" colSpan={2}>
                  {e.maxDrawdownPct === null ? <span className="text-zinc-500">not covered</span> : `${e.maxDrawdownPct.toFixed(1)}%`}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-400">Advanced evidence</h2>
        <p className="mt-2 text-xs text-zinc-400">Caveats: {e.caveats.join(' · ')}</p>
        <p className="mt-2 text-xs text-zinc-500">
          Raw reason codes: {e.reasonCodes.join(', ')} · evaluation points walked: {evidence.evaluationPoints ?? 'n/a'} ·
          engine v{e.engineVersion} · computed {e.computedAt.toISOString().slice(0, 19)}Z
        </p>
      </section>
    </div>
  );
}
