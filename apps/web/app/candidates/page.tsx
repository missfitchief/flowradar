import { prisma } from '@/lib/db';
import { fmtUsd } from '@/lib/format';

// FlowRadar — /candidates page (working-loop milestone).
//
// Renders the AUTOMATIC token-candidate feed produced by the runner-mining
// working loop: historical $10M+ runners -> top-PnL wallets -> local
// validation -> dormancy/entity/funding analysis -> capital-outflow
// tracking -> receiver enrollment -> candidate discovery. Everything shown
// here is real persisted evidence (token_candidate_scores +
// wallet_dna_profiles + receiver_enrollments) — no mock data, no live
// polling, observation-only end to end. The score is a SHADOW ranking
// (documented deterministic weights) — NOT a FlowScore; nothing on this
// page feeds signals, thresholds, or eligibility.
export const dynamic = 'force-dynamic';

const STATE_STYLES: Record<string, string> = {
  WATCHING: 'bg-zinc-500/15 text-zinc-300',
  STEALTH_ACCUMULATION: 'bg-emerald-500/15 text-emerald-300',
  EARLY_INDEPENDENT_CONFIRMATION: 'bg-sky-500/15 text-sky-300',
  PUBLIC_KOL_ARRIVAL: 'bg-amber-500/15 text-amber-300',
  CROWD_EXPANSION: 'bg-orange-500/15 text-orange-300',
  DISTRIBUTION_RISK: 'bg-red-500/15 text-red-300',
  INVALIDATED: 'bg-red-900/30 text-red-400 line-through'
};

function StateBadge({ state }: { state: string }) {
  return (
    <span
      className={`inline-block rounded px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap ${STATE_STYLES[state] ?? 'bg-zinc-500/15 text-zinc-300'}`}
    >
      {state.replaceAll('_', ' ')}
    </span>
  );
}

function shortAddr(a: string): string {
  return a.length > 12 ? `${a.slice(0, 5)}…${a.slice(-4)}` : a;
}

export default async function CandidatesPage() {
  const [candidates, dnaCount, dnaWithCompleted, receivers, outflowTiers] = await Promise.all([
    prisma.tokenCandidateScore.findMany({
      orderBy: [{ score: 'desc' }, { mint: 'asc' }],
      take: 100
    }),
    prisma.walletDnaProfile.count(),
    prisma.walletDnaProfile.count({ where: { completedPositions: { gt: 0 } } }),
    prisma.receiverEnrollment.groupBy({ by: ['receiverClass'], _count: { _all: true } }),
    prisma.capitalOutflowPath.groupBy({ by: ['evidenceTier'], _count: { _all: true } })
  ]);

  const receiverTotal = receivers.reduce((a, g) => a + g._count._all, 0);
  const outflowTotal = outflowTiers.reduce((a, g) => a + g._count._all, 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Token Candidates</h1>
        <p className="mt-1 text-sm text-zinc-400">
          Automatic candidate feed from the runner-mining working loop: qualified wallets (mined from
          historical $10M+ runners), their linked/enrolled receivers, and where that capital deploys next.
          Shadow ranking only — observation_only, never a FlowScore, never signal-eligible.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
          <div className="text-2xl font-semibold">{candidates.length}</div>
          <div className="text-xs text-zinc-400">candidate tokens (top 100 by score)</div>
        </div>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
          <div className="text-2xl font-semibold">{dnaCount}</div>
          <div className="text-xs text-zinc-400">
            qualified wallets (Wallet DNA) · {dnaWithCompleted} with completed positions
          </div>
        </div>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
          <div className="text-2xl font-semibold">{receiverTotal}</div>
          <div className="text-xs text-zinc-400">
            enrolled receivers ·{' '}
            {receivers.map((g) => `${g.receiverClass.replaceAll('_', ' ')}: ${g._count._all}`).join(' · ') || 'none'}
          </div>
        </div>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
          <div className="text-2xl font-semibold">{outflowTotal}</div>
          <div className="text-xs text-zinc-400">
            capital outflow paths ·{' '}
            {outflowTiers.map((g) => `${g.evidenceTier.replaceAll('_', ' ')}: ${g._count._all}`).join(' · ') || 'none'}
          </div>
        </div>
      </div>

      {candidates.length === 0 ? (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-6 text-sm text-zinc-400">
          No candidates persisted yet — run the working-loop pilot
          (<code className="text-zinc-300">scripts/runner-candidates-pilot.mts</code>) against the pilot DB.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-zinc-800">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-zinc-800 bg-zinc-900/70 text-xs text-zinc-400">
              <tr>
                <th className="px-3 py-2">Token</th>
                <th className="px-3 py-2">State</th>
                <th className="px-3 py-2 text-right">Score</th>
                <th className="px-3 py-2 text-right">Mcap (observed)</th>
                <th className="px-3 py-2 text-right">Indep. entities</th>
                <th className="px-3 py-2 text-right">Qualified buyers</th>
                <th className="px-3 py-2 text-right">Dormant react.</th>
                <th className="px-3 py-2 text-right">Funded paths</th>
                <th className="px-3 py-2 text-right">Receiver deploys</th>
                <th className="px-3 py-2 text-right">KOL cont.</th>
                <th className="px-3 py-2 text-right">Crowd</th>
                <th className="px-3 py-2 text-right">Conf.</th>
                <th className="px-3 py-2">Stealth engine</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/60">
              {candidates.map((c) => (
                <tr key={c.id} className="hover:bg-zinc-900/40">
                  <td className="px-3 py-2 font-mono text-xs" title={c.mint}>
                    {shortAddr(c.mint)}
                  </td>
                  <td className="px-3 py-2">
                    <StateBadge state={c.state} />
                  </td>
                  <td className="px-3 py-2 text-right font-semibold">{Math.round(c.score)}</td>
                  <td className="px-3 py-2 text-right">
                    {c.currentMcapUsd === null ? (
                      <span className="text-zinc-500">unknown</span>
                    ) : (
                      fmtUsd(Number(c.currentMcapUsd))
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">{c.independentEntityCount}</td>
                  <td className="px-3 py-2 text-right">{c.qualifiedBuyerCount}</td>
                  <td className="px-3 py-2 text-right">{c.dormantReactivations}</td>
                  <td className="px-3 py-2 text-right">{c.fundedPathCount}</td>
                  <td className="px-3 py-2 text-right">{c.receiverDeployments}</td>
                  <td className={`px-3 py-2 text-right ${c.kolContamination > 0 ? 'text-amber-400' : ''}`}>
                    {c.kolContamination}
                  </td>
                  <td className="px-3 py-2 text-right">{c.nonCohortBuyerCount}</td>
                  <td className="px-3 py-2 text-right text-zinc-400">{Math.round(c.confidence)}</td>
                  <td className="px-3 py-2 text-xs text-zinc-400">
                    {c.stealthEngineState ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-zinc-500">
        States derive from mining evidence (stateBasis: mining_derived); the “Stealth engine” column shows the
        live stealth engine&apos;s own latest persisted state side by side when it exists. Unknown values are
        shown as unknown — never fabricated. All wallets referenced stay observation_only.
      </p>
    </div>
  );
}
