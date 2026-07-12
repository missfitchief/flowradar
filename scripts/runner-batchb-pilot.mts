// FlowRadar — Batch B pilot (Tasks 9-12) over the persisted pilot cohort
// (wallet_behavior_profiles). PILOT DB ONLY.
//
// Runs, in order: Task 9 funding/reactivation paths (per Task 7 anchor),
// Task 10 post-entry behaviors, Task 11 repeat-runner candidates, Task 12
// dormant-runner candidates — then reports REAL counts (zero/negative results
// recorded as-is, never fabricated) plus an idempotency probe.
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: path.join(HERE, '..', '..', 'flowradar', '.env') });

const url = new URL(process.env.DATABASE_URL ?? 'postgresql://invalid');
if (url.pathname !== '/flowradar_pilot') throw new Error('pilot DB only: ' + url.pathname);

const {
  prisma,
  buildFundingReactivationPaths,
  buildPostEntryBehaviors,
  buildRepeatRunnerCandidates,
  buildDormantRunnerCandidates
} = await import('@flowradar/db');
import { writeFileSync, mkdirSync } from 'node:fs';

async function main() {
  const profiles = await prisma.walletBehaviorProfile.findMany({
    where: { chain: 'SOLANA' },
    orderBy: { walletAddress: 'asc' },
    take: 500,
    select: { walletAddress: true }
  });
  const wallets = profiles.map((p) => p.walletAddress);
  const anchorCount = await prisma.addressDormancyObservation.count({
    where: { walletAddress: { in: wallets }, chain: 'SOLANA' }
  });

  // Task 9 — funding/reactivation paths per Task 7 anchor.
  const t9 = await buildFundingReactivationPaths(prisma, {
    chain: 'SOLANA',
    walletAddresses: wallets,
    limit: Math.max(1000, anchorCount)
  });
  const t9DbByStatus = Object.fromEntries(
    (await prisma.fundingReactivationPath.groupBy({
      by: ['status'],
      where: { walletAddress: { in: wallets }, chain: 'SOLANA' },
      _count: { _all: true }
    })).map((g) => [g.status, g._count._all])
  );

  // Task 10 — post-entry behaviors.
  const t10 = await buildPostEntryBehaviors(prisma, {
    chain: 'SOLANA',
    walletAddresses: wallets,
    limit: wallets.length
  });
  const t10DbByClass = Object.fromEntries(
    (await prisma.postEntryBehavior.groupBy({
      by: ['primaryClass'],
      where: { walletAddress: { in: wallets }, chain: 'SOLANA' },
      _count: { _all: true }
    })).map((g) => [g.primaryClass, g._count._all])
  );

  // Task 11 — repeat-runner candidates (entity-adjusted).
  const t11 = await buildRepeatRunnerCandidates(prisma, {
    chain: 'SOLANA',
    walletAddresses: wallets,
    limit: wallets.length
  });
  const t11DbByStatus = Object.fromEntries(
    (await prisma.repeatRunnerCandidate.groupBy({
      by: ['status'],
      // Scope to entities containing this pilot cohort (never global rows).
      where: { chain: 'SOLANA', memberWallets: { hasSome: wallets } },
      _count: { _all: true }
    })).map((g) => [g.status, g._count._all])
  );

  // Task 12 — dormant-runner candidates.
  const t12 = await buildDormantRunnerCandidates(prisma, {
    chain: 'SOLANA',
    walletAddresses: wallets,
    limit: wallets.length
  });
  const t12DbByPattern = Object.fromEntries(
    (await prisma.dormantRunnerCandidate.groupBy({
      by: ['pattern'],
      where: { chain: 'SOLANA', memberWallets: { hasSome: wallets } },
      _count: { _all: true }
    })).map((g) => [g.pattern, g._count._all])
  );

  // Idempotency probe: rerun everything for the first 5 wallets and compare
  // SEMANTIC payloads (stable-ordered, timestamp-free), not just row counts.
  const probe = wallets.slice(0, 5);
  const snapshot = async () => ({
    funding: await prisma.fundingReactivationPath.findMany({
      where: { walletAddress: { in: probe } },
      orderBy: [{ walletAddress: 'asc' }, { anchorKey: 'asc' }],
      select: {
        walletAddress: true, anchorKey: true, status: true, directFunderAddress: true,
        repeatFundingCount: true, pathDepth: true, reasonCodes: true
      }
    }),
    postEntry: await prisma.postEntryBehavior.findMany({
      where: { walletAddress: { in: probe } },
      orderBy: [{ walletAddress: 'asc' }, { tokenAddress: 'asc' }],
      select: { walletAddress: true, tokenAddress: true, primaryClass: true, labels: true, dataComplete: true }
    }),
    repeat: await prisma.repeatRunnerCandidate.findMany({
      where: { chain: 'SOLANA', memberWallets: { hasSome: probe } },
      orderBy: { entityKey: 'asc' },
      select: {
        entityKey: true, memberWallets: true, status: true, runnersEntered: true,
        distinctRunnersEntered: true, score: true
      }
    }),
    dormantRunner: await prisma.dormantRunnerCandidate.findMany({
      where: { chain: 'SOLANA', memberWallets: { hasSome: probe } },
      orderBy: { entityKey: 'asc' },
      select: {
        entityKey: true, memberWallets: true, pattern: true, dormantEntryEvents: true,
        distinctRunnerTokens: true
      }
    })
  });
  const before = await snapshot();
  await buildFundingReactivationPaths(prisma, { chain: 'SOLANA', walletAddresses: probe, limit: 1000 });
  await buildPostEntryBehaviors(prisma, { chain: 'SOLANA', walletAddresses: probe, limit: probe.length });
  await buildRepeatRunnerCandidates(prisma, { chain: 'SOLANA', walletAddresses: probe, limit: probe.length });
  await buildDormantRunnerCandidates(prisma, { chain: 'SOLANA', walletAddresses: probe, limit: probe.length });
  const after = await snapshot();

  const report = {
    ts: new Date().toISOString(),
    cohort: { source: 'wallet_behavior_profiles (SOLANA)', wallets: wallets.length, anchors: anchorCount },
    task9: { batch: t9, dbByStatus: t9DbByStatus },
    task10: { batch: t10, dbByPrimaryClass: t10DbByClass },
    task11: { batch: t11, dbByStatus: t11DbByStatus },
    task12: { batch: t12, dbByPattern: t12DbByPattern },
    idempotency: {
      identical: JSON.stringify(before) === JSON.stringify(after),
      probeRows: {
        funding: before.funding.length,
        postEntry: before.postEntry.length,
        repeat: before.repeat.length,
        dormantRunner: before.dormantRunner.length
      }
    },
    caveat:
      'observation-only shadow analytics over the pilot cohort; insufficient/unknown/one_off are honest states, never fabricated patterns'
  };
  mkdirSync('data/runner-mining', { recursive: true });
  writeFileSync('data/runner-mining/batchb-pilot-report.json', JSON.stringify(report, null, 2));
  console.log('[batchb-pilot] REPORT', JSON.stringify(report, null, 2));
  await prisma.$disconnect();
}
main().catch(async (e) => {
  console.error('[batchb-pilot] FATAL', e?.message ?? e);
  await prisma.$disconnect();
  process.exit(1);
});
