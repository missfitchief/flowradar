import { getProductionHealth, latestBackupDirectory, prisma, readBackupManifest } from '@flowradar/db';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export const dynamic = 'force-dynamic';

function age(value: Date | null) {
  if (!value) return 'Never';
  const seconds = Math.max(0, Math.round((Date.now() - value.getTime()) / 1_000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3_600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3_600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

function count(value: number | bigint) { return Number(value).toLocaleString('en-US'); }
function ms(value: number) { return value >= 1_000 ? `${(value / 1_000).toFixed(2)}s` : `${Math.round(value)}ms`; }
function statusClass(status: string, stale = false) {
  if (stale || status === 'failed' || status === 'degraded') return 'bg-red-500/15 text-red-300';
  if (status === 'healthy' || status === 'passed') return 'bg-emerald-500/15 text-emerald-300';
  return 'bg-amber-500/15 text-amber-300';
}

export default async function OperationsPage() {
  const health = await getProductionHealth(prisma);
  let latestBackup: ReturnType<typeof readBackupManifest> | null = null;
  try { latestBackup = readBackupManifest(latestBackupDirectory()); } catch { /* no verified backup visible to this runtime */ }
  const cards = [
    ['Core wallets monitored', health.counts.coreWallets],
    ['Dormant entities', health.counts.dormantWallets],
    ['Observation wallets', health.counts.observationWallets],
    ['Provider subscriptions', health.counts.providerSubscriptions],
    ['Queue size', health.counts.queueSize],
    ['Average processing latency', ms(health.processing.averageLatencyMs)],
    ['Alerts generated · 24h', health.counts.alertsGenerated],
    ['Suppressed alerts · 24h', health.counts.suppressedAlerts],
    ['Rejected alerts · 24h', health.counts.rejectedAlerts],
    ['Inbox alerts', health.counts.inboxAlerts],
    ['Activity events', health.counts.activityEvents],
    ['Intelligence entities', health.counts.entities],
    ['Last database backup', latestBackup ? age(new Date(latestBackup.completedAt)) : 'Not available']
  ] as const;

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Production Operations</h1>
      <p className="mt-2 text-sm text-muted-foreground">Live operational state from persisted cursors, queues, receipts and runtime heartbeats.</p>

      <div className="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {cards.map(([label, value]) => (
          <Card key={label}><CardHeader><CardTitle className="text-xs text-muted-foreground">{label}</CardTitle></CardHeader>
            <CardContent><div className="text-2xl font-semibold tabular-nums">{typeof value === 'number' ? count(value) : value}</div></CardContent>
          </Card>
        ))}
      </div>

      <h2 className="mt-8 text-lg font-semibold">Runtime health</h2>
      <div className="mt-3 overflow-x-auto rounded-xl border border-zinc-800">
        <table className="w-full text-left text-sm"><thead className="border-b border-zinc-800 bg-zinc-900/70 text-xs text-zinc-400"><tr>
          <th className="px-3 py-2">Component</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">PID</th><th className="px-3 py-2">Last heartbeat</th><th className="px-3 py-2">Latest latency</th><th className="px-3 py-2">Last error</th>
        </tr></thead><tbody className="divide-y divide-zinc-800/60">
          {health.runtimes.map((runtime) => {
            const metadata = runtime.metadataJson && typeof runtime.metadataJson === 'object' && !Array.isArray(runtime.metadataJson) ? runtime.metadataJson as Record<string, unknown> : {};
            return <tr key={runtime.component}><td className="px-3 py-2 font-mono text-xs">{runtime.component}</td>
              <td className="px-3 py-2"><span className={`rounded px-2 py-0.5 text-xs ${statusClass(runtime.status, runtime.stale)}`}>{runtime.stale ? 'stale' : runtime.status}</span></td>
              <td className="px-3 py-2 tabular-nums">{runtime.pid}</td><td className="px-3 py-2 text-zinc-400">{age(runtime.heartbeatAt)}</td>
              <td className="px-3 py-2 text-zinc-400">{typeof metadata.durationMs === 'number' ? ms(metadata.durationMs) : '—'}</td>
              <td className="max-w-xs truncate px-3 py-2 text-xs text-red-300">{runtime.lastError ?? '—'}</td></tr>;
          })}
          {!health.runtimes.length && <tr><td className="px-3 py-4 text-zinc-500" colSpan={6}>No runtime heartbeat has been recorded.</td></tr>}
        </tbody></table>
      </div>

      <h2 className="mt-8 text-lg font-semibold">Provider health · 24h</h2>
      <div className="mt-3 overflow-x-auto rounded-xl border border-zinc-800">
        <table className="w-full text-left text-sm"><thead className="border-b border-zinc-800 bg-zinc-900/70 text-xs text-zinc-400"><tr>
          <th className="px-3 py-2">Provider</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">Latency</th><th className="px-3 py-2">Success rate</th><th className="px-3 py-2">Rate limits</th><th className="px-3 py-2">Timeouts</th><th className="px-3 py-2">Retries</th><th className="px-3 py-2">Last success</th><th className="px-3 py-2">Last error</th>
        </tr></thead><tbody className="divide-y divide-zinc-800/60">
          {health.providers.map((provider) => <tr key={provider.provider}><td className="px-3 py-2 font-medium">{provider.provider}</td>
            <td className="px-3 py-2"><span className={`rounded px-2 py-0.5 text-xs ${statusClass(provider.status)}`}>{provider.status}</span></td>
            <td className="px-3 py-2">{ms(provider.latencyMs)}</td><td className="px-3 py-2">{(provider.successRate * 100).toFixed(1)}%</td>
            <td className="px-3 py-2">{provider.rateLimited}</td><td className="px-3 py-2">{provider.timedOut}</td><td className="px-3 py-2">{provider.retryCount}</td>
            <td className="px-3 py-2 text-zinc-400">{age(provider.lastSuccessAt)}</td><td className="max-w-xs truncate px-3 py-2 text-xs text-red-300">{provider.lastError ?? '—'}</td></tr>)}
          {!health.providers.length && <tr><td className="px-3 py-4 text-zinc-500" colSpan={9}>No provider execution has been recorded in the last 24 hours.</td></tr>}
        </tbody></table>
      </div>

      <div className="mt-8 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 text-sm">
        <div className="font-medium">Integrity and cursor safety</div>
        <div className="mt-2 text-zinc-400">Latest integrity run: <span className={health.latestIntegrity ? statusClass(health.latestIntegrity.status) : ''}>{health.latestIntegrity?.status ?? 'not run'}</span></div>
        <div className="mt-1 text-zinc-400">Errors: {health.latestIntegrity?.errorCount ?? 0} · Warnings: {health.latestIntegrity?.warningCount ?? 0} · Rejected cursor regressions (24h): {health.cursors.rejectedRegressions24h}</div>
        <div className="mt-1 text-zinc-400">Tracker throughput: {health.processing.throughputPerSec.toFixed(1)} events/s · Peak heap: {(Number(health.processing.peakHeapBytes) / 1_048_576).toFixed(1)} MB · Retries: {health.processing.retryAttempts}</div>
        <div className="mt-1 text-zinc-400">Backup: {latestBackup ? `${latestBackup.backupId} · ${latestBackup.tables.length} tables · ${latestBackup.totalRows.toLocaleString('en-US')} rows` : 'No verified backup is visible to this runtime.'}</div>
      </div>
    </div>
  );
}
