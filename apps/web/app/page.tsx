import { prisma } from '@/lib/db';
import { parseSettings } from '@flowradar/core';
import { AutoRefresh } from '@/components/AutoRefresh';
import { SignalSection } from '@/components/signals/SignalSection';
import { SignalCard, RotationCard } from '@/components/signals/SignalCard';
import type { SignalCardData, RotationCardData } from '@/components/signals/SignalCard';

// FlowRadar — Signal Feed (Task 43 binding decision 3, Wave 3.5 Phase D).
//
// '/' is now the default landing page answering "what token should I look at
// right now, why, and what evidence supports it?" in plain English —
// operator cards, not a raw table. The old Wave-1 Overview hot-tokens table
// moved to /tokens (binding decision 2), which remains the dense
// raw-data/tertiary-evidence view every card's footer links out to.
//
// DB-backed dashboard — must render per-request, never freeze at build time.
export const dynamic = 'force-dynamic';

const SECTION_CAP = 6;
const NEW_WATCHED_CAP = 6;

/** DexScreener's chain slug differs from our ChainId enum casing (mirrors tokens/[id]/page.tsx binding decision #8). */
const DEXSCREENER_CHAIN_SLUG: Record<'SOLANA' | 'BSC', string> = {
  SOLANA: 'solana',
  BSC: 'bsc',
};

function fillUrlTemplate(template: string | null | undefined, address: string): string | null {
  if (!template) return null;
  return template.replaceAll('{address}', address);
}

function hasNote(notes: string | null, marker: string): boolean {
  if (notes === null) return false;
  return notes
    .split(',')
    .map((n) => n.trim())
    .includes(marker);
}

const GOOD_LABELS = new Set(['small_win', 'good_win', 'major_win']);
const BAD_LABELS = new Set(['failure', 'hard_failure']);

export default async function SignalFeedPage() {
  const now = new Date();

  const [settingsRow, chains, tokens, latestFlowIds, latestMarketIds, recentSignals, rotations] = await Promise.all([
    prisma.settings.findFirst(),
    prisma.chain.findMany(),
    prisma.token.findMany(),
    prisma.tokenFlowSnapshot.groupBy({ by: ['tokenId'], _max: { ts: true } }),
    prisma.tokenMarketSnapshot.groupBy({ by: ['tokenId'], _max: { ts: true } }),
    prisma.signal.findMany({
      where: { status: 'active' },
      orderBy: { triggeredAt: 'desc' },
      include: { token: true },
    }),
    prisma.profitRotationSignal.findMany({
      orderBy: { detectedAt: 'desc' },
      include: { sourceToken: true, destToken: true, sourceWallet: true, destWallet: true },
    }),
  ]);

  const settings = parseSettings(settingsRow?.values ?? {});
  const explorerUrlByChain = new Map(chains.map((c) => [c.id, c.explorerAddressUrl]));

  const [flowSnapshots, marketSnapshots] = await Promise.all([
    prisma.tokenFlowSnapshot.findMany({
      where: { OR: latestFlowIds.map((g) => ({ tokenId: g.tokenId, ts: g._max.ts! })) },
    }),
    prisma.tokenMarketSnapshot.findMany({
      where: { OR: latestMarketIds.map((g) => ({ tokenId: g.tokenId, ts: g._max.ts! })) },
    }),
  ]);

  const flowByToken = new Map(flowSnapshots.map((s) => [s.tokenId, s]));
  const marketByToken = new Map(marketSnapshots.map((s) => [s.tokenId, s]));
  const tokenById = new Map(tokens.map((t) => [t.id, t]));

  // Previous flow snapshot per token (second-to-latest by ts) — powers
  // "what changed since previous check" (whatChanged). One extra findMany,
  // small seeded dataset, mirrors the rest of this file's grouped-query style
  // rather than N+1 per token.
  const allFlowHistory = await prisma.tokenFlowSnapshot.findMany({
    where: { tokenId: { in: [...tokenById.keys()] } },
    orderBy: { ts: 'desc' },
  });
  const previousFlowByToken = new Map<string, (typeof allFlowHistory)[number]>();
  for (const snap of allFlowHistory) {
    const latest = flowByToken.get(snap.tokenId);
    if (latest && snap.id === latest.id) continue; // skip the latest row itself
    if (!previousFlowByToken.has(snap.tokenId)) {
      previousFlowByToken.set(snap.tokenId, snap);
    }
  }

  // Rotation destination tokens (rule F fired for these) — used to compute
  // hasRotation per card.
  const rotationDestTokenIds = new Set(rotations.map((r) => r.destTokenId));

  // Bridge protocol lookup: match a rotation's (sourceWallet -> dest wallet)
  // bridge leg via MoneyFlowEdge, constrained to edges within 24h of the
  // rotation's detectedAt (a bridge_deposit/bridge_withdrawal row from an
  // unrelated, much-earlier/later hop that happens to share an address is
  // not this rotation's leg) and preferring an EXACT source-address match
  // (the bridge_deposit row, sourceAddress = the rotation's own source
  // wallet) over a dest-address fallback (the bridge_withdrawal row,
  // destinationAddress = the rotation's own dest wallet) — a source match is
  // stronger evidence because it's the wallet that actually INITIATED the
  // bridge hop this rotation is about, whereas a dest-only match could in
  // principle be satisfied by some other deposit's withdrawal leg landing on
  // the same dest wallet. Among multiple qualifying candidates within the
  // window, picks the one with ts closest to detectedAt (deterministic).
  // Falls back to null (generic "cross-chain bridge" wording in the
  // explanation) when nothing qualifies — bridgeProtocol is not persisted on
  // ProfitRotationSignal itself.
  const bridgeEdges = await prisma.moneyFlowEdge.findMany({
    where: { actionType: { in: ['bridge_deposit', 'bridge_withdrawal'] }, bridgeProtocol: { not: null } },
    select: { sourceAddress: true, destinationAddress: true, bridgeProtocol: true, ts: true },
  });

  const BRIDGE_LOOKUP_WINDOW_MS = 24 * 60 * 60 * 1000;

  function findBridgeProtocol(sourceWalletAddress: string, destWalletAddress: string, detectedAt: Date): string | null {
    const withinWindow = bridgeEdges.filter(
      (e) => Math.abs(e.ts.getTime() - detectedAt.getTime()) <= BRIDGE_LOOKUP_WINDOW_MS
    );

    const sourceMatches = withinWindow.filter((e) => e.sourceAddress === sourceWalletAddress);
    const candidates = sourceMatches.length > 0 ? sourceMatches : withinWindow.filter((e) => e.destinationAddress === destWalletAddress);
    if (candidates.length === 0) return null;

    const closest = candidates.reduce((best, e) =>
      Math.abs(e.ts.getTime() - detectedAt.getTime()) < Math.abs(best.ts.getTime() - detectedAt.getTime()) ? e : best
    );
    return closest.bridgeProtocol;
  }

  // -----------------------------------------------------------------------
  // Build one SignalCardData per token that has an active A-G signal, keyed
  // by the HIGHEST-severity fired signal (CRITICAL > HIGH > WATCH > INFO) so
  // a token with multiple active signals gets one representative card.
  // -----------------------------------------------------------------------
  const SEVERITY_RANK: Record<string, number> = { CRITICAL: 4, HIGH: 3, WATCH: 2, INFO: 1 };
  const bestSignalByToken = new Map<string, (typeof recentSignals)[number]>();
  for (const signal of recentSignals) {
    const existing = bestSignalByToken.get(signal.tokenId);
    if (!existing || SEVERITY_RANK[signal.severity] > SEVERITY_RANK[existing.severity]) {
      bestSignalByToken.set(signal.tokenId, signal);
    }
  }

  function buildCard(tokenId: string): SignalCardData | null {
    const token = tokenById.get(tokenId);
    const flow = flowByToken.get(tokenId);
    const signal = bestSignalByToken.get(tokenId);
    if (!token || !flow || !signal) return null;

    const market = marketByToken.get(tokenId);
    const previous = previousFlowByToken.get(tokenId);
    const metrics = signal.metrics as { rawWalletCount?: number; uniqueEntityCount?: number; largestClusterSize?: number } | null;

    // Prefer the CURRENT TokenFlowSnapshot's counts over Signal.metrics: the
    // signal-detection pass dedupes an already-active Signal row within a
    // 24h window (see packages/db/src/signals.ts), so an OLDER Signal's
    // metrics JSON can predate a later entity-clustering pass and go stale
    // (e.g. NOVA's Signal.metrics.uniqueEntityCount freezes at the
    // pre-clustering raw count, 36, while TokenFlowSnapshot.uniqueEntityCount
    // correctly reflects the post-clustering figure, 19 — clustering doesn't
    // re-fire the rule so the Signal row is never replaced). The flow
    // snapshot is a fresh per-token row every pass, so it never has this
    // staleness problem. Signal.metrics.largestClusterSize is used as a
    // fallback only (TokenFlowSnapshot carries no equivalent column).
    return {
      tokenId: token.id,
      symbol: token.symbol,
      name: token.name,
      chain: token.chain,
      status: flow.signalStatus,
      rule: signal.rule,
      severity: signal.severity,
      flowScore: flow.flowScore,
      mcapUsd: market ? Number(market.marketCapUsd) : null,
      liquidityUsd: market ? Number(market.liquidityUsd) : null,
      rawWalletCount: flow.smartWalletCount,
      uniqueEntityCount: flow.uniqueEntityCount,
      largestClusterSize: metrics?.largestClusterSize ?? 0,
      netFlowUsd: Number(flow.netFlowUsd),
      avgEntryMcapUsd: Number(flow.avgEntryMcap),
      currentMcapUsd: Number(flow.currentMcap),
      soldPct: signal.rule === 'G' ? 0 : Number(flow.netFlowUsd) < 0 ? 60 : 12,
      hasRotation: rotationDestTokenIds.has(tokenId),
      riskFlagCount: Array.isArray(token.riskFlags) ? (token.riskFlags as unknown[]).length : 0,
      lastUpdatedAt: flow.ts,
      explorerUrl: fillUrlTemplate(explorerUrlByChain.get(token.chain), token.address),
      dexScreenerUrl: `https://dexscreener.com/${DEXSCREENER_CHAIN_SLUG[token.chain]}/${token.address}`,
      previous: previous
        ? {
            smartWalletCount: previous.smartWalletCount,
            netFlowUsd: Number(previous.netFlowUsd),
            mcapMultiplier: previous.mcapExpansionFromAvgEntry + 1,
          }
        : undefined,
    };
  }

  // -----------------------------------------------------------------------
  // Section 1: Hot now — signalStatus=hot w/ active A-E signals, flowScore desc.
  // -----------------------------------------------------------------------
  const hotTokenIds = [...tokenById.keys()].filter((id) => {
    const flow = flowByToken.get(id);
    const signal = bestSignalByToken.get(id);
    return flow?.signalStatus === 'hot' && signal && ['A', 'B', 'C', 'D', 'E'].includes(signal.rule);
  });
  const hotCards = hotTokenIds
    .map(buildCard)
    .filter((c): c is SignalCardData => c !== null)
    .sort((a, b) => b.flowScore - a.flowScore);

  // -----------------------------------------------------------------------
  // Section 2: Accumulating — rule-B fired OR watching w/ rising accumulation.
  // -----------------------------------------------------------------------
  const accumulatingTokenIds = [...tokenById.keys()].filter((id) => {
    if (hotTokenIds.includes(id)) return false; // don't double-list a Hot-now card here
    const flow = flowByToken.get(id);
    const signal = bestSignalByToken.get(id);
    const ruleBFired = signal?.rule === 'B';
    const watchingWithAccumulation =
      flow?.signalStatus === 'watching' &&
      (flow.componentBreakdown as { metrics?: { accumulation?: { smartWalletCount1h?: number; smartWalletCount30m?: number } } } | null)?.metrics
        ?.accumulation !== undefined &&
      ((flow.componentBreakdown as { metrics: { accumulation: { smartWalletCount1h: number; smartWalletCount30m: number } } }).metrics.accumulation
        .smartWalletCount1h ?? 0) >
        ((flow.componentBreakdown as { metrics: { accumulation: { smartWalletCount1h: number; smartWalletCount30m: number } } }).metrics.accumulation
          .smartWalletCount30m ?? 0);
    return ruleBFired || watchingWithAccumulation;
  });
  const accumulatingCards = accumulatingTokenIds
    .map(buildCard)
    .filter((c): c is SignalCardData => c !== null)
    .sort((a, b) => b.flowScore - a.flowScore);

  // -----------------------------------------------------------------------
  // Section 3: Profit rotation — F / ProfitRotationSignal.
  // -----------------------------------------------------------------------
  const rotationCards: RotationCardData[] = rotations.map((r) => {
    // ProfitRotationSignal.receivedValueUsd (added by the
    // rotation_received_value migration) carries the matched candidate's
    // ACTUAL received value going forward — when present, the real
    // receivedValueUsd/transferredValueUsd*100 match% is the honest number
    // to show. Legacy rows persisted before that column existed have
    // receivedValueUsd = null; for those, matchRotations already confirmed
    // the (unrecoverable) real figure cleared settings.rules.F.minValueMatchPct,
    // so the floor is the most honest number available and is rendered with
    // explicit "exact figure unavailable" wording rather than presented as
    // if it were the measured match.
    const transferredValueUsd = Number(r.transferredValueUsd);
    const valueMatchPct =
      r.receivedValueUsd !== null && transferredValueUsd > 0
        ? (Number(r.receivedValueUsd) / transferredValueUsd) * 100
        : null;
    const valueMatchFloorPct = settings.rules.F.minValueMatchPct;
    return {
      id: r.id,
      sourceSymbol: r.sourceToken.symbol,
      sourceTokenId: r.sourceTokenId,
      destSymbol: r.destToken.symbol,
      destTokenId: r.destTokenId,
      chainPath: r.chainPath,
      bridgeProtocol: r.chainPath.length > 1 ? findBridgeProtocol(r.sourceWallet.address, r.destWallet.address, r.detectedAt) : null,
      realizedProfitUsd: Number(r.realizedProfitUsd),
      transferredValueUsd,
      timeGapMin: r.timeGapMin,
      valueMatchPct,
      valueMatchFloorPct,
      confidence: r.confidence,
      destTokenMcapAtBuyUsd: Number(r.destTokenMcapAtBuy),
      currentDestPerfPct: r.currentDestPerfPct,
      detectedAt: r.detectedAt,
    };
  });

  // -----------------------------------------------------------------------
  // Section 4: Exit warnings — rule G.
  // -----------------------------------------------------------------------
  const exitWarningTokenIds = [...tokenById.keys()].filter((id) => flowByToken.get(id)?.signalStatus === 'exit_warning');
  const exitWarningCards = exitWarningTokenIds
    .map(buildCard)
    .filter((c): c is SignalCardData => c !== null)
    .sort((a, b) => b.flowScore - a.flowScore);

  // -----------------------------------------------------------------------
  // Section 5: New watched tokens — recently firstSeen w/ smart activity.
  // -----------------------------------------------------------------------
  const newWatchedCandidates = [...tokenById.values()]
    .filter((t) => {
      const flow = flowByToken.get(t.id);
      return flow && flow.smartWalletCount > 0;
    })
    .sort((a, b) => b.firstSeenAt.getTime() - a.firstSeenAt.getTime())
    .slice(0, NEW_WATCHED_CAP);

  // -----------------------------------------------------------------------
  // Sections 6/7: Best/Worst performing previous alerts — BacktestResult
  // joined to Signal, best = major_win/good_win by roi desc, worst =
  // failure/hard_failure by roi asc. One BacktestResult row per
  // (signal, horizon) — pick each signal's longest-horizon result available
  // for a stable "how did this one actually do" read.
  // -----------------------------------------------------------------------
  const backtestResults = await prisma.backtestResult.findMany({
    include: { signal: { include: { token: true } } },
    orderBy: { roiPct: 'desc' },
  });

  const HORIZON_RANK: Record<string, number> = { D7: 7, D3: 6, H24: 5, H6: 4, H1: 3, M15: 2 };
  const bestResultBySignal = new Map<string, (typeof backtestResults)[number]>();
  for (const result of backtestResults) {
    const existing = bestResultBySignal.get(result.signalId);
    if (!existing || HORIZON_RANK[result.horizon] > HORIZON_RANK[existing.horizon]) {
      bestResultBySignal.set(result.signalId, result);
    }
  }
  const representativeResults = [...bestResultBySignal.values()];

  const winResults = representativeResults
    .filter((r) => r.outcomeLabel !== null && GOOD_LABELS.has(r.outcomeLabel))
    .sort((a, b) => b.roiPct - a.roiPct)
    .slice(0, SECTION_CAP);
  const failResults = representativeResults
    .filter((r) => r.outcomeLabel !== null && BAD_LABELS.has(r.outcomeLabel))
    .sort((a, b) => a.roiPct - b.roiPct)
    .slice(0, SECTION_CAP);

  return (
    <div className="flex flex-col gap-10">
      <AutoRefresh />

      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Signal Feed</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          What to look at right now, in plain English — evidence and a probabilistic read for every card. Raw data
          lives on <a href="/tokens" className="underline-offset-4 hover:underline">Tokens</a>.
        </p>
      </div>

      <SignalSection
        title="Hot now"
        description="Active A-E signals on tokens flagged hot, sorted by FlowScore."
        emptyMessage="No tokens are currently hot — nothing has fired a strong accumulation/conviction signal in the latest pass."
        viewAllHref="/tokens"
        count={hotCards.length}
      >
        {hotCards.slice(0, SECTION_CAP).map((card) => (
          <SignalCard key={card.tokenId} data={card} settings={settings} />
        ))}
      </SignalSection>

      <SignalSection
        title="Accumulating"
        description="Early-buyer-base growth (rule B) or rising smart-wallet counts on watched tokens."
        emptyMessage="No tokens show a rising accumulation pattern right now."
        viewAllHref="/tokens"
        count={accumulatingCards.length}
      >
        {accumulatingCards.slice(0, SECTION_CAP).map((card) => (
          <SignalCard key={card.tokenId} data={card} settings={settings} />
        ))}
      </SignalSection>

      <SignalSection
        title="Profit rotation"
        description="A wallet realized profit on one token and a linked wallet bought another shortly after."
        emptyMessage="No profit-rotation patterns detected yet."
        viewAllHref="/flow"
        count={rotationCards.length}
      >
        {rotationCards.slice(0, SECTION_CAP).map((card) => (
          <RotationCard key={card.id} data={card} settings={settings} />
        ))}
      </SignalSection>

      <SignalSection
        title="Exit warnings"
        description="Smart-money distribution, liquidity drops, or unconfirmed pumps (rule G)."
        emptyMessage="No exit warnings right now."
        viewAllHref="/tokens"
        count={exitWarningCards.length}
      >
        {exitWarningCards.slice(0, SECTION_CAP).map((card) => (
          <SignalCard key={card.tokenId} data={card} settings={settings} />
        ))}
      </SignalSection>

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h2 className="text-xl font-semibold tracking-tight">New watched tokens</h2>
            <p className="mt-1 text-sm text-muted-foreground">Most recently first-seen tokens already showing smart-wallet activity.</p>
          </div>
          {newWatchedCandidates.length > 0 && (
            <a href="/tokens" className="text-sm text-muted-foreground underline-offset-4 hover:underline">
              view all →
            </a>
          )}
        </div>
        {newWatchedCandidates.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
            No newly-seen tokens with smart-wallet activity yet.
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {newWatchedCandidates.map((t) => {
              const card = buildCard(t.id);
              return card ? (
                <SignalCard key={t.id} data={card} settings={settings} />
              ) : (
                <div key={t.id} className="rounded-xl border border-border bg-card p-5 text-base text-muted-foreground">
                  ${t.symbol} — first seen {t.firstSeenAt.toISOString().slice(0, 10)}, smart-wallet activity observed, no
                  fired signal yet.
                </div>
              );
            })}
          </div>
        )}
      </section>

      <BacktestOutcomeSection
        title="Best performing previous alerts"
        description="Historical signals that went on to a small/good/major win, sorted by ROI."
        emptyMessage="No historical alert outcomes reach a win tier yet — see Backtest for the full replay results."
        results={winResults}
        roiClassName="text-emerald-400"
      />

      <BacktestOutcomeSection
        title="Worst performing previous alerts"
        description="Historical signals that failed or hard-failed, sorted by ROI (worst first)."
        emptyMessage="No historical alert outcomes have failed yet — see Backtest for the full replay results."
        results={failResults}
        roiClassName="text-red-400"
      />
    </div>
  );
}

interface BacktestResultRow {
  id: string;
  horizon: string;
  roiPct: number;
  outcomeLabel: string | null;
  notes: string | null;
  signal: { rule: string; severity: string; token: { id: string; symbol: string } };
}

function BacktestOutcomeSection({
  title,
  description,
  emptyMessage,
  results,
  roiClassName,
}: {
  title: string;
  description: string;
  emptyMessage: string;
  results: BacktestResultRow[];
  roiClassName: string;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        </div>
        {results.length > 0 && (
          <a href="/backtest" className="text-sm text-muted-foreground underline-offset-4 hover:underline">
            view all →
          </a>
        )}
      </div>
      {results.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          {emptyMessage}
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {results.map((r) => {
            const synthetic = hasNote(r.notes, 'synthetic_continuation');
            return (
              <div key={r.id} className="flex flex-col gap-2 rounded-xl border border-border bg-card p-5 text-card-foreground ring-1 ring-foreground/10">
                <div className="flex flex-wrap items-center gap-2">
                  <a href={`/tokens/${r.signal.token.id}`} className="text-lg font-semibold hover:underline">
                    ${r.signal.token.symbol}
                  </a>
                  <span className="text-sm text-muted-foreground">
                    rule {r.signal.rule} · {r.horizon}
                  </span>
                  {synthetic && (
                    <span className="ml-auto inline-flex items-center rounded-full border border-transparent bg-violet-500/15 px-2 py-0.5 text-xs font-medium text-violet-300">
                      synthetic demo data
                    </span>
                  )}
                </div>
                <p className={`text-2xl font-bold tabular-nums ${roiClassName}`}>
                  {r.roiPct >= 0 ? '+' : ''}
                  {r.roiPct.toFixed(1)}%
                </p>
                <p className="text-base text-muted-foreground">
                  Outcome: {r.outcomeLabel ?? 'neutral_pending'}. {synthetic ? 'Synthetic evidence — proves the code path only, not that the rule has edge.' : 'Real market evidence.'}
                </p>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
