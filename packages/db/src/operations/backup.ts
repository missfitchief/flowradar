import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import { Client } from 'pg';
import { from as copyFrom, to as copyTo } from 'pg-copy-streams';

export const BACKUP_FORMAT_VERSION = 2;

export interface BackupTableManifest {
  schema: string;
  table: string;
  columns: string[];
  rows: number;
  file: string;
  bytes: number;
  sha256: string;
  reusedFrom?: string;
}

export interface BackupManifest {
  formatVersion: number;
  backupId: string;
  database: string;
  createdAt: string;
  completedAt: string;
  storageMode: 'full_logical_with_unchanged_table_deduplication';
  consistentSnapshot: 'repeatable_read';
  schemaMigrations: string[];
  tables: BackupTableManifest[];
  totalRows: number;
  totalBytes: number;
  criticalCounts: Record<string, number>;
}

const CRITICAL_TABLES = new Set([
  'wallets', 'wallet_intelligence_profiles', 'intelligence_entities', 'intelligence_entity_memberships',
  'monitoring_subscriptions', 'provider_sync_states', 'operator_watches', 'operator_watch_alerts',
  'mass_transaction_events', 'alchemy_webhook_receipts', 'alchemy_webhook_subscription_states',
  'intelligence_signals', 'alerts'
]);

function q(identifier: string) { return `"${identifier.replaceAll('"', '""')}"`; }
function backupRoot() { return path.resolve(process.env.FLOWRADAR_BACKUP_DIR?.trim() || path.join(homedir(), 'FlowRadarBackups')); }
function safeDbName(databaseUrl: string) { return decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, '')) || 'postgres'; }
async function sha256(file: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
function atomicJson(file: string, value: unknown) {
  const temp = `${file}.partial`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(temp, file);
}

export function readBackupManifest(directory: string): BackupManifest {
  const parsed = JSON.parse(readFileSync(path.join(directory, 'manifest.json'), 'utf8')) as BackupManifest;
  if (parsed.formatVersion !== BACKUP_FORMAT_VERSION) throw new Error(`Unsupported backup format ${parsed.formatVersion}`);
  return parsed;
}

export function latestBackupDirectory(root = backupRoot()) {
  const latest = JSON.parse(readFileSync(path.join(root, 'latest.json'), 'utf8')) as { directory: string };
  return path.resolve(root, latest.directory);
}

export async function verifyBackup(directory: string) {
  const manifest = readBackupManifest(directory);
  const errors: string[] = [];
  for (const table of manifest.tables) {
    const file = path.join(directory, table.file);
    if (!existsSync(file)) errors.push(`${table.schema}.${table.table}: missing file`);
    else if (statSync(file).size !== table.bytes) errors.push(`${table.schema}.${table.table}: size mismatch`);
    else if (await sha256(file) !== table.sha256) errors.push(`${table.schema}.${table.table}: checksum mismatch`);
  }
  return { ok: errors.length === 0, errors, manifest };
}

export async function createDatabaseBackup(databaseUrl: string, options: { retain?: number } = {}) {
  const root = backupRoot();
  mkdirSync(root, { recursive: true });
  const createdAt = new Date();
  const database = safeDbName(databaseUrl);
  const backupId = `${createdAt.toISOString().replace(/[:.]/g, '-')}-${database}`;
  const partial = path.join(root, `${backupId}.partial`);
  const final = path.join(root, backupId);
  const tablesDir = path.join(partial, 'tables');
  rmSync(partial, { recursive: true, force: true });
  mkdirSync(tablesDir, { recursive: true });

  let previousDirectory: string | null = null;
  let previous: BackupManifest | null = null;
  try {
    previousDirectory = latestBackupDirectory(root);
    previous = readBackupManifest(previousDirectory);
  } catch { /* first backup */ }

  const client = new Client({ connectionString: databaseUrl, application_name: 'flowradar-backup' });
  const tableManifests: BackupTableManifest[] = [];
  let schemaMigrations: string[] = [];
  try {
    await client.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const migrations = await client.query<{ migration_name: string }>(`
      SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY finished_at, migration_name`);
    schemaMigrations = migrations.rows.map((row) => row.migration_name);
    const tables = await client.query<{ schema: string; table: string }>(`
      SELECT n.nspname AS schema, c.relname AS table
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r' AND n.nspname = 'public' AND c.relname <> '_prisma_migrations'
      ORDER BY c.relname`);
    for (const row of tables.rows) {
      const columnsResult = await client.query<{ column_name: string }>(`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`, [row.schema, row.table]);
      const columns = columnsResult.rows.map((column) => column.column_name);
      const countResult = await client.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM ${q(row.schema)}.${q(row.table)}`);
      const fileName = `${row.schema}__${row.table}.copy.gz`;
      const output = path.join(tablesDir, fileName);
      const copySql = `COPY ${q(row.schema)}.${q(row.table)} (${columns.map(q).join(',')}) TO STDOUT WITH (FORMAT csv, NULL '\\N', ENCODING 'UTF8')`;
      await pipeline(client.query(copyTo(copySql)), createGzip({ level: 6 }), createWriteStream(output, { flags: 'wx' }));
      let bytes = statSync(output).size;
      let digest = await sha256(output);
      let reusedFrom: string | undefined;
      const prior = previous?.tables.find((table) => table.schema === row.schema && table.table === row.table && table.sha256 === digest);
      if (prior && previousDirectory) {
        const priorFile = path.join(previousDirectory, prior.file);
        if (existsSync(priorFile)) {
          unlinkSync(output);
          linkSync(priorFile, output);
          bytes = statSync(output).size;
          digest = prior.sha256;
          reusedFrom = previous!.backupId;
        }
      }
      tableManifests.push({
        schema: row.schema, table: row.table, columns,
        rows: Number(countResult.rows[0]?.count ?? 0),
        file: path.join('tables', fileName).replaceAll('\\', '/'),
        bytes, sha256: digest, ...(reusedFrom ? { reusedFrom } : {})
      });
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    rmSync(partial, { recursive: true, force: true });
    throw error;
  } finally {
    await client.end().catch(() => undefined);
  }

  const completedAt = new Date();
  const manifest: BackupManifest = {
    formatVersion: BACKUP_FORMAT_VERSION,
    backupId,
    database,
    createdAt: createdAt.toISOString(),
    completedAt: completedAt.toISOString(),
    storageMode: 'full_logical_with_unchanged_table_deduplication',
    consistentSnapshot: 'repeatable_read',
    schemaMigrations,
    tables: tableManifests,
    totalRows: tableManifests.reduce((sum, table) => sum + table.rows, 0),
    totalBytes: tableManifests.reduce((sum, table) => sum + table.bytes, 0),
    criticalCounts: Object.fromEntries(tableManifests.filter((table) => CRITICAL_TABLES.has(table.table)).map((table) => [table.table, table.rows]))
  };
  atomicJson(path.join(partial, 'manifest.json'), manifest);
  renameSync(partial, final);
  atomicJson(path.join(root, 'latest.json'), { backupId, directory: path.basename(final), completedAt: manifest.completedAt });
  pruneBackups(root, Math.max(2, options.retain ?? Number(process.env.FLOWRADAR_BACKUP_RETENTION ?? 14)));
  return { directory: final, manifest };
}

function pruneBackups(root: string, retain: number) {
  const directories = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.endsWith('.partial'))
    .map((entry) => entry.name)
    .sort().reverse();
  for (const directory of directories.slice(retain)) rmSync(path.join(root, directory), { recursive: true, force: true });
}

export async function restoreDatabaseBackup(directory: string, targetDatabaseUrl: string) {
  const verification = await verifyBackup(directory);
  if (!verification.ok) throw new Error(`Backup integrity failed: ${verification.errors.join('; ')}`);
  const targetDatabase = safeDbName(targetDatabaseUrl);
  if (targetDatabase === verification.manifest.database && process.env.FLOWRADAR_ALLOW_PRODUCTION_RESTORE !== 'true') {
    throw new Error('Refusing in-place production restore. Restore into an isolated database first, or explicitly set FLOWRADAR_ALLOW_PRODUCTION_RESTORE=true.');
  }
  const client = new Client({ connectionString: targetDatabaseUrl, application_name: 'flowradar-restore' });
  try {
    await client.connect();
    const available = await client.query<{ table: string }>(`
      SELECT c.relname AS table FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r' AND n.nspname = 'public'`);
    const availableTables = new Set(available.rows.map((row) => row.table));
    const targetMigrations = await client.query<{ migration_name: string }>(`
      SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`);
    const targetMigrationNames = new Set(targetMigrations.rows.map((row) => row.migration_name));
    const missingMigrations = verification.manifest.schemaMigrations.filter((migration) => !targetMigrationNames.has(migration));
    if (missingMigrations.length) throw new Error(`Target schema is missing backup migrations: ${missingMigrations.join(', ')}`);
    const missing = verification.manifest.tables.filter((table) => !availableTables.has(table.table));
    if (missing.length) throw new Error(`Target schema is missing tables: ${missing.map((table) => table.table).join(', ')}`);

    await client.query('BEGIN');
    await client.query(`TRUNCATE TABLE ${verification.manifest.tables.map((table) => `${q(table.schema)}.${q(table.table)}`).join(', ')} RESTART IDENTITY CASCADE`);
    await client.query(`SET LOCAL session_replication_role = 'replica'`);
    for (const table of verification.manifest.tables) {
      const copySql = `COPY ${q(table.schema)}.${q(table.table)} (${table.columns.map(q).join(',')}) FROM STDIN WITH (FORMAT csv, NULL '\\N', ENCODING 'UTF8')`;
      await pipeline(createReadStream(path.join(directory, table.file)), createGunzip(), client.query(copyFrom(copySql)));
    }
    await client.query(`SET LOCAL session_replication_role = 'origin'`);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end().catch(() => undefined);
  }

  const counts = new Client({ connectionString: targetDatabaseUrl, application_name: 'flowradar-restore-verify' });
  await counts.connect();
  try {
    const mismatches: string[] = [];
    for (const table of verification.manifest.tables) {
      const result = await counts.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM ${q(table.schema)}.${q(table.table)}`);
      const actual = Number(result.rows[0]?.count ?? 0);
      if (actual !== table.rows) mismatches.push(`${table.table}: expected ${table.rows}, restored ${actual}`);
    }
    if (mismatches.length) throw new Error(`Restore row-count verification failed: ${mismatches.join('; ')}`);
  } finally {
    await counts.end();
  }
  return { backupId: verification.manifest.backupId, targetDatabase, tableCount: verification.manifest.tables.length, totalRows: verification.manifest.totalRows };
}
