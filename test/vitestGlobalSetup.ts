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
import { resolveDatabaseUrlForEnv } from '../packages/db/src/testDb';

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
  // Provision THE SAME url the workers will resolve (Codex Task-A review: a
  // validated TEST_DATABASE_URL override must be provisioned here too, not
  // just the hardcoded default). Forcing VITEST on makes the resolver take
  // its fail-closed test branch regardless of this process's own env.
  const resolvedTestUrl = resolveDatabaseUrlForEnv({ ...process.env, VITEST: '1' });
  const testUrl = new URL(resolvedTestUrl);
  const testDbName = testUrl.pathname.replace(/^\//, '');
  const clusterHost = testUrl.hostname;
  const clusterPort = Number(testUrl.port || '5432');

  if (!(await probePort(clusterHost, clusterPort))) {
    console.warn(`[testdb] test cluster not reachable on :${clusterPort} — DB suites will self-skip.`);
    return;
  }

  // Maintenance connection: same cluster/credentials, `postgres` database —
  // exists on every cluster and is NOT the live application database.
  const maintenanceUrl = new URL(resolvedTestUrl);
  maintenanceUrl.pathname = '/postgres';

  const admin = new PrismaClient({ datasources: { db: { url: maintenanceUrl.toString() } } });
  try {
    const rows = await admin.$queryRaw<{ n: number }[]>`SELECT 1 AS n FROM pg_database WHERE datname = ${testDbName}`;
    if (rows.length === 0) {
      try {
        // Database identifier comes from the VALIDATED resolver output.
        await admin.$executeRawUnsafe(`CREATE DATABASE "${testDbName}"`);
        console.log(`[testdb] created test database "${testDbName}"`);
      } catch (err) {
        // 42P04 duplicate_database: two vitest runs raced the check-then-create
        // — the database exists, which is exactly what we wanted. Anything
        // else is a real failure.
        const code = (err as { meta?: { code?: string }; code?: string })?.meta?.code ?? (err as { code?: string })?.code;
        if (code !== '42P04' && !String(err).includes('42P04') && !String(err).includes('already exists')) throw err;
      }
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
    env: { ...process.env, DATABASE_URL: resolvedTestUrl }
  });
  console.log(`[testdb] migrations deployed to "${testDbName}"`);
}
