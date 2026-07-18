import { createDatabaseBackup, resolveDatabaseUrl, verifyBackup } from '@flowradar/db';

const result = await createDatabaseBackup(resolveDatabaseUrl());
const verified = await verifyBackup(result.directory);
if (!verified.ok) throw new Error(`Backup verification failed: ${verified.errors.join('; ')}`);
console.log(JSON.stringify({
  status: 'verified',
  backupId: result.manifest.backupId,
  directory: result.directory,
  tables: result.manifest.tables.length,
  rows: result.manifest.totalRows,
  bytes: result.manifest.totalBytes,
  criticalCounts: result.manifest.criticalCounts
}, null, 2));
