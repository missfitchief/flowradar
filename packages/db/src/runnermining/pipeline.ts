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

      let status: string;
      const reasons: string[] = [];
      if (walletCount > 0 && (cands?.verified ?? 0) > 0) {
        status = 'local_reconstruction_ok';
        reasons.push(`locally_verified_wallets:${cands?.verified}`);
      } else if (walletCount > 0) {
        status = 'incomplete_coverage';
        reasons.push('candidates_exist_but_none_locally_verified');
      } else if (!hasTokenRow) {
        status = 'unavailable';
        reasons.push('no_local_token_row');
      } else if (!hasLocalTrades) {
        // No local trades: provider is the only path, and it's quota-blocked.
        status = fetchState === 'provider_error' ? 'retryable_provider_failure' : fetchState === 'empty' ? 'no_valid_wallets' : 'unavailable';
        reasons.push(fetchState ? `provider_fetch:${fetchState}` : 'no_local_trades_no_provider_data');
      } else {
        status = 'no_valid_wallets';
        reasons.push('local_trades_exist_but_no_extractable_top_pnl_wallets');
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
    independentEntitiesOnToken: number;
    confidence: number;
    reasonCodes: string[];
    caveats: string[];
    receipts: unknown;
  }) => {
    const dedupeKey = `${row.kind}|${row.sourceWallet}|${row.receiverWallet ?? ''}|${row.tokenBought ?? ''}`;
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

  // Entity keys for source wallets (entity-adjusted, so linked wallets share
  // one entity and are never counted as independent).
  const dnaWallets = (
    await prisma.walletDnaProfile.findMany({ where: { chain }, select: { walletAddress: true }, orderBy: { walletAddress: 'asc' } })
  ).map((w) => w.walletAddress);
  const entityOf = await entityKeysFor(prisma, chain, dnaWallets);
  const entityKeyOf = (w: string) => entityOf.get(w) ?? w;

  // Independent-entity count per candidate token (for the end-to-end join).
  const candidateEntityCount = new Map<string, number>();
  for (const c of await prisma.tokenCandidateScore.findMany({
    where: { chain },
    select: { mint: true, independentEntityCount: true }
  })) {
    candidateEntityCount.set(c.mint, c.independentEntityCount);
  }

  try {
    // --- STAGING + DEPLOYMENT: outflow (transfer) -> receiver -> its buys ---
    const outflows = await prisma.capitalOutflowPath.findMany({
      where: { chain, destinationType: 'wallet', evidenceTier: { in: ['direct_transfer', 'multi_hop_transfer'] } },
      orderBy: [{ sourceWallet: 'asc' }, { destinationAddress: 'asc' }],
      take: limit
    });
    const receiverEnrollments = new Map(
      (await prisma.receiverEnrollment.findMany({ where: { chain }, select: { receiverAddress: true, receiverClass: true, deploymentsJson: true, firstReceiptTs: true } }))
        .map((r) => [r.receiverAddress, r])
    );
    for (const o of outflows) {
      const enrollment = receiverEnrollments.get(o.destinationAddress);
      await upsert({
        kind: 'staging',
        sourceEntityKey: entityKeyOf(o.sourceWallet),
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
        independentEntitiesOnToken: 0,
        confidence: o.evidenceTier === 'direct_transfer' ? 60 : 45,
        reasonCodes: [`capital_staged_to_${o.receiverClassAtReceipt}`],
        caveats: ['staging is a transfer of capital to a fresh/dormant/linked wallet BEFORE any observed token buy'],
        receipts: { firstTransferTs: o.firstTransferTs.toISOString() }
      });
      report.staging += 1;

      // DEPLOYMENT: a receiver's post-receipt deployments (honest — usually 0).
      const deployments = (enrollment?.deploymentsJson ?? []) as { mint: string; firstBuyTs: string; buyCount: number; boughtKnownUsd: number | null }[];
      for (const dep of deployments.slice(0, 10)) {
        const tok = await prisma.token.findUnique({ where: { chain_address: { chain, address: dep.mint } }, select: { symbol: true } });
        const delay = enrollment ? Math.round((new Date(dep.firstBuyTs).getTime() - enrollment.firstReceiptTs.getTime()) / 1000) : null;
        await upsert({
          kind: 'deployment',
          sourceEntityKey: entityKeyOf(o.sourceWallet),
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
          independentEntitiesOnToken: candidateEntityCount.get(dep.mint) ?? 0,
          confidence: 55,
          reasonCodes: ['staged_receiver_deployed_capital_into_token'],
          caveats: ['deployment = the funded receiver later BOUGHT this token; observation_only'],
          receipts: { deploymentFirstBuyTs: dep.firstBuyTs, buyCount: dep.buyCount }
        });
        report.deployment += 1;
        report.endToEndExamples += 1;
      }
    }

    // --- PROFIT ROTATION: within a wallet, a profitable RUNNER exit followed
    //     by a buy into ANOTHER token (same-wallet or linked-entity). Built
    //     from local priced positions in the behavior profile. ------------
    const runnerMints = new Set(
      (await prisma.tokenLifecycle.findMany({ where: { runnerClass: 'verified_above_10m' }, select: { mint: true } })).map((r) => r.mint)
    );
    const profiles = await prisma.walletBehaviorProfile.findMany({
      where: { chain, walletAddress: { in: dnaWallets } },
      select: { walletAddress: true, profileJson: true }
    });
    for (const p of profiles) {
      const positions = ((p.profileJson as { local?: { tokenPositions?: Position[] } } | null)?.local?.tokenPositions ?? []);
      // Profitable RUNNER positions (realized profit proven by the full
      // position) that had begun taking profit — anchor on the FIRST sell
      // (firstBuyTs + timeToFirstSellSec), the moment profit-taking started,
      // since a wallet often redeploys before finishing the exit.
      const exits = positions
        .filter(
          (pos) =>
            runnerMints.has(pos.tokenAddress) &&
            pos.buyUsd > 0 &&
            pos.sellUsd - pos.buyUsd > 0 &&
            pos.firstBuyTs !== null &&
            pos.timeToFirstSellSec !== null
        )
        .map((pos) => ({ pos, firstSellMs: new Date(pos.firstBuyTs!).getTime() + (pos.timeToFirstSellSec as number) * 1000 }))
        .sort((a, b) => a.firstSellMs - b.firstSellMs);
      if (exits.length === 0) continue;
      // subsequent BUYS into other tokens (rotation destination)
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
        await upsert({
          kind: 'profit_rotation',
          sourceEntityKey: entityKeyOf(p.walletAddress),
          sourceWallet: p.walletAddress,
          receiverWallet: p.walletAddress, // same-wallet rotation
          route: 'same_wallet_rotation',
          evidenceTier: 'direct_transfer',
          knownValueUsd: dest.buyUsd,
          fundingTs: new Date(firstSellMs),
          tokenBought: dest.tokenAddress,
          tokenBoughtSymbol: tok?.symbol ?? null,
          entryMcapUsd: null,
          fundingToBuyDelaySec: delay,
          sourceToken: exit.tokenAddress,
          realizedProfitUsd: exit.sellUsd - exit.buyUsd,
          receiverClass: null,
          relationshipTier: null,
          independentEntitiesOnToken: candidateEntityCount.get(dest.tokenAddress) ?? 0,
          confidence: 55,
          reasonCodes: ['profit_realized_on_runner_then_bought_another_token'],
          caveats: [
            'same-wallet capital rotation inferred from local priced positions — a realized runner profit followed by a later buy; not proof the exact dollars moved'
          ],
          receipts: { sourceRunner: exit.tokenAddress, realizedProfitUsd: exit.sellUsd - exit.buyUsd, rotatedIntoBuyUsd: dest.buyUsd }
        });
        report.profitRotation += 1;
        report.endToEndExamples += 1;
      }
    }
  } catch (err) {
    report.errors += 1;
    if (report.errorReceipts.length < ERROR_RECEIPTS_MAX) report.errorReceipts.push(toErrorReceipt('capital-chains', err));
  }
  // Reconcile stale chains from prior runs (computedAt < now) when clean.
  if (report.errors === 0) {
    await prisma.capitalChain.deleteMany({ where: { chain, computedAt: { lt: now } } });
  }
  return report;
}
