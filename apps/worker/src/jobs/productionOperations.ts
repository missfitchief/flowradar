import { createDatabaseBackup, latestBackupDirectory, pruneOperationalTelemetry, readBackupManifest, recordRuntimeHeartbeat, resolveDatabaseUrl, runProductionIntegrity } from '@flowradar/db';
import type { JobContext } from '../context';

const PROCESS_STARTED_AT = new Date();
const DEFAULT_BACKUP_INTERVAL_MS = 6 * 60 * 60_000;
const DEFAULT_INTEGRITY_INTERVAL_MS = 60 * 60_000;

function configuredMs(name: string, fallback: number) {
  const hours = Number(process.env[name]);
  return Number.isFinite(hours) && hours > 0 ? hours * 60 * 60_000 : fallback;
}

export async function run(ctx: JobContext) {
  const { prisma, log } = ctx;
  await recordRuntimeHeartbeat(prisma, {
    component: 'worker', status: 'healthy', startedAt: PROCESS_STARTED_AT, success: true,
    metadata: { mockMode: process.env.MOCK_MODE !== 'false', durableQueue: Boolean(process.env.REDIS_URL) }
  });

  const latestIntegrity = await prisma.productionIntegrityRun.findFirst({ orderBy: { startedAt: 'desc' }, select: { startedAt: true } });
  if (!latestIntegrity || Date.now() - latestIntegrity.startedAt.getTime() >= configuredMs('FLOWRADAR_INTEGRITY_INTERVAL_HOURS', DEFAULT_INTEGRITY_INTERVAL_MS)) {
    const report = await runProductionIntegrity(prisma);
    log.info('production integrity complete', { status: report.status, errors: report.errorCount, warnings: report.warningCount, runId: report.id });
  }

  let lastBackupAt = 0;
  try { lastBackupAt = new Date(readBackupManifest(latestBackupDirectory()).completedAt).getTime(); } catch { /* no verified backup yet */ }
  if (process.env.MOCK_MODE === 'false' && Date.now() - lastBackupAt >= configuredMs('FLOWRADAR_BACKUP_INTERVAL_HOURS', DEFAULT_BACKUP_INTERVAL_MS)) {
    const backup = await createDatabaseBackup(resolveDatabaseUrl());
    log.info('database backup complete', {
      backupId: backup.manifest.backupId, tables: backup.manifest.tables.length,
      rows: backup.manifest.totalRows, bytes: backup.manifest.totalBytes
    });
  }
  await pruneOperationalTelemetry(prisma);
}
