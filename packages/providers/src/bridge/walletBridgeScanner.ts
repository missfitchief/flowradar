import type { Chain, MassTransactionEvent } from '@flowradar/core';
import { fetchWormholeOperations, mapWormholeOperation } from './wormholeScan';

export interface WalletBridgeRef { chain: Chain; address: string }
export interface WalletBridgeScanResult {
  events: MassTransactionEvent[];
  provider: string;
  pagesFetched: number;
  complete: boolean;
  warnings: string[];
}
export interface WalletBridgeScanProvider {
  scanWallets(refs: readonly WalletBridgeRef[], options?: { maxPages?: number; observedAt?: Date }): Promise<WalletBridgeScanResult>;
}

/** Official-message-only Wormhole wallet scan. Both legs are returned when
 * either the decoded sender or recipient belongs to the investigation set. */
export function createWormholeWalletBridgeScanner(): WalletBridgeScanProvider {
  return {
    async scanWallets(refs, options = {}) {
      const maxPages = Math.max(1, Math.min(Math.trunc(options.maxPages ?? 3), 20));
      const observedAt = options.observedAt ?? new Date();
      const wanted = new Set(refs.filter((ref) => ref.chain === 'SOLANA' || ref.chain === 'BSC').map((ref) => `${ref.chain}:${canonical(ref.chain, ref.address)}`));
      const events = new Map<string, MassTransactionEvent>();
      const warnings: string[] = [];
      let pagesFetched = 0;
      let complete = true;
      for (const [emitterChain, targetChain] of [[1, 4], [4, 1]] as const) {
        let directionComplete = false;
        for (let page = 0; page < maxPages; page += 1) {
          const operations = await fetchWormholeOperations({ emitterChain, targetChain, page, pageSize: 100, signal: AbortSignal.timeout(30_000) });
          pagesFetched += 1;
          if (!operations.length) { directionComplete = true; break; }
          for (const operation of operations) {
            const pair = mapWormholeOperation(operation, observedAt);
            if (pair.length !== 2) continue;
            const bridge = pair[0].bridge;
            if (!bridge?.protocolCompleted || bridge.verifiedBy !== 'protocol_message' || !bridge.officialMessageId) continue;
            const senderKey = `${bridge.sourceChain}:${canonical(bridge.sourceChain, bridge.sender ?? '')}`;
            const recipientKey = `${bridge.destinationChain}:${canonical(bridge.destinationChain, bridge.recipient ?? '')}`;
            if (!wanted.has(senderKey) && !wanted.has(recipientKey)) continue;
            for (const event of pair) events.set(event.eventId, event);
          }
        }
        if (!directionComplete) { complete = false; warnings.push(`Wormhole ${emitterChain}->${targetChain} history bounded at ${maxPages} pages`); }
      }
      return { events: [...events.values()].sort((a, b) => a.ts.getTime() - b.ts.getTime() || a.eventId.localeCompare(b.eventId)), provider: 'WormholeScan', pagesFetched, complete, warnings };
    }
  };
}

function canonical(chain: Chain, value: string) { return chain === 'BSC' ? value.trim().toLowerCase() : value.trim(); }
