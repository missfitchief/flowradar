// FlowRadar — ingest pipeline: NormalizedTx[] -> Wallet/Token/WalletTokenTrade/
// MoneyFlowEdge rows, plus TokenMarket -> TokenMarketSnapshot.
//
// Normative source: Task 5 brief "Decisions resolving ambiguity" #1. This is
// the single place raw provider output (mock today, live in Wave 4) becomes
// durable rows — every later worker job and every page reads through these
// tables, never through a provider directly.
//
// Scope note: `ingestNormalizedTxs` is called once per *watched wallet's*
// activity stream (mirroring `WalletActivityProvider.getWalletTransactions(chain,
// address)`), so a WalletTokenTrade row is only ever created for `walletAddress`
// itself — a leg where neither `from` nor `to` equals `walletAddress` produces
// no trade row from that call (it will when that other wallet's own activity
// stream is ingested). MoneyFlowEdge rows are wallet-agnostic directed edges
// (raw source/destination addresses, no Wallet FK) and are written once per
// qualifying leg regardless of which wallet's stream triggered the call —
// dedup on (txHash, sourceAddress, destinationAddress, actionType) makes
// repeated writes from multiple wallets' perspectives idempotent.
//
// Decimal/Float coercion: several WalletTokenTrade/TokenMarketSnapshot columns
// are non-nullable Decimal/Float/Int in schema.prisma (priceUsd,
// marketCapAtTrade, walletScoreAtTime, TokenMarketSnapshot's market fields)
// even though the corresponding source values (@flowradar/core's TokenMarket,
// "latest snapshot if any") are naturally nullable/absent-on-first-sight. Per
// brief decision 1, "else null" in that situation is coerced to 0 here so the
// non-nullable column always gets a concrete number — 0 reads honestly as
// "no data yet" for a UI that always shows *something* rather than crashing
// on a missing snapshot row.

import type { PrismaClient } from '@prisma/client';
import type { Chain, NormalizedTx, TokenMarket, TxLeg } from '@flowradar/core';

const PROVIDER_SOURCE = 'mock';

type TradeAction = 'BUY' | 'SELL' | 'TRANSFER_IN' | 'TRANSFER_OUT' | 'LP_ADD' | 'LP_REMOVE';
type MoneyFlowActionType =
  | 'transfer'
  | 'swap'
  | 'bridge_deposit'
  | 'bridge_withdrawal'
  | 'cex_deposit'
  | 'cex_withdrawal'
  | 'dex_buy'
  | 'dex_sell'
  | 'lp_add'
  | 'lp_remove'
  | 'contract_interaction';

// ---------------------------------------------------------------------------
// ingestNormalizedTxs
// ---------------------------------------------------------------------------

/**
 * Ingests one wallet's NormalizedTx activity stream: upserts Wallet/Token
 * stubs on first sight, writes WalletTokenTrade rows for legs touching
 * `walletAddress`, and writes MoneyFlowEdge rows for transfer/bridge legs
 * (wallet-agnostic — written regardless of which wallet's stream produced
 * them). Safe to call repeatedly with overlapping tx sets: both trade rows
 * (unique on chain+txHash+walletId+tokenId+action) and edge rows (deduped by
 * an explicit existence check on txHash+sourceAddress+destinationAddress+
 * actionType) are no-ops on repeat.
 */
export async function ingestNormalizedTxs(
  prisma: PrismaClient,
  chain: Chain,
  walletAddress: string,
  txs: NormalizedTx[]
): Promise<void> {
  if (txs.length === 0) return;

  // Upsert the ingested wallet once up front (every leg below may need its
  // id), using the earliest/latest tx timestamps across the whole batch as
  // firstSeenAt/lastActiveAt bounds.
  const sortedTs = txs.map((tx) => tx.ts.getTime()).sort((a, b) => a - b);
  const earliestTs = new Date(sortedTs[0]!);
  const latestTs = new Date(sortedTs[sortedTs.length - 1]!);
  const wallet = await upsertWallet(prisma, chain, walletAddress, earliestTs, latestTs);

  for (const tx of txs) {
    for (const leg of tx.legs) {
      await ingestLeg(prisma, chain, wallet.id, walletAddress, tx, leg);
    }
  }
}

async function upsertWallet(
  prisma: PrismaClient,
  chain: Chain,
  address: string,
  seenAt: Date,
  activeAt: Date
): Promise<{ id: string }> {
  return prisma.wallet.upsert({
    where: { address_chain: { address, chain } },
    create: {
      address,
      chain,
      firstSeenAt: seenAt,
      lastActiveAt: activeAt
    },
    update: {
      // lastActiveAt only ever moves forward; firstSeenAt is set once at
      // creation and never revised down here (a later tx.ts arriving out of
      // batch order should not retroactively lower an already-recorded
      // firstSeenAt from a previous ingest call).
      lastActiveAt: activeAt
    },
    select: { id: true }
  });
}

async function upsertToken(
  prisma: PrismaClient,
  chain: Chain,
  asset: TxLeg['asset'],
  seenAt: Date
): Promise<{ id: string } | null> {
  if (!asset.address) return null;
  return prisma.token.upsert({
    where: { chain_address: { chain, address: asset.address } },
    create: {
      chain,
      address: asset.address,
      symbol: asset.symbol,
      name: asset.symbol,
      decimals: asset.decimals,
      firstSeenAt: seenAt,
      riskFlags: []
    },
    update: {},
    select: { id: true }
  });
}

async function ingestLeg(
  prisma: PrismaClient,
  chain: Chain,
  walletId: string,
  walletAddress: string,
  tx: NormalizedTx,
  leg: TxLeg
): Promise<void> {
  switch (leg.kind) {
    case 'swap_leg':
      await ingestSwapLeg(prisma, chain, walletId, walletAddress, tx, leg);
      return;
    case 'token_transfer':
      await ingestTokenTransferLeg(prisma, chain, walletId, walletAddress, tx, leg);
      return;
    case 'native_transfer':
      await ingestTransferEdgeOnly(prisma, chain, tx, leg, 'transfer');
      return;
    case 'bridge_deposit':
      await ingestTransferEdgeOnly(prisma, chain, tx, leg, 'bridge_deposit');
      return;
    case 'bridge_withdrawal':
      await ingestTransferEdgeOnly(prisma, chain, tx, leg, 'bridge_withdrawal');
      return;
    case 'lp_add':
      await ingestLpLeg(prisma, chain, walletId, walletAddress, tx, leg, 'LP_ADD');
      return;
    case 'lp_remove':
      await ingestLpLeg(prisma, chain, walletId, walletAddress, tx, leg, 'LP_REMOVE');
      return;
    case 'contract_interaction':
      // Explicitly a no-op in this task per brief decision 1 ("skip — no row").
      return;
    default:
      assertNever(leg.kind);
  }
}

// ---------------------------------------------------------------------------
// swap_leg -> BUY/SELL trade
// ---------------------------------------------------------------------------

async function ingestSwapLeg(
  prisma: PrismaClient,
  chain: Chain,
  walletId: string,
  walletAddress: string,
  tx: NormalizedTx,
  leg: TxLeg
): Promise<void> {
  let action: TradeAction;
  if (leg.to === walletAddress) {
    action = 'BUY';
  } else if (leg.from === walletAddress) {
    action = 'SELL';
  } else {
    return; // leg doesn't touch the wallet whose stream is being ingested
  }

  const token = await upsertToken(prisma, chain, leg.asset, tx.ts);
  if (!token) return; // swap leg with no token address is not representable as a trade

  const amountToken = Number(leg.amountToken);
  const amountUsd = leg.amountUsd ?? 0;
  const priceUsd = amountUsd > 0 && amountToken > 0 ? amountUsd / amountToken : 0;
  const marketCapAtTrade = await latestMarketCapUsd(prisma, token.id);
  const walletScoreAtTime = await latestWalletScore(prisma, walletId);

  await upsertTrade(prisma, {
    chain,
    walletId,
    tokenId: token.id,
    action,
    amountToken,
    amountUsd,
    txHash: tx.txHash,
    blockOrSlot: tx.blockOrSlot,
    ts: tx.ts,
    priceUsd,
    marketCapAtTrade,
    walletScoreAtTime
  });
}

// ---------------------------------------------------------------------------
// token_transfer -> TRANSFER_IN/OUT trade + MoneyFlowEdge
// ---------------------------------------------------------------------------

async function ingestTokenTransferLeg(
  prisma: PrismaClient,
  chain: Chain,
  walletId: string,
  walletAddress: string,
  tx: NormalizedTx,
  leg: TxLeg
): Promise<void> {
  const token = await upsertToken(prisma, chain, leg.asset, tx.ts);

  if (token) {
    let action: TradeAction | null = null;
    if (leg.to === walletAddress) action = 'TRANSFER_IN';
    else if (leg.from === walletAddress) action = 'TRANSFER_OUT';

    if (action) {
      const amountToken = Number(leg.amountToken);
      const amountUsd = leg.amountUsd ?? 0;
      const priceUsd = amountUsd > 0 && amountToken > 0 ? amountUsd / amountToken : 0;
      const marketCapAtTrade = await latestMarketCapUsd(prisma, token.id);
      const walletScoreAtTime = await latestWalletScore(prisma, walletId);

      await upsertTrade(prisma, {
        chain,
        walletId,
        tokenId: token.id,
        action,
        amountToken,
        amountUsd,
        txHash: tx.txHash,
        blockOrSlot: tx.blockOrSlot,
        ts: tx.ts,
        priceUsd,
        marketCapAtTrade,
        walletScoreAtTime
      });
    }
  }

  await upsertMoneyFlowEdge(prisma, {
    chain,
    tx,
    leg,
    actionType: 'transfer'
  });
}

// ---------------------------------------------------------------------------
// native_transfer / bridge_* -> MoneyFlowEdge only
// ---------------------------------------------------------------------------

async function ingestTransferEdgeOnly(
  prisma: PrismaClient,
  chain: Chain,
  tx: NormalizedTx,
  leg: TxLeg,
  actionType: MoneyFlowActionType
): Promise<void> {
  await upsertMoneyFlowEdge(prisma, { chain, tx, leg, actionType });
}

// ---------------------------------------------------------------------------
// lp_add / lp_remove -> LP_ADD/LP_REMOVE trade
// ---------------------------------------------------------------------------

async function ingestLpLeg(
  prisma: PrismaClient,
  chain: Chain,
  walletId: string,
  walletAddress: string,
  tx: NormalizedTx,
  leg: TxLeg,
  action: 'LP_ADD' | 'LP_REMOVE'
): Promise<void> {
  if (leg.to !== walletAddress && leg.from !== walletAddress) return;

  const token = await upsertToken(prisma, chain, leg.asset, tx.ts);
  if (!token) return;

  const amountToken = Number(leg.amountToken);
  const amountUsd = leg.amountUsd ?? 0;
  const priceUsd = amountUsd > 0 && amountToken > 0 ? amountUsd / amountToken : 0;
  const marketCapAtTrade = await latestMarketCapUsd(prisma, token.id);
  const walletScoreAtTime = await latestWalletScore(prisma, walletId);

  await upsertTrade(prisma, {
    chain,
    walletId,
    tokenId: token.id,
    action,
    amountToken,
    amountUsd,
    txHash: tx.txHash,
    blockOrSlot: tx.blockOrSlot,
    ts: tx.ts,
    priceUsd,
    marketCapAtTrade,
    walletScoreAtTime
  });
}

// ---------------------------------------------------------------------------
// Shared writers
// ---------------------------------------------------------------------------

interface TradeWriteInput {
  chain: Chain;
  walletId: string;
  tokenId: string;
  action: TradeAction;
  amountToken: number;
  amountUsd: number;
  txHash: string;
  blockOrSlot: bigint;
  ts: Date;
  priceUsd: number;
  marketCapAtTrade: number;
  walletScoreAtTime: number;
}

/**
 * Upsert on the schema's unique(chain, txHash, walletId, tokenId, action) key
 * — re-ingesting the same (tx, leg) pair for the same wallet is a no-op write
 * (the `update: {}` branch touches no columns), satisfying the "re-ingest ⇒
 * zero new rows" dedupe requirement without a separate existence check.
 */
async function upsertTrade(prisma: PrismaClient, input: TradeWriteInput): Promise<void> {
  await prisma.walletTokenTrade.upsert({
    where: {
      chain_txHash_walletId_tokenId_action: {
        chain: input.chain,
        txHash: input.txHash,
        walletId: input.walletId,
        tokenId: input.tokenId,
        action: input.action
      }
    },
    create: {
      walletId: input.walletId,
      tokenId: input.tokenId,
      chain: input.chain,
      action: input.action,
      amountToken: input.amountToken,
      amountUsd: input.amountUsd,
      txHash: input.txHash,
      blockOrSlot: input.blockOrSlot,
      ts: input.ts,
      priceUsd: input.priceUsd,
      marketCapAtTrade: input.marketCapAtTrade,
      walletScoreAtTime: input.walletScoreAtTime,
      provider: PROVIDER_SOURCE
    },
    update: {}
  });
}

interface EdgeWriteInput {
  chain: Chain;
  tx: NormalizedTx;
  leg: TxLeg;
  actionType: MoneyFlowActionType;
}

/**
 * MoneyFlowEdge has no unique constraint in schema (Task 5 brief decision 1
 * defines dedupe manually: skip when a row with the same
 * txHash+sourceAddress+destinationAddress+actionType already exists). A plain
 * findFirst-then-create is sufficient — every ingest call in this codebase
 * runs sequentially (jobs process one wallet/tx set at a time), so there is
 * no concurrent-write race on the same leg to guard against with a DB-level
 * constraint.
 *
 * sourceChain/destinationChain are set to the same `chain` the caller passes
 * (the chain the leg's own NormalizedTx belongs to) — a bridge's two sides
 * are two separate NormalizedTx on two separate chains in the mock world
 * (see mock/scenarios.ts buildAlphaToBeta), each ingested as its own leg on
 * its own chain, so a single MoneyFlowEdge row's source/destination chain are
 * identical (cross-chain bridge linkage is a pair of same-chain edges joined
 * by matching amount/time/protocol, not one cross-chain edge row).
 */
async function upsertMoneyFlowEdge(prisma: PrismaClient, input: EdgeWriteInput): Promise<void> {
  const { chain, tx, leg, actionType } = input;
  const existing = await prisma.moneyFlowEdge.findFirst({
    where: {
      txHash: tx.txHash,
      sourceAddress: leg.from,
      destinationAddress: leg.to,
      actionType
    },
    select: { id: true }
  });
  if (existing) return;

  const bridgeProtocol =
    (actionType === 'bridge_deposit' || actionType === 'bridge_withdrawal') && leg.programOrContract
      ? leg.programOrContract
      : null;

  await prisma.moneyFlowEdge.create({
    data: {
      sourceAddress: leg.from,
      destinationAddress: leg.to,
      sourceChain: chain,
      destinationChain: chain,
      asset: leg.asset.symbol,
      amountToken: Number(leg.amountToken),
      amountUsd: leg.amountUsd ?? 0,
      ts: tx.ts,
      txHash: tx.txHash,
      actionType,
      bridgeProtocol,
      confidence: 100,
      providerSource: PROVIDER_SOURCE,
      metadata: {}
    }
  });
}

async function latestMarketCapUsd(prisma: PrismaClient, tokenId: string): Promise<number> {
  const latest = await prisma.tokenMarketSnapshot.findFirst({
    where: { tokenId },
    orderBy: { ts: 'desc' },
    select: { marketCapUsd: true }
  });
  return latest ? Number(latest.marketCapUsd) : 0;
}

async function latestWalletScore(prisma: PrismaClient, walletId: string): Promise<number> {
  const latest = await prisma.walletStats.findFirst({
    where: { walletId },
    orderBy: { computedAt: 'desc' },
    select: { walletScore: true }
  });
  return latest ? latest.walletScore : 0;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled leg kind: ${String(value)}`);
}

// ---------------------------------------------------------------------------
// snapshotMarket
// ---------------------------------------------------------------------------

/**
 * Writes one TokenMarketSnapshot row from a TokenMarket reading. TokenMarket's
 * marketCapUsd/fdvUsd/liquidityUsd/holderCount are nullable (a provider may
 * genuinely not know a value) but the corresponding schema columns are
 * non-nullable Decimal/Int — null is coerced to 0 (see file header).
 */
export async function snapshotMarket(
  prisma: PrismaClient,
  tokenId: string,
  market: TokenMarket,
  ts: Date
): Promise<void> {
  await prisma.tokenMarketSnapshot.create({
    data: {
      tokenId,
      ts,
      priceUsd: market.priceUsd,
      marketCapUsd: market.marketCapUsd ?? 0,
      fdvUsd: market.fdvUsd ?? 0,
      liquidityUsd: market.liquidityUsd ?? 0,
      vol5m: market.vol5m,
      vol1h: market.vol1h,
      vol6h: market.vol6h,
      vol24h: market.vol24h,
      holderCount: market.holderCount ?? 0
    }
  });
}
