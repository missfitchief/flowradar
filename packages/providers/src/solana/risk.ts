// FlowRadar — Solana token risk checks via Helius's standard JSON-RPC proxy
// (Task 27). Implements RiskProvider.getTokenRisk by calling three RPC
// methods against `https://mainnet.helius-rpc.com/?api-key=...`:
//
//   - getTokenLargestAccounts + getTokenSupply -> top-1/top-5 holder
//     concentration flags. DOC-VERIFIED: both methods' full request/response
//     JSON shapes were confirmed verbatim against
//     https://www.helius.dev/docs/api-reference/rpc/http/gettokenlargestaccounts
//     ("Returns the 20 largest accounts", fields address/amount/decimals/
//     uiAmount/uiAmountString) and
//     https://www.helius.dev/docs/api-reference/rpc/http/gettokensupply
//     (fields amount/decimals/uiAmount/uiAmountString) — see this task's
//     report for the exact fetched example JSON.
//
//   - getAccountInfo(mint, jsonParsed) -> mintAuthority/freezeAuthority flags.
//     TODO(provider): STUB, not implemented against a real parse. Every doc
//     page checked this session —
//     https://www.helius.dev/docs/api-reference/rpc/http/getaccountinfo ,
//     https://solana.com/docs/rpc/http/getaccountinfo ,
//     https://www.solana-program.com/docs/token — describes the jsonParsed
//     `{program, parsed, space}` envelope in prose but none publishes a full
//     verbatim example response for an SPL Token MINT account showing the
//     exact `result.value.data.parsed.info.{mintAuthority,freezeAuthority}`
//     path and its null-when-revoked behavior. Per the binding "docs first,
//     no hallucinated endpoints" rule, this surface stays a typed stub
//     (mintAuthorityCheck.mode === 'stub') rather than guessing the shape.
//     A future task should re-verify against a live response sample (e.g. via
//     `helius doctor`/a manual curl against a known mint) before wiring this
//     up for real.
//
// penalty = capped sum: mint_authority_active 0.25 + freeze_authority_active
// 0.25 (both currently unreachable while the mint-authority check is stubbed
// — see getMintAuthorityFlags below) + top_holder_concentration (top1>=30%)
// 0.3 + elevated top-5 concentration (top5>=60%) 0.15, cap 1 (Task 27 binding
// decision 4).

import type { RiskReport } from '@flowradar/core';
import type { Chain } from '@flowradar/core';
import type { RiskProvider } from '../types';
import { createRateLimiter } from '../rateLimiter';
import type { RateLimiter } from '../rateLimiter';

export interface HeliusRiskEnv {
  HELIUS_API_KEY?: string;
}

const HELIUS_RPC_BASE = 'https://mainnet.helius-rpc.com';
const HELIUS_RPS = 9;

const TOP1_DANGER_THRESHOLD = 0.3; // >=30% top-1 holder -> danger
const TOP5_WARN_THRESHOLD = 0.6; // >=60% top-5 holders -> warn

const PENALTY_MINT_AUTHORITY = 0.25;
const PENALTY_FREEZE_AUTHORITY = 0.25;
const PENALTY_TOP1_CONCENTRATION = 0.3;
const PENALTY_TOP5_CONCENTRATION = 0.15;
const PENALTY_CAP = 1;

// ---------------------------------------------------------------------------
// RPC response shapes (doc-verified — see file header)
// ---------------------------------------------------------------------------

interface RpcTokenAccountEntry {
  address: string;
  amount: string;
  decimals: number;
  uiAmount: number | null;
  uiAmountString: string;
}

interface RpcTokenLargestAccountsResult {
  context: { slot: number };
  value: RpcTokenAccountEntry[];
}

interface RpcTokenSupplyResult {
  context: { slot: number };
  value: { amount: string; decimals: number; uiAmount: number | null; uiAmountString: string };
}

interface JsonRpcResponse<T> {
  jsonrpc: '2.0';
  id: string | number;
  result?: T;
  error?: { code: number; message: string };
}

// ---------------------------------------------------------------------------
// mint authority stub (see file header TODO)
// ---------------------------------------------------------------------------

export interface MintAuthorityFlags {
  mode: 'stub';
  mintAuthorityActive: null;
  freezeAuthorityActive: null;
}

/**
 * TODO(provider): stub — see file header. Docs URL:
 * https://www.helius.dev/docs/api-reference/rpc/http/getaccountinfo (jsonParsed
 * mint response shape unverifiable this session). Always returns
 * `{ mode: 'stub', mintAuthorityActive: null, freezeAuthorityActive: null }`
 * without making any network call.
 */
export function getMintAuthorityFlags(_mint: string): MintAuthorityFlags {
  return { mode: 'stub', mintAuthorityActive: null, freezeAuthorityActive: null };
}

// ---------------------------------------------------------------------------
// Holder concentration (doc-verified, real implementation)
// ---------------------------------------------------------------------------

export interface HolderConcentration {
  top1Share: number; // 0..1
  top5Share: number; // 0..1
}

/** Pure: derives top-1/top-5 holder share from doc-verified getTokenLargestAccounts + getTokenSupply results. */
export function computeHolderConcentration(
  largestAccounts: RpcTokenLargestAccountsResult,
  supply: RpcTokenSupplyResult
): HolderConcentration {
  const totalSupply = Number(supply.value.amount);
  if (!(totalSupply > 0)) {
    return { top1Share: 0, top5Share: 0 };
  }
  const sorted = [...largestAccounts.value].sort((a, b) => Number(b.amount) - Number(a.amount));
  const top1 = Number(sorted[0]?.amount ?? 0);
  const top5 = sorted.slice(0, 5).reduce((sum, acc) => sum + Number(acc.amount), 0);
  return { top1Share: top1 / totalSupply, top5Share: top5 / totalSupply };
}

/** Pure: builds the RiskReport flags+penalty from holder concentration + (stubbed) mint authority flags. */
export function buildRiskReport(concentration: HolderConcentration, mintAuthority: MintAuthorityFlags): RiskReport {
  const flags: RiskReport['flags'] = [];
  let penalty = 0;

  if (mintAuthority.mintAuthorityActive === true) {
    flags.push({ id: 'mint_authority_active', label: 'Mint authority is still active', severity: 'danger' });
    penalty += PENALTY_MINT_AUTHORITY;
  }
  if (mintAuthority.freezeAuthorityActive === true) {
    flags.push({ id: 'freeze_authority_active', label: 'Freeze authority is still active', severity: 'danger' });
    penalty += PENALTY_FREEZE_AUTHORITY;
  }

  if (concentration.top1Share >= TOP1_DANGER_THRESHOLD) {
    flags.push({
      id: 'top_holder_concentration',
      label: `Top holder controls ${(concentration.top1Share * 100).toFixed(1)}% of supply`,
      severity: 'danger'
    });
    penalty += PENALTY_TOP1_CONCENTRATION;
  }
  if (concentration.top5Share >= TOP5_WARN_THRESHOLD) {
    flags.push({
      id: 'top5_holder_concentration',
      label: `Top 5 holders control ${(concentration.top5Share * 100).toFixed(1)}% of supply`,
      severity: 'warn'
    });
    penalty += PENALTY_TOP5_CONCENTRATION;
  }

  return { flags, penalty: Math.min(PENALTY_CAP, penalty) };
}

// ---------------------------------------------------------------------------
// RPC error typing + "holder data unavailable" degrade (F9)
// ---------------------------------------------------------------------------

const RPC_INVALID_REQUEST = -32600;

/**
 * A Helius JSON-RPC `error` response (the `json.error` branch of callRpc),
 * carrying the raw RPC `code` + `message` so callers can classify specific
 * conditions (e.g. -32600 "too many accounts") WITHOUT string-parsing the
 * formatted Error.message. The message format is unchanged from the prior
 * plain-Error throw, so existing message/key-redaction expectations still hold.
 */
export class HeliusRpcError extends Error {
  readonly code: number;
  readonly rpcMessage: string;
  readonly method: string;
  constructor(method: string, code: number, rpcMessage: string) {
    super(`Helius RPC ${method} returned an error: ${code} ${rpcMessage}`);
    this.name = 'HeliusRpcError';
    this.code = code;
    this.rpcMessage = rpcMessage;
    this.method = method;
  }
}

/**
 * True for the specific "this mint has too many holder accounts to sample"
 * failure getTokenLargestAccounts returns for mega-holder mints (stablecoins
 * like USDC/USDT, wSOL, other major tokens): JSON-RPC code -32600 with a
 * "too many accounts" message (e.g. "Too many accounts requested (5000000
 * pubkeys), try adding filters to narrow down results"). This is a KNOWN,
 * expected condition for high-holder tokens — not a provider outage — so
 * getTokenRisk treats it as "holder data unavailable" and degrades instead of
 * failing the token's whole score on every scoring cycle. Deliberately narrow:
 * it must be the getTokenLargestAccounts call (the only method that produces
 * this holder-sampling limit), a different -32600 message, a different code, or
 * a non-HeliusRpcError all return false so genuine failures still propagate.
 */
export function isTokenAccountsUnavailableError(err: unknown): boolean {
  return (
    err instanceof HeliusRpcError &&
    err.method === 'getTokenLargestAccounts' &&
    err.code === RPC_INVALID_REQUEST &&
    /too many accounts/i.test(err.rpcMessage)
  );
}

/**
 * RiskReport for a mint whose holder concentration can't be sampled (see
 * isTokenAccountsUnavailableError). Surfaces an explicit `holder_data_unavailable`
 * warn flag so the token reads as UNKNOWN, never clean/safe — while keeping
 * `penalty: 0` so the flow-score formula (which reads ONLY risk.penalty, not
 * flags — see @flowradar/core computeFlowScore) stays completely unchanged.
 * penalty 0 is also the correct default here: a mint with millions of holders
 * is the OPPOSITE of top-holder-concentrated, so it warrants no concentration
 * penalty — we simply couldn't measure it precisely, and must not fabricate a
 * penalty (falsely dangerous) OR an empty report (falsely clean) either way.
 */
export function buildUnavailableRiskReport(): RiskReport {
  return {
    flags: [
      {
        id: 'holder_data_unavailable',
        label: 'Holder concentration data unavailable (mint has too many accounts to sample)',
        severity: 'warn'
      }
    ],
    penalty: 0
  };
}

// ---------------------------------------------------------------------------
// Live provider construction
// ---------------------------------------------------------------------------

async function callRpc<T>(apiKey: string, limiter: RateLimiter, method: string, params: unknown[]): Promise<T> {
  await limiter.acquire();
  const url = `${HELIUS_RPC_BASE}/?api-key=${apiKey}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: '1', method, params })
  });

  if (!response.ok) {
    const bodyText = await response.text().catch(() => '<no response body>');
    // Never interpolate the raw url/apiKey into the thrown message — redact.
    throw new Error(`Helius RPC ${method} failed (${response.status} ${response.statusText}): ${bodyText}`);
  }

  const json = (await response.json()) as JsonRpcResponse<T>;
  if (json.error) {
    throw new HeliusRpcError(method, json.error.code, json.error.message);
  }
  if (json.result === undefined) {
    throw new Error(`Helius RPC ${method} returned no result field`);
  }
  return json.result;
}

/**
 * Constructs a Solana RiskProvider backed by Helius's JSON-RPC proxy, or
 * returns `null` when HELIUS_API_KEY is absent (registry.ts's missing_key /
 * mock-fallback path — Task 27 binding decision 5). Rate-limited to ~9rps via
 * createRateLimiter (shared per-provider-instance limiter across calls).
 */
export function createHeliusRiskProvider(env: HeliusRiskEnv): RiskProvider | null {
  const apiKey = env.HELIUS_API_KEY;
  if (!apiKey) return null;

  const limiter = createRateLimiter({ rps: HELIUS_RPS });

  return {
    providerName: 'Helius',
    async getTokenRisk(_chain: Chain, address: string): Promise<RiskReport> {
      try {
        const [largestAccounts, supply] = await Promise.all([
          callRpc<RpcTokenLargestAccountsResult>(apiKey, limiter, 'getTokenLargestAccounts', [address]),
          callRpc<RpcTokenSupplyResult>(apiKey, limiter, 'getTokenSupply', [address])
        ]);
        const concentration = computeHolderConcentration(largestAccounts, supply);
        const mintAuthority = getMintAuthorityFlags(address);
        return buildRiskReport(concentration, mintAuthority);
      } catch (err) {
        // Mega-holder mints (stablecoins/wSOL/major tokens) can't have their
        // holder concentration sampled — getTokenLargestAccounts returns
        // -32600 "too many accounts". Degrade to an explicit "unavailable"
        // report instead of throwing, which would fail this token's score on
        // EVERY cycle and spam the log. Any OTHER error (rate limit, network,
        // other RPC codes) still propagates unchanged.
        if (isTokenAccountsUnavailableError(err)) {
          return buildUnavailableRiskReport();
        }
        throw err;
      }
    }
  };
}
