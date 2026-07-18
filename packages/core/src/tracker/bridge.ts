import type { BridgeCorrelation, MassTransactionEvent } from './types';

export interface BridgeCorrelationConfig {
  heuristicWindowMs: number;
  heuristicAmountTolerancePct: number;
  allowHeuristic: boolean;
}

const DEFAULTS: BridgeCorrelationConfig = {
  heuristicWindowMs: 2 * 60 * 60_000,
  heuristicAmountTolerancePct: 5,
  allowHeuristic: true
};

function canonicalProtocol(protocol: string): string {
  return protocol.trim().toLowerCase();
}

function exactKey(event: MassTransactionEvent): string | null {
  const b = event.bridge;
  if (!b?.officialMessageId || b.verifiedBy === 'heuristic' || !b.protocolCompleted) return null;
  return `${canonicalProtocol(b.protocol)}:${b.officialMessageId}`;
}

function probablePair(source: MassTransactionEvent, destination: MassTransactionEvent, cfg: BridgeCorrelationConfig): boolean {
  if (!source.bridge || !destination.bridge) return false;
  if (canonicalProtocol(source.bridge.protocol) !== canonicalProtocol(destination.bridge.protocol)) return false;
  if (source.chain === destination.chain) return false;
  if (source.bridge.destinationChain !== destination.chain || destination.bridge.sourceChain !== source.chain) return false;
  const a = source.asset.amountUsd;
  const b = destination.asset.amountUsd;
  if (a === null || b === null || a <= 0 || b <= 0) return false;
  if (destination.ts < source.ts || destination.ts.getTime() - source.ts.getTime() > cfg.heuristicWindowMs) return false;
  const deltaPct = (Math.abs(a - b) / Math.max(a, b)) * 100;
  return deltaPct <= cfg.heuristicAmountTolerancePct;
}

/** One-to-one bridge pairing. Protocol message IDs take precedence over heuristics. */
export function correlateBridgeEvents(
  events: readonly MassTransactionEvent[],
  config: Partial<BridgeCorrelationConfig> = {}
): BridgeCorrelation[] {
  const cfg = { ...DEFAULTS, ...config };
  const sources = events.filter((e) => e.kind === 'bridge_source').sort(compareEvents);
  const destinations = events.filter((e) => e.kind === 'bridge_destination').sort(compareEvents);
  const usedDestinations = new Set<string>();
  const correlations: BridgeCorrelation[] = [];

  for (const source of sources) {
    const key = exactKey(source);
    let destination = key
      ? destinations.find((candidate) => !usedDestinations.has(candidate.eventId) && exactKey(candidate) === key)
      : undefined;
    let status: BridgeCorrelation['status'] = 'verified';
    if (!destination && cfg.allowHeuristic) {
      destination = destinations.find((candidate) => !usedDestinations.has(candidate.eventId) && probablePair(source, candidate, cfg));
      status = 'probable';
    }
    if (!destination) continue;
    usedDestinations.add(destination.eventId);
    correlations.push({
      correlationId: key ?? `heuristic:${source.eventId}:${destination.eventId}`,
      protocol: source.bridge?.protocol ?? destination.bridge?.protocol ?? 'unknown',
      source,
      destination,
      confidence: status === 'verified' ? 100 : 55,
      status,
      reasonCodes: status === 'verified'
        ? ['same_completed_official_message_id', 'cross_chain_direction_consistent']
        : ['amount_time_chain_heuristic_only', 'not_officially_verified']
    });
  }
  return correlations;
}

function compareEvents(a: MassTransactionEvent, b: MassTransactionEvent): number {
  return a.ts.getTime() - b.ts.getTime() || a.eventId.localeCompare(b.eventId);
}
