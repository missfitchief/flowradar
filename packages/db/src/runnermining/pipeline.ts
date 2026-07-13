// FlowRadar — finish-pipeline builders (complete-the-loop sprint):
//   1. buildTopPnlExtractionStatus — per-token HONEST extraction outcome for
//      every verified $10M+ runner (succeeded / local-only / retryable /
//      unavailable / no-valid-wallets / incomplete), so "processing state" is
//      never mistaken for "successfully mined".
//   2. buildCapitalChains — the end-to-end product proof: known entity ->
//      transfer -> receiver (STAGING) -> token buy (DEPLOYMENT), plus
//      same/linked-entity PROFIT ROTATION (profit realized on token A ->
//      capital into token B). Built by JOINING already-persisted evidence
//      (outflow paths, receiver enrollments, local trades, entity graph).
//      Nothing fabricated; near-empty deployment is an honest data state.
// SHADOW-ONLY, observation_only throughout.

import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { toErrorReceipt, ERROR_RECEIPTS_MAX } from '../dormancy/activity';
import type { WalletErrorReceipt } from '../dormancy/activity';
import { entityKeysFor } from './capitalOutflow';

export const PIPELINE_ENGINE_VERSION = 1;

// ---------------------------------------------------------------------------
// 1. Per-token top-PnL extraction status
// ---------------------------------------------------------------------------
export interface ExtractionStatusReport {
  mintsConsidered: number;
  written: number;
  byStatus: Record<string, number>;
  errors: number;
  errorReceipts: WalletErrorReceipt[];
}

export async function buildTopPnlExtractionStatus(
  prisma: PrismaClient,
  opts: { chain?: 'SOLANA' | 'BSC'; limit?: number; now?: Date } = {}
): Promise<ExtractionStatusReport> {
  const chain = opts.chain ?? 'SOLANA';
  const limit = opts.limit ?? 2000;
  const now = opts.now ?? new Date();

  const runners = await prisma.tokenLifecycle.findMany({
    where: { runnerClass: 'verified_above_10m' },
    orderBy: { mint: 'asc' },
    take: limit,
    select: { mint: true }
  });
  const mints = runners.map((r) => r.mint);

  // Bulk-load the joins once (bounded, stable).
  const [tokens, candGroups, fetchStates] = await Promise.all([
    prisma.token.findMany({ where: { chain, address: { in: mints } }, select: { id: true, address: true } }),
    prisma.tokenTopPnlCandidate.findMany({
      where: { chain, mint: { in: mints } },
      select: { mint: true, walletAddress: true, validation: true }
    }),
    prisma.topPnlFetchState.findMany({ where: { mint: { in: mints } }, select: { mint: true, status: true } })
  ]);
  const tokenIdOf = new Map(tokens.map((t) => [t.address, t.id]));
  const fetchStateOf = new Map(fetchStates.map((f) => [f.mint, f.status]));
  // token has local trades?
  const tradeGroups = await prisma.walletTokenTrade.groupBy({
    by: ['tokenId'],
    where: { tokenId: { in: tokens.map((t) => t.id) } },
    _count: { _all: true }
  });
  const tokenIdsWithTrades = new Set(tradeGroups.map((g) => g.tokenId));
  const candsOf = new Map<string, { wallets: Set<string>; verified: number; providerOnly: number; incomplete: number }>();
  for (const c of candGroups) {
    const e = candsOf.get(c.mint) ?? { wallets: new Set<string>(), verified: 0, providerOnly: 0, incomplete: 0 };
    e.wallets.add(c.walletAddress);
    if (c.validation === 'locally_verified') e.verified += 1;
    else if (c.validation === 'provider_only') e.providerOnly += 1;
    else if (c.validation === 'incomplete') e.incomplete += 1;
    candsOf.set(c.mint, e);
  }

  const report: ExtractionStatusReport = { mintsConsidered: mints.length, written: 0, byStatus: {}, errors: 0, errorReceipts: [] };
  for (const mint of mints) {
    try {
      const tokenId = tokenIdOf.get(mint);
      const hasTokenRow = tokenId !== undefined;
      const hasLocalTrades = tokenId !== undefined && tokenIdsWithTrades.has(tokenId);
      const cands = candsOf.get(mint);
      const walletCount = cands?.wallets.size ?? 0;
      const fetchState = fetchStateOf.get(mint) ?? null;

      // Precise, mutually-exclusive taxonomy. 'unavailable' is STRICTLY
      // "no local token row" (nothing to work with). A token row that simply
      // has not been fetched yet is 'incomplete_coverage', not 'unavailable'.
      let status: string;
      const reasons: string[] = [];
      if (!hasTokenRow) {
        // Nothing local to work with — precedes any candidate branch (a
        // locally_verified claim is impossible without the token).
        status = 'unavailable';
        reasons.push('no_local_token_row');
      } else if (walletCount > 0 && (cands?.verified ?? 0) > 0) {
        status = 'local_reconstruction_ok';
        reasons.push(`locally_verified_wallets:${cands?.verified}`);
      } else if (walletCount > 0) {
        status = 'incomplete_coverage';
        reasons.push('candidates_exist_but_none_locally_verified');
      } else if (hasLocalTrades) {
        status = 'no_valid_wallets';
        reasons.push('local_trades_exist_but_no_extractable_top_pnl_wallets');
      } else if (fetchState === 'provider_error') {
        status = 'retryable_provider_failure';
        reasons.push('provider_fetch:provider_error');
      } else if (fetchState === 'empty' || fetchState === 'fetched') {
        status = 'no_valid_wallets';
        reasons.push(`provider_fetch:${fetchState}_no_wallets`);
      } else {
        status = 'incomplete_coverage';
        reasons.push('token_row_no_local_trades_no_provider_attempt');
      }

      const data = {
        chain,
        mint,
        status,
        hasTokenRow,
        hasLocalTrades,
        walletCount,
        locallyVerified: cands?.verified ?? 0,
        providerOnly: cands?.providerOnly ?? 0,
        incomplete: cands?.incomplete ?? 0,
        providerFetchState: fetchState,
        reasonCodes: reasons,
        receiptsJson: { hasTokenRow, hasLocalTrades } as unknown as Prisma.InputJsonValue,
        engineVersion: PIPELINE_ENGINE_VERSION,
        computedAt: now
      };
      await prisma.topPnlExtractionStatus.upsert({ where: { chain_mint: { chain, mint } }, create: data, update: data });
      report.written += 1;
      report.byStatus[status] = (report.byStatus[status] ?? 0) + 1;
    } catch (err) {
      report.errors += 1;
      if (report.errorReceipts.length < ERROR_RECEIPTS_MAX) report.errorReceipts.push(toErrorReceipt(mint, err));
    }
  }
  return report;
}

// ---------------------------------------------------------------------------
// 2. Capital chains (staging / deployment / profit rotation)
// ---------------------------------------------------------------------------
export interface CapitalChainReport {
  staging: number;
  deployment: number;
  profitRotation: number;
  byKind: Record<string, number>;
  endToEndExamples: number;
  errors: number;
  errorReceipts: WalletErrorReceipt[];
}

interface Position {
  tokenAddress: string;
  buyUsd: number;
  sellUsd: number;
  firstBuyTs: string | null;
  lastSellTs: string | null;
  exitRatio: number | null;
  fullExitSec: number | null;
  timeToFirstSellSec: number | null;
}

export async function buildCapitalChains(
  prisma: PrismaClient,
  opts: { chain?: 'SOLANA' | 'BSC'; limit?: number; now?: Date } = {}
): Promise<CapitalChainReport> {
  const chain = opts.chain ?? 'SOLANA';
  const limit = opts.limit ?? 2000;
  const now = opts.now ?? new Date();
  const report: CapitalChainReport = {
    staging: 0,
    deployment: 0,
    profitRotation: 0,
    byKind: {},
    endToEndExamples: 0,
    errors: 0,
    errorReceipts: []
  };

  const upsert = async (row: {
    kind: string;
    sourceEntityKey: string;
    sourceWallet: string;
    receiverWallet: string | null;
    route: string;
    evidenceTier: string;
    knownValueUsd: number | null;
    fundingTs: Date | null;
    tokenBought: string | null;
    tokenBoughtSymbol: string | null;
    entryMcapUsd: number | null;
    fundingToBuyDelaySec: number | null;
    sourceToken: string | null;
    realizedProfitUsd: number | null;
    receiverClass: string | null;
    relationshipTier: string | null;
    independentEntitiesOnToken: number | null;
    confidence: number;
    reasonCodes: string[];
    caveats: string[];
    receipts: unknown;
  }) => {
    // Fully-specifying key: chain, kind, route, source, receiver, sourceToken
    // AND tokenBought — so two source tokens rotating into one destination,
    // and direct vs multi-hop paths, and cross-chain addresses never collide.
    const dedupeKey = `${chain}|${row.kind}|${row.route}|${row.sourceWallet}|${row.receiverWallet ?? ''}|${row.sourceToken ?? ''}|${row.tokenBought ?? ''}`;
    const data = {
      dedupeKey,
      chain,
      ...row,
      knownValueUsd: row.knownValueUsd,
      entryMcapUsd: row.entryMcapUsd,
      realizedProfitUsd: row.realizedProfitUsd,
      receiptsJson: (row.receipts ?? {}) as Prisma.InputJsonValue,
      engineVersion: PIPELINE_ENGINE_VERSION,
      computedAt: now
    };
    // strip the helper-only `receipts` field
    const { receipts, ...clean } = data as typeof data & { receipts?: unknown };
    void receipts;
    await prisma.capitalChain.upsert({ where: { dedupeKey }, create: clean, update: clean });
    report.byKind[row.kind] = (report.byKind[row.kind] ?? 0) + 1;
  };

  // Independent-entity count per candidate token — a Map presence means the
  // token was scored; ABSENCE means unknown (never rendered as 0).
  const candidateEntityCount = new Map<string, number>();
  for (const c of await prisma.tokenCandidateScore.findMany({
    where: { chain },
    select: { mint: true, independentEntityCount: true },
    take: 20_000
  })) {
    candidateEntityCount.set(c.mint, c.independentEntityCount);
  }
  const entityCountOf = (mint: string): number | null => (candidateEntityCount.has(mint) ? candidateEntityCount.get(mint)! : null);

  // Reconciliation is only safe when NO input was truncated (else a valid row
  // outside the processed window would be wrongly deleted).
  let truncated = false;

  // --- STAGING + DEPLOYMENT: outflow (transfer) -> receiver -> its buys ---
  const outflows = await prisma.capitalOutflowPath.findMany({
    where: { chain, destinationType: 'wallet', evidenceTier: { in: ['direct_transfer', 'multi_hop_transfer'] } },
    orderBy: [{ sourceWallet: 'asc' }, { destinationAddress: 'asc' }, { evidenceTier: 'asc' }],
    take: limit + 1
  });
  if (outflows.length > limit) truncated = true;
  const receiverEnrollments = new Map(
    (await prisma.receiverEnrollment.findMany({ where: { chain }, select: { receiverAddress: true, receiverClass: true, deploymentsJson: true, firstReceiptTs: true } }))
      .map((r) => [r.receiverAddress, r])
  );
  for (const o of outflows.slice(0, limit)) {
    try {
      const enrollment = receiverEnrollments.get(o.destinationAddress);
      // The persisted sourceEntityKey is already entity-adjusted (works for
      // operator roots + non-DNA sources too) — never re-derive from address.
      const sourceEntityKey = o.sourceEntityKey;
      await upsert({
        kind: 'staging',
        sourceEntityKey,
        sourceWallet: o.sourceWallet,
        receiverWallet: o.destinationAddress,
        route: o.evidenceTier,
        evidenceTier: o.evidenceTier,
        knownValueUsd: o.knownValueUsd === null ? null : Number(o.knownValueUsd),
        fundingTs: o.firstTransferTs,
        tokenBought: null,
        tokenBoughtSymbol: null,
        entryMcapUsd: null,
        fundingToBuyDelaySec: null,
        sourceToken: null,
        realizedProfitUsd: null,
        receiverClass: o.receiverClassAtReceipt,
        relationshipTier: o.receiverRelationshipTier,
        independentEntitiesOnToken: null,
        confidence: o.evidenceTier === 'direct_transfer' ? 60 : 45,
        reasonCodes: [`capital_staged_to_${o.receiverClassAtReceipt}`],
        caveats: ['staging is a transfer of capital to a fresh/dormant/linked wallet BEFORE any observed token buy'],
        receipts: { firstTransferTs: o.firstTransferTs.toISOString() }
      });
      report.staging += 1;

      // DEPLOYMENT: a receiver's post-receipt deployments — but ONLY chain a
      // deployment to THIS outflow when the outflow's funding preceded the
      // buy (this source's capital could plausibly have funded it). Delay is
      // measured from THIS transfer, not the receiver's earliest receipt.
      const deployments = (enrollment?.deploymentsJson ?? []) as { mint: string; firstBuyTs: string; buyCount: number; boughtKnownUsd: number | null }[];
      for (const dep of deployments.slice(0, 10)) {
        const buyMs = new Date(dep.firstBuyTs).getTime();
        if (!Number.isFinite(buyMs) || buyMs < o.firstTransferTs.getTime()) continue; // buy predates this funding -> not this source's chain
        const tok = await prisma.token.findUnique({ where: { chain_address: { chain, address: dep.mint } }, select: { symbol: true } });
        const delay = Math.round((buyMs - o.firstTransferTs.getTime()) / 1000);
        await upsert({
          kind: 'deployment',
          sourceEntityKey,
          sourceWallet: o.sourceWallet,
          receiverWallet: o.destinationAddress,
          route: o.evidenceTier,
          evidenceTier: o.evidenceTier,
          knownValueUsd: dep.boughtKnownUsd,
          fundingTs: o.firstTransferTs,
          tokenBought: dep.mint,
          tokenBoughtSymbol: tok?.symbol ?? null,
          entryMcapUsd: null,
          fundingToBuyDelaySec: delay,
          sourceToken: null,
          realizedProfitUsd: null,
          receiverClass: o.receiverClassAtReceipt,
          relationshipTier: o.receiverRelationshipTier,
          independentEntitiesOnToken: entityCountOf(dep.mint),
          confidence: 55,
          reasonCodes: ['staged_receiver_deployed_capital_into_token'],
          caveats: ['deployment = the funded receiver later BOUGHT this token, AFTER this transfer; capital linkage is inferred, observation_only'],
          receipts: { deploymentFirstBuyTs: dep.firstBuyTs, buyCount: dep.buyCount }
        });
        report.deployment += 1;
        report.endToEndExamples += 1;
      }
    } catch (err) {
      report.errors += 1;
      if (report.errorReceipts.length < ERROR_RECEIPTS_MAX) report.errorReceipts.push(toErrorReceipt(`outflow:${o.sourceWallet}`, err));
    }
  }

  // --- PROFIT ROTATION: within a wallet, a profitable RUNNER exit followed by
  //     a buy into ANOTHER token. Realized profit must be PROVEN — a token
  //     with any unpriced BUY/SELL leg (unknown cost basis) or a truncated
  //     profile is excluded. Entity-adjusted; per-profile error isolation. ---
  const DNA_CAP = 20_000;
  const RUNNER_CAP = 20_000;
  const PROFILE_CAP = 20_000;
  const UNPRICED_CAP = 100_000;
  const dnaRowsAll = await prisma.walletDnaProfile.findMany({ where: { chain }, select: { walletAddress: true }, orderBy: { walletAddress: 'asc' }, take: DNA_CAP + 1 });
  if (dnaRowsAll.length > DNA_CAP) truncated = true;
  const dnaWallets = dnaRowsAll.slice(0, DNA_CAP).map((w) => w.walletAddress);
  const entityOf = await entityKeysFor(prisma, chain, dnaWallets);
  const runnerRows = await prisma.tokenLifecycle.findMany({ where: { runnerClass: 'verified_above_10m' }, select: { mint: true }, take: RUNNER_CAP + 1 });
  if (runnerRows.length > RUNNER_CAP) truncated = true;
  const runnerMints = new Set(runnerRows.slice(0, RUNNER_CAP).map((r) => r.mint));
  const profilesAll = await prisma.walletBehaviorProfile.findMany({
    where: { chain, walletAddress: { in: dnaWallets } },
    orderBy: { walletAddress: 'asc' },
    select: { walletAddress: true, profileJson: true },
    take: PROFILE_CAP + 1
  });
  if (profilesAll.length > PROFILE_CAP) truncated = true;
  const profiles = profilesAll.slice(0, PROFILE_CAP);
  // Per-wallet tokens with an unpriced BUY/SELL leg (unknown cost basis).
  // Deterministically ordered so, on truncation, only wallets at/after the
  // boundary walletId are uncertain — those become rotation-INELIGIBLE.
  const dnaWalletRows = await prisma.wallet.findMany({ where: { chain, address: { in: dnaWallets } }, select: { id: true, address: true } });
  const addrOfId = new Map(dnaWalletRows.map((w) => [w.id, w.address]));
  const unpricedLegRows = await prisma.walletTokenTrade.findMany({
    where: { chain, walletId: { in: dnaWalletRows.map((w) => w.id) }, action: { in: ['BUY', 'SELL'] }, amountUsd: 0 },
    orderBy: [{ walletId: 'asc' }, { tokenId: 'asc' }],
    select: { walletId: true, token: { select: { address: true } } },
    distinct: ['walletId', 'tokenId'],
    take: UNPRICED_CAP + 1
  });
  const unpricedTruncated = unpricedLegRows.length > UNPRICED_CAP;
  if (unpricedTruncated) truncated = true;
  const usableUnpriced = unpricedLegRows.slice(0, UNPRICED_CAP);
  const unpricedTokensOf = new Map<string, Set<string>>();
  for (const t of usableUnpriced) {
    const a = addrOfId.get(t.walletId);
    if (!a) continue;
    const s = unpricedTokensOf.get(a) ?? new Set<string>();
    s.add(t.token.address);
    unpricedTokensOf.set(a, s);
  }
  // Boundary walletId: on truncation only wallets with id < boundary are fully
  // loaded and rotation-eligible (their unpriced set is complete).
  const boundaryWalletId = unpricedTruncated ? usableUnpriced[usableUnpriced.length - 1]?.walletId ?? null : null;
  const rotationEligible = new Set(
    unpricedTruncated && boundaryWalletId !== null
      ? dnaWalletRows.filter((w) => w.id < boundaryWalletId).map((w) => w.address)
      : dnaWalletRows.map((w) => w.address)
  );

  for (const p of profiles) {
    try {
      const truncatedProfile = (p.profileJson as { localViewTruncated?: boolean } | null)?.localViewTruncated === true;
      // Truncated profile OR a wallet past the unpriced-leg boundary -> cost
      // basis may be incomplete, so no realized profit can be asserted.
      if (truncatedProfile || !rotationEligible.has(p.walletAddress)) continue;
      const positions = ((p.profileJson as { local?: { tokenPositions?: Position[] } } | null)?.local?.tokenPositions ?? []);
      const unpriced = unpricedTokensOf.get(p.walletAddress) ?? new Set<string>();
      const entityKey = entityOf.get(p.walletAddress) ?? p.walletAddress;
      // Profitable RUNNER positions, cost basis fully priced. Anchor on the
      // FIRST sell (firstBuyTs + timeToFirstSellSec).
      const exits = positions
        .filter(
          (pos) =>
            runnerMints.has(pos.tokenAddress) &&
            pos.buyUsd > 0 &&
            !unpriced.has(pos.tokenAddress) &&
            pos.sellUsd - pos.buyUsd > 0 &&
            pos.firstBuyTs !== null &&
            pos.timeToFirstSellSec !== null
        )
        .map((pos) => ({ pos, firstSellMs: new Date(pos.firstBuyTs!).getTime() + (pos.timeToFirstSellSec as number) * 1000 }))
        .filter((e) => Number.isFinite(e.firstSellMs))
        .sort((a, b) => a.firstSellMs - b.firstSellMs);
      if (exits.length === 0) continue;
      const laterBuys = positions
        .filter((pos) => pos.firstBuyTs !== null && pos.buyUsd > 0)
        .sort((a, b) => (a.firstBuyTs! < b.firstBuyTs! ? -1 : 1));
      for (const { pos: exit, firstSellMs } of exits) {
        const dest = laterBuys.find(
          (b) => b.tokenAddress !== exit.tokenAddress && new Date(b.firstBuyTs!).getTime() > firstSellMs
        );
        if (!dest) continue;
        const tok = await prisma.token.findUnique({ where: { chain_address: { chain, address: dest.tokenAddress } }, select: { symbol: true } });
        const delay = Math.round((new Date(dest.firstBuyTs!).getTime() - firstSellMs) / 1000);
        const destPriced = dest.buyUsd > 0 && !unpriced.has(dest.tokenAddress);
        await upsert({
          kind: 'profit_rotation',
          sourceEntityKey: entityKey,
          sourceWallet: p.walletAddress,
          receiverWallet: p.walletAddress, // same-wallet rotation
          route: 'same_wallet_rotation',
          evidenceTier: 'inferred_rotation', // NOT a transfer — inference from local positions
          knownValueUsd: destPriced ? dest.buyUsd : null,
          fundingTs: new Date(firstSellMs),
          tokenBought: dest.tokenAddress,
          tokenBoughtSymbol: tok?.symbol ?? null,
          entryMcapUsd: null,
          fundingToBuyDelaySec: delay,
          sourceToken: exit.tokenAddress,
          realizedProfitUsd: exit.sellUsd - exit.buyUsd,
          receiverClass: null,
          relationshipTier: null,
          independentEntitiesOnToken: entityCountOf(dest.tokenAddress),
          confidence: 45,
          reasonCodes: ['profit_realized_on_runner_then_bought_another_token'],
          caveats: [
            'INFERRED same-wallet rotation from local priced positions — a fully-priced realized runner profit followed by a later buy; NOT proof the same dollars moved and NOT transfer evidence'
          ],
          receipts: { sourceRunner: exit.tokenAddress, realizedProfitUsd: exit.sellUsd - exit.buyUsd, rotatedIntoBuyUsd: destPriced ? dest.buyUsd : null }
        });
        report.profitRotation += 1;
        report.endToEndExamples += 1;
      }
    } catch (err) {
      report.errors += 1;
      if (report.errorReceipts.length < ERROR_RECEIPTS_MAX) report.errorReceipts.push(toErrorReceipt(`rotation:${p.walletAddress}`, err));
    }
  }

  // Reconcile stale chains ONLY when the run was clean AND not truncated — a
  // truncated outflow window could otherwise erase valid rows it never saw.
  if (report.errors === 0 && !truncated) {
    await prisma.capitalChain.deleteMany({ where: { chain, computedAt: { lt: now } } });
  }
  return report;
}
