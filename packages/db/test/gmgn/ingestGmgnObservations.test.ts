// FlowRadar — GMGN raw observation ingest tests (Task 2). Isolated test DB.
//
// Covers the pure normalizers (feed row → GmgnObservation) and the DB ingest:
// append-only rows with dedupe idempotency, wallet materialization as
// observation_only (never eligible), provider claims → ObservationProviderSnapshot
// (never WalletStats), KOL/promoter status mapping ONLY with provider evidence,
// and cross-source dedup preserving confirmation.
import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import net from 'node:net';
import { prisma } from '../../src/client';
import {
  normalizeSmartmoneyRow,
  normalizePortfolioActivityRow,
  gmgnDedupeKey,
  ingestGmgnObservations,
  type GmgnObservationInput
} from '../../src/gmgn/ingest';

const PFX = 'GMGNTEST';
const NOW = new Date('2026-07-11T12:00:00Z');
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function addr(seed: number): string {
  const b = new Uint8Array(32);
  for (let i = 0; i < 32; i++) b[i] = (seed * 97 + i * 11 + 3) % 256;
  if (b[0] === 0) b[0] = 5;
  let acc = 0n; for (const x of b) acc = (acc << 8n) | BigInt(x);
  let o = ''; while (acc > 0n) { o = B58[Number(acc % 58n)] + o; acc /= 58n; }
  return o;
}
function probe(port: number): Promise<boolean> {
  return new Promise((r) => { const s = net.createConnection({ host: 'localhost', port }); const d = (ok: boolean) => { s.removeAllListeners(); s.destroy(); r(ok); }; s.setTimeout(800); s.once('connect', () => d(true)); s.once('timeout', () => d(false)); s.once('error', () => d(false)); });
}
const A1 = addr(1), A2 = addr(2), T1 = addr(50);
async function cleanup() {
  await prisma.gmgnObservation.deleteMany({ where: { sourceCommand: { startsWith: PFX } } });
  await prisma.observationProviderSnapshot.deleteMany({ where: { wallet: { address: { in: [A1, A2] } } } });
  await prisma.walletStats.deleteMany({ where: { wallet: { address: { in: [A1, A2] } } } });
  await prisma.wallet.deleteMany({ where: { address: { in: [A1, A2] } } });
}

const HAS_DB = await probe(5439);
const d = HAS_DB ? describe : describe.skip;

describe('gmgn normalizers (pure)', () => {
  it('normalizes a smartmoney trade row, distinguishing buy/sell + provider label', () => {
    const row = { maker: A1, base_address: T1, side: 'buy', token_amount: '1000', amount_usd: '250.5', timestamp: 1_752_000_000, maker_info: { tag: 'smart_degen' } };
    const o = normalizeSmartmoneyRow(row, { sourceCommand: `${PFX}:track smartmoney`, retrievedAt: NOW });
    expect(o.walletAddress).toBe(A1);
    expect(o.tokenAddress).toBe(T1);
    expect(o.side).toBe('buy');
    expect(Number(o.amountUsd)).toBe(250.5);
    expect(o.activityTs).toEqual(new Date(1_752_000_000 * 1000));
    expect(o.isKolTagged).toBe(false);
    expect(o.rawClassification).toEqual({ tag: 'smart_degen' });
  });

  it('flags a KOL-tagged maker', () => {
    const row = { maker: A1, base_address: T1, side: 'sell', timestamp: 1_752_000_000, maker_info: { is_kol: true, name: 'SomeKOL' } };
    const o = normalizeSmartmoneyRow(row, { sourceCommand: `${PFX}:track kol`, retrievedAt: NOW });
    expect(o.isKolTagged).toBe(true);
  });

  it('normalizes portfolio activity with transfer types and unknown side', () => {
    const row = { wallet: A2, token: T1, event_type: 'transferIn', token_amount: '5', cost_usd: null, timestamp: 1_752_000_500, tx_hash: 'sig' };
    const o = normalizePortfolioActivityRow(row, { sourceCommand: `${PFX}:portfolio activity`, retrievedAt: NOW });
    expect(o.side).toBe('transfer');
    expect(o.activityType).toBe('transferIn');
    expect(o.amountUsd).toBeNull(); // missing USD stays null, never 0
  });

  it('dedupeKey is stable + tuple-sensitive', () => {
    const base: GmgnObservationInput = { chain: 'SOLANA', sourceCommand: `${PFX}:x`, walletAddress: A1, tokenAddress: T1, side: 'buy', activityTs: NOW, retrievedAt: NOW, dataQuality: 'complete', dedupeKey: '' };
    const k1 = gmgnDedupeKey(base);
    const k2 = gmgnDedupeKey({ ...base, retrievedAt: new Date(NOW.getTime() + 99999) });
    const k3 = gmgnDedupeKey({ ...base, side: 'sell' });
    expect(k1).toBe(k2); // retrievedAt not in the key (idempotent re-poll)
    expect(k1).not.toBe(k3); // side IS in the key
  });
});

d('ingestGmgnObservations (DB)', () => {
  beforeEach(cleanup);
  afterAll(async () => { await cleanup(); await prisma.$disconnect(); });

  function obs(p: Partial<GmgnObservationInput>): GmgnObservationInput {
    const base: GmgnObservationInput = { chain: 'SOLANA', sourceCommand: `${PFX}:track smartmoney`, walletAddress: A1, tokenAddress: T1, side: 'buy', amountUsd: '100', activityTs: NOW, retrievedAt: NOW, dataQuality: 'complete', dedupeKey: '', ...p };
    base.dedupeKey = gmgnDedupeKey(base);
    return base;
  }

  it('creates observation rows + materializes wallets observation_only, never eligible', async () => {
    const res = await ingestGmgnObservations(prisma, [obs({ walletAddress: A1 }), obs({ walletAddress: A2, side: 'sell' })]);
    expect(res.observationsCreated).toBe(2);
    expect(res.walletsMaterialized).toBe(2);
    const w = await prisma.wallet.findUnique({ where: { address_chain: { address: A1, chain: 'SOLANA' } }, include: { stats: true } });
    expect(w!.status).toBe('observation_only');
    expect(w!.stats).toHaveLength(0); // NEVER WalletStats
  });

  it('is idempotent — re-ingesting the same rows creates zero duplicates', async () => {
    const rows = [obs({}), obs({ side: 'sell' })];
    await ingestGmgnObservations(prisma, rows);
    const res2 = await ingestGmgnObservations(prisma, rows);
    expect(res2.observationsCreated).toBe(0);
    expect(res2.duplicatesSkipped).toBe(2);
    expect(await prisma.gmgnObservation.count({ where: { sourceCommand: { startsWith: PFX } } })).toBe(2);
  });

  it('provider metrics land in ObservationProviderSnapshot (provider_claimed), not WalletStats', async () => {
    await ingestGmgnObservations(prisma, [obs({ providerPnlUsd: '12345.67', providerWinRate: 0.62, providerTradeCount: 40 })]);
    const w = await prisma.wallet.findUnique({ where: { address_chain: { address: A1, chain: 'SOLANA' } }, include: { stats: true } });
    expect(w!.stats).toHaveLength(0);
    const snap = await prisma.observationProviderSnapshot.findFirst({ where: { walletId: w!.id, source: { startsWith: 'gmgn' } } });
    expect(snap).not.toBeNull();
    expect(snap!.providerClaimed).toBe(true);
    expect(Number(snap!.pnlUsd)).toBe(12345.67);
    expect(snap!.winRate).toBeCloseTo(0.62, 5);
  });

  it('a KOL-tagged wallet becomes public_kol (crowd analysis) — never signal_eligible', async () => {
    await ingestGmgnObservations(prisma, [obs({ isKolTagged: true })]);
    const w = await prisma.wallet.findUnique({ where: { address_chain: { address: A1, chain: 'SOLANA' } } });
    expect(w!.status).toBe('public_kol');
  });

  it('PRESERVES an existing classified status (does not demote public_kol to observation)', async () => {
    await prisma.wallet.create({ data: { address: A1, chain: 'SOLANA', firstSeenAt: NOW, lastActiveAt: NOW, status: 'signal_eligible' } });
    await ingestGmgnObservations(prisma, [obs({ isKolTagged: true })]);
    const w = await prisma.wallet.findUnique({ where: { address_chain: { address: A1, chain: 'SOLANA' } } });
    // An operator-promoted signal_eligible wallet is NEVER downgraded by a GMGN feed.
    expect(w!.status).toBe('signal_eligible');
  });

  it('cross-source: the same wallet from two feeds keeps both observation rows (confirmation preserved)', async () => {
    await ingestGmgnObservations(prisma, [
      obs({ sourceCommand: `${PFX}:track smartmoney`, activityTs: new Date(NOW.getTime() + 1000) }),
      obs({ sourceCommand: `${PFX}:token traders`, activityTs: new Date(NOW.getTime() + 1000) })
    ]);
    // Different sourceCommand ⇒ different dedupeKey ⇒ both retained.
    expect(await prisma.gmgnObservation.count({ where: { walletAddress: A1, sourceCommand: { startsWith: PFX } } })).toBe(2);
  });

  it('never writes signal_eligible for a brand-new GMGN wallet under any flag combo', async () => {
    await ingestGmgnObservations(prisma, [obs({ isKolTagged: true, isPromoterTagged: true, providerPnlUsd: '999999', providerWinRate: 0.99 })]);
    expect(await prisma.wallet.count({ where: { address: A1, status: 'signal_eligible' } })).toBe(0);
  });
});
