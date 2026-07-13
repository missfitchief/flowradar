import Link from 'next/link';
import { prisma } from '@/lib/db';
import { fmtUsd } from '@/lib/format';
import {
  CLASSIFICATION_LABEL,
  CLASSIFICATION_BADGE_CLASS,
  STATE_LABEL,
  explainReason,
  shortAddr,
  fmtMult
} from '@/lib/rescue';
import { resolveTokenIdentity } from '@/lib/tokenIdentity';

// FlowRadar — Historical Proof (rescue sprint): what the system WOULD have
// shown at the historical moment, evaluated with no lookahead, with the
// later outcome recorded separately. Successes, misses and controls are all
// visible — this page never shows only the winner list.
export const dynamic = 'force-dynamic';

export default async function ProofPage() {
  const events = await prisma.replaySignalEvent.findMany({
    where: { chain: 'SOLANA' },
    orderBy: [{ eventKind: 'asc' }, { scoreAtEvent: 'desc' }, { mint: 'asc' }],
    take: 100
  });
  const metaOf = new Map(
    (await prisma.tokenMetadata.findMany({ where: { chain: 'SOLANA', mint: { in: events.map((e) => e.mint) } }, select: { mint: true, name: true, symbol: true, logoUri: true, availability: true } })).map((m) => [m.mint, m])
  );

  const counts: Record<string, number> = {};
  for (const e of events) counts[e.classification] = (counts[e.classification] ?? 0) + 1;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Historical Proof</h1>
        <p className="mt-1 max-w-3xl text-sm text-zinc-400">
          This page checks what FlowRadar would have known at that historical moment, before the later outcome
          occurred. At each evaluation moment the engine saw ONLY evidence available then; what happened afterwards is
          recorded separately. Catches, misses, false alerts and correct rejections are all shown — this is
          validation, not marketing. Click any case for the full explanation.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {(['true_positive', 'miss', 'false_positive', 'true_negative'] as const).map((k) => (
          <div key={k} className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
            <div className="text-2xl font-semibold">{counts[k] ?? 0}</div>
            <div className="text-xs text-zinc-400">{CLASSIFICATION_LABEL[k]}</div>
          </div>
        ))}
      </div>

      <div className="space-y-3">
        {events.map((e) => {
          const mult = fmtMult(
            e.mcapAtSignalUsd === null ? null : Number(e.mcapAtSignalUsd),
            e.maxLaterMcapUsd === null ? null : Number(e.maxLaterMcapUsd)
          );
          return (
            <Link
              key={e.id}
              href={`/proof/${e.id}`}
              className="block rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 transition-colors hover:bg-zinc-900"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{resolveTokenIdentity(e.mint, metaOf.get(e.mint)).display}</span>
                <span className="font-mono text-xs text-zinc-500">{shortAddr(e.mint)}</span>
                <span className={`inline-block rounded px-2 py-0.5 text-xs ${CLASSIFICATION_BADGE_CLASS[e.classification] ?? ''}`}>
                  {CLASSIFICATION_LABEL[e.classification] ?? e.classification}
                </span>
                <span className="ml-auto text-xs text-zinc-400">
                  {e.eventTs.toISOString().slice(0, 16).replace('T', ' ')}Z
                </span>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-sm md:grid-cols-4">
                <div>
                  <span className="text-zinc-400">{e.eventKind === 'signal' ? 'At signal: ' : 'At best evaluation: '}</span>
                  {e.mcapAtSignalUsd === null ? 'mcap unknown' : fmtUsd(Number(e.mcapAtSignalUsd))}
                </div>
                <div>
                  <span className="text-zinc-400">{e.eventKind === 'signal' ? 'Peak after: ' : 'Peak afterwards: '}</span>
                  {e.maxLaterMcapUsd === null ? 'not covered' : fmtUsd(Number(e.maxLaterMcapUsd))}
                  {mult ? <span className="ml-1 text-emerald-400">({mult})</span> : null}
                </div>
                <div>
                  <span className="text-zinc-400">State: </span>
                  {STATE_LABEL[e.stateAtEvent] ?? e.stateAtEvent} · score {Math.round(e.scoreAtEvent)}
                </div>
                <div>
                  <span className="text-zinc-400">Entities: </span>
                  {e.independentEntitiesAtEvent} independent · {e.buyersAtEvent} buyers
                </div>
              </div>
              <p className="mt-2 text-sm text-zinc-300">
                {(() => {
                  const at = e.mcapAtSignalUsd === null ? null : Number(e.mcapAtSignalUsd);
                  const peak = e.maxLaterMcapUsd === null ? null : Number(e.maxLaterMcapUsd);
                  const flagged = e.eventKind === 'signal';
                  const moved = at !== null && peak !== null ? `It later moved from ${fmtUsd(at)} to ${fmtUsd(peak)}.` : '';
                  if (e.classification === 'miss') {
                    const why = e.independentEntitiesAtEvent < 2
                      ? `Only ${e.independentEntitiesAtEvent} qualified independent ${e.independentEntitiesAtEvent === 1 ? 'entity was' : 'entities were'} observed; the rule required 2.`
                      : `${e.independentEntitiesAtEvent} independent entities were observed, but another requirement blocked the signal (${e.reasonCodes.slice(0, 2).map(explainReason).join('; ') || 'see reason codes'}).`;
                    return `FlowRadar did not flag this token. ${moved} ${why}`;
                  }
                  if (e.classification === 'true_positive') {
                    return `FlowRadar would have flagged this at ${STATE_LABEL[e.stateAtEvent] ?? e.stateAtEvent} on ${e.independentEntitiesAtEvent} independent qualified entities. ${moved}`;
                  }
                  if (e.classification === 'false_positive') {
                    return `FlowRadar would have flagged this control token on ${e.independentEntitiesAtEvent} entities, but it did not run. ${moved}`;
                  }
                  return `FlowRadar correctly did not flag this control token. ${e.independentEntitiesAtEvent} independent ${e.independentEntitiesAtEvent === 1 ? 'entity' : 'entities'} observed; it did not meet the signal rule. ${moved}`;
                })()}
              </p>
              <p className="mt-1 text-xs text-zinc-500">{e.reasonCodes.slice(0, 3).map(explainReason).join('; ')}</p>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
