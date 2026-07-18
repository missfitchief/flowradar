import { isValidSolanaAddress } from '@flowradar/core';
import type { ChainId, Prisma, PrismaClient } from '@prisma/client';

const CHAINS: ChainId[] = ['SOLANA', 'ETHEREUM', 'BASE', 'ARBITRUM', 'BSC'];
const WEBHOOK_ID_ENV: Record<ChainId, string> = {
  SOLANA: 'ALCHEMY_SOLANA_WEBHOOK_ID', ETHEREUM: 'ALCHEMY_ETHEREUM_WEBHOOK_ID',
  BASE: 'ALCHEMY_BASE_WEBHOOK_ID', ARBITRUM: 'ALCHEMY_ARBITRUM_WEBHOOK_ID',
  BSC: 'ALCHEMY_BSC_WEBHOOK_ID'
};
const NETWORK: Record<ChainId, string> = {
  SOLANA: 'SOLANA_MAINNET', ETHEREUM: 'ETH_MAINNET', BASE: 'BASE_MAINNET',
  ARBITRUM: 'ARB_MAINNET', BSC: 'BNB_MAINNET'
};
const UPDATE_URL = 'https://dashboard.alchemy.com/api/update-webhook-addresses';
const LIST_URL = 'https://dashboard.alchemy.com/api/webhook-addresses';
const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const ADDRESS_UPDATE_BATCH_SIZE = 100;
const SOLANA_ACCOUNT_BATCH_SIZE = 100;

export interface AlchemySubscriptionEnv extends NodeJS.ProcessEnv {
  ALCHEMY_NOTIFY_AUTH_TOKEN?: string;
  ALCHEMY_SOLANA_RPC_URL?: string;
  ALCHEMY_SOLANA_WEBHOOK_ID?: string;
  ALCHEMY_ETHEREUM_WEBHOOK_ID?: string;
  ALCHEMY_BASE_WEBHOOK_ID?: string;
  ALCHEMY_ARBITRUM_WEBHOOK_ID?: string;
  ALCHEMY_BSC_WEBHOOK_ID?: string;
}

export interface AlchemySubscriptionSyncResult {
  chain: ChainId;
  status: 'synced' | 'pending_configuration' | 'failed';
  added: number;
  removed: number;
  duplicates: number;
  failures: number;
  desiredAddressCount: number;
  remoteAddressCount: number | null;
  unchanged: number;
  candidateAddressCount: number;
  uniqueCandidateCount: number;
  sourceDuplicates: number;
  invalidExcluded: number;
  inactiveExcluded: number;
}

export interface MonitoredAlchemyAddressSelection {
  addresses: string[];
  candidateAddressCount: number;
  uniqueCandidateCount: number;
  sourceDuplicates: number;
  invalidExcluded: number;
  inactiveExcluded: number;
}

export function alchemyWebhookId(chain: ChainId, env: AlchemySubscriptionEnv = process.env) {
  return env[WEBHOOK_ID_ENV[chain]]?.trim() || null;
}

/** Best-effort immediate /add or /remove propagation; the worker reconciler is
 * the durable recovery path if Alchemy or the local process is unavailable. */
export async function syncAlchemyCoreWalletChange(
  prisma: PrismaClient,
  refs: ReadonlyArray<{ chain: ChainId; address: string }>,
  action: 'add' | 'remove',
  env: AlchemySubscriptionEnv = process.env
): Promise<AlchemySubscriptionSyncResult[]> {
  const results: AlchemySubscriptionSyncResult[] = [];
  for (const chain of CHAINS) {
    const addresses = unique(refs.filter((ref) => ref.chain === chain).map((ref) => normalize(chain, ref.address)));
    if (!addresses.length) continue;
    const selection = await monitoredAddressSelection(prisma, chain, env);
    const desired = selection.addresses;
    const desiredSet = new Set(desired);
    const webhookId = alchemyWebhookId(chain, env);
    const auth = env.ALCHEMY_NOTIFY_AUTH_TOKEN?.trim();
    if (!webhookId || !auth) {
      await saveState(prisma, chain, webhookId, 'pending_configuration', desired.length, null, null, {
        notifyAuthConfigured: Boolean(auth), webhookIdConfigured: Boolean(webhookId)
      });
      results.push(syncResult(chain, selection, { status: 'pending_configuration', failures: 0 }));
      continue;
    }
    try {
      const remote = await listAddresses(webhookId, auth, chain);
      const remoteSet = new Set(remote.addresses);
      const add = action === 'add' ? addresses.filter((address) => desiredSet.has(address) && !remoteSet.has(address)) : [];
      // /remove only removes an address after the database says that no active
      // monitoring subscription remains for it. History and profile rows are
      // intentionally untouched.
      const remove = action === 'remove' ? addresses.filter((address) => !desiredSet.has(address) && remoteSet.has(address)) : [];
      await applyAddressDiff(webhookId, auth, add, remove);
      const duplicates = remote.duplicates + (action === 'add' ? addresses.length - add.length : 0);
      const remoteCount = remoteSet.size + add.length - remove.length;
      await saveState(prisma, chain, webhookId, 'synced', desired.length, remoteCount, null, {
        lastAction: action, added: add.length, removed: remove.length, duplicates, ...selectionMetadata(selection)
      });
      results.push(syncResult(chain, selection, {
        status: 'synced', added: add.length, removed: remove.length, duplicates, failures: 0,
        remoteAddressCount: remoteCount, unchanged: [...remoteSet].filter((address) => desiredSet.has(address)).length
      }));
    } catch (error) {
      const message = safeError(error);
      await saveState(prisma, chain, webhookId, 'failed', desired.length, null, message, { lastAction: action, changedAddresses: addresses.length });
      results.push(syncResult(chain, selection, { status: 'failed', failures: 1 }));
    }
  }
  return results;
}

/** Reconciles the dedicated FlowRadar webhook to the complete active
 * monitoring universe. Wallet intelligence status is not changed here and is
 * still enforced downstream by Alert Engine v2. */
export async function reconcileAlchemyCoreWebhooks(
  prisma: PrismaClient,
  env: AlchemySubscriptionEnv = process.env
): Promise<AlchemySubscriptionSyncResult[]> {
  const output: AlchemySubscriptionSyncResult[] = [];
  for (const chain of CHAINS) {
    const selection = await monitoredAddressSelection(prisma, chain, env);
    const desired = selection.addresses;
    const webhookId = alchemyWebhookId(chain, env);
    const auth = env.ALCHEMY_NOTIFY_AUTH_TOKEN?.trim();
    if (!webhookId || !auth) {
      await saveState(prisma, chain, webhookId, 'pending_configuration', desired.length, null, null, {
        notifyAuthConfigured: Boolean(auth), webhookIdConfigured: Boolean(webhookId)
      });
      output.push(syncResult(chain, selection, { status: 'pending_configuration', failures: 0 }));
      continue;
    }
    try {
      const remote = await listAddresses(webhookId, auth, chain);
      const remoteSet = new Set(remote.addresses);
      const missing = desired.filter((address) => !remoteSet.has(address));
      const desiredSet = new Set(desired);
      const stale = remote.addresses.filter((address) => !desiredSet.has(address));
      const unchanged = remote.addresses.filter((address) => desiredSet.has(address)).length;
      await applyAddressDiff(webhookId, auth, missing, stale);
      const finalRemote = missing.length || stale.length ? await listAddresses(webhookId, auth, chain) : remote;
      if (!sameAddresses(finalRemote.addresses, desired)) {
        throw new Error(`Alchemy Notify reconciliation verification failed: expected ${desired.length}, received ${finalRemote.addresses.length}`);
      }
      await saveState(prisma, chain, webhookId, 'synced', desired.length, finalRemote.addresses.length, null, {
        addedDuringReconcile: missing.length, removedDuringReconcile: stale.length,
        duplicates: finalRemote.duplicates, unchanged, ...selectionMetadata(selection)
      });
      output.push(syncResult(chain, selection, {
        status: 'synced', added: missing.length, removed: stale.length, duplicates: finalRemote.duplicates,
        failures: 0, remoteAddressCount: finalRemote.addresses.length, unchanged
      }));
    } catch (error) {
      await saveState(prisma, chain, webhookId, 'failed', desired.length, null, safeError(error), { reconciliation: true });
      output.push(syncResult(chain, selection, { status: 'failed', failures: 1 }));
    }
  }
  return output;
}

export async function monitoredAlchemyAddresses(
  prisma: PrismaClient,
  chain: ChainId,
  env: AlchemySubscriptionEnv = process.env
) {
  return (await monitoredAddressSelection(prisma, chain, env)).addresses;
}

export async function monitoredAlchemyAddressSelection(
  prisma: PrismaClient,
  chain: ChainId,
  env: AlchemySubscriptionEnv = process.env
): Promise<MonitoredAlchemyAddressSelection> {
  return monitoredAddressSelection(prisma, chain, env);
}

async function monitoredAddressSelection(
  prisma: PrismaClient,
  chain: ChainId,
  env: AlchemySubscriptionEnv
): Promise<MonitoredAlchemyAddressSelection> {
  const [subscriptions, inactiveExcluded] = await Promise.all([
    prisma.monitoringSubscription.findMany({
      where: { active: true, wallet: { chain } },
      select: { wallet: { select: { address: true } } }
    }),
    prisma.wallet.count({
      where: {
        chain,
        monitoringSubscriptions: { some: { active: false }, none: { active: true } }
      }
    })
  ]);
  const normalized = subscriptions.map((row) => normalize(chain, row.wallet.address)).filter(Boolean);
  const candidates = unique(normalized).sort();
  const locallyValid = candidates.filter((address) => validAddress(chain, address));
  const addresses = chain === 'SOLANA'
    ? await filterSolanaWalletAccounts(locallyValid, env.ALCHEMY_SOLANA_RPC_URL)
    : locallyValid;
  return {
    addresses: addresses.sort(),
    candidateAddressCount: normalized.length,
    uniqueCandidateCount: candidates.length,
    sourceDuplicates: normalized.length - candidates.length,
    invalidExcluded: candidates.length - addresses.length,
    inactiveExcluded
  };
}

async function updateAddresses(webhookId: string, auth: string, add: string[], remove: string[]) {
  const response = await fetch(UPDATE_URL, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'X-Alchemy-Token': auth },
    body: JSON.stringify({ webhook_id: webhookId, addresses_to_add: add, addresses_to_remove: remove }),
    signal: AbortSignal.timeout(20_000)
  });
  const responseBody = await response.text();
  if (!response.ok) {
    throw new Error(`Alchemy Notify address update failed with HTTP ${response.status}: ${safeResponseBody(responseBody)}`);
  }
}

async function applyAddressDiff(webhookId: string, auth: string, add: string[], remove: string[]) {
  // Remove first so a webhook close to its provider limit has room for the
  // canonical replacements. Alchemy accepts 100-address chunks reliably.
  for (const batch of chunks(remove, ADDRESS_UPDATE_BATCH_SIZE)) await updateAddresses(webhookId, auth, [], batch);
  for (const batch of chunks(add, ADDRESS_UPDATE_BATCH_SIZE)) await updateAddresses(webhookId, auth, batch, []);
}

async function listAddresses(webhookId: string, auth: string, chain: ChainId) {
  const addresses: string[] = [];
  let after: string | undefined;
  for (let page = 0; page < 1_000; page++) {
    const url = new URL(LIST_URL);
    url.searchParams.set('webhook_id', webhookId);
    // Notify's address-list endpoint currently rejects 500 with HTTP 400;
    // its documented/default page size is 100. Keep paging via `after`.
    url.searchParams.set('limit', '100');
    if (after) url.searchParams.set('after', after);
    const response = await fetch(url, { headers: { 'X-Alchemy-Token': auth }, signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`Alchemy Notify address list failed with HTTP ${response.status}`);
    const body = await response.json() as { data?: string[]; addresses?: string[]; pagination?: { cursors?: { after?: string | null } } };
    const rows = Array.isArray(body.data) ? body.data : Array.isArray(body.addresses) ? body.addresses : [];
    addresses.push(...rows.filter((address): address is string => typeof address === 'string'));
    const next = body.pagination?.cursors?.after || undefined;
    if (!next || next === after) break;
    after = next;
  }
  const normalized = addresses.map((address) => normalize(chain, address));
  const uniqueAddresses = unique(normalized);
  return { addresses: uniqueAddresses, duplicates: normalized.length - uniqueAddresses.length };
}

async function saveState(prisma: PrismaClient, chain: ChainId, webhookId: string | null, status: string, desired: number, remote: number | null, error: string | null, metadata: Prisma.InputJsonObject) {
  await prisma.alchemyWebhookSubscriptionState.upsert({
    where: { chain },
    create: { chain, webhookId, network: NETWORK[chain], status, desiredAddressCount: desired, remoteAddressCount: remote, lastSyncedAt: status === 'synced' ? new Date() : null, lastError: error, metadataJson: metadata },
    update: { webhookId, network: NETWORK[chain], status, desiredAddressCount: desired, remoteAddressCount: remote, lastSyncedAt: status === 'synced' ? new Date() : undefined, lastError: error, metadataJson: metadata }
  });
}

function normalize(chain: ChainId, address: string) {
  const trimmed = address.trim();
  return chain === 'SOLANA' ? trimmed : trimmed.toLowerCase();
}
function unique(values: string[]) { return [...new Set(values.filter(Boolean))]; }
function chunks<T>(values: T[], size: number) { const output: T[][] = []; for (let index = 0; index < values.length; index += size) output.push(values.slice(index, index + size)); return output; }
function safeError(error: unknown) { return error instanceof Error ? error.message.replace(/https:\/\/\S+/g, '<redacted-url>').slice(0, 300) : 'subscription synchronization failed'; }

function validAddress(chain: ChainId, address: string) {
  if (chain === 'SOLANA') return isValidSolanaAddress(address) && isEd25519Point(address);
  return /^0x[0-9a-f]{40}$/.test(address);
}

async function filterSolanaWalletAccounts(addresses: string[], rpcUrl: string | undefined) {
  if (!addresses.length) return [];
  if (!rpcUrl?.trim()) throw new Error('ALCHEMY_SOLANA_RPC_URL is required to validate Solana monitoring wallets');
  const valid: string[] = [];
  for (const [index, batch] of chunks(addresses, SOLANA_ACCOUNT_BATCH_SIZE).entries()) {
    const response = await fetch(rpcUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: index + 1, method: 'getMultipleAccounts',
        params: [batch, { encoding: 'base64', commitment: 'confirmed' }]
      }),
      signal: AbortSignal.timeout(20_000)
    });
    const body = await response.json().catch(() => null) as {
      result?: { value?: Array<{ executable?: boolean; owner?: string } | null> };
      error?: { message?: string };
    } | null;
    if (!response.ok || body?.error || !Array.isArray(body?.result?.value) || body.result.value.length !== batch.length) {
      throw new Error(`Alchemy Solana account validation failed with HTTP ${response.status}: ${body?.error?.message ?? 'invalid response'}`);
    }
    for (let offset = 0; offset < batch.length; offset++) {
      const account = body.result.value[offset];
      if (account === null || (account.executable !== true && account.owner === SYSTEM_PROGRAM)) valid.push(batch[offset]);
    }
  }
  return valid;
}

function sameAddresses(left: string[], right: string[]) {
  if (left.length !== right.length) return false;
  const set = new Set(left);
  return set.size === right.length && right.every((address) => set.has(address));
}

function selectionMetadata(selection: MonitoredAlchemyAddressSelection): Prisma.InputJsonObject {
  return {
    candidateAddressCount: selection.candidateAddressCount,
    uniqueCandidateCount: selection.uniqueCandidateCount,
    sourceDuplicates: selection.sourceDuplicates,
    invalidExcluded: selection.invalidExcluded,
    inactiveExcluded: selection.inactiveExcluded
  };
}

function syncResult(
  chain: ChainId,
  selection: MonitoredAlchemyAddressSelection,
  input: Partial<AlchemySubscriptionSyncResult> & Pick<AlchemySubscriptionSyncResult, 'status' | 'failures'>
): AlchemySubscriptionSyncResult {
  return {
    chain, status: input.status, added: input.added ?? 0, removed: input.removed ?? 0,
    duplicates: input.duplicates ?? 0, failures: input.failures,
    desiredAddressCount: selection.addresses.length,
    remoteAddressCount: input.remoteAddressCount ?? null,
    unchanged: input.unchanged ?? 0,
    candidateAddressCount: selection.candidateAddressCount,
    uniqueCandidateCount: selection.uniqueCandidateCount,
    sourceDuplicates: selection.sourceDuplicates,
    invalidExcluded: selection.invalidExcluded,
    inactiveExcluded: selection.inactiveExcluded
  };
}

function safeResponseBody(body: string) {
  return body.replace(/[A-Za-z0-9_-]{80,}/g, '<redacted>').slice(0, 500) || 'empty response';
}

// Solana wallet keys must be signable Ed25519 points. A syntactically valid
// 32-byte pubkey can still be an off-curve PDA/program address, which Alchemy
// Address Activity rejects. This is the same compressed-point test used by
// PublicKey.isOnCurve, kept local to subscription selection to avoid changing
// any intelligence or ingest validation semantics.
function isEd25519Point(address: string) {
  const bytes = decodeBase58(address);
  if (!bytes || bytes.length !== 32) return false;
  const encoded = Uint8Array.from(bytes);
  const sign = (encoded[31] >> 7) & 1;
  encoded[31] &= 0x7f;
  let y = 0n;
  for (let index = 31; index >= 0; index--) y = (y << 8n) + BigInt(encoded[index]);
  if (y >= ED25519_P) return false;
  const ySquared = field(y * y);
  const xSquared = field((ySquared - 1n) * inverse(field(ED25519_D * ySquared + 1n)));
  let x = power(xSquared, (ED25519_P + 3n) / 8n);
  if (field(x * x - xSquared) !== 0n) x = field(x * ED25519_I);
  return field(x * x - xSquared) === 0n && !(x === 0n && sign === 1);
}

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_VALUES = new Map([...BASE58_ALPHABET].map((character, index) => [character, BigInt(index)]));
const ED25519_P = (1n << 255n) - 19n;
function field(value: bigint) { const result = value % ED25519_P; return result < 0n ? result + ED25519_P : result; }
function power(base: bigint, exponent: bigint) {
  let result = 1n;
  let value = field(base);
  let remaining = exponent;
  while (remaining > 0n) {
    if (remaining & 1n) result = field(result * value);
    value = field(value * value);
    remaining >>= 1n;
  }
  return result;
}
function inverse(value: bigint) { return power(value, ED25519_P - 2n); }
const ED25519_D = field(-121665n * inverse(121666n));
const ED25519_I = power(2n, (ED25519_P - 1n) / 4n);
function decodeBase58(value: string) {
  let number = 0n;
  for (const character of value) {
    const digit = BASE58_VALUES.get(character);
    if (digit === undefined) return null;
    number = number * 58n + digit;
  }
  const suffix: number[] = [];
  while (number > 0n) { suffix.push(Number(number & 0xffn)); number >>= 8n; }
  suffix.reverse();
  let leadingZeroes = 0;
  while (leadingZeroes < value.length && value[leadingZeroes] === '1') leadingZeroes += 1;
  return Uint8Array.from([...Array(leadingZeroes).fill(0), ...suffix]);
}
