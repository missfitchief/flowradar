// FlowRadar — external-confluence provider interfaces (External Confluence
// subsystem; design doc §Architecture / §"Provider status taxonomy").
// Mirrors social/types.ts's SocialSourceProvider but for SHADOW-ONLY evidence:
// a ConfluenceProvider READS holder/liquidity/external-intel for a KNOWN token
// and hands back a ConfluenceFetchResult; it NEVER trades, NEVER creates Token
// rows, and NEVER asserts a "safe"/"clean" verdict. The externalConfluence job
// (packages/db + apps/worker, Task D) turns these into TokenConfluenceSnapshot
// rows. Solana-only this build (chains=['SOLANA']); schema stays chain-aware.
import type { Chain } from '@flowradar/core';

/**
 * One point-in-time fetch result for a token. `status` is the honest outcome:
 * 'ok' (data present, provider-claimed) | 'unavailable'/'unknown' (could not
 * get data) | 'missing_key'/'plan_required' (operator must configure) | 'stub'
 * (no confirmed integration) | 'rate_limited' | 'error'. `dataJson` is
 * display-safe ONLY — it must contain NO secret values (design doc §Security).
 */
export interface ConfluenceFetchResult {
  status: 'ok' | 'unavailable' | 'missing_key' | 'plan_required' | 'rate_limited' | 'error' | 'stub';
  dataJson: Record<string, unknown>;
  observedAt: Date;
}

/**
 * A shadow-only evidence reader for one or more chains. `name` should match the
 * ExternalConfluenceSource.name row so Task D's resolver can look providers up
 * by name. `provider`/`snapshotType` map onto the TokenConfluenceSnapshot
 * columns (design doc §Schema plan #2).
 */
export interface ConfluenceProvider {
  name: string;
  provider: string;
  snapshotType: string;
  chains: Chain[];
  fetchForToken(chain: Chain, tokenAddress: string): Promise<ConfluenceFetchResult>;
}

/** Per-source effective mode for the token-detail Confluence panel's source-health row. */
export type ConfluenceSourceMode =
  | 'live'
  | 'mock'
  | 'missing_key'
  | 'plan_required'
  | 'stub'
  | 'unavailable'
  | 'error';

/**
 * Per-source status row. Never echoes a secret VALUE — only the configured env
 * var NAME and whether it is present (design doc §Security; constraint 13).
 */
export interface ConfluenceSourceStatusRow {
  sourceName: string;
  provider: string;
  mode: ConfluenceSourceMode;
  note: string;
  /** The env VAR NAME the operator configured — a NAME only, never a value. null for keyless (ag_paper/internal). */
  apiKeyEnvName: string | null;
}
