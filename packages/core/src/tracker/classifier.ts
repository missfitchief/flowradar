import type {
  MassTransactionEvent,
  RelevanceConfig,
  RelevanceVerdict,
  TrackerAddressContext
} from './types';
import { DEFAULT_RELEVANCE_CONFIG } from './types';

const NEVER_LINK_INFRA = new Set(['CEX', 'BRIDGE', 'ROUTER', 'POOL', 'MIXER', 'TOKEN_CONTRACT', 'PROGRAM', 'BURN', 'SYSTEM']);

function base(category: RelevanceVerdict['category'], score: number, reasons: string[]): RelevanceVerdict {
  return {
    relevant: score >= 50,
    category,
    score,
    reasonCodes: reasons,
    safeEntityLink: false,
    enrollmentCandidate: false,
    grantsTraderRole: false
  };
}

function isService(ctx: TrackerAddressContext, cfg: RelevanceConfig): boolean {
  return (ctx.infrastructure !== null && NEVER_LINK_INFRA.has(ctx.infrastructure)) || ctx.distinctCounterparties >= cfg.serviceDegreeThreshold;
}

function amount(event: MassTransactionEvent): number | null {
  const value = Number(event.asset.amount);
  return Number.isFinite(value) ? value : null;
}

/** Pure, deterministic event relevance and entity-link safety classifier. */
export function classifyMassEvent(
  event: MassTransactionEvent,
  from: TrackerAddressContext,
  to: TrackerAddressContext,
  config: Partial<RelevanceConfig> = {}
): RelevanceVerdict {
  const cfg = { ...DEFAULT_RELEVANCE_CONFIG, ...config };
  if (event.status === 'failed') return base('failed', 0, ['transaction_failed']);
  if (event.kind === 'token_buy') {
    const verdict = base('token_deployment', 90, ['wallet_received_swap_output', 'token_buy_is_terminal_trace_event']);
    verdict.relevant = true;
    return verdict;
  }
  if (!event.from || !event.to || event.from === event.to) return base('self_transfer', 0, ['missing_or_same_counterparty']);

  const fromService = isService(from, cfg);
  const toService = isService(to, cfg);
  if (event.kind === 'contract_interaction') return base('contract_noise', 5, ['contract_interaction_without_value_transfer']);

  if (event.kind === 'bridge_source' || event.kind === 'bridge_destination') {
    const official = event.bridge?.officialMessageId != null && event.bridge.verifiedBy !== 'heuristic' && event.bridge.protocolCompleted;
    const verdict = base(official ? 'bridge_verified' : 'bridge_unverified', official ? 95 : 45, [
      official ? 'official_protocol_message_completed' : 'bridge_leg_without_completed_protocol_message'
    ]);
    verdict.relevant = true; // raw bridge leg remains graph evidence even before correlation
    // Bridge contracts/programs are infrastructure by definition. The safe
    // cross-chain link is between the decoded protocol sender/recipient, not
    // between a wallet and the bridge endpoint accounts in from/to.
    verdict.safeEntityLink = official && Boolean(event.bridge?.sender) && Boolean(event.bridge?.recipient);
    verdict.enrollmentCandidate = verdict.safeEntityLink && event.kind === 'bridge_destination';
    return verdict;
  }

  const evmStructuredSwapOutput =
    event.chain === 'BSC' && event.kind === 'token_transfer' && event.actor !== null &&
    event.to === event.actor && event.asset.address !== null &&
    event.metadata.sameTxActorSentValue === true &&
    Array.isArray(event.metadata.sameTxContractTargets) && event.metadata.sameTxContractTargets.length > 0;
  if (evmStructuredSwapOutput) {
    const verdict = base('token_deployment', 80, [
      'evm_same_tx_actor_outflow_contract_call_and_token_output',
      'deterministic_structure_not_provider_claim'
    ]);
    verdict.relevant = true;
    return verdict;
  }

  if (fromService || toService) {
    return base('infrastructure_noise', 10, [
      fromService ? 'source_is_infrastructure' : 'destination_is_infrastructure',
      'visible_but_never_entity_merged'
    ]);
  }

  if (event.kind !== 'native_transfer' && event.kind !== 'token_transfer') {
    return base('unrelated', 10, ['not_capital_movement']);
  }

  const usd = event.asset.amountUsd;
  const nativeAmount = amount(event);
  if (usd !== null && usd <= cfg.dustMaxUsd) return base('dust', 5, ['known_value_at_or_below_dust']);

  const senderTracked = from.trackedEntityKey !== null;
  const receiverFreshOrDormant = to.dormantDays === null || to.dormantDays >= cfg.dormantReceiverDays;
  const gasFunding =
    event.kind === 'native_transfer' &&
    usd === null &&
    nativeAmount !== null &&
    nativeAmount >= cfg.gasFundingMinNative &&
    nativeAmount <= cfg.gasFundingMaxNative;
  const aboveThreshold = usd !== null && usd >= cfg.minCapitalTransferUsd;

  if (!senderTracked || (!aboveThreshold && !gasFunding)) {
    return base('unrelated', aboveThreshold || gasFunding ? 40 : 20, [
      senderTracked ? 'below_relevance_threshold' : 'sender_not_in_tracked_entity',
      usd === null && !gasFunding ? 'unknown_value_not_assumed_relevant' : 'deterministic_threshold'
    ]);
  }

  const verdict = base(gasFunding ? 'gas_funding' : 'capital_transfer', gasFunding ? 75 : 85, [
    gasFunding ? 'bounded_native_gas_funding' : 'known_value_above_minimum',
    from.role === 'operator_root' ? 'operator_root_is_capital_provenance_not_trader' : 'tracked_sender',
    receiverFreshOrDormant ? 'receiver_fresh_or_dormant' : 'receiver_recently_active'
  ]);
  verdict.relevant = true;
  verdict.safeEntityLink = receiverFreshOrDormant;
  verdict.enrollmentCandidate = receiverFreshOrDormant;
  return verdict;
}
