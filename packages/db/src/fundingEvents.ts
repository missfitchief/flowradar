// FlowRadar — fundingEvents.ts: buildFundingEvents (Rule E's FundingEvent[] builder).
//
// Normative source: Task 15 binding decision 3.
//
// Builds FundingEvent[] (packages/core/src/types.ts's Rule E contract) for
// one token from raw MoneyFlowEdge `transfer` rows:
//   1. Start from every MoneyFlowEdge row with actionType='transfer' whose
//      `ts` falls in [windowFrom, now] and whose sourceAddress belongs to a
//      wallet that is watched OR profitable (the "funder" side — Rule E's
//      premise is that a KNOWN smart wallet is bankrolling a fresh one).
//   2. The funded (destination) wallet must be FRESH relative to the
//      transfer: its first-ever trade (WalletTokenTrade, any action, any
//      token) must be AFTER the transfer's ts. A funded wallet with trade
//      history predating the transfer is not "fresh" — it was already
//      active, so a transfer to it isn't evidence of a coordinated
//      funding-to-buy setup.
//   3. `fundedFirstBuy` is the funded wallet's first-ever BUY of THIS
//      SPECIFIC token (tokenId param) — Rule E only fires for funding
//      chains that land on the token currently being evaluated (see
//      ruleE.ts's own header: "a fresh wallet buying a DIFFERENT token is
//      not evidence for this token's signal"). A funded wallet that never
//      buys this token at all produces a FundingEvent with
//      fundedFirstBuy=undefined (ruleE.ts already treats that as a
//      non-match, not an error).
//
// Wallet identity: MoneyFlowEdge stores raw addresses (sourceAddress/
// destinationAddress), not Wallet FKs (see ingest.ts's own header — it's a
// wallet-agnostic directed edge). This builder joins address -> Wallet.id
// (scoped to the edge's own sourceChain/destinationChain) to get the
// funderWalletId/fundedWalletId FundingEvent needs, and silently skips any
// edge whose source or destination address isn't a known Wallet row at all
// (an edge touching e.g. a bridge program or CEX hot wallet on one side has
// no Wallet counterpart to report a FundingEvent for).

import type { PrismaClient } from '@prisma/client';
import { isProfitableWallet, isSignalEligibleStatus, statsTrustOf } from '@flowradar/core';
import type { FundingEvent, Settings, WalletStatus } from '@flowradar/core';

export async function buildFundingEvents(
  prisma: PrismaClient,
  tokenId: string,
  windowFrom: Date,
  now: Date,
  settings: Settings
): Promise<FundingEvent[]> {
  const transferEdges = await prisma.moneyFlowEdge.findMany({
    where: {
      actionType: 'transfer',
      ts: { gte: windowFrom, lte: now }
    },
    select: {
      sourceAddress: true,
      destinationAddress: true,
      sourceChain: true,
      destinationChain: true,
      amountUsd: true,
      ts: true
    }
  });
  if (transferEdges.length === 0) return [];

  const sourceAddresses = [...new Set(transferEdges.map((e) => e.sourceAddress))];
  const destAddresses = [...new Set(transferEdges.map((e) => e.destinationAddress))];
  const allAddresses = [...new Set([...sourceAddresses, ...destAddresses])];

  const walletRows = await prisma.wallet.findMany({
    where: { address: { in: allAddresses } },
    select: { id: true, address: true, chain: true, isWatched: true, status: true }
  });
  const walletByAddressChain = new Map(walletRows.map((w) => [`${w.address}:${w.chain}`, w]));
  const allWalletIds = walletRows.map((w) => w.id);

  const [statsRows, firstTradeRows, firstBuyOfTokenRows] = await Promise.all([
    prisma.walletStats.findMany({
      where: { walletId: { in: allWalletIds } },
      orderBy: { computedAt: 'desc' },
      select: {
        walletId: true,
        pnlUsd: true,
        realizedPnlUsd: true,
        winRate: true,
        tradeCount: true,
        avgTradeSizeUsd: true,
        source: true
      }
    }),
    // First-ever trade per wallet (any action, any token) — used to decide
    // freshness relative to a transfer's ts.
    prisma.walletTokenTrade.findMany({
      where: { walletId: { in: allWalletIds } },
      orderBy: { ts: 'asc' },
      select: { walletId: true, ts: true }
    }),
    // First-ever BUY of THIS token per wallet.
    prisma.walletTokenTrade.findMany({
      where: { walletId: { in: allWalletIds }, tokenId, action: 'BUY' },
      orderBy: { ts: 'asc' },
      select: { walletId: true, ts: true, amountUsd: true, marketCapAtTrade: true }
    })
  ]);

  const latestStatsByWallet = new Map<string, (typeof statsRows)[number]>();
  for (const row of statsRows) {
    if (!latestStatsByWallet.has(row.walletId)) latestStatsByWallet.set(row.walletId, row);
  }

  const firstTradeTsByWallet = new Map<string, Date>();
  for (const row of firstTradeRows) {
    if (!firstTradeTsByWallet.has(row.walletId)) firstTradeTsByWallet.set(row.walletId, row.ts);
  }

  const firstBuyOfTokenByWallet = new Map<string, (typeof firstBuyOfTokenRows)[number]>();
  for (const row of firstBuyOfTokenRows) {
    if (!firstBuyOfTokenByWallet.has(row.walletId)) firstBuyOfTokenByWallet.set(row.walletId, row);
  }

  // Rule E's funder gate consumes THE eligibility gate (Phase 0 review,
  // 2026-07-10 — this function was a second, contradictory smartness
  // predicate): a funder qualifies only when signal_eligible AND (watched OR
  // profitable on TRUSTED stats). Mirrors fetchAggregateInputs exactly —
  // provider-claimed figures never qualify an unwatched funder, synthetic
  // never qualifies anyone, and a wallet whose status is excluded/public/
  // bot keeps isWatched residue without regaining signal weight here.
  function isFunderQualified(walletId: string, isWatched: boolean, status: WalletStatus): boolean {
    if (!isSignalEligibleStatus(status)) return false;
    if (isWatched) return true;
    const stats = latestStatsByWallet.get(walletId);
    if (!stats) return false;
    const trust = statsTrustOf(stats.source);
    if (trust === 'synthetic' || trust === 'provider_claimed') return false;
    return isProfitableWallet(
      {
        pnlUsd: Number(stats.pnlUsd),
        realizedPnlUsd: Number(stats.realizedPnlUsd),
        winRate: stats.winRate,
        tradeCount: stats.tradeCount,
        avgTradeSizeUsd: Number(stats.avgTradeSizeUsd)
      },
      settings.profitableWallet
    );
  }

  const events: FundingEvent[] = [];

  for (const edge of transferEdges) {
    const funder = walletByAddressChain.get(`${edge.sourceAddress}:${edge.sourceChain}`);
    const funded = walletByAddressChain.get(`${edge.destinationAddress}:${edge.destinationChain}`);
    if (!funder || !funded) continue; // one side isn't a known Wallet row — not representable as a FundingEvent

    if (!isFunderQualified(funder.id, funder.isWatched, funder.status as WalletStatus)) continue;

    const fundedFirstTradeTs = firstTradeTsByWallet.get(funded.id);
    // Freshness: the funded wallet's first-ever trade (if any) must be AFTER
    // the transfer. A funded wallet with NO trade history at all is
    // trivially fresh (nothing predates the transfer).
    const fundedAddressFresh = fundedFirstTradeTs === undefined || fundedFirstTradeTs.getTime() > edge.ts.getTime();

    const firstBuyOfToken = firstBuyOfTokenByWallet.get(funded.id);
    const fundedFirstBuy = firstBuyOfToken
      ? {
          tokenId,
          usd: Number(firstBuyOfToken.amountUsd),
          ts: firstBuyOfToken.ts,
          mcapAtBuy: firstBuyOfToken.marketCapAtTrade !== null ? Number(firstBuyOfToken.marketCapAtTrade) : null
        }
      : undefined;

    events.push({
      funderWalletId: funder.id,
      fundedWalletId: funded.id,
      fundedAddressFresh,
      amountUsd: Number(edge.amountUsd),
      ts: edge.ts,
      ...(fundedFirstBuy ? { fundedFirstBuy } : {})
    });
  }

  return events;
}
