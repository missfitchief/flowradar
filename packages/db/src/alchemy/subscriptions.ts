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

export interface AlchemySubscriptionEnv extends NodeJS.ProcessEnv {
  ALCHEMY_NOTIFY_AUTH_TOKEN?: string;
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
    const desired = await monitoredAddresses(prisma, chain);
    const desiredSet = new Set(desired);
    const webhookId = alchemyWebhookId(chain, env);
    const auth = env.ALCHEMY_NOTIFY_AUTH_TOKEN?.trim();
    if (!webhookId || !auth) {
      await saveState(prisma, chain, webhookId, 'pending_configuration', desired.length, null, null, {
        notifyAuthConfigured: Boolean(auth), webhookIdConfigured: Boolean(webhookId)
      });
      results.push({ chain, status: 'pending_configuration', added: 0, removed: 0, duplicates: 0, failures: 0, desiredAddressCount: desired.length, remoteAddressCount: null });
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
      if (add.length || remove.length) await updateAddresses(webhookId, auth, add, remove);
      const duplicates = remote.duplicates + (action === 'add' ? addresses.length - add.length : 0);
      const remoteCount = remoteSet.size + add.length - remove.length;
      await saveState(prisma, chain, webhookId, 'synced', desired.length, remoteCount, null, { lastAction: action, added: add.length, removed: remove.length, duplicates });
      results.push({ chain, status: 'synced', added: add.length, removed: remove.length, duplicates, failures: 0, desiredAddressCount: desired.length, remoteAddressCount: remoteCount });
    } catch (error) {
      const message = safeError(error);
      await saveState(prisma, chain, webhookId, 'failed', desired.length, null, message, { lastAction: action, changedAddresses: addresses.length });
      results.push({ chain, status: 'failed', added: 0, removed: 0, duplicates: 0, failures: 1, desiredAddressCount: desired.length, remoteAddressCount: null });
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
    const desired = await monitoredAddresses(prisma, chain);
    const webhookId = alchemyWebhookId(chain, env);
    const auth = env.ALCHEMY_NOTIFY_AUTH_TOKEN?.trim();
    if (!webhookId || !auth) {
      await saveState(prisma, chain, webhookId, 'pending_configuration', desired.length, null, null, {
        notifyAuthConfigured: Boolean(auth), webhookIdConfigured: Boolean(webhookId)
      });
      output.push({ chain, status: 'pending_configuration', added: 0, removed: 0, duplicates: 0, failures: 0, desiredAddressCount: desired.length, remoteAddressCount: null });
      continue;
    }
    try {
      const remote = await listAddresses(webhookId, auth, chain);
      const remoteSet = new Set(remote.addresses);
      const missing = desired.filter((address) => !remoteSet.has(address));
      const desiredSet = new Set(desired);
      const stale = remote.addresses.filter((address) => !desiredSet.has(address));
      const addBatches = chunks(missing, 500);
      const removeBatches = chunks(stale, 500);
      for (let index = 0; index < Math.max(addBatches.length, removeBatches.length); index++) {
        await updateAddresses(webhookId, auth, addBatches[index] ?? [], removeBatches[index] ?? []);
      }
      await saveState(prisma, chain, webhookId, 'synced', desired.length, desired.length, null, {
        addedDuringReconcile: missing.length, removedDuringReconcile: stale.length, duplicates: remote.duplicates
      });
      output.push({ chain, status: 'synced', added: missing.length, removed: stale.length, duplicates: remote.duplicates, failures: 0, desiredAddressCount: desired.length, remoteAddressCount: desired.length });
    } catch (error) {
      await saveState(prisma, chain, webhookId, 'failed', desired.length, null, safeError(error), { reconciliation: true });
      output.push({ chain, status: 'failed', added: 0, removed: 0, duplicates: 0, failures: 1, desiredAddressCount: desired.length, remoteAddressCount: null });
    }
  }
  return output;
}

export async function monitoredAlchemyAddresses(prisma: PrismaClient, chain: ChainId) {
  const wallets = await prisma.wallet.findMany({
    where: { chain, monitoringSubscriptions: { some: { active: true } } },
    select: { address: true }
  });
  return unique(wallets.map((wallet) => normalize(chain, wallet.address))).sort();
}

const monitoredAddresses = monitoredAlchemyAddresses;

async function updateAddresses(webhookId: string, auth: string, add: string[], remove: string[]) {
  const response = await fetch(UPDATE_URL, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'X-Alchemy-Token': auth },
    body: JSON.stringify({ webhook_id: webhookId, addresses_to_add: add, addresses_to_remove: remove }),
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) throw new Error(`Alchemy Notify address update failed with HTTP ${response.status}`);
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

function normalize(chain: ChainId, address: string) { return chain === 'SOLANA' ? address : address.toLowerCase(); }
function unique(values: string[]) { return [...new Set(values.filter(Boolean))]; }
function chunks<T>(values: T[], size: number) { const output: T[][] = []; for (let index = 0; index < values.length; index += size) output.push(values.slice(index, index + size)); return output; }
function safeError(error: unknown) { return error instanceof Error ? error.message.replace(/https:\/\/\S+/g, '<redacted-url>').slice(0, 300) : 'subscription synchronization failed'; }
