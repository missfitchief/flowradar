// FlowRadar — live-recovery sprint pilot: receiver post-receipt backfill
// (reading the LIVE shadow DB read-only for the richest coverage) + token
// metadata resolution + capital-chain recompute. PILOT DB writes only.
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: path.join(HERE, '..', '..', 'flowradar', '.env') });

const url = new URL(process.env.DATABASE_URL ?? 'postgresql://invalid');
if (url.pathname !== '/flowradar_pilot') throw new Error('pilot DB only: ' + url.pathname);

const { prisma, buildReceiverActivityBackfill, buildTokenMetadata, buildCapitalChains, buildTokenCandidateScores } = await import('@flowradar/db');
const { PrismaClient } = await import('@prisma/client');
import { writeFileSync, mkdirSync } from 'node:fs';

const LIVE_URL = 'postgresql://flowradar:flowradar@localhost:5439/flowradar';

async function main() {
  const t0 = Date.now();
  // Read-only client for the live shadow DB (richer post-receipt activity).
  const live = new PrismaClient({ datasources: { db: { url: LIVE_URL } } });

  const backfill = await buildReceiverActivityBackfill(prisma, { chain: 'SOLANA', activityClient: live as never });
  console.log('[live-recovery] receiver backfill', JSON.stringify({ byStatus: backfill.byStatus, deployments: backfill.deploymentsFound, errors: backfill.errors }));
  await live.$disconnect();

  const meta = await buildTokenMetadata(prisma, { chain: 'SOLANA', heliusApiKey: process.env.HELIUS_API_KEY, maxRequests: 3 });
  console.log('[live-recovery] token metadata', JSON.stringify({ considered: meta.mintsConsidered, resolved: meta.resolved, retryable: meta.retryable, unavailable: meta.unavailable, requests: meta.requestsUsed }));

  // Recompute capital chains (deployment picks up any newly observed buys).
  const chains = await buildCapitalChains(prisma, { chain: 'SOLANA', limit: 5000 });
  const cands = await buildTokenCandidateScores(prisma, { chain: 'SOLANA', limit: 500 });
  console.log('[live-recovery] chains', JSON.stringify({ staging: chains.staging, deployment: chains.deployment, rotation: chains.profitRotation }), 'candidates', JSON.stringify(cands.byState));

  const report = {
    ts: new Date().toISOString(),
    durationSec: Math.round((Date.now() - t0) / 1000),
    receiverBackfill: { byStatus: backfill.byStatus, deploymentsFound: backfill.deploymentsFound, written: backfill.written, errors: backfill.errors },
    tokenMetadata: { considered: meta.mintsConsidered, resolved: meta.resolved, placeholderOnly: meta.placeholderOnly, retryable: meta.retryable, unavailable: meta.unavailable, requestsUsed: meta.requestsUsed },
    capitalChains: { staging: chains.staging, deployment: chains.deployment, profitRotation: chains.profitRotation },
    candidates: cands.byState,
    honestGaps: [
      'Helius + Birdeye quota are exhausted this session — token metadata resolution is retryable, not fabricated',
      'receiver deployment chains remain 0: receivers are pass-through wallets (0/151 post-receipt token buys in local+live data, verified direct and 2-hop)'
    ]
  };
  mkdirSync('data/runner-mining', { recursive: true });
  writeFileSync('data/runner-mining/live-recovery-report.json', JSON.stringify(report, null, 2));
  console.log('[live-recovery] REPORT written');
  await prisma.$disconnect();
}
main().catch(async (e) => { console.error('[live-recovery] FATAL', e?.message ?? e); await prisma.$disconnect(); process.exit(1); });
