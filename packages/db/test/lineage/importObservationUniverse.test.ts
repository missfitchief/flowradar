// FlowRadar — observation-universe importer tests (Wave D).
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import net from 'node:net';
import { prisma } from '../../src/client';
import { importObservationUniverse, parseObservationUniverse } from '../../src/lineage/importObservationUniverse';

const PREFIX = 'OBSUNIV';
const NOW = new Date('2026-07-10T12:00:00Z');
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function addr(seed: number): string {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = (seed * 91 + i * 13 + 5) % 256;
  if (bytes[0] === 0) bytes[0] = 9;
  let acc = 0n;
  for (const b of bytes) acc = (acc << 8n) | BigInt(b);
  let out = '';
  while (acc > 0n) { out = BASE58[Number(acc % 58n)] + out; acc /= 58n; }
  return out;
}

function probePort(host: string, port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createConnection({ host, port });
    const done = (ok: boolean) => { s.removeAllListeners(); s.destroy(); resolve(ok); };
    s.setTimeout(timeoutMs); s.once('connect', () => done(true)); s.once('timeout', () => done(false)); s.once('error', () => done(false));
  });
}
let dbReachable = false;
beforeAll(async () => { dbReachable = await probePort('localhost', 5439); });

const A1 = addr(1), A2 = addr(2), A3 = addr(3);
async function cleanup() {
  await prisma.walletStats.deleteMany({ where: { wallet: { address: { in: [A1, A2, A3] } } } });
  await prisma.wallet.deleteMany({ where: { address: { in: [A1, A2, A3] } } });
}
afterAll(async () => { if (!dbReachable) return; await cleanup(); await prisma.$disconnect(); });
beforeEach(async () => { if (!dbReachable) return; await cleanup(); });

describe('parseObservationUniverse (pure)', () => {
  it('parses valid rows, parks EVM, flags malformed, dedupes', () => {
    const csv = [
      'wallet_address,source,pnl_30d,win_rate,trade_count_30d,avg_trade_size_usd,tags',
      `${A1},solana_tracker,50000,0.6,40,500,smart|kol`,
      '0xcd83f4c3a4b96d56367e482a3774802877b82e13,evm,1,1,1,1,',
      'not-an-address,bad,,,,,',
      `${A1},dup,,,,,` // duplicate
    ].join('\n');
    const r = parseObservationUniverse(csv);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.providerStats).toMatchObject({ pnl30d: 50000, winRate: 0.6 });
    expect(r.rows[0]!.tags).toEqual(['smart', 'kol']);
    expect(r.evmParked).toHaveLength(1);
    expect(r.malformed).toHaveLength(1);
    expect(r.duplicates).toBe(1);
  });

  it('does NOT build provider stats from a partial/invalid row (no fabrication)', () => {
    const csv = ['wallet_address,pnl_30d,win_rate', `${A2},50000,`, `${A3},50000,5`].join('\n'); // missing / win>1
    const r = parseObservationUniverse(csv);
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]!.providerStats).toBeUndefined();
    expect(r.rows[1]!.providerStats).toBeUndefined(); // win_rate 5 is not a fraction
  });

  it('does NOT fabricate zero stats from blank cells (Number("")===0 trap)', () => {
    // All stats headers present but cells blank / negative — must NOT create
    // a zeroed provider-stats block (hard rule 9: missing = unknown, not 0).
    const csv = [
      'wallet_address,pnl_30d,win_rate,trade_count_30d,avg_trade_size_usd',
      `${A1},,,,`,           // all blank
      `${A2},50000,0.6,,500`, // one blank (trade_count)
      `${A3},50000,0.6,-4,500` // negative trade_count
    ].join('\n');
    const r = parseObservationUniverse(csv);
    expect(r.rows).toHaveLength(3);
    expect(r.rows[0]!.providerStats).toBeUndefined();
    expect(r.rows[1]!.providerStats).toBeUndefined();
    expect(r.rows[2]!.providerStats).toBeUndefined();
  });

  it('canonicalizes an inline addr|label cell and dedupes it against the bare address', () => {
    const csv = [
      'wallet_address,source',
      `${A1},plain`,
      `${A1}|smart-money,labeled` // same address, decorated — must dedupe, not create a malformed row
    ].join('\n');
    const r = parseObservationUniverse(csv);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.address).toBe(A1); // canonical, label stripped
    expect(r.malformed).toHaveLength(0);
    expect(r.duplicates).toBe(1);
  });

  it('throws when the wallet_address header is missing (no silent column-0 guess)', () => {
    const csv = [`addr,source`, `${A1},x`].join('\n');
    expect(() => parseObservationUniverse(csv)).toThrow(/wallet_address/);
  });

  it('handles spreadsheet-style quoted fields incl. embedded commas', () => {
    const csv = [
      '"wallet_address","source","tags"',
      `"${A1}","solana, tracker","smart|kol"`, // quoted address + comma inside a quoted field
      `${A2},plain,x`                            // mixed: unquoted row still works
    ].join('\n');
    const r = parseObservationUniverse(csv);
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]!.address).toBe(A1); // quoted address validated, not malformed
    expect(r.rows[0]!.source).toBe('solana, tracker'); // comma did not shift columns
    expect(r.rows[0]!.tags).toEqual(['smart', 'kol']);
    expect(r.rows[1]!.address).toBe(A2);
    expect(r.malformed).toHaveLength(0);
  });
});

describe.skipIf(!(await probePort('localhost', 5439)))('importObservationUniverse', () => {
  it('creates wallets observation_only with provider_claimed stats; never signal_eligible', async () => {
    const csv = ['wallet_address,source,pnl_30d,win_rate,trade_count_30d,avg_trade_size_usd', `${A1},solana_tracker,50000,0.6,40,500`].join('\n');
    const res = await importObservationUniverse(prisma, csv, { now: NOW });
    expect(res.walletsCreated).toBe(1);
    expect(res.statsRowsCreated).toBe(1);
    const w = await prisma.wallet.findUnique({ where: { address_chain: { address: A1, chain: 'SOLANA' } }, include: { stats: true } });
    expect(w!.status).toBe('observation_only');
    expect(w!.isWatched).toBe(false);
    expect(w!.stats[0]!.source).toBe('provider'); // provider_claimed
  });

  it('address-only rows create observation wallets with NO fabricated stats', async () => {
    const csv = ['wallet_address', A2].join('\n');
    const res = await importObservationUniverse(prisma, csv, { now: NOW });
    expect(res.walletsCreated).toBe(1);
    expect(res.statsRowsCreated).toBe(0);
    const w = await prisma.wallet.findUnique({ where: { address_chain: { address: A2, chain: 'SOLANA' } }, include: { stats: true } });
    expect(w!.stats).toHaveLength(0); // NOT fabricated
  });

  it('PRESERVES an existing classified status (public_kol) and never demotes/promotes', async () => {
    await prisma.wallet.create({ data: { address: A3, chain: 'SOLANA', firstSeenAt: NOW, lastActiveAt: NOW, status: 'public_kol' } });
    const csv = ['wallet_address,pnl_30d,win_rate,trade_count_30d,avg_trade_size_usd', `${A3},99999,0.9,100,1000`].join('\n');
    const res = await importObservationUniverse(prisma, csv, { now: NOW });
    expect(res.walletsExisting).toBe(1);
    const w = await prisma.wallet.findUnique({ where: { address_chain: { address: A3, chain: 'SOLANA' } } });
    expect(w!.status).toBe('public_kol'); // preserved, not re-statused
  });

  it('is idempotent — a second import creates no duplicate wallet/stats', async () => {
    const csv = ['wallet_address,pnl_30d,win_rate,trade_count_30d,avg_trade_size_usd', `${A1},50000,0.6,40,500`].join('\n');
    await importObservationUniverse(prisma, csv, { now: NOW });
    const res2 = await importObservationUniverse(prisma, csv, { now: NOW });
    expect(res2.walletsCreated).toBe(0);
    expect(res2.statsRowsCreated).toBe(0);
    expect(await prisma.walletStats.count({ where: { wallet: { address: A1 } } })).toBe(1);
  });

  it('an imported observation wallet contributes ZERO smart votes (status gate holds)', async () => {
    const csv = ['wallet_address,pnl_30d,win_rate,trade_count_30d,avg_trade_size_usd', `${A1},999999,0.9,500,5000`].join('\n');
    await importObservationUniverse(prisma, csv, { now: NOW });
    const w = await prisma.wallet.findUnique({ where: { address_chain: { address: A1, chain: 'SOLANA' } } });
    // observation_only => isSignalEligibleStatus false => zero smart weight
    // (enforced in aggregateWindow; here we assert the status is the gate).
    expect(w!.status).toBe('observation_only');
  });
});
