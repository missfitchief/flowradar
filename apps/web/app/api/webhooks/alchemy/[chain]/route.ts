import type { ChainId } from '@prisma/client';
import { alchemyPayloadHash, alchemyWebhookId, ingestAlchemyWebhook, prisma } from '@flowradar/db';
import { alchemyWebhookSigningKey, parseAlchemyWebhookEnvelope, verifyAlchemyWebhookSignature } from '@flowradar/providers';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CHAIN_BY_SLUG: Record<string, ChainId> = {
  solana: 'SOLANA', ethereum: 'ETHEREUM', base: 'BASE', arbitrum: 'ARBITRUM', bsc: 'BSC'
};
const NETWORK_ALIASES: Record<ChainId, string[]> = {
  SOLANA: ['SOLANA_MAINNET', 'SOLANA_MAINNET_BETA', 'SOLANA'],
  ETHEREUM: ['ETH_MAINNET', 'ETHEREUM_MAINNET', 'ETHEREUM'],
  BASE: ['BASE_MAINNET', 'BASE'], ARBITRUM: ['ARB_MAINNET', 'ARBITRUM_MAINNET', 'ARBITRUM'],
  BSC: ['BNB_MAINNET', 'BSC_MAINNET', 'BNB', 'BSC']
};

export async function POST(request: Request, context: { params: Promise<{ chain: string }> }) {
  const { chain: slug } = await context.params;
  const chain = CHAIN_BY_SLUG[slug.toLowerCase()];
  if (!chain) return NextResponse.json({ accepted: false, error: 'unsupported_chain' }, { status: 404 });
  const rawBody = await request.text();
  const signingKey = alchemyWebhookSigningKey(chain);
  if (!signingKey) return NextResponse.json({ accepted: false, error: 'receiver_not_configured' }, { status: 503 });
  const signature = request.headers.get('x-alchemy-signature');
  if (!verifyAlchemyWebhookSignature(rawBody, signature, signingKey)) {
    return NextResponse.json({ accepted: false, error: 'invalid_signature' }, { status: 401 });
  }
  try {
    const envelope = parseAlchemyWebhookEnvelope(rawBody);
    const configuredId = alchemyWebhookId(chain);
    if (configuredId && envelope.webhookId !== configuredId) {
      return NextResponse.json({ accepted: false, error: 'unexpected_webhook' }, { status: 401 });
    }
    const network = String(envelope.event.network ?? '').toUpperCase();
    if (network && !NETWORK_ALIASES[chain].includes(network)) {
      return NextResponse.json({ accepted: false, error: 'network_mismatch' }, { status: 400 });
    }
    const result = await ingestAlchemyWebhook(prisma, { chain, envelope, payloadHash: alchemyPayloadHash(rawBody) });
    return NextResponse.json({
      accepted: true, duplicate: result.duplicate, normalizedEvents: result.normalizedEvents,
      persistedEvents: result.persistedEvents, eligibilityStatus: result.eligibilityStatus
    });
  } catch (error) {
    const conflict = error instanceof Error && error.message === 'Conflicting Alchemy webhook replay';
    return NextResponse.json({ accepted: false, error: conflict ? 'conflicting_replay' : 'ingest_failed' }, { status: conflict ? 409 : 500 });
  }
}
