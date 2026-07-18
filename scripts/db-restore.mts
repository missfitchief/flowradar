import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { PrismaClient } from '@prisma/client';
import { latestBackupDirectory, readBackupManifest, resolveDatabaseUrl, restoreDatabaseBackup, runProductionIntegrity, verifyBackup } from '@flowradar/db';

const args = process.argv.slice(2);
const command = args[0] ?? 'drill';
const directory = args[1] && args[1] !== 'latest' ? path.resolve(args[1]) : latestBackupDirectory();

if (command === 'verify') {
  const result = await verifyBackup(directory);
  console.log(JSON.stringify({ status: result.ok ? 'verified' : 'failed', backupId: result.manifest.backupId, errors: result.errors }, null, 2));
  if (!result.ok) process.exitCode = 1;
} else if (command === 'restore') {
  const target = process.env.FLOWRADAR_RESTORE_DATABASE_URL;
  if (!target) throw new Error('FLOWRADAR_RESTORE_DATABASE_URL is required for an explicit restore.');
  const result = await restoreDatabaseBackup(directory, target);
  console.log(JSON.stringify({ status: 'restored', ...result }, null, 2));
} else if (command === 'drill') {
  await drill(directory);
} else {
  throw new Error('Usage: npm run db:restore -- <verify|drill|restore> [latest|backup-directory]');
}

async function drill(backupDirectory: string) {
  const sourceUrl = resolveDatabaseUrl();
  const manifest = readBackupManifest(backupDirectory);
  const source = new URL(sourceUrl);
  const restoreDb = `flowradar_restore_${Date.now()}`;
  const maintenance = new URL(sourceUrl); maintenance.pathname = '/postgres';
  const target = new URL(sourceUrl); target.pathname = `/${restoreDb}`;
  const admin = new Client({ connectionString: maintenance.toString(), application_name: 'flowradar-restore-drill-admin' });
  let restored = false;
  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE "${restoreDb}"`);
    const here = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(here, '..');
    const prismaDir = path.join(repoRoot, 'packages', 'db');
    const prismaCli = path.join(repoRoot, 'node_modules', 'prisma', 'build', 'index.js');
    const migration = spawnSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
      cwd: prismaDir,
      env: { ...process.env, DATABASE_URL: target.toString() },
      encoding: 'utf8'
    });
    if (migration.status !== 0) throw new Error(`Restore drill schema migration failed: ${migration.error?.message ?? migration.stderr ?? migration.stdout ?? `exit ${migration.status}`}`);
    const receipt = await restoreDatabaseBackup(backupDirectory, target.toString());
    const restoredPrisma = new PrismaClient({ datasources: { db: { url: target.toString() } } });
    try {
      const integrity = await runProductionIntegrity(restoredPrisma);
      if (integrity.status === 'failed') throw new Error(`Restored database integrity failed (${integrity.errorCount} errors)`);
      restored = true;
      console.log(JSON.stringify({
        status: 'restore_drill_passed', backupId: manifest.backupId,
        temporaryDatabase: restoreDb, tables: receipt.tableCount, rows: receipt.totalRows,
        integrity: { status: integrity.status, errors: integrity.errorCount, warnings: integrity.warningCount }
      }, null, 2));
    } finally {
      await restoredPrisma.$disconnect();
    }
  } finally {
    if (!admin.ended) {
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [restoreDb]).catch(() => undefined);
      await admin.query(`DROP DATABASE IF EXISTS "${restoreDb}"`).catch(() => undefined);
      await admin.end();
    }
    if (!restored) process.exitCode = 1;
  }
}
