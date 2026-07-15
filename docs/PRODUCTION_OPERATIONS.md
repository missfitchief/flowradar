# FlowRadar Production Operations

This runbook covers operational safety only. Provider health, cursor receipts,
backups, integrity checks and runtime heartbeats never feed scoring, entity
inference, signal eligibility or alert policy.

## Health dashboard

Open `/operations` in the web application. It reads persisted state and shows:

- monitored Core, dormant and observation wallets;
- active provider subscriptions, due work and alert inbox size;
- tracker throughput, memory, retries and provider failures;
- worker, Telegram, intelligence and per-job heartbeats;
- provider latency, success rate, rate limits, timeouts and last errors;
- integrity status and rejected cursor regressions.

A runtime heartbeat older than two minutes is stale. A process existing in the
OS is not sufficient evidence of health.

## Backup policy

The production worker checks every five minutes and creates a backup when the
last completed snapshot is older than `FLOWRADAR_BACKUP_INTERVAL_HOURS`
(default: 6 hours). Manual backup:

```text
npm run db:backup
```

Backups default to `%USERPROFILE%\FlowRadarBackups`, outside the repository.
Each version is a consistent PostgreSQL `REPEATABLE READ` logical snapshot.
Every application table is exported as compressed PostgreSQL COPY data with a
SHA-256 checksum, column manifest and row count. Unchanged table files are
hard-linked to the previous version; every retained version remains directly
restorable even if an older directory is removed.

This is storage-incremental table deduplication, not PostgreSQL WAL/PITR. The
default recovery point objective is therefore six hours. For true point-in-time
recovery, configure managed PostgreSQL WAL archiving or provider snapshots.

The default backup location is on the same machine. A disk loss can remove both
database and backup. Production deployment must replicate the backup directory
to encrypted off-host storage with independent retention.

## Verification and restore

Checksum verification only:

```text
npm run db:restore -- verify latest
```

Mandatory isolated restore drill:

```text
npm run db:restore -- drill latest
```

The drill creates a temporary database on the same PostgreSQL cluster, deploys
the current Prisma migrations, restores every table, verifies all row counts,
runs the production integrity checker, then drops the temporary database.

Explicit restore into a prepared database:

```text
set FLOWRADAR_RESTORE_DATABASE_URL=postgresql://.../flowradar_restore
npm run db:restore -- restore latest
```

In-place restore to a database with the same name is refused. Disaster recovery
requires an isolated restore and verification first. Only then may an operator
set `FLOWRADAR_ALLOW_PRODUCTION_RESTORE=true` for a controlled maintenance
window.

## Integrity check

```text
npm run production:integrity
```

The receipt checks active Core monitoring subscriptions, signal-to-entity and
signal-to-event references, Telegram delivery receipts, stale scheduler claims
and timestamp cursor format. Results are persisted in
`production_integrity_runs`.

## Cursor and replay safety

Wallet activity and Core monitoring cursors advance only after event
persistence. Every transition is stored in `provider_cursor_checkpoints`.
Older or malformed cursors are rejected. Equal cursors are treated as safe
replays. Event IDs and database uniqueness constraints remain the final
duplicate-processing guard.

The wallet polling rotation index is stored in `provider_sync_states`; a worker
restart resumes the next bounded wallet window instead of returning to window
zero.

## Queue durability

Monitoring subscriptions, provider cursors, alert inbox rows and wallet
investigation sessions are database-backed. In FULL mode, `REDIS_URL` enables
BullMQ for durable queued jobs. In LITE mode, ad-hoc `InlineRunner` FIFO jobs
remain process-memory only and can be lost on a hard crash. Production 24/7
operation should use FULL mode with persistent Redis.

## Provider fail-closed behavior

Live mode never substitutes a mock provider. Missing credentials are recorded
as `missing_key`; per-wallet failures do not terminate the monitoring cycle.
FlowRadar continues other chains/providers where possible and preserves the
last successful cursor for retry.
