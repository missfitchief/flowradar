// FlowRadar — Phase A closure + Task 5 pilot: rebuild controls once after the
// suspect downgrade, then full wallet-token history reconstruction over the
// real buyer cohort of runner/control tokens using the EXISTING approved
// behavior engine (reconstructWalletBehavior — field-level provenance,
// winners+losers, provider claims separated). PILOT DB ONLY.
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: path.join(HERE, '..', '..', 'flowradar', '.env') });
const { prisma, buildControlMatches, reconstructWalletBehavior } = await import('@flowradar/db');
import { writeFileSync, mkdirSync } from 'node:fs';

const url = new URL(process.env.DATABASE_URL ?? 'postgresql://invalid');
if (url.pathname !== '/flowradar_pilot') throw new Error('pilot DB only: ' + url.pathname);

async function main() {
  // A3 closure: rebuild controls ONCE after the 32-suspect downgrade.
  const controls = await buildControlMatches(prisma);

  // Task 5 tranche: first 50 matched pairs (deterministic by runnerMint).
  const pairs = await prisma.cohortMatch.findMany({
    where: { status: { in: ['matched_tier1', 'matched_tier2'] } },
    orderBy: { runnerMint: 'asc' },
    take: 50,
    select: { runnerMint: true, controlMint: true }
  });
  const mints = [...new Set(pairs.flatMap((p) => [p.runnerMint, p.controlMint].filter(Boolean) as string[]))];

  // Cohort = locally observed BUYERS of those tokens (earliest buyers first),
  // capped at 1,000 unique wallets. Their in-band status is UNPROVEN (entry
  // valuations unavailable) — recorded as a cohort caveat, not fabricated.
  const tokens = await prisma.token.findMany({ where: { address: { in: mints }, chain: 'SOLANA' }, select: { id: true, address: true } });
  const wallets = new Set<string>();
  for (const t of tokens) {
    if (wallets.size >= 1000) break;
    const buys = await prisma.walletTokenTrade.findMany({
      where: { tokenId: t.id, action: 'BUY' },
      orderBy: [{ ts: 'asc' }, { id: 'asc' }],
      take: 200,
      select: { wallet: { select: { address: true } } }
    });
    for (const b of buys) { if (wallets.size < 1000) wallets.add(b.wallet.address); }
  }

  let profiles = 0, errors = 0;
  const byQuality: Record<string, number> = {};
  let withLosers = 0, withWinners = 0, incomplete = 0;
  const outcomeByMint = new Map((await prisma.tokenLifecycle.findMany({
    where: { runnerClass: { not: null } }, select: { mint: true, runnerClass: true }
  })).map((r) => [r.mint, r.runnerClass]));

  for (const address of wallets) {
    try {
      const { profile } = await reconstructWalletBehavior(prisma, { chain: 'SOLANA', address });
      profiles += 1;
      byQuality[profile.dataQuality] = (byQuality[profile.dataQuality] ?? 0) + 1;
      if (profile.localViewTruncated) incomplete += 1;
      const positions = profile.local.tokenPositions;
      if (positions.some((p) => outcomeByMint.get(p.tokenAddress) === 'verified_above_10m')) withWinners += 1;
      if (positions.some((p) => (p.exitRatio ?? 0) < 0.5 && p.buyUsd > 0)) withLosers += 1;
    } catch { errors += 1; }
  }

  // Idempotency: rerun 25 wallets — row count must not grow.
  const before = await prisma.walletBehaviorProfile.count();
  for (const address of [...wallets].slice(0, 25)) {
    try { await reconstructWalletBehavior(prisma, { chain: 'SOLANA', address }); } catch { /* counted above */ }
  }
  const after = await prisma.walletBehaviorProfile.count();

  const report = {
    ts: new Date().toISOString(),
    controlsRebuilt: controls,
    task5: {
      pairsProcessed: pairs.length,
      uniqueWallets: wallets.size,
      profilesPersisted: profiles,
      errors,
      byDataQuality: byQuality,
      walletsWithRunnerExposure: withWinners,
      walletsWithLosingPositions: withLosers,
      truncatedHistories: incomplete,
      idempotency: { before, after, identical: before === after },
      caveat: 'cohort = locally observed buyers of runner/control tokens; in-band early-entry status UNPROVEN (historical entry valuations unavailable locally) — recorded, not fabricated'
    }
  };
  mkdirSync('data/runner-mining', { recursive: true });
  writeFileSync('data/runner-mining/task5-report.json', JSON.stringify(report, null, 2));
  console.log('[task5] REPORT', JSON.stringify(report, null, 2));
  await prisma.$disconnect();
}
main().catch(async (e) => { console.error('[task5] FATAL', e?.message ?? e); await prisma.$disconnect(); process.exit(1); });
