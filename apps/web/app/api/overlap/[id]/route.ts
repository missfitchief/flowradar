// FlowRadar — GET /api/overlap/[id] (Task 38, Wave 4.6, task-38-brief.md
// binding decision 3). Returns a TokenOverlapSearch row plus its wallet/group
// results, each joined against CandidateWallet (validationStatus) so the UI
// can show the pipeline state for every already-known candidate (binding
// decision 4 — "is this address already a CandidateWallet?").

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await params;

  const search = await prisma.tokenOverlapSearch.findUnique({
    where: { id },
    include: { walletResults: true, groupResults: true }
  });

  if (!search) {
    return NextResponse.json({ error: `no TokenOverlapSearch found with id "${id}"` }, { status: 404 });
  }

  const walletAddresses = search.walletResults.map((w) => w.walletAddress);
  const candidates = walletAddresses.length
    ? await prisma.candidateWallet.findMany({
        where: { walletAddress: { in: walletAddresses }, chain: search.chain },
        select: { walletAddress: true, validationStatus: true, source: true }
      })
    : [];
  // A wallet can have candidate rows from multiple sources — prefer the
  // dune_token_overlap one if present (the source this search itself would
  // have created), else the first found; "already a CandidateWallet at all"
  // is the fact the UI cares about, matching task-38-brief.md's framing.
  const candidateByAddress = new Map<string, { validationStatus: string; source: string }>();
  for (const c of candidates) {
    const existing = candidateByAddress.get(c.walletAddress);
    if (!existing || c.source === 'dune_token_overlap') {
      candidateByAddress.set(c.walletAddress, { validationStatus: c.validationStatus, source: c.source });
    }
  }

  const { walletResults, groupResults, ...searchFields } = search;

  return NextResponse.json({
    search: searchFields,
    walletResults: walletResults.map((w) => ({
      walletAddress: w.walletAddress,
      chain: w.chain,
      tokensOverlapCount: w.tokensOverlapCount,
      totalBuyUsd: w.totalBuyUsd !== null ? Number(w.totalBuyUsd) : null,
      totalSellUsd: w.totalSellUsd !== null ? Number(w.totalSellUsd) : null,
      estimatedPnlUsd: w.estimatedPnlUsd !== null ? Number(w.estimatedPnlUsd) : null,
      firstBuyTime: w.firstBuyTime ? w.firstBuyTime.toISOString() : null,
      buyCount: w.buyCount,
      sellCount: w.sellCount,
      entryMarketCapUsd: w.entryMarketCapUsd !== null ? Number(w.entryMarketCapUsd) : null,
      overlapGroupId: w.overlapGroupId,
      txHashesSample: w.txHashesSample,
      candidateStatus: candidateByAddress.get(w.walletAddress)?.validationStatus ?? null,
      // true only when THIS overlap pipeline (dune_token_overlap source) is
      // the one that created/upserted the CandidateWallet row — distinct
      // from candidateStatus, which reports the pipeline state of ANY
      // candidate row for this address regardless of which source created
      // it (local overlap never creates candidates itself — see
      // localOverlap.ts's header — so a local search's rows can still show
      // a non-null candidateStatus from an unrelated source without this
      // search having "added" anything).
      isDuneOverlapCandidate: candidateByAddress.get(w.walletAddress)?.source === 'dune_token_overlap'
    })),
    groupResults: groupResults.map((g) => ({
      overlapGroupId: g.overlapGroupId,
      walletCount: g.walletCount,
      walletAddresses: g.walletAddresses,
      sharedTokenCount: g.sharedTokenCount
    }))
  });
}
