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
// packages/providers/src/solana/{helius,risk}.ts). When HELIUS_API_KEY is
// absent, SOLANA walletActivity/risk fall back to the shared MockProvider
// (graceful keyless fallback, binding decision 5) while getProviderStatuses()
// still honestly reports 'missing_key' for those rows — the boot/worker
// cycle never crashes just because a key wasn't configured.
//
// Task 29 (Wave 4, BSC scaffold): MOCK_MODE="false" now also resolves real
// adapters for BSC: walletActivity via BscScan (Etherscan API V2, chainid=56
// — createBscScanActivityProvider, key-gated on BSCSCAN_API_KEY, same
// graceful-keyless-mock-fallback contract as Helius) and risk via GoPlus
// (createGoPlusRiskProvider — keyless-live, GOPLUS_API_KEY only raises rate
// limits, never gates it — see bsc/goplus.ts's file header for the
// live-verified proof). Birdeye/Moralis/Bitquery (bsc/stubs.ts) remain typed
// stubs, never wired into getProvider — only surfaced via
// getProviderStatuses() so the Settings page shows the swap-in point. Every
// other (chain, capability) pair (BSC tokenMetadata/walletDiscovery, SOLANA
// tokenMetadata/walletDiscovery) still has no live adapter, and getProvider
// still throws for those in live mode rather than silently mocking (same
// "fail loudly, use getProviderStatuses() to check first" contract as
// before).

import type { Chain, ProviderStatus } from '@flowradar/core';
import type { MarketDataProvider, ProviderCapability, ProviderCapabilityMap } from './types';
import { createMockWorld } from './mock/world';
import type { MockWorld } from './mock/world';
import { MockProvider } from './mock/provider';
import { createHeliusActivityProvider } from './solana/helius';
import { createHeliusRiskProvider } from './solana/risk';
import { createDexScreenerProvider } from './market/dexscreener';
import { createBscScanActivityProvider } from './bsc/bscscan';
import { createGoPlusRiskProvider } from './bsc/goplus';

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

// ---------------------------------------------------------------------------
// Live-provider cache (Important finding #1, Task 27 review)
//
// createHeliusActivityProvider/createHeliusRiskProvider each build their own
// createRateLimiter({rps:9}) internally (see solana/{helius,risk}.ts) — the
// limiter is a closure variable inside the returned provider object, not
// something registry.ts constructs directly. That means the ONLY way to get
// one limiter shared across every getProvider('SOLANA', <cap>) call is to
// make sure the factory itself is only invoked ONCE per live capability, and
// every subsequent getProvider call reuses that same returned instance.
//
// Mechanism chosen: a module-scope Map<capabilityCacheKey, LiveProvider>,
// populated the first time a live (key-present) provider is successfully
// constructed for a capability, and reused after that. This is the minimal
// fix — it doesn't require touching helius.ts/risk.ts's internals or
// threading a limiter through an extra layer of indirection; it just ensures
// registry.ts never calls createHelius*Provider more than once per live
// capability while a cache entry exists.
//
// The mock fallback (HELIUS_API_KEY absent) is deliberately NOT cached as
// "live" — it's cheap (returns the already-shared MockProvider singleton) and
// re-checking env on every call means a key added mid-process (e.g. tests
// flipping env between assertions, or a future hot-reload of config) is
// picked up on the next getProvider call instead of being stuck on a stale
// mock decision from before the key existed.
// ---------------------------------------------------------------------------

type LiveCacheKey =
  | 'solana:walletActivity'
  | 'solana:risk'
  | 'marketData:dexscreener'
  | 'bsc:walletActivity'
  | 'bsc:risk';

// NOTE: this cache is sticky across a HELIUS_API_KEY (or any live key) rotation
// WITHIN a running process — once a live provider is constructed under one key,
// that instance is reused until resetProviderCache() clears it. The boot-once
// worker (one key read at startup, no in-process rotation) makes this moot in
// practice; tests and any future hot-config-reload must call resetProviderCache().
const liveProviderCache = new Map<LiveCacheKey, unknown>();

/**
 * Clears the module-scope live-provider cache. Tests must call this between
 * process.env mutations (e.g. toggling HELIUS_API_KEY or MOCK_MODE) so a
 * provider instance built under a previous env doesn't leak into a
 * subsequent assertion under a different env.
 */
export function resetProviderCache(): void {
  liveProviderCache.clear();
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
 *
 * Review fix (Important #1): the constructed LIVE provider instance is
 * cached at module scope (liveProviderCache) so repeated getProvider calls —
 * e.g. once per wallet per poll tick — reuse the SAME provider object (and
 * therefore its single internal rate limiter) instead of constructing a
 * fresh limiter every call. The mock fallback is never cached here (it's
 * already the shared MockProvider singleton via getSharedMockProvider).
 */
function getSolanaHeliusOrMockFallback<C extends ProviderCapability>(capability: C): ProviderCapabilityMap[C] | null {
  // HELIUS_RPS throttles the wallet-activity Enhanced-Tx adapter only.
  // HELIUS_RISK_RPS (2026-07-11 rollout: this key sustains well under the risk
  // provider's 9rps default — sustained 429s) throttles the risk-RPC adapter;
  // see solana/risk.ts resolveRiskRps (clamped 1..9, default 9).
  const env = {
    HELIUS_API_KEY: process.env.HELIUS_API_KEY,
    HELIUS_RPS: process.env.HELIUS_RPS,
    HELIUS_RISK_RPS: process.env.HELIUS_RISK_RPS
  };

  if (capability === 'walletActivity') {
    const cacheKey: LiveCacheKey = 'solana:walletActivity';
    const cached = liveProviderCache.get(cacheKey);
    if (cached) return cached as ProviderCapabilityMap[C];

    const live = createHeliusActivityProvider(env);
    if (live) {
      liveProviderCache.set(cacheKey, live);
      return live as unknown as ProviderCapabilityMap[C];
    }
    return getSharedMockProvider() as unknown as ProviderCapabilityMap[C];
  }

  if (capability === 'risk') {
    const cacheKey: LiveCacheKey = 'solana:risk';
    const cached = liveProviderCache.get(cacheKey);
    if (cached) return cached as ProviderCapabilityMap[C];

    const live = createHeliusRiskProvider(env);
    if (live) {
      liveProviderCache.set(cacheKey, live);
      return live as unknown as ProviderCapabilityMap[C];
    }
    return getSharedMockProvider() as unknown as ProviderCapabilityMap[C];
  }

  return null;
}

/**
 * BSC walletActivity/risk in live mode (Task 29): mirrors
 * getSolanaHeliusOrMockFallback's shape exactly, but the two capabilities
 * have different keyless-ness:
 *  - walletActivity (BscScan/Etherscan-V2) IS key-gated
 *    (createBscScanActivityProvider returns null without BSCSCAN_API_KEY) —
 *    same "graceful keyless fallback to the shared MockProvider" contract as
 *    Solana's Helius adapters.
 *  - risk (GoPlus) is NOT key-gated — createGoPlusRiskProvider always
 *    returns a working provider (GOPLUS_API_KEY only raises rate limits; see
 *    bsc/goplus.ts's file header for the live-verified keyless-tier proof),
 *    so it is cached and returned directly, with no null-check/mock-fallback
 *    branch needed.
 */
function getBscLiveOrMockFallback<C extends ProviderCapability>(capability: C): ProviderCapabilityMap[C] | null {
  if (capability === 'walletActivity') {
    const cacheKey: LiveCacheKey = 'bsc:walletActivity';
    const cached = liveProviderCache.get(cacheKey);
    if (cached) return cached as ProviderCapabilityMap[C];

    const live = createBscScanActivityProvider({ BSCSCAN_API_KEY: process.env.BSCSCAN_API_KEY });
    if (live) {
      liveProviderCache.set(cacheKey, live);
      return live as unknown as ProviderCapabilityMap[C];
    }
    return getSharedMockProvider() as unknown as ProviderCapabilityMap[C];
  }

  if (capability === 'risk') {
    const cacheKey: LiveCacheKey = 'bsc:risk';
    const cached = liveProviderCache.get(cacheKey);
    if (cached) return cached as ProviderCapabilityMap[C];

    const live = createGoPlusRiskProvider({ GOPLUS_API_KEY: process.env.GOPLUS_API_KEY });
    liveProviderCache.set(cacheKey, live);
    return live as unknown as ProviderCapabilityMap[C];
  }

  return null;
}

/**
 * DexScreener (Task 28): the ONLY capability adapter in this registry that is
 * unconditionally live in non-mock mode, on BOTH chains — no API key gates it
 * (see market/dexscreener.ts's file header). Cached at module scope like the
 * Helius live providers, so every getProvider('marketData') call across both
 * chains shares one rate limiter instance.
 */
function getDexScreenerMarketProvider(): MarketDataProvider {
  const cacheKey: LiveCacheKey = 'marketData:dexscreener';
  const cached = liveProviderCache.get(cacheKey);
  if (cached) return cached as MarketDataProvider;

  const live = createDexScreenerProvider();
  liveProviderCache.set(cacheKey, live);
  return live;
}

/**
 * Resolves a provider implementation for `capability` on `chain`. In
 * MOCK_MODE (default), every capability resolves to the shared MockProvider,
 * which implements all five capability interfaces against one MockWorld.
 *
 * Live mode (MOCK_MODE="false"):
 *  - `marketData` on EITHER chain always resolves to the live, keyless
 *    DexScreener adapter (Task 28) — no fallback needed since it can't be
 *    missing a key.
 *  - SOLANA's walletActivity/risk resolve to the real Helius adapter when
 *    HELIUS_API_KEY is set, or gracefully fall back to the shared
 *    MockProvider when it's missing (Task 27 — see
 *    getSolanaHeliusOrMockFallback above).
 *  - BSC's walletActivity resolves to the real BscScan adapter when
 *    BSCSCAN_API_KEY is set, or gracefully falls back to the shared
 *    MockProvider when it's missing; BSC's risk always resolves to the real
 *    GoPlus adapter (keyless-live, Task 29 — see getBscLiveOrMockFallback
 *    above).
 * Every other (chain, capability) pair has no live adapter yet and still
 * throws rather than silently mocking, so a misconfigured deployment fails
 * loudly instead of pretending to be live. Use `getProviderStatuses()` to
 * check `mode` before calling `getProvider` in live mode.
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

  if (capability === 'marketData') {
    return getDexScreenerMarketProvider() as unknown as ProviderCapabilityMap[C];
  }

  if (chain === 'SOLANA') {
    const resolved = getSolanaHeliusOrMockFallback(capability);
    if (resolved) return resolved;
  }

  if (chain === 'BSC') {
    const resolved = getBscLiveOrMockFallback(capability);
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

      // Task 28: marketData is keyless-live on BOTH chains (DexScreener) —
      // report 'live' unconditionally, before any env-key lookup, since no
      // env var gates this capability at all (a `missing_key` row here would
      // be actively wrong: there's no key to be missing).
      if (capability === 'marketData') {
        statuses.push({
          name: 'DexScreener',
          chain,
          capability,
          mode: 'live',
          note: 'Live DexScreener adapter active (keyless, ~300 req/min (default, unconfirmed)) — holderCount is not provided by this API and is always null.'
        });
        continue;
      }

      // Task 29: BSC risk (GoPlus) is keyless-live — report 'live'
      // unconditionally, same treatment as marketData/DexScreener above,
      // since GOPLUS_API_KEY only raises rate limits and is never required
      // (see bsc/goplus.ts's file header for the live-verified keyless-tier
      // proof). This must be checked BEFORE the generic keyEnvVar/hasKey
      // logic below, which would otherwise report 'missing_key' whenever
      // GOPLUS_API_KEY is unset.
      if (chain === 'BSC' && capability === 'risk') {
        statuses.push({
          name: 'GoPlus',
          chain,
          capability,
          mode: 'live',
          note: 'Live GoPlus token_security adapter active (keyless; GOPLUS_API_KEY optional, raises rate limits only).'
        });
        continue;
      }

      const keyEnvVar = liveKeyEnvVarFor(chain, capability);
      const hasKey = Boolean(keyEnvVar && process.env[keyEnvVar]);

      // Task 27/29: SOLANA walletActivity/risk (Helius) and BSC
      // walletActivity (BscScan) have a real, key-gated live adapter now —
      // report 'live' when the key is present instead of the generic
      // "not implemented yet" stub note every other (chain, capability) pair
      // still gets.
      const hasLiveAdapter =
        (chain === 'SOLANA' && (capability === 'walletActivity' || capability === 'risk')) ||
        (chain === 'BSC' && capability === 'walletActivity');
      if (hasLiveAdapter) {
        const note =
          chain === 'BSC'
            ? 'Live BscScan adapter active (Etherscan API V2, chainid=56 — txlist + tokentx merged; swap detection is best-effort/deferred, see bscscanMapper.ts).'
            : 'Live Helius adapter active (Enhanced Transactions API + RPC risk checks).';
        statuses.push({
          name: liveAdapterNameFor(chain, capability),
          chain,
          capability,
          mode: hasKey ? 'live' : 'missing_key',
          note: hasKey ? note : `Missing ${keyEnvVar ?? 'required env var'}; falling back to MockProvider (graceful keyless fallback).`
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
