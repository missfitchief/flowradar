// FlowRadar — provider registry: `getProvider(chain, capability)` resolves a
// concrete provider implementation per (chain, capability) from env, and
// `getProviderStatuses()` reports what's actually wired up (Spec §5, plan
// Shared Contracts `ProviderStatus`).
//
// MOCK_MODE (env, default true — see .env.example) is the single switch:
// MOCK_MODE !== 'false' => every capability resolves to MockProvider, backed
// by one shared, lazily-built MockWorld (default seed 20260705, genesis =
// process start time) so every capability sees a mutually consistent world.
// Live adapters (Helius/DexScreener/BscScan/GoPlus/...) arrive in Wave 4;
// until then MOCK_MODE="false" reports honest 'missing_key'/'stub' statuses
// rather than crashing or silently mocking (Spec §5: "Missing keys => stub/
// mock with documented TODO; never a crash").
//
// Task 27 (Wave 4, Solana): MOCK_MODE="false" + HELIUS_API_KEY present now
// resolves real Helius adapters for SOLANA's walletActivity/risk
// capabilities (createHeliusActivityProvider/createHeliusRiskProvider —
// packages/providers/src/solana/{helius,risk}.ts). Every other
// (chain, capability) pair (BSC's everything, SOLANA's marketData/
// tokenMetadata/walletDiscovery) has no live adapter yet, and getProvider
// still throws for those in live mode rather than silently mocking (same
// "fail loudly, use getProviderStatuses() to check first" contract as
// before). When HELIUS_API_KEY is absent, SOLANA walletActivity/risk fall
// back to the shared MockProvider (graceful keyless fallback, binding
// decision 5) while getProviderStatuses() still honestly reports
// 'missing_key' for those rows — the boot/worker cycle never crashes just
// because a key wasn't configured.

import type { Chain, ProviderStatus } from '@flowradar/core';
import type { ProviderCapability, ProviderCapabilityMap } from './types';
import { createMockWorld } from './mock/world';
import type { MockWorld } from './mock/world';
import { MockProvider } from './mock/provider';
import { createHeliusActivityProvider } from './solana/helius';
import { createHeliusRiskProvider } from './solana/risk';

const ALL_CAPABILITIES: ProviderCapability[] = [
  'walletActivity',
  'marketData',
  'tokenMetadata',
  'risk',
  'walletDiscovery'
];
const ALL_CHAINS: Chain[] = ['SOLANA', 'BSC'];

/**
 * Live-adapter env var each capability depends on, per Spec §5 (used only for
 * status reporting — no live calls yet), for SOLANA (the default chain this
 * map covers directly). BSC uses different env vars for walletActivity/
 * tokenMetadata (BSCSCAN_API_KEY) and risk (GOPLUS_API_KEY) — see
 * liveKeyEnvVarFor's BSC-specific overrides below. Task 27 fix: `risk` used
 * to default to GOPLUS_API_KEY here (correct for BSC, wrong for SOLANA —
 * risk.ts's real Helius adapter reads HELIUS_API_KEY), which made
 * getProviderStatuses report the wrong missing env var for SOLANA/risk;
 * fixed by making HELIUS_API_KEY the default (matches SOLANA, since every
 * other capability in this map is also HELIUS_API_KEY-keyed for SOLANA) and
 * moving GOPLUS_API_KEY into the BSC-only override in liveKeyEnvVarFor.
 */
const LIVE_KEY_ENV_BY_CAPABILITY: Record<ProviderCapability, string> = {
  walletActivity: 'HELIUS_API_KEY', // + BSCSCAN_API_KEY for BSC — see per-chain note in getProviderStatuses
  marketData: 'BIRDEYE_API_KEY', // DexScreener is keyless-primary; Birdeye is the optional key-gated adapter
  tokenMetadata: 'HELIUS_API_KEY',
  risk: 'HELIUS_API_KEY', // SOLANA risk derives from Helius RPC; BSC risk from GoPlus (see liveKeyEnvVarFor override)
  walletDiscovery: 'HELIUS_API_KEY'
};

function isMockMode(): boolean {
  return process.env.MOCK_MODE !== 'false';
}

// Lazily constructed, process-wide shared mock world so every capability
// resolved via getProvider() during a run sees the same wallets/tokens/txs.
// genesis is fixed at first access (module-load time would run before tests
// can set env/mock the clock; lazy access keeps this predictable and cheap
// when providers are never touched, e.g. pure typecheck-only imports).
let sharedMockWorld: MockWorld | null = null;
let sharedMockProvider: MockProvider | null = null;

function getSharedMockWorld(): MockWorld {
  if (!sharedMockWorld) {
    // genesis = 72h before "now" so the world's scripted future (up to
    // genesis+72h) brackets the current moment — matches Spec §5's
    // "MockProvider ... genesis = seed-time - 72h, advancing with real time"
    // description for the shared runtime instance (test-owned MockWorld
    // instances construct their own explicit genesis and bypass this path
    // entirely by calling createMockWorld directly, as world.test.ts /
    // provider.test.ts do).
    const genesis = new Date(Date.now() - 72 * 60 * 60 * 1000);
    sharedMockWorld = createMockWorld({ genesis });
  }
  return sharedMockWorld;
}

function getSharedMockProvider(): MockProvider {
  if (!sharedMockProvider) {
    sharedMockProvider = new MockProvider(getSharedMockWorld());
  }
  return sharedMockProvider;
}

/**
 * Solana walletActivity/risk in live mode (Task 27): tries the real Helius
 * adapter first; when HELIUS_API_KEY is absent, createHelius*Provider
 * returns null and this falls back to the shared MockProvider rather than
 * throwing (Task 27 binding decision 5's "graceful keyless fallback" — a
 * misconfigured/keyless live deployment still boots and cycles, it just
 * serves mock data for these two capabilities until a key is set).
 * getProviderStatuses() independently reports 'missing_key' for this case so
 * the gap is still visible in ops/Settings, even though getProvider() itself
 * doesn't throw.
 */
function getSolanaHeliusOrMockFallback<C extends ProviderCapability>(capability: C): ProviderCapabilityMap[C] | null {
  const env = { HELIUS_API_KEY: process.env.HELIUS_API_KEY };
  if (capability === 'walletActivity') {
    const live = createHeliusActivityProvider(env);
    if (live) return live as unknown as ProviderCapabilityMap[C];
    return getSharedMockProvider() as unknown as ProviderCapabilityMap[C];
  }
  if (capability === 'risk') {
    const live = createHeliusRiskProvider(env);
    if (live) return live as unknown as ProviderCapabilityMap[C];
    return getSharedMockProvider() as unknown as ProviderCapabilityMap[C];
  }
  return null;
}

/**
 * Resolves a provider implementation for `capability` on `chain`. In
 * MOCK_MODE (default), every capability resolves to the shared MockProvider,
 * which implements all five capability interfaces against one MockWorld.
 *
 * Live mode (MOCK_MODE="false"): SOLANA's walletActivity/risk resolve to the
 * real Helius adapter when HELIUS_API_KEY is set, or gracefully fall back to
 * the shared MockProvider when it's missing (Task 27 — see
 * getSolanaHeliusOrMockFallback above). Every other (chain, capability) pair
 * has no live adapter yet and still throws rather than silently mocking, so
 * a misconfigured deployment fails loudly instead of pretending to be live.
 * Use `getProviderStatuses()` to check `mode` before calling `getProvider` in
 * live mode.
 */
export function getProvider<C extends ProviderCapability>(
  chain: Chain,
  capability: C
): ProviderCapabilityMap[C] {
  if (isMockMode()) {
    // MockProvider implements every ProviderCapabilityMap interface; the cast
    // narrows the shared instance to the specific capability the caller asked
    // for (identical object, capability-shaped view).
    return getSharedMockProvider() as unknown as ProviderCapabilityMap[C];
  }

  if (chain === 'SOLANA') {
    const resolved = getSolanaHeliusOrMockFallback(capability);
    if (resolved) return resolved;
  }

  throw new Error(
    `getProvider: live adapter for capability "${capability}" on chain "${chain}" is not implemented yet (Wave 4). ` +
      `Set MOCK_MODE=true (or unset it) to use the deterministic mock world.`
  );
}

/**
 * Reports the effective provider mode for every (capability, chain) pair —
 * used by the Settings page's "provider key status" panel (Spec §8.7) and by
 * ops/debugging. Never echoes secret values, only whether a required env key
 * is present.
 */
export function getProviderStatuses(): ProviderStatus[] {
  const mockMode = isMockMode();
  const statuses: ProviderStatus[] = [];

  for (const chain of ALL_CHAINS) {
    for (const capability of ALL_CAPABILITIES) {
      if (mockMode) {
        statuses.push({
          name: 'MockProvider',
          chain,
          capability,
          mode: 'mock',
          note: 'MOCK_MODE active — serving deterministic mock world'
        });
        continue;
      }

      const keyEnvVar = liveKeyEnvVarFor(chain, capability);
      const hasKey = Boolean(keyEnvVar && process.env[keyEnvVar]);

      // Task 27: SOLANA walletActivity/risk have a real Helius adapter now —
      // report 'live' when the key is present instead of the generic
      // "not implemented yet" stub note every other (chain, capability) pair
      // still gets.
      const hasLiveAdapter = chain === 'SOLANA' && (capability === 'walletActivity' || capability === 'risk');
      if (hasLiveAdapter) {
        statuses.push({
          name: liveAdapterNameFor(chain, capability),
          chain,
          capability,
          mode: hasKey ? 'live' : 'missing_key',
          note: hasKey
            ? 'Live Helius adapter active (Enhanced Transactions API + RPC risk checks).'
            : `Missing ${keyEnvVar ?? 'required env var'}; falling back to MockProvider (graceful keyless fallback).`
        });
        continue;
      }

      statuses.push({
        name: liveAdapterNameFor(chain, capability),
        chain,
        capability,
        mode: hasKey ? 'stub' : 'missing_key',
        note: hasKey
          ? 'Live adapter not implemented yet (Wave 4) — falling back to stub.'
          : `Missing ${keyEnvVar ?? 'required env var'}; live adapter not implemented yet (Wave 4).`
      });
    }
  }

  return statuses;
}

function liveKeyEnvVarFor(chain: Chain, capability: ProviderCapability): string {
  if (chain === 'BSC' && (capability === 'walletActivity' || capability === 'tokenMetadata')) {
    return 'BSCSCAN_API_KEY';
  }
  if (chain === 'BSC' && capability === 'risk') {
    return 'GOPLUS_API_KEY';
  }
  return LIVE_KEY_ENV_BY_CAPABILITY[capability];
}

function liveAdapterNameFor(chain: Chain, capability: ProviderCapability): string {
  if (capability === 'marketData') return 'DexScreener';
  if (chain === 'BSC') {
    if (capability === 'risk') return 'GoPlus';
    return 'BscScan';
  }
  return 'Helius';
}
