import type { Chain, NormalizedTx, TxLeg } from '../types';
import type { BridgeMessage, MassEventKind, MassTransactionEvent } from './types';

export interface NormalizeTransactionContext {
  chain: Chain;
  provider: string;
  observedAt: Date;
  status?: 'succeeded' | 'failed';
  /** Optional decoded bridge metadata indexed by leg number. */
  bridgeByLeg?: ReadonlyMap<number, BridgeMessage>;
}

function normalizeAddress(chain: Chain, address: string): string {
  const trimmed = address.trim();
  return chain === 'BSC' ? trimmed.toLowerCase() : trimmed;
}

function eventKind(leg: TxLeg, walletAddress?: string): MassEventKind {
  if (leg.kind === 'bridge_deposit') return 'bridge_source';
  if (leg.kind === 'bridge_withdrawal') return 'bridge_destination';
  if (leg.kind === 'swap_leg') return walletAddress && leg.to === walletAddress ? 'token_buy' : 'token_sell';
  return leg.kind;
}

/** Deterministically expands one provider-normalized transaction into events. */
export function normalizeMassTransaction(
  tx: NormalizedTx,
  ctx: NormalizeTransactionContext,
  walletAddress?: string
): MassTransactionEvent[] {
  const actor = walletAddress ? normalizeAddress(ctx.chain, walletAddress) : null;
  const actorSentValue = actor !== null && tx.legs.some((leg) =>
    (leg.kind === 'native_transfer' || leg.kind === 'token_transfer' || leg.kind === 'swap_leg') &&
    normalizeAddress(ctx.chain, leg.from) === actor && Number(leg.amountToken) > 0
  );
  const contractTargets = tx.legs
    .filter((leg) => leg.kind === 'contract_interaction')
    .map((leg) => normalizeAddress(ctx.chain, leg.to))
    .filter(Boolean);
  return tx.legs.map((leg, eventIndex) => {
    const from = normalizeAddress(ctx.chain, leg.from);
    const to = normalizeAddress(ctx.chain, leg.to);
    const kind = eventKind(leg, walletAddress ? normalizeAddress(ctx.chain, walletAddress) : undefined);
    return {
      eventId: `${ctx.chain}:${tx.txHash}:${eventIndex}`,
      chain: ctx.chain,
      txHash: tx.txHash,
      eventIndex,
      blockOrSlot: tx.blockOrSlot,
      ts: new Date(tx.ts),
      kind,
      status: ctx.status ?? tx.status ?? 'succeeded',
      from,
      to,
      actor,
      asset: {
        address: leg.asset.address ? normalizeAddress(ctx.chain, leg.asset.address) : null,
        symbol: leg.asset.symbol || null,
        decimals: Number.isInteger(leg.asset.decimals) ? leg.asset.decimals : null,
        amount: leg.amountToken,
        amountUsd: Number.isFinite(leg.amountUsd) ? (leg.amountUsd ?? null) : null
      },
      programOrContract: leg.programOrContract ? normalizeAddress(ctx.chain, leg.programOrContract) : null,
      provider: ctx.provider,
      observedAt: new Date(ctx.observedAt),
      bridge: ctx.bridgeByLeg?.get(eventIndex) ?? null,
      metadata: {
        transactionLegCount: tx.legs.length,
        sameTxActorSentValue: actorSentValue,
        sameTxContractTargets: contractTargets
      }
    };
  });
}
