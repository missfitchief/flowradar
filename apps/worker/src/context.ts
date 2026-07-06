// FlowRadar — shared JobContext type every job's `run(ctx)` receives.
//
// Normative source: Task 5 brief decision 3 ("each exports run(ctx) where
// ctx = {prisma, settings, providers, log}"). `providers` is the resolver
// function itself (getProvider) rather than pre-resolved instances, so a job
// can ask for a capability on whichever chain it's currently processing
// (SOLANA vs BSC) without the bootstrap needing to enumerate every
// chain x capability pair up front.

import type { PrismaClient } from '@flowradar/db';
import type { Settings, Chain } from '@flowradar/core';
import type { ProviderCapability, ProviderCapabilityMap } from '@flowradar/providers';
import { getProvider } from '@flowradar/providers';

export type ProviderResolver = <C extends ProviderCapability>(
  chain: Chain,
  capability: C
) => ProviderCapabilityMap[C];

export interface JobLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface JobContext {
  prisma: PrismaClient;
  settings: Settings;
  providers: ProviderResolver;
  log: JobLogger;
}

/** Default JobContext.providers resolver — thin wrapper around @flowradar/providers's getProvider. */
export const defaultProviderResolver: ProviderResolver = getProvider;

export function createConsoleLogger(prefix: string): JobLogger {
  return {
    info(message: string, meta?: Record<string, unknown>) {
      const suffix = meta ? ` ${JSON.stringify(meta)}` : '';
      // eslint-disable-next-line no-console
      console.log(`[${prefix}] ${message}${suffix}`);
    },
    error(message: string, meta?: Record<string, unknown>) {
      const suffix = meta ? ` ${JSON.stringify(meta)}` : '';
      // eslint-disable-next-line no-console
      console.error(`[${prefix}] ${message}${suffix}`);
    }
  };
}
