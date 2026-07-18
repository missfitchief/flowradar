import type { BridgeCorrelation, CapitalTrace, ClassifiedMassEvent, MassTransactionEvent, TraceConfig } from './types';
import { DEFAULT_TRACE_CONFIG } from './types';

interface QueueState {
  wallet: string;
  chain: string;
  hops: ClassifiedMassEvent[];
  bridges: BridgeCorrelation[];
  seen: Set<string>;
}

function walletKey(chain: string, address: string): string {
  return `${chain}:${address}`;
}

/** Bounded, time-monotonic direct/multi-hop/bridge capital-to-buy tracing. */
export function traceCapitalToTokenBuys(args: {
  sourceEntityKey: string;
  sourceWallet: string;
  sourceChain: MassTransactionEvent['chain'];
  sourceRole: CapitalTrace['sourceRole'];
  events: readonly ClassifiedMassEvent[];
  bridgeCorrelations?: readonly BridgeCorrelation[];
  config?: Partial<TraceConfig>;
}): CapitalTrace[] {
  const cfg = { ...DEFAULT_TRACE_CONFIG, ...args.config };
  const outgoing = new Map<string, ClassifiedMassEvent[]>();
  for (const classified of args.events) {
    if (!classified.verdict.relevant) continue;
    const key = walletKey(classified.event.chain, classified.event.actor ?? classified.event.from);
    const bucket = outgoing.get(key) ?? [];
    bucket.push(classified);
    outgoing.set(key, bucket);
  }
  for (const bucket of outgoing.values()) bucket.sort((a, b) => a.event.ts.getTime() - b.event.ts.getTime() || a.event.eventId.localeCompare(b.event.eventId));

  // Heuristic matches remain evidence but cannot carry entity lineage across
  // chains. Only protocol-verified message correlations enter the path graph.
  const bridgeBySource = new Map((args.bridgeCorrelations ?? []).filter((c) => c.status === 'verified').map((c) => [c.source.eventId, c]));
  const queue: QueueState[] = [{
    wallet: args.sourceWallet,
    chain: args.sourceChain,
    hops: [],
    bridges: [],
    seen: new Set([walletKey(args.sourceChain, args.sourceWallet)])
  }];
  const traces: CapitalTrace[] = [];
  let expanded = 0;

  while (queue.length > 0 && traces.length < cfg.maxPaths && expanded < cfg.maxPaths * cfg.maxHops) {
    const state = queue.shift()!;
    expanded++;
    if (state.hops.length >= cfg.maxHops) continue;
    const candidates = outgoing.get(walletKey(state.chain, state.wallet)) ?? [];
    const previousTs = state.hops.at(-1)?.event.ts;
    for (const candidate of candidates) {
      if (candidate.verdict.score < cfg.minLinkScore && candidate.event.kind !== 'token_buy') continue;
      if (previousTs && (candidate.event.ts < previousTs || candidate.event.ts.getTime() - previousTs.getTime() > cfg.maxGapMs)) continue;
      const hops = [...state.hops, candidate];
      if ((candidate.event.kind === 'token_buy' || candidate.verdict.category === 'token_deployment') && candidate.event.asset.address) {
        if (state.hops.length === 0) continue; // a root's own buy is not a funded-receiver chain
        const firstTs = hops[0]!.event.ts;
        const hasBridge = state.bridges.length > 0;
        traces.push({
          traceId: `${args.sourceEntityKey}:${hops.map((h) => h.event.eventId).join('>')}`,
          sourceEntityKey: args.sourceEntityKey,
          sourceRole: args.sourceRole,
          sourceWallet: args.sourceWallet,
          terminalWallet: state.wallet,
          tokenBought: candidate.event.asset.address,
          route: hasBridge
            ? hops.length <= 3 ? 'verified_bridge' : 'multi_hop_bridge'
            : hops.length === 2 ? 'direct_transfer' : 'multi_hop_transfer',
          hops,
          bridgeCorrelations: [...state.bridges],
          fundingToBuyDelaySec: Math.max(0, Math.floor((candidate.event.ts.getTime() - firstTs.getTime()) / 1000)),
          confidence: Math.min(...hops.map((h) => h.verdict.score), ...state.bridges.map((b) => b.confidence)),
          reasonCodes: [
            'time_monotonic_capital_path',
            hasBridge ? 'protocol_correlated_bridge_in_path' : 'direct_chain_path',
            args.sourceRole === 'operator_root'
              ? 'root_is_provenance_only'
              : args.sourceRole === 'execution_wallet'
                ? 'execution_wallet_source'
                : 'linked_entity_member_source'
          ],
          grantsEligibility: false
        });
        continue;
      }

      const bridge = bridgeBySource.get(candidate.event.eventId);
      const nextEvent = bridge?.destination ?? candidate.event;
      const nextWallet = bridge?.destination.to ?? candidate.event.to;
      const nextChain = nextEvent.chain;
      if (!nextWallet || candidate.verdict.category === 'token_deployment') continue;
      const nextKey = walletKey(nextChain, nextWallet);
      if (state.seen.has(nextKey)) continue;
      queue.push({
        wallet: nextWallet,
        chain: nextChain,
        hops: bridge
          ? [...hops, { event: bridge.destination, verdict: { ...candidate.verdict, category: bridge.status === 'verified' ? 'bridge_verified' : 'bridge_unverified', score: bridge.confidence } }]
          : hops,
        bridges: bridge ? [...state.bridges, bridge] : [...state.bridges],
        seen: new Set([...state.seen, nextKey])
      });
    }
  }
  return traces.sort((a, b) => a.traceId.localeCompare(b.traceId));
}
