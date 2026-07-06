// FlowRadar — static AddressRegistry seed data aggregator (Task 26).
//
// Combines the per-chain curated lists into one { chain, ...entry }[] the
// seed script upserts. See ./solana.ts's header for the "starting registry,
// not exhaustive" contract every entry in both lists follows.

import type { Chain } from '@flowradar/core';
import { SOLANA_STATIC_REGISTRY } from './solana';
import { BSC_STATIC_REGISTRY } from './bsc';
import type { StaticRegistryEntry } from './solana';

export type { StaticRegistryEntry } from './solana';

export interface ChainStaticRegistryEntry extends StaticRegistryEntry {
  chain: Chain;
}

/** Every curated static registry entry across all chains, tagged with its chain. */
export const STATIC_REGISTRY_ENTRIES: ChainStaticRegistryEntry[] = [
  ...SOLANA_STATIC_REGISTRY.map((e: StaticRegistryEntry) => ({ ...e, chain: 'SOLANA' as const })),
  ...BSC_STATIC_REGISTRY.map((e: StaticRegistryEntry) => ({ ...e, chain: 'BSC' as const }))
];

export { SOLANA_STATIC_REGISTRY, BSC_STATIC_REGISTRY };
