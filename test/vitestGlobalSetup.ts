// FlowRadar — vitest global setup (overnight Task A: TEST/LIVE DB isolation).
//
// Runs ONCE before any test project. Ensures the dedicated test database
// exists on the embedded LITE cluster and carries EXACTLY the live schema:
//   1. connect to the cluster's `postgres` maintenance database
//   2. CREATE DATABASE flowradar_test if missing (never touches `flowradar`)
//   3. `prisma migrate deploy` against the TEST database using the SAME
//      prisma/migrations directory as live — test schema can never drift.
//
// If the cluster is down, this is a silent no-op: DB-touching suites already
// self-skip via their own port probes. This setup NEVER connects to the live
// `flowradar` database and never prints credentials.

import { execSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { TEST_LITE_DATABASE_URL } from '../packages/db/src/testDb';

const CLUSTER_HOST = 'localhost';
const CLUSTER_PORT = 5439;

function probePort(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createConnection({ host, port });
    const done = (ok: boolean) => { s.removeAllListeners(); s.destroy(); resolve(ok); };
    s.setTimeout(timeoutMs);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
  });
}

export default async function globalSetup(): Promise<void> {
  if (!(await probePort(CLUSTER_HOST, CLUSTER_PORT))) {
    console.warn('[testdb] LITE cluster not reachable on :5439 — DB suites will self-skip.');
    return;
  }

  const testUrl = new URL(TEST_LITE_DATABASE_URL);
  const testDbName = testUrl.pathname.replace(/^\//, '');
  // Maintenance connection: same cluster/credentials, `postgres` database —
  // exists on every cluster and is NOT the live application database.
  const maintenanceUrl = new URL(TEST_LITE_DATABASE_URL);
  maintenanceUrl.pathname = '/postgres';

  const admin = new PrismaClient({ datasources: { db: { url: maintenanceUrl.toString() } } });
  try {
    const rows = await admin.$queryRaw<{ n: number }[]>`SELECT 1 AS n FROM pg_database WHERE datname = ${testDbName}`;
    if (rows.length === 0) {
      // Database identifier comes from OUR constant, not user input.
      await admin.$executeRawUnsafe(`CREATE DATABASE "${testDbName}"`);
      console.log(`[testdb] created test database "${testDbName}"`);
    }
  } finally {
    await admin.$disconnect();
  }

  // Apply the SAME migrations directory as live (requirement: test migrations
  // match live migrations). `migrate deploy` never resets and never seeds.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dbPackageDir = path.resolve(here, '..', 'packages', 'db');
  execSync('npx prisma migrate deploy', {
    cwd: dbPackageDir,
    stdio: 'pipe', // do not echo the URL-bearing env into test output
    env: { ...process.env, DATABASE_URL: TEST_LITE_DATABASE_URL }
  });
  console.log(`[testdb] migrations deployed to "${testDbName}"`);
}
