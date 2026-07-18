// FlowRadar — Wallet DNA builder tests (scope-correction pipeline, DB).

import { describe, expect, it, afterAll, beforeEach } from 'vitest';
import net from 'node:net';
import { prisma } from '../../src/client';
import { buildWalletDnaProfiles } from '../../src/runnermining/walletDna';

const PREFIX = 'DRMDN'; // base58-safe (no 0/O/I/l)

function probePort(host: string, port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (ok: boolean) => { socket.removeAllListeners(); socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

const dbReachable = await probePort('localhost', 5439);
const T0 = new Date('2026-06-01T00:00:00Z');
const addr = (s: string) => `${PREFIX}${s}`;

async function cleanup() {
  await prisma.walletDnaProfile.deleteMany({ where: { walletAddress: { startsWith: PREFIX } } });
  await prisma.tokenTopPnlCandidate.deleteMany({ where: { walletAddress: { startsWith: PREFIX } } });
  await prisma.walletBehaviorProfile.deleteMany({ where: { walletAddress: { startsWith: PREFIX } } });
  await prisma.walletTokenTrade.deleteMany({ where: { txHash: { startsWith: PREFIX } } });
  await prisma.tokenLifecycle.deleteMany({ where: { mint: { startsWith: PREFIX } } });
  await prisma.wallet.deleteMany({ where: { address: { startsWith: PREFIX } } });
  await prisma.token.deleteMany({ where: { address: { startsWith: PREFIX } } });
}

let tokenSeq = 0;
async function seedToken(runnerClass: string | null = null, labels: string[] = []) {
  tokenSeq += 1;
  const a = addr(`TK${tokenSeq}`);
  const token = await prisma.token.create({
    data: { chain: 'SOLANA', address: a, symbol: `T${tokenSeq}`, name: a, decimals: 9, firstSeenAt: T0, riskFlags: [] },
    select: { id: true, address: true }
  });
  if (runnerClass) {
    await prisma.tokenLifecycle.create({
      data: {
        mint: a, enteredUniverseAt: T0, sourcesJson: {}, coverage: 'covered',
        runnerClass, outcomeLabels: labels as unknown as object, confidence: 'high', classifiedAt: T0
      }
    });
  }
  return token;
}

async function seedWallet(suffix: string) {
  return prisma.wallet.create({
    data: { address: addr(suffix), chain: 'SOLANA', firstSeenAt: T0, lastActiveAt: T0 },
    select: { id: true, address: true }
  });
}

let txSeq = 0;
async function seedTrade(walletId: string, tokenId: string, action: 'BUY' | 'SELL', usd: number, ts: Date) {
  txSeq += 1;
  return prisma.walletTokenTrade.create({
    data: {
      walletId, tokenId, chain: 'SOLANA', action, amountToken: '10', amountUsd: String(usd),
      txHash: addr(`TX${txSeq}`), blockOrSlot: 1n, ts, priceUsd: '1', marketCapAtTrade: '100000',
      walletScoreAtTime: 50, provider: 'test'
    }
  });
}

beforeEach(async () => {
  if (dbReachable) await cleanup();
});

afterAll(async () => {
  if (!dbReachable) return;
  await cleanup();
  await prisma.$disconnect();
});

describe.skipIf(!dbReachable)('buildWalletDnaProfiles (Wallet DNA)', () => {
  it('WR/EV over COMPLETED positions only — open and unpriced never count; one-winner dependence exposed', async () => {
    const w = await seedWallet('WA');
    const runnerTok = await seedToken('verified_above_10m'); // completed WIN
    const rugTok = await seedToken('verified_below_10m', ['rug_or_collapse']); // completed LOSS
    const openTok = await seedToken(); // partial exit => OPEN
    const unpricedTok = await seedToken(); // unpriced => excluded

    await seedTrade(w.id, runnerTok.id, 'BUY', 100, T0);
    await seedTrade(w.id, runnerTok.id, 'SELL', 500, new Date(T0.getTime() + 1000)); // +400 win
    await seedTrade(w.id, rugTok.id, 'BUY', 100, T0);
    await seedTrade(w.id, rugTok.id, 'SELL', 96, new Date(T0.getTime() + 2000)); // -4 loss (>=95% exited)
    await seedTrade(w.id, openTok.id, 'BUY', 100, T0);
    await seedTrade(w.id, openTok.id, 'SELL', 20, new Date(T0.getTime() + 3000)); // partial => open
    await seedTrade(w.id, unpricedTok.id, 'BUY', 0, T0); // legacy 0-for-unpriced

    const r = await buildWalletDnaProfiles(prisma, { chain: 'SOLANA', walletAddresses: [w.address] });
    expect(r.errors).toBe(0);
    expect(r.walletsWritten).toBe(1);
    expect(r.reconstructed).toBe(1); // behavior profile was missing => reused engine reconstructed it

    const dna = await prisma.walletDnaProfile.findUniqueOrThrow({
      where: { chain_walletAddress: { chain: 'SOLANA', walletAddress: w.address } }
    });
    expect(dna.status).toBe('observation_only');
    expect(dna.tokensEntered).toBe(4);
    expect(dna.runnersEntered).toBe(1);
    expect(dna.completedPositions).toBe(2); // explicit denominator
    expect(dna.openPositions).toBe(1);
    expect(dna.unpricedPositions).toBe(1);
    expect(dna.winCount).toBe(1);
    expect(dna.lossCount).toBe(1);
    expect(dna.winRate).toBe(0.5);
    expect(dna.evUsdPerCompletedPosition).toBe((400 - 4) / 2);
    expect(dna.oneWinnerDependence).toBe(1); // the single winner carries everything
    const outcomes = dna.outcomeMixJson as Record<string, number>;
    expect(outcomes.runner).toBe(1);
    expect(outcomes.rug).toBe(1);
    expect(outcomes.unknown).toBe(2); // unclassified mints stay unknown, never guessed
    expect(dna.coverage).toBe('partial'); // unpriced position degrades coverage
    expect(dna.caveats.join(' ')).toContain('excluded from W/L');

    // Idempotent rerun.
    await buildWalletDnaProfiles(prisma, { chain: 'SOLANA', walletAddresses: [w.address] });
    expect(await prisma.walletDnaProfile.count({ where: { walletAddress: { startsWith: PREFIX } } })).toBe(1);
  });

  it('a wallet with no completed positions gets winRate NULL — never a fabricated zero', async () => {
    const w = await seedWallet('WB');
    const tok = await seedToken();
    await seedTrade(w.id, tok.id, 'BUY', 100, T0); // still holding

    await buildWalletDnaProfiles(prisma, { chain: 'SOLANA', walletAddresses: [w.address] });
    const dna = await prisma.walletDnaProfile.findUniqueOrThrow({
      where: { chain_walletAddress: { chain: 'SOLANA', walletAddress: w.address } }
    });
    expect(dna.completedPositions).toBe(0);
    expect(dna.winRate).toBeNull();
    expect(dna.evUsdPerCompletedPosition).toBeNull();
    expect(dna.openPositions).toBe(1);
    expect(dna.reasonCodes).toContain('no_completed_positions');
  });

  it('provider-discovered wallets with no local history get coverage minimal (honest emptiness)', async () => {
    // Discovery row exists, but the wallet has no local trades at all.
    await prisma.tokenTopPnlCandidate.create({
      data: {
        chain: 'SOLANA', mint: addr('MZZ'), walletAddress: addr('WGH'), source: 'birdeye_top_traders',
        validation: 'provider_only', coverage: 'none', confidence: 25, reasonCodes: [],
        receiptsJson: {}, caveats: [], engineVersion: 1
      }
    });
    const r = await buildWalletDnaProfiles(prisma, { chain: 'SOLANA' , walletAddresses: [addr('WGH')] });
    expect(r.walletsWritten).toBe(1);
    const dna = await prisma.walletDnaProfile.findUniqueOrThrow({
      where: { chain_walletAddress: { chain: 'SOLANA', walletAddress: addr('WGH') } }
    });
    expect(dna.coverage).toBe('minimal');
    expect(dna.tokensEntered).toBe(0);
    expect(dna.winRate).toBeNull();
    expect(dna.caveats.join(' ')).toContain('not evidence of inactivity');
    const discovery = dna.discoveryJson as { mint: string; source: string }[];
    expect(discovery).toHaveLength(1);
    expect(discovery[0].source).toBe('birdeye_top_traders');
  });

  it('default cohort = distinct discovered wallets from token_top_pnl_candidates', async () => {
    const w = await seedWallet('WC');
    const tok = await seedToken('verified_above_10m');
    await seedTrade(w.id, tok.id, 'BUY', 50, T0);
    await prisma.tokenTopPnlCandidate.create({
      data: {
        chain: 'SOLANA', mint: tok.address, walletAddress: w.address, source: 'local_reconstruction',
        validation: 'incomplete', coverage: 'local_partial', confidence: 35, reasonCodes: [],
        receiptsJson: {}, caveats: [], engineVersion: 1
      }
    });
    // Scope to the PREFIX cohort via walletAddresses to avoid other suites' rows.
    const r = await buildWalletDnaProfiles(prisma, { chain: 'SOLANA', walletAddresses: [w.address] });
    expect(r.walletsWritten).toBe(1);
    const dna = await prisma.walletDnaProfile.findUniqueOrThrow({
      where: { chain_walletAddress: { chain: 'SOLANA', walletAddress: w.address } }
    });
    expect(dna.runnersEntered).toBe(1);
    expect(dna.openPositions).toBe(1);
  });
});
