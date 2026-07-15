import { createHmac, timingSafeEqual } from 'node:crypto';
import { normalizeMassTransaction, type Chain, type MassTransactionEvent, type NormalizedTx } from '@flowradar/core';
import { alchemyRpcRequest, alchemyRpcUrl, mapAlchemyEvmTransfers, mapAlchemySolanaTransaction, type AlchemyRpcEnv, type AlchemyTransfer } from './rpc';

export interface AlchemyWebhookEnvelope {
  webhookId: string;
  id: string;
  createdAt: string;
  type: string;
  event: Record<string, unknown>;
}

export interface AlchemyWebhookEnv extends AlchemyRpcEnv {
  ALCHEMY_SOLANA_WEBHOOK_SIGNING_KEY?: string;
  ALCHEMY_ETHEREUM_WEBHOOK_SIGNING_KEY?: string;
  ALCHEMY_BASE_WEBHOOK_SIGNING_KEY?: string;
  ALCHEMY_ARBITRUM_WEBHOOK_SIGNING_KEY?: string;
  ALCHEMY_BSC_WEBHOOK_SIGNING_KEY?: string;
}

const SIGNING_KEY_ENV: Record<Chain, keyof AlchemyWebhookEnv> = {
  SOLANA: 'ALCHEMY_SOLANA_WEBHOOK_SIGNING_KEY', ETHEREUM: 'ALCHEMY_ETHEREUM_WEBHOOK_SIGNING_KEY',
  BASE: 'ALCHEMY_BASE_WEBHOOK_SIGNING_KEY', ARBITRUM: 'ALCHEMY_ARBITRUM_WEBHOOK_SIGNING_KEY',
  BSC: 'ALCHEMY_BSC_WEBHOOK_SIGNING_KEY'
};

export function alchemyWebhookSigningKey(chain: Chain, env: AlchemyWebhookEnv = process.env as AlchemyWebhookEnv) {
  return env[SIGNING_KEY_ENV[chain]]?.trim() || null;
}

export function verifyAlchemyWebhookSignature(rawBody: string, signature: string | null, signingKey: string | null): boolean {
  if (!signature || !signingKey || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  const expected = createHmac('sha256', signingKey).update(rawBody, 'utf8').digest();
  const provided = Buffer.from(signature, 'hex');
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export function parseAlchemyWebhookEnvelope(rawBody: string): AlchemyWebhookEnvelope {
  let value: unknown;
  try { value = JSON.parse(rawBody); } catch { throw new Error('Webhook body is not valid JSON'); }
  const envelope = objectOf(value);
  const event = objectOf(envelope?.event);
  if (!envelope || !event || typeof envelope.id !== 'string' || typeof envelope.webhookId !== 'string' || typeof envelope.createdAt !== 'string' || envelope.type !== 'ADDRESS_ACTIVITY') {
    throw new Error('Unsupported Alchemy webhook payload');
  }
  const createdAt = new Date(envelope.createdAt);
  if (!Number.isFinite(createdAt.getTime())) throw new Error('Alchemy webhook createdAt is invalid');
  return { webhookId: envelope.webhookId, id: envelope.id, createdAt: envelope.createdAt, type: envelope.type, event };
}

export async function normalizeAlchemyWebhook(
  chain: Chain,
  envelope: AlchemyWebhookEnvelope,
  trackedAddresses: ReadonlySet<string>,
  options: { env?: AlchemyWebhookEnv; observedAt?: Date } = {}
): Promise<MassTransactionEvent[]> {
  const env = options.env ?? process.env as AlchemyWebhookEnv;
  const observedAt = options.observedAt ?? new Date();
  const rows = activityRows(envelope.event, envelope.createdAt);
  const byHash = new Map<string, AlchemyTransfer[]>();
  for (const row of rows) {
    if (!row.hash) continue;
    const bucket = byHash.get(row.hash) ?? [];
    bucket.push(row); byHash.set(row.hash, bucket);
  }
  const rpcUrl = alchemyRpcUrl(chain, env);
  const events: MassTransactionEvent[] = [];
  for (const [hash, transfers] of [...byHash.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    let actor = chooseActor(chain, transfers, trackedAddresses);
    let txs = actor ? await mapWebhookTransaction(chain, rpcUrl, actor, transfers) : [];
    // Solana webhooks can occasionally omit parsed transfer sides. Only in
    // that insufficient-payload case spend one RPC call for the full parsed
    // transaction and recover the subscribed actor from its account keys.
    if (chain === 'SOLANA' && rpcUrl && (!actor || txs.length === 0)) {
      const transaction = await alchemyRpcRequest<unknown>(rpcUrl, 'getTransaction', [hash, {
        encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0
      }]).catch(() => null);
      actor = actor ?? chooseSolanaActor(transaction, trackedAddresses);
      const mapped = actor ? mapAlchemySolanaTransaction(transaction, actor) : null;
      if (mapped) txs = [mapped];
    }
    if (!actor) continue;
    for (const tx of txs) {
      const normalized = normalizeMassTransaction(tx, { chain, provider: 'AlchemyWebhook', observedAt }, actor)
        .map((event) => ({
          ...event,
          eventId: `alchemy:${chain}:${hash}:${event.eventIndex}`,
          metadata: {
            ...event.metadata, alchemyWebhookEventId: envelope.id, alchemyWebhookId: envelope.webhookId,
            alchemyNetwork: String(envelope.event.network ?? ''), liveWebhook: true, historicalBackfill: false
          }
        }));
      events.push(...normalized);
    }
  }
  return events;
}

async function mapWebhookTransaction(chain: Chain, rpcUrl: string | null, actor: string, transfers: AlchemyTransfer[]): Promise<NormalizedTx[]> {
  const sorted = [...transfers].sort((a, b) => transferKey(a).localeCompare(transferKey(b)));
  if (chain !== 'SOLANA' && rpcUrl) return mapAlchemyEvmTransfers(rpcUrl, chain, actor, sorted);
  // Solana Address Activity uses the same transfer-oriented envelope. It is
  // deliberately mapped as transfers unless the payload itself proves both
  // sides of an asset exchange; no extra per-event RPC calls are spent on an
  // ordinary one-way funding transfer.
  return mapAlchemyEvmTransfers('', chain, actor, sorted);
}

function activityRows(event: Record<string, unknown>, createdAt: string): AlchemyTransfer[] {
  const activity = Array.isArray(event.activity) ? event.activity : [];
  return activity.map((value) => {
    const row = objectOf(value) ?? {};
    const raw = objectOf(row.rawContract);
    const metadata = objectOf(row.metadata);
    return {
      blockNum: stringOf(row.blockNum) ?? stringOf(row.slot) ?? '0x0',
      uniqueId: stringOf(row.uniqueId), hash: stringOf(row.hash) ?? stringOf(row.signature),
      from: stringOf(row.fromAddress) ?? stringOf(row.from), to: stringOf(row.toAddress) ?? stringOf(row.to),
      value: numberOrString(row.value), asset: stringOf(row.asset), category: stringOf(row.category),
      rawContract: raw ? { value: stringOf(raw.rawValue) ?? stringOf(raw.value), address: stringOf(raw.address), decimal: raw.decimals ?? raw.decimal as string | number | null } : undefined,
      metadata: { blockTimestamp: stringOf(metadata?.blockTimestamp) ?? createdAt }
    } satisfies AlchemyTransfer;
  });
}

function chooseActor(chain: Chain, rows: AlchemyTransfer[], tracked: ReadonlySet<string>) {
  const normalize = (value: string | undefined) => chain === 'SOLANA' ? value ?? '' : (value ?? '').toLowerCase();
  for (const row of rows) {
    const from = normalize(row.from); const to = normalize(row.to);
    if (tracked.has(from)) return from;
    if (tracked.has(to)) return to;
  }
  return null;
}

function chooseSolanaActor(value: unknown, tracked: ReadonlySet<string>) {
  const row = objectOf(value);
  const transaction = objectOf(row?.transaction);
  const message = objectOf(transaction?.message);
  const accountKeys = Array.isArray(message?.accountKeys) ? message.accountKeys : [];
  for (const value of accountKeys) {
    const address = typeof value === 'string' ? value : stringOf(objectOf(value)?.pubkey);
    if (address && tracked.has(address)) return address;
  }
  return null;
}

function transferKey(row: AlchemyTransfer) { return [row.category, row.from, row.to, row.rawContract?.address, row.rawContract?.value, row.value].join('|'); }
function objectOf(value: unknown): Record<string, any> | null { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : null; }
function stringOf(value: unknown): string | undefined { return typeof value === 'string' && value ? value : undefined; }
function numberOrString(value: unknown): string | number | null { return typeof value === 'string' || typeof value === 'number' ? value : null; }
