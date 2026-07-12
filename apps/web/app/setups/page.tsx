import Link from 'next/link';
import { prisma } from '@/lib/db';
import { fmtUsd } from '@/lib/format';
import {
  STATE_LABEL,
  STATE_DESCRIPTION,
  STATE_BADGE_CLASS,
  explainReason,
  shortAddr,
  missingEvidence
} from '@/lib/rescue';

// FlowRadar — Active Setups (rescue sprint): the operator's default view.
// Qualified setups only — score-zero / insufficient-evidence records live in
// /watching, never here. Real persisted data only; observation-only always.
export const dynamic = 'force-dynamic';

const QUALIFIED_STATES = ['STEALTH_ACCUMULATION', 'EARLY_INDEPENDENT_CONFIRMATION'];
const WARNING_STATES = ['PUBLIC_KOL_ARRIVAL', 'CROWD_EXPANSION', 'DISTRIBUTION_RISK'];

function SetupCard({
  c,
  tokenMeta
}: {
  c: {
    mint: string;
    state: string;
    score: number;
    confidence: number;
    currentMcapUsd: unknown;
    currentMcapTs: Date | null;
    independentEntityCount: number;
    qualifiedBuyerCount: number;
    linkedAddressCount: number;
    dormantReactivations: number;
    fundedPathCount: number;
    receiverDeployments: number;
    kolContamination: number;
    nonCohortBuyerCount: number;
    behaviorMixJson: unknown;
    reasonCodes: string[];
    caveats: string[];
    updatedAt: Date;
  };
  tokenMeta: Map<string, { symbol: string | null; name: string | null }>;
}) {
  const meta = tokenMeta.get(c.mint);
  const behavior = (c.behaviorMixJson ?? {}) as Record<string, number>;
  const holding = (behavior.durable_hold ?? 0) + (behavior.still_holding ?? 0);
  const distributing =
    (behavior.full_exit ?? 0) + (behavior.fast_dump ?? 0) + (behavior.burst_exit ?? 0) + (behavior.staged_distribution ?? 0);
  const holdStatus =
    holding + distributing === 0
      ? 'no exit behavior observed yet'
      : distributing > holding
        ? `distributing (${distributing} of ${holding + distributing} tracked buyers exiting)`
        : `mostly holding (${holding} of ${holding + distributing} tracked buyers)`;
  const risks = c.caveats.filter((x) => !x.startsWith('shadow ranking') && !x.startsWith('candidate discovery') && !x.startsWith('observation-only'));

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-base font-semibold">
          {meta?.symbol ? `$${meta.symbol}` : shortAddr(c.mint)}
        </span>
        {meta?.name && meta.name !== meta.symbol && <span className="text-sm text-zinc-400">{meta.name}</span>}
        <Link href={`/token/${c.mint}`} className="font-mono text-xs text-sky-400 hover:underline" title={c.mint}>
          {shortAddr(c.mint)}
        </Link>
        <span className={`ml-auto inline-block rounded px-2 py-0.5 text-xs font-medium ${STATE_BADGE_CLASS[c.state] ?? ''}`}>
          {STATE_LABEL[c.state] ?? c.state}
        </span>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-sm md:grid-cols-4">
        <div><span className="text-zinc-400">Market cap: </span>{c.currentMcapUsd === null ? 'unknown' : fmtUsd(Number(c.currentMcapUsd))}</div>
        <div><span className="text-zinc-400">Score: </span><span className="font-semibold">{Math.round(c.score)}</span> / 100</div>
        <div><span className="text-zinc-400">Confidence: </span>{Math.round(c.confidence)} / 100</div>
        <div><span className="text-zinc-400">Updated: </span>{c.updatedAt.toISOString().slice(0, 16).replace('T', ' ')}Z</div>
        <div><span className="text-zinc-400">Independent entities: </span>{c.independentEntityCount}</div>
        <div><span className="text-zinc-400">Qualified buyers: </span>{c.qualifiedBuyerCount}</div>
        <div><span className="text-zinc-400">Linked addresses: </span>{c.linkedAddressCount}</div>
        <div><span className="text-zinc-400">Dormant reactivations: </span>{c.dormantReactivations}</div>
        <div><span className="text-zinc-400">Funded entries: </span>{c.fundedPathCount}</div>
        <div><span className="text-zinc-400">Receiver deployments: </span>{c.receiverDeployments}</div>
        <div><span className="text-zinc-400">KOL/crowd: </span>{c.kolContamination} KOL · {c.nonCohortBuyerCount} retail</div>
        <div><span className="text-zinc-400">Behavior: </span>{holdStatus}</div>
      </div>

      <p className="mt-3 text-sm">
        <span className="font-medium text-zinc-300">Why flagged: </span>
        {STATE_DESCRIPTION[c.state] ?? ''} {c.reasonCodes.map(explainReason).join('; ')}.
      </p>
      {risks.length > 0 && (
        <p className="mt-1 text-xs text-zinc-400">
          <span className="font-medium">Risks / missing evidence: </span>
          {risks.join(' · ')}
        </p>
      )}
      <div className="mt-3">
        <Link href={`/token/${c.mint}`} className="text-sm text-sky-400 hover:underline">
          Full evidence →
        </Link>
      </div>
    </div>
  );
}

export default async function SetupsPage() {
  const [qualified, warnings, staging, topWatching] = await Promise.all([
    prisma.tokenCandidateScore.findMany({
      where: { state: { in: QUALIFIED_STATES }, score: { gt: 0 } },
      orderBy: [{ score: 'desc' }, { mint: 'asc' }],
      take: 20
    }),
    prisma.tokenCandidateScore.findMany({
      where: { state: { in: WARNING_STATES } },
      orderBy: [{ updatedAt: 'desc' }, { mint: 'asc' }],
      take: 10
    }),
    prisma.receiverEnrollment.findMany({
      where: { deployedTokenCount: { gt: 0 } },
      orderBy: [{ deployedTokenCount: 'desc' }, { receiverAddress: 'asc' }],
      take: 8
    }),
    prisma.tokenCandidateScore.findMany({
      where: { state: 'WATCHING' },
      orderBy: [{ confidence: 'desc' }, { qualifiedBuyerCount: 'desc' }, { mint: 'asc' }],
      take: 5
    })
  ]);

  const allMints = [...new Set([...qualified, ...warnings, ...topWatching].map((c) => c.mint))];
  const tokenRows = await prisma.token.findMany({
    where: { chain: 'SOLANA', address: { in: allMints } },
    select: { address: true, symbol: true, name: true }
  });
  const tokenMeta = new Map(tokenRows.map((t) => [t.address, { symbol: t.symbol, name: t.name }]));

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-semibold">Active Setups</h1>
        <p className="mt-1 max-w-3xl text-sm text-zinc-400">
          Tokens where independently-acting qualified wallets (mined from historical $10M+ runners) are
          accumulating right now, in this database&apos;s observation window. Analytics only — nothing here is
          trading advice, and every wallet stays observation-only.
        </p>
      </div>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-zinc-400">Qualified setups</h2>
        {qualified.length === 0 ? (
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6">
            <p className="text-sm font-medium">No qualified live setups right now.</p>
            <p className="mt-1 text-sm text-zinc-400">
              A qualified setup needs at least two INDEPENDENT qualified entities buying with priceable evidence
              and no KOL/crowd contamination. The strongest watching records are below, with exactly what each
              one is missing.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {qualified.map((c) => (
              <SetupCard key={c.id} c={c} tokenMeta={tokenMeta} />
            ))}
          </div>
        )}
      </section>

      {staging.length > 0 && (
        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-zinc-400">Capital staging</h2>
          <p className="mb-3 text-xs text-zinc-500">
            Wallets that recently RECEIVED capital from qualified entities and already deployed it into tokens.
          </p>
          <div className="overflow-x-auto rounded-xl border border-zinc-800">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-zinc-800 bg-zinc-900/70 text-xs text-zinc-400">
                <tr>
                  <th className="px-3 py-2">Receiver</th>
                  <th className="px-3 py-2">Class at receipt</th>
                  <th className="px-3 py-2">Funded by</th>
                  <th className="px-3 py-2 text-right">Known inflow</th>
                  <th className="px-3 py-2 text-right">Tokens deployed into</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60">
                {staging.map((r) => (
                  <tr key={r.id} className="hover:bg-zinc-900/40">
                    <td className="px-3 py-2">
                      <Link href={`/entity/${r.receiverAddress}`} className="font-mono text-xs text-sky-400 hover:underline">
                        {shortAddr(r.receiverAddress)}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-xs">{r.receiverClass.replaceAll('_', ' ')}</td>
                    <td className="px-3 py-2 font-mono text-xs">{r.sourceWallets.slice(0, 2).map(shortAddr).join(', ')}</td>
                    <td className="px-3 py-2 text-right">
                      {r.totalKnownInflowUsd === null ? 'unknown' : fmtUsd(Number(r.totalKnownInflowUsd))}
                    </td>
                    <td className="px-3 py-2 text-right">{r.deployedTokenCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {warnings.length > 0 && (
        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-zinc-400">
            Late-stage / distribution warnings
          </h2>
          <div className="space-y-4">
            {warnings.map((c) => (
              <SetupCard key={c.id} c={c} tokenMeta={tokenMeta} />
            ))}
          </div>
        </section>
      )}

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-zinc-400">
          Strongest watching records
        </h2>
        <div className="space-y-3">
          {topWatching.map((c) => {
            const meta = tokenMeta.get(c.mint);
            const missing = missingEvidence(c);
            return (
              <div key={c.id} className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{meta?.symbol ? `$${meta.symbol}` : shortAddr(c.mint)}</span>
                  <Link href={`/token/${c.mint}`} className="font-mono text-xs text-sky-400 hover:underline">
                    {shortAddr(c.mint)}
                  </Link>
                  <span className="text-xs text-zinc-400">
                    {c.qualifiedBuyerCount} qualified buyer(s) · mcap{' '}
                    {c.currentMcapUsd === null ? 'unknown' : fmtUsd(Number(c.currentMcapUsd))}
                  </span>
                </div>
                <p className="mt-1 text-xs text-zinc-400">
                  <span className="font-medium text-zinc-300">Missing: </span>
                  {missing.length > 0 ? missing.join(' · ') : 'stronger independent-entity evidence'}
                </p>
              </div>
            );
          })}
        </div>
        <div className="mt-3">
          <Link href="/watching" className="text-sm text-sky-400 hover:underline">
            All watching records →
          </Link>
        </div>
      </section>
    </div>
  );
}
