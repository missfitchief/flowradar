// FlowRadar — dormancy pilot (Tasks 6+7+8 / Review Batch A) over the 22
// persisted pilot wallets (wallet_behavior_profiles). PILOT DB ONLY.
//
// Runs, in order: Task 6 meaningful-activity classification, Task 7 address
// dormancy observations (one per wallet-token qualifying entry), Task 8
// entity dormancy observations — then reports REAL counts (zero/negative
// results are recorded as-is, never fabricated) plus an idempotency probe.
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: path.join(HERE, '..', '..', 'flowradar', '.env') });

const url = new URL(process.env.DATABASE_URL ?? 'postgresql://invalid');
if (url.pathname !== '/flowradar_pilot') throw new Error('pilot DB only: ' + url.pathname);

const { prisma, runActivityClassification, buildAddressDormancyObservations, buildEntityDormancyObservations } =
  await import('@flowradar/db');
import { writeFileSync, mkdirSync } from 'node:fs';

async function main() {
  const profiles = await prisma.walletBehaviorProfile.findMany({
    where: { chain: 'SOLANA' },
    orderBy: { walletAddress: 'asc' },
    take: 500, // bounded cohort fetch (Codex Batch-A review) — the pilot holds 22
    select: { walletAddress: true }
  });
  const wallets = profiles.map((p) => p.walletAddress);

  // Task 6 — meaningful-activity classification over the cohort.
  const t6 = await runActivityClassification(prisma, {
    chain: 'SOLANA',
    walletAddresses: wallets,
    limit: wallets.length
  });
  const t6DbByClass = Object.fromEntries(
    (await prisma.walletActivityClassification.groupBy({
      by: ['classification'],
      where: { walletAddress: { in: wallets }, chain: 'SOLANA' },
      _count: { _all: true }
    })).map((g) => [g.classification, g._count._all])
  );

  // Task 7 — address dormancy, one observation per qualifying token entry.
  const t7 = await buildAddressDormancyObservations(prisma, {
    chain: 'SOLANA',
    walletAddresses: wallets,
    limit: wallets.length
  });
  const t7DbByClass = Object.fromEntries(
    (await prisma.addressDormancyObservation.groupBy({
      by: ['overallClass'],
      where: { walletAddress: { in: wallets }, chain: 'SOLANA' },
      _count: { _all: true }
    })).map((g) => [g.overallClass, g._count._all])
  );

  // Task 8 — entity dormancy over every Task 7 observation.
  const t7ObsCount = await prisma.addressDormancyObservation.count({
    where: { walletAddress: { in: wallets }, chain: 'SOLANA' }
  });
  const t8 = await buildEntityDormancyObservations(prisma, {
    chain: 'SOLANA',
    walletAddresses: wallets,
    limit: Math.max(1000, t7ObsCount)
  });
  const t8DbByClass = Object.fromEntries(
    (await prisma.entityDormancyObservation.groupBy({
      by: ['entityClass'],
      where: { walletAddress: { in: wallets }, chain: 'SOLANA' },
      _count: { _all: true }
    })).map((g) => [g.entityClass, g._count._all])
  );

  // Idempotency probe: rerun T7+T8 for the first 5 wallets — counts stable.
  const probe = wallets.slice(0, 5);
  const before = {
    activity: await prisma.walletActivityClassification.count({ where: { walletAddress: { in: probe } } }),
    address: await prisma.addressDormancyObservation.count({ where: { walletAddress: { in: probe } } }),
    entity: await prisma.entityDormancyObservation.count({ where: { walletAddress: { in: probe } } })
  };
  await runActivityClassification(prisma, { chain: 'SOLANA', walletAddresses: probe, limit: probe.length });
  await buildAddressDormancyObservations(prisma, { chain: 'SOLANA', walletAddresses: probe, limit: probe.length });
  await buildEntityDormancyObservations(prisma, { chain: 'SOLANA', walletAddresses: probe, limit: 1000 });
  const after = {
    activity: await prisma.walletActivityClassification.count({ where: { walletAddress: { in: probe } } }),
    address: await prisma.addressDormancyObservation.count({ where: { walletAddress: { in: probe } } }),
    entity: await prisma.entityDormancyObservation.count({ where: { walletAddress: { in: probe } } })
  };

  const report = {
    ts: new Date().toISOString(),
    cohort: { source: 'wallet_behavior_profiles (SOLANA)', wallets: wallets.length },
    task6: {
      batch: t6,
      dbByClass: t6DbByClass,
      unknownValueRows: t6DbByClass.unknown_value ?? 0,
      coverageWarnings: {
        walletsWithTruncation: t6.walletsWithTruncation,
        note: 'truncated wallets cannot mint covered-dormant claims downstream (verified by the Task 7 completeness check)'
      }
    },
    task7: {
      batch: t7,
      dbByOverallClass: t7DbByClass,
      unknowns: t7DbByClass.unknown ?? 0,
      incompleteHistory: t7DbByClass.apparently_dormant_incomplete_history ?? 0,
      coverageWarnings: { walletsIncompleteClassification: t7.walletsIncompleteClassification }
    },
    task8: {
      batch: t8,
      dbByEntityClass: t8DbByClass,
      insufficientEvidence: t8DbByClass.insufficient_evidence ?? 0
    },
    idempotency: { before, after, identical: JSON.stringify(before) === JSON.stringify(after) },
    caveat:
      'observation-only shadow analytics over the 22-wallet pilot cohort; unknown/incomplete classes are honest states, never zeros'
  };
  mkdirSync('data/runner-mining', { recursive: true });
  writeFileSync('data/runner-mining/dormancy-pilot-report.json', JSON.stringify(report, null, 2));
  console.log('[dormancy-pilot] REPORT', JSON.stringify(report, null, 2));
  await prisma.$disconnect();
}
main().catch(async (e) => {
  console.error('[dormancy-pilot] FATAL', e?.message ?? e);
  await prisma.$disconnect();
  process.exit(1);
});
